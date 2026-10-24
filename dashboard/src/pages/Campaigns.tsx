import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, download, get, patch, post, uuid } from '../api';
import { useAuth } from '../auth';
import { Pipeline, toCounts } from '../components/Pipeline';
import { duration, Modal, n, Notice, Pager, StatusTag, useAction, useLoad, when } from '../util';

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export function Campaigns() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useLoad(() => get(`/campaigns?page=${page}&page_size=25${status ? `&status=${status}` : ''}`), [page, status], 10_000);
  return (
    <>
      <header className="page-head">
        <h1>Campaigns</h1>
        {can('campaigns.write') && (
          <Link className="btn btn-primary" to="/campaigns/new">
            New campaign
          </Link>
        )}
      </header>
      <div className="toolbar">
        <label className="inline">
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Notice kind="error">{error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th className="num">Recipients</th>
            <th>Created</th>
            <th>Started</th>
            <th>Finished</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((c: any) => (
            <tr key={c.id}>
              <td>
                <Link to={`/campaigns/${c.id}`}>{c.name}</Link>
                <div className="muted small">by {c.created_by_name}</div>
              </td>
              <td>
                <StatusTag s={c.status} />
              </td>
              <td className="num">{c.recipients ? n(c.recipients) : '–'}</td>
              <td>{when(c.created_at)}</td>
              <td>{when(c.started_at)}</td>
              <td>{when(c.completed_at)}</td>
            </tr>
          ))}
          {data && data.items.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No campaigns yet. Create one to message a contact group.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data && <Pager page={page} pageSize={25} total={data.total} onPage={setPage} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Message composer with live segment count
// ---------------------------------------------------------------------------
const FIELDS = [
  { f: 'first_name', label: 'First name', example: '{{first_name|Student}}' },
  { f: 'last_name', label: 'Last name', example: '{{last_name}}' },
  { f: 'full_name', label: 'Full name', example: '{{full_name}}' },
  { f: 'reference_no', label: 'Reference no.', example: '{{reference_no}}' },
];

export function Composer({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [info, setInfo] = useState<any>();
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setInfo(await post('/tools/sms-analyze', { text: value }));
      } catch {
        /* ignore while typing */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [value]);
  const insert = (token: string) => {
    const el = ref.current;
    if (!el) return onChange(value + token);
    const s = el.selectionStart;
    const next = value.slice(0, s) + token + value.slice(el.selectionEnd);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + token.length;
    });
  };
  return (
    <div className="composer">
      <div className="field-buttons" aria-label="Insert personalisation">
        {FIELDS.map((x) => (
          <button type="button" key={x.f} className="chip" onClick={() => insert(x.example)}>
            + {x.label}
          </button>
        ))}
      </div>
      <textarea ref={ref} rows={6} value={value} onChange={(e) => onChange(e.target.value)} maxLength={1600} aria-label="Message text" />
      {info && (
        <div className={`seginfo ${info.encoding === 'UCS2' ? 'seginfo-warn' : ''}`}>
          <span>
            <strong>{info.segments}</strong> SMS segment{info.segments === 1 ? '' : 's'} per recipient (template text; personalised messages may differ)
          </span>
          <span>
            {info.encoding === 'GSM7' ? 'Standard characters' : 'Unicode'} · {info.characters} characters · {info.remainingInLast} left in this segment
          </span>
          {info.nonGsmCharacters.length > 0 && (
            <span>
              These characters switch the message to Unicode (70 per SMS instead of 160): <code>{info.nonGsmCharacters.join(' ')}</code>
            </span>
          )}
          {info.template.issues.map((i: any) => (
            <span key={i.field + i.problem} className="bad">
              {i.problem === 'UNKNOWN_FIELD' ? `{{${i.field}}} is not a field you can use` : 'Braces {{ }} are not balanced'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New campaign wizard
// ---------------------------------------------------------------------------
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CampaignNew() {
  const nav = useNavigate();
  const { data: groups } = useLoad(() => get('/groups'), []);
  const [step, setStep] = useState(1);
  const key = useMemo(() => uuid(), []);
  const [f, setF] = useState({
    name: '',
    group_ids: [] as string[],
    consent_purpose: 'general',
    body_template: 'Sawubona {{first_name|Student}}, ',
    start_mode: 'now' as 'now' | 'later',
    start_at: '',
    window_start: '08:00',
    window_end: '18:00',
    days_of_week: [1, 2, 3, 4, 5],
    cooldown: false,
    cooldown_every: 100,
    cooldown_seconds: 600,
    max_recipients: 10000,
    budget_segments: '' as string,
    cost_per_segment: '0.45',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const a = useAction();
  const selected = (groups?.items ?? []).filter((g: any) => f.group_ids.includes(g.id));
  const steps = ['Recipients', 'Message', 'Schedule and limits'];

  const create = () =>
    a.run(async () => {
      const body = {
        name: f.name,
        body_template: f.body_template,
        group_ids: f.group_ids,
        consent_purpose: f.consent_purpose || 'general',
        max_recipients: Number(f.max_recipients),
        budget_segments: f.budget_segments ? Number(f.budget_segments) : null,
        cost_per_segment: Number(f.cost_per_segment || 0),
        schedule: {
          start_at: f.start_mode === 'later' && f.start_at ? new Date(f.start_at).toISOString() : null,
          timezone: 'Africa/Mbabane',
          window_start: f.window_start,
          window_end: f.window_end,
          days_of_week: f.days_of_week,
          cooldown_every: f.cooldown ? Number(f.cooldown_every) : null,
          cooldown_seconds: f.cooldown ? Number(f.cooldown_seconds) : null,
        },
      };
      const c = await post('/campaigns', body, { 'idempotency-key': key });
      nav(`/campaigns/${c.id}`);
    });

  return (
    <>
      <header className="page-head">
        <h1>New campaign</h1>
      </header>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s} className={i + 1 === step ? 'is-current' : i + 1 < step ? 'is-done' : ''}>
            <button type="button" className="linklike" onClick={() => setStep(i + 1)} disabled={i + 1 > step}>
              {s}
            </button>
          </li>
        ))}
      </ol>
      <div className="panel">
        {step === 1 && (
          <>
            <label>
              Campaign name
              <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Semester 2 exam timetable" maxLength={150} />
            </label>
            <fieldset>
              <legend>Send to these groups</legend>
              {!groups && <p className="muted">Loading groups…</p>}
              {groups?.items.length === 0 && (
                <p>
                  No groups yet. <Link to="/groups">Create a group</Link> and add contacts first.
                </p>
              )}
              <div className="checklist">
                {groups?.items.map((g: any) => (
                  <label key={g.id} className="check">
                    <input
                      type="checkbox"
                      checked={f.group_ids.includes(g.id)}
                      onChange={(e) => set({ group_ids: e.target.checked ? [...f.group_ids, g.id] : f.group_ids.filter((x) => x !== g.id) })}
                    />
                    <span>
                      {g.name} <span className="muted">({n(g.valid_count)} valid of {n(g.member_count)})</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              Consent purpose
              <input value={f.consent_purpose} onChange={(e) => set({ consent_purpose: e.target.value })} />
              <span className="hint">Only contacts who consented to this purpose (or to "general") receive it.</span>
            </label>
            <div className="actions">
              <button className="btn btn-primary" disabled={!f.name.trim() || f.group_ids.length === 0} onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <p className="muted">
              Sending to {selected.map((g: any) => g.name).join(', ')}. Use fallbacks like <code>{'{{first_name|Student}}'}</code> for contacts without a name.
              Include how to opt out, e.g. "Reply STOP to opt out".
            </p>
            <Composer value={f.body_template} onChange={(v) => set({ body_template: v })} />
            <div className="actions">
              <button className="btn btn-quiet" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="btn btn-primary" disabled={!f.body_template.trim()} onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <fieldset>
              <legend>When to start</legend>
              <label className="check">
                <input type="radio" checked={f.start_mode === 'now'} onChange={() => set({ start_mode: 'now' })} /> When I press Start after approval
              </label>
              <label className="check">
                <input type="radio" checked={f.start_mode === 'later'} onChange={() => set({ start_mode: 'later' })} /> Automatically at
                <input type="datetime-local" value={f.start_at} onChange={(e) => set({ start_at: e.target.value, start_mode: 'later' })} />
              </label>
            </fieldset>
            <fieldset>
              <legend>Only send between (Eswatini time)</legend>
              <div className="row">
                <input type="time" value={f.window_start} onChange={(e) => set({ window_start: e.target.value })} aria-label="Window start" />
                <span>and</span>
                <input type="time" value={f.window_end} onChange={(e) => set({ window_end: e.target.value })} aria-label="Window end" />
              </div>
              <div className="row">
                {DAYS.map((d, i) => (
                  <label key={d} className="check">
                    <input
                      type="checkbox"
                      checked={f.days_of_week.includes(i + 1)}
                      onChange={(e) => set({ days_of_week: e.target.checked ? [...f.days_of_week, i + 1].sort() : f.days_of_week.filter((x) => x !== i + 1) })}
                    />
                    {d}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Rest periods</legend>
              <label className="check">
                <input type="checkbox" checked={f.cooldown} onChange={(e) => set({ cooldown: e.target.checked })} />
                After every
                <input type="number" min={1} className="w-num" value={f.cooldown_every} onChange={(e) => set({ cooldown_every: Number(e.target.value) })} />
                messages, pause for
                <input type="number" min={1} className="w-num" value={f.cooldown_seconds} onChange={(e) => set({ cooldown_seconds: Number(e.target.value) })} />
                seconds
              </label>
            </fieldset>
            <fieldset>
              <legend>Limits and cost</legend>
              <div className="row wrap">
                <label>
                  Maximum recipients
                  <input type="number" min={1} value={f.max_recipients} onChange={(e) => set({ max_recipients: Number(e.target.value) })} />
                </label>
                <label>
                  Segment budget (optional)
                  <input type="number" min={1} value={f.budget_segments} onChange={(e) => set({ budget_segments: e.target.value })} placeholder="no limit" />
                </label>
                <label>
                  Cost per segment (SZL)
                  <input type="number" min={0} step="0.01" value={f.cost_per_segment} onChange={(e) => set({ cost_per_segment: e.target.value })} />
                </label>
              </div>
              <span className="hint">The campaign pauses itself when the segment budget is used up. A daily budget for all campaigns is set in Settings.</span>
            </fieldset>
            <Notice kind="error">{a.error}</Notice>
            <div className="actions">
              <button className="btn btn-quiet" onClick={() => setStep(2)}>
                Back
              </button>
              <button className="btn btn-primary" disabled={a.busy} onClick={() => void create()}>
                Save draft and check recipients
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
export function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: c, reload, error } = useLoad(() => get(`/campaigns/${id}`), [id], 8000);
  const live = c && ['RUNNING', 'PAUSED', 'APPROVED', 'SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(c.status);
  const { data: prog, reload: reloadProg } = useLoad(() => (live ? get(`/campaigns/${id}/progress`) : Promise.resolve(undefined)), [id, live], 5000);
  const [modal, setModal] = useState<'' | 'approve' | 'pause' | 'cancel' | 'test' | 'edit' | 'return'>('');
  const a = useAction();
  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    if (await a.run(fn, okMsg)) {
      setModal('');
      await reload();
      await reloadProg();
    }
  };
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!c) return <p className="muted">Loading…</p>;
  const draft = c.status === 'DRAFT';
  return (
    <>
      <header className="page-head">
        <div>
          <p className="crumb">
            <Link to="/campaigns">Campaigns</Link>
          </p>
          <h1>{c.name}</h1>
          <div className="row">
            <StatusTag s={c.status} />
            {c.pause_reason && <span className="muted">{c.pause_reason}</span>}
          </div>
        </div>
        <div className="head-actions">
          {draft && can('campaigns.write') && (
            <>
              <button className="btn btn-quiet" onClick={() => setModal('edit')}>
                Edit
              </button>
              <button className="btn btn-quiet" onClick={() => setModal('test')}>
                Send test
              </button>
              <button className="btn btn-primary" disabled={a.busy} onClick={() => void act(() => post(`/campaigns/${id}/submit`), 'Submitted for approval.')}>
                Submit for approval
              </button>
            </>
          )}
          {c.status === 'PENDING_APPROVAL' && (
            <>
              {can('campaigns.write') && (
                <button className="btn btn-quiet" onClick={() => setModal('test')}>
                  Send test
                </button>
              )}
              {can('campaigns.approve') && (
                <>
                  <button className="btn btn-quiet" onClick={() => setModal('return')}>
                    Return to draft
                  </button>
                  <button className="btn btn-primary" onClick={() => setModal('approve')}>
                    Approve and queue
                  </button>
                </>
              )}
            </>
          )}
          {['APPROVED', 'SCHEDULED'].includes(c.status) && can('campaigns.operate') && (
            <button className="btn btn-primary" disabled={a.busy} onClick={() => void act(() => post(`/campaigns/${id}/start`), 'Sending started.')}>
              Start sending now
            </button>
          )}
          {c.status === 'RUNNING' && can('campaigns.operate') && (
            <button className="btn btn-quiet" onClick={() => setModal('pause')}>
              Pause
            </button>
          )}
          {c.status === 'PAUSED' && can('campaigns.operate') && (
            <button className="btn btn-primary" disabled={a.busy} onClick={() => void act(() => post(`/campaigns/${id}/resume`), 'Resumed.')}>
              Resume
            </button>
          )}
          {['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'].includes(c.status) && can('campaigns.operate') && (
            <button className="btn btn-danger" onClick={() => setModal('cancel')}>
              Cancel campaign
            </button>
          )}
          {draft && can('campaigns.write') && (
            <button
              className="btn btn-quiet"
              onClick={() => void a.run(async () => {
                await del(`/campaigns/${id}`);
                nav('/campaigns');
              })}
            >
              Delete draft
            </button>
          )}
        </div>
      </header>
      <Notice kind="error">{a.error}</Notice>
      <Notice kind="ok">{a.ok}</Notice>

      {prog && (
        <section className="panel">
          <h2>Progress</h2>
          <Pipeline counts={toCounts(prog)} total={prog.total} />
          <div className="live-meta">
            <span>
              {n(prog.submitted)} of {n(prog.total)} submitted · {n(prog.segments_submitted)} segments
            </span>
            <span>{prog.rate_per_minute > 0 ? `${prog.rate_per_minute} per minute over the last ${prog.rate_window_minutes} min` : 'No submissions in the last 15 minutes'}</span>
            {prog.pending > 0 && <span title={prog.eta.note}>Estimated time left: {duration(prog.eta.minutes)}</span>}
          </div>
          {prog.eta.minutes != null && prog.pending > 0 && <p className="muted small">{prog.eta.note}</p>}
          {prog.unknown > 0 && (
            <Notice kind="warn">
              {n(prog.unknown)} message(s) have an unknown outcome. <Link to={`/messages?campaign_id=${id}`}>Reconcile them</Link> before any resend.
            </Notice>
          )}
        </section>
      )}

      {(draft || c.status === 'PENDING_APPROVAL') && <PreviewPanel id={id!} key={c.updated_at} />}

      <div className="grid-2">
        <section className="panel">
          <h2>Message</h2>
          <pre className="sms">{c.body_template}</pre>
          <p className="muted small">
            {c.template_analysis.segments} segment(s), {c.template_analysis.encoding === 'GSM7' ? 'standard characters' : 'Unicode'} · consent purpose “{c.consent_purpose}”
          </p>
        </section>
        <section className="panel">
          <h2>Schedule and limits</h2>
          <dl className="facts">
            <div>
              <dt>Start</dt>
              <dd>{c.schedule.start_at ? when(c.schedule.start_at) : 'When started'}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>
                {c.schedule.window_start}–{c.schedule.window_end}, {c.schedule.days_of_week.map((d: number) => DAYS[d - 1]).join(' ')}
              </dd>
            </div>
            <div>
              <dt>Rest</dt>
              <dd>{c.schedule.cooldown_every ? `${c.schedule.cooldown_seconds}s after every ${c.schedule.cooldown_every}` : 'None'}</dd>
            </div>
            <div>
              <dt>Max recipients</dt>
              <dd>{n(c.max_recipients)}</dd>
            </div>
            <div>
              <dt>Segment budget</dt>
              <dd>{c.budget_segments ? n(c.budget_segments) : 'No limit'}</dd>
            </div>
            <div>
              <dt>Auto-pause</dt>
              <dd>
                {Math.round(c.failure_pause_ratio * 100)}% failures in last {c.failure_window_size}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {live && <ReportPanel id={id!} status={c.status} />}
      {live && <CampaignMessages id={id!} />}

      {modal === 'approve' && (
        <ApproveModal
          name={c.name}
          busy={a.busy}
          error={a.error}
          onClose={() => setModal('')}
          onApprove={(confirm) => void act(() => post(`/campaigns/${id}/approve`, { confirm_name: confirm }), 'Approved. Messages are queued.')}
        />
      )}
      {(modal === 'pause' || modal === 'cancel' || modal === 'return') && (
        <ReasonModal
          title={modal === 'pause' ? 'Pause campaign' : modal === 'cancel' ? 'Cancel campaign' : 'Return to draft'}
          help={
            modal === 'cancel'
              ? 'Every message not yet handed to a phone is cancelled. Messages the phone has already started sending cannot be recalled.'
              : modal === 'pause'
                ? 'No new messages are handed to the phone until you resume. Messages already with the phone are not sent.'
                : 'The campaign goes back to draft so it can be edited.'
          }
          action={modal === 'pause' ? 'Pause' : modal === 'cancel' ? 'Cancel campaign' : 'Return to draft'}
          danger={modal === 'cancel'}
          busy={a.busy}
          error={a.error}
          onClose={() => setModal('')}
          onSubmit={(reason) =>
            void act(() =>
              modal === 'return' ? post(`/campaigns/${id}/return-to-draft`, { note: reason }) : post(`/campaigns/${id}/${modal}`, { reason }),
            )
          }
        />
      )}
      {modal === 'test' && <TestModal id={id!} onClose={() => { setModal(''); void reload(); }} />}
      {modal === 'edit' && <EditModal c={c} onClose={() => { setModal(''); void reload(); }} />}
    </>
  );
}

function PreviewPanel({ id }: { id: string }) {
  const { data: p, error, loading } = useLoad(() => post(`/campaigns/${id}/preview`, { sample_size: 3 }), [id]);
  return (
    <section className="panel">
      <h2>Recipient checks</h2>
      {loading && <p className="muted">Checking every recipient for a valid number, opt-out, consent and duplicates…</p>}
      <Notice kind="error">{error}</Notice>
      {p && (
        <>
          <dl className="facts">
            <div>
              <dt>Will receive</dt>
              <dd className="big">{n(p.summary.included)}</dd>
            </div>
            <div>
              <dt>Invalid number</dt>
              <dd>{n(p.summary.excluded.INVALID_NUMBER)}</dd>
            </div>
            <div>
              <dt>Opted out</dt>
              <dd>{n(p.summary.excluded.SUPPRESSED)}</dd>
            </div>
            <div>
              <dt>No consent</dt>
              <dd>{n(p.summary.excluded.NO_CONSENT)}</dd>
            </div>
            <div>
              <dt>Same number twice</dt>
              <dd>{n(p.summary.excluded.DUPLICATE_NUMBER)}</dd>
            </div>
            <div>
              <dt>Over the limit</dt>
              <dd>{n(p.summary.excluded.OVER_LIMIT)}</dd>
            </div>
            <div>
              <dt>SMS segments</dt>
              <dd>{n(p.summary.segmentsTotal)}</dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>
                {p.estimated_cost.currency} {p.estimated_cost.amount.toFixed(2)}
              </dd>
            </div>
          </dl>
          {p.warnings.map((w: string) => (
            <Notice key={w} kind="warn">
              {w}
            </Notice>
          ))}
          {p.samples.length > 0 && (
            <>
              <h3>How it will read</h3>
              <div className="samples">
                {p.samples.map((s: any) => (
                  <figure key={s.contact_id} className="bubble">
                    <figcaption>
                      {s.phone} · {s.segments} segment{s.segments === 1 ? '' : 's'}
                    </figcaption>
                    <p>{s.text}</p>
                  </figure>
                ))}
              </div>
            </>
          )}
          <p className="muted small">{p.estimated_cost.note}</p>
        </>
      )}
    </section>
  );
}

function ApproveModal({ name, busy, error, onClose, onApprove }: { name: string; busy: boolean; error?: string; onClose: () => void; onApprove: (n: string) => void }) {
  const [typed, setTyped] = useState('');
  return (
    <Modal title="Approve and queue" onClose={onClose}>
      <p>
        Approving runs every recipient check again, freezes the recipient list and queues one message per recipient. Sending begins when the campaign is started (or at its
        scheduled time).
      </p>
      <label>
        Type the campaign name to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} autoFocus />
      </label>
      <Notice kind="error">{error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={busy || typed.trim() !== name.trim()} onClick={() => onApprove(typed)}>
          Approve and queue
        </button>
      </div>
    </Modal>
  );
}

export function ReasonModal(props: { title: string; help: string; action: string; danger?: boolean; busy: boolean; error?: string; onClose: () => void; onSubmit: (r: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p>{props.help}</p>
      <label>
        Reason (recorded in the audit log)
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </label>
      <Notice kind="error">{props.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={props.onClose}>
          Back
        </button>
        <button className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} disabled={props.busy || reason.trim().length < 3} onClick={() => props.onSubmit(reason.trim())}>
          {props.action}
        </button>
      </div>
    </Modal>
  );
}

function TestModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: settings } = useLoad(() => get('/settings'), []);
  const [phone, setPhone] = useState('');
  const a = useAction();
  const [sent, setSent] = useState<any>();
  const nums: string[] = settings?.test_numbers ?? [];
  const { data: msg } = useLoad(() => (sent ? get(`/messages/${sent.message_id}`) : Promise.resolve(undefined)), [sent?.message_id], 3000);
  return (
    <Modal title="Send a test message" onClose={onClose}>
      {nums.length === 0 ? (
        <Notice kind="warn">
          No authorised test numbers yet. Add your own number under <Link to="/settings">Settings</Link> first.
        </Notice>
      ) : (
        <>
          <p>The personalised text is sent through the phone to one authorised test number, before any campaign message.</p>
          <label>
            Test number
            <select value={phone} onChange={(e) => setPhone(e.target.value)}>
              <option value="">Choose…</option>
              {nums.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <Notice kind="error">{a.error}</Notice>
          {sent && (
            <div className="panel inset">
              <pre className="sms">{sent.text}</pre>
              <p>
                Status: {msg ? <StatusTag s={msg.status} /> : '…'} {msg?.status === 'QUEUED' && <span className="muted small">waiting for a phone to pick it up</span>}
              </p>
            </div>
          )}
          <div className="actions">
            <button className="btn btn-quiet" onClick={onClose}>
              Done
            </button>
            <button className="btn btn-primary" disabled={!phone || a.busy} onClick={() => void a.run(async () => setSent(await post(`/campaigns/${id}/test`, { phone })))}>
              Send test
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function EditModal({ c, onClose }: { c: any; onClose: () => void }) {
  const [name, setName] = useState(c.name);
  const [body, setBody] = useState(c.body_template);
  const [budget, setBudget] = useState(c.budget_segments ?? '');
  const a = useAction();
  return (
    <Modal title="Edit draft" onClose={onClose} wide>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <Composer value={body} onChange={setBody} />
      <label>
        Segment budget
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="no limit" />
      </label>
      <p className="muted small">Changing the text clears the earlier test message; send a new test before approval.</p>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button
          className="btn btn-primary"
          disabled={a.busy}
          onClick={() => void a.run(async () => {
            await patch(`/campaigns/${c.id}`, { name, body_template: body, budget_segments: budget === '' ? null : Number(budget) });
            onClose();
          })}
        >
          Save changes
        </button>
      </div>
    </Modal>
  );
}

function ReportPanel({ id, status }: { id: string; status: string }) {
  const { can } = useAuth();
  const { data: r, reload } = useLoad(() => get(`/campaigns/${id}/report`), [id], 15_000);
  const a = useAction();
  const [retry, setRetry] = useState(false);
  if (!r) return null;
  const t = r.totals;
  const rows: [string, number | string, string?][] = [
    ['Intended recipients', t.intended_recipients],
    ['Excluded before sending', Object.values(t.excluded_by_reason as Record<string, number>).reduce((x, y) => x + y, 0), Object.entries(t.excluded_by_reason).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(', ')],
    ['Submitted to the network', t.submitted, r.definitions.submitted],
    ['Confirmed delivered', t.confirmed_delivered, r.definitions.confirmed_delivered],
    ['Submitted, awaiting report', t.submitted_awaiting_report],
    ['Submitted, no report received', t.submitted_no_report, r.definitions.submitted_no_report],
    ['Reconciled as sent (inferred)', t.reconciled_as_sent, r.definitions.reconciled_as_sent],
    ['Failed', t.confirmed_failed],
    ['Unknown outcome', t.unknown, r.definitions.unknown],
    ['Cancelled', t.cancelled],
    ['Still to send', t.pending],
    ['Segments estimated / submitted', `${n(t.segments_estimated)} / ${n(t.segments_submitted)}`],
    ['Submission attempts', t.submission_attempts],
    ['Automatic / manual retries', `${n(t.automatic_retries)} / ${n(t.manual_retries)}`],
    ['Cost (estimate)', `${r.cost.currency} ${r.cost.based_on_submitted.toFixed(2)} of ${r.cost.estimated.toFixed(2)} estimated`, r.cost.note],
  ];
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Report</h2>
        <div className="row">
          <Link className="btn btn-quiet" to={`/campaigns/${id}/print`} target="_blank">
            Printable report
          </Link>
          {can('reports.export') && (
            <button className="btn btn-quiet" onClick={() => void a.run(() => download(`/campaigns/${id}/report.csv`, 'campaign.csv'))}>
              Download CSV
            </button>
          )}
          {can('messages.retry') && status !== 'CANCELLED' && (
            <button className="btn btn-quiet" onClick={() => setRetry(true)}>
              Retry dead letters
            </button>
          )}
        </div>
      </header>
      <Notice kind="error">{a.error}</Notice>
      <Notice kind="ok">{a.ok}</Notice>
      <table className="table compact">
        <tbody>
          {rows.map(([k, v, help]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td className="num">{typeof v === 'number' ? n(v) : v}</td>
              <td className="muted small">{help}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.top_errors.length > 0 && (
        <>
          <h3>Most common problems</h3>
          <ul className="plain">
            {r.top_errors.map((e: any) => (
              <li key={`${e.code}${e.category}`}>
                <code>{e.code ?? 'no code'}</code> {e.category?.toLowerCase().replace(/_/g, ' ')}: {n(e.n)}
              </li>
            ))}
          </ul>
        </>
      )}
      {retry && (
        <ReasonModal
          title="Retry dead letters"
          help="Messages that failed with a temporary error and used up their automatic retries get one more attempt. Permanent rejections and opted-out recipients are never retried."
          action="Retry"
          busy={a.busy}
          error={a.error}
          onClose={() => setRetry(false)}
          onSubmit={(note) =>
            void a.run(async () => {
              const res = await post(`/campaigns/${id}/retry-failed`, { note });
              setRetry(false);
              await reload();
              a.setOk(`${res.requeued} message(s) queued for one more attempt.`);
            })
          }
        />
      )}
    </section>
  );
}

function CampaignMessages({ id }: { id: string }) {
  const [status, setStatus] = useState('');
  const [phone, setPhone] = useState('');
  const [page, setPage] = useState(1);
  const { data } = useLoad(
    () => get(`/messages?campaign_id=${id}&page=${page}&page_size=25${status ? `&status=${status}` : ''}${phone ? `&phone=${encodeURIComponent(phone)}` : ''}`),
    [id, page, status, phone],
    10_000,
  );
  return (
    <section className="panel">
      <h2>Recipients</h2>
      <div className="toolbar">
        <label className="inline">
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {['QUEUED', 'LEASED', 'SENDING', 'SUBMITTED', 'DELIVERED', 'FAILED', 'UNKNOWN', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Phone
          <input value={phone} onChange={(e) => { setPhone(e.target.value); setPage(1); }} placeholder="last 4+ digits" />
        </label>
      </div>
      <MessageTable items={data?.items ?? []} />
      {data && <Pager page={page} pageSize={25} total={data.total} onPage={setPage} />}
    </section>
  );
}

export function MessageTable({ items, actions }: { items: any[]; actions?: (m: any) => React.ReactNode }) {
  const [open, setOpen] = useState<string>();
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Status</th>
            <th>Delivery report</th>
            <th className="num">Attempts</th>
            <th>Submitted</th>
            <th>Last error</th>
            {actions && <th />}
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td>
                <button className="linklike" onClick={() => setOpen(m.id)}>
                  {m.phone_e164 ?? 'erased'}
                </button>
                <div className="muted small">
                  {[m.first_name, m.last_name].filter(Boolean).join(' ')}
                  {m.campaign_name && ` · ${m.campaign_name}`}
                  {m.is_test && ' · test'}
                  {m.opted_out && ' · opted out'}
                </div>
              </td>
              <td>
                <StatusTag s={m.status} />
              </td>
              <td className="small">{({ NONE: '–', AWAITING_REPORT: 'waiting', NO_REPORT: 'none received', CONFIRMED: 'confirmed', FAILED: 'failure' } as Record<string, string>)[m.delivery_state] ?? m.delivery_state}</td>
              <td className="num">
                {m.attempt_count}/{m.max_attempts}
              </td>
              <td>{when(m.submitted_at)}</td>
              <td className="small">
                {m.last_error_code && <code>{m.last_error_code}</code>}
                {m.dead_lettered_at && <span className="muted"> retries used up</span>}
              </td>
              {actions && <td className="row-actions">{actions(m)}</td>}
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {open && <MessageHistory id={open} onClose={() => setOpen(undefined)} />}
    </>
  );
}

export function MessageHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: m } = useLoad(() => get(`/messages/${id}`), [id], 5000);
  return (
    <Modal title="Message history" onClose={onClose} wide>
      {!m ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p>
            <StatusTag s={m.status} /> to {m.phone_e164 ?? 'erased number'} {m.campaign_name && <>in “{m.campaign_name}”</>}
          </p>
          <pre className="sms">{m.body}</pre>
          <h3>Attempts</h3>
          <table className="table compact">
            <thead>
              <tr>
                <th>#</th>
                <th>Phone</th>
                <th>Outcome</th>
                <th>Handed to phone</th>
                <th>Confirmed for sending</th>
                <th>Reported</th>
                <th>Parts ok/failed</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {m.attempts.map((x: any) => (
                <tr key={x.id}>
                  <td>{x.attempt_no}</td>
                  <td>{x.gateway_name}</td>
                  <td>{x.outcome.toLowerCase().replace('_', ' ')}</td>
                  <td>{when(x.started_at, true)}</td>
                  <td>{when(x.confirmed_at, true)}</td>
                  <td>{when(x.reported_at, true)}</td>
                  <td>
                    {x.parts_ok}/{x.parts_failed} of {x.parts_total}
                  </td>
                  <td className="small">
                    {x.error_code} {x.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Delivery reports</h3>
          {m.delivery_reports.length === 0 ? (
            <p className="muted">None received. Not every network sends delivery reports.</p>
          ) : (
            <ul className="plain">
              {m.delivery_reports.map((d: any) => (
                <li key={`${d.attempt_id}${d.part_index}`}>
                  Part {d.part_index + 1}: {d.status.toLowerCase()} (TP-Status 0x{Number(d.tp_status).toString(16).padStart(2, '0')}) at {when(d.received_at, true)}
                </li>
              ))}
            </ul>
          )}
          {(m.retries.length > 0 || m.reconciliations.length > 0) && (
            <>
              <h3>Retries and decisions</h3>
              <ul className="plain">
                {m.retries.map((r: any, i: number) => (
                  <li key={`r${i}`}>
                    {when(r.created_at)} {r.kind.toLowerCase().replace('_', ' ')} retry{r.requested_by && ` by ${r.requested_by}`}: {r.reason}
                  </li>
                ))}
                {m.reconciliations.map((r: any, i: number) => (
                  <li key={`c${i}`}>
                    {when(r.decided_at)} {r.decided_by} decided {r.decision.toLowerCase().replace(/_/g, ' ')}: {r.note}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Printable report
// ---------------------------------------------------------------------------
export function CampaignPrint() {
  const { id } = useParams();
  const { data: r } = useLoad(() => get(`/campaigns/${id}/report`), [id]);
  if (!r) return <p className="muted">Loading…</p>;
  const t = r.totals;
  const c = r.campaign;
  return (
    <div className="print">
      <button className="btn btn-primary no-print" onClick={() => window.print()}>
        Print
      </button>
      <h1>Campaign report: {c.name}</h1>
      <p>
        Status {c.status.toLowerCase()} · created {when(c.created_at)} by {c.created_by_name} · approved {when(c.approved_at)}
        {c.approved_by_name && ` by ${c.approved_by_name}`} · started {when(c.started_at)} · finished {when(c.completed_at ?? c.cancelled_at)}
      </p>
      <h2>Message</h2>
      <pre className="sms">{c.body_template}</pre>
      <h2>Results</h2>
      <table className="table compact">
        <tbody>
          {(
            [
              ['Intended recipients', t.intended_recipients],
              ['Included', t.included],
              ...Object.entries(t.excluded_by_reason).map(([k, v]) => [`Excluded: ${k.toLowerCase().replace(/_/g, ' ')}`, v]),
              ['Submitted to the network', t.submitted],
              ['Confirmed delivered (delivery report)', t.confirmed_delivered],
              ['Submitted, no delivery report', t.submitted_no_report + t.submitted_awaiting_report],
              ['Reconciled as sent (inferred, not confirmed)', t.reconciled_as_sent],
              ['Failed', t.confirmed_failed],
              ['Unknown outcome', t.unknown],
              ['Cancelled', t.cancelled],
              ['Still to send', t.pending],
              ['Segments submitted', t.segments_submitted],
              ['Retries (automatic / manual)', `${t.automatic_retries} / ${t.manual_retries}`],
              ['Cost, estimated from configured rate', `${r.cost.currency} ${r.cost.based_on_submitted.toFixed(2)}`],
            ] as [string, any][]
          ).map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td className="num">{typeof v === 'number' ? n(v) : v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Definitions</h2>
      <dl className="defs">
        {Object.entries(r.definitions).map(([k, v]) => (
          <div key={k}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd>{v as string}</dd>
          </div>
        ))}
      </dl>
      <p className="small">Generated {new Date().toLocaleString('en-GB')}. A SIM-based gateway cannot guarantee exactly-once delivery; unknown outcomes are listed, not hidden.</p>
    </div>
  );
}
