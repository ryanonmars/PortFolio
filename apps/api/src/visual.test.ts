import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import type { Device } from '../../../packages/shared/src/index.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

describe('M4 canonical equipment order', () => {
  it('atomically orders the full site, preserves equipment/ports and survives restart', async () => {
    const client = await apiFixture();
    clients.push(client);
    const site = await client.createSite();
    const base = `/api/v1/sites/${site.id}/devices`;
    const devices: Device[] = [];
    for (const displayName of ['Router', 'Switch', 'Server']) {
      devices.push(
        (await client.request('POST', base, { displayName })).json().device,
      );
    }
    const generated = await client.request(
      'POST',
      `${base}/${devices[0]!.id}/ports/generate`,
      { count: 8, rowVersion: 1 },
    );
    devices[0] = generated.json().device;
    const ports = generated.json().ports;
    const order = [devices[2]!, devices[0]!, devices[1]!];
    const response = await client.request('POST', `${base}/reorder`, {
      devices: order.map(({ id, rowVersion }) => ({ id, rowVersion })),
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved: Device[] = response.json().devices;
    expect(saved.map((device) => device.id)).toEqual(
      order.map((device) => device.id),
    );
    expect(saved.map((device) => device.orderIndex)).toEqual([0, 1, 2]);
    expect(saved.map((device) => device.rowVersion)).toEqual(
      order.map((device) => device.rowVersion + 1),
    );
    expect(
      (await client.request('GET', `${base}/${devices[0]!.id}/ports`)).json()
        .ports,
    ).toEqual(ports);
    await client.restart();
    expect((await client.request('GET', base)).json().devices).toEqual(saved);
    // A stale participant must roll back the entire proposed order.
    const stale = await client.request('POST', `${base}/reorder`, {
      devices: saved.toReversed().map(({ id, rowVersion }, index) => ({
        id,
        rowVersion: index === 1 ? rowVersion - 1 : rowVersion,
      })),
    });
    expect(stale.statusCode).toBe(409);
    expect((await client.request('GET', base)).json().devices).toEqual(saved);
  });

  it('rejects incomplete, foreign, duplicate and unauthorized lists without changing either site', async () => {
    const client = await apiFixture();
    clients.push(client);
    const site = await client.createSite();
    const other = await client.createSite('Other');
    const base = `/api/v1/sites/${site.id}/devices`;
    const foreignBase = `/api/v1/sites/${other.id}/devices`;
    const local: Device = (
      await client.request('POST', base, { displayName: 'Local' })
    ).json().device;
    const foreign: Device = (
      await client.request('POST', foreignBase, { displayName: 'Foreign' })
    ).json().device;
    const item = { id: local.id, rowVersion: 1 };
    for (const [devices, status] of [
      [[], 409],
      [[{ id: foreign.id, rowVersion: 1 }], 409],
      [[item, item], 400],
    ] as const) {
      const response = await client.request('POST', `${base}/reorder`, {
        devices,
      });
      expect(response.statusCode, response.body).toBe(status);
    }
    expect(
      (
        await client.request(
          'POST',
          `${base}/reorder`,
          { devices: [item] },
          { cookie: '' },
        )
      ).statusCode,
    ).toBe(403);
    expect((await client.request('GET', base)).json().devices).toEqual([local]);
    expect((await client.request('GET', foreignBase)).json().devices).toEqual([
      foreign,
    ]);
    expect(
      (
        await client.request('POST', `${foreignBase}/reorder`, {
          devices: [{ id: foreign.id, rowVersion: 1 }],
          unknown: true,
        })
      ).statusCode,
    ).toBe(400);
  });
});
