import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import type {
  Connection,
  Device,
  Port,
  PortField,
  Site,
} from '../../../packages/shared/src/index.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
const base = (site: Site) => `/api/v1/sites/${site.id}`;
async function fixture() {
  const client = await apiFixture();
  clients.push(client);
  const site = await client.createSite();
  const deviceResponse = await client.request('POST', base(site) + '/devices', {
    displayName: 'Switch',
  });
  const device: Device = deviceResponse.json().device;
  const generated = await client.request(
    'POST',
    base(site) + `/devices/${device.id}/ports/generate`,
    { count: 4, rowVersion: device.rowVersion },
  );
  expect(generated.statusCode, generated.body).toBe(201);
  return {
    client,
    site,
    device: generated.json().device as Device,
    ports: generated.json().ports as Port[],
  };
}
async function readPort(
  client: Fixture,
  site: Site,
  id: string,
): Promise<Port> {
  return (await client.request('GET', base(site) + '/ports/' + id)).json().port;
}
async function field(
  client: Fixture,
  site: Site,
  key: string,
  valueType: string,
  extra: Record<string, unknown> = {},
): Promise<PortField> {
  const response = await client.request('POST', base(site) + '/port-fields', {
    key,
    title: key,
    valueType,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().field;
}

describe('M3 atomic configure grid', () => {
  it('matches SQLite name uniqueness for existing non-ASCII names and atomic swaps', async () => {
    const { client, site, ports } = await fixture();
    const [a, b] = ports as [Port, Port];
    for (const [port, name] of [
      [a, 'Ä'],
      [b, 'ä'],
    ] as const) {
      const renamed = await client.request(
        'PATCH',
        base(site) + '/ports/' + port.id,
        { rowVersion: 1, name },
      );
      expect(renamed.statusCode, renamed.body).toBe(200);
    }
    const changed = await client.request(
      'POST',
      base(site) + '/ports/bulk-edit',
      {
        updates: [
          {
            portId: a.id,
            rowVersion: 2,
            changes: { description: 'Valid existing name retained' },
          },
        ],
      },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const swapped = await client.request(
      'POST',
      base(site) + '/ports/bulk-edit',
      {
        updates: [
          { portId: a.id, rowVersion: 3, changes: { name: 'ä' } },
          { portId: b.id, rowVersion: 2, changes: { name: 'Ä' } },
        ],
      },
    );
    expect(swapped.statusCode, swapped.body).toBe(200);
    expect((await readPort(client, site, a.id)).name).toBe('ä');
    const duplicate = await client.request(
      'POST',
      base(site) + '/ports/bulk-edit',
      {
        updates: [
          { portId: a.id, rowVersion: 4, changes: { name: 'SPARE' } },
          { portId: b.id, rowVersion: 3, changes: { name: 'spare' } },
        ],
      },
    );
    expect(duplicate.statusCode).toBe(409);
    expect((await readPort(client, site, a.id)).name).toBe('ä');
  });

  it('supports name/order swaps atomically and leaves device versions and custom values intact', async () => {
    const { client, site, device, ports } = await fixture();
    const [a, b] = ports as [Port, Port];
    const response = await client.request(
      'POST',
      base(site) + '/ports/bulk-edit',
      {
        updates: [
          {
            portId: a.id,
            rowVersion: 1,
            changes: { name: b.name, orderIndex: b.orderIndex, mode: 'routed' },
          },
          {
            portId: b.id,
            rowVersion: 1,
            changes: {
              name: a.name,
              orderIndex: a.orderIndex,
              documentedLinkState: 'up',
            },
          },
        ],
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().devices).toEqual([device]);
    expect(response.json().ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.id,
          name: b.name,
          orderIndex: b.orderIndex,
          mode: 'routed',
          rowVersion: 2,
        }),
        expect.objectContaining({
          id: b.id,
          name: a.name,
          orderIndex: a.orderIndex,
          rowVersion: 2,
        }),
      ]),
    );
    expect(response.json().customValues).toEqual({ [a.id]: {}, [b.id]: {} });
    await client.restart();
    expect(await readPort(client, site, a.id)).toMatchObject({
      name: b.name,
      orderIndex: b.orderIndex,
      rowVersion: 2,
    });
  });

  it('rolls back the whole batch on stale, duplicate, invalid configuration and wrong-site references', async () => {
    const { client, site, ports } = await fixture();
    const [a, b] = ports as [Port, Port];
    const other = await client.createSite('Other');
    const foreign = (
      await client.request('POST', base(other) + '/vlans', { vlanId: 20 })
    ).json().vlan;
    const bodies = [
      [
        {
          portId: a.id,
          rowVersion: 1,
          changes: { description: 'must rollback' },
        },
        { portId: b.id, rowVersion: 2, changes: {} },
      ],
      [
        {
          portId: a.id,
          rowVersion: 1,
          changes: { description: 'must rollback' },
        },
        {
          portId: b.id,
          rowVersion: 1,
          changes: { mode: 'access', taggedVlanRefs: [foreign.id] },
        },
      ],
      [
        {
          portId: a.id,
          rowVersion: 1,
          changes: { description: 'must rollback' },
        },
        { portId: b.id, rowVersion: 1, changes: { nativeVlanRef: foreign.id } },
      ],
      [
        { portId: a.id, rowVersion: 1, changes: {} },
        { portId: a.id, rowVersion: 1, changes: {} },
      ],
      [{ portId: a.id, rowVersion: 1, changes: { name: b.name } }],
      [{ portId: a.id, rowVersion: 1, changes: { orderIndex: b.orderIndex } }],
    ];
    for (const updates of bodies) {
      const response = await client.request(
        'POST',
        base(site) + '/ports/bulk-edit',
        { updates },
      );
      expect([400, 409]).toContain(response.statusCode);
      expect(await readPort(client, site, a.id)).toEqual(a);
      expect(await readPort(client, site, b.id)).toEqual(b);
    }
    expect(
      (
        await client.request(
          'POST',
          base(site) + '/ports/bulk-edit',
          { updates: [{ portId: a.id, rowVersion: 1, changes: {} }] },
          { 'x-csrf-token': 'forged' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request('POST', base(other) + '/ports/bulk-edit', {
          updates: [{ portId: a.id, rowVersion: 1, changes: {} }],
        })
      ).statusCode,
    ).toBe(404);
  });

  it('accepts 512 updates and rejects 513 without partial changes', async () => {
    const { client, site, device } = await fixture();
    const original = (
      await client.request('GET', base(site) + `/devices/${device.id}/ports`)
    ).json().ports as Port[];
    let version = device.rowVersion;
    for (const [count, startNumber] of [
      [256, 5],
      [252, 261],
    ]) {
      const response = await client.request(
        'POST',
        base(site) + `/devices/${device.id}/ports/generate`,
        { count, startNumber, rowVersion: version },
      );
      expect(response.statusCode, response.body).toBe(201);
      version = response.json().device.rowVersion;
    }
    const ports = (
      await client.request('GET', base(site) + `/devices/${device.id}/ports`)
    ).json().ports as Port[];
    expect(ports).toHaveLength(512);
    const updates = ports.map((port) => ({
      portId: port.id,
      rowVersion: port.rowVersion,
      changes: { description: 'bulk' },
    }));
    const saved = await client.request(
      'POST',
      base(site) + '/ports/bulk-edit',
      { updates },
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().ports).toHaveLength(512);
    expect(
      (
        await client.request('POST', base(site) + '/ports/bulk-edit', {
          updates: [...updates, updates[0]],
        })
      ).statusCode,
    ).toBe(400);
    expect(await readPort(client, site, original[0]!.id)).toMatchObject({
      description: 'bulk',
      rowVersion: 2,
    });
  });

  it('stores exact typed custom values including false, zero, explicit null and real dates', async () => {
    const { client, site, device, ports } = await fixture();
    const a = ports[0]!;
    const bool = await field(client, site, 'enabled', 'boolean', {
      defaultValue: true,
    });
    const number = await field(client, site, 'capacity', 'number', {
      defaultValue: 12,
    });
    const date = await field(client, site, 'installed', 'date');
    const select = await field(client, site, 'role', 'select', {
      choices: ['A', 'B'],
    });
    const text = await field(client, site, 'owner', 'text', {
      defaultValue: 'default',
    });
    const values = {
      [bool.id]: false,
      [number.id]: 0,
      [date.id]: '2024-02-29',
      [select.id]: 'A',
      [text.id]: null,
    };
    const response = await client.request(
      'POST',
      base(site) + '/ports/bulk-edit',
      {
        updates: [
          {
            portId: a.id,
            rowVersion: 1,
            changes: { description: 'saved together' },
            customValues: values,
          },
        ],
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().customValues[a.id]).toEqual(values);
    for (const [fieldId, value] of [
      [bool.id, 'false'],
      [number.id, '0'],
      [date.id, '2025-02-29'],
      [select.id, 'missing'],
    ]) {
      const invalid = await client.request(
        'POST',
        base(site) + '/ports/bulk-edit',
        {
          updates: [
            {
              portId: a.id,
              rowVersion: 2,
              changes: { description: 'rollback' },
              customValues: { [fieldId!]: value },
            },
          ],
        },
      );
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
    expect(await readPort(client, site, a.id)).toMatchObject({
      description: 'saved together',
      rowVersion: 2,
    });
    const single = await client.request(
      'PATCH',
      base(site) + `/ports/${a.id}`,
      { rowVersion: 2, speed: '1G' },
    );
    expect(single.statusCode).toBe(200);
    const read = await client.request(
      'GET',
      base(site) + `/devices/${device.id}/port-values`,
    );
    expect(read.json().customValues[a.id]).toEqual(values);
    expect(read.json().customValues[ports[1]!.id]).toEqual({});
    await client.restart();
    expect(
      (
        await client.request(
          'GET',
          base(site) + `/devices/${device.id}/port-values`,
        )
      ).json().customValues[a.id],
    ).toEqual(values);
  });

  it('revalidates existing values on field changes and guards definitions and cross-site values', async () => {
    const { client, site, device, ports } = await fixture();
    const a = ports[0]!;
    const choice = await field(client, site, 'role', 'select', {
      choices: ['A', 'B'],
    });
    await client.request('POST', base(site) + '/ports/bulk-edit', {
      updates: [
        {
          portId: a.id,
          rowVersion: 1,
          changes: {},
          customValues: { [choice.id]: 'A' },
        },
      ],
    });
    expect(
      (
        await client.request(
          'PATCH',
          base(site) + `/port-fields/${choice.id}`,
          { rowVersion: 1, choices: ['B'] },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'PATCH',
          base(site) + `/port-fields/${choice.id}`,
          { rowVersion: 1, valueType: 'number', choices: [] },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'PATCH',
          base(site) + `/port-fields/${choice.id}`,
          { rowVersion: 1, key: 'renamed' },
        )
      ).statusCode,
    ).toBe(400);
    const changed = await client.request(
      'PATCH',
      base(site) + `/port-fields/${choice.id}`,
      { rowVersion: 1, title: 'Role' },
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.json().field.rowVersion).toBe(2);
    expect(
      (
        await client.request(
          'PATCH',
          base(site) + `/port-fields/${choice.id}`,
          { rowVersion: 1, title: 'Stale' },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('POST', base(site) + '/port-fields', {
          key: 'name',
          title: 'Shadow',
          valueType: 'text',
        })
      ).statusCode,
    ).toBe(400);
    const other = await client.createSite('Other');
    const foreign = await field(client, other, 'extra', 'text');
    expect(
      (
        await client.request('POST', base(site) + '/ports/bulk-edit', {
          updates: [
            {
              portId: a.id,
              rowVersion: 2,
              changes: {},
              customValues: { [foreign.id]: 'bad' },
            },
          ],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request(
          'GET',
          base(other) + `/devices/${device.id}/port-values`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request(
          'DELETE',
          base(site) + `/port-fields/${choice.id}`,
          { rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'DELETE',
          base(site) + `/port-fields/${choice.id}`,
          { rowVersion: 2 },
        )
      ).statusCode,
    ).toBe(204);
    expect(await readPort(client, site, a.id)).toMatchObject({ rowVersion: 3 });
    expect(
      (
        await client.request(
          'GET',
          base(site) + `/devices/${device.id}/port-values`,
        )
      ).json().customValues[a.id],
    ).toEqual({});
  });

  it('connects reciprocally, preserves annotations, confirms exact replacements and blocks linked deletes', async () => {
    const { client, site, device, ports } = await fixture();
    const [a, b, c] = ports as [Port, Port, Port];
    await client.request('PATCH', base(site) + `/ports/${a.id}`, {
      rowVersion: 1,
      externalDestinationLabel: 'Separate annotation',
    });
    const connect = async (
      aId: string,
      bId: string,
      replacements: { id: string; rowVersion: number }[] = [],
    ) =>
      client.request('POST', base(site) + '/connections', {
        endpointAPortId: aId,
        endpointBPortId: bId,
        endpointARowVersion: (await readPort(client, site, aId)).rowVersion,
        endpointBRowVersion: (await readPort(client, site, bId)).rowVersion,
        replaceConnections: replacements,
      });
    const created = await connect(a.id, b.id);
    expect(created.statusCode, created.body).toBe(201);
    const connection = created.json().connection as Connection;
    expect(created.json().ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.id,
          rowVersion: 3,
          externalDestinationLabel: 'Separate annotation',
        }),
        expect.objectContaining({ id: b.id, rowVersion: 2 }),
      ]),
    );
    expect(
      (await client.request('GET', base(site) + '/connections')).json()
        .connections,
    ).toEqual([connection]);
    expect((await connect(a.id, a.id)).statusCode).toBe(400);
    expect((await connect(c.id, a.id)).statusCode).toBe(409);
    expect(
      (await connect(a.id, c.id, [{ id: randomUUID(), rowVersion: 1 }]))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('DELETE', base(site) + `/ports/${a.id}`, {
          rowVersion: 3,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('DELETE', base(site) + `/devices/${device.id}`, {
          rowVersion: device.rowVersion,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'PATCH',
          base(site) + `/connections/${connection.id}`,
          { rowVersion: 1, notes: 'Updated cable' },
        )
      ).json().connection.rowVersion,
    ).toBe(2);
    expect(
      (await connect(a.id, c.id, [{ id: connection.id, rowVersion: 1 }]))
        .statusCode,
    ).toBe(409);
    expect(
      (await client.request('GET', base(site) + '/connections')).json()
        .connections,
    ).toHaveLength(1);
    const replaced = await connect(a.id, c.id, [
      { id: connection.id, rowVersion: 2 },
    ]);
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json().ports).toHaveLength(3);
    expect(await readPort(client, site, b.id)).toMatchObject({ rowVersion: 3 });
    expect(await readPort(client, site, a.id)).toMatchObject({
      rowVersion: 4,
      externalDestinationLabel: 'Separate annotation',
    });
    const replacement = replaced.json().connection as Connection;
    await client.restart();
    expect(
      (await client.request('GET', base(site) + '/connections')).json()
        .connections,
    ).toEqual([replacement]);
    expect(
      (
        await client.request(
          'DELETE',
          base(site) + `/connections/${replacement.id}`,
          { rowVersion: 2 },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'DELETE',
          base(site) + `/connections/${replacement.id}`,
          { rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(204);
    expect(await readPort(client, site, a.id)).toMatchObject({ rowVersion: 5 });
    expect(
      (await client.request('GET', base(site) + '/connections')).json()
        .connections,
    ).toEqual([]);
  });

  it('enforces cross-column endpoint occupancy, self and same-site rules even through direct SQL', async () => {
    const { client, site, ports } = await fixture();
    const [a, b, c, d] = ports as [Port, Port, Port, Port];
    const insert = client.db.prepare(
      'INSERT INTO connections (id,site_id,endpoint_a_port_id,endpoint_b_port_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    );
    const connectionId = randomUUID();
    insert.run(connectionId, site.id, a.id, b.id, 1, 1);
    expect(() => insert.run(randomUUID(), site.id, c.id, a.id, 1, 1)).toThrow(
      'already has',
    );
    expect(() => insert.run(randomUUID(), site.id, b.id, c.id, 1, 1)).toThrow(
      'already has',
    );
    expect(() => insert.run(randomUUID(), site.id, c.id, c.id, 1, 1)).toThrow();
    const secondId = randomUUID();
    insert.run(secondId, site.id, c.id, d.id, 1, 1);
    expect(() =>
      client.db
        .prepare('UPDATE connections SET endpoint_b_port_id=? WHERE id=?')
        .run(a.id, secondId),
    ).toThrow('already has');
    const other = await client.createSite('Other');
    client.db.prepare('DELETE FROM connections').run();
    expect(() => insert.run(randomUUID(), other.id, a.id, b.id, 1, 1)).toThrow(
      'FOREIGN KEY',
    );
    const foreignField = await field(client, other, 'owner', 'text');
    expect(() =>
      client.db
        .prepare(
          'INSERT INTO port_custom_values (port_id,field_def_id,site_id,value_json) VALUES (?,?,?,?)',
        )
        .run(a.id, foreignField.id, site.id, '"bad"'),
    ).toThrow('FOREIGN KEY');
    expect(
      (
        await client.request('POST', base(other) + '/connections', {
          endpointAPortId: a.id,
          endpointBPortId: b.id,
          endpointARowVersion: 1,
          endpointBRowVersion: 1,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('connects ports on different devices and requires both occupied cables to be confirmed', async () => {
    const { client, site, ports } = await fixture();
    const [a, b, c] = ports as [Port, Port, Port];
    const otherDevice = (
      await client.request('POST', base(site) + '/devices', {
        displayName: 'Router',
      })
    ).json().device as Device;
    const d = (
      await client.request(
        'POST',
        base(site) + `/devices/${otherDevice.id}/ports`,
        { name: 'WAN', mode: 'routed' },
      )
    ).json().port as Port;
    const connect = async (
      first: Port,
      second: Port,
      replaceConnections: { id: string; rowVersion: number }[] = [],
    ) =>
      client.request('POST', base(site) + '/connections', {
        endpointAPortId: first.id,
        endpointBPortId: second.id,
        endpointARowVersion: (await readPort(client, site, first.id))
          .rowVersion,
        endpointBRowVersion: (await readPort(client, site, second.id))
          .rowVersion,
        replaceConnections,
      });
    const one = (await connect(a, b)).json().connection as Connection;
    const twoResponse = await connect(c, d);
    expect(twoResponse.statusCode, twoResponse.body).toBe(201);
    const two = twoResponse.json().connection as Connection;
    expect(twoResponse.json().ports.map((port: Port) => port.deviceId)).toEqual(
      expect.arrayContaining([otherDevice.id, a.deviceId]),
    );
    expect(
      (await connect(a, c, [{ id: one.id, rowVersion: 1 }])).statusCode,
    ).toBe(409);
    expect(
      (
        await connect(a, c, [
          { id: one.id, rowVersion: 1 },
          { id: two.id, rowVersion: 2 },
        ])
      ).statusCode,
    ).toBe(409);
    expect(
      (await client.request('GET', base(site) + '/connections')).json()
        .connections,
    ).toHaveLength(2);
    const replaced = await connect(a, c, [
      { id: one.id, rowVersion: 1 },
      { id: two.id, rowVersion: 1 },
    ]);
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json().ports).toHaveLength(4);
    expect(
      replaced.json().ports.every((port: Port) => port.rowVersion === 3),
    ).toBe(true);
    expect(
      (await client.request('GET', base(site) + '/connections')).json()
        .connections,
    ).toHaveLength(1);
  });
});
