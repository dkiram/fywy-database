-- READ ONLY. Finds the remaining duplicate customers from the Access import.
--
-- Matches on NAME rather than address: Shomorrey Smith's two rows had the same
-- address, but Doret Baker's read "Clones Dist., Harry Watch P.O., Manchester"
-- against "Clones District, Harry Watch P.O." - close enough for a human, not
-- close enough for SQL. Name is the reliable key; the address is shown so you
-- can eyeball it.
--
-- The payment counts are the important columns. In both merges so far the
-- DISCONNECTED record held nearly all the history and the ACTIVE one held
-- almost none, which is exactly backwards from what "delete the old one"
-- suggests. Check them before merging anything.

SELECT
    LOWER(TRIM(c.name))                                     AS matched_on,
    COUNT(*)                                                AS copies,

    -- The one to DELETE (disconnected) and the one to KEEP (active).
    (ARRAY_AGG(c.customer_id ORDER BY c.customer_id)
        FILTER (WHERE c.status <> 'active'))[1]             AS disconnected_id,
    (ARRAY_AGG(c.customer_id ORDER BY c.customer_id)
        FILTER (WHERE c.status = 'active'))[1]              AS active_id,

    -- How much history each side is holding.
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = (ARRAY_AGG(c.customer_id ORDER BY c.customer_id)
        FILTER (WHERE c.status <> 'active'))[1])            AS payments_on_disconnected,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = (ARRAY_AGG(c.customer_id ORDER BY c.customer_id)
        FILTER (WHERE c.status = 'active'))[1])             AS payments_on_active,

    ARRAY_AGG(c.customer_id ORDER BY c.customer_id)         AS all_ids,
    ARRAY_AGG(c.status      ORDER BY c.customer_id)         AS all_statuses,
    ARRAY_AGG(COALESCE(c.address, '-') ORDER BY c.customer_id) AS addresses,
    ARRAY_AGG(c.activation_date ORDER BY c.customer_id)     AS activation_dates
FROM public.customers c
WHERE c.hidden_from_app = FALSE
  AND COALESCE(TRIM(c.name), '') <> ''
GROUP BY LOWER(TRIM(c.name))
HAVING COUNT(*) > 1
   -- Exactly one live record and at least one retired one: the shape both
   -- confirmed duplicates had. Drop this line to see every repeated name,
   -- including genuine namesakes.
   AND COUNT(*) FILTER (WHERE c.status = 'active') = 1
   AND COUNT(*) FILTER (WHERE c.status <> 'active') >= 1
ORDER BY payments_on_disconnected DESC, matched_on;


-- A tighter list: same name AND same activation date. Two people sharing a
-- name is ordinary; two people sharing a name and the day they were activated
-- is the import having duplicated one row.
SELECT
    LOWER(TRIM(c.name))                             AS matched_on,
    c.activation_date,
    COUNT(*)                                        AS copies,
    ARRAY_AGG(c.customer_id ORDER BY c.customer_id) AS ids,
    ARRAY_AGG(c.status      ORDER BY c.customer_id) AS statuses
FROM public.customers c
WHERE c.hidden_from_app = FALSE
  AND c.activation_date IS NOT NULL
  AND COALESCE(TRIM(c.name), '') <> ''
GROUP BY LOWER(TRIM(c.name)), c.activation_date
HAVING COUNT(*) > 1
ORDER BY matched_on;


-- How big is this overall?
SELECT
    COUNT(*)                                   AS duplicated_names,
    SUM(copies)                                AS customer_rows_involved
FROM (
    SELECT COUNT(*) AS copies
    FROM public.customers
    WHERE hidden_from_app = FALSE
      AND COALESCE(TRIM(name), '') <> ''
    GROUP BY LOWER(TRIM(name)), activation_date
    HAVING COUNT(*) > 1
) grouped;
