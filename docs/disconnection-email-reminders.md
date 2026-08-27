# Five-day disconnection email reminders

SPCL checks once each day for active customers whose due date passed five
Jamaica calendar days ago and whose ten-day grace period ends in five days. It
sends one email warning per customer and grace-period end date from the separate
`notifications@fywycable.com` FYWY Cable Workspace mailbox.
The message is labelled as automated/do-not-reply and gives SPCL's telephone
and WhatsApp numbers instead of asking customers to reply.

## Who qualifies

A customer is queued only when all of these are true:

- the account is active and visible in SPCL;
- the calculated outstanding balance is greater than zero;
- the due date passed exactly five days ago;
- the ten-day grace period ends exactly five days from today;
- no disconnection hold is active;
- the account has a usable email address.

Unverified historical billing entries do not block this reminder. The message
does not state an outstanding amount, but SPCL still requires a recorded
positive balance and the exact due/grace dates before sending.

The worker checks those rules again immediately before sending. A payment,
hold, status change, revised disconnection date, or hidden account therefore
cancels a queued warning. If the account email changes before delivery, SPCL
uses the current address.

## Safety and delivery

Migrations `059_add_disconnection_email_reminders.sql`,
`060_align_email_reminders_to_grace_period.sql`, and
`061_version_email_reminder_eligibility.sql` create the durable queue, align it
to the ten-day grace period, and safely version eligibility changes. The unique
key allows only one five-day warning per customer and grace-period end date,
even after an API restart.
Failed Gmail requests retry up to three times by default; missing or invalid
emails are recorded as skips.

The queue sends a small batch each minute and has a separate daily cap. That
keeps routine reminder delivery from delaying counter receipt emails. Reminder
Gmail credentials remain in the NAS `.env.production` file, separate from the
receipt mailbox credentials. They are not stored in the database or repository.

Authorize the new mailbox with the existing Google Cloud OAuth client JSON:

```sh
cd server
npm run authorize:gmail -- /absolute/path/to/oauth-client.json --profile=reminders
```

Sign in as `notifications@fywycable.com` when Google opens. The command creates
the protected, gitignored `server/.env.gmail.reminders` file. Copy its five
`REMINDER_GMAIL_*` values into the NAS `.env.production` file.

## First rollout

Before the first live run, preview the exact eligible list on the NAS:

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
  b.oldest_unpaid_due_date AS due_date,
  b.grace_end_date
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE c.status = 'active'
  AND c.hidden_from_app = FALSE
  AND b.outstanding_balance > 0
  AND b.oldest_unpaid_due_date =
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 5
  AND b.grace_end_date =
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE + 5
  AND b.is_on_hold = FALSE
  AND c.email IS NOT NULL
  AND LENGTH(BTRIM(c.email)) <= 254
  AND BTRIM(c.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
ORDER BY b.grace_end_date, c.customer_id;

ROLLBACK;
SQL
```

Review the names, balances, dates, and addresses before enabling anything.
Then set the following in the NAS `.env.production` file and redeploy:

```dotenv
EMAIL_REMINDERS_ENABLED=true
EMAIL_REMINDERS_START_DATE=2026-08-27
EMAIL_REMINDERS_HOUR=7
EMAIL_REMINDERS_MINUTE=30
EMAIL_REMINDERS_BATCH_SIZE=20
EMAIL_REMINDERS_DAILY_LIMIT=1500
EMAIL_REMINDERS_MAX_ATTEMPTS=3
```

The hour and minute are Jamaica time. The start date is a fail-closed first-run
lock: no reminder can be queued or sent before that Jamaica calendar date. On
and after the start date, if the API first starts after the chosen time, it
creates that day's queue instead of waiting until tomorrow.

## Checking results

Run summaries are in `customer_email_notification_runs`. Individual delivery
records are in `customer_email_notifications`, with `sent`, `failed`,
`skipped_no_email`, and `skipped_no_longer_eligible` outcomes. Successful
sends also create an immutable customer audit-log entry.

To stop new reminders immediately, set `EMAIL_REMINDERS_ENABLED=false` and
restart the API container. Existing queued rows remain available for auditing;
they are not processed while the switch is off.
