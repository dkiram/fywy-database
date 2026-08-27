# One-time old-delinquency waiver requests

`requestOldDelinquencyWaivers.js` reduces false old arrears without directly
changing any customer balance. It creates pending requests in the normal
discount approval queue. An administrator must still review and approve each
request before its waiver is posted.

## Eligibility

A customer is included only when all of these are true at run time:

- the account is active, visible, and delinquent;
- the balance is exactly one current monthly fee;
- the oldest unpaid ledger item is a monthly service charge due more than six
  months ago;
- the latest paid-for month is this month or last month;
- each of the six consecutive paid-for months ending there totals exactly one
  current monthly fee;
- no discount request is currently pending; and
- no earlier request, in any status, has the note
  `one time waiver for new system`.

Payment continuity uses **Month Paid For**, not the day the receipt was keyed.
That keeps an early or late counter visit from creating a false gap. Split
payments are accepted only when their total for that paid-for month is exactly
the monthly fee.

## Run it

Take a production backup first:

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh
```

Preview using the username of the employee who is requesting the discounts:

```bash
docker exec -it spcl-api node dist/scripts/requestOldDelinquencyWaivers.js \
  --requested-by USERNAME
```

The preview obtains the same locks and runs the same query as apply mode, then
rolls back everything. It prints every customer, fee, outstanding balance, old
due date, latest paid month, and the exact eligible count.

If the preview says, for example, 14 customers, apply that exact reviewed
count:

```bash
docker exec -it spcl-api node dist/scripts/requestOldDelinquencyWaivers.js \
  --requested-by USERNAME \
  --apply \
  --expected-count 14 \
  --confirmation "REQUEST 14 ONE-TIME WAIVERS"
```

The whole batch is one database transaction. If the eligible count changes,
the confirmation is wrong, or any insert fails, no requests are saved. Re-runs
skip every customer who has already received this one-time request, including a
request that an administrator later rejected or reversed.

After a successful run, review the created items in the Admin discount approval
queue. The script deliberately does not approve them.
