-- =====================================================================
--  Wrongful reconnection-fee audit
--
--  The manual process being checked:
--    Go down the delinquent list. A customer who
--      (a) has PAID a monthly bill in the last ~5 months, and
--      (b) doesn't genuinely owe yet (nothing really past due), but
--      (c) is showing a reconnection fee + a monthly charge outstanding
--    was disconnected on a wrong balance. That reconnection fee (and the
--    monthly charge that rode in with it) is not correct, so it gets
--    cleared with an Admin credit.
--
--  Audit window for "was it done / done right":
--    2026-08-31 00:00  ->  2026-09-01 10:30   America/Jamaica  (UTC-05)
--
--  Run:  docker exec -i spcl-backup psql < discount_credit_audit.sql
--
--  Reconnection-fee ledger facts:
--    entry_type = 'reconnection_fee', positive amount, one per disconnection,
--    source_key 'reconnection-fee:status-history:<id>'. A payment against it is
--    entry_type 'reconnection_payment'. The ledger is FIFO, so "still owed" is
--    judged at the customer level: outstanding_balance vs the fee total.
-- =====================================================================


-- ---------------------------------------------------------------------
-- P1.  THE WORKLIST - delinquent customers who still match the pattern
--      and have NOT been cleared yet. This is who was likely missed.
--
--      months_paid_last5 : distinct months with a non-void Monthly Fee
--                          payment in the last 5 months  (the "still paying")
--      recon_fee_open    : reconnection fees charged minus reconnection
--                          payments made
--      non_recon_owed    : outstanding_balance minus recon_fee_open
--                          (roughly the monthly charges still outstanding)
--      last_disconnect   : most recent 'disconnected' transition + who did it
-- ---------------------------------------------------------------------
WITH led AS (
  SELECT
    customer_id,
    SUM(amount) FILTER (WHERE entry_type = 'reconnection_fee')          AS recon_fee_charged,
    SUM(-amount) FILTER (WHERE entry_type = 'reconnection_payment')     AS recon_fee_paid,
    SUM(-amount) FILTER (WHERE entry_type IN ('waiver','adjustment') AND amount < 0) AS credits_ever,
    COUNT(*) FILTER (WHERE entry_type = 'monthly_charge')               AS monthly_charges_total,
    COUNT(*) FILTER (WHERE entry_type = 'monthly_charge' AND is_verified = FALSE) AS monthly_charges_unverified,
    MAX(effective_date) FILTER (WHERE entry_type = 'reconnection_fee')  AS last_recon_fee_date
  FROM public.account_ledger_entries
  GROUP BY customer_id
),
pay5 AS (
  SELECT
    customer_id,
    COUNT(DISTINCT DATE_TRUNC('month', month_paid))                     AS months_paid_last5,
    MAX(payment_date)                                                   AS last_payment_date,
    (ARRAY_AGG(month_paid ORDER BY payment_date DESC))[1]               AS last_month_paid,
    (ARRAY_AGG(amount_paid ORDER BY payment_date DESC))[1]              AS last_payment_amount
  FROM public.payments
  WHERE payment_type = 'Monthly Fee'
    AND voided_at IS NULL
    AND payment_date >= (CURRENT_DATE - INTERVAL '5 months')
  GROUP BY customer_id
),
lastdc AS (
  SELECT DISTINCT ON (h.customer_id)
    h.customer_id,
    h.effective_date  AS disconnected_on,
    h.reason          AS disconnect_reason,
    CASE WHEN h.changed_by_employee_id IS NULL THEN 'automation / system'
         ELSE CONCAT_WS(' ', e.first_name, e.last_name) END AS disconnected_by
  FROM public.account_status_history h
  LEFT JOIN public.employees e ON e.employee_id = h.changed_by_employee_id
  WHERE h.to_status = 'disconnected'
  ORDER BY h.customer_id, h.effective_date DESC, h.changed_at DESC, h.account_status_history_id DESC
)
SELECT
  c.customer_id,
  c.name                                              AS customer,
  c.status                                            AS account_status,
  bs.outstanding_balance,
  COALESCE(led.recon_fee_charged,0) - COALESCE(led.recon_fee_paid,0)   AS recon_fee_open,
  bs.outstanding_balance
    - (COALESCE(led.recon_fee_charged,0) - COALESCE(led.recon_fee_paid,0)) AS non_recon_owed,
  c.monthly_fee,
  led.monthly_charges_unverified,
  COALESCE(p.months_paid_last5,0)                     AS months_paid_last5,
  p.last_payment_date,
  p.last_month_paid,
  p.last_payment_amount,
  d.disconnected_on,
  d.disconnected_by,
  d.disconnect_reason,
  COALESCE(led.credits_ever,0)                        AS credits_ever,
  bs.is_on_hold
FROM public.customers c
JOIN public.customer_billing_status bs ON bs.customer_id = c.customer_id
JOIN led            ON led.customer_id = c.customer_id
LEFT JOIN pay5 p    ON p.customer_id = c.customer_id
LEFT JOIN lastdc d  ON d.customer_id = c.customer_id
WHERE bs.is_delinquent
  AND c.hidden_from_app = FALSE
  AND COALESCE(led.recon_fee_charged,0) > COALESCE(led.recon_fee_paid,0)   -- an open reconnection fee
  AND COALESCE(p.months_paid_last5,0) >= 1                                 -- has been paying
  -- apart from the reconnection fee they owe at most ~2 months = "not really behind"
  -- (loosen or tighten the * 2 to match how far back you go)
  AND bs.outstanding_balance
      - (COALESCE(led.recon_fee_charged,0) - COALESCE(led.recon_fee_paid,0))
      <= COALESCE(c.monthly_fee,0) * 2
ORDER BY p.months_paid_last5 DESC, bs.outstanding_balance DESC;


-- ---------------------------------------------------------------------
-- P2.  DONE IN THE WINDOW - credits applied 31 Aug 00:00 - 1 Sep 10:30,
--      checked against the pattern. Look at match_check.
--        'ok'                    - had open recon fee + recent payment
--        'no reconnection fee'   - cleared something else
--        'no recent payment'     - not the "still paying" profile
--        'over-credited'         - credit exceeds fee + outstanding monthly
-- ---------------------------------------------------------------------
WITH w AS (
  SELECT TIMESTAMPTZ '2026-08-31 00:00:00-05' AS lo,
         TIMESTAMPTZ '2026-09-01 10:30:00-05' AS hi
),
credits AS (
  SELECT e.customer_id,
         SUM(-e.amount) AS credited_in_window,
         STRING_AGG(DISTINCT NULLIF(TRIM(e.reason), ''), ' | ') AS reasons,
         MIN(e.created_at) AS first_credit_at,
         CONCAT_WS(' ', MAX(emp.first_name), MAX(emp.last_name)) AS applied_by
  FROM public.account_ledger_entries e
  JOIN w ON e.created_at >= w.lo AND e.created_at < w.hi
  LEFT JOIN public.employees emp ON emp.employee_id = e.created_by_employee_id
  WHERE e.entry_type IN ('waiver','adjustment') AND e.amount < 0
  GROUP BY e.customer_id
)
SELECT
  cr.customer_id,
  c.name                                   AS customer,
  c.status                                 AS account_status,
  cr.credited_in_window,
  cr.applied_by,
  cr.reasons,
  COALESCE(rf.recon_open,0)                AS recon_fee_open,
  bs.outstanding_balance                   AS balance_now,
  COALESCE(pp.months_paid_last5,0)         AS months_paid_last5,
  pp.last_payment_date,
  CASE
    WHEN COALESCE(rf.recon_open,0) <= 0                        THEN 'no reconnection fee'
    WHEN COALESCE(pp.months_paid_last5,0) = 0                  THEN 'no recent payment'
    WHEN cr.credited_in_window > COALESCE(rf.recon_open,0)
         + COALESCE(c.monthly_fee,0) * 2 + 1                   THEN 'over-credited'
    ELSE 'ok'
  END                                      AS match_check
FROM credits cr
JOIN public.customers c ON c.customer_id = cr.customer_id
LEFT JOIN public.customer_billing_status bs ON bs.customer_id = cr.customer_id
LEFT JOIN LATERAL (
  SELECT SUM(amount) FILTER (WHERE entry_type='reconnection_fee')
       + SUM(amount) FILTER (WHERE entry_type='reconnection_payment') AS recon_open
  FROM public.account_ledger_entries WHERE customer_id = cr.customer_id
) rf ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(DISTINCT DATE_TRUNC('month', month_paid)) AS months_paid_last5,
         MAX(payment_date) AS last_payment_date
  FROM public.payments
  WHERE customer_id = cr.customer_id AND payment_type='Monthly Fee'
    AND voided_at IS NULL AND payment_date >= (CURRENT_DATE - INTERVAL '5 months')
) pp ON TRUE
ORDER BY match_check, cr.customer_id;


-- ---------------------------------------------------------------------
-- P3.  Pending discount requests in the window - promised, not yet credited.
--      (These exist only where the customer still had a positive balance
--       when the request was filed.)
-- ---------------------------------------------------------------------
WITH w AS (
  SELECT TIMESTAMPTZ '2026-08-31 00:00:00-05' AS lo,
         TIMESTAMPTZ '2026-09-01 10:30:00-05' AS hi
)
SELECT
  r.waiver_request_id,
  r.customer_id,
  c.name                                        AS customer,
  r.amount,
  r.status,
  r.reason,
  r.requested_at AT TIME ZONE 'America/Jamaica'  AS requested_local,
  CONCAT_WS(' ', rq.first_name, rq.last_name)    AS requested_by,
  bs.outstanding_balance                         AS balance_now
FROM public.waiver_requests r
JOIN w ON (r.requested_at >= w.lo AND r.requested_at < w.hi)
       OR (r.reviewed_at  >= w.lo AND r.reviewed_at  < w.hi)
JOIN public.customers c       ON c.customer_id = r.customer_id
LEFT JOIN public.employees rq ON rq.employee_id = r.requested_by_employee_id
LEFT JOIN public.customer_billing_status bs ON bs.customer_id = r.customer_id
WHERE r.status = 'pending'
ORDER BY r.requested_at;


-- ---------------------------------------------------------------------
-- P4.  Context - every credit / waiver / adjustment applied in the window,
--      raw, with who and why. Cross-check anything odd from P2 here.
-- ---------------------------------------------------------------------
WITH w AS (
  SELECT TIMESTAMPTZ '2026-08-31 00:00:00-05' AS lo,
         TIMESTAMPTZ '2026-09-01 10:30:00-05' AS hi
)
SELECT
  e.account_ledger_entry_id                       AS ledger_id,
  e.customer_id,
  c.name                                          AS customer,
  e.entry_type,
  e.amount,
  e.effective_date,
  e.created_at AT TIME ZONE 'America/Jamaica'      AS created_local,
  CONCAT_WS(' ', emp.first_name, emp.last_name)    AS applied_by,
  e.reason,
  e.description,
  (SELECT COALESCE(SUM(e2.amount),0) FROM public.account_ledger_entries e2
    WHERE e2.customer_id = e.customer_id AND e2.created_at < e.created_at) AS balance_before,
  bs.outstanding_balance                          AS balance_now
FROM public.account_ledger_entries e
JOIN w ON e.created_at >= w.lo AND e.created_at < w.hi
JOIN public.customers c        ON c.customer_id = e.customer_id
LEFT JOIN public.employees emp  ON emp.employee_id = e.created_by_employee_id
LEFT JOIN public.customer_billing_status bs ON bs.customer_id = e.customer_id
WHERE e.entry_type IN ('waiver','adjustment')
ORDER BY e.created_at;
