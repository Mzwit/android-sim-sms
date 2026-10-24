import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, del, download, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Modal, n, Notice, Pager, StatusTag, useAction, useLoad, when } from '../util';

export function Contacts() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [group, setGroup] = useState(params.get('group') ?? '');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);
  const { data: groups } = useLoad(() => get('/groups'), []);
  const qs = new URLSearchParams({ page: String(page), page_size: '50' });
  if (q.trim()) qs.set('q', q.trim());
  if (group) qs.set('group_id', group);
  if (filter === 'invalid') qs.set('valid', 'false');
  if (filter === 'opted_out') qs.set('opted_out', 'true');
  if (filter === 'no_consent') qs.set('consent', 'NONE');
  if (filter === 'withdrawn') qs.set('consent', 'WITHDRAWN');
  const { data, error, reload } = useLoad(() => get(`/contacts?${qs}`), [qs.toString()]);
  const a = useAction();
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <>
      <header className="page-head">
        <h1>Contacts</h1>
        <div className="head-actions">
          {can('contacts.export') && (
            <button className="btn btn-quiet" onClick={() => void a.run(() => download(`/contacts/export.csv${group ? `?group_id=${group}` : ''}`, 'contacts.csv'))}>
              Export CSV
            </button>
          )}
          {can('contacts.write') && (
            <>
              <Link className="btn btn-quiet" to="/contacts/import">
                Import CSV or Excel
              </Link>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                Add contact
              </button>
            </>
          )}
        </div>
      </header>
      <div className="toolbar">
        <input type="search" placeholder="Search name, reference, email or last digits" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="grow" />
        <select value={group} onChange={(e) => { setGroup(e.target.value); setPage(1); }} aria-label="Group">
          <option value="">All groups</option>
          {groups?.items.map((g: any) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} aria-label="Filter">
          <option value="">Everyone</option>
          <option value="invalid">Invalid numbers</option>
          <option value="no_consent">No consent recorded</option>
          <option value="withdrawn">Consent withdrawn</option>
          <option value="opted_out">Opted out</option>
        </select>
        {selected.length > 0 && can('contacts.write') && (
          <button className="btn btn-quiet" onClick={() => setBulk(true)}>
            Edit {selected.length} selected
          </button>
        )}
      </div>
      <Notice kind="error">{error ?? a.error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th className="w-check">
              <input
                type="checkbox"
                aria-label="Select all on this page"
                checked={!!data?.items.length && data.items.every((c: any) => selected.includes(c.id))}
                onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...data.items.map((c: any) => c.id)])] : selected.filter((id) => !data.items.some((c: any) => c.id === id)))}
              />
            </th>
            <th>Name</th>
            <th>Phone</th>
            <th>Reference</th>
            <th>Consent</th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((c: any) => (
            <tr key={c.id} className={!c.is_valid ? 'row-bad' : ''}>
              <td>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} aria-label="Select" />
              </td>
              <td>
                <button className="linklike" onClick={() => setOpen(c.id)}>
                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || 'No name'}
                </button>
              </td>
              <td>
                {c.phone_e164 ?? (
                  <>
                    {c.phone_raw && <code>{c.phone_raw}</code>} <span className="bad small">{(c.validation_error ?? 'invalid').replace(/^[A-Z_]+: /, '')}</span>
                  </>
                )}
                {c.opted_out && <span className="tag tag-cancelled">opted out</span>}
              </td>
              <td>{c.reference_no ?? ''}</td>
              <td>{c.consent_general === 'GRANTED' ? 'Given' : c.consent_general === 'WITHDRAWN' ? <span className="bad">Withdrawn</span> : <span className="muted">None</span>}</td>
              <td className="small">{c.tags.join(', ')}</td>
            </tr>
          ))}
          {data && data.items.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No contacts match. {can('contacts.write') && <Link to="/contacts/import">Import a list</Link>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data && <Pager page={page} pageSize={50} total={data.total} onPage={setPage} />}
      {adding && <ContactForm groups={groups?.items ?? []} onClose={() => { setAdding(false); void reload(); }} />}
      {open && <ContactDetail id={open} onClose={() => { setOpen(undefined); void reload(); }} />}
      {bulk && <BulkEdit ids={selected} groups={groups?.items ?? []} onClose={(done) => { setBulk(false); if (done) setSelected([]); void reload(); }} />}
    </>
  );
}

function ContactForm({ groups, onClose, existing }: { groups: any[]; onClose: () => void; existing?: any }) {
  const [f, setF] = useState({
    phone: existing?.phone_e164 ?? '',
    first_name: existing?.first_name ?? '',
    last_name: existing?.last_name ?? '',
    reference_no: existing?.reference_no ?? '',
    email: existing?.email ?? '',
    tags: (existing?.tags ?? []).join(', '),
    group_ids: [] as string[],
    consent: !existing,
    consent_source: '',
    consent_evidence: '',
  });
  const a = useAction();
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = () =>
    a.run(async () => {
      const tags = f.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
      const body: any = { first_name: f.first_name || null, last_name: f.last_name || null, reference_no: f.reference_no || null, email: f.email || null, tags };
      if (existing) {
        if (f.phone !== existing.phone_e164 && !existing.phone_masked) body.phone = f.phone;
        await patch(`/contacts/${existing.id}`, body);
      } else {
        await post('/contacts', {
          ...body,
          phone: f.phone,
          group_ids: f.group_ids,
          consent: f.consent ? { source: f.consent_source, evidence: f.consent_evidence || undefined } : undefined,
        });
      }
      onClose();
    });
  return (
    <Modal title={existing ? 'Edit contact' : 'Add contact'} onClose={onClose}>
      <label>
        Mobile number
        <input value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="7612 3456 or +268 7612 3456" disabled={existing?.phone_masked} />
        <span className="hint">Eswatini numbers can be written without +268.</span>
      </label>
      <div className="row wrap">
        <label>
          First name
          <input value={f.first_name} onChange={(e) => set({ first_name: e.target.value })} />
        </label>
        <label>
          Last name
          <input value={f.last_name} onChange={(e) => set({ last_name: e.target.value })} />
        </label>
      </div>
      <div className="row wrap">
        <label>
          Reference number
          <input value={f.reference_no} onChange={(e) => set({ reference_no: e.target.value })} />
        </label>
        <label>
          Email
          <input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
        </label>
      </div>
      <label>
        Tags (comma separated)
        <input value={f.tags} onChange={(e) => set({ tags: e.target.value })} />
      </label>
      {!existing && (
        <>
          {groups.length > 0 && (
            <fieldset>
              <legend>Groups</legend>
              <div className="checklist">
                {groups.map((g) => (
                  <label key={g.id} className="check">
                    <input type="checkbox" checked={f.group_ids.includes(g.id)} onChange={(e) => set({ group_ids: e.target.checked ? [...f.group_ids, g.id] : f.group_ids.filter((x) => x !== g.id) })} />
                    {g.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset>
            <legend>Consent</legend>
            <label className="check">
              <input type="checkbox" checked={f.consent} onChange={(e) => set({ consent: e.target.checked })} />
              This person agreed to receive messages
            </label>
            {f.consent && (
              <div className="row wrap">
                <label>
                  How they agreed
                  <input value={f.consent_source} onChange={(e) => set({ consent_source: e.target.value })} placeholder="e.g. Registration form 2026" />
                </label>
                <label>
                  Evidence reference (optional)
                  <input value={f.consent_evidence} onChange={(e) => set({ consent_evidence: e.target.value })} placeholder="form number, file name…" />
                </label>
              </div>
            )}
          </fieldset>
        </>
      )}
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-primary" disabled={a.busy || !f.phone || (f.consent && !existing && f.consent_source.trim().length < 2)} onClick={() => void save()}>
          {existing ? 'Save changes' : 'Add contact'}
        </button>
      </div>
    </Modal>
  );
}

function ContactDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const { data: c, reload, error } = useLoad(() => get(`/contacts/${id}`), [id]);
  const { data: msgs } = useLoad(() => (can('campaigns.read') ? get(`/contacts/${id}/messages`) : Promise.resolve({ items: [] })), [id]);
  const [mode, setMode] = useState<'' | 'edit' | 'consent' | 'erase'>('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<'GRANTED' | 'WITHDRAWN'>('WITHDRAWN');
  const a = useAction();
  if (error) return <Modal title="Contact" onClose={onClose}><Notice kind="error">{error}</Notice></Modal>;
  if (!c) return null;
  if (mode === 'edit') return <ContactForm groups={[]} existing={c} onClose={() => { setMode(''); void reload(); }} />;
  return (
    <Modal title={[c.first_name, c.last_name].filter(Boolean).join(' ') || 'Contact'} onClose={onClose} wide>
      <dl className="facts">
        <div>
          <dt>Number</dt>
          <dd>{c.phone_e164 ?? '–'}</dd>
        </div>
        <div>
          <dt>As entered</dt>
          <dd>{c.phone_raw ?? 'hidden'}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd>{c.reference_no ?? '–'}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{c.email ?? '–'}</dd>
        </div>
        <div>
          <dt>Opted out</dt>
          <dd>{c.opted_out ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{when(c.created_at)}</dd>
        </div>
      </dl>
      {!c.is_valid && <Notice kind="warn">This number is invalid: {c.validation_error}. Edit it to fix.</Notice>}
      <div className="row">
        {can('contacts.write') && (
          <button className="btn btn-quiet" onClick={() => setMode('edit')}>
            Edit
          </button>
        )}
        {can('consent.write') && (
          <button className="btn btn-quiet" onClick={() => setMode('consent')}>
            Record consent change
          </button>
        )}
        {can('consent.write') && c.phone_e164 && !c.opted_out && !c.phone_masked && (
          <button className="btn btn-quiet" onClick={() => void a.run(async () => { await post('/opt-outs', { phone: c.phone_e164, source: 'Opted out by administrator from contact page' }); await reload(); }, 'Opted out. Queued messages to this number were cancelled.')}>
            Opt out now
          </button>
        )}
        {can('contacts.delete') && (
          <>
            <button className="btn btn-quiet" onClick={() => void a.run(async () => { await del(`/contacts/${id}`); onClose(); })}>
              Delete
            </button>
            <button className="btn btn-danger" onClick={() => setMode('erase')}>
              Erase personal data
            </button>
          </>
        )}
      </div>
      {mode === 'consent' && (
        <div className="panel inset">
          <div className="row wrap">
            <label>
              Change
              <select value={status} onChange={(e) => setStatus(e.target.value as any)}>
                <option value="WITHDRAWN">Consent withdrawn</option>
                <option value="GRANTED">Consent given</option>
              </select>
            </label>
            <label className="grow">
              How you know
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Email to registrar, 24 Oct" />
            </label>
          </div>
          <button className="btn btn-primary" disabled={source.trim().length < 2 || a.busy} onClick={() => void a.run(async () => { const r = await post(`/contacts/${id}/consent`, { status, source }); setMode(''); await reload(); a.setOk(status === 'WITHDRAWN' ? `Recorded. ${r.cancelled_messages} queued message(s) cancelled.` : 'Recorded.'); })}>
            Record
          </button>
        </div>
      )}
      {mode === 'erase' && (
        <div className="panel inset">
          <p>
            Erasing removes this person's name, email, reference, number and message texts. Any opt-out for the number is kept, so they are never messaged again. This cannot be
            undone.
          </p>
          <label>
            Reason (e.g. data protection request number)
            <input value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
          <button className="btn btn-danger" disabled={source.trim().length < 5 || a.busy} onClick={() => void a.run(async () => { await post(`/contacts/${id}/erase`, { note: source }); onClose(); })}>
            Erase permanently
          </button>
        </div>
      )}
      <Notice kind="error">{a.error}</Notice>
      <Notice kind="ok">{a.ok}</Notice>
      <h3>Consent history</h3>
      {c.consent_history.length === 0 ? (
        <p className="muted">No consent recorded. This contact will be excluded from campaigns.</p>
      ) : (
        <ul className="plain">
          {c.consent_history.map((h: any) => (
            <li key={h.id}>
              {when(h.effective_at)}: {h.status === 'GRANTED' ? 'given' : 'withdrawn'} for “{h.purpose}”, {h.source}
              {h.evidence && ` (${h.evidence})`}
            </li>
          ))}
        </ul>
      )}
      <h3>Messages</h3>
      {msgs?.items.length ? (
        <ul className="plain">
          {msgs.items.map((m: any) => (
            <li key={m.id}>
              <StatusTag s={m.status} /> {m.campaign_name ?? (m.is_test ? 'test message' : '')} · {when(m.submitted_at ?? m.queued_at)}
              {m.last_error_code && <code> {m.last_error_code}</code>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No messages yet.</p>
      )}
    </Modal>
  );
}

function BulkEdit({ ids, groups, onClose }: { ids: string[]; groups: any[]; onClose: (done: boolean) => void }) {
  const [addTags, setAddTags] = useState('');
  const [removeTags, setRemoveTags] = useState('');
  const [addGroup, setAddGroup] = useState('');
  const [removeGroup, setRemoveGroup] = useState('');
  const a = useAction();
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title={`Edit ${ids.length} contacts`} onClose={() => onClose(false)}>
      <label>
        Add tags
        <input value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="comma separated" />
      </label>
      <label>
        Remove tags
        <input value={removeTags} onChange={(e) => setRemoveTags(e.target.value)} />
      </label>
      <div className="row wrap">
        <label>
          Add to group
          <select value={addGroup} onChange={(e) => setAddGroup(e.target.value)}>
            <option value="">–</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Remove from group
          <select value={removeGroup} onChange={(e) => setRemoveGroup(e.target.value)}>
            <option value="">–</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Notice kind="error">{a.error}</Notice>
      <div className="actions">
        <button className="btn btn-quiet" onClick={() => onClose(false)}>
          Back
        </button>
        <button
          className="btn btn-primary"
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await post('/contacts/bulk-update', {
                contact_ids: ids,
                add_tags: split(addTags),
                remove_tags: split(removeTags),
                add_group_ids: addGroup ? [addGroup] : [],
                remove_group_ids: removeGroup ? [removeGroup] : [],
              });
              onClose(true);
            })
          }
        >
          Apply to {ids.length} contacts
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import wizard
// ---------------------------------------------------------------------------
const ERROR_TEXT: Record<string, string> = {
  EMPTY: 'No number',
  INVALID_CHARACTERS: 'Letters or symbols in the number',
  UNPARSEABLE: 'Not a phone number',
  INVALID_NUMBER: 'Wrong number of digits',
  NOT_MOBILE: 'Landline (cannot receive SMS)',
  INVALID_EMAIL: 'Invalid email',
  INVALID_TAG: 'Invalid tag',
  INVALID_CONSENT_DATE: 'Consent date not a date',
  FUTURE_CONSENT_DATE: 'Consent date in the future',
};

export function ContactImport() {
  const { data: groups } = useLoad(() => get('/groups'), []);
  const [file, setFile] = useState<File>();
  const [staged, setStaged] = useState<any>();
  const [result, setResult] = useState<any>();
  const [opts, setOpts] = useState({ on_existing: 'skip', group_id: '', store_invalid: true, use_default_consent: false, consent_source: '', consent_evidence: '' });
  const a = useAction();
  const upload = () =>
    a.run(async () => {
      const fd = new FormData();
      fd.append('file', file!);
      setStaged(await api('POST', '/contacts/import', fd));
    });
  const commit = () =>
    a.run(async () => {
      setResult(
        await post(`/contacts/imports/${staged.import_id}/commit`, {
          on_existing: opts.on_existing,
          group_ids: opts.group_id ? [opts.group_id] : [],
          store_invalid: opts.store_invalid,
          default_consent: opts.use_default_consent ? { source: opts.consent_source, evidence: opts.consent_evidence || undefined } : null,
        }),
      );
    });
  const s = staged?.summary;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="crumb">
            <Link to="/contacts">Contacts</Link>
          </p>
          <h1>Import contacts</h1>
        </div>
      </header>
      {!staged && (
        <section className="panel narrow">
          <p>
            Upload a CSV or Excel (.xlsx) file with a <strong>phone</strong> column. Optional columns: first_name, last_name, reference_no, email, tags, consent_source,
            consent_date. Nothing is saved until you review the result.
          </p>
          <button className="linklike" onClick={() => void a.run(() => download('/contacts/import/template.csv', 'contacts-template.csv'))}>
            Download the template
          </button>
          <label className="file">
            File
            <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0])} />
          </label>
          <Notice kind="error">{a.error}</Notice>
          <button className="btn btn-primary" disabled={!file || a.busy} onClick={() => void upload()}>
            {a.busy ? 'Checking every row…' : 'Check file'}
          </button>
        </section>
      )}
      {staged && !result && (
        <>
          <section className="panel">
            <h2>What we found in {file?.name}</h2>
            <dl className="facts">
              <div>
                <dt>Rows</dt>
                <dd>{n(s.total_rows)}</dd>
              </div>
              <div>
                <dt>New contacts</dt>
                <dd className="big">{n(s.new_contacts)}</dd>
              </div>
              <div>
                <dt>Already in contacts</dt>
                <dd>{n(s.existing_contacts)}</dd>
              </div>
              <div>
                <dt>Same number twice in file</dt>
                <dd>{n(s.duplicate_rows_in_file)}</dd>
              </div>
              <div>
                <dt>Rows with problems</dt>
                <dd className={s.invalid_rows ? 'bad' : ''}>{n(s.invalid_rows)}</dd>
              </div>
              <div>
                <dt>Rows with consent columns</dt>
                <dd>{n(s.rows_with_consent)}</dd>
              </div>
            </dl>
            <p className="muted small">Columns recognised: {s.columns_detected.join(', ')}</p>
            {staged.problems.length > 0 && (
              <>
                <h3>Rows that need attention</h3>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Number as written</th>
                      <th>Name</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staged.problems.slice(0, 100).map((p: any) => (
                      <tr key={p.row_no}>
                        <td>{p.row_no + 1}</td>
                        <td>
                          <code>{p.phone_raw ?? ''}</code>
                        </td>
                        <td>{[p.first_name, p.last_name].filter(Boolean).join(' ')}</td>
                        <td>{p.error_code ? (ERROR_TEXT[p.error_code] ?? p.error_message) : `Same number as row ${p.duplicate_of_row + 1} (skipped)`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="linklike" onClick={() => void a.run(() => download(`/contacts/imports/${staged.import_id}/problems.csv`, 'import-problems.csv'))}>
                  Download all problem rows
                </button>
              </>
            )}
          </section>
          <section className="panel">
            <h2>How to import</h2>
            <fieldset>
              <legend>Numbers already in contacts</legend>
              <label className="check">
                <input type="radio" checked={opts.on_existing === 'skip'} onChange={() => setOpts({ ...opts, on_existing: 'skip' })} /> Leave them unchanged
              </label>
              <label className="check">
                <input type="radio" checked={opts.on_existing === 'update'} onChange={() => setOpts({ ...opts, on_existing: 'update' })} /> Update names and details from the file
              </label>
            </fieldset>
            <label>
              Add everyone to group
              <select value={opts.group_id} onChange={(e) => setOpts({ ...opts, group_id: e.target.value })}>
                <option value="">No group</option>
                {groups?.items.map((g: any) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.store_invalid} onChange={(e) => setOpts({ ...opts, store_invalid: e.target.checked })} /> Keep rows with problems as invalid contacts, so
              they can be fixed later (they are never messaged)
            </label>
            <fieldset>
              <legend>Consent for rows without consent columns</legend>
              <label className="check">
                <input type="checkbox" checked={opts.use_default_consent} onChange={(e) => setOpts({ ...opts, use_default_consent: e.target.checked })} /> Everyone in this file agreed to
                receive messages
              </label>
              {opts.use_default_consent && (
                <div className="row wrap">
                  <label>
                    How they agreed
                    <input value={opts.consent_source} onChange={(e) => setOpts({ ...opts, consent_source: e.target.value })} placeholder="e.g. Signed enrolment forms 2026" />
                  </label>
                  <label>
                    Evidence reference
                    <input value={opts.consent_evidence} onChange={(e) => setOpts({ ...opts, consent_evidence: e.target.value })} />
                  </label>
                </div>
              )}
              {!opts.use_default_consent && <p className="hint">Contacts without consent are imported but excluded from every campaign until consent is recorded.</p>}
            </fieldset>
            <Notice kind="error">{a.error}</Notice>
            <div className="actions">
              <button className="btn btn-quiet" onClick={() => void a.run(async () => { await post(`/contacts/imports/${staged.import_id}/discard`); setStaged(undefined); })}>
                Discard
              </button>
              <button className="btn btn-primary" disabled={a.busy || (opts.use_default_consent && opts.consent_source.trim().length < 2)} onClick={() => void commit()}>
                Import {n(s.new_contacts)} new contacts
              </button>
            </div>
          </section>
        </>
      )}
      {result && (
        <section className="panel narrow">
          <h2>Import finished</h2>
          <ul className="plain">
            <li>{n(result.created)} contacts created</li>
            {result.updated > 0 && <li>{n(result.updated)} existing contacts updated</li>}
            {result.skipped_existing > 0 && <li>{n(result.skipped_existing)} already existed (unchanged)</li>}
            {result.skipped_duplicates_in_file > 0 && <li>{n(result.skipped_duplicates_in_file)} duplicate rows skipped</li>}
            {result.invalid_rows > 0 && <li>{n(result.invalid_rows)} rows with problems{result.invalid_stored ? `, ${n(result.invalid_stored)} kept as invalid contacts` : ', not imported'}</li>}
            <li>{n(result.consent_records)} consent records</li>
            {result.memberships_added > 0 && <li>{n(result.memberships_added)} added to the group</li>}
          </ul>
          <Link className="btn btn-primary" to="/contacts">
            See contacts
          </Link>
        </section>
      )}
    </>
  );
}
