import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { apiFixture } from '../../../tests/support/api.js';
type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
describe('authenticated navigation metadata', () => {
  it('keeps folder labels and endpoint labels in one snapshot while another SQLite writer renames a device', async () => {
    const client = await apiFixture();
    clients.push(client);
    const site = await client.createSite();
    const base = `/api/v1/sites/${site.id}`;
    const parent = (
      await client.request('POST', base + '/devices', { displayName: 'Before' })
    ).json().device;
    const ports = (
      await client.request(
        'POST',
        base + `/devices/${parent.id}/ports/generate`,
        { count: 2, rowVersion: 1 },
      )
    ).json().ports;
    expect(
      (
        await client.request('POST', base + '/connections', {
          endpointAPortId: ports[0].id,
          endpointBPortId: ports[1].id,
          endpointARowVersion: 1,
          endpointBRowVersion: 1,
        })
      ).statusCode,
    ).toBe(201);
    const original = DatabaseSync.prototype.prepare;
    let changed = false;
    const spy = vi
      .spyOn(DatabaseSync.prototype, 'prepare')
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (
          !changed &&
          sql.startsWith('SELECT id,display_name AS label FROM devices')
        ) {
          changed = true;
          original
            .call(
              client.db,
              'UPDATE devices SET display_name=?,row_version=row_version+1 WHERE id=?',
            )
            .run('After', parent.id);
        }
        return original.call(this, sql);
      });
    try {
      const first = (await client.request('GET', base + '/navigation')).json()
        .records;
      expect(changed).toBe(true);
      expect(first.devices).toEqual([{ id: parent.id, label: 'Before' }]);
      expect(first.connections[0].label).toBe(
        'Before / Port 1 ⇄ Before / Port 2',
      );
    } finally {
      spy.mockRestore();
    }
    const next = (await client.request('GET', base + '/navigation')).json()
      .records;
    expect(next.devices).toEqual([{ id: parent.id, label: 'After' }]);
    expect(next.connections[0].label).toBe('After / Port 1 ⇄ After / Port 2');
  });
  it('reads actual minimal site folder records and immediately reflects create, rename and delete operations', async () => {
    const client = await apiFixture();
    clients.push(client);
    const site = await client.createSite('Explorer');
    const other = await client.createSite('Other');
    const base = `/api/v1/sites/${site.id}`;
    const post = async (path: string, data: Record<string, unknown>) => {
      const response = await client.request('POST', path, data);
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const first = (
      await post(base + '/devices', {
        displayName: 'Router',
        managementIp: '192.0.2.1',
        description: 'Private device notes',
      })
    ).device;
    const second = (await post(base + '/devices', { displayName: 'Switch' }))
      .device;
    const a = (
      await post(base + `/devices/${first.id}/ports/generate`, {
        count: 1,
        rowVersion: 1,
      })
    ).ports[0];
    const b = (
      await post(base + `/devices/${second.id}/ports/generate`, {
        count: 1,
        rowVersion: 1,
      })
    ).ports[0];
    const cable = (
      await post(base + '/connections', {
        endpointAPortId: a.id,
        endpointBPortId: b.id,
        endpointARowVersion: 1,
        endpointBRowVersion: 1,
        notes: 'Private cable notes',
      })
    ).connection;
    const logical = (
      await post(base + '/logical-connections', {
        endpointADeviceId: first.id,
        endpointBDeviceId: second.id,
        name: 'Overlay',
        protocol: 'GRE',
        notes: 'Private logical notes',
      })
    ).logicalConnection;
    const vlan = (
      await post(base + '/vlans', {
        vlanId: 20,
        name: 'Server',
        description: 'Private VLAN notes',
      })
    ).vlan;
    const subnet = (
      await post(base + '/subnets', {
        cidr: '192.0.2.0/24',
        name: 'Documentation',
        notes: 'Private network notes',
      })
    ).subnet;
    const rack = (
      await post(base + '/racks', {
        name: 'Rack A',
        description: 'Private rack notes',
      })
    ).rack;
    const template = (
      await post('/api/v1/device-templates', {
        name: 'Saved ports',
        description: 'Private template notes',
        groups: [{ count: 2 }],
      })
    ).template;
    await post(`/api/v1/sites/${other.id}/devices`, {
      displayName: 'Foreign device',
    });
    const read = async () => {
      const response = await client.request('GET', base + '/navigation');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      return response;
    };
    const response = await read();
    const data = response.json();
    expect(Object.keys(data).sort()).toEqual(['records', 'siteId']);
    expect(data.siteId).toBe(site.id);
    expect(Object.keys(data.records).sort()).toEqual([
      'connections',
      'devices',
      'network',
      'racks',
      'templates',
      'vlans',
    ]);
    expect(data.records.devices).toEqual([
      { id: first.id, label: 'Router' },
      { id: second.id, label: 'Switch' },
    ]);
    expect(data.records.vlans).toEqual([
      { id: vlan.id, label: 'VLAN 20 — Server' },
    ]);
    expect(data.records.network).toEqual([
      { id: subnet.id, label: '192.0.2.0/24 — Documentation' },
    ]);
    expect(data.records.racks).toEqual([{ id: rack.id, label: 'Rack A' }]);
    expect(data.records.templates).toHaveLength(7);
    expect(data.records.templates).toContainEqual({
      id: template.id,
      label: 'Saved ports',
    });
    expect(data.records.connections).toEqual([
      {
        id: cable.id,
        label: 'Router / Port 1 ⇄ Switch / Port 1',
        kind: 'physical',
      },
      { id: logical.id, label: 'Overlay — GRE', kind: 'logical' },
    ]);
    for (const secret of [
      'managementIp',
      'description',
      'notes',
      'rowVersion',
      'password',
      'csrf',
      'ports":',
      'Private',
      'Foreign device',
    ])
      expect(response.body).not.toContain(secret);
    const foreign = (
      await client.request('GET', `/api/v1/sites/${other.id}/navigation`)
    ).json();
    expect(
      foreign.records.devices.map((record: { label: string }) => record.label),
    ).toEqual(['Foreign device']);
    expect(foreign.records.connections).toEqual([]);
    expect(foreign.records.templates).toEqual(data.records.templates);
    for (const [path, body] of [
      [base + '/vlans/' + vlan.id, { rowVersion: 1, name: 'Servers' }],
      [
        base + '/devices/' + first.id,
        { rowVersion: 2, displayName: 'Core router' },
      ],
      [
        '/api/v1/device-templates/' + template.id,
        { rowVersion: 1, name: 'Updated layout' },
      ],
    ] as const)
      expect((await client.request('PATCH', path, body)).statusCode).toBe(200);
    const renamed = (await read()).json().records;
    expect(renamed.vlans[0].label).toBe('VLAN 20 — Servers');
    expect(renamed.devices[0].label).toBe('Core router');
    expect(renamed.connections[0].label).toContain('Core router / Port 1');
    expect(renamed.templates).toContainEqual({
      id: template.id,
      label: 'Updated layout',
    });
    for (const [path, rowVersion] of [
      [base + '/connections/' + cable.id, 1],
      [base + '/logical-connections/' + logical.id, 1],
      [base + '/subnets/' + subnet.id, 1],
      [base + '/racks/' + rack.id, 1],
      [base + '/vlans/' + vlan.id, 2],
      ['/api/v1/device-templates/' + template.id, 2],
      [base + '/devices/' + first.id, 3],
      [base + '/devices/' + second.id, 2],
    ] as const)
      expect(
        (await client.request('DELETE', path, { rowVersion })).statusCode,
        path,
      ).toBe(204);
    const remaining = (await read()).json().records;
    for (const folder of [
      'devices',
      'vlans',
      'network',
      'racks',
      'connections',
    ])
      expect(remaining[folder]).toEqual([]);
    expect(remaining.templates).toHaveLength(6);
  });
  it('protects site folder metadata with authentication, host checks and safe missing-site errors', async () => {
    const client = await apiFixture();
    clients.push(client);
    const site = await client.createSite();
    const url = `/api/v1/sites/${site.id}/navigation`;
    expect(
      (await client.app.inject({ url, headers: { host: '127.0.0.1:3088' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await client.request('GET', url, undefined, { host: 'foreign.example' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await client.request('GET', '/api/v1/sites/missing/navigation'))
        .statusCode,
    ).toBe(404);
    expect((await client.request('GET', url)).json().records.devices).toEqual(
      [],
    );
  });
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
