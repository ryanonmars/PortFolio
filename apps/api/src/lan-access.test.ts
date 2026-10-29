import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from './app.js';

const disposals: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.reverse()) await dispose();
  disposals.length = 0;
});
const account = {
  username: 'lan-test-admin',
  password: 'Synthetic-LAN-password-42',
};
async function fixture(options: Partial<Omit<AppOptions, 'dataDir'>> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-lan-'));
  disposals.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const app = await createApp({
    dataDir,
    webRoot: join(dataDir, 'missing-web'),
    ...options,
  });
  disposals.push(() => app.close());
  const counts = () => {
    const db = new DatabaseSync(join(dataDir, 'app.sqlite'), {
      readOnly: true,
    });
    try {
      return {
        users: (
          db.prepare('SELECT count(*) AS count FROM users').get() as {
            count: number;
          }
        ).count,
        sessions: (
          db.prepare('SELECT count(*) AS count FROM sessions').get() as {
            count: number;
          }
        ).count,
      };
    } finally {
      db.close();
    }
  };
  async function client(origin: string) {
    const host = new URL(origin).host;
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { host },
    });
    expect(session.statusCode).toBe(200);
    let cookie = `portfolio_session=${session.cookies[0]!.value}`;
    let csrfToken = session.json().csrfToken as string;
    return {
      session,
      get cookie() {
        return cookie;
      },
      get csrfToken() {
        return csrfToken;
      },
      async post(
        path: string,
        payload?: Record<string, unknown>,
        extra: Record<string, string> = {},
      ) {
        const response = await app.inject({
          method: 'POST',
          url: path,
          payload,
          headers: {
            host,
            origin,
            cookie,
            'x-csrf-token': csrfToken,
            ...extra,
          },
        });
        if (response.cookies[0]?.value)
          cookie = `portfolio_session=${response.cookies[0].value}`;
        if (response.body && response.headers['content-type']?.includes('json'))
          csrfToken = response.json().csrfToken ?? csrfToken;
        return response;
      },
    };
  }
  return { app, counts, client };
}

describe('LAN-first authentication boundaries', () => {
  it('offers real first-run setup through ordinary local addresses without any origin settings', async () => {
    const { app, client } = await fixture();
    for (const host of [
      'localhost:3088',
      '127.0.0.1:3088',
      '192.168.50.10:3088',
      'dockge.truenas:3088',
      'nas.local:8088',
      '100.101.102.103:3088',
      '[fd12::1]:3088',
    ]) {
      const status = await app.inject({
        url: '/api/v1/auth/setup-status',
        headers: { host },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ setupRequired: true });
    }
    const browser = await client('http://dockge.truenas:3088');
    expect(browser.session.headers['set-cookie']).toContain('HttpOnly');
    expect(browser.session.headers['set-cookie']).toContain('SameSite=Strict');
    expect(browser.session.headers['set-cookie']).not.toContain('Domain=');
    expect(Boolean(browser.session.cookies[0]?.secure)).toBe(false);
    const setup = await browser.post('/api/v1/auth/setup', account);
    expect(setup.statusCode).toBe(201);
    expect(setup.json().user.username).toBe(account.username);
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/setup-status',
          headers: { host: '192.168.50.10:3088' },
        })
      ).json(),
    ).toEqual({ setupRequired: false });
    expect(
      (
        await app.inject({
          url: '/api/v1/boards',
          headers: { host: 'dockge.truenas:3088', cookie: browser.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect((await browser.post('/api/v1/auth/logout')).statusCode).toBe(204);
    const again = await client('http://100.101.102.103:3088');
    expect((await again.post('/api/v1/auth/login', account)).statusCode).toBe(
      200,
    );
  });

  it('rejects attacker-controlled public Host values before reads can create sessions or reveal setup', async () => {
    const { app, counts } = await fixture();
    for (const host of [
      'attacker.example.com:3088',
      '127.0.0.1.attacker.example.com:3088',
      'dockge.truenas.attacker.example.com:3088',
      'attacker.zip:3088',
      '8.8.8.8:3088',
    ]) {
      for (const url of ['/api/v1/auth/session', '/api/v1/auth/setup-status']) {
        const rejected = await app.inject({
          url,
          headers: {
            host,
            'x-forwarded-host': 'localhost:3088',
            'x-forwarded-proto': 'https',
            'x-forwarded-for': '127.0.0.1',
          },
        });
        expect(rejected.statusCode).toBe(403);
        expect(rejected.json().error.code).toBe('INVALID_ORIGIN');
        expect(rejected.cookies).toEqual([]);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/setup',
            headers: { host, origin: `http://${host}` },
            payload: account,
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(counts()).toEqual({ users: 0, sessions: 0 });
  });

  it('keeps same-origin and CSRF requirements independent of automatically accepted LAN hosts', async () => {
    const { app, client, counts } = await fixture();
    const browser = await client('http://dockge.truenas:3088');
    for (const origin of [
      '',
      'null',
      'http://attacker.example.com:3088',
      'http://192.168.50.10:3088',
      'http://dockge.truenas:3089',
      'https://dockge.truenas:3088',
      'http://dockge.truenas:3088/path',
      'http://user:password@dockge.truenas:3088',
    ]) {
      const rejected = await browser.post('/api/v1/auth/setup', account, {
        origin,
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.code).toBe('INVALID_ORIGIN');
    }
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: {
        host: 'dockge.truenas:3088',
        cookie: browser.cookie,
        'x-csrf-token': browser.csrfToken,
      },
      payload: account,
    });
    expect(noOrigin.statusCode).toBe(403);
    for (const token of ['', 'forged']) {
      const rejected = await browser.post('/api/v1/auth/setup', account, {
        'x-csrf-token': token,
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.code).toBe('INVALID_CSRF');
    }
    expect(counts().users).toBe(0);
    expect((await browser.post('/api/v1/auth/setup', account)).statusCode).toBe(
      201,
    );
  });

  it('preserves configured HTTPS proxy cookies while leaving direct LAN HTTP available', async () => {
    const { app, client } = await fixture({
      publicOrigin: 'https://device.tail12345.ts.net',
      allowedOrigins: ['https://portfolio.example.com:8443'],
    });
    const local = await client('http://dockge.truenas:3088');
    expect((await local.post('/api/v1/auth/setup', account)).statusCode).toBe(
      201,
    );
    for (const origin of [
      'https://device.tail12345.ts.net',
      'https://portfolio.example.com:8443',
    ]) {
      const browser = await client(origin);
      expect(browser.session.cookies[0]?.secure).toBe(true);
      const login = await browser.post('/api/v1/auth/login', account);
      expect(login.statusCode).toBe(200);
      expect(login.cookies[0]?.secure).toBe(true);
      const logout = await browser.post('/api/v1/auth/logout');
      expect(logout.statusCode).toBe(204);
      expect(logout.cookies[0]?.secure).toBe(true);
    }
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: { host: 'other.tail12345.ts.net' },
        })
      ).statusCode,
    ).toBe(403);
    const forgedTls = await app.inject({
      url: '/api/v1/auth/session',
      headers: {
        host: 'dockge.truenas:3088',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'device.tail12345.ts.net',
      },
    });
    expect(forgedTls.statusCode).toBe(200);
    expect(Boolean(forgedTls.cookies[0]?.secure)).toBe(false);
    const downgrade = await local.post('/api/v1/auth/login', account, {
      host: 'device.tail12345.ts.net',
      origin: 'http://device.tail12345.ts.net',
    });
    expect(downgrade.statusCode).toBe(403);
    expect(downgrade.json().error.code).toBe('INVALID_ORIGIN');
  });

  it('honors optional strict hosts and port limits instead of the automatic LAN policy', async () => {
    const { app, client } = await fixture({
      trustedHosts: ['dockge.truenas:3088'],
    });
    const accepted = await client('http://dockge.truenas:3088');
    expect(
      (await accepted.post('/api/v1/auth/setup', account)).statusCode,
    ).toBe(201);
    for (const host of [
      'localhost:3088',
      '127.0.0.1:3088',
      '192.168.50.10:3088',
      'other.truenas:3088',
      'dockge.truenas:3089',
    ])
      expect(
        (await app.inject({ url: '/api/v1/auth/session', headers: { host } }))
          .statusCode,
      ).toBe(403);
  });
});
