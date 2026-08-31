-- Names only: customers with no current OLT/ONT assignment.
SELECT
    c.customer_id,
    c.name
FROM public.customers c
WHERE NOT EXISTS (
    SELECT 1
    FROM public.customer_ont_assignments a
    WHERE a.customer_id = c.customer_id
      AND a.ended_at IS NULL
)
  -- AND c.status = 'active'          -- uncomment to limit to live accounts
  -- AND c.hidden_from_app = FALSE    -- uncomment to hide archived-from-app rows
ORDER BY c.name;
