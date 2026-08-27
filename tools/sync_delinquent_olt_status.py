#!/usr/bin/env python3
"""
Walk the delinquency list and, for every customer that has OLT info on their
profile, reconcile their account status to what the U2000/OLT already shows:

  1. POST /api/customers/{id}/network-access/verify      ("Verify with OLT")
  2a. live ONT control flag is "deactivated" but the account is still active:
      POST /api/customers/{id}/sync-status-with-olt       ("Sync")  -> disconnected
  2b. live ONT is "active" but has been "offline" (registered on the OLT,
      no service) and --mark-offline is passed:
      POST /api/customers/{id}/mark-offline               -> offline

This script never sends a command to the OLT and never deactivates anyone. Both
writes are database-only status changes that match reality already on the
equipment: no balance change, no reconnection fee. "offline" also pauses billing
and takes the customer off the delinquency chase list until service is restored.

Runs on your computer against the app you normally log in to. The login user
must be Admin or Head Office.

    pip install requests
    python3 tools/sync_delinquent_olt_status.py --base-url https://YOUR-APP-URL --username kdunn7

Options:
    --dry-run        verify only; report what WOULD change, change nothing
    --mark-offline   also mark customers whose ONT is active-but-offline as
                     'offline' (database only, no OLT command, no fee)
    --max N          stop after N customers that have OLT info
    --delay SEC      pause between customers (default 1.0)
    --start-page N   delinquency-list page to start from (default 1)
"""
from __future__ import annotations

import argparse
import getpass
import sys
import time

import requests


MARK_OFFLINE_REASON = (
    "Bulk cleanup: U2000 shows the ONT active but offline. No service is being "
    "delivered, so billing is paused and the account leaves the delinquency list "
    "until service is restored. No OLT command was sent."
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", required=True, help="e.g. https://app.example.com  (no trailing /api)")
    p.add_argument("--username", required=True)
    p.add_argument("--dry-run", action="store_true", help="verify only, never sync or mark offline")
    p.add_argument(
        "--mark-offline",
        action="store_true",
        help="also mark customers whose ONT is active but offline as 'offline' "
        "(database status only; no OLT command, no reconnection fee)",
    )
    p.add_argument("--max", type=int, default=0, help="stop after N customers with OLT info (0 = all)")
    p.add_argument("--delay", type=float, default=1.0, help="seconds between customers")
    p.add_argument("--start-page", type=int, default=1)
    p.add_argument("--timeout", type=float, default=120.0, help="per-request timeout seconds (OLT reads are slow)")
    return p.parse_args()


# The link to the app runs over Tailscale to Jamaica and the OLT reads behind
# /verify are slow, so the proxy resetting the connection mid-request is
# routine and means nothing on its own. Retry transient failures (connection
# reset, timeout, 502/503/504) with backoff before giving up on a customer.
RETRYABLE_STATUS = {502, 503, 504}
MAX_ATTEMPTS = 4


class TransientError(Exception):
    """A request that failed in a way that is worth retrying."""


class Client:
    def __init__(self, base_url: str, timeout: float) -> None:
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.s = requests.Session()

    def _send(self, method: str, path: str, **kwargs) -> tuple[int, dict]:
        """One request, with retries. Returns (status_code, parsed_body).

        A non-retryable HTTP response (4xx, or a 200 that isn't JSON) comes
        back as a normal (status, body) tuple for the caller to handle. Only
        exhausted transient failures raise.
        """
        kwargs.setdefault("timeout", self.timeout)
        last_error = ""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                r = self.s.request(method, f"{self.base}{path}", **kwargs)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
                last_error = f"{type(exc).__name__}"
            else:
                if r.status_code in RETRYABLE_STATUS:
                    last_error = f"HTTP {r.status_code}"
                else:
                    try:
                        return r.status_code, r.json()
                    except ValueError:
                        return r.status_code, {"error": r.text[:200]}
            if attempt < MAX_ATTEMPTS:
                wait = 2 ** attempt
                print(f"    (transient {last_error}, retry {attempt}/{MAX_ATTEMPTS - 1} in {wait}s)")
                time.sleep(wait)
        raise TransientError(f"{method} {path} failed after {MAX_ATTEMPTS} attempts ({last_error})")

    def login(self, username: str, password: str) -> None:
        code, body = self._send(
            "POST",
            "/api/auth/login",
            json={"username": username, "password": password},
        )
        if code != 200:
            raise SystemExit(f"Login failed ({code}): {body.get('error', body)}")

    def delinquent_page(self, page: int) -> dict:
        code, body = self._send("GET", "/api/reports/delinquent-customers", params={"page": page})
        if code != 200:
            raise TransientError(f"delinquent page {page}: HTTP {code}")
        return body

    def network_access(self, customer_id: int) -> dict | None:
        code, body = self._send("GET", f"/api/customers/{customer_id}/network-access")
        if code != 200:
            return None
        return body.get("networkAccess")

    def verify(self, customer_id: int) -> tuple[int, dict]:
        return self._send("POST", f"/api/customers/{customer_id}/network-access/verify")

    def sync(self, customer_id: int) -> tuple[int, dict]:
        return self._send("POST", f"/api/customers/{customer_id}/sync-status-with-olt")

    def mark_offline(self, customer_id: int) -> tuple[int, dict]:
        return self._send(
            "POST",
            f"/api/customers/{customer_id}/mark-offline",
            json={"reason": MARK_OFFLINE_REASON},
        )


def handle_customer(client: "Client", args, stats: dict, cid: int, name: str) -> None:
    """Verify one customer against the OLT and reconcile their status.

    Raises TransientError if the link kept failing; the caller skips and moves on.
    """
    na = client.network_access(cid)
    if not na:
        stats["no_olt_info"] += 1
        return
    stats["with_olt_info"] += 1

    code, body = client.verify(cid)
    if code != 200:
        stats["verify_failed"] += 1
        print(f"  {cid} {name}: verify failed ({code}) {body.get('error', '')}")
        return

    live = (body.get("verification", {}).get("live")) or {}
    flag = live.get("controlFlag")
    run_state = live.get("runState")

    if flag == "deactivated":
        stats["live_deactivated"] += 1
        if args.dry_run:
            stats["would_sync"] += 1
            print(f"  {cid} {name}: OLT deactivated -> WOULD SYNC")
            return
        scode, sbody = client.sync(cid)
        if scode == 200:
            stats["synced_disconnected"] += 1
            new_status = sbody.get("customer", {}).get("status", "disconnected")
            print(f"  {cid} {name}: synced -> {new_status}")
        else:
            stats["sync_skipped"] += 1
            print(f"  {cid} {name}: sync skipped ({scode}) {sbody.get('error', '')}")
        return

    if flag == "active" and run_state == "offline":
        stats["live_active_offline"] += 1
        if not args.mark_offline:
            print(f"  {cid} {name}: OLT active but OFFLINE - not touched (pass --mark-offline)")
            return
        if args.dry_run:
            stats["would_mark_offline"] += 1
            print(f"  {cid} {name}: OLT active but OFFLINE -> WOULD MARK OFFLINE")
            return
        mcode, mbody = client.mark_offline(cid)
        if mcode == 200:
            stats["marked_offline"] += 1
            print(f"  {cid} {name}: active+offline -> offline")
        else:
            stats["mark_offline_failed"] += 1
            print(f"  {cid} {name}: mark offline failed ({mcode}) {mbody.get('error', '')}")
        return

    stats["live_active_online"] += 1
    print(f"  {cid} {name}: OLT active/online - left as is")


def main() -> int:
    args = parse_args()
    password = getpass.getpass(f"Password for {args.username}: ")

    client = Client(args.base_url, args.timeout)
    client.login(args.username, password)
    print(f"Logged in as {args.username}. Base: {client.base}")
    if args.dry_run:
        print("DRY RUN: will verify but never sync or mark offline.\n")
    elif args.mark_offline:
        print("MARK-OFFLINE ON: active-but-offline ONTs will be set to 'offline' (DB only).\n")
    else:
        print("active-but-offline ONTs will be reported only (pass --mark-offline to act).\n")

    stats = {
        "delinquent_seen": 0,
        "no_olt_info": 0,
        "with_olt_info": 0,
        "verify_failed": 0,
        "live_active_online": 0,
        "live_active_offline": 0,
        "live_deactivated": 0,
        "synced_disconnected": 0,
        "sync_skipped": 0,
        "would_sync": 0,
        "marked_offline": 0,
        "mark_offline_failed": 0,
        "would_mark_offline": 0,
        "transient_skipped": 0,
    }

    first = client.delinquent_page(args.start_page)
    total_pages = int(first.get("pagination", {}).get("totalPages", 1))
    print(f"Delinquency list: {first.get('pagination', {}).get('total', '?')} customers, {total_pages} pages.\n")

    try:
        for page in range(args.start_page, total_pages + 1):
            data = first if page == args.start_page else client.delinquent_page(page)
            for row in data.get("rows", []):
                cid = int(row["customer_id"])
                name = row.get("customer_name") or ""
                stats["delinquent_seen"] += 1

                try:
                    handle_customer(client, args, stats, cid, name)
                except TransientError as exc:
                    # One customer the link would not hold still for. Note it,
                    # keep going; re-run later to pick up the stragglers.
                    stats["transient_skipped"] += 1
                    print(f"  {cid} {name}: skipped - {exc}")

                if args.max and stats["with_olt_info"] >= args.max:
                    raise StopIteration
                time.sleep(args.delay)
    except (KeyboardInterrupt, StopIteration):
        print("\nStopped early.")

    print("\n--- summary ---")
    for k, v in stats.items():
        print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TransientError as exc:
        raise SystemExit(f"\nGave up: {exc}\nThe link to the app kept failing. Try again in a bit.")
    except KeyboardInterrupt:
        raise SystemExit("\nInterrupted.")
