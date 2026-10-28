import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  Device,
  Port,
  Site,
  Vlan,
} from '../../../packages/shared/src/index.js';
import { apiFixture } from '../../../tests/support/api.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture();
  clients.push(client);
  return client;
}
const base = (site: Site) => '/api/v1/sites/' + site.id;

describe('append reusable port layouts', () => {
  it('appends ordered mixed connector/face groups atomically and increments the device once', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const original = await port(client, site, parent);
    const path = base(site) + `/devices/${parent.id}/ports/from-template`;
    const response = await client.request('POST', path, {
      rowVersion: 2,
      groups: [
        { count: 1, kind: 'rj45', speed: '1G', mode: 'access' },
        {
          count: 2,
          kind: 'sfp_plus',
          speed: '10G',
          mode: 'routed',
          face: 'rear',
          namePrefix: 'Uplink ',
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().device.rowVersion).toBe(3);
    expect(
      response
        .json()
        .ports.map((item: Port) => [
          item.name,
          item.orderIndex,
          item.kind,
          item.mode,
          item.face,
        ]),
    ).toEqual([
      ['Port 2', 1, 'rj45', 'access', 'front'],
      ['Uplink 3', 2, 'sfp_plus', 'routed', 'rear'],
      ['Uplink 4', 3, 'sfp_plus', 'routed', 'rear'],
    ]);
    expect(await readPort(client, site, original.id)).toEqual(original);
    const before = (
      await client.request('GET', base(site) + `/devices/${parent.id}/ports`)
    ).json();
    expect(
      (
        await client.request('POST', path, {
          rowVersion: 2,
          groups: [{ count: 1 }],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('GET', base(site) + `/devices/${parent.id}/ports`)
      ).json(),
    ).toEqual(before);
    await client.restart();
    expect(
      (
        await client.request('GET', base(site) + `/devices/${parent.id}/ports`)
      ).json(),
    ).toEqual(before);
  });
  it('rejects empty, cross-site, duplicate-name and late-failure appends without changing original records', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const other = await client.createSite('Other');
    const parent = await device(client, site);
    const original = await port(client, site, parent, 'Port 2');
    const path = base(site) + `/devices/${parent.id}/ports/from-template`;
    expect(
      (await client.request('POST', path, { rowVersion: 2, groups: [] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await client.request(
          'POST',
          base(other) + `/devices/${parent.id}/ports/from-template`,
          { rowVersion: 2, groups: [{ count: 1 }] },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request('POST', path, {
          rowVersion: 2,
          groups: [{ count: 1 }],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'POST',
          path,
          { rowVersion: 2, groups: [{ count: 1 }] },
          { 'x-csrf-token': 'invalid' },
        )
      ).statusCode,
    ).toBe(403);
    client.db.exec(
      "CREATE TRIGGER fail_append_layout BEFORE INSERT ON ports WHEN NEW.order_index=3 BEGIN SELECT RAISE(ABORT,'Synthetic late append failure'); END;",
    );
    expect(
      (
        await client.request('POST', path, {
          rowVersion: 2,
          groups: [{ count: 3, namePrefix: 'New ' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request('GET', base(site) + `/devices/${parent.id}/ports`)
      ).json().ports,
    ).toEqual([original]);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(2);
  });
  it('enforces existing capacity and legal final order positions at their boundaries', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    await port(client, site, parent);
    const path = base(site) + `/devices/${parent.id}/ports/from-template`;
    const fill = await client.request('POST', path, {
      rowVersion: 2,
      groups: [{ count: 256 }, { count: 255, kind: 'qsfp', face: 'rear' }],
    });
    expect(fill.statusCode, fill.body).toBe(201);
    expect(fill.json().ports).toHaveLength(511);
    expect(fill.json().ports.at(-1)).toMatchObject({
      name: 'Port 512',
      orderIndex: 511,
    });
    expect(
      (
        await client.request('POST', path, {
          rowVersion: 3,
          groups: [{ count: 1 }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(3);
    const edge = await device(client, site, 'Order boundary');
    const last = await port(client, site, edge, 'Last', { orderIndex: 65535 });
    expect(
      (
        await client.request(
          'POST',
          base(site) + `/devices/${edge.id}/ports/from-template`,
          { rowVersion: 2, groups: [{ count: 1 }] },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request('GET', base(site) + `/devices/${edge.id}/ports`)
      ).json().ports,
    ).toEqual([last]);
    expect((await readDevice(client, site, edge.id)).rowVersion).toBe(2);
  });
});
async function device(
  client: Fixture,
  site: Site,
  displayName = 'Switch',
  fields: Record<string, unknown> = {},
): Promise<Device> {
  const result = await client.request('POST', base(site) + '/devices', {
    displayName,
    ...fields,
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json().device;
}
async function port(
  client: Fixture,
  site: Site,
  parent: Device,
  name = 'Port 1',
  fields: Record<string, unknown> = {},
): Promise<Port> {
  const result = await client.request(
    'POST',
    base(site) + '/devices/' + parent.id + '/ports',
    { name, ...fields },
  );
  expect(result.statusCode, result.body).toBe(201);
  return result.json().port;
}
async function vlan(
  client: Fixture,
  site: Site,
  vlanId: number,
): Promise<Vlan> {
  const result = await client.request('POST', base(site) + '/vlans', {
    vlanId,
    name: 'VLAN ' + vlanId,
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json().vlan;
}
async function readDevice(
  client: Fixture,
  site: Site,
  id: string,
): Promise<Device> {
  return (await client.request('GET', base(site) + '/devices/' + id)).json()
    .device;
}
async function readPort(
  client: Fixture,
  site: Site,
  id: string,
): Promise<Port> {
  return (await client.request('GET', base(site) + '/ports/' + id)).json().port;
}
async function listPorts(
  client: Fixture,
  site: Site,
  id: string,
): Promise<Port[]> {
  return (
    await client.request('GET', base(site) + '/devices/' + id + '/ports')
  ).json().ports;
}

describe('M2 equipment and ports', () => {
  it('documents unassigned, native and tagged WAN encapsulation without changing the routed mode', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site, 'WAN router', { type: 'router' });
    const unassigned = await port(client, site, parent, 'Unassigned WAN', {
      mode: 'routed',
    });
    expect(unassigned).toMatchObject({
      mode: 'routed',
      nativeVlanRef: null,
      taggedVlanRefs: [],
      pvid: null,
    });
    const a = await vlan(client, site, 20);
    const b = await vlan(client, site, 30);
    const native = await port(client, site, parent, 'Native WAN', {
      mode: 'routed',
      nativeVlanRef: a.id,
    });
    expect(native).toMatchObject({
      mode: 'routed',
      nativeVlanRef: a.id,
      taggedVlanRefs: [],
      pvid: null,
    });
    const tagged = await port(client, site, parent, 'Tagged WAN', {
      mode: 'routed',
      taggedVlanRefs: [b.id],
    });
    expect(tagged).toMatchObject({
      mode: 'routed',
      nativeVlanRef: null,
      taggedVlanRefs: [b.id],
    });
    const trunk = await port(client, site, parent, 'Documented encapsulation', {
      mode: 'trunk',
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
      pvid: 4092,
      description: 'Explicit WAN encapsulation',
    });
    const changed = await client.request(
      'PATCH',
      base(site) + '/ports/' + trunk.id,
      { mode: 'routed', rowVersion: 1 },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const routed = changed.json().port as Port;
    expect(routed).toMatchObject({
      mode: 'routed',
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
      pvid: 4092,
      description: trunk.description,
      rowVersion: 2,
    });
    await client.restart();
    expect(await readPort(client, site, routed.id)).toEqual(routed);
  });

  it('rejects routed VLAN overlap, duplicate tags and cross-site encapsulation atomically', async () => {
    const client = await fixture();
    const site = await client.createSite('WAN site');
    const foreignSite = await client.createSite('Other site');
    const parent = await device(client, site);
    const a = await vlan(client, site, 20);
    const b = await vlan(client, site, 30);
    const foreign = await vlan(client, foreignSite, 20);
    const original = await port(client, site, parent, 'WAN', {
      mode: 'routed',
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
      pvid: 4092,
    });
    const path = base(site) + '/ports/' + original.id;
    for (const input of [
      { taggedVlanRefs: [a.id] },
      { taggedVlanRefs: [b.id, b.id] },
      { nativeVlanRef: foreign.id },
      { taggedVlanRefs: [foreign.id] },
    ]) {
      expect(
        (await client.request('PATCH', path, { ...input, rowVersion: 1 }))
          .statusCode,
      ).toBe(400);
      expect(await readPort(client, site, original.id)).toEqual(original);
      const created = await client.request(
        'POST',
        base(site) + '/devices/' + parent.id + '/ports',
        { name: 'Invalid WAN', mode: 'routed', nativeVlanRef: a.id, ...input },
      );
      expect(created.statusCode).toBe(400);
      expect(await listPorts(client, site, parent.id)).toEqual([original]);
      expect((await readDevice(client, site, parent.id)).rowVersion).toBe(2);
    }
  });

  it('accepts only one competing generation against the same device version', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const path = base(site) + '/devices/' + parent.id + '/ports/generate';
    const responses = await Promise.all([
      client.request('POST', path, { count: 8, rowVersion: 1 }),
      client.request('POST', path, { count: 8, rowVersion: 1 }),
    ]);
    expect(responses.map((result) => result.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(await listPorts(client, site, parent.id)).toHaveLength(8);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(2);
  });

  it('creates network-independent devices and validates optional metadata and duplicate names', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const router = await device(client, site, 'Router', { type: 'router' });
    expect(router).toMatchObject({
      rackId: null,
      managementIp: '',
      serial: '',
      mac: '',
      tags: [],
      rowVersion: 1,
    });
    const custom = await device(client, site, 'Custom', {
      type: 'custom',
      tags: ['shelf'],
      managementIp: '2001:db8::1',
    });
    const update = await client.request(
      'PATCH',
      base(site) + '/devices/' + custom.id,
      { model: 'XR', orderIndex: 8, rowVersion: 1 },
    );
    expect(update.statusCode).toBe(200);
    expect(update.json().device).toMatchObject({
      model: 'XR',
      orderIndex: 8,
      rowVersion: 2,
      tags: ['shelf'],
    });
    expect(
      (
        await client.request('POST', base(site) + '/devices', {
          displayName: 'router',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('PATCH', base(site) + '/devices/' + custom.id, {
          model: 'Old',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('POST', base(site) + '/devices', {
          displayName: 'Bad',
          managementIp: 'not an IP',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request('POST', base(site) + '/devices', {
          displayName: 'Bad',
          siteId: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await client.request('GET', base(site) + '/devices'))
        .json()
        .devices.map((item: Device) => item.id),
    ).toEqual([router.id, custom.id]);
  });

  it('generates 8/11/24/48 ports with unknown documented state and supports mixed connectors and routed WAN', async () => {
    const client = await fixture();
    const site = await client.createSite();
    for (const count of [8, 11, 24, 48]) {
      const parent = await device(client, site, 'Device ' + count, {
        type: count === 11 ? 'router' : 'switch',
      });
      const result = await client.request(
        'POST',
        base(site) + '/devices/' + parent.id + '/ports/generate',
        { count, rowVersion: 1 },
      );
      expect(result.statusCode, result.body).toBe(201);
      const generated = result.json().ports as Port[];
      expect(generated).toHaveLength(count);
      expect(result.json().device.rowVersion).toBe(2);
      expect(generated[0]).toMatchObject({
        name: 'Port 1',
        orderIndex: 0,
        kind: 'rj45',
        mode: 'other',
        documentedLinkState: 'unknown',
        pvid: null,
        nativeVlanRef: null,
        taggedVlanRefs: [],
      });
      expect(generated.at(-1)?.name).toBe('Port ' + count);
      if (count === 11) {
        const wan = await client.request(
          'PATCH',
          base(site) + '/ports/' + generated[3]!.id,
          { mode: 'routed', description: 'WAN uplink', rowVersion: 1 },
        );
        expect(wan.statusCode).toBe(200);
        expect(wan.json().port).toMatchObject({
          mode: 'routed',
          nativeVlanRef: null,
          taggedVlanRefs: [],
        });
        for (const [index, kind] of [
          [0, 'sfp_plus'],
          [1, 'sfp_plus'],
          [2, 'sfp'],
        ] as const)
          expect(
            (
              await client.request(
                'PATCH',
                base(site) + '/ports/' + generated[index]!.id,
                { kind, rowVersion: 1 },
              )
            ).statusCode,
          ).toBe(200);
      }
    }
  });

  it('rolls back the complete generation on collisions and rejects stale parent versions', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const existing = await port(client, site, parent, 'Port 3');
    const path = base(site) + '/devices/' + parent.id + '/ports/generate';
    const collision = await client.request('POST', path, {
      count: 4,
      rowVersion: 2,
    });
    expect(collision.statusCode, collision.body).toBe(409);
    expect(
      (await listPorts(client, site, parent.id)).map((item) => item.id),
    ).toEqual([existing.id]);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(2);
    const fresh = await client.request('POST', path, {
      count: 2,
      startNumber: 4,
      namePrefix: 'eth',
      kind: 'sfp_plus',
      speed: '10G',
      rowVersion: 2,
    });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().ports.map((item: Port) => item.name)).toEqual([
      'eth4',
      'eth5',
    ]);
    expect(
      (
        await client.request('POST', path, {
          count: 1,
          startNumber: 6,
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(409);
    expect(await listPorts(client, site, parent.id)).toHaveLength(3);
  });

  it('bounds generation counts and the total device port capacity atomically', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const path = base(site) + '/devices/' + parent.id + '/ports/generate';
    for (const input of [
      { count: 0 },
      { count: 257 },
      { count: 1.5 },
      { count: 2, startNumber: 65535 },
      { count: 1, startNumber: 0 },
    ])
      expect(
        (await client.request('POST', path, { ...input, rowVersion: 1 }))
          .statusCode,
      ).toBe(400);
    expect(await listPorts(client, site, parent.id)).toHaveLength(0);
    expect(
      (await client.request('POST', path, { count: 256, rowVersion: 1 }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await client.request('POST', path, {
          count: 256,
          startNumber: 257,
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await client.request('POST', path, {
          count: 1,
          startNumber: 513,
          rowVersion: 3,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request(
          'POST',
          base(site) + '/devices/' + parent.id + '/ports',
          { name: 'Extra' },
        )
      ).statusCode,
    ).toBe(400);
    expect(await listPorts(client, site, parent.id)).toHaveLength(512);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(3);
  });

  it('validates whole port configurations, preserves explicit PVID and supports deliberate native/tag swaps', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const a = await vlan(client, site, 1);
    const b = await vlan(client, site, 20);
    const original = await port(client, site, parent, 'Trunk', {
      mode: 'trunk',
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
      pvid: 30,
      description: 'Explicit PVID',
      documentedLinkState: 'up',
      externalDestinationLabel: 'Unstructured remote label',
    });
    const path = base(site) + '/ports/' + original.id;
    for (const input of [
      { mode: 'access' },
      { nativeVlanRef: b.id },
      { taggedVlanRefs: [b.id, b.id] },
      { pvid: 0 },
      { pvid: 4095 },
    ]) {
      expect(
        (await client.request('PATCH', path, { ...input, rowVersion: 1 }))
          .statusCode,
      ).toBe(400);
      expect(await readPort(client, site, original.id)).toEqual(original);
    }
    const disabled = await client.request('PATCH', path, {
      mode: 'disabled',
      rowVersion: 1,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().port).toMatchObject({
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
      pvid: 30,
      documentedLinkState: 'up',
    });
    const swapped = await client.request('PATCH', path, {
      mode: 'trunk',
      nativeVlanRef: b.id,
      taggedVlanRefs: [a.id],
      rowVersion: 2,
    });
    expect(swapped.statusCode, swapped.body).toBe(200);
    expect(swapped.json().port).toMatchObject({
      nativeVlanRef: b.id,
      taggedVlanRefs: [a.id],
      pvid: 30,
    });
    const routed = await client.request('PATCH', path, {
      mode: 'routed',
      nativeVlanRef: null,
      taggedVlanRefs: [],
      rowVersion: 3,
    });
    expect(routed.statusCode, routed.body).toBe(200);
    expect(routed.json().port).toMatchObject({
      mode: 'routed',
      nativeVlanRef: null,
      taggedVlanRefs: [],
      pvid: 30,
    });
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(2);
  });

  it('rejects invalid creations and duplicate port names/positions without modifying the parent', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const a = await vlan(client, site, 1);
    const first = await port(client, site, parent, 'Port 1', {
      mode: 'access',
      nativeVlanRef: a.id,
      pvid: 1,
    });
    for (const fields of [
      { name: 'port 1' },
      { name: 'Second', orderIndex: 0 },
      { name: 'Access', mode: 'access', taggedVlanRefs: [a.id] },
      {
        name: 'Overlap',
        mode: 'trunk',
        nativeVlanRef: a.id,
        taggedVlanRefs: [a.id],
      },
    ])
      expect([400, 409]).toContain(
        (
          await client.request(
            'POST',
            base(site) + '/devices/' + parent.id + '/ports',
            fields,
          )
        ).statusCode,
      );
    expect(await listPorts(client, site, parent.id)).toEqual([first]);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(2);
  });

  it('isolates all scoped routes and rejects rack/native/tagged references from other workspaces', async () => {
    const client = await fixture();
    const a = await client.createSite('A');
    const b = await client.createSite('B');
    const parent = await device(client, a);
    const item = await port(client, a, parent);
    const otherVlan = await vlan(client, b, 20);
    const rackResult = await client.request('POST', base(b) + '/racks', {
      name: 'Other rack',
    });
    expect(rackResult.statusCode).toBe(201);
    const rackId = rackResult.json().rack.id as string;
    const foreignDevice = base(b) + '/devices/' + parent.id;
    const foreignPort = base(b) + '/ports/' + item.id;
    for (const [method, path, payload] of [
      ['GET', foreignDevice, undefined],
      ['PATCH', foreignDevice, { displayName: 'Wrong', rowVersion: 2 }],
      ['DELETE', foreignDevice, { rowVersion: 2 }],
      ['GET', foreignDevice + '/ports', undefined],
      ['POST', foreignDevice + '/ports', { name: 'Wrong' }],
      ['POST', foreignDevice + '/ports/generate', { count: 1, rowVersion: 2 }],
      ['GET', foreignPort, undefined],
      ['PATCH', foreignPort, { name: 'Wrong', rowVersion: 1 }],
      ['DELETE', foreignPort, { rowVersion: 1 }],
    ] as const)
      expect(
        (await client.request(method, path, payload)).statusCode,
        method + ' ' + path,
      ).toBe(404);
    expect(
      (
        await client.request('POST', base(a) + '/devices', {
          displayName: 'Bad rack',
          rackId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request('PATCH', base(a) + '/devices/' + parent.id, {
          rackId,
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(400);
    for (const input of [
      { nativeVlanRef: otherVlan.id },
      { taggedVlanRefs: [otherVlan.id] },
    ]) {
      expect(
        (
          await client.request('PATCH', base(a) + '/ports/' + item.id, {
            ...input,
            rowVersion: 1,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await client.request(
            'POST',
            base(a) + '/devices/' + parent.id + '/ports',
            { name: 'Wrong', ...input },
          )
        ).statusCode,
      ).toBe(400);
    }
    expect((await client.request('GET', base(b) + '/devices')).json()).toEqual({
      devices: [],
    });
    expect(await readPort(client, a, item.id)).toEqual(item);
  });

  it('rolls back membership changes after a position conflict and rejects stale updates/deletes', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const a = await vlan(client, site, 1);
    const b = await vlan(client, site, 20);
    const first = await port(client, site, parent, 'First', {
      mode: 'trunk',
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
    });
    await port(client, site, parent, 'Second');
    const path = base(site) + '/ports/' + first.id;
    const conflict = await client.request('PATCH', path, {
      orderIndex: 1,
      nativeVlanRef: b.id,
      taggedVlanRefs: [a.id],
      rowVersion: 1,
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(await readPort(client, site, first.id)).toEqual(first);
    const changed = await client.request('PATCH', path, {
      name: 'Uplink',
      orderIndex: 50,
      rowVersion: 1,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().port).toMatchObject({
      name: 'Uplink',
      orderIndex: 50,
      rowVersion: 2,
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
    });
    expect(
      (await client.request('PATCH', path, { name: 'Old', rowVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await client.request('DELETE', path, { rowVersion: 1 })).statusCode,
    ).toBe(409);
    expect((await listPorts(client, site, parent.id)).at(-1)?.name).toBe(
      'Uplink',
    );
  });

  it('deletes only explicitly selected hardware and cascades memberships while preserving VLAN inventory', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site);
    const a = await vlan(client, site, 20);
    const first = await port(client, site, parent, 'Access', {
      nativeVlanRef: a.id,
      mode: 'access',
    });
    const second = await port(client, site, parent, 'Trunk', {
      taggedVlanRefs: [a.id],
      mode: 'trunk',
    });
    expect(
      (await client.request('GET', base(site) + '/deletion-impact')).json()
        .impact.ports,
    ).toBe(2);
    expect(
      (
        await client.request('DELETE', base(site) + '/devices/' + parent.id, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('DELETE', base(site) + '/ports/' + first.id, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
    expect((await readDevice(client, site, parent.id)).rowVersion).toBe(4);
    expect(
      (
        await client.request('DELETE', base(site) + '/devices/' + parent.id, {
          rowVersion: 4,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await client.request('GET', base(site) + '/ports/' + second.id))
        .statusCode,
    ).toBe(404);
    expect(
      client.db.prepare('SELECT count(*) count FROM port_tagged_vlans').get(),
    ).toEqual({ count: 0 });
    expect(
      (await client.request('GET', base(site) + '/vlans')).json().vlans,
    ).toHaveLength(1);
  });

  it('persists equipment, explicit PVID, VLAN memberships and notes across restart', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const parent = await device(client, site, 'Persistent router', {
      type: 'router',
      tags: ['documented'],
    });
    const a = await vlan(client, site, 1);
    const b = await vlan(client, site, 20);
    const item = await port(client, site, parent, 'Saved trunk', {
      mode: 'trunk',
      nativeVlanRef: a.id,
      taggedVlanRefs: [b.id],
      pvid: 30,
      description: '<script>inert</script>',
      face: 'rear',
    });
    await client.restart();
    expect(await readPort(client, site, item.id)).toEqual(item);
    expect((await readDevice(client, site, parent.id)).tags).toEqual([
      'documented',
    ]);
  });

  it('requires authentication and CSRF and protects normalized equipment routes', async () => {
    const client = await fixture();
    const site = await client.createSite();
    const unauthorized = await client.app.inject({
      url: base(site) + '/devices',
      headers: { host: '127.0.0.1:3088' },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toHaveProperty('error.code', 'UNAUTHENTICATED');
    expect(
      (
        await client.request(
          'POST',
          base(site) + '/devices',
          { displayName: 'Forged' },
          { 'x-csrf-token': 'forged' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request(
          'GET',
          '/%61pi/v1/sites/' + site.id + '/devices',
          undefined,
          { host: 'attacker.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await client.request('GET', base(site) + '/devices')).json(),
    ).toEqual({ devices: [] });
  });
});
