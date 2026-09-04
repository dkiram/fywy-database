-- =====================================================================
--  Peter Dunn - discount-approval session of 31 Aug / 1 Sep 2026
--  Window: 2026-08-31 00:00  ->  2026-09-01 10:30  America/Jamaica (UTC-05)
--  Read-only. Run:
--    docker exec -i spcl-postgres psql -U spcl_readonly -d spcl_db < discount_credit_audit.sql
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0.  Confirm which employee row this resolves to. If it returns nothing or
--     the wrong person, adjust the name test in the me CTEs below.
-- ---------------------------------------------------------------------
SELECT employee_id, first_name, last_name, username, role
FROM public.employees
WHERE lower(first_name) = 'peter' AND lower(last_name) = 'dunn';


-- ---------------------------------------------------------------------
-- A.  What Peter actually did in the window
--     (approved / rejected discount requests he reviewed, and direct credits)
-- ---------------------------------------------------------------------
WITH me AS (
  SELECT employee_id, CONCAT_WS(' ', first_name, last_name) AS name
  FROM public.employees
  WHERE lower(first_name) = 'peter' AND lower(last_name) = 'dunn'
),
w AS (
  SELECT TIMESTAMPTZ '2026-08-31 00:00:00-05' AS lo,
         TIMESTAMPTZ '2026-09-01 10:30:00-05' AS hi
)
SELECT
  'discount request' AS kind,
  r.status,
  r.customer_id,
  c.name                                         AS customer,
  r.amount,
  r.reason,
  r.review_note,
  r.reviewed_at AT TIME ZONE 'America/Jamaica'    AS actioned_local,
  bs.outstanding_balance                          AS balance_now,
  bs.credit_balance                              AS credit_now
FROM public.waiver_requests r
JOIN me ON r.reviewed_by_employee_id = me.employee_id
JOIN w  ON r.reviewed_at >= w.lo AND r.reviewed_at < w.hi
JOIN public.customers c ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status bs ON bs.customer_id = r.customer_id

UNION ALL

SELECT
  'direct credit' AS kind,
  'applied'        AS status,
  e.customer_id,
  c.name           AS customer,
  -e.amount        AS amount,
  e.reason,
  e.description    AS review_note,
  e.created_at AT TIME ZONE 'America/Jamaica'     AS actioned_local,
  bs.outstanding_balance,
  bs.credit_balance
FROM public.account_ledger_entries e
JOIN me ON e.created_by_employee_id = me.employee_id
JOIN w  ON e.created_at >= w.lo AND e.created_at < w.hi
JOIN public.customers c ON c.customer_id = e.customer_id
LEFT JOIN public.customer_billing_status bs ON bs.customer_id = e.customer_id
WHERE e.entry_type IN ('waiver','adjustment') AND e.amount < 0
ORDER BY actioned_local;


-- ---------------------------------------------------------------------
-- B.  MISSED - discount requests that were sitting in the queue during his
--     session and that he did NOT turn into a credit:
--       still 'pending' now, or he 'rejected' them in the window.
-- ---------------------------------------------------------------------
WITH me AS (
  SELECT employee_id FROM public.employees
  WHERE lower(first_name)='peter' AND lower(last_name)='dunn'
),
w AS (
  SELECT TIMESTAMPTZ '2026-08-31 00:00:00-05' AS lo,
         TIMESTAMPTZ '2026-09-01 10:30:00-05' AS hi
)
SELECT
  r.waiver_request_id,
  r.status,
  r.customer_id,
  c.name                                          AS customer,
  c.status                                        AS account_status,
  r.amount                                        AS requested_amount,
  r.reason,
  r.review_note,
  r.requested_at AT TIME ZONE 'America/Jamaica'    AS requested_local,
  CONCAT_WS(' ', rq.first_name, rq.last_name)      AS requested_by,
  r.reviewed_at  AT TIME ZONE 'America/Jamaica'    AS rejected_local,
  bs.outstanding_balance                          AS balance_now,
  bs.credit_balance                               AS credit_now
FROM public.waiver_requests r
JOIN w ON r.requested_at < w.hi
JOIN public.customers c ON c.customer_id = r.customer_id
LEFT JOIN public.employees rq ON rq.employee_id = r.requested_by_employee_id
LEFT JOIN public.customer_billing_status bs ON bs.customer_id = r.customer_id
WHERE r.status = 'pending'
   OR (r.status = 'rejected'
       AND r.reviewed_by_employee_id IN (SELECT employee_id FROM me)
       AND r.reviewed_at >= w.lo AND r.reviewed_at < w.hi)
ORDER BY r.status, r.requested_at;


-- ---------------------------------------------------------------------
-- C.  MISSED (no request could exist) - customers who PAID during or just
--     before the window so their balance cleared, and are still carrying a
--     reconnection fee + monthly charge that should have been credited.
--       Peter can't have a rejected/pending request for these because the
--       request screen refuses to open at balance <= 0.
-- ---------------------------------------------------------------------
WITH w AS (
  SELECT TIMESTAMPTZ '2026-08-31 00:00:00-05' AS lo,
         TIMESTAMPTZ '2026-09-01 10:30:00-05' AS hi
),
led AS (
  SELECT customer_id,
    SUM(amount)  FILTER (WHERE entry_type='reconnection_fee')     AS recon_charged,
    SUM(-amount) FILTER (WHERE entry_type='reconnection_payment') AS recon_paid,
    SUM(-amount) FILTER (WHERE entry_type IN ('waiver','adjustment') AND amount<0) AS credits_ever
  FROM public.account_ledger_entries GROUP BY customer_id
),
pay AS (
  SELECT customer_id,
    COUNT(DISTINCT DATE_TRUNC('month', month_paid)) FILTER (
      WHERE payment_date >= CURRENT_DATE - INTERVAL '5 months')  AS months_paid_last5,
    MAX(payment_date)                                             AS last_payment_date,
    (ARRAY_AGG(month_paid  ORDER BY payment_date DESC))[1]        AS last_month_paid,
    bool_or(recorded_at >= (SELECT lo FROM w)
        AND recorded_at < (SELECT hi FROM w))                     AS paid_in_window
  FROM public.payments
  WHERE payment_type='Monthly Fee' AND voided_at IS NULL
  GROUP BY customer_id
)
SELECT
  c.customer_id,
  c.name                                          AS customer,
  c.status                                        AS account_status,
  bs.outstanding_balance,
  COALESCE(led.recon_charged,0)-COALESCE(led.recon_paid,0)  AS recon_fee_open,
  bs.outstanding_balance
    - (COALESCE(led.recon_charged,0)-COALESCE(led.recon_paid,0)) AS non_recon_owed,
  c.monthly_fee,
  COALESCE(pay.months_paid_last5,0)               AS months_paid_last5,
  pay.last_payment_date,
  pay.last_month_paid,
  pay.paid_in_window,
  COALESCE(led.credits_ever,0)                    AS credits_ever
FROM public.customers c
JOIN public.customer_billing_status bs ON bs.customer_id = c.customer_id
JOIN led ON led.customer_id = c.customer_id
LEFT JOIN pay ON pay.customer_id = c.customer_id
WHERE c.hidden_from_app = FALSE
  AND COALESCE(led.recon_charged,0) > COALESCE(led.recon_paid,0)   -- open reconnection fee
  AND COALESCE(pay.months_paid_last5,0) >= 1                       -- has been paying
  AND bs.outstanding_balance
      - (COALESCE(led.recon_charged,0)-COALESCE(led.recon_paid,0))
      <= COALESCE(c.monthly_fee,0) * 2                             -- not really behind
  AND COALESCE(led.credits_ever,0) = 0                             -- never credited
ORDER BY pay.paid_in_window DESC NULLS LAST, pay.last_payment_date DESC;
