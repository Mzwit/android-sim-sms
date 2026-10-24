import { useState } from 'react';
import { get, post } from '../api';
import { useAuth } from '../auth';
import { Modal, Notice, Pager, useAction, useLoad, when } from '../util';

export function OptOuts() {
  const { can } = useAuth();
  const [active, setActive] = useState(true);
  const [page, setPage] = useState(1);
  const { data, reload, error } = useLoad(() => get(`/suppressions?active=${active}&page=${page}&page_size=50`), [active, page]);
  const [adding, setAdding] = useState(false);
  const [lift, setLift] = useState<any>();
  return (
    <>
      <header className="page-head">
        <h1>Opt-outs</h1>
        {can('consent.write') && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            Opt out a number
          </button>
        )}
      </header>
      <p className="muted">
        These numbers never receive messages, even if they are imported again. Replies such as STOP to the gateway phone are added here automatically, and any of their queued
        messages are cancelled at once.
      </p>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={active} className={active ? 'is-current' : ''} onClick={() => { setActive(true); setPage(1); }}>
          Active
        </button>
        <button role="tab" aria-selected={!active} className={!active ? 'is-current' : ''} onClick={() => { setActive(false); setPage(1); }}>
          Lifted
        </button>
      </div>
      <Notice kind="error">{error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th>Number</th>
            <th>Reason</th>
            <th>How</th>
            <th>Since</th>
            {!active && <th>Lifted</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((s: any) => (
            <tr key={s.id}>
              <td>{s.phone_e164}</td>
              <td>{s.reason.toLowerCase().replace(/_/g, ' ')}</td>
              <td className="small">
                {s.source}
                {s.note && ` – ${s.note}`}
              </td>
              <td>{when(s.created_at)}</td>
              {!active && (
                <td className="small">
                  {when(s.lifted_at)} {s.lift_note}
                </td>
              )}
              <td className="row-actions">
                {active && can('consent.write') && (
                  <button className="btn btn-quiet" onClick={() => setLift(s)}>
                    Lift
                  </button>
                )}
              </td>
            </tr>
          ))}
          {data?.items.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No {active ? 'active' : 'lifted'} opt-outs.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data && <Pager page={page} pageSize={50} total={data.total} onPage={setPage} />}
      {adding && <AddOptOut onClose={() => { setAdding(false); void reload(); }} />}
      {lift && <LiftOptOut s={lift} onClose={() => { setLift(undefined); void reload(); }} />}
    </>
  );
}

function AddOptOut({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('OPT_OUT');
  const [source, setSource] = useState('');
  const a = useAction();
  return (
    <Modal title="Opt out a number" onClose={onClose}>
      <label>
        Number
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="7612 3456" autoFocus />
      </label>
      <label>
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="OPT_OUT">The person asked to stop</option>
          <option value="COMPLAINT">Complaint</option>
          <option value="INVALID_NUMBER">Wrong or reassigned number</option>
          <option value="ADMIN">Other administrative reason</option>
        </select>
      </label>
      <label>
        How you know
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Phoned reception on 24 Oct" />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <Notice kind="ok">{a.ok}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button
          className="btn btn-primary"
          disabled={!phone || source.trim().length < 2 || a.busy}
          onClick={() => void a.run(async () => {
            const r = reason === 'OPT_OUT' ? await post('/opt-outs', { phone, source }) : await post('/suppressions', { phone, reason, source });
            a.setOk(r.already_suppressed ? 'This number was already opted out.' : `Opted out. ${r.cancelled_messages} queued message(s) cancelled.`);
            setTimeout(onClose, 1200);
          })}
        >
          Opt out
        </button>
      </div>
    </Modal>
  );
}

function LiftOptOut({ s, onClose }: { s: any; onClose: () => void }) {
  const [note, setNote] = useState('');
  const a = useAction();
  return (
    <Modal title={`Lift opt-out for ${s.phone_e164}`} onClose={onClose}>
      <p>
        Only lift an opt-out when the person has clearly asked to receive messages again. Their consent stays withdrawn until you record new consent on their contact.
      </p>
      <label>
        Evidence of renewed consent
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Signed new consent form, 20 Oct 2026" />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={note.trim().length < 10 || a.busy} onClick={() => void a.run(async () => { await post(`/suppressions/${s.id}/lift`, { note }); onClose(); })}>
          Lift opt-out
        </button>
      </div>
    </Modal>
  );
}
