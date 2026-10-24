import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, adminClient, createAdmin, login, makeApp, resetDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.end();
});
beforeEach(() => resetDb(ctx.db));

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as never, headers });

describe('login', () => {
  it('succeeds with correct credentials and sets an HttpOnly SameSite cookie', async () => {
    const a = await createAdmin(ctx.db);
    const res = await post('/auth/login', { email: a.email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toHaveLength(43);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/smsgw_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('returns the same error for unknown email and wrong password', async () => {
    const a = await createAdmin(ctx.db);
    const wrong = await post('/auth/login', { email: a.email, password: 'not-the-password' });
    const unknown = await post('/auth/login', { email: 'nobody@example.org', password: 'whatever' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toEqual(unknown.json().error);
  });

  it('locks the account after repeated failures', async () => {
    const a = await createAdmin(ctx.db);
    for (let i = 0; i < 5; i++) expect((await post('/auth/login', { email: a.email, password: 'bad' })).statusCode).toBe(401);
    const locked = await post('/auth/login', { email: a.email, password: PASSWORD });
    expect(locked.statusCode).toBe(423);
    const { rows } = await ctx.db.query(`SELECT action FROM audit_logs WHERE actor_id = $1 ORDER BY id`, [a.id]);
    expect(rows.map((r) => r.action)).toContain('auth.account_locked');
  });

  it('refuses inactive accounts', async () => {
    const a = await createAdmin(ctx.db);
    await ctx.db.query('UPDATE administrators SET is_active = false WHERE id = $1', [a.id]);
    expect((await post('/auth/login', { email: a.email, password: PASSWORD })).statusCode).toBe(401);
  });

  it('validates input', async () => {
    const res = await post('/auth/login', { email: 'not-an-email', password: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('sessions', () => {
  it('rejects missing, garbage and revoked tokens', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer ' + 'x'.repeat(43) } })).statusCode).toBe(401);
    const c = await adminClient(ctx.app, ctx.db);
    expect((await c.call('GET', '/auth/me')).statusCode).toBe(200);
    expect((await c.call('POST', '/auth/logout')).statusCode).toBe(200);
    expect((await c.call('GET', '/auth/me')).statusCode).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const c = await adminClient(ctx.app, ctx.db);
    await ctx.db.query(`UPDATE admin_sessions SET expires_at = now() - interval '1 second'`);
    expect((await c.call('GET', '/auth/me')).statusCode).toBe(401);
  });

  it('requires the CSRF header on cookie-authenticated writes, but not on reads or bearer calls', async () => {
    const a = await createAdmin(ctx.db);
    const token = await login(ctx.app, a.email);
    const cookie = { cookie: `smsgw_session=${token}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: cookie })).statusCode).toBe(200);
    const noCsrf = await ctx.app.inject({ method: 'POST', url: '/api/v1/groups', headers: cookie, payload: { name: 'g' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_HEADER_MISSING');
    const withCsrf = await ctx.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { ...cookie, 'x-smsgw-csrf': '1' }, payload: { name: 'g' } });
    expect(withCsrf.statusCode).toBe(201);
  });
});

describe('password change', () => {
  it('blocks everything except change-password until a temporary password is changed', async () => {
    const a = await createAdmin(ctx.db, 'SUPER_ADMIN', { mustChange: true });
    const token = await login(ctx.app, a.email);
    const h = { authorization: `Bearer ${token}` };
    const blocked = await ctx.app.inject({ method: 'GET', url: '/api/v1/contacts', headers: h });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h })).json().must_change_password).toBe(true);

    const weak = await post('/auth/change-password', { current_password: PASSWORD, new_password: 'short' }, h);
    expect(weak.json().error.code).toBe('WEAK_PASSWORD');
    const ok = await post('/auth/change-password', { current_password: PASSWORD, new_password: 'Mbabane-Morning-Mist-77' }, h);
    expect(ok.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/contacts', headers: h })).statusCode).toBe(200);
    expect((await post('/auth/login', { email: a.email, password: 'Mbabane-Morning-Mist-77' })).statusCode).toBe(200);
  });

  it('revokes other sessions after a change', async () => {
    const a = await createAdmin(ctx.db);
    const t1 = await login(ctx.app, a.email);
    const t2 = await login(ctx.app, a.email);
    await post('/auth/change-password', { current_password: PASSWORD, new_password: 'Lobamba-Valley-Rain-31' }, { authorization: `Bearer ${t1}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${t2}` } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${t1}` } })).statusCode).toBe(200);
  });

  it('stores argon2id hashes, never plaintext', async () => {
    const a = await createAdmin(ctx.db);
    const { rows } = await ctx.db.query('SELECT password_hash FROM administrators WHERE id = $1', [a.id]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe('rate limiting', () => {
  it('limits login attempts per IP', async () => {
    const limited = await makeApp({ loginRateLimitPerMinute: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await limited.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x@example.org', password: 'y' } })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.app.close();
      await limited.db.end();
    }
  });
});

describe('security headers and docs', () => {
  it('sends helmet headers and serves OpenAPI', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    const spec = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(Object.keys(spec.json().paths)).toContain('/api/v1/campaigns');
  });
});
