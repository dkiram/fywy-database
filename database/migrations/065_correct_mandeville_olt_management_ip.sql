-- PuTTY confirmed that Mandeville's working MA5680T CLI address is
-- 192.168.1.4. The 192.168.1.211 value came from U2000 and is not accepting
-- the direct SSH connection required by the SPCL backend.
DO $$
DECLARE
    mandeville_id BIGINT;
    mandeville_row_count INTEGER;
    conflicting_olt TEXT;
    current_ip TEXT;
BEGIN
    SELECT COUNT(*)::INTEGER
      INTO mandeville_row_count
      FROM public.olts
     WHERE normalized_name IN ('MANDEVILLE', 'MADEVILLE');

    IF mandeville_row_count > 1 THEN
        RAISE EXCEPTION
            'Cannot correct Mandeville OLT: both Mandeville and Madeville inventory rows exist';
    END IF;

    SELECT olt_id, host(management_ip)
      INTO mandeville_id, current_ip
      FROM public.olts
     WHERE normalized_name IN ('MANDEVILLE', 'MADEVILLE');

    SELECT name
      INTO conflicting_olt
      FROM public.olts
     WHERE management_ip = '192.168.1.4'::INET
       AND (mandeville_id IS NULL OR olt_id <> mandeville_id);

    IF conflicting_olt IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot assign 192.168.1.4 to Mandeville: it already belongs to OLT %',
            conflicting_olt;
    END IF;

    -- The clarified records had not yet been attached in SPCL, so some live
    -- databases contain only Newport in OLT inventory. In that case create the
    -- shared Mandeville device now; assignment creation remains a separate,
    -- read-only-live-verified batch operation.
    IF mandeville_id IS NULL THEN
        INSERT INTO public.olts (name, management_ip)
        VALUES ('Mandeville', '192.168.1.4'::INET)
        RETURNING olt_id, host(management_ip)
             INTO mandeville_id, current_ip;
    END IF;

    IF current_ip NOT IN ('192.168.1.211', '192.168.1.4') THEN
        RAISE EXCEPTION
            'Refusing unexpected Mandeville OLT IP change: current value is %',
            current_ip;
    END IF;

    UPDATE public.olts
       SET name = 'Mandeville',
           management_ip = '192.168.1.4'::INET,
           updated_at = CURRENT_TIMESTAMP
     WHERE olt_id = mandeville_id
       AND (
           normalized_name <> 'MANDEVILLE'
           OR management_ip <> '192.168.1.4'::INET
       );
END
$$;
