# Staff review — applied September 15, 2026

Committed 26 account corrections under employee 2, net balance increase J$64,500.
The rollback rehearsal and post-commit production audit passed. All 30 reviewed
accounts match the staff-approved targets; the four confirmed zero accounts needed
no correction. The approved targets and observed balances are in
`staff-approved-targets.json` and `staff-correction-commit-audit.json`.

| Account | Outstanding / credit | Grace through | Disconnection eligible from |
|---|---:|---|---|
| 38 — Jennifer Williams | J$3,500 outstanding | September 19 | September 20 |
| 2525 — Le-Ann Swaby | J$1,500 outstanding | September 19 | September 20 |
| 9946 — Karlene Heron | J$1,500 outstanding | September 16 | September 17 |
| 9524 — Mary Nicholson | J$1,000 credit | — | — |

The latest user instruction for 38 superseded staff's earlier J$2,500 figure.
The three named outstanding accounts are active and each has a configured J$1,500
reconnection fee. This correction did not post that fee. Existing automation posts
it on an actual disconnection, keyed by the status-history record.

## Future payment-entry fix — deployment still required

`server/src/routes/paymentMonthCharge.ts` previously used the receipt's service
month directly as the billing month. Due days 1–15 must map it to the following
month. The lookup now uses that mapped anniversary for charge identity, historical
service, rates and whether a charge is due. This prevents the older-month charge
seen on 2525/9946 when their July/August payments were entered.

The existing unique monthly-charge source key prevents repeat generation for the
same due date. Expiration of grace does not create a second monthly charge. The
next month's normal charge is a distinct billing event.

Validation: 14 payment tests passed; server TypeScript check passed; actual lookup
SQL passed six read-only PostgreSQL checks, including accounts 2525/9946, day 15/16,
year rollover and leap/nonleap February. See `verify-payment-month-mapping.sql` and
`payment-month-mapping-verification.json`.

The source change is local and has not been deployed by this task. Deploy the
updated server code to activate the payment-entry fix. Do not rerun correction SQL
as part of deployment.

## Tiffany Brady

This batch excluded Tiffany (15092), as requested. A concurrent separate action
voided receipt 442398 (September, J$2,500) at 17:44:16 Jamaica time under employee 2,
reason “requested by head office.” That existing change was left in place.
Evidence: `tiffany-concurrent-void.json`.
