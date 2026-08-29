#!/usr/bin/env python3
"""
Walk the delinquency list and, for every customer that has OLT info on their
profile, verify against the U2000/OLT and take the matching action:

  1. POST /api/customers/{id}/network-access/verify      ("Verify with OLT")
  2a. live ONT control flag is "deactivated" but the account is still active:
      POST /api/customers/{id}/sync-status-with-olt       ("Sync")  -> disconnected
  2b. live ONT is "active" but "offline" (registered, no service) and
      --mark-offline is passed:
      POST /api/customers/{id}/mark-offline               -> offline
  2c. live ONT is "active" AND "online" (getting service) and the customer
      owes a lot and has not paid in months and --disconnect-nonpaying is
      passed:
      POST /api/customers/{id}/deactivate                 -> disconnected

Steps 2a and 2b are database-only reconciliations: no OLT command, no balance
change, no fee. Step 2c is the ONE action that sends a real deactivate command
to the OLT and creates a reconnection fee, and it only runs when you ask for it.

Runs on your computer against the app you normally log in to. The login user
must be Admin or Head Office.

    pip install requests
    python3 tools/sync_delinquent_olt_status.py --base-url https://YOUR-APP-URL --username kdunn7

Options:
    --dry-run              verify only; report what WOULD change, change nothing
    --mark-offline         mark customers whose ONT is active-but-offline as
                           'offline' (database only, no OLT command, no fee)
    --disconnect-nonpaying cut off (real OLT deactivate + reconnection fee)
                           customers who are active AND online on the OLT, owe
                           more than --min-outstanding, and have not paid within
                           --unpaid-months
    --min-outstanding N    balance threshold for --disconnect-nonpaying (default 15000)
    --unpaid-months N      months since last payment for --disconnect-nonpaying (default 7)
    --max N                stop after N customers that have OLT info
    --delay SEC            pause between customers (default 1.0)
    --start-page N         delinquency-list page to start from (default 1)
"""
from __future__ import annotations

import argparse
import calendar
import datetime
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
    p.add_argument(
        "--disconnect-nonpaying",
        action="store_true",
        help="cut off customers who are active AND online on the OLT, owe more "
        "than --min-outstanding, and have not paid within --unpaid-months "
        "(sends a real OLT deactivate command and creates a reconnection fee)",
    )
    p.add_argument(
        "--min-outstanding",
        type=float,
        default=15000.0,
        help="balance threshold for --disconnect-nonpaying (default 15000)",
    )
    p.add_argument(
        "--unpaid-months",
        type=int,
        default=7,
        help="months since last payment for --disconnect-nonpaying (default 7)",
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

    def deactivate(self, customer_id: int, reason: str) -> tuple[int, dict]:
        # The server requires the confirmation string exactly, and for an
        # OLT-mapped customer this sends the real deactivate command.
        return self._send(
            "POST",
            f"/api/customers/{customer_id}/deactivate",
            json={"reason": reason, "confirmation": f"DEACTIVATE {customer_id}"},
        )


def _months_ago(months: int) -> datetime.date:
    today = datetime.date.today()
    total = today.year * 12 + (today.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    day = min(today.day, calendar.monthrange(year, month)[1])
    return datetime.date(year, month, day)


def qualifies_for_disconnect(row: dict, args) -> tuple[bool, str]:
    """A deeply delinquent customer who is still getting service.

    Returns (matches, human-readable detail).
    """
    try:
        outstanding = float(row.get("outstanding_balance") or 0)
    except (TypeError, ValueError):
        outstanding = 0.0
    if outstanding <= args.min_outstanding:
        return False, f"owes J${outstanding:,.0f} (<= J${args.min_outstanding:,.0f})"

    last_paid = row.get("last_payment_date")
    if last_paid:
        try:
            paid_date = datetime.date.fromisoformat(str(last_paid)[:10])
        except ValueError:
            paid_date = None
        if paid_date and paid_date >= _months_ago(args.unpaid_months):
            return False, f"owes J${outstanding:,.0f} but paid {paid_date.isoformat()}"

    return True, f"owes J${outstanding:,.0f}, last paid {str(last_paid)[:10] if last_paid else 'never'}"


def handle_customer(client: "Client", args, stats: dict, row: dict) -> None:
    """Verify one customer against the OLT and take the matching action.

    Raises TransientError if the link kept failing; the caller skips and moves on.
    """
    cid = int(row["customer_id"])
    name = row.get("customer_name") or ""

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
    if not args.disconnect_nonpaying:
        print(f"  {cid} {name}: OLT active/online - left as is")
        return

    matches, detail = qualifies_for_disconnect(row, args)
    if not matches:
        print(f"  {cid} {name}: active/online, keeping - {detail}")
        return

    stats["nonpaying_match"] += 1
    if args.dry_run:
        stats["would_disconnect"] += 1
        print(f"  {cid} {name}: active/online + {detail} -> WOULD DISCONNECT")
        return

    reason = (
        f"Bulk disconnection: {detail} while the ONT was still active and online. "
        f"Rule: over J${args.min_outstanding:,.0f} owing and no payment in "
        f"{args.unpaid_months}+ months."
    )
    dcode, dbody = client.deactivate(cid, reason)
    if dcode == 200:
        stats["disconnected_nonpaying"] += 1
        print(f"  {cid} {name}: active+online + {detail} -> DISCONNECTED")
    else:
        stats["disconnect_failed"] += 1
        print(f"  {cid} {name}: disconnect failed ({dcode}) {dbody.get('error', '')}")


def main() -> int:
    args = parse_args()
    password = getpass.getpass(f"Password for {args.username}: ")

    client = Client(args.base_url, args.timeout)
    client.login(args.username, password)
    print(f"Logged in as {args.username}. Base: {client.base}")
    if args.dry_run:
        print("DRY RUN: will verify but never sync, mark offline, or disconnect.")
    if args.mark_offline:
        print("MARK-OFFLINE ON: active-but-offline ONTs will be set to 'offline' (DB only).")
    if args.disconnect_nonpaying:
        print(
            f"DISCONNECT-NONPAYING ON: active+online ONTs whose customer owes more than "
            f"J${args.min_outstanding:,.0f} and has not paid in {args.unpaid_months}+ months "
            f"will be CUT OFF on the OLT (real deactivate + reconnection fee)."
        )
    if not (args.mark_offline or args.disconnect_nonpaying):
        print("Report only - pass --mark-offline and/or --disconnect-nonpaying to act.")
    print()

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
        "nonpaying_match": 0,
        "disconnected_nonpaying": 0,
        "disconnect_failed": 0,
        "would_disconnect": 0,
        "transient_skipped": 0,
    }

    # Collect every row up front. sync / mark-offline / disconnect all remove
    # the customer from the delinquency list, so paging through it live would
    # shift every later row up by one and silently skip people. The listing is
    # cheap (no OLT calls); snapshot it, then work the fixed list.
    first = client.delinquent_page(args.start_page)
    total_pages = int(first.get("pagination", {}).get("totalPages", 1))
    rows = list(first.get("rows", []))
    for page in range(args.start_page + 1, total_pages + 1):
        rows.extend(client.delinquent_page(page).get("rows", []))
    print(
        f"Delinquency list: {first.get('pagination', {}).get('total', '?')} customers; "
        f"{len(rows)} collected from pages {args.start_page}-{total_pages}.\n"
    )

    try:
        for row in rows:
            cid = row.get("customer_id")
            name = row.get("customer_name") or ""
            stats["delinquent_seen"] += 1

            try:
                handle_customer(client, args, stats, row)
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
