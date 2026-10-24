import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';
import { Notice, useAction, useLoad, when } from '../util';

export function Alerts() {
  const [open, setOpen] = useState(true);
  const { data, reload, error } = useLoad(() => get(`/alerts?open=${open}`), [open], 15_000);
  const a = useAction();
  const link = (x: any) => (x.entity_type === 'campaign' ? `/campaigns/${x.entity_id}` : x.entity_type === 'gateway' ? '/gateways' : x.entity_type === 'suppression' ? '/opt-outs' : x.kind === 'MESSAGES_UNKNOWN' ? '/messages' : undefined);
  return (
    <>
      <header className="page-head">
        <h1>Alerts</h1>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={open} className={open ? 'is-current' : ''} onClick={() => setOpen(true)}>
          Open
        </button>
        <button role="tab" aria-selected={!open} className={!open ? 'is-current' : ''} onClick={() => setOpen(false)}>
          All
        </button>
      </div>
      <Notice kind="error">{error ?? a.error}</Notice>
      <ul className="alerts">
        {data?.items.map((x: any) => (
          <li key={x.id} className={`alert alert-${x.severity.toLowerCase()}`}>
            <div>
              <p>{x.message}</p>
              <p className="muted small">
                {when(x.created_at)} {x.acknowledged_at && `· acknowledged by ${x.acknowledged_by} ${when(x.acknowledged_at)}`}
              </p>
            </div>
            <div className="row">
              {link(x) && (
                <Link className="btn btn-quiet" to={link(x)!}>
                  Open
                </Link>
              )}
              {!x.acknowledged_at && (
                <button className="btn btn-quiet" onClick={() => void a.run(async () => { await post(`/alerts/${x.id}/ack`); await reload(); })}>
                  Acknowledge
                </button>
              )}
            </div>
          </li>
        ))}
        {data?.items.length === 0 && <li className="empty">Nothing needs your attention.</li>}
      </ul>
    </>
  );
}
