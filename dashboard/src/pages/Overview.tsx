import { Link } from 'react-router-dom';
import { get } from '../api';
import { Pipeline, toCounts } from '../components/Pipeline';
import { duration, n, Notice, StatusTag, useLoad } from '../util';

export function Overview() {
  const { data: s, error } = useLoad(() => get('/dashboard/summary'), [], 5000);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!s) return <p className="muted">Loading…</p>;
  const m = s.messages;
  const allCounts = toCounts({ pending: m.queued, submitted: m.submitted, confirmed_delivered: m.confirmed_delivered, failed: m.failed, unknown: m.unknown, cancelled: m.cancelled });
  const total = m.queued + m.submitted + m.failed + m.unknown + m.cancelled;
  return (
    <>
      <header className="page-head">
        <h1>Overview</h1>
        <Link className="btn btn-primary" to="/campaigns/new">
          New campaign
        </Link>
      </header>

      <section className="live">
        <h2>Sending now</h2>
        {s.active_campaigns.length === 0 && (
          <p className="muted">
            No campaign is sending. <Link to="/campaigns">See all campaigns</Link>.
          </p>
        )}
        {s.active_campaigns.map((c: any) => (
          <Link key={c.id} to={`/campaigns/${c.id}`} className="live-row">
            <div className="live-title">
              <strong>{c.name}</strong>
              <StatusTag s={c.status} />
              {c.pause_reason && <span className="muted small">{c.pause_reason}</span>}
            </div>
            <Pipeline counts={toCounts(c.progress)} total={c.progress.total} compact />
            <div className="live-meta">
              <span>
                {n(c.progress.submitted)} of {n(c.progress.total)} submitted
              </span>
              <span>{c.progress.rate_per_minute > 0 ? `${c.progress.rate_per_minute} per minute` : 'not sending at the moment'}</span>
              {c.progress.eta.minutes != null && c.progress.pending > 0 && <span title={c.progress.eta.note}>about {duration(c.progress.eta.minutes)} left (estimate)</span>}
            </div>
          </Link>
        ))}
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>All messages</h2>
          <Pipeline counts={allCounts} total={total} />
          <p className="muted small">
            {n(m.awaiting_report)} submitted messages are waiting for a delivery report; {n(m.no_report)} never received one. Many networks do not send reports, so these are
            not counted as delivered.
          </p>
          {m.unknown > 0 && (
            <Notice kind="warn">
              {n(m.unknown)} message{m.unknown === 1 ? '' : 's'} have an unknown outcome. <Link to="/messages">Reconcile them</Link> before any resend.
            </Notice>
          )}
        </section>
        <section className="panel">
          <h2>Recipients</h2>
          <dl className="facts">
            <div>
              <dt>Contacts</dt>
              <dd>{n(s.contacts.total)}</dd>
            </div>
            <div>
              <dt>Valid numbers</dt>
              <dd>{n(s.contacts.valid)}</dd>
            </div>
            <div>
              <dt>With consent</dt>
              <dd>{n(s.contacts.consented)}</dd>
            </div>
            <div>
              <dt>Opted out</dt>
              <dd>{n(s.contacts.opted_out)}</dd>
            </div>
            <div>
              <dt>Campaigns</dt>
              <dd>{n(s.campaigns.total)}</dd>
            </div>
            <div>
              <dt>Current rate</dt>
              <dd>{s.rate_per_minute} / min</dd>
            </div>
          </dl>
          <p className="muted small">Rates and finish times are measured from what the phones actually sent in the last 15 minutes, not promised.</p>
        </section>
      </div>
    </>
  );
}
