# Overdue legacy disconnection cleanup

`disconnectOverdueLegacyAccounts.ts` marks legacy accounts that should have been
disconnected in 2025 (or earlier) but are still `active` and still being billed.

It changes account status only. **It never touches money.** Existing monthly
charges stay on the ledger; once the `disconnected` status-history row exists,
migration 054's trigger stops new ones, and the already-raised charges appear in
`customer_offline_monthly_charge_review` for a separate, audited decision.

## Who it selects

All of these must be true:

- `status = 'active'`, not hidden, and a legacy account (`source_staging_id` set);
- currently delinquent, with a balance greater than zero;
- `customer_billing_status.grace_end_date` is before the cutoff
  (default `2026-01-01` — i.e. the account's grace period ended during 2025 or
  earlier);
- not covered by an active disconnection hold;
- no discount request pending.

Accounts that also have a **current ONT assignment** (`customer_ont_assignments`
with `ended_at IS NULL`) are **not touched** — they are listed separately so they
can be disconnected through the normal OLT workflow, where the Huawei command and
the status change happen together.

## Run it

Take a backup first:

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh
```

Preview (always rolls back). A wrong username prints the list of employees
allowed to perform this:

```bash
docker exec -it spcl-api node dist/scripts/disconnectOverdueLegacyAccounts.js --performed-by USERNAME
```

The preview prints two groups — the ONT-mapped accounts it will leave alone, and
the accounts it will disconnect — plus the exact eligible count and the total of
monthly charges already raised since each missed disconnection date.

Apply the reviewed count:

```bash
docker exec -it spcl-api node dist/scripts/disconnectOverdueLegacyAccounts.js --performed-by USERNAME --apply --expected-count 40 --confirmation "DISCONNECT 40 LEGACY OVERDUE ACCOUNTS"
```

The whole batch is one transaction. If the count changes or the confirmation is
wrong, nothing is written. Re-runs skip accounts already disconnected.

### Options

- `--include-ont-mapped` — also disconnect accounts that have a current ONT
  assignment (DB status only; the ONT still needs the OLT deactivate command
  afterwards). Default leaves those for the OLT workflow.
- `--grace-ended-before YYYY-MM-DD` — move the cutoff (default `2026-01-01`).
- `--effective-date today|eligible` — `today` (default) records the
  disconnection now; `eligible` backdates it to the day after grace ended
  (never before the account's most recent status-history event), which also
  flags every monthly charge since then as raised while offline.

## After

- Review the disconnected accounts in the Attention / Disconnected view.
- Decide separately whether to reverse the monthly charges raised while the
  account should have been off (`customer_offline_monthly_charge_review`).
- Sync the ONT-mapped accounts to the OLT through the normal disconnection flow.
