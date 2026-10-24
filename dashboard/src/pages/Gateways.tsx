import { useState } from 'react';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';
import { ReasonModal } from './Campaigns';
import { ago, Modal, n, Notice, useAction, useLoad, when } from '../util';

const BARS = [1, 2, 3, 4];

export function Gateways() {
  const { can } = useAuth();
  const { data, reload, error } = useLoad(() => get('/gateways'), [], 10_000);
  const [pairing, setPairing] = useState(false);
  const [modal, setModal] = useState<{ g: any; kind: 'pause' | 'emergency-stop' | 'revoke' | 'resume' | 'settings' | 'health' }>();
  const a = useAction();
  return (
    <>
      <header className="page-head">
        <h1>Phones</h1>
        {can('gateways.manage') && (
          <button className="btn btn-primary" onClick={() => setPairing(true)}>
            Pair a phone
          </button>
        )}
      </header>
      <p className="muted">Each paired Android phone sends through its own SIM. Phones connect to this server; the server never connects to them.</p>
      <Notice kind="error">{error ?? a.error}</Notice>
      {data?.items.length === 0 && <div className="panel empty">No phone is paired yet. Install the app on the phone, then press Pair a phone and scan the code.</div>}
      <div className="phones">
        {data?.items.map((g: any) => {
          const h = g.last_health ?? {};
          const state = g.emergency_stop_at ? 'stopped' : g.is_paused ? 'paused' : g.online ? 'online' : 'offline';
          return (
            <article key={g.id} className={`phone phone-${state}`}>
              <header>
                <h2>{g.name}</h2>
                <span className={`tag tag-${state}`}>{{ online: 'Online', offline: 'Offline', paused: 'Paused', stopped: 'Emergency stop' }[state]}</span>
              </header>
              {g.pause_reason && <p className="small bad">{g.pause_reason}</p>}
              <dl className="facts">
                <div>
                  <dt>Last contact</dt>
                  <dd>{ago(g.last_seen_at)}</dd>
                </div>
                <div>
                  <dt>SIM</dt>
                  <dd>{g.sim_display_name ? `${g.sim_display_name} (${g.sim_carrier_name ?? '?'})` : 'not chosen'}</dd>
                </div>
                <div>
                  <dt>Signal</dt>
                  <dd>
                    <span className="bars" aria-label={`signal ${h.signal_level ?? 'unknown'} of 4`}>
                      {BARS.map((b) => (
                        <i key={b} className={h.signal_level >= b ? 'on' : ''} style={{ height: 4 + b * 3 }} />
                      ))}
                    </span>{' '}
                    {h.network_type ?? ''}
                  </dd>
                </div>
                <div>
                  <dt>Battery</dt>
                  <dd>
                    {h.battery_pct ?? '?'}% {h.is_charging ? 'charging' : h.battery_pct != null ? <span className="bad">not charging</span> : ''}
                  </dd>
                </div>
                <div>
                  <dt>SIM state</dt>
                  <dd>{h.sim_state ?? '?'}</dd>
                </div>
                <div>
                  <dt>Today</dt>
                  <dd>
                    {n(g.messages_today)} messages, {n(g.segments_today)} segments
                  </dd>
                </div>
                <div>
                  <dt>Pace</dt>
                  <dd>
                    one per {g.send_interval_ms / 1000}s, batches of {g.batch_limit}
                  </dd>
                </div>
                <div>
                  <dt>With phone now</dt>
                  <dd>{n(g.in_flight)}</dd>
                </div>
              </dl>
              {h.permissions && Object.entries(h.permissions).some(([, v]) => !v) && (
                <Notice kind="warn">
                  Missing permission on the phone:{' '}
                  {Object.entries(h.permissions)
                    .filter(([, v]) => !v)
                    .map(([k]) => k)
                    .join(', ')}
                </Notice>
              )}
              <p className="muted small">
                {g.device_model} · Android {g.android_version} · app {g.app_version} · paired {when(g.created_at)}
              </p>
              <div className="row wrap">
                <button className="btn btn-quiet" onClick={() => setModal({ g, kind: 'health' })}>
                  Health and errors
                </button>
                {can('campaigns.operate') && !g.is_paused && (
                  <button className="btn btn-quiet" onClick={() => setModal({ g, kind: 'pause' })}>
                    Pause
                  </button>
                )}
                {can('campaigns.operate') && g.is_paused && (
                  <button className="btn btn-primary" onClick={() => setModal({ g, kind: 'resume' })}>
                    Resume
                  </button>
                )}
                {can('gateways.manage') && (
                  <>
                    <button className="btn btn-quiet" onClick={() => setModal({ g, kind: 'settings' })}>
                      Pace
                    </button>
                    {!g.emergency_stop_at && (
                      <button className="btn btn-danger" onClick={() => setModal({ g, kind: 'emergency-stop' })}>
                        Emergency stop
                      </button>
                    )}
                    <button className="btn btn-quiet" onClick={() => setModal({ g, kind: 'revoke' })}>
                      Unpair
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {pairing && <PairModal onClose={() => { setPairing(false); void reload(); }} />}
      {modal && ['pause', 'resume', 'emergency-stop', 'revoke'].includes(modal.kind) && (
        <ReasonModal
          title={{ pause: 'Pause phone', resume: 'Resume phone', 'emergency-stop': 'Emergency stop', revoke: 'Unpair phone' }[modal.kind as 'pause']}
          help={
            {
              pause: 'The phone stops taking new messages and hands back the ones it has not started.',
              resume: 'The phone starts taking messages again. This also clears an emergency stop.',
              'emergency-stop': 'At its next contact the phone drops every message it has not started sending and stops. Messages already handed to its radio cannot be recalled.',
              revoke: 'The phone’s access is removed permanently. Its unsent messages go back in the queue. To use it again, pair it again.',
            }[modal.kind as 'pause']
          }
          action={{ pause: 'Pause', resume: 'Resume', 'emergency-stop': 'Stop now', revoke: 'Unpair' }[modal.kind as 'pause']}
          danger={modal.kind === 'emergency-stop' || modal.kind === 'revoke'}
          busy={a.busy}
          error={a.error}
          onClose={() => setModal(undefined)}
          onSubmit={(reason) => void a.run(async () => { await post(`/gateways/${modal.g.id}/${modal.kind}`, { reason }); setModal(undefined); await reload(); })}
        />
      )}
      {modal?.kind === 'settings' && <PaceModal g={modal.g} onClose={() => { setModal(undefined); void reload(); }} />}
      {modal?.kind === 'health' && <HealthModal g={modal.g} onClose={() => setModal(undefined)} />}
    </>
  );
}

function PairModal({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [code, setCode] = useState<any>();
  const a = useAction();
  return (
    <Modal title="Pair a phone" onClose={onClose}>
      {!code ? (
        <>
          <ol className="howto">
            <li>Install the SIM SMS Gateway app on the phone with the SIM you will send from.</li>
            <li>Give the phone a name here, then scan the code with the app (Pair with server → Scan QR code).</li>
          </ol>
          <label>
            Phone name
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Registry office phone" autoFocus />
          </label>
          <Notice kind="error">{a.error}</Notice>
          <div className="actions">
            <button className="btn btn-primary" disabled={!label.trim() || a.busy} onClick={() => void a.run(async () => setCode(await post('/gateways/pairing-codes', { label })))}>
              Show pairing code
            </button>
          </div>
        </>
      ) : (
        <div className="pair">
          <img src={code.qr_data_url} alt="Pairing QR code" width={280} height={280} />
          <div>
            <p>Scan this with the app. It works once and expires at {new Date(code.expires_at).toLocaleTimeString('en-GB')}.</p>
            <p>
              Or type it in the app: server <code>{code.server_url}</code>, code <code className="big">{code.code}</code>
            </p>
            {code.certificate_fingerprint && (
              <p className="small">
                Certificate fingerprint: <code>{code.certificate_fingerprint}</code>
              </p>
            )}
            <Notice kind="warn">{code.warning}</Notice>
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PaceModal({ g, onClose }: { g: any; onClose: () => void }) {
  const [interval, setIntervalS] = useState(g.send_interval_ms / 1000);
  const [batch, setBatch] = useState(g.batch_limit);
  const a = useAction();
  const perHour = Math.round(3600 / Math.max(1, interval));
  return (
    <Modal title={`Pace for ${g.name}`} onClose={onClose}>
      <label>
        Seconds between messages
        <input type="number" min={1} step={0.5} value={interval} onChange={(e) => setIntervalS(Number(e.target.value))} />
        <span className="hint">
          At most about {n(perHour)} messages an hour from this phone. Faster sending raises the risk that the carrier throttles or blocks the SIM, and Android may ask for
          confirmation on the phone after about 30 messages unless its limit was raised.
        </span>
      </label>
      <label>
        Messages per batch
        <input type="number" min={1} max={200} value={batch} onChange={(e) => setBatch(Number(e.target.value))} />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={a.busy} onClick={() => void a.run(async () => { await patch(`/gateways/${g.id}`, { send_interval_ms: Math.round(interval * 1000), batch_limit: batch }); onClose(); })}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function HealthModal({ g, onClose }: { g: any; onClose: () => void }) {
  const { data } = useLoad(() => get(`/gateways/${g.id}/health?hours=24`), [g.id]);
  const events = (data?.events ?? []) as any[];
  const pts = events.slice().reverse();
  const w = 600;
  const hgt = 80;
  const path = (key: string, max: number) =>
    pts
      .map((e, i) => (e[key] == null ? null : `${(i / Math.max(1, pts.length - 1)) * w},${hgt - (e[key] / max) * hgt}`))
      .filter(Boolean)
      .join(' ');
  return (
    <Modal title={`${g.name}: last 24 hours`} onClose={onClose} wide>
      {pts.length > 1 ? (
        <figure className="spark">
          <svg viewBox={`0 0 ${w} ${hgt}`} preserveAspectRatio="none" role="img" aria-label="Battery and signal over time">
            <polyline points={path('battery_pct', 100)} className="line-battery" />
            <polyline points={path('signal_level', 4)} className="line-signal" />
          </svg>
          <figcaption>
            <span className="key key-battery">Battery %</span> <span className="key key-signal">Signal (0–4)</span> · {pts.length} check-ins
          </figcaption>
        </figure>
      ) : (
        <p className="muted">Not enough check-ins yet.</p>
      )}
      <h3>Recent failures</h3>
      {data?.recent_errors.length === 0 && <p className="muted">None.</p>}
      <ul className="plain">
        {data?.recent_errors.map((e: any, i: number) => (
          <li key={i}>
            {when(e.reported_at, true)} <code>{e.error_code}</code> {e.error_category?.toLowerCase().replace(/_/g, ' ')} {e.detail}
          </li>
        ))}
      </ul>
      <h3>Events</h3>
      <ul className="plain small">
        {events.filter((e) => e.kind !== 'HEARTBEAT').slice(0, 30).map((e, i) => (
          <li key={i}>
            {when(e.received_at, true)} {e.kind.toLowerCase().replace(/_/g, ' ')}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
