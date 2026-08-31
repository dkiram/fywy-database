-- Customers with NO OLT / ONT info: no current (active) row in
-- customer_ont_assignments. Every column in that table is NOT NULL, so
-- "OLT info is null" means the assignment row itself does not exist.
--
-- Swap the final SELECT for the commented COUNT block if you only want totals.

SELECT
    c.customer_id,
    c.name,
    c.status,
    c.telephone,
    c.address,
    c.activation_date,
    c.deactivation_date,
    (c.source_staging_id IS NOT NULL)          AS legacy_account,
    b.outstanding_balance,
    b.is_delinquent,
    b.unverified_entries > 0                   AS has_unverified_charges,
    b.grace_end_date,
    b.is_on_hold
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE NOT EXISTS (
    SELECT 1
    FROM public.customer_ont_assignments a
    WHERE a.customer_id = c.customer_id
      AND a.ended_at IS NULL
)
  -- AND c.status = 'active'          -- uncomment to limit to live accounts
  -- AND c.hidden_from_app = FALSE    -- uncomment to hide archived-from-app rows
ORDER BY
    c.status,
    b.grace_end_date NULLS LAST,
    c.customer_id;


-- ---------------------------------------------------------------------------
-- Totals only:
--
-- SELECT
--     c.status,
--     COUNT(*)                                              AS customers_without_olt,
--     COUNT(*) FILTER (WHERE b.is_delinquent)               AS delinquent,
--     COUNT(*) FILTER (WHERE b.unverified_entries > 0)      AS with_unverified_charges,
--     COUNT(*) FILTER (WHERE b.grace_end_date < CURRENT_DATE) AS past_grace
-- FROM public.customers c
-- LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
-- WHERE NOT EXISTS (
--     SELECT 1 FROM public.customer_ont_assignments a
--     WHERE a.customer_id = c.customer_id AND a.ended_at IS NULL
-- )
-- GROUP BY c.status
-- ORDER BY c.status;
