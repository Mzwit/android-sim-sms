import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Modal, n, Notice, useAction, useLoad, when } from '../util';

export function Groups() {
  const { can } = useAuth();
  const { data, reload, error } = useLoad(() => get('/groups'), []);
  const [edit, setEdit] = useState<any>();
  const a = useAction();
  return (
    <>
      <header className="page-head">
        <h1>Groups</h1>
        {can('groups.write') && (
          <button className="btn btn-primary" onClick={() => setEdit({ name: '', description: '' })}>
            New group
          </button>
        )}
      </header>
      <p className="muted">Campaigns are sent to groups. A contact can be in several groups and still receives a campaign only once.</p>
      <Notice kind="error">{error ?? a.error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th className="num">Members</th>
            <th className="num">Valid numbers</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((g: any) => (
            <tr key={g.id}>
              <td>
                <Link to={`/contacts?group=${g.id}`}>{g.name}</Link>
              </td>
              <td className="small">{g.description}</td>
              <td className="num">{n(g.member_count)}</td>
              <td className="num">{n(g.valid_count)}</td>
              <td>{when(g.created_at)}</td>
              <td className="row-actions">
                {can('groups.write') && (
                  <>
                    <button className="btn btn-quiet" onClick={() => setEdit(g)}>
                      Rename
                    </button>
                    <button className="btn btn-quiet" onClick={() => void a.run(async () => { await del(`/groups/${g.id}`); await reload(); })}>
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {data?.items.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No groups yet. Create one, then add contacts from the Contacts page or during import.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {edit && <GroupForm g={edit} onClose={() => { setEdit(undefined); void reload(); }} />}
    </>
  );
}

function GroupForm({ g, onClose }: { g: any; onClose: () => void }) {
  const [name, setName] = useState(g.name);
  const [description, setDescription] = useState(g.description ?? '');
  const a = useAction();
  return (
    <Modal title={g.id ? 'Rename group' : 'New group'} onClose={onClose}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={!name.trim() || a.busy} onClick={() => void a.run(async () => { if (g.id) await patch(`/groups/${g.id}`, { name, description }); else await post('/groups', { name, description }); onClose(); })}>
          Save
        </button>
      </div>
    </Modal>
  );
}
