# SPCL — database operations

Two routine jobs, both run from inside the `spcl-backup` container on the NAS:

1. **Is there a usable backup?** — `backup-check.sh`
2. **Get a change onto the production database** — `migrate.sh`

The backup container is used for both because it is the only container with
`psql`, the database credentials, a route to the private `spcl-postgres`
container, and the NAS backup folder mounted. Nothing new has to be installed
on the NAS.

---

## One-time setup

### 1. Give the backup container the migrations folder

`docker-compose.prod.yml` now mounts `./database` into the backup container
read-only. Pick it up with:

```bash
cd /mnt/md0/SPCL/deployment          # your real path

docker compose -f docker-compose.prod.yml --env-file .env.production \
  up -d --force-recreate backup
```

Only the backup container restarts. The API and database keep running.

### 2. Baseline each existing database — once

Both databases already have all 32 migrations applied by hand, but nothing
records that. Baselining writes those 32 filenames into a tracking table
**without running any of them**, so later runs only apply genuinely new files.

On the NAS:

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh --baseline
```

On your Mac, against the local dev database:

```bash
docker exec -i spcl-postgres psql -U spcl_user -d spcl_db < /dev/null   # sanity check it answers
MIGRATIONS_DIR=database/migrations SKIP_BACKUP=true \
  PGHOST=localhost PGUSER=spcl_user PGPASSWORD=spcl_dev_password PGDATABASE=spcl_db \
  sh deploy/migrate.sh --baseline
```

Skipping this step on a database that already has tables is caught and
refused — the script will not re-run migration 001 over live data.

---

## Checking the backups

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/backup-check.sh
```

Checks the most recent dump is under 26 hours old, is large enough to be real,
that its sha256 still matches, that more than one restore point exists, that
roles were captured, and that `backup.log` has no recent failures. Exits 0 when
everything passes and 1 when something needs attention, so it also works as a
scheduled job.

The check that matters most is the age one. A NAS folder that is mounted but
pointing at the wrong path fails silently — the container writes happily into
its own filesystem and nothing reaches the drive. A recent dump on disk is the
proof the mount is real.

**Monthly, prove a dump actually restores:**

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/restore-verify.sh
```

A backup nobody has restored is a guess. This one restores into a scratch
database, prints row counts, and drops it again; the live database is never
touched.

---

## Getting a change onto the NAS

### Schema changes

Write a new numbered file in `database/migrations/`, test it locally, copy the
repository to the NAS as usual, then:

```bash
# See what would happen. Changes nothing.
docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh --dry-run

# Apply it.
docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh
```

What it does, in order: takes a fresh dump first (so rollback is never worse
than losing the minutes since the deploy started), then applies each pending
file in filename order, each one inside a single transaction together with its
own tracking row. A migration that fails rolls back completely and stops the
run — it can never half-apply, and can never be recorded as applied when it
was not.

Rules of the road:

- **Never edit a migration that has already been applied.** The database no
  longer matches the file, and the two databases drift apart. `migrate.sh`
  compares checksums and warns when this has happened. Write a new file for
  the difference instead.
- **Zero-padded numbers, no reuse.** `033_`, `034_`. Order is filename order.
- **Prefer idempotent SQL** — `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`.

### One-off data changes

Things like adding employees are data, not schema, and do not belong in
`database/migrations/`. Put them in `database/scripts/` and run them by hand,
after a backup:

```bash
# Backup first, always.
docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh

# Then run it. The repo is mounted read-only inside the container.
docker exec -it spcl-backup psql -f /opt/spcl-database/scripts/add_employees.sql
```

`add_employees.sql` is safe to run twice — it reports `INSERT 0 3` the first
time and `INSERT 0 0` after that.

### Checking where things stand

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh --status
```

Prints how many migrations are applied, what is pending, and the five most
recent. Run it against both databases when they seem out of step — that is
what caught the three employees existing on the Mac but not on the NAS.

---

## Known issue: these migrations cannot be replayed from scratch

Running all 32 against an empty database does not work. Verified against
PostgreSQL 16:

- **`009_create_staging_payments.sql`** ends with a stray `-` after the final
  `);`. A lone hyphen is not a comment marker, so it is a syntax error. Run
  with plain `psql` the error scrolls past and the table still gets created,
  which is why it went unnoticed.
- **`009` and `010` both create `staging.payments`** in different shapes. `010`
  is described in its own comment as "the earlier minimal shape", so the
  numbering is backwards relative to the history. Applied in filename order,
  `010` fails with `relation "payments" already exists`.
- **`012_migrate_payments.sql`** needs `month_paid`, a column that exists in
  `010`'s shape but not `009`'s. It fails on a fresh database regardless of
  which of the two ran.

None of this affects the running system. Both databases already have every
migration applied, `--baseline` records that fact without executing anything,
and only new files ever run from here on.

What it does mean: **rebuilding from migrations is not a recovery path.**
Recovery is `pg_restore` from a nightly dump — which is the more reliable
option anyway, since it brings back the data too. This is worth cleaning up
only if you ever want to stand up a fresh branch database from source.

---

## If something goes wrong

A migration that fails has already rolled itself back; the database is as it
was before that file started. Fix the SQL and run again.

To go back further, restore the safety dump `migrate.sh` took immediately
before the run:

```bash
docker exec -it spcl-backup ls -lt /backups/daily | head

docker exec -it spcl-backup pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  --dbname=spcl_db /backups/daily/spcl-YYYY-MM-DD-HHMMSS.dump
```

Anything written between that dump and the restore is lost, so check the
timestamp before running it.

---

## Cadence

| When | What |
|---|---|
| After any deploy | `migrate.sh --status` on both databases |
| Weekly | `backup-check.sh` |
| Monthly | `restore-verify.sh`, and plug in the USB drive |
| Never | Editing a migration that has already been applied |
