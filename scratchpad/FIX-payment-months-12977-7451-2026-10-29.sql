-- Correct MONTH PAID FOR only. Date paid remains 2026-10-28.
-- Princess Edwards #12977: J$3,500, October -> November 2026.
-- Steve Smith-Bertram Lindsay #7451: J$2,500, October -> November 2026.
-- Steve: target receipt 458127 only; receipt 458126 stays October.
-- Run against the intended database with psql -v ON_ERROR_STOP=1 -f this-file.sql.
-- This script COMMITs. Both corrections succeed together or neither does.
-- No changes to amounts, payment dates, or ledger entries. Safe to rerun.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $fix$
DECLARE
    t RECORD;
    receipt public.payments%ROWTYPE;
    customer_name TEXT;
    matches INTEGER;
    balance_before NUMERIC;
    balance_after NUMERIC;
BEGIN
    FOR t IN
        SELECT 7451 AS customer_id,
               '%steve%smith%bertram%lindsay%'::TEXT AS name_pattern,
               2500.00::NUMERIC AS amount,
               458127::BIGINT AS target_payment_id
        UNION ALL
        SELECT 12977, '%princess%edwards%'::TEXT,
               3500.00::NUMERIC, NULL::BIGINT
    LOOP
        SELECT name INTO customer_name FROM public.customers
        WHERE customer_id = t.customer_id FOR UPDATE;
        IF customer_name IS NULL OR customer_name NOT ILIKE t.name_pattern THEN
            RAISE EXCEPTION 'Account % has unexpected name: %', t.customer_id, customer_name;
        END IF;

        -- Lock candidates before checking uniqueness, including already-fixed rows.
        PERFORM payment_id FROM public.payments
        WHERE customer_id = t.customer_id
          AND (t.target_payment_id IS NULL OR payment_id = t.target_payment_id)
          AND payment_date = DATE '2026-10-28'
          AND payment_type = 'Monthly Fee'
          AND amount_paid = t.amount
          AND location = 'Blenheim'
          AND cashier_name = 'Kimone Dunn'
          AND voided_at IS NULL
        FOR UPDATE;

        SELECT COUNT(*) INTO matches FROM public.payments
        WHERE customer_id = t.customer_id
          AND (t.target_payment_id IS NULL OR payment_id = t.target_payment_id)
          AND payment_date = DATE '2026-10-28'
          AND payment_type = 'Monthly Fee'
          AND amount_paid = t.amount
          AND location = 'Blenheim'
          AND cashier_name = 'Kimone Dunn'
          AND voided_at IS NULL;
        IF matches <> 1 THEN
            RAISE EXCEPTION 'Account %: expected exactly one matching receipt, found %', t.customer_id, matches;
        END IF;

        SELECT * INTO STRICT receipt FROM public.payments
        WHERE customer_id = t.customer_id
          AND (t.target_payment_id IS NULL OR payment_id = t.target_payment_id)
          AND payment_date = DATE '2026-10-28'
          AND payment_type = 'Monthly Fee'
          AND amount_paid = t.amount
          AND location = 'Blenheim'
          AND cashier_name = 'Kimone Dunn'
          AND voided_at IS NULL;

        IF receipt.month_paid = DATE '2026-11-01' THEN
            RAISE NOTICE 'Account %, receipt % already paid for November; unchanged', t.customer_id, receipt.payment_id;
            CONTINUE;
        END IF;
        IF DATE_TRUNC('month', receipt.month_paid) IS DISTINCT FROM TIMESTAMP '2026-10-01' THEN
            RAISE EXCEPTION 'Account %: expected October month paid for, found %', t.customer_id, receipt.month_paid;
        END IF;

        SELECT balance INTO STRICT balance_before
        FROM public.customer_billing_status WHERE customer_id = t.customer_id;

        UPDATE public.payments SET month_paid = DATE '2026-11-01'
        WHERE payment_id = receipt.payment_id;

        IF NOT EXISTS (
            SELECT 1 FROM public.payments p WHERE p.payment_id = receipt.payment_id
              AND p.month_paid = DATE '2026-11-01'
              AND (to_jsonb(p) - 'month_paid') = (to_jsonb(receipt) - 'month_paid')
        ) THEN
            RAISE EXCEPTION 'Receipt % verification failed; only month_paid may change', receipt.payment_id;
        END IF;

        SELECT balance INTO STRICT balance_after
        FROM public.customer_billing_status WHERE customer_id = t.customer_id;
        IF balance_after IS DISTINCT FROM balance_before THEN
            RAISE EXCEPTION 'Account % balance changed from % to %; rolling back', t.customer_id, balance_before, balance_after;
        END IF;

        INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, source_key
        ) VALUES (
            NULL, 'SQL correction (database user: ' || session_user || ')',
            'Corrected payment month paid for', 'payment', receipt.payment_id::TEXT,
            'month_paid', receipt.month_paid::TEXT, '2026-11-01',
            'User-requested correction 2026-10-29: October 28 receipt pays for November 2026. Date paid and amount unchanged.',
            'retag-month-20261029:' || receipt.payment_id::TEXT
        );
    END LOOP;
END $fix$;

SELECT p.customer_id, c.name, p.payment_id, p.payment_date AS date_paid,
       p.month_paid AS month_paid_for, p.amount_paid, p.location, p.cashier_name
FROM public.payments p JOIN public.customers c USING (customer_id)
WHERE p.customer_id IN (12977, 7451)
  AND p.payment_date = DATE '2026-10-28'
  AND p.payment_type = 'Monthly Fee' AND p.voided_at IS NULL
ORDER BY p.customer_id, p.payment_id;

COMMIT;
