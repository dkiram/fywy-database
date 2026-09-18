"""Generate guarded staff-approved corrections from the reviewed live snapshot."""
import json
from decimal import Decimal
from pathlib import Path
ROOT=Path(__file__).resolve().parent
live=json.loads((ROOT/'staff-review-live.json').read_text())
review={r['customer_id']:r for r in json.loads((ROOT/'current-charge-review.json').read_text())}
override={38:3500,1641:2500,1899:3500,2512:0,4379:0,10389:0,15019:0,
          9524:-1000,2525:1500,9946:1500,7134:1000,11139:1000,14975:1500}
def quote(v): return "'"+str(v).replace("'","''")+"'"
rows=[]; report=[]
for c in live:
    cid=c['customer_id']; r=review[cid]
    target=Decimal(str(override.get(cid,r['possible_restoration'])))
    before=Decimal(str(c['billing']['balance'])); delta=target-before
    report.append(dict(customer_id=cid,name=c['name'],before=float(before),target=float(target),adjustment=float(delta)))
    if not delta: continue
    assert c['status']=='active'
    if delta>0: assert delta<=Decimal(str(r['waiver_amount']))
    vals=[str(cid),quote(c['status']),str(before),str(delta),str(r['waiver_amount']),
          str(r['waiver_request_id']),str(r['waiver_id']),str(r['charge_id']),
          quote(r['due_date']),quote(r['grace_end_date']),
          quote(json.dumps(c['ledger'],separators=(',',':')))+'::jsonb',
          quote(json.dumps(c['payments'],separators=(',',':')))+'::jsonb']
    rows.append('('+','.join(vals)+')')
assert len(rows)==26
net=sum(Decimal(str(r['adjustment'])) for r in report)
body='''SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
LOCK TABLE public.customers,public.payments,public.account_ledger_entries,public.waiver_requests,
 public.customer_billing_start,public.customer_rate_history,public.audit_logs,
 public.account_status_history,public.disconnection_holds IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE current_correction_plan(
 customer_id INTEGER PRIMARY KEY,customer_status TEXT,current_balance NUMERIC,
 proposed_adjustment NUMERIC,waiver_amount NUMERIC,waiver_request_id BIGINT,
 waiver_id BIGINT,charge_id BIGINT,due_date DATE,grace_end_date DATE,
 expected_ledger JSONB,expected_payments JSONB) ON COMMIT DROP;
INSERT INTO current_correction_plan VALUES
'''+',\n'.join(rows)+''';
DO $guard$ BEGIN
 IF (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::date<>DATE '2026-09-15' THEN
   RAISE EXCEPTION 'Date changed; refresh staff review'; END IF;
 IF EXISTS(SELECT 1 FROM public.audit_logs WHERE source_key LIKE 'staff-reviewed-correction-20260915:%') THEN
   RAISE EXCEPTION 'Staff batch already applied'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p JOIN public.customers c USING(customer_id)
   WHERE c.status IS DISTINCT FROM p.customer_status) THEN RAISE EXCEPTION 'Status changed'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p LEFT JOIN public.waiver_requests w USING(waiver_request_id)
   WHERE w.status IS DISTINCT FROM 'approved' OR w.amount IS DISTINCT FROM p.waiver_amount
     OR w.waiver_ledger_entry_id IS DISTINCT FROM p.waiver_id) THEN RAISE EXCEPTION 'Waiver changed'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p WHERE p.expected_ledger IS DISTINCT FROM (
   SELECT jsonb_agg(jsonb_build_array(e.account_ledger_entry_id,e.entry_type,e.amount,e.due_date,e.grace_end_date,
      e.created_at,e.source_key,e.reason) ORDER BY e.account_ledger_entry_id)
   FROM public.account_ledger_entries e WHERE e.customer_id=p.customer_id)) THEN
   RAISE EXCEPTION 'Ledger changed since staff review. Preserve new payments; refresh before applying.'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p WHERE p.expected_payments IS DISTINCT FROM (
   SELECT jsonb_agg(jsonb_build_array(x.payment_id,x.amount_paid,x.payment_date,x.month_paid,x.voided_at,x.recorded_at)
     ORDER BY x.payment_id) FROM public.payments x WHERE x.customer_id=p.customer_id
     AND COALESCE(x.payment_type,x.legacy_payment_type)='Monthly Fee'
     AND (x.payment_date>=DATE '2026-08-01' OR x.month_paid>=DATE '2026-08-01'))) THEN
   RAISE EXCEPTION 'Payments changed since review'; END IF;
END $guard$;
'''
old=(ROOT/'APPLY-current-charge-corrections.sql').read_text()
core=old[old.index('-- Reverse each original waiver'):old.index('CREATE TEMP TABLE current_correction_after')]
core=core.replace('current-charge-correction-20260915','staff-reviewed-correction-20260915')
core=core.replace('FROM current_correction_plan;', 'FROM current_correction_plan WHERE proposed_adjustment>0;')
core=core.replace('WHERE waiver_amount>proposed_adjustment;', 'WHERE proposed_adjustment>0 AND waiver_amount>proposed_adjustment;')
core=core.replace('WHERE p.waiver_amount>p.proposed_adjustment;', 'WHERE p.proposed_adjustment>0 AND p.waiver_amount>p.proposed_adjustment;')
core=core.replace('WHERE w.waiver_request_id=p.waiver_request_id', 'WHERE p.proposed_adjustment>0 AND w.waiver_request_id=p.waiver_request_id')
# The common audit applies to both positive corrections and the approved extra credit.
core=core.replace('Corrected current charge cleared by reconciliation','Applied staff-reviewed billing correction')
core=core.replace("'. Later payments and retained relief preserved; original waiver request '||p.waiver_request_id::TEXT||' reversed.'", "'. Staff-approved outstanding/credit target; original waiver request '||p.waiver_request_id::TEXT")
body+=core+'''
INSERT INTO public.account_ledger_entries(customer_id,entry_type,amount,effective_date,description,
 created_by_employee_id,reason,is_verified,source_key)
SELECT customer_id,'waiver',proposed_adjustment,DATE '2026-09-15',
 'Staff-reviewed additional account credit',2,'Staff confirmed J$1,000 credit for Mary Nicholson.',TRUE,
 'staff-reviewed-correction-20260915:extra-credit:'||customer_id::TEXT
FROM current_correction_plan WHERE proposed_adjustment<0;
INSERT INTO public.waiver_requests(customer_id,amount,reason,status,requested_by_employee_id,
 reviewed_by_employee_id,reviewed_at,review_note,waiver_ledger_entry_id,is_credit)
SELECT p.customer_id,-p.proposed_adjustment,'Staff confirmed the account credit after payment review.',
 'approved',2,2,CURRENT_TIMESTAMP,'Staff review September 15: target J$1,000 credit.',l.account_ledger_entry_id,TRUE
FROM current_correction_plan p JOIN public.account_ledger_entries l
 ON l.source_key='staff-reviewed-correction-20260915:extra-credit:'||p.customer_id::TEXT
WHERE p.proposed_adjustment<0;
CREATE TEMP TABLE current_correction_after ON COMMIT DROP AS
SELECT b.* FROM public.customer_billing_status b JOIN current_correction_plan p USING(customer_id);
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM current_correction_plan p JOIN current_correction_after b USING(customer_id)
   WHERE b.balance IS DISTINCT FROM p.current_balance+p.proposed_adjustment
      OR (b.balance>0 AND (b.oldest_unpaid_due_date IS DISTINCT FROM p.due_date
                           OR b.grace_end_date IS DISTINCT FROM p.grace_end_date))
      OR (b.balance<=0 AND b.oldest_unpaid_due_date IS NOT NULL)) THEN
   RAISE EXCEPTION 'Balance or original due/grace date verification failed'; END IF;
 IF EXISTS(SELECT 1 FROM current_correction_plan p JOIN public.customers c USING(customer_id)
    WHERE c.status IS DISTINCT FROM p.customer_status) THEN RAISE EXCEPTION 'Status changed'; END IF;
 IF (SELECT count(*) FROM public.audit_logs WHERE source_key LIKE 'staff-reviewed-correction-20260915:%')<>26 THEN
   RAISE EXCEPTION 'Wrong audit count'; END IF;
END $guard$;
SELECT jsonb_build_object('accounts',count(*),'net_adjustment',sum(p.proposed_adjustment),
 'details',jsonb_agg(jsonb_build_array(p.customer_id,b.balance,b.oldest_unpaid_due_date,b.grace_end_date)
     ORDER BY p.customer_id),'verified_at',CURRENT_TIMESTAMP) AS payload
FROM current_correction_plan p JOIN current_correction_after b USING(customer_id);
'''
(ROOT/'APPLY-staff-reviewed-corrections.sql').write_text('BEGIN;\n'+body+'COMMIT;\n')
(ROOT/'REHEARSE-staff-reviewed-corrections.sql').write_text('''CREATE OR REPLACE FUNCTION pg_temp.verify_staff_corrections() RETURNS JSONB LANGUAGE plpgsql AS $verify$
DECLARE result JSONB;
BEGIN BEGIN EXECUTE $changes$
'''+body+'''$changes$ INTO result;
 RAISE EXCEPTION USING ERRCODE='ZX003',MESSAGE=result::TEXT;
 EXCEPTION WHEN SQLSTATE 'ZX003' THEN RETURN jsonb_build_object('result','PASS - all staff corrections rolled back','details',SQLERRM::JSONB);
 END; END $verify$;
SELECT pg_temp.verify_staff_corrections() AS payload;
''')
(ROOT/'staff-approved-targets.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(dict(changes=len(rows),net_adjustment=str(net),unchanged=[r['customer_id'] for r in report if not r['adjustment']])))
