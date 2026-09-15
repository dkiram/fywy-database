"""Reproduce the proposed batch from the five supplied audit exports."""
import csv
import json
from collections import Counter, defaultdict
from decimal import Decimal as D
from pathlib import Path

ROOT = Path('/Users/kimmy/.codex/attachments')
OUT = Path(__file__).resolve().parent


def read(prefix, width):
    paths = list(ROOT.glob(prefix + '*/pasted-text.txt'))
    assert len(paths) == 1
    with paths[0].open() as f:
        rows = list(csv.reader(f, delimiter='\t'))
    assert all(len(r) == width for r in rows)
    return rows


accounts = read('106df19c', 27)
receipts = read('dc314bf1', 12)
payments = read('3b2fa226', 8)
ledger = read('f714b08f', 13)
history = read('8c1a754a', 10)
assert len(accounts) == len({r[0] for r in accounts}) == 1138
assert len(payments) == len({r[1] for r in payments})
assert len(ledger) == len({r[1] for r in ledger})

pay_by = defaultdict(list)
ledger_by = defaultdict(list)
months = defaultdict(lambda: defaultdict(lambda: D(0)))
for p in payments:
    pay_by[p[0]].append(p)
    if p[6] == 'NULL' and p[4] != 'NULL':
        months[p[0]][p[4][:7]] += D(p[5])
for e in ledger:
    ledger_by[e[0]].append(e)
for a in accounts:
    assert sum((D(e[3]) for e in ledger_by[a[0]]), D(0)) == D(a[7]), a[0]

required = ['2026-%02d' % n for n in range(3, 9)]
batch, exceptions, other = [], [], []
for a in accounts:
    if D(a[8]) <= 0 or a[2] not in ('active', 'disconnected', 'pending_reconnection') or a[26] != 'false':
        continue
    cid, fee = a[0], D(a[3])
    totals = {m: str(months[cid][m]) for m in required}
    row = dict(customer_id=int(cid), name=a[1], status=a[2], balance=a[7],
               monthly_fee=a[3], month_totals=totals, september_due_date=a[5])
    if fee <= 0 or any(months[cid][m] < fee for m in required):
        row['review_reason'] = 'Missing/short month labels or invalid current fee; historical rates and receipt allocations need review.'
        other.append(row)
        continue
    flags = []
    if any(e[2] == 'monthly_charge' and D(e[3]) > fee for e in ledger_by[cid]):
        flags.append('Ledger monthly charge exceeds current monthly fee')
    if any(p[6] == 'NULL' and D(p[5]) < 0 for p in pay_by[cid]):
        flags.append('Nonvoid negative monthly receipt; resolve allocation')
    if any(e[2] == 'adjustment' and D(e[3]) > 0 for e in ledger_by[cid]):
        flags.append('Existing positive adjustment; resolve reason before clearing')
    if a[4] == 'NULL' or int(a[4][-2:]) > 15:
        flags.append('Requires separate September month coverage check')
    row['payment_ids'] = [int(p[1]) for p in pay_by[cid]
                          if p[6] == 'NULL' and p[4][:7] in required]
    row['flags'] = flags
    (exceptions if flags else batch).append(row)

assert len(batch) + len(exceptions) + len(other) == 605
summary = {
    'discount_accounts': len(accounts), 'owing_accounts': 607,
    'owing_accounts_in_scope': len(batch) + len(exceptions) + len(other),
    'six_month_payment_screen': len(batch) + len(exceptions),
    'initial_proposed_batch': len(batch),
    'debt_to_clear': str(sum((D(r['balance']) for r in batch), D(0))),
    'statuses': dict(Counter(r['status'] for r in batch)),
    'six_month_screen_exceptions': len(exceptions), 'other_accounts_to_review': len(other),
    'basis': 'March-August 2026 month labels each total at least the current fee, excluding voids. '
             'Initial batch excludes negative receipts, positive ledger adjustments, higher historical '
             'charges, and due days after 15. This is a conservative screen, not verification of historical rates.'
}
for name, data in [('summary', summary), ('initial-batch', batch),
                   ('six-month-exceptions', exceptions), ('other-review', other)]:
    (OUT / (name + '.json')).write_text(json.dumps(data, indent=2) + '\n')

def quote(text):
    return "'" + text.replace("'", "''") + "'"

values = []
for r in sorted(batch, key=lambda r: r['customer_id']):
    evidence = ('Management billing correction: March-August 2026 nonvoid month totals each >= current fee; '
                'due day 1-15 (August covers September due date). Snapshot ledger reconciles; '
                'no negative monthly receipts, positive adjustments or higher monthly charges. '
                'Clear full outstanding balance under management instruction.')
    values.append(f"    ({r['customer_id']}, {r['balance']}, {quote(evidence)})")
base = OUT.parent / 'apply-discount-missing-credits-2026.sql'
sql = base.read_text()
start = sql.index('-- Populate with affected IDs')
end = sql.index('CREATE TEMP TABLE reviewed_credits', start)
sql = sql[:start] + ('-- Proposed initial batch from supplied audit; review BEFORE output.\n'
                    'INSERT INTO reviewed_accounts VALUES\n' + ',\n'.join(values) + ';\n\n') + sql[end:]
guard = """-- Revalidate the payment screen against live data while tables are locked.
CREATE TEMP TABLE reviewed_rates (customer_id INTEGER PRIMARY KEY, monthly_fee NUMERIC(14,2)) ON COMMIT DROP;
INSERT INTO reviewed_rates VALUES
""" + ',\n'.join(f"({r['customer_id']}, {r['monthly_fee']})" for r in batch) + """;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reviewed_rates r JOIN public.customers c USING (customer_id)
    WHERE c.monthly_fee IS DISTINCT FROM r.monthly_fee
       OR c.activation_date IS NULL OR EXTRACT(DAY FROM c.activation_date) > 15
       OR EXISTS (
         SELECT 1 FROM GENERATE_SERIES(DATE '2026-03-01', DATE '2026-08-01', INTERVAL '1 month') m(month_start)
         WHERE COALESCE((SELECT SUM(p.amount_paid) FROM public.payments p
           WHERE p.customer_id = r.customer_id AND p.voided_at IS NULL
             AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
             AND DATE_TRUNC('month', p.month_paid) = m.month_start), 0) < r.monthly_fee
       )
       OR EXISTS (
         SELECT 1 FROM public.payments p WHERE p.customer_id = r.customer_id
           AND p.voided_at IS NULL AND p.amount_paid < 0
           AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
           AND (p.payment_date >= DATE '2026-01-01' OR p.month_paid >= DATE '2026-01-01')
       )
       OR EXISTS (
         SELECT 1 FROM public.account_ledger_entries e WHERE e.customer_id = r.customer_id
           AND ((e.entry_type = 'adjustment' AND e.amount > 0)
             OR (e.entry_type = 'monthly_charge' AND e.amount > r.monthly_fee))
       )
  ) THEN
    RAISE EXCEPTION 'Payment coverage, rate, due day or correction history changed; re-audit this batch.';
  END IF;
END $$;
SELECT COUNT(*) AS accounts_in_batch, SUM(credit_to_add) AS total_debt_to_clear,
       COUNT(*) FILTER (WHERE status_before = 'disconnected') AS accounts_to_queue
FROM reviewed_credits;

"""
sql = sql.replace("SELECT 'BEFORE' AS stage", guard + "SELECT 'BEFORE' AS stage")
# Preserve the original template while delivering a populated, reproducible batch.
(OUT / 'apply-initial-batch.sql').write_text(sql)
report = ['# Proposed initial billing correction', '',
          f"{len(batch)} accounts; J${summary['debt_to_clear']} outstanding debt to clear.",
          f"{summary['statuses'].get('disconnected', 0)} disconnected accounts move to pending_reconnection.", '',
          summary['basis'], '',
          'Balances were checked against every supplied ledger entry. SQL rechecks live balances and discount eligibility. '
          'The script uses employee 2 and ends in ROLLBACK. No database changes have been executed.', '',
          '| ID | Customer | Status | Debt to clear (J$) |', '|---|---|---|---:|']
for r in sorted(batch, key=lambda r: r['customer_id']):
    report.append(f"| {r['customer_id']} | {r['name'].replace('|', '/')} | {r['status']} | {r['balance']} |")
report += ['', '## Six-month screen exceptions', '',
           '| ID | Customer | Outstanding (J$) | Reason to review |', '|---|---|---:|---|']
for r in sorted(exceptions, key=lambda r: r['customer_id']):
    report.append(f"| {r['customer_id']} | {r['name'].replace('|', '/')} | {r['balance']} | {'; '.join(r['flags'])} |")
(OUT / 'review.md').write_text('\n'.join(report) + '\n')
print(json.dumps(summary, indent=2))
