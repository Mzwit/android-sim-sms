import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post } from '../api';
import { useAuth } from '../auth';
import { MessageTable } from './Campaigns';
import { Modal, n, Notice, Pager, useAction, useLoad } from '../util';

const TABS = [
  { key: 'unknown', label: 'Unknown outcome', q: 'status=UNKNOWN', help: 'The phone may or may not have sent these. Find out what happened before resending, or a recipient could get the message twice.' },
  { key: 'dead', label: 'Retries used up', q: 'dead_letter=true', help: 'Temporary failures (no signal, radio errors) that failed on every automatic attempt.' },
  { key: 'failed', label: 'All failed', q: 'status=FAILED', help: 'Rejected by the network, invalid numbers, failed delivery reports, and dead letters.' },
  { key: 'test', label: 'Test messages', q: 'is_test=true', help: 'Messages sent to authorised test numbers.' },
];

export function Messages() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [tab, setTab] = useState(TABS[0]!);
  const [page, setPage] = useState(1);
  const campaign = params.get('campaign_id');
  const { data, reload, error } = useLoad(() => get(`/messages?${tab.q}&page=${page}&page_size=25${campaign ? `&campaign_id=${campaign}` : ''}`), [tab.key, page, campaign], 15_000);
  const [act, setAct] = useState<{ m: any; kind: 'reconcile' | 'retry' }>();
  return (
    <>
      <header className="page-head">
        <h1>Needs attention</h1>
      </header>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === tab.key} className={t.key === tab.key ? 'is-current' : ''} onClick={() => { setTab(t); setPage(1); }}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="muted">{tab.help}</p>
      <Notice kind="error">{error}</Notice>
      <MessageTable
        items={data?.items ?? []}
        actions={(m) =>
          can('messages.retry') ? (
            m.status === 'UNKNOWN' ? (
              <button className="btn btn-quiet" onClick={() => setAct({ m, kind: 'reconcile' })}>
                Reconcile
              </button>
            ) : m.status === 'FAILED' ? (
              <button className="btn btn-quiet" onClick={() => setAct({ m, kind: 'retry' })}>
                Retry once
              </button>
            ) : null
          ) : null
        }
      />
      {data && <Pager page={page} pageSize={25} total={data.total} onPage={setPage} />}
      {data && data.total > 0 && <p className="muted small">{n(data.total)} in this list.</p>}
      {act?.kind === 'reconcile' && <Reconcile m={act.m} onClose={() => { setAct(undefined); void reload(); }} />}
      {act?.kind === 'retry' && <Retry m={act.m} onClose={() => { setAct(undefined); void reload(); }} />}
    </>
  );
}

function Reconcile({ m, onClose }: { m: any; onClose: () => void }) {
  const [decision, setDecision] = useState('');
  const [note, setNote] = useState('');
  const a = useAction();
  const options = [
    { v: 'CONFIRMED_SENT', label: 'It was sent', help: 'e.g. it is in the phone’s Sent folder, or the recipient confirmed. Counted as submitted (inferred), never as delivered.' },
    { v: 'CONFIRMED_NOT_SENT', label: 'It was not sent', help: 'e.g. the Sent folder on the phone does not contain it. It goes back in the queue.' },
    { v: 'RESEND', label: 'Not sure, send again', help: 'Accept that the recipient might get it twice.' },
    { v: 'ABANDON', label: 'Leave it', help: 'Do not send again. Recorded as failed with unknown outcome.' },
  ];
  return (
    <Modal title={`Reconcile message to ${m.phone_e164}`} onClose={onClose}>
      <p>
        Error <code>{m.last_error_code}</code>. Check the gateway phone’s Sent messages folder for this number around the time it was confirmed for sending.
      </p>
      <fieldset>
        {options.map((o) => (
          <label key={o.v} className="check stacked">
            <input type="radio" name="decision" checked={decision === o.v} onChange={() => setDecision(o.v)} />
            <span>
              <strong>{o.label}</strong>
              <span className="hint">{o.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        How you established this (audit log)
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Checked Sent folder on gateway phone" />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={!decision || note.trim().length < 5 || a.busy} onClick={() => void a.run(async () => { await post(`/messages/${m.id}/reconcile`, { decision, note }); onClose(); })}>
          Record decision
        </button>
      </div>
    </Modal>
  );
}

function Retry({ m, onClose }: { m: any; onClose: () => void }) {
  const [note, setNote] = useState('');
  const permanent = ['INVALID_DESTINATION', 'DELIVERY_FAILURE'].includes(m.last_error_category);
  const [force, setForce] = useState(false);
  const a = useAction();
  return (
    <Modal title={`Retry message to ${m.phone_e164}`} onClose={onClose}>
      <p>
        Last error <code>{m.last_error_code}</code> ({m.last_error_category?.toLowerCase().replace(/_/g, ' ')}). The message gets exactly one more attempt.
      </p>
      {permanent && (
        <label className="check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          {m.last_error_category === 'DELIVERY_FAILURE' ? 'The network said this was undeliverable. Send a new SMS anyway.' : 'This number was rejected. Try anyway.'}
        </label>
      )}
      <label>
        Reason
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Signal restored at the office" />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={note.trim().length < 3 || (permanent && !force) || a.busy} onClick={() => void a.run(async () => { await post(`/messages/${m.id}/retry`, { note, force }); onClose(); })}>
          Retry once
        </button>
      </div>
    </Modal>
  );
}
