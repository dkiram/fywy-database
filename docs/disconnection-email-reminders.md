# Five-day disconnection email reminders

SPCL checks once each day for active customers whose scheduled disconnection
date is exactly five Jamaica calendar days away. It sends one email warning per
customer and scheduled date from the existing FYWY Cable Gmail configuration.
The message is labelled as automated/do-not-reply and gives SPCL's telephone
and WhatsApp numbers instead of asking customers to reply.

## Who qualifies

A customer is queued only when all of these are true:

- the account is active and visible in SPCL;
- the calculated outstanding balance is greater than zero;
- the calculated disconnection date is exactly five days away;
- no disconnection hold is active;
- the account ledger has no unverified entries; and
- the account has a usable email address.

The worker checks those rules again immediately before sending. A payment,
hold, status change, revised disconnection date, or hidden account therefore
cancels a queued warning. If the account email changes before delivery, SPCL
uses the current address.

## Safety and delivery

Migration `059_add_disconnection_email_reminders.sql` creates a durable queue
and run history. The unique key allows only one five-day warning per customer
and disconnection date, even after an API restart. Failed Gmail requests retry
up to three times by default; missing or invalid emails are recorded as skips.

The queue sends a small batch each minute and has a separate daily cap. That
keeps routine reminder delivery from delaying counter receipt emails. Gmail
credentials remain in the NAS `.env.production` file and are not stored in the
database or repository.

## First rollout

Deploy with `EMAIL_REMINDERS_ENABLED=false`. After migration 059 is applied,
preview today's exact eligible list on the NAS:

```sh
docker exec -i spcl-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;
SELECT public.spcl_generate_monthly_charges(
  (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
);

SELECT
  c.customer_id,
  c.name,
  c.email,
  b.outstanding_balance,
  b.scheduled_disconnection_date
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE c.status = 'active'
  AND c.hidden_from_app = FALSE
  AND b.outstanding_balance > 0
  AND b.scheduled_disconnection_date =
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE + 5
  AND b.is_on_hold = FALSE
  AND b.unverified_entries = 0
  AND c.email IS NOT NULL
  AND LENGTH(BTRIM(c.email)) <= 254
  AND BTRIM(c.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
ORDER BY b.scheduled_disconnection_date, c.customer_id;

ROLLBACK;
SQL
```

Review the names, balances, dates, and addresses before enabling anything.
Then set the following in the NAS `.env.production` file and redeploy:

```dotenv
EMAIL_REMINDERS_ENABLED=true
EMAIL_REMINDERS_HOUR=8
EMAIL_REMINDERS_MINUTE=0
EMAIL_REMINDERS_BATCH_SIZE=20
EMAIL_REMINDERS_DAILY_LIMIT=1500
EMAIL_REMINDERS_MAX_ATTEMPTS=3
```

The hour and minute are Jamaica time. If the API first starts after the chosen
time, it still creates that day's queue instead of waiting until tomorrow.

## Checking results

Run summaries are in `customer_email_notification_runs`. Individual delivery
records are in `customer_email_notifications`, with `sent`, `failed`,
`skipped_no_email`, and `skipped_no_longer_eligible` outcomes. Successful
sends also create an immutable customer audit-log entry.

To stop new reminders immediately, set `EMAIL_REMINDERS_ENABLED=false` and
restart the API container. Existing queued rows remain available for auditing;
they are not processed while the switch is off.
