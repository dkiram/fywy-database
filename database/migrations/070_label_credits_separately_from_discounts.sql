-- 070: tell credits apart from discounts in the record.
--
-- Both are stored as a negative 'waiver' ledger entry plus an approved
-- waiver_requests row, because both give money back and both must stay
-- reversible. But they mean different things to the business: a discount is
-- money forgiven off what a customer owed, a credit is money sitting on the
-- account in their favour. Reading a customer's history a year from now,
-- "discount, discount, discount" hides that difference entirely.
--
-- One boolean carries the distinction. No new table, no new entry_type, and
-- nothing about how balances are calculated changes.

ALTER TABLE public.waiver_requests
ADD COLUMN IF NOT EXISTS is_credit BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.waiver_requests.is_credit IS
  'TRUE when this was an Admin-applied account credit rather than a discount '
  'forgiving an existing balance. Both post the same negative waiver ledger '
  'entry; only the label and reporting differ.';

-- Backfill 1: everything created by the Add Credit route. That route writes
-- this exact review_note and nothing else does, so the match is unambiguous.
UPDATE public.waiver_requests
SET is_credit = TRUE
WHERE review_note = 'Credit applied directly by an administrator.';

-- Backfill 2: the bulk credits applied by hand on 2026-08-29 and after. They
-- went in through a waiver-shaped INSERT, but each carries a source_key that
-- no discount ever gets.
UPDATE public.waiver_requests w
SET is_credit = TRUE
FROM public.account_ledger_entries e
WHERE e.account_ledger_entry_id = w.waiver_ledger_entry_id
  AND e.source_key LIKE 'goodwill-waiver:%';

-- Make the ledger line read honestly too. The description is what shows in
-- Recent balance entries, and those hand-applied rows still say "waiver".
UPDATE public.account_ledger_entries e
SET description = 'Admin-applied account credit'
FROM public.waiver_requests w
WHERE w.waiver_ledger_entry_id = e.account_ledger_entry_id
  AND w.is_credit = TRUE
  AND e.description <> 'Admin-applied account credit';

-- What this migration deliberately does NOT do: guess. A credit handed out
-- through the ordinary Request Discount flow before the Add Credit button
-- existed is stored identically to a real discount, and only the person who
-- typed the reason knows which it was. Those stay FALSE. Flip them by hand:
--
--   SELECT waiver_request_id, customer_id, amount, reason, review_note,
--          reviewed_at, is_credit
--   FROM public.waiver_requests
--   WHERE status IN ('approved', 'reversed')
--     AND reviewed_at >= DATE '2026-08-29'
--   ORDER BY reviewed_at;
--
--   UPDATE public.waiver_requests SET is_credit = TRUE
--   WHERE waiver_request_id IN (...);
--
-- Then re-run the description UPDATE above to match.
