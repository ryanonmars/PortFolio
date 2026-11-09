import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import { registerSecurity } from './security.js';
const clients: Awaited<ReturnType<typeof apiFixture>>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture(false);
  clients.push(client);
  return client;
}
it('creates one-time secrets, stores only hashes, lists metadata and revokes user-bound tokens', async () => {
  const c = await fixture();
  const created = await c.request('POST', '/api/v1/api-tokens', {
    name: 'Documentation assistant',
    access: 'read',
  });
  expect(created.statusCode).toBe(201);
  const { token, plaintextToken } = created.json();
  expect(plaintextToken).toMatch(/^pf_[a-f0-9]{64}$/);
  expect(
    JSON.stringify(c.db.prepare('SELECT * FROM personal_api_tokens').all()),
  ).not.toContain(plaintextToken);
  const list = await c.request('GET', '/api/v1/api-tokens');
  expect(list.json().tokens).toEqual([token]);
  expect(list.body).not.toContain(plaintextToken);
  await c.restart();
  expect((await c.request('GET', '/api/v1/api-tokens')).json().tokens).toEqual([
    token,
  ]);
  c.db.exec('PRAGMA ignore_check_constraints = ON');
  c.db
    .prepare(
      'INSERT INTO users(id,admin_slot,username,password_hash,created_at,updated_at) VALUES (?,2,?,?,?,?)',
    )
    .run('other', 'other', 'unused', 1, 1);
  c.db.exec('PRAGMA ignore_check_constraints = OFF');
  c.db
    .prepare('UPDATE personal_api_tokens SET user_id = ? WHERE id = ?')
    .run('other', token.id);
  expect((await c.request('GET', '/api/v1/api-tokens')).json().tokens).toEqual(
    [],
  );
  expect(
    (await c.request('DELETE', `/api/v1/api-tokens/${token.id}`)).statusCode,
  ).toBe(404);
  c.db
    .prepare(
      'UPDATE personal_api_tokens SET user_id = (SELECT id FROM users WHERE username = ?) WHERE id = ?',
    )
    .run('test_admin', token.id);
  expect(
    (await c.request('DELETE', `/api/v1/api-tokens/${token.id}`)).statusCode,
  ).toBe(204);
  expect(
    c.db
      .prepare('SELECT revoked_at FROM personal_api_tokens WHERE id = ?')
      .get(token.id)?.revoked_at,
  ).toEqual(expect.any(Number));
});
it('requires cookie CSRF for token management and rejects invalid inputs and active-token overflow', async () => {
  const c = await fixture();
  for (const input of [
    { name: '', access: 'read' },
    { name: 'test', access: 'admin' },
    { name: 'test', access: 'read', expiresAt: 0 },
    { name: 'test', access: 'read', extra: true },
  ])
    expect(
      (await c.request('POST', '/api/v1/api-tokens', input)).statusCode,
    ).toBe(400);
  expect(
    (
      await c.request(
        'POST',
        '/api/v1/api-tokens',
        { name: 'test', access: 'read' },
        { 'x-csrf-token': 'bad' },
      )
    ).statusCode,
  ).toBe(403);
  for (let i = 0; i < 10; i++)
    expect(
      (
        await c.request('POST', '/api/v1/api-tokens', {
          name: `Token ${i}`,
          access: 'read',
        })
      ).statusCode,
    ).toBe(201);
  expect(
    (
      await c.request('POST', '/api/v1/api-tokens', {
        name: 'Overflow',
        access: 'read',
      })
    ).statusCode,
  ).toBe(409);
});
it('isolates bearer auth, enforces permissions, transport, expiration, revocation and disabled users', async () => {
  const c = await fixture();
  const made = await c.request('POST', '/api/v1/api-tokens', {
    name: 'Agent',
    access: 'read',
  });
  expect(made.statusCode).toBe(201);
  const { token, plaintextToken } = made.json();
  async function server(allow = false, publicOrigin?: string) {
    const app = Fastify();
    const security = await registerSecurity(
      app,
      c.db,
      publicOrigin,
      undefined,
      [],
      undefined,
      allow,
    );
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as { statusCode?: number }).statusCode ?? 500)
        .send({ error: (error as Error).message }),
    );
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const)
      app.route({
        method,
        url: '/api/v1/integration/check',
        preHandler: async (r) => {
          security.requireIntegrationAuth(r);
        },
        handler: (r) => security.requireIntegrationAuth(r),
      });
    app.post('/api/v1/integration/proposals/validate', (r) =>
      security.requireIntegrationAuth(r),
    );
    app.get('/api/v1/boards', (r) => security.requireAuth(r));
    return app;
  }
  const headers = {
    host: '127.0.0.1:3088',
    authorization: `Bearer ${plaintextToken}`,
  };
  expect(
    (await c.app.inject({ url: '/api/v1/api-tokens', headers })).statusCode,
  ).toBe(401);
  for (const url of ['/api/v1/auth/logout', '/api/v1/api-tokens'])
    expect(
      (await c.app.inject({ method: 'POST', url, headers })).statusCode,
    ).toBe(403);
  expect(
    (
      await c.app.inject({
        method: 'DELETE',
        url: '/api/v1/boards/nonexistent',
        headers,
      })
    ).statusCode,
  ).toBe(403);
  const strict = await server();
  expect(
    (await strict.inject({ url: '/api/v1/integration/check', headers }))
      .statusCode,
  ).toBe(403);
  await strict.close();
  const proxy = await server(false, 'https://portfolio.example');
  expect(
    (
      await proxy.inject({
        url: '/api/v1/integration/check',
        headers: { ...headers, host: 'portfolio.example' },
      })
    ).statusCode,
  ).toBe(200);
  await proxy.close();
  const publicHttp = await server(true, 'http://portfolio.com');
  expect(
    (
      await publicHttp.inject({
        url: '/api/v1/integration/check',
        headers: { ...headers, host: 'portfolio.com' },
      })
    ).statusCode,
  ).toBe(403);
  await publicHttp.close();
  const app = await server(true);
  try {
    expect(
      (await app.inject({ url: '/api/v1/boards', headers })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/v1/integration/check',
          headers: { host: headers.host, cookie: c.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/v1/integration/check',
          headers: {
            ...headers,
            authorization: 'Bearer invalid',
            cookie: c.cookie,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/v1/integration/check',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/%61pi/v1/integration/check',
          headers: { ...headers, host: 'evil.com' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/integration/check', headers })).json(),
    ).toMatchObject({ tokenId: token.id, access: 'read' });
    expect(
      c.db
        .prepare('SELECT last_used_at FROM personal_api_tokens WHERE id=?')
        .get(token.id)?.last_used_at,
    ).toEqual(expect.any(Number));
    for (const method of ['POST', 'PATCH', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: '/api/v1/integration/check',
            headers,
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/integration/proposals/validate',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    c.db
      .prepare('UPDATE personal_api_tokens SET access = ? WHERE id = ?')
      .run('write', token.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/integration/check',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    for (const sql of [
      'UPDATE personal_api_tokens SET expires_at=0',
      'UPDATE personal_api_tokens SET expires_at=NULL, revoked_at=1',
      'UPDATE personal_api_tokens SET revoked_at=NULL; UPDATE users SET disabled=1',
    ]) {
      c.db.exec(sql);
      expect(
        (await app.inject({ url: '/api/v1/integration/check', headers }))
          .statusCode,
      ).toBe(401);
    }
    c.db.exec('UPDATE users SET disabled=0');
    const limited = await server(true);
    const statuses: number[] = [];
    for (let index = 0; index < 121; index++)
      statuses.push(
        (await limited.inject({ url: '/api/v1/integration/check', headers }))
          .statusCode,
      );
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 120)).toEqual(Array(120).fill(200));
    await limited.close();
  } finally {
    await app.close();
  }
});
