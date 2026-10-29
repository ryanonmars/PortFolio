import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { hashPassword } from './security.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
const password = 'synthetic-test-password-123';
async function fixture(
  publicOrigin = 'http://127.0.0.1:3088',
  localOrigin?: string,
  allowedOrigins?: readonly string[],
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-auth-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let app = await createApp({
    dataDir,
    publicOrigin,
    localOrigin,
    allowedOrigins,
    webRoot: join(dataDir, 'no-web'),
    enableLegacyEditor: true,
  });
  cleanup.push(() => app.close());
  let cookie = '';
  let csrfToken = '';
  const host = new URL(publicOrigin).host;
  const request = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        host,
        origin: publicOrigin,
        cookie,
        'x-csrf-token': csrfToken,
        ...headers,
      },
      payload,
    });
    const newCookie = response.cookies.find(
      (item) => item.name === 'portfolio_session',
    );
    if (newCookie) cookie = `portfolio_session=${newCookie.value}`;
    if (response.body && response.headers['content-type']?.includes('json')) {
      const body = response.json<{ csrfToken?: string }>();
      if (body.csrfToken) csrfToken = body.csrfToken;
    }
    return response;
  };
  await request('GET', '/api/v1/auth/session');
  return {
    get app() {
      return app;
    },
    dataDir,
    request,
    get cookie() {
      return cookie;
    },
    get csrfToken() {
      return csrfToken;
    },
    setup: () =>
      request('POST', '/api/v1/auth/setup', { username: 'admin', password }),
    restart: async () => {
      await app.close();
      app = await createApp({
        dataDir,
        publicOrigin,
        localOrigin,
        allowedOrigins,
        webRoot: join(dataDir, 'no-web'),
        enableLegacyEditor: true,
      });
    },
  };
}

describe('admin security and organization', () => {
  it('supports independent HTTPS and loopback login sessions without allowing cross-origin writes', async () => {
    const publicOrigin = 'https://portfolio.example';
    const client = await fixture(publicOrigin, 'http://127.0.0.1:3090', [
      'http://192.0.2.64:3090',
      'https://portfolio.internal.example',
    ]);
    await client.setup();
    for (const origin of [
      publicOrigin,
      'http://127.0.0.1:3090',
      'http://localhost:3090',
      'http://192.0.2.64:3090',
      'https://portfolio.internal.example',
    ]) {
      const host = new URL(origin).host;
      const session = await client.app.inject({
        url: '/api/v1/auth/session',
        headers: { host },
      });
      expect(session.statusCode).toBe(200);
      expect(Boolean(session.cookies[0]?.secure)).toBe(
        origin.startsWith('https:'),
      );
      const cookie = `portfolio_session=${session.cookies[0]!.value}`;
      const headers = {
        host,
        origin,
        cookie,
        'x-csrf-token': session.json().csrfToken as string,
      };
      for (const forbidden of [
        {
          origin:
            origin === publicOrigin ? 'http://localhost:3090' : publicOrigin,
        },
        { origin: 'https://attacker.example.com' },
        { 'x-csrf-token': 'forged' },
      ])
        expect(
          (
            await client.app.inject({
              method: 'POST',
              url: '/api/v1/auth/login',
              headers: { ...headers, ...forbidden },
              payload: { username: 'admin', password },
            })
          ).statusCode,
        ).toBe(403);
      const login = await client.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers,
        payload: { username: 'admin', password },
      });
      expect(login.statusCode).toBe(200);
      expect(Boolean(login.cookies[0]?.secure)).toBe(
        origin.startsWith('https:'),
      );
      const loggedIn = `portfolio_session=${login.cookies[0]!.value}`;
      const logout = await client.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          host,
          origin,
          cookie: loggedIn,
          'x-csrf-token': login.json().csrfToken as string,
        },
      });
      expect(logout.statusCode).toBe(204);
      expect(Boolean(logout.cookies[0]?.secure)).toBe(
        origin.startsWith('https:'),
      );
    }
    for (const host of ['203.0.113.1:3091', 'attacker.example.com'])
      expect(
        (
          await client.app.inject({
            url: '/api/v1/auth/session',
            headers: { host, 'x-forwarded-host': 'portfolio.example' },
          })
        ).statusCode,
      ).toBe(403);
  });

  it('rejects malformed or conflicting additional origins before serving', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-allowed-origins-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    for (const allowedOrigins of [
      ['ftp://portfolio.example'],
      ['https://portfolio.example/path'],
      ['https://user:password@portfolio.example'],
      ['https://portfolio.example/'],
      ['https://portfolio.example?query=1'],
      ['http://portfolio.example'],
      ['http://localhost:3090', 'https://127.0.0.1:3090'],
    ])
      await expect(
        createApp({
          dataDir,
          publicOrigin: 'https://portfolio.example',
          allowedOrigins,
        }),
      ).rejects.toThrow('ALLOWED_ORIGINS');
  });

  it('rejects non-loopback and ambiguous local origins', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-local-origin-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    for (const localOrigin of [
      'http://attacker.example.com',
      'https://localhost:3090',
      'http://127.0.0.1:3090/path',
      'http://user:password@localhost:3090',
      'http://localhost:3090',
    ])
      await expect(
        createApp({
          dataDir,
          publicOrigin: 'https://127.0.0.1:3090',
          localOrigin,
        }),
      ).rejects.toThrow('LOCAL_ORIGIN');
  });

  it('rejects absolute-form request targets over real HTTP before setup can run', async () => {
    const client = await fixture();
    const address = await client.app.listen({ host: '127.0.0.1', port: 0 });
    const sendAbsolute = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          address,
          {
            method: 'POST',
            path,
            headers: {
              host: 'attacker.example.com',
              'content-type': 'application/json',
              connection: 'close',
            },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () =>
              resolve({ status: response.statusCode!, body }),
            );
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ username: 'attacker', password }));
      });
    for (const path of [
      'http://attacker.example.com/api/v1/auth/setup',
      '//attacker.example.com/api/v1/auth/setup',
    ]) {
      const response = await sendAbsolute(path);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe(
        'INVALID_REQUEST_TARGET',
      );
    }
    expect(
      (await client.request('GET', '/api/v1/auth/setup-status')).json(),
    ).toEqual({ setupRequired: true });
  });
  it('rejects invalid configured origins before serving requests', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-bad-origin-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    for (const publicOrigin of [
      'ftp://portfolio.example',
      'https://portfolio.example/path',
      'https://user:password@portfolio.example',
      'https://portfolio.example?query=1',
    ]) {
      await expect(createApp({ dataDir, publicOrigin })).rejects.toThrow(
        'PUBLIC_ORIGIN',
      );
    }
  });

  it('bounds simultaneous password hashes to prevent memory exhaustion', async () => {
    const results = await Promise.allSettled([
      hashPassword(password),
      hashPassword(password),
      hashPassword(password),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.statusCode).toBe(
      429,
    );
  });
  it('sets up once, rotates sessions, hashes passwords and returns safe cookies', async () => {
    const client = await fixture();
    const previous = client.cookie;
    expect(
      (await client.request('GET', '/api/v1/auth/setup-status')).json(),
    ).toEqual({ setupRequired: true });
    const setup = await client.setup();
    expect(setup.statusCode).toBe(201);
    expect(setup.json().user.username).toBe('admin');
    expect(client.cookie).not.toBe(previous);
    expect(setup.headers['set-cookie']).toContain('HttpOnly');
    expect(setup.headers['set-cookie']).toContain('SameSite=Strict');
    expect(setup.headers['set-cookie']).toContain('Path=/');
    expect(setup.headers['cache-control']).toBe('no-store');
    expect((await client.setup()).statusCode).toBe(409);
    expect(
      (await client.request('GET', '/api/v1/auth/setup-status')).json(),
    ).toEqual({ setupRequired: false });
    const db = new DatabaseSync(join(client.dataDir, 'app.sqlite'));
    const user = db.prepare('SELECT password_hash FROM users').get() as {
      password_hash: string;
    };
    expect(user.password_hash).toMatch(
      /^scrypt\$131072\$8\$1\$[a-f0-9]{64}\$[a-f0-9]{128}$/,
    );
    expect(user.password_hash).not.toContain(password);
    const session = db.prepare('SELECT token_hash FROM sessions').get() as {
      token_hash: string;
    };
    expect(client.cookie).not.toContain(session.token_hash);
    db.close();
    expect(
      (
        await client.app.inject({
          url: '/api/v1/workspaces',
          headers: { host: '127.0.0.1:3088', cookie: previous },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('only allows one administrator under concurrent setup requests', async () => {
    const client = await fixture();
    const responses = await Promise.all([client.setup(), client.setup()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const db = new DatabaseSync(join(client.dataDir, 'app.sqlite'));
    expect(db.prepare('SELECT count(*) AS count FROM users').get()).toEqual({
      count: 1,
    });
    db.close();
  });

  it('rejects forged CSRF, missing/null origins, wrong hosts, and forwarded host forgery', async () => {
    const client = await fixture();
    const before = client.cookie;
    const forgedHeaders: Record<string, string>[] = [
      { 'x-csrf-token': 'forged' },
      { origin: '' },
      { origin: 'null' },
      { origin: 'https://attacker.example.com' },
      { host: 'attacker.example.com' },
      {
        host: 'attacker.example.com',
        'x-forwarded-host': '127.0.0.1:3088',
        'x-forwarded-proto': 'http',
      },
    ];
    for (const headers of forgedHeaders) {
      const response = await client.request(
        'POST',
        '/api/v1/auth/setup',
        { username: 'admin', password },
        headers,
      );
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: expect.any(String),
        message: expect.any(String),
      });
    }
    expect(client.cookie).toBe(before);
    expect((await client.request('GET', '/api/v1/workspaces')).statusCode).toBe(
      401,
    );
    expect(
      (
        await client.app.inject({
          url: '/api/v1/auth/session',
          headers: { host: 'attacker.example.com' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('protects encoded API paths by their resolved route identity', async () => {
    const client = await fixture();
    for (const url of ['/%61pi/v1/auth/session', '/api/%761/auth/session']) {
      const response = await client.app.inject({
        url,
        headers: { host: 'attacker.example.com' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'INVALID_ORIGIN',
          message: 'Request origin is not allowed',
        },
      });
    }
    expect((await client.request('GET', '/api/v1/workspaces')).json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
    });
  });

  it('logs in with generic failures, logs out, and invalidates the previous cookie', async () => {
    const client = await fixture();
    await client.setup();
    const originalCookie = client.cookie;
    expect(
      (await client.request('POST', '/api/v1/auth/logout')).statusCode,
    ).toBe(204);
    expect(
      (
        await client.app.inject({
          url: '/api/v1/workspaces',
          headers: { host: '127.0.0.1:3088', cookie: originalCookie },
        })
      ).statusCode,
    ).toBe(401);
    await client.request('GET', '/api/v1/auth/session');
    const unknown = await client.request('POST', '/api/v1/auth/login', {
      username: 'unknown',
      password,
    });
    const wrong = await client.request('POST', '/api/v1/auth/login', {
      username: 'admin',
      password: 'incorrect-password',
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    const login = await client.request('POST', '/api/v1/auth/login', {
      username: 'ADMIN',
      password,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe('admin');
  });

  it('rate limits repeated login attempts', async () => {
    const client = await fixture();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await client.request('POST', '/api/v1/auth/login', {
        username: 'unknown',
        password,
      });
      statuses.push(response.statusCode);
      if (attempt === 5)
        expect(response.json()).toEqual({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts. Try again later',
          },
        });
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('returns the agreed error envelope for authentication, CSRF, validation and conflicts', async () => {
    const client = await fixture();
    expect((await client.request('GET', '/api/v1/workspaces')).json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
    });
    expect(
      (
        await client.request(
          'POST',
          '/api/v1/auth/setup',
          { username: 'admin', password },
          { 'x-csrf-token': 'forged' },
        )
      ).json(),
    ).toEqual({
      error: {
        code: 'INVALID_CSRF',
        message: 'Refresh the page and try again',
      },
    });
    await client.setup();
    expect(
      (await client.request('POST', '/api/v1/workspaces', { name: '' })).json(),
    ).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Check the supplied fields',
        fieldErrors: { name: [expect.any(String)] },
      },
    });
    await client.request('POST', '/api/v1/workspaces', { name: 'Home' });
    expect(
      (
        await client.request('POST', '/api/v1/workspaces', { name: 'Home' })
      ).json(),
    ).toEqual({
      error: { code: 'DUPLICATE_NAME', message: 'That name is already in use' },
    });
  });

  it('uses Secure cookies for HTTPS and rejects expired sessions', async () => {
    const client = await fixture('https://portfolio.example');
    const setup = await client.setup();
    expect(setup.headers['set-cookie']).toContain('Secure');
    const db = new DatabaseSync(join(client.dataDir, 'app.sqlite'));
    db.prepare('UPDATE sessions SET expires_at = 0').run();
    db.close();
    expect((await client.request('GET', '/api/v1/workspaces')).statusCode).toBe(
      401,
    );
    const session = await client.request('GET', '/api/v1/auth/session');
    expect(session.json().user).toBeNull();
  });

  it('creates rack-free sites, isolates workspace lists, guards deletes and detects stale updates', async () => {
    const client = await fixture();
    await client.setup();
    const a = (
      await client.request('POST', '/api/v1/workspaces', { name: 'Home' })
    ).json().workspace;
    const b = (
      await client.request('POST', '/api/v1/workspaces', { name: 'Work' })
    ).json().workspace;
    expect(
      (await client.request('POST', '/api/v1/workspaces', { name: 'home' }))
        .statusCode,
    ).toBe(409);
    const siteResponse = await client.request(
      'POST',
      `/api/v1/workspaces/${a.id}/sites`,
      { name: 'Lab', notes: '<script>inert</script>' },
    );
    expect(siteResponse.statusCode).toBe(201);
    const site = siteResponse.json().site;
    expect(site.workspaceId).toBe(a.id);
    expect(
      (await client.request('GET', `/api/v1/workspaces/${b.id}/sites`)).json(),
    ).toEqual({ sites: [] });
    expect(
      (
        await client.request('POST', '/api/v1/workspaces/missing/sites', {
          name: 'Bad',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request('PATCH', `/api/v1/sites/${site.id}`, {
          workspaceId: b.id,
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(400);
    const updated = await client.request('PATCH', `/api/v1/sites/${site.id}`, {
      name: 'Renamed',
      rowVersion: 1,
    });
    expect(updated.json().site.rowVersion).toBe(2);
    expect(
      (
        await client.request('PATCH', `/api/v1/sites/${site.id}`, {
          name: 'Lost',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('DELETE', `/api/v1/sites/${site.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'GET',
          `/api/v1/workspaces/${a.id}/deletion-impact`,
        )
      ).json().impact.sites,
    ).toBe(1);
    expect(
      (
        await client.request('PATCH', `/api/v1/workspaces/${b.id}`, {
          name: 'Office',
          rowVersion: 1,
        })
      ).json().workspace.rowVersion,
    ).toBe(2);
    expect(
      (
        await client.request('DELETE', `/api/v1/workspaces/${b.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await client.request('GET', '/api/v1/sites/missing')).statusCode,
    ).toBe(404);
    expect(
      (await client.request('GET', `/api/v1/sites/${site.id}`)).json().site
        .notes,
    ).toBe('<script>inert</script>');
    expect(
      (
        await client.request('DELETE', `/api/v1/sites/${site.id}`, {
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await client.request('DELETE', `/api/v1/workspaces/${a.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
  });

  it('retains authenticated sessions, workspaces and sites across server restart', async () => {
    const client = await fixture();
    await client.setup();
    const workspace = (
      await client.request('POST', '/api/v1/workspaces', { name: 'Persistent' })
    ).json().workspace;
    const site = (
      await client.request('POST', `/api/v1/workspaces/${workspace.id}/sites`, {
        name: 'Stored',
      })
    ).json().site;
    await client.restart();
    expect(
      (await client.request('GET', '/api/v1/auth/session')).json().user
        .username,
    ).toBe('admin');
    expect(
      (await client.request('GET', `/api/v1/sites/${site.id}`)).json().site,
    ).toEqual(site);
  });
});
