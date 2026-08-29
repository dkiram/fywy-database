# Account suspension

Migration `067_add_suspended_account_status.sql`.

## What it is

A customer who will be away — overseas, a house shut for the season — asks SPCL
to stop their service rather than keep paying the full package rate. Their ONT
is deactivated exactly as it is for a disconnection: physically this **is** a
disconnection, and no service reaches the house. Only the money is different.

| | `disconnected` | `offline` | `suspended` |
|---|---|---|---|
| OLT command sent | yes | no | yes |
| Billed while off | nothing | nothing | J$500/month |
| Fee charged | J$1,500 at cutoff | none | J$500 or J$1,500, at return |
| Who chose it | SPCL (non-payment) | nobody (a fault) | the customer |

## The rules

* **J$500 a month while suspended.** The charge falls on the monthly
  anniversary of the day the customer was suspended, starting on that day
  itself. Suspended 10 August and back on 5 September is **one** J$500 charge,
  not two — one month away, one month billed. The 29th, 30th and 31st clamp to
  the last day of a short month, the same way the package charge does.
* **Coming back costs J$500 within three months**, and the customer's normal
  package reconnection fee (J$1,500) after that. The boundary is inclusive:
  suspended 10 August and back on 10 November is three months to the day and
  still J$500. 11 November is the first day it becomes J$1,500.
* **Passing three months raises the fee; it does not stop the monthly charge.**
  A customer away seven months owes seven J$500 charges *and* J$1,500 to return.

The three numbers and the three-month threshold live in `public.suspension_terms`,
one editable row, so the office can change them without a deploy. Charges
already in the ledger are never rewritten when they change — the ledger keeps
what a customer was actually billed at the time, the same rule
`customer_rate_history` follows for package rates.

## Why the fee is charged at the end, not the start

An ordinary disconnection charges its reconnection fee the moment service is
cut, because that fee is a fixed property of the package. A suspension cannot:
on the day the customer leaves, nobody knows yet whether they will be back
inside three months at J$500 or after them at J$1,500.

So the fee is posted by `postSuspensionReconnectionFee` inside the reconnection
transaction, *before* the cleared-balance check. Two consequences worth knowing:

* The fee is part of what the customer has to clear, so a clerk quoting only
  the outstanding balance sends them away short. Use `total_due_to_reconnect`
  from `customer_suspension_status`, which already includes it.
* A reconnection that fails the balance check rolls the fee back with
  everything else, so no stale price is ever left on the account. The customer
  pays at the counter first, then the reconnection commits.

## The workflow

```
active ──suspend──> suspended ──end-suspension──> active
                        │
                        └──deactivate──> disconnected
```

* `POST /api/customers/:id/suspend` — Admin and Head Office, from `active`
  only. A customer already cut off for non-payment does not get to convert that
  into a J$500 arrangement after the fact. Sends the real OLT deactivate
  command when the rollout gate covers the customer; confirmation is
  `SUSPEND <id>`.
* `POST /api/customers/:id/end-suspension` — one direct transition back to
  `active`, gated on a cleared balance, with the usual audited
  `adminBalanceOverride` available. Confirmation is `RECONNECT <id>`.
* `POST /api/customers/:id/deactivate` now also accepts `suspended`. This is
  the write-off path for a customer who went away, stopped answering and
  stopped paying the holding fee: it ends the suspension, stops it accruing,
  and charges the normal package reconnection fee.
* `GET /api/customers/:id/suspension` — the read-only counter quote. Writes
  nothing.

A suspension deliberately does **not** pass through `pending_reconnection`.
That queue exists to hold a disconnected customer while an Admin decides
whether to let them back on owing money; routing a suspension through it would
mean a cancelled request either resets the three-month clock or strands the
customer in `disconnected`. A customer who cannot pay simply stays suspended
and keeps accruing, which is both simpler and what actually happens.

## What suspension inherits for free

* **The full package charge stops by itself.** Migration 054's `BEFORE INSERT`
  trigger on `account_ledger_entries` refuses any `monthly_charge` for a date
  the account was not `active`. Migration 067 extends the same trigger in the
  other direction, refusing a `suspension_charge` for a date the account was
  not `suspended` — otherwise a rerun after the customer returns would keep
  minting J$500 charges for months they were already paying full rate for.
* **Every chase list drops the account.** The delinquency list, the dashboard
  delinquent count, the five-day reminder emails and the automatic OLT
  disconnection run all filter `status = 'active'`, so a suspended account
  leaves all of them with no change to those queries. Nothing will
  auto-disconnect a customer who is already off the network by arrangement,
  however far behind the J$500 charges fall.
* **Holding charges stay current everywhere.**
  `spcl_generate_monthly_charges` now calls `spcl_generate_suspension_charges`
  before its own once-a-day guard, so every existing caller — the balance check
  inside an account transition, the payment screen, the nightly run — sees a
  suspended customer's true balance without knowing suspension exists.

## What it deliberately does not do

* **Payments are not blocked.** `offline` accounts cannot take a payment;
  suspended accounts must, or they could never clear the balance that lets them
  back on. There is a comment in `routes/payments.ts` saying so, because the
  two statuses look similar enough that someone will eventually try to add it.
* **`ready_for_reconnection` still excludes `suspended`.** It would read TRUE
  for a customer who has cleared their holding fees but not yet paid the
  reconnection fee — which is exactly the misleading case. The suspension quote
  view carries the truth for these accounts instead.
* **`spcl_regenerate_customer_charges` leaves suspension charges alone.** They
  are not derived from `customer_rate_history`, so a rebuild has nothing better
  to replace them with, and deleting them would quietly forgive real money.

## Reading the state

```sql
-- Who is away, and what do they owe to come back?
SELECT * FROM public.customer_suspension_status ORDER BY suspended_on;

-- Every suspension a customer has ever had; ended_on IS NULL means current.
SELECT * FROM public.customer_suspension_episodes WHERE customer_id = 1234;

-- What would it cost this customer to return on a given date?
SELECT public.spcl_suspension_reconnection_fee(1234, CURRENT_DATE);
```

Ledger entries carry two new `entry_type` values: `suspension_charge` for the
monthly holding fee and `suspension_reconnection_fee` for the return fee. The
second is deliberately not reusing `reconnection_fee`, so reporting can tell a
customer who suspended on purpose apart from one who was cut off for
non-payment.
