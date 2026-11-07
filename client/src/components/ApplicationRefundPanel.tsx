import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../auth/AuthContext';

type Refund = {
  application_refund_id: number; amount: string; returned_on: string; location_name: string;
  cashier_name: string; status: 'pending' | 'approved' | 'rejected'; reviewer_name: string;
  review_note: string | null;
};
const money = (amount: string) => `J$${Number(amount).toLocaleString('en-JM', { minimumFractionDigits: 2 })}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Jamaica', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const inputClass = 'mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm';

export default function ApplicationRefundPanel({ application, onChanged }: {
  application: { application_id: number; status: string; installation_payment_id: number | null; installation_amount: string | null; installation_voided: boolean };
  onChanged: (status: 'pending' | 'approved' | 'rejected') => void;
}) {
  const { employee } = useAuth();
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [returnedOn, setReturnedOn] = useState(today);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canReview = employee?.role === 'admin' || employee?.role === 'head_office';
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch(`/api/applications/${application.application_id}/refunds`);
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not load refunds.');
      setRefunds(data.refunds);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load refunds.'); }
    finally { setLoading(false); }
  }, [application.application_id]);
  useEffect(() => { void load(); }, [load]);
  const current = refunds[0];
  const canRequest = ['pending', 'match_review', 'legacy_unresolved'].includes(application.status)
    && application.installation_payment_id && !application.installation_voided && Number(application.installation_amount) > 0
    && !refunds.some(r => r.status === 'pending' || r.status === 'approved');
  async function submit(decision?: 'approved' | 'rejected') {
    setBusy(true); setError(''); setNotice('');
    try {
      const path = decision ? `/${current.application_refund_id}/review` : '';
      const response = await apiFetch(`/api/applications/${application.application_id}/refunds${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision ? { decision, note } : { returnedOn, moneyReturned: confirmed }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not save refund.');
      setRequesting(false); setConfirmed(false); setNote('');
      setNotice(decision === 'approved' ? 'Refund approved. The application is closed as Refund; the deduction uses the money-return date.'
        : decision === 'rejected' ? 'Refund request rejected. No deduction was posted.' : 'Refund requested. Head office can now review it.');
      await load(); onChanged(decision ?? 'pending');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save refund.'); }
    finally { setBusy(false); }
  }
  if (!loading && !canRequest && !refunds.length && !error) return null;
  return <section className="space-y-3 rounded-xl border border-outline-variant p-4" aria-label="Application refund">
    <h3 className="font-semibold">Application refund</h3>
    {loading && <p className="text-sm">Loading refund details…</p>}
    {refunds.map(refund => <div key={refund.application_refund_id} className="rounded-lg bg-surface-container-low p-3 text-sm">
      <p className="font-semibold">{money(refund.amount)} · {refund.status === 'pending' ? 'Awaiting head office approval' : refund.status === 'approved' ? 'Refund approved' : 'Request rejected'}</p>
      <p className="mt-1">Returned {refund.returned_on.slice(0, 10)} at {refund.location_name} by {refund.cashier_name}.</p>
      {refund.reviewer_name && <p>Reviewed by {refund.reviewer_name}.</p>}
      {refund.review_note && <p>{refund.review_note}</p>}
    </div>)}
    {!loading && canRequest && !requesting && <button type="button" onClick={() => setRequesting(true)} className="rounded-lg bg-error/10 px-4 py-2 text-sm font-semibold text-error">Request Refund</button>}
    {requesting && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="text-sm">Request a full refund of <strong>{money(application.installation_amount!)}</strong>. The returning office is <strong>{employee?.locationName || 'not assigned to your account'}</strong>. After approval, the application closes with reason “Refund” and this office’s totals are reduced on the date below.</p>
      <label className="block text-sm font-medium">Date money was returned<input type="date" required max={today()} value={returnedOn} onChange={e => setReturnedOn(e.target.value)} className={inputClass} /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />I handed the full amount back to the applicant.</label>
      <div className="flex gap-2"><button disabled={busy || !confirmed || !employee?.locationId} className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Submit Refund Request'}</button><button type="button" disabled={busy} onClick={() => setRequesting(false)} className="px-3 py-2 text-sm">Cancel</button></div>
    </form>}
    {!loading && current?.status === 'pending' && canReview && <div className="space-y-3">
      <p className="text-sm">Approve {money(current.amount)} returned on {current.returned_on.slice(0, 10)} at {current.location_name}. Approval closes the application and deducts that amount from that office’s return-day total.</p>
      <label className="block text-sm">Review note (required only to reject)<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)} className={inputClass} /></label>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void submit('approved')} className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">Approve Refund</button><button type="button" disabled={busy || note.trim().length < 3} onClick={() => void submit('rejected')} className="rounded-lg bg-error/10 px-4 py-2 text-sm text-error disabled:opacity-50">Reject Request</button></div>
    </div>}
    {notice && <p role="status" className="text-sm text-tertiary">{notice}</p>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
  </section>;
}
