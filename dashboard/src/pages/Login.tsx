import { useState } from 'react';
import { post } from '../api';
import { useAuth } from '../auth';
import { Notice, useAction } from '../util';

export function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const a = useAction();
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await post('/auth/login', { email, password });
            await refresh();
          });
        }}
      >
        <h1>Sign in</h1>
        <p className="muted">SIM SMS Gateway administration</p>
        <label>
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <Notice kind="error">{a.error}</Notice>
        <button className="btn btn-primary" disabled={a.busy}>
          {a.busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">There is no default account. The first administrator is created on the server (see the deployment guide).</p>
      </form>
    </div>
  );
}

export function ChangePassword({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const a = useAction();
  const form = (
    <form
      className={forced ? 'auth-card' : 'panel narrow'}
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== again) return a.setError('The new passwords do not match.');
        void a.run(async () => {
          await post('/auth/change-password', { current_password: current, new_password: next });
          await refresh();
        }, 'Password changed. Other sessions were signed out.');
      }}
    >
      <h1>{forced ? 'Choose your password' : 'Change password'}</h1>
      {forced && <p className="muted">You signed in with a temporary password. Choose your own before continuing.</p>}
      <label>
        Current password
        <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label>
        New password
        <input type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
        <span className="hint">At least 12 characters. A short sentence works well.</span>
      </label>
      <label>
        New password again
        <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <Notice kind="error">{a.error}</Notice>
      <Notice kind="ok">{a.ok}</Notice>
      <button className="btn btn-primary" disabled={a.busy}>
        Change password
      </button>
      {forced && (
        <button type="button" className="linklike" onClick={() => void logout()}>
          Sign out
        </button>
      )}
    </form>
  );
  return forced ? <div className="auth-page">{form}</div> : form;
}
