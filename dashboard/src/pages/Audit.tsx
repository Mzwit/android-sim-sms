import { useState } from 'react';
import { get } from '../api';
import { Notice, Pager, useLoad, when } from '../util';

export function Audit() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useLoad(() => get(`/audit-logs?page=${page}&page_size=50${action ? `&action=${encodeURIComponent(action)}` : ''}`), [page, action]);
  return (
    <>
      <header className="page-head">
        <h1>Audit log</h1>
      </header>
      <p className="muted">Every sign-in, change, approval, export and phone event is recorded here. Entries cannot be edited or deleted.</p>
      <div className="toolbar">
        <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Filter">
          <option value="">Everything</option>
          <option value="campaign.">Campaigns</option>
          <option value="contact.">Contacts</option>
          <option value="contacts.">Imports and exports</option>
          <option value="consent.">Consent</option>
          <option value="suppression.">Opt-outs</option>
          <option value="gateway.">Phones</option>
          <option value="message.">Retries and reconciliation</option>
          <option value="auth.">Sign-ins</option>
          <option value="admin.">Administrators</option>
          <option value="settings.">Settings</option>
          <option value="kill_switch.">Kill switch</option>
        </select>
      </div>
      <Notice kind="error">{error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((l: any) => (
            <tr key={l.id}>
              <td className="nowrap">{when(l.occurred_at, true)}</td>
              <td>
                {l.actor_name ?? l.actor_type.toLowerCase()}
                {l.ip && <div className="muted small">{l.ip}</div>}
              </td>
              <td>
                <code>{l.action}</code>
              </td>
              <td className="small details">{Object.keys(l.details ?? {}).length ? JSON.stringify(l.details) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && <Pager page={page} pageSize={50} total={data.total} onPage={setPage} />}
    </>
  );
}
