# Huawei ONT safe-match import

`customer_ont_assignments` is the join table between an SPCL customer and the
shared `olts` inventory table. Do not add Huawei columns directly to
`customers`; the join row can keep history when an ONT or port changes.

The importer reads private PuTTY logs, compares each U2000 Description with the
current PostgreSQL customer name, and accepts only an exact one-to-one match.
It never changes a customer's billing/account status and never sends a command
to the OLT.

## Safety rules

- Dry-run is the default. Only `--apply` writes rows.
- Huawei parser warnings stop the run.
- Fuzzy names, duplicate customer names, and customers appearing on multiple
  ONTs are withheld.
- Existing customer mappings, occupied OLT locations, and reused ONT serials
  are withheld instead of overwritten.
- Imported mappings use `source = 'u2000_import'` and remain `unverified` until
  a future live OLT check confirms the tuple and serial.
- The whole write is one transaction and is safe to rerun.

## Local or tunneled database

From `server/`, with its PostgreSQL environment variables pointing at the
correct database:

```bash
npm run import:ont-matches -- \
  --file /private/path/ont-sample.txt \
  --file /private/path/newport-card11-ports1-15.txt \
  --olt-name NEWPORT \
  --management-ip 192.168.1.3 \
  --report /private/path/newport-olt-import-report.json
```

For the supplied Newport logs and an unchanged customer list, the first report
should show 1,872 parsed ONTs, 1,767 exact one-to-one matches, and 105 records
requiring name review. The live database may reduce `readyToInsert` if staff
have already added mappings.

After reading that dry-run report and taking a database backup, repeat the same
command with `--apply` at the end. A successful rerun should report the imported
rows as `alreadyPresent`, not create duplicates.

## Production container

The production image contains compiled JavaScript rather than the TypeScript
runner. Copy the two private logs into a temporary container location and run:

```bash
docker exec spcl-api node dist/scripts/importHuaweiOntMatches.js \
  --file /tmp/ont-sample.txt \
  --file /tmp/newport-card11-ports1-15.txt \
  --olt-name NEWPORT \
  --management-ip 192.168.1.3 \
  --report /tmp/newport-olt-import-report.json
```

Add `--apply` only after the dry-run counts have been reviewed. Copy the report
out if it is needed, then remove the temporary logs and report from the
container because they contain customer names and ONT serial numbers.
