SELECT jsonb_agg(jsonb_build_object('case',cases.label,'expected',cases.expected,'actual',actual.due_date,'has_charge',actual.has_charge,'pass',actual.due_date=cases.expected AND (cases.expect_charge IS NULL OR actual.has_charge=cases.expect_charge))) AS payload FROM (VALUES (2525,DATE '2023-01-09','2026-08','2026-09-09',TRUE,'2525 August'),(9946,DATE '2023-01-06','2026-08','2026-09-06',TRUE,'9946 August'),(-999,DATE '2023-01-15','2026-12','2027-01-15',NULL,'day 15 year rollover'),(-999,DATE '2023-01-16','2026-08','2026-08-16',NULL,'day 16 same month'),(-999,DATE '2023-01-31','2028-02','2028-02-29',NULL,'leap February'),(-999,DATE '2023-01-31','2026-02','2026-02-28',NULL,'nonleap February')) cases(customer_id,activation_date,service_month,expected,expect_charge,label) CROSS JOIN LATERAL (WITH me AS (
      SELECT c.customer_id,
             c.activation_date,
             (cases.service_month || '-01')::DATE AS month_start,
             (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today
      FROM (SELECT cases.customer_id,cases.activation_date) c
    ),
    due AS (
      SELECT me.*,
             CASE WHEN me.activation_date IS NULL THEN NULL
                  ELSE public.spcl_anniversary_date(me.activation_date,
                    (me.month_start + CASE WHEN EXTRACT(DAY FROM me.activation_date)<=15
                      THEN INTERVAL '1 month' ELSE INTERVAL '0 months' END)::DATE)
             END AS due_date
      FROM me
    )
    SELECT
      d.month_start::TEXT AS month_start,
      d.due_date::TEXT AS due_date,
      d.due_date <= d.today AS is_past,
      EXISTS (
        SELECT 1 FROM public.account_ledger_entries ch
        WHERE ch.customer_id = d.customer_id
          AND ch.entry_type = 'monthly_charge'
          AND COALESCE(ch.due_date, ch.effective_date) = d.due_date
      ) AS has_charge,
      CASE WHEN d.due_date IS NULL THEN NULL
           ELSE public.spcl_customer_service_active_on(d.customer_id, d.due_date)
      END AS service_on,
      (
        SELECT h.to_status
        FROM public.account_status_history h
        WHERE h.customer_id = d.customer_id
          AND h.effective_date <= COALESCE(d.due_date, d.month_start)
        ORDER BY h.effective_date DESC, h.changed_at DESC, h.account_status_history_id DESC
        LIMIT 1
      ) AS status_then,
      rate.customer_rate_history_id,
      rate.monthly_fee::TEXT AS monthly_fee
    FROM due d
    LEFT JOIN LATERAL (
      SELECT r.customer_rate_history_id, r.monthly_fee
      FROM public.customer_rate_history r
      WHERE r.customer_id = d.customer_id
        AND r.effective_date <= COALESCE(d.due_date, d.month_start)
      ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
      LIMIT 1
    ) rate ON TRUE) actual;