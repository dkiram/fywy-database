# Email receipts

SPCL records a payment before contacting Gmail. If Gmail rejects or cannot
deliver the request, the payment remains valid and the receipt screen exposes
retry and physical-print fallback controls. A successful email receipt has no
print action, which prevents routine paper use.

## Google Workspace prerequisites

1. `spc@fywycable.com` is the licensed mailbox.
2. `receipts@fywycable.com` is an alias on that user, not another paid user.
3. In Gmail for `spc@fywycable.com`, the alias is configured under
   **Settings > Accounts > Send mail as**.
4. The `SPCL Customer Notifications` Google Cloud project belongs to the
   `fywycable.com` organization.
5. Gmail API is enabled.
6. Google Auth Platform audience is **Internal**.
7. The project has only the `https://www.googleapis.com/auth/gmail.send` Gmail
   scope.
8. The OAuth client named `SPCL Mailer` has application type **Desktop app**.

## Authorize the mailbox once

Download the OAuth client JSON from Google Cloud. Keep it outside the Git
repository, then run locally:

```sh
cd server
npm run authorize:gmail -- /absolute/path/to/downloaded-client.json
```

The browser opens. Sign in as `spc@fywycable.com` and approve send-only Gmail
access. The script writes `server/.env.gmail` with mode `0600`. Its contents
include the OAuth client ID, client secret and durable refresh token; the file
is ignored by Git and must never be pasted into chat or committed.

Copy those five `GMAIL_*` lines into the NAS repository's `.env.production`
file. Delete the downloaded client JSON from Downloads after the production
configuration has been backed up in SPCL's protected credential store.

Deploy normally. Docker Compose passes the protected values to the API
container without putting them into the image.

## Counter workflow

The cashier must choose a receipt method for every new customer payment.

- **Email receipt:** the account email is offered first. A different address
  applies to that send only and does not change the customer profile.
- **Physical receipt:** the existing slip/A4 controls remain available.
- **Email succeeded:** the receipt window confirms the masked destination and
  does not display print controls.
- **Email failed:** the payment remains recorded. Staff can correct the email
  and retry; paper printing appears only as the fallback while the customer is
  still present.

Every request creates a row in `receipt_email_deliveries`. Retrying creates a
new row instead of overwriting prior evidence, so the destination, employee,
time, result and provider message ID remain auditable.

## Acceptance test

After migration `046_add_receipt_email_delivery.sql` is applied:

1. Email a receipt to a Gmail address and confirm no print button appears.
2. Email one to a non-Gmail address.
3. Use a one-time alternate address and confirm the customer profile is
   unchanged.
4. Submit an invalid address and confirm the payment form refuses it.
5. Temporarily use an invalid Gmail token, confirm the payment still records,
   then verify retry and failure-only printing.
6. Open a successfully emailed receipt from Payment History and use
   **Send Again**.
7. Confirm any customer reply arrives in the `spc@fywycable.com` mailbox even
   though the message is labelled as automated/do-not-reply.
