-- Run the whole file. COMMIT applies all six account corrections together.
-- November -> October changes MONTH PAID FOR only, never the date paid.
-- Denesha's two split receipts (2200 + 300) both move to October.
-- Balance guards use the user-supplied snapshot; stale balances abort the batch.
-- Unique audit/ledger keys prevent this batch being applied twice.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE fix1105_accounts (
    customer_id INTEGER PRIMARY KEY, expected_name TEXT,
    expected_balance NUMERIC, target_balance NUMERIC
) ON COMMIT DROP;
INSERT INTO fix1105_accounts VALUES
    (1217, 'Roy Griffiths', 0, 0),
    (2867, 'Denesha Whyte', 0, 0),
    (10349, 'Presley Rismond', 0, 0),
    (13861, 'Merva-Lee Wynter', 2000, 5000),
    (14042, 'Camoy R Stewart', 0, 5000),
    (14221, 'Kerry-Ann Watson #2', 0, -2000);

CREATE TEMP TABLE fix1105_payments (
    payment_id BIGINT PRIMARY KEY, customer_id INTEGER, amount NUMERIC
) ON COMMIT DROP;
INSERT INTO fix1105_payments VALUES
    (460328, 1217, 2500),
    (460391, 2867, 2200),
    (460394, 2867, 300),
    (460376, 10349, 3500);

DO $correction$
DECLARE
    a RECORD;
    t RECORD;
    p public.payments%ROWTYPE;
    actual_name TEXT;
    before_balance NUMERIC;
    after_balance NUMERIC;
    correction_key TEXT;
    actor TEXT := 'SQL correction (database user: ' || session_user || ')';
BEGIN
    -- Lock all six accounts in a consistent order before changing anything.
    FOR a IN SELECT * FROM fix1105_accounts ORDER BY customer_id LOOP
        SELECT name INTO STRICT actual_name FROM public.customers
        WHERE customer_id = a.customer_id FOR UPDATE;
        IF LOWER(TRIM(actual_name)) <> LOWER(TRIM(a.expected_name)) THEN
            RAISE EXCEPTION 'Account % name mismatch: %', a.customer_id, actual_name;
        END IF;
    END LOOP;

    FOR t IN SELECT * FROM fix1105_payments ORDER BY payment_id LOOP
        SELECT * INTO STRICT p FROM public.payments
        WHERE payment_id = t.payment_id FOR UPDATE;
        IF p.customer_id IS DISTINCT FROM t.customer_id
           OR p.amount_paid IS DISTINCT FROM t.amount
           OR p.payment_type IS DISTINCT FROM 'Monthly Fee'
           OR p.payment_date IS DISTINCT FROM DATE '2026-11-04'
           OR p.voided_at IS NOT NULL THEN
            RAISE EXCEPTION 'Receipt % does not match the supplied details', t.payment_id;
        END IF;

        correction_key := 'account-fix-20261105:payment:' || p.payment_id;
        IF EXISTS (SELECT 1 FROM public.audit_logs WHERE source_key = correction_key) THEN
            IF p.month_paid IS DISTINCT FROM DATE '2026-10-01' THEN
                RAISE EXCEPTION 'Previously corrected receipt % has changed; review required', p.payment_id;
            END IF;
            CONTINUE;
        END IF;
        IF p.month_paid IS DISTINCT FROM DATE '2026-11-01' THEN
            RAISE EXCEPTION 'Receipt % expected November 2026, found %', p.payment_id, p.month_paid;
        END IF;

        SELECT balance INTO STRICT before_balance FROM public.customer_billing_status
        WHERE customer_id = t.customer_id;
        UPDATE public.payments SET month_paid = DATE '2026-10-01'
        WHERE payment_id = t.payment_id;
        IF NOT EXISTS (
            SELECT 1 FROM public.payments updated
            WHERE updated.payment_id = t.payment_id
              AND updated.month_paid = DATE '2026-10-01'
              AND (to_jsonb(updated) - 'month_paid') = (to_jsonb(p) - 'month_paid')
        ) THEN
            RAISE EXCEPTION 'Receipt % verification failed: only month_paid may change', t.payment_id;
        END IF;
        SELECT balance INTO STRICT after_balance FROM public.customer_billing_status
        WHERE customer_id = t.customer_id;
        IF after_balance IS DISTINCT FROM before_balance THEN
            RAISE EXCEPTION 'Month correction unexpectedly changed account % balance', t.customer_id;
        END IF;
        INSERT INTO public.audit_logs (
            actor_name, action, entity_type, entity_id, field_name,
            old_value, new_value, reason, source_key
        ) VALUES (
            actor, 'Corrected payment month paid for', 'payment', p.payment_id::TEXT,
            'month_paid', p.month_paid::TEXT, '2026-10-01',
            'User instruction 2026-11-05: November payment was for October. Date paid and amount unchanged.',
            correction_key
        );
    END LOOP;

    FOR a IN SELECT * FROM fix1105_accounts
             WHERE expected_balance <> target_balance ORDER BY customer_id LOOP
        correction_key := 'account-fix-20261105:balance:' || a.customer_id;
        IF EXISTS (SELECT 1 FROM public.account_ledger_entries WHERE source_key = correction_key) THEN
            RAISE NOTICE 'Account % balance correction already applied; skipping', a.customer_id;
            CONTINUE;
        END IF;
        SELECT balance INTO STRICT before_balance FROM public.customer_billing_status
        WHERE customer_id = a.customer_id;
        IF before_balance IS DISTINCT FROM a.expected_balance THEN
            RAISE EXCEPTION 'Account % balance changed: expected %, found %. Refresh before applying.',
                a.customer_id, a.expected_balance, before_balance;
        END IF;
        INSERT INTO public.account_ledger_entries (
            customer_id, entry_type, amount, effective_date, description,
            reason, is_verified, source_key
        ) VALUES (
            a.customer_id, 'adjustment', a.target_balance - before_balance,
            DATE '2026-11-05', 'User-requested account correction 2026-11-05',
            CASE a.customer_id
                WHEN 14042 THEN 'Add J$5,000 to outstanding balance.'
                WHEN 13861 THEN 'Set outstanding balance to J$5,000.'
                WHEN 14221 THEN 'Set account credit to J$2,000.'
            END, TRUE, correction_key
        );
        SELECT balance INTO STRICT after_balance FROM public.customer_billing_status
        WHERE customer_id = a.customer_id;
        IF after_balance IS DISTINCT FROM a.target_balance THEN
            RAISE EXCEPTION 'Account % expected final balance %, found %',
                a.customer_id, a.target_balance, after_balance;
        END IF;
        INSERT INTO public.audit_logs (
            actor_name, action, entity_type, entity_id, field_name,
            old_value, new_value, reason, source_key
        ) VALUES (
            actor, 'Adjusted account balance', 'customer', a.customer_id::TEXT,
            'balance', before_balance::TEXT, after_balance::TEXT,
            'User-requested correction 2026-11-05. Positive balance is debt; negative balance is credit.',
            correction_key
        );
    END LOOP;
END $correction$;

SELECT c.customer_id, c.name, b.balance, b.outstanding_balance, b.credit_balance
FROM fix1105_accounts a JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
ORDER BY c.customer_id;

SELECT p.payment_id, p.customer_id, p.payment_date AS date_paid,
       p.month_paid AS month_paid_for, p.amount_paid
FROM fix1105_payments t JOIN public.payments p USING (payment_id)
ORDER BY p.customer_id, p.payment_id;
COMMIT;
