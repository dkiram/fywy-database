# Reconcile account status from the OLT

`reconcileDisconnectedFromOlt.ts` marks accounts `disconnected` when the live OLT
already shows their ONT `deactivated` but the account is still `active`.

- **Read-only against the OLT.** One `display ont info <pon> all` per PON port,
  no Huawei write, ever.
- **No money touched.** Existing charges stay; migration 054's trigger stops new
  ones once the `disconnected` status-history row exists.
- **Safe matching.** An account is transitioned only when the live ONT at the
  saved location is `deactivated` **and** its serial matches the saved serial
  **and** (unless `--skip-name-match`) its description matches the customer name.

Needs `HUAWEI_OLT_CONNECTIONS_JSON` configured on the NAS (same as the app's
OLT verification and `bulkVerifyHuaweiMappings`).

## Run it

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh
```

Preview — reads the OLT, writes nothing:

```bash
docker exec -it spcl-api node dist/scripts/reconcileDisconnectedFromOlt.js --performed-by USERNAME
```

It prints a per-account table and a summary (ports read, port errors, ONT not
found, serial/name mismatches skipped, still active on the OLT, and the count it
would disconnect), then the exact apply command.

Apply the reviewed count:

```bash
docker exec -it spcl-api node dist/scripts/reconcileDisconnectedFromOlt.js --performed-by USERNAME --apply --expected-count 120 --confirmation "RECONCILE 120 OLT DISCONNECTED ACCOUNTS"
```

Each account is its own transaction, guarded by `status = 'active'`, so a re-run
after a partial failure just picks up the rest.

### Options

- `--management-ip <IP>` — one OLT only (default: every active OLT).
- `--include-non-delinquent` — also reconcile active accounts that are not
  currently delinquent but whose ONT is deactivated.
- `--skip-name-match` — match on location + serial only. Less safe; use only when
  descriptions on the OLT are known to be unreliable.
