import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
describe('authenticated navigation metadata', () => {
  it('returns the complete cross-workspace hierarchy without network or account secrets', async () => {
    const client = await apiFixture();
    clients.push(client);
    const a = await client.createSite('Same name');
    const b = await client.createSite('Same name');
    const device = (
      await client.request('POST', `/api/v1/sites/${b.id}/devices`, {
        displayName: 'Router',
        managementIp: '192.0.2.1',
        serial: 'private-serial',
        description: 'private-device-notes',
      })
    ).json().device;
    const response = await client.request('GET', '/api/v1/navigation');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const data = response.json();
    expect(data.workspaces).toHaveLength(2);
    expect(data.sites).toHaveLength(2);
    expect(data.sites).toEqual(
      expect.arrayContaining([
        { id: a.id, workspaceId: a.workspaceId, name: a.name },
        { id: b.id, workspaceId: b.workspaceId, name: b.name },
      ]),
    );
    expect(data.devices).toEqual([
      {
        id: device.id,
        siteId: b.id,
        displayName: 'Router',
        type: device.type,
        orderIndex: 0,
      },
    ]);
    for (const key of [
      'managementIp',
      'serial',
      'description',
      'notes',
      'users',
      'sessions',
      'password',
      'csrf',
      'ports',
      'private-',
    ])
      expect(response.body).not.toContain(key);
    await client.request(
      'PATCH',
      `/api/v1/sites/${b.id}/devices/${device.id}`,
      { rowVersion: 1, displayName: 'Renamed router' },
    );
    expect(
      (await client.request('GET', '/api/v1/navigation')).json().devices[0]
        .displayName,
    ).toBe('Renamed router');
    expect(
      (
        await client.request('DELETE', `/api/v1/workspaces/${b.workspaceId}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
    const remaining = (
      await client.request('GET', '/api/v1/navigation')
    ).json();
    expect(remaining.sites).toEqual([
      { id: a.id, workspaceId: a.workspaceId, name: a.name },
    ]);
    expect(remaining.devices).toEqual([]);
  });
  it('rejects anonymous and wrong-host reads', async () => {
    const client = await apiFixture();
    clients.push(client);
    expect(
      (
        await client.app.inject({
          url: '/api/v1/navigation',
          headers: { host: '127.0.0.1:3088' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await client.request('GET', '/api/v1/navigation', undefined, {
          host: 'foreign.example',
        })
      ).statusCode,
    ).toBe(403);
  });
});
