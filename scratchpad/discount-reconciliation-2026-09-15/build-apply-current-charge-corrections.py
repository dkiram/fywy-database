"""Generate an atomic correction limited to the explicitly approved export."""
import csv
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
export = Path('/Users/kimmy/.codex/attachments/9dfe2308-2061-4112-a67e-9c703c467889/pasted-text.txt')
saved = {r['customer_id']: r for r in json.loads((ROOT/'current-charge-review.json').read_text())}
rows = [r for r in csv.reader(export.open(), delimiter='\t') if r[2]=='proposed_restore']
assert len(rows)==933 and sum(Decimal(r[10]) for r in rows)==Decimal('2723330')
values = []
for r in rows:
    e = saved[int(r[0])]
    assert e['decision']=='proposed_restore' and Decimal(str(e['proposed_adjustment']))==Decimal(r[10])
    values.append(f"({int(r[0])},{e['charge_id']},{e['waiver_id']},{int(r[15])},{r[10]},DATE '{r[3]}',DATE '{r[4]}')")
cte = (ROOT/'preview-current-charge-corrections.sql').read_text().split('SELECT customer_id,name,decision,due_date')[0]
body = '''SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
LOCK TABLE public.customers,public.payments,public.account_ledger_entries,
 public.waiver_requests,public.customer_billing_start,public.customer_rate_history,
 public.audit_logs,public.account_status_history,public.disconnection_holds IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE approved_current_corrections(
 customer_id INTEGER PRIMARY KEY,charge_id BIGINT,waiver_id BIGINT,waiver_request_id BIGINT,
 amount NUMERIC(14,2),due_date DATE,grace_end_date DATE) ON COMMIT DROP;
INSERT INTO approved_current_corrections VALUES
''' + ',\n'.join(values) + ';\n'
body += 'CREATE TEMP TABLE current_correction_plan ON COMMIT DROP AS\n'+cte+"SELECT * FROM preview WHERE decision='proposed_restore';\n"
body += '''DO $guard$
BEGIN
 IF (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE<>DATE '2026-09-15' THEN
   RAISE EXCEPTION 'Wrong date. Refresh the approved review.'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employees WHERE employee_id=2) THEN
   RAISE EXCEPTION 'Employee 2 not found'; END IF;
 IF EXISTS(SELECT 1 FROM public.audit_logs WHERE source_key LIKE 'current-charge-correction-20260915:%')
 OR EXISTS(SELECT 1 FROM public.account_ledger_entries WHERE source_key LIKE 'current-charge-correction-20260915:%') THEN
   RAISE EXCEPTION 'Correction batch already applied. Do not repeat.'; END IF;
 IF EXISTS(SELECT 1 FROM approved_current_corrections a FULL JOIN current_correction_plan p USING(customer_id)
   WHERE a.customer_id IS NULL OR p.customer_id IS NULL OR a.amount IS DISTINCT FROM p.proposed_adjustment
     OR a.charge_id IS DISTINCT FROM p.charge_id OR a.waiver_id IS DISTINCT FROM p.waiver_id
     OR a.waiver_request_id IS DISTINCT FROM p.waiver_request_id
     OR a.due_date IS DISTINCT FROM p.due_date OR a.grace_end_date IS DISTINCT FROM p.grace_end_date) THEN
   RAISE EXCEPTION 'Live proposal differs from approved 933 accounts. Refresh the review.'; END IF;
 IF (SELECT count(*) FROM current_correction_plan)<>933
 OR (SELECT sum(proposed_adjustment) FROM current_correction_plan)<>2723330
 OR (SELECT count(*) FROM current_correction_plan WHERE waiver_amount>proposed_adjustment)<>76
 OR (SELECT sum(waiver_amount-proposed_adjustment) FROM current_correction_plan)<>271750 THEN
   RAISE EXCEPTION 'Correction totals differ from approval'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p JOIN public.waiver_requests w USING(waiver_request_id)
   WHERE w.status<>'approved' OR w.amount<>p.waiver_amount OR w.customer_id<>p.customer_id
     OR w.waiver_ledger_entry_id<>p.waiver_id OR w.reversal_ledger_entry_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Original waiver changed'; END IF;
END $guard$;
-- Reverse each original waiver using the application's standard unique key.
-- For partial reversals, replace only the retained credit/relief in the same transaction.
INSERT INTO public.account_ledger_entries(customer_id,entry_type,amount,effective_date,
 description,created_by_employee_id,reason,is_verified,source_key)
SELECT customer_id,'adjustment',waiver_amount,DATE '2026-09-15',
 'Correction of September 15 reconciliation waiver',2,
 'Restore only the approved unpaid current charge; any remaining original relief is reissued in this transaction.',TRUE,
 'waiver-reversal:request:'||waiver_request_id::TEXT FROM current_correction_plan;
INSERT INTO public.account_ledger_entries(customer_id,entry_type,amount,effective_date,
 description,created_by_employee_id,reason,is_verified,source_key)
SELECT customer_id,'waiver',-(waiver_amount-proposed_adjustment),DATE '2026-09-15',
 'Retained relief and credit after current-charge correction',2,
 'Retain the unaffected portion of the original reconciliation credit; current bill alone is restored.',TRUE,
 'current-charge-correction-20260915:retained:'||customer_id::TEXT
FROM current_correction_plan WHERE waiver_amount>proposed_adjustment;
INSERT INTO public.waiver_requests(customer_id,amount,reason,status,requested_by_employee_id,
 reviewed_by_employee_id,reviewed_at,review_note,waiver_ledger_entry_id,is_credit)
SELECT p.customer_id,p.waiver_amount-p.proposed_adjustment,
 'Retained portion of September 15 reconciliation after correction of the unpaid current charge.',
 'approved',2,2,CURRENT_TIMESTAMP,'Replaces retained portion of waiver request '||p.waiver_request_id::TEXT,
 l.account_ledger_entry_id,w.is_credit
FROM current_correction_plan p JOIN public.waiver_requests w USING(waiver_request_id)
JOIN public.account_ledger_entries l
 ON l.source_key='current-charge-correction-20260915:retained:'||p.customer_id::TEXT
WHERE p.waiver_amount>p.proposed_adjustment;
UPDATE public.waiver_requests w SET status='reversed',reversed_by_employee_id=2,
 reversed_at=CURRENT_TIMESTAMP,
 reversal_note='Current-charge correction: restored J$'||p.proposed_adjustment::TEXT||
   '; retained J$'||(p.waiver_amount-p.proposed_adjustment)::TEXT||' as a separately recorded replacement credit/waiver.',
 reversal_ledger_entry_id=l.account_ledger_entry_id
FROM current_correction_plan p,public.account_ledger_entries l
WHERE w.waiver_request_id=p.waiver_request_id
 AND l.source_key='waiver-reversal:request:'||p.waiver_request_id::TEXT;
INSERT INTO public.audit_logs(employee_id,actor_name,action,entity_type,entity_id,
 field_name,old_value,new_value,reason,source_key)
SELECT 2,CONCAT_WS(' ',e.first_name,e.last_name),'Corrected current charge cleared by reconciliation',
 'customer',p.customer_id::TEXT,'balance',p.current_balance::TEXT,
 (p.current_balance+p.proposed_adjustment)::TEXT,
 'Restored J$'||p.proposed_adjustment::TEXT||' for charge '||p.charge_id::TEXT||
 '; original due '||p.due_date::TEXT||', grace through '||p.grace_end_date::TEXT||
 '. Later payments and retained relief preserved; original waiver request '||p.waiver_request_id::TEXT||' reversed.',
 'current-charge-correction-20260915:'||p.customer_id::TEXT
FROM current_correction_plan p CROSS JOIN public.employees e WHERE e.employee_id=2;
CREATE TEMP TABLE current_correction_after ON COMMIT DROP AS
SELECT b.* FROM public.customer_billing_status b JOIN current_correction_plan p USING(customer_id);
DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM current_correction_plan p JOIN current_correction_after b USING(customer_id)
   WHERE b.balance IS DISTINCT FROM p.current_balance+p.proposed_adjustment
     OR (b.balance>0 AND (b.oldest_unpaid_due_date IS DISTINCT FROM p.due_date
                          OR b.grace_end_date IS DISTINCT FROM p.grace_end_date))
     OR (b.balance<=0 AND b.oldest_unpaid_due_date IS NOT NULL)) THEN
   RAISE EXCEPTION 'Post-write balance or grace verification failed'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p JOIN public.customers c USING(customer_id)
   WHERE c.status IS DISTINCT FROM p.customer_status) THEN RAISE EXCEPTION 'Customer status changed'; END IF;
 IF (SELECT count(*) FROM public.audit_logs WHERE source_key LIKE 'current-charge-correction-20260915:%')<>933
 OR (SELECT count(*) FROM public.waiver_requests w JOIN current_correction_plan p USING(waiver_request_id)
      WHERE w.status='reversed')<>933
 OR (SELECT count(*) FROM public.account_ledger_entries
      WHERE source_key LIKE 'current-charge-correction-20260915:retained:%')<>76 THEN
   RAISE EXCEPTION 'Post-write journal count failed'; END IF;
END $guard$;
SELECT jsonb_build_object('accounts',count(*),'net_restored',sum(p.proposed_adjustment),
 'retained_credit_and_relief',sum(p.waiver_amount-p.proposed_adjustment),
 'nonpositive_after',count(*) FILTER(WHERE b.balance<=0),
 'unpaid_grace_ends_today',count(*) FILTER(WHERE b.balance>0 AND b.grace_end_date=DATE '2026-09-15'),
 'verified_at',CURRENT_TIMESTAMP) AS payload
FROM current_correction_plan p JOIN current_correction_after b USING(customer_id);
'''
(ROOT/'APPLY-current-charge-corrections.sql').write_text('-- Approved batch. Atomic, guarded; COMMIT applies the corrections.\nBEGIN;\n'+body+'COMMIT;\n')
(ROOT/'REHEARSE-current-charge-corrections.sql').write_text('''CREATE OR REPLACE FUNCTION pg_temp.verify_current_charge_corrections() RETURNS JSONB LANGUAGE plpgsql AS $verify$
DECLARE result JSONB;
BEGIN
 BEGIN
 EXECUTE $changes$
'''+body+'''$changes$ INTO result;
 RAISE EXCEPTION USING ERRCODE='ZX002', MESSAGE=result::TEXT;
 EXCEPTION WHEN SQLSTATE 'ZX002' THEN
   RETURN jsonb_build_object('result','PASS - all correction changes rolled back','details',SQLERRM::JSONB);
 END;
END $verify$;
SELECT pg_temp.verify_current_charge_corrections() AS payload;
''')
print('Generated approved 933-account correction and rollback rehearsal.')
