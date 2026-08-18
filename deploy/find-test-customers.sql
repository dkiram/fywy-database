-- ============================================================================
-- STEP 1 of 2 — read-only. Find the customer_id values you want to delete.
--
-- Plain SQL, no psql-only syntax: paste it into a TablePlus SQL tab and hit
-- run, or pipe it through psql. Safe on production, works as spcl_readonly.
--
-- Run it on BOTH databases. The local Vite database and the NAS database are
-- two separate Postgres instances with separate data. The IDs will very likely
-- be different in each — note them separately.
-- ============================================================================

SELECT
    c.customer_id,
    c.name,
    c.status,
    c.created_at,
    -- The history counts are the tell. A customer you created by clicking
    -- through the app once has almost nothing attached. A real account that
    -- has been running has payments and a ledger. If a row below has real
    -- numbers, it is not your test record.
    (SELECT count(*) FROM public.payments               p WHERE p.customer_id = c.customer_id) AS payments,
    (SELECT count(*) FROM public.account_ledger_entries l WHERE l.customer_id = c.customer_id) AS ledger,
    (SELECT count(*) FROM public.service_tickets        t WHERE t.customer_id = c.customer_id) AS tickets,
    (SELECT count(*) FROM public.account_status_history h WHERE h.customer_id = c.customer_id) AS status_changes,
    (SELECT count(*) FROM public.customer_rate_history  r WHERE r.customer_id = c.customer_id) AS rate_changes,
    (SELECT count(*) FROM public.waiver_requests        w WHERE w.customer_id = c.customer_id) AS waivers,
    (SELECT count(*) FROM public.reconnection_requests  n WHERE n.customer_id = c.customer_id) AS reconnections,
    (SELECT count(*) FROM public.disconnection_holds    d WHERE d.customer_id = c.customer_id) AS holds,
    (SELECT count(*) FROM public.applications           a WHERE a.customer_id = c.customer_id
                                                            OR a.suggested_customer_id = c.customer_id) AS applications
FROM public.customers c
WHERE c.name ILIKE '%kimaree%'          -- <-- change the search text if needed
ORDER BY c.customer_id;
