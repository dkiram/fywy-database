"""Build an exact review manifest; never connects to or writes a database."""
import json
from decimal import Decimal as D
from collections import Counter
from pathlib import Path

out = Path(__file__).resolve().parent
rows = []
for p in sorted(out.glob('live-plan-*.json')):
    rows.extend(json.loads(p.read_text(), parse_float=D))
assert len(rows) == len({r[0] for r in rows})
assert len(rows) == 2646, f'Incomplete collection: {len(rows)} / 2646'
assert all(not r[14] for r in rows), 'Hidden accounts require separate review'
changes = [r for r in rows if r[5] > r[6]]
queue = [r for r in rows if r[2] == 'disconnected']
assert len(changes) == 2636
total = sum((r[5] - r[6] for r in changes), D(0))
assert total == D('9347080')
summary = dict(accounts_scanned=11327, financial_corrections=len(changes),
               total_adjustment=str(total), debt_cleared=str(sum((max(r[5], 0) for r in changes), D(0))),
               queue_for_reconnection=len(queue), status_counts=dict(Counter(r[2] for r in changes)),
               future_credit_accounts=sum(r[6] < 0 for r in changes),
               unlabelled_recent_payment_accounts=sum(r[10] != 0 for r in changes),
               policy='PROPOSED, awaiting management clarification: positive net monthly receipts since August 1 qualify for full debt relief; future payments retain credit under the due-day mapping.')
(out / 'all-account-summary.json').write_text(json.dumps(summary, indent=2) + '\n')

def money(n):
    return f'{n:,.2f}'

report = ['# All-account reconciliation review', '',
          '**Proposal only. No customer balances or statuses have been changed.**', '',
          '## Decision required', '',
          'Recent payments are evidence of payment activity; they do not, by themselves, prove all arrears are incorrect. '
          'This proposed plan applies a one-time full debt reset to recent net-paying accounts. Management must confirm that broader policy.', '',
          f"- Accounts scanned: **11,327**.",
          f"- Financial corrections: **{len(changes):,}**.",
          f"- Total adjustment: **J${money(total)}**.",
          f"- Outstanding debt cleared: **J${money(D(summary['debt_cleared']))}**.",
          f"- Additional advance credit restored: **J${money(total - D(summary['debt_cleared']))}**.",
          f"- Disconnected accounts queued: **{len(queue)}**, including 10 already without an outstanding balance.", '',
          '## Exact proposed rule', '',
          '- All customer accounts were scanned, regardless of earlier discounts.',
          '- A positive net Monthly Fee total collected August 1–September 15 qualifies for the proposed debt reset; voided payments are excluded.',
          '- Paid-for months with a future mapped due date retain prepaid value. Due days 1–15 map a paid month to the next calendar month; days 16–31 map it to the same month.',
          '- Future monthly charges already posted are deducted from the prepaid reserve to avoid double credit.',
          '- The target is the lower of the existing balance and the negative prepaid reserve. Existing credit is preserved.',
          '- Disconnected qualifying accounts move to pending_reconnection. Other account statuses remain unchanged.',
          '- Unlabelled receipts count as payment activity, but cannot establish a particular future paid-for month.', '',
          '## Largest proposed adjustments', '',
          '| ID | Name | Status | Current balance | Target balance | Adjustment | Recent net paid |',
          '|---|---|---|---:|---:|---:|---:|']
for r in sorted(changes, key=lambda r: r[5] - r[6], reverse=True)[:30]:
    report.append(f'| {r[0]} | {r[1].replace("|", "/")} | {r[2]} | {money(r[5])} | {money(r[6])} | {money(r[5]-r[6])} | {money(r[7])} |')
report += ['', '## All proposed accounts', '',
           '| ID | Name | Status | Current balance | Target balance | Recent net paid | Last payment | Unlabelled recent total |',
           '|---|---|---|---:|---:|---:|---|---:|']
for r in rows:
    report.append(f'| {r[0]} | {r[1].replace("|", "/")} | {r[2]} | {money(r[5])} | {money(r[6])} | {money(r[7])} | {r[8]} | {money(r[10])} |')
(out / 'all-account-review.md').write_text('\n'.join(report) + '\n')
print(json.dumps(summary, indent=2))
