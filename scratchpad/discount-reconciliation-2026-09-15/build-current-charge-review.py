"""Build a read-only current-charge review from captured production evidence."""
import collections
import datetime
import decimal
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
D = lambda value: decimal.Decimal(str(value))


def timestamp(value):
    # PostgreSQL may omit trailing zeros in fractional seconds.
    import re
    value = re.sub(r'\.(\d+)([+-])', lambda m: '.' + m[1].ljust(6, '0') + m[2], value)
    return datetime.datetime.fromisoformat(value)


def classify(row):
    at = timestamp(row['waiver_at'])
    pre = [p for p in row['receipts'] or []
           if (p[5] is None or timestamp(p[5]) <= at)
           and (p[4] is None or timestamp(p[4]) > at)
           and p[2] <= row['waiver_at'][:10]]
    paid = sum((D(p[1]) for p in pre if p[3] and p[3][:7] == row['service_month'][:7]), D(0))
    amount = min(D(row['cleared_current']), max(D(0), D(row['charge_amount']) - paid))
    unlabelled = any(p[3] is None and D(p[1]) != 0 for p in pre)
    unusual_later = any(e[1] != 'monthly_payment' or D(e[2]) >= 0
                        or not (e[5] or '').startswith('payment:')
                        for e in row['later_entries'] or [])
    if row['waiver_status'] == 'reversed':
        decision = 'already_reversed'
    elif amount == 0:
        decision = 'covered_by_receipts'
    elif row['waiver_status'] != 'approved' or row['customer_status'] != 'active':
        decision = 'review_status'
    elif row['schedule_converted']:
        decision = 'review_prepaid_schedule'
    elif unlabelled:
        decision = 'review_unlabelled_receipts'
    elif unusual_later:
        decision = 'review_later_charges'
    elif paid < 0:
        decision = 'review_negative_receipts'
    else:
        decision = 'proposed_restore'
    exception_path = ROOT/'grace-allocation-exceptions.json'
    if decision == 'proposed_restore' and exception_path.exists():
        if row['customer_id'] in {r['id'] for r in json.loads(exception_path.read_text())}:
            decision = 'review_due_allocation'
    return dict(row, decision=decision, matched_paid_before=float(paid),
                possible_restoration=float(amount),
                proposed_adjustment=float(amount) if decision == 'proposed_restore' else 0,
                proposed_balance=float(D(row['current_balance']) + amount)
                    if decision == 'proposed_restore' else row['current_balance'])


def main():
    source = (ROOT/'investigate-current-charges.sql').read_text()
    prefix = source.split('SELECT jsonb_agg(to_jsonb(r)')[0].rstrip()
    evidence = source.split('AS payload FROM (\n', 1)[1].rsplit(') r;', 1)[0]
    assessment_sql = prefix + ', evidence AS (\n' + evidence + r'''), payment_evidence AS (
 SELECT e.*, p.matched_paid_before, p.unlabelled,
        EXISTS(SELECT 1 FROM jsonb_array_elements(e.later_entries) x
          WHERE x->>1 IS DISTINCT FROM 'monthly_payment' OR (x->>2)::numeric>=0
             OR COALESCE(x->>5,'') NOT LIKE 'payment:%') AS unusual_later
 FROM evidence e
 CROSS JOIN LATERAL (
   SELECT COALESCE(SUM((x->>1)::numeric) FILTER(
              WHERE date_trunc('month',(x->>3)::date)::date=e.service_month),0) AS matched_paid_before,
          COALESCE(BOOL_OR(x->>3 IS NULL AND (x->>1)::numeric<>0),false) AS unlabelled
   FROM jsonb_array_elements(e.receipts) x
   WHERE (x->>5 IS NULL OR (x->>5)::timestamptz<=e.waiver_at)
     AND (x->>4 IS NULL OR (x->>4)::timestamptz>e.waiver_at)
     AND (x->>2)::date<=(e.waiver_at AT TIME ZONE 'America/Jamaica')::date
 ) p
), amounts AS (
 SELECT *, LEAST(cleared_current,GREATEST(charge_amount-matched_paid_before,0)) AS possible_restoration
 FROM payment_evidence
), initial_decisions AS (
 SELECT *, CASE
   WHEN waiver_status='reversed' THEN 'already_reversed'
   WHEN possible_restoration=0 THEN 'covered_by_receipts'
   WHEN waiver_status IS DISTINCT FROM 'approved' OR customer_status IS DISTINCT FROM 'active' THEN 'review_status'
   WHEN schedule_converted THEN 'review_prepaid_schedule'
   WHEN unlabelled THEN 'review_unlabelled_receipts'
   WHEN unusual_later THEN 'review_later_charges'
   WHEN matched_paid_before<0 THEN 'review_negative_receipts'
   ELSE 'proposed_restore' END AS initial_decision
 FROM amounts
), allocation_credits AS (
 SELECT e.customer_id,COALESCE(-SUM(e.amount) FILTER(WHERE e.amount<0),0) AS credits
 FROM public.account_ledger_entries e JOIN initial_decisions p USING(customer_id)
 WHERE p.initial_decision='proposed_restore' GROUP BY e.customer_id
), allocation_debits AS (
 SELECT e.customer_id,e.due_date,e.grace_end_date,e.account_ledger_entry_id,
   SUM(e.amount) OVER(PARTITION BY e.customer_id
      ORDER BY e.due_date NULLS FIRST,e.account_ledger_entry_id) AS cumulative
 FROM public.account_ledger_entries e JOIN initial_decisions p USING(customer_id)
 WHERE e.amount>0 AND p.initial_decision='proposed_restore'
), allocation_oldest AS (
 SELECT DISTINCT ON(d.customer_id) d.customer_id,d.due_date,d.grace_end_date
 FROM allocation_debits d JOIN allocation_credits c USING(customer_id)
 JOIN initial_decisions p USING(customer_id)
 WHERE d.cumulative+p.possible_restoration>c.credits
 ORDER BY d.customer_id,d.due_date NULLS FIRST,d.account_ledger_entry_id
), decisions AS (
 SELECT p.*, CASE WHEN p.initial_decision='proposed_restore'
   AND ((p.current_balance+p.possible_restoration>0
         AND (o.due_date IS DISTINCT FROM p.due_date OR o.grace_end_date IS DISTINCT FROM p.grace_end_date))
        OR (p.current_balance+p.possible_restoration<=0 AND o.customer_id IS NOT NULL))
   THEN 'review_due_allocation' ELSE p.initial_decision END AS decision
 FROM initial_decisions p LEFT JOIN allocation_oldest o USING(customer_id)
), preview AS (
 SELECT *, CASE WHEN decision='proposed_restore' THEN possible_restoration ELSE 0 END AS proposed_adjustment
 FROM decisions
)
'''
    detail_sql = assessment_sql + '''SELECT customer_id,name,decision,due_date,grace_end_date,service_month,
 charge_amount,matched_paid_before,cleared_current,current_balance,proposed_adjustment,
 current_balance+proposed_adjustment AS proposed_balance,
 grace_end_date+1 AS original_disconnection_eligibility_date,
 COUNT(*) FILTER(WHERE decision='proposed_restore') OVER() AS total_proposed_accounts,
 SUM(proposed_adjustment) OVER() AS total_proposed_adjustment,
 waiver_request_id,waiver_status,receipts,later_entries
FROM preview ORDER BY decision,customer_id;
'''
    summary_sql = assessment_sql + '''SELECT decision,COUNT(*) AS accounts,
 SUM(proposed_adjustment) AS proposed_adjustment,
 COUNT(*) FILTER(WHERE proposed_adjustment>0 AND due_date=DATE '2026-09-15') AS due_today,
 COUNT(*) FILTER(WHERE proposed_adjustment>0 AND current_balance+proposed_adjustment<=0) AS remain_paid,
 COUNT(*) FILTER(WHERE proposed_adjustment>0 AND current_balance+proposed_adjustment>0
   AND grace_end_date=DATE '2026-09-15') AS unpaid_grace_ends_today
FROM preview GROUP BY decision ORDER BY decision;
'''
    (ROOT/'preview-current-charge-corrections.sql').write_text(detail_sql)
    (ROOT/'summary-current-charge-corrections.sql').write_text(summary_sql)
    rows = [classify(r) for p in sorted(ROOT.glob('current-charge-[0-9]*.json'))
            for r in json.loads(p.read_text())]
    assert len(rows) == len({r['customer_id'] for r in rows}) == 1582
    assert sum(D(r['cleared_current']) for r in rows) == D(4721980)
    assert next(r for r in rows if r['customer_id'] == 7026)['decision'] == 'already_reversed'
    assert next(r for r in rows if r['customer_id'] == 19)['decision'] == 'covered_by_receipts'
    for r in rows:
        assert 0 <= D(r['proposed_adjustment']) <= D(r['cleared_current']) <= D(r['charge_amount'])
    summary = {}
    for group in sorted({r['decision'] for r in rows}):
        members = [r for r in rows if r['decision'] == group]
        summary[group] = dict(accounts=len(members),
            proposed_adjustment=float(sum(D(r['proposed_adjustment']) for r in members)),
            possible_restoration=float(sum(D(r['possible_restoration']) for r in members)))
    ready = [r for r in rows if r['decision'] == 'proposed_restore']
    summary['due_september_15_proposals'] = dict(accounts=sum(r['due_date']=='2026-09-15' for r in ready),
        amount=float(sum(D(r['proposed_adjustment']) for r in ready if r['due_date']=='2026-09-15')))
    summary['proposals_with_later_payments'] = sum(bool(r['later_entries']) for r in ready)
    summary['proposals_ending_nonpositive'] = sum(r['proposed_balance'] <= 0 for r in ready)
    (ROOT/'current-charge-review.json').write_text(json.dumps(rows, indent=2)+'\n')
    (ROOT/'current-charge-review-summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    lines = ['# Current charges cleared by the September 15 reconciliation', '',
        '**Investigation and proposal only. No corrective database writes performed.**', '',
        'Production evidence collected September 15, approximately 13:25–13:32 Jamaica time. '
        'Run `preview-current-charge-corrections.sql` for a fresh read-only assessment before any correction.', '',
        '## Findings', '',
        '- The original 2,639 ledger credits totaling J$9,467,380 are committed.',
        '- 1,582 accounts had J$4,721,980 cleared against September 5–15 monthly charges whose grace had not ended.',
        '- Customer 7026: September 15 charge posted 00:00:27; waiver posted 01:15:56. '
        'A separate reversal at 13:10:41 restored J$5,000. Excluded from proposals. Grace ends September 25; disconnection eligibility begins September 26.',
        '- All 1,582 reviewed accounts were active. These proposals do not change status or reconnection queues.', '',
        '## Decision totals', '', '| Decision | Accounts | Proposed addition |', '|---|---:|---:|']
    for k, v in summary.items():
        if isinstance(v, dict) and 'proposed_adjustment' in v:
            lines.append(f"| {k} | {v['accounts']} | J${v['proposed_adjustment']:,.2f} |")
    lines += ['', '## How proposed amounts are calculated', '',
        '1. Reconstruct the ledger immediately before the original waiver using ledger IDs. '
        'Use the application’s oldest-debit-first allocation to find the exact current-charge amount the waiver cleared.',
        '2. Match nonvoid payments already recorded at the waiver to the service month. '
        'For due days 1–15, September’s due date represents August service. '
        'The proposed addition is the smaller of the amount cleared and the monthly charge less matching payments, never below zero.',
        '3. Add that amount to the current ledger balance. Later payment credits remain in place; '
        'they are not subtracted a second time. Existing future credit is not separately reversed.',
        '4. Exclude an already reversed waiver. Hold unlabelled receipts, changed schedules/status, '
        'and subsequent charges or manual adjustments for separate review.', '',
        '**Limitations:** payment month labels and historical ledger records may be incorrect. '
        'These are conservative proposals under the corrected rule, not proof of the underlying service obligation. '
        'Receipts without month labels collected before August 1 are outside this receipt extract. '
        'Their recorded ledger credit is included in the allocation, but unrecorded advance coverage cannot be established from this scan.', '',
        '## Separate issues', '',
        'Accounts 2525, 9524 and 9946 have older monthly charges generated after the reconciliation when payments were entered. '
        'They are excluded from automatic proposals (9524 is also in the unlabelled-receipt group). '
        'Review the payment-month charge generation path before deciding whether those older charges are valid.', '',
        'Restoring charges with grace ending September 15 could make unpaid accounts eligible for disconnection September 16. '
        'Any application must preview the resulting billing eligibility, use employee 2, and be guarded against repeat execution '
        'and payments/reversals arriving after review. Do not rerun the original reconciliation.', '',
        '## Customer detail', '',
        '| ID | Customer | Due | Grace ends | Decision | Current balance | Proposed addition | Proposed balance |',
        '|---|---|---|---|---|---:|---:|---:|']
    for r in rows:
        name = r['name'].replace('|', '\\|').replace('\n', ' ')
        lines.append(f"| {r['customer_id']} | {name} | {r['due_date']} | {r['grace_end_date']} | {r['decision']} | {r['current_balance']:,.2f} | {r['proposed_adjustment']:,.2f} | {r['proposed_balance']:,.2f} |")
    (ROOT/'CURRENT-CHARGE-REVIEW.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
