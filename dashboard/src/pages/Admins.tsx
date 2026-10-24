import { useState } from 'react';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';
import { ago, Modal, Notice, useAction, useLoad } from '../util';

export function Admins() {
  const { me } = useAuth();
  const { data, reload, error } = useLoad(() => get('/admins'), []);
  const { data: roles } = useLoad(() => get('/roles'), []);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ email: string; password: string }>();
  const a = useAction();
  return (
    <>
      <header className="page-head">
        <h1>Administrators</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          Add administrator
        </button>
      </header>
      <Notice kind="error">{error ?? a.error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Last sign-in</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((u: any) => (
            <tr key={u.id}>
              <td>
                {u.display_name}
                <div className="muted small">{u.email}</div>
              </td>
              <td>
                <select
                  value={u.role}
                  disabled={u.id === me?.id}
                  onChange={(e) => void a.run(async () => { await patch(`/admins/${u.id}`, { role: e.target.value }); await reload(); })}
                  aria-label="Role"
                >
                  {roles?.items.map((r: any) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>{ago(u.last_login_at)}</td>
              <td>
                {!u.is_active ? 'Deactivated' : u.locked_until && new Date(u.locked_until) > new Date() ? 'Locked' : u.must_change_password ? 'Must change password' : 'Active'}
              </td>
              <td className="row-actions">
                {u.id !== me?.id && (
                  <>
                    <button className="btn btn-quiet" onClick={() => void a.run(async () => { const r = await post(`/admins/${u.id}/reset-password`); setSecret({ email: u.email, password: r.temporary_password }); await reload(); })}>
                      Reset password
                    </button>
                    {u.locked_until && (
                      <button className="btn btn-quiet" onClick={() => void a.run(async () => { await patch(`/admins/${u.id}`, { unlock: true }); await reload(); })}>
                        Unlock
                      </button>
                    )}
                    <button className="btn btn-quiet" onClick={() => void a.run(async () => { await patch(`/admins/${u.id}`, { is_active: !u.is_active }); await reload(); })}>
                      {u.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="panel">
        <h2>What each role can do</h2>
        <dl className="defs">
          {roles?.items.map((r: any) => (
            <div key={r.code}>
              <dt>{r.name}</dt>
              <dd>
                {r.description}. <span className="muted small">{r.permissions.join(', ')}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      {adding && <AddAdmin roles={roles?.items ?? []} onClose={(s) => { setAdding(false); if (s) setSecret(s); void reload(); }} />}
      {secret && (
        <Modal title="Temporary password" onClose={() => setSecret(undefined)}>
          <p>
            Give this to {secret.email} in person or by phone. It is shown only once and must be changed at first sign-in.
          </p>
          <p className="secret">
            <code>{secret.password}</code>
          </p>
          <button className="btn btn-primary" onClick={() => setSecret(undefined)}>
            I have noted it
          </button>
        </Modal>
      )}
    </>
  );
}

function AddAdmin({ roles, onClose }: { roles: any[]; onClose: (s?: { email: string; password: string }) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('OPERATOR');
  const a = useAction();
  return (
    <Modal title="Add administrator" onClose={() => onClose()}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}: {r.description}
            </option>
          ))}
        </select>
      </label>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={() => onClose()}>
          Back
        </button>
        <button className="btn btn-primary" disabled={!email || !name || a.busy} onClick={() => void a.run(async () => { const r = await post('/admins', { email, display_name: name, role }); onClose({ email, password: r.temporary_password }); })}>
          Add
        </button>
      </div>
    </Modal>
  );
}
