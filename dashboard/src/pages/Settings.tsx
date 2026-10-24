import { useEffect, useState } from 'react';
import { get, post, put } from '../api';
import { useAuth } from '../auth';
import { Notice, useAction, useLoad, when } from '../util';

export function Settings() {
  const { can } = useAuth();
  const { data: s, reload, error } = useLoad(() => get('/settings'), []);
  const editable = can('settings.write');
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <>
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <KillSwitch k={s.kill_switch} editable={editable} onChange={reload} />
      <div className="grid-2">
        <section className="panel">
          <h2>Sending limits</h2>
          <NumberSetting k="daily_segment_budget" label="Daily segment budget (all phones together)" value={s.daily_segment_budget} hint="Sending stops for the day when this many SMS segments have been submitted. Protects against unexpected airtime costs." editable={editable} />
          <NumberSetting k="max_campaign_recipients" label="Largest allowed campaign" value={s.max_campaign_recipients} editable={editable} />
          <NumberSetting k="lease_seconds" label="Seconds a phone may hold a message before it returns to the queue" value={s.lease_seconds} editable={editable} />
          <NumberSetting k="delivery_report_timeout_hours" label="Hours to wait for a delivery report" value={s.delivery_report_timeout_hours} hint="After this, the message is shown as submitted with no report." editable={editable} />
          <NumberSetting k="gateway_offline_minutes" label="Alert when a phone is silent for (minutes)" value={s.gateway_offline_minutes} editable={editable} />
          <JsonSetting k="retry_policy" label="Automatic retry backoff" value={s.retry_policy} editable={editable} fields={[['base_seconds', 'First retry after (seconds)'], ['max_seconds', 'Longest wait (seconds)']]} />
        </section>
        <section className="panel">
          <h2>Safety</h2>
          <ListSetting k="test_numbers" label="Authorised test numbers" value={s.test_numbers} hint="Test messages can only go to these numbers. Add your own phone." editable={editable} />
          <ListSetting k="opt_out_keywords" label="Opt-out reply words" value={s.opt_out_keywords} hint="A reply consisting of (or starting with) one of these words opts the sender out. Other replies are never stored." editable={editable} />
          <BoolSetting k="require_test_before_approval" label="A test message must be submitted before a campaign can be approved" value={s.require_test_before_approval} editable={editable} />
          <BoolSetting k="require_separate_approver" label="A different administrator must approve each campaign" value={s.require_separate_approver} editable={editable} />
          <TextSetting k="default_country" label="Default country for numbers without a country code" value={s.default_country} hint="Two-letter code, SZ for Eswatini (+268)." editable={editable} />
        </section>
      </div>
      <Retention r={s.retention} editable={editable} />
    </>
  );
}

function KillSwitch({ k, editable, onChange }: { k: any; editable: boolean; onChange: () => void }) {
  const [reason, setReason] = useState('');
  const a = useAction();
  return (
    <section className={`panel killswitch ${k.enabled ? 'is-on' : ''}`}>
      <div>
        <h2>Kill switch</h2>
        <p>
          {k.enabled
            ? `On since ${when(k.changed_at)}: ${k.reason}. No phone is given any new message; messages already with a phone are handed back.`
            : 'Off. Turning it on stops every phone from sending new messages within seconds, for every campaign.'}
        </p>
      </div>
      {editable && (
        <div className="kill-form">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={k.enabled ? 'Why it is safe to resume' : 'Why you are stopping all sending'} aria-label="Reason" />
          <button
            className={`btn ${k.enabled ? 'btn-primary' : 'btn-danger'}`}
            disabled={reason.trim().length < 3 || a.busy}
            onClick={() => void a.run(async () => { await post('/kill-switch', { enabled: !k.enabled, reason }); setReason(''); onChange(); })}
          >
            {k.enabled ? 'Turn off and allow sending' : 'Stop all sending'}
          </button>
        </div>
      )}
      <Notice kind="error">{a.error}</Notice>
    </section>
  );
}

function useSave(k: string) {
  const a = useAction();
  const save = (value: unknown) => a.run(() => put(`/settings/${k}`, { value }), 'Saved');
  return { ...a, save };
}

function NumberSetting({ k, label, value, hint, editable }: { k: string; label: string; value: number; hint?: string; editable: boolean }) {
  const [v, setV] = useState(String(value));
  const s = useSave(k);
  return (
    <div className="setting">
      <label>
        {label}
        <div className="row">
          <input type="number" value={v} onChange={(e) => setV(e.target.value)} disabled={!editable} />
          {editable && Number(v) !== value && (
            <button className="btn btn-quiet" disabled={s.busy} onClick={() => void s.save(Number(v))}>
              Save
            </button>
          )}
        </div>
        {hint && <span className="hint">{hint}</span>}
      </label>
      <Notice kind="error">{s.error}</Notice>
      <Notice kind="ok">{s.ok}</Notice>
    </div>
  );
}

function TextSetting({ k, label, value, hint, editable }: { k: string; label: string; value: string; hint?: string; editable: boolean }) {
  const [v, setV] = useState(value);
  const s = useSave(k);
  return (
    <div className="setting">
      <label>
        {label}
        <div className="row">
          <input value={v} onChange={(e) => setV(e.target.value.toUpperCase())} disabled={!editable} maxLength={2} className="w-num" />
          {editable && v !== value && (
            <button className="btn btn-quiet" disabled={s.busy} onClick={() => void s.save(v)}>
              Save
            </button>
          )}
        </div>
        {hint && <span className="hint">{hint}</span>}
      </label>
      <Notice kind="error">{s.error}</Notice>
      <Notice kind="ok">{s.ok}</Notice>
    </div>
  );
}

function BoolSetting({ k, label, value, editable }: { k: string; label: string; value: boolean; editable: boolean }) {
  const [v, setV] = useState(value);
  const s = useSave(k);
  return (
    <div className="setting">
      <label className="check">
        <input type="checkbox" checked={v} disabled={!editable || s.busy} onChange={(e) => { setV(e.target.checked); void s.save(e.target.checked); }} />
        {label}
      </label>
      <Notice kind="error">{s.error}</Notice>
    </div>
  );
}

function ListSetting({ k, label, value, hint, editable }: { k: string; label: string; value: string[]; hint?: string; editable: boolean }) {
  const [v, setV] = useState(value.join('\n'));
  const s = useSave(k);
  useEffect(() => setV(value.join('\n')), [value]);
  const list = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  return (
    <div className="setting">
      <label>
        {label}
        <textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} disabled={!editable} />
        {hint && <span className="hint">{hint} One per line.</span>}
      </label>
      {editable && list.join('|') !== value.join('|') && (
        <button className="btn btn-quiet" disabled={s.busy} onClick={() => void s.save(list).then((ok) => ok && setV(list.join('\n')))}>
          Save
        </button>
      )}
      <Notice kind="error">{s.error}</Notice>
      <Notice kind="ok">{s.ok}</Notice>
    </div>
  );
}

function JsonSetting({ k, label, value, fields, editable }: { k: string; label: string; value: Record<string, number>; fields: [string, string][]; editable: boolean }) {
  const [v, setV] = useState(value);
  const s = useSave(k);
  const changed = fields.some(([f]) => v[f] !== value[f]);
  return (
    <fieldset className="setting">
      <legend>{label}</legend>
      <div className="row wrap">
        {fields.map(([f, l]) => (
          <label key={f}>
            {l}
            <input type="number" value={v[f]} disabled={!editable} onChange={(e) => setV({ ...v, [f]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      {editable && changed && (
        <button className="btn btn-quiet" disabled={s.busy} onClick={() => void s.save(v)}>
          Save
        </button>
      )}
      <Notice kind="error">{s.error}</Notice>
      <Notice kind="ok">{s.ok}</Notice>
    </fieldset>
  );
}

function Retention({ r, editable }: { r: any; editable: boolean }) {
  const [preview, setPreview] = useState<any>();
  const a = useAction();
  return (
    <section className="panel">
      <h2>Data retention</h2>
      <p className="muted">Old data is deleted automatically once a day. Opt-outs are never deleted.</p>
      <JsonSetting
        k="retention"
        label="Keep for (days)"
        value={r}
        editable={editable}
        fields={[
          ['messages_days', 'Finished messages'],
          ['health_days', 'Phone health history'],
          ['audit_days', 'Audit log'],
          ['sessions_days', 'Old sign-in sessions'],
        ]}
      />
      {editable && (
        <div className="row">
          <button className="btn btn-quiet" disabled={a.busy} onClick={() => void a.run(async () => setPreview(await post('/maintenance/retention', { dry_run: true })))}>
            Show what would be deleted now
          </button>
          {preview && (
            <span className="small">
              {Object.entries(preview.deleted)
                .map(([k2, v]) => `${v} ${k2.replace(/_/g, ' ')}`)
                .join(', ')}
            </span>
          )}
        </div>
      )}
      <Notice kind="error">{a.error}</Notice>
    </section>
  );
}
