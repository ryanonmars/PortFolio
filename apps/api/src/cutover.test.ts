import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { apiFixture } from '../../../tests/support/api.js';
import { createApp } from './app.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('production board-only route cutover', () => {
  it('does not expose legacy editing or navigation routes in the production default', async () => {
    const client = await apiFixture(false);
    cleanup.push(() => client.close());
    const paths = [
      '/api/v1/workspaces',
      '/api/v1/navigation',
      '/api/v1/device-templates',
    ];
    for (const path of paths) {
      expect((await client.request('GET', path)).statusCode).toBe(404);
      expect(
        (await client.request('POST', path, { name: 'Retired editor' }))
          .statusCode,
      ).toBe(404);
    }
    for (const resource of [
      'devices',
      'ports/bulk-edit',
      'vlans',
      'subnets',
      'racks',
      'connections',
      'logical-connections',
      'import/commit',
    ]) {
      const response = await client.request(
        'POST',
        '/api/v1/sites/legacy/' + resource,
        {},
      );
      expect(response.statusCode, resource + ': ' + response.body).toBe(404);
    }
    expect((await client.request('GET', '/healthz')).json()).toEqual({
      status: 'ok',
    });
    expect(
      (await client.request('GET', '/api/v1/auth/session')).json().user
        .username,
    ).toBe('test_admin');
    const board = await client.request('POST', '/api/v1/boards', {
      name: 'Standalone board',
    });
    expect(board.statusCode).toBe(201);
    expect(board.json().board.groupId).toBeNull();
    expect(
      client.db.prepare('SELECT count(*) n FROM workspaces').get(),
    ).toEqual({ n: 0 });
  });

  it('keeps explicit compatibility tests available while preserving migrated data in the default runtime', async () => {
    const legacy = await apiFixture(true);
    cleanup.push(() => legacy.close());
    const site = await legacy.createSite();
    const device = await legacy.request(
      'POST',
      `/api/v1/sites/${site.id}/devices`,
      { displayName: 'Preserved switch' },
    );
    expect(device.statusCode).toBe(201);
    expect((await legacy.request('GET', '/api/v1/workspaces')).statusCode).toBe(
      200,
    );
    const before = legacy.db
      .prepare('SELECT * FROM devices WHERE site_id=?')
      .all(site.id);
    const production = await createApp({
      dataDir: legacy.dataDir,
      webRoot: join(legacy.dataDir, 'no-web'),
    });
    cleanup.push(() => production.close());
    const headers = {
      host: '127.0.0.1:3088',
      origin: 'http://127.0.0.1:3088',
      cookie: legacy.cookie,
      'x-csrf-token': legacy.csrfToken,
    };
    expect(
      (
        await production.inject({
          method: 'POST',
          url: `/api/v1/sites/${site.id}/devices`,
          headers,
          payload: { displayName: 'Must not write' },
        })
      ).statusCode,
    ).toBe(404);
    const board = await production.inject({
      url: `/api/v1/boards/${site.id}`,
      headers,
    });
    expect(board.statusCode, board.body).toBe(200);
    expect(board.json().board.document.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: device.json().device.id,
          name: 'Preserved switch',
        }),
      ]),
    );
    expect(
      legacy.db.prepare('SELECT * FROM devices WHERE site_id=?').all(site.id),
    ).toEqual(before);
  });

  it('still requires session authentication, same-origin checks and CSRF for canonical board mutations', async () => {
    const client = await apiFixture(false);
    cleanup.push(() => client.close());
    expect(
      (
        await client.app.inject({
          url: '/api/v1/boards',
          headers: { host: '127.0.0.1:3088' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await client.request(
          'POST',
          '/api/v1/boards',
          { name: 'Forged' },
          { 'x-csrf-token': 'forged' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request(
          'POST',
          '/api/v1/boards',
          { name: 'Wrong origin' },
          { origin: 'https://attacker.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    expect((await client.request('GET', '/api/v1/boards')).json()).toEqual({
      boards: [],
      groups: [],
    });
  });
});
