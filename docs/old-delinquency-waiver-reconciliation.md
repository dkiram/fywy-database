# One-time old-delinquency waiver requests

`requestOldDelinquencyWaivers.js` reduces false old arrears without directly
changing any customer balance. It creates pending requests in the normal
discount approval queue. An administrator must still review and approve each
request before its waiver is posted.

## Eligibility

A customer is included only when all of these are true at run time:

- the account is active, visible, and delinquent;
- the balance is exactly one current monthly fee, and that balance is entirely
  monthly charges minus monthly payments — no reconnection fee, adjustment,
  opening balance, or waiver is mixed in;
- the six most recent monthly charges that have come due are each paid in full
  (matched by the month the payment was *for*);
- no discount request is currently pending; and
- no earlier request, in any status, has the note
  `one time waiver for new system`.

Because the six most recent due charges are all paid and the account still owes
one fee, the unpaid charge is more than six months old. A payment missed within
the last six months leaves one of those six charges short, so the customer is
skipped and left alone.

The ledger's oldest-unpaid date is **not** used to date the gap. Payments apply
oldest-first (FIFO), so a customer who missed one month years ago but has paid
every month since shows the *newest* charge as unpaid. Only the payment-by-month
history reveals whether the gap is old or current.

Payment continuity uses **Month Paid For**, not the day the receipt was keyed.
That keeps an early or late counter visit from creating a false gap. A paid-for
month counts only when its payments total *exactly* the monthly fee: a partial
month is treated as unpaid, and a month carrying prepayment for another month is
not counted, so both cases skip the customer.

## Run it

Take a production backup first:

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh
```

Preview using the username of the employee who is requesting the discounts. If
the username is wrong the script prints the list of employees allowed to request
discounts and stops.

```bash
docker exec -it spcl-api node dist/scripts/requestOldDelinquencyWaivers.js --requested-by USERNAME
```

The preview obtains the same locks and runs the same query as apply mode, then
rolls back everything. It prints every customer, fee, outstanding balance, the
date of their first monthly charge, the ledger's (FIFO) oldest-unpaid date, and
the exact eligible count. Read the list before applying: every row should be a
long-standing customer whose only debt is one fee from more than six months ago.

If the preview says, for example, 14 customers, apply that exact reviewed
count:

```bash
docker exec -it spcl-api node dist/scripts/requestOldDelinquencyWaivers.js --requested-by USERNAME --apply --expected-count 14 --confirmation "REQUEST 14 ONE-TIME WAIVERS"
```

The whole batch is one database transaction. If the eligible count changes,
the confirmation is wrong, or any insert fails, no requests are saved. Re-runs
skip every customer who has already received this one-time request, including a
request that an administrator later rejected or reversed.

After a successful run, review the created items in the Admin discount approval
queue. The script deliberately does not approve them.
