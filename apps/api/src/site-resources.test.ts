import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import { backupDatabase } from '../../../packages/db/src/index.js';
import type {
  Connection,
  Device,
  Port,
  PortField,
  Rack,
  Site,
  Subnet,
  Vlan,
} from '../../../packages/shared/src/index.js';
import { exportSite } from './transfer-store.js';

type Client = Awaited<ReturnType<typeof apiFixture>>;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture();
  clients.push(client);
  return client;
}
async function populate(client: Client, site: Site) {
  const base = `/api/v1/sites/${site.id}`;
  async function post<T>(path: string, data: unknown, key: string): Promise<T> {
    const response = await client.request('POST', base + path, data);
    expect(response.statusCode, response.body).toBe(201);
    return response.json()[key] as T;
  }
  const rack = await post<Rack>('/racks', { name: 'Rack' }, 'rack');
  const vlan = await post<Vlan>('/vlans', { vlanId: 20 }, 'vlan');
  const subnet = await post<Subnet>(
    '/subnets',
    { cidr: '192.0.2.0/24', vlanRef: vlan.id },
    'subnet',
  );
  await post(
    '/subnets/' + subnet.id + '/dhcp-scopes',
    { startIp: '192.0.2.10', endIp: '192.0.2.20' },
    'dhcpScope',
  );
  const devices: Device[] = [];
  const ports: Port[] = [];
  for (const displayName of ['Router', 'Switch']) {
    const device = await post<Device>(
      '/devices',
      { displayName, rackId: rack.id },
      'device',
    );
    devices.push(device);
    ports.push(
      await post<Port>(
        `/devices/${device.id}/ports`,
        { name: 'Port 1', mode: 'trunk', taggedVlanRefs: [vlan.id] },
        'port',
      ),
    );
  }
  const field = await post<PortField>(
    '/port-fields',
    { key: 'poe', title: 'PoE', valueType: 'boolean' },
    'field',
  );
  expect(
    (
      await client.request('POST', base + '/ports/bulk-edit', {
        updates: [
          {
            portId: ports[0]!.id,
            rowVersion: 1,
            changes: {},
            customValues: { [field.id]: false },
          },
        ],
      })
    ).statusCode,
  ).toBe(200);
  const connection = await post<Connection>(
    '/connections',
    {
      endpointAPortId: ports[0]!.id,
      endpointBPortId: ports[1]!.id,
      endpointARowVersion: 2,
      endpointBRowVersion: 1,
      cableType: 'Cat6',
    },
    'connection',
  );
  return { devices, ports, connection };
}
const tables = [
  'connections',
  'port_custom_values',
  'port_tagged_vlans',
  'ports',
  'devices',
  'dhcp_scopes',
  'subnets',
  'port_custom_field_defs',
  'racks',
  'vlans',
] as const;

it('deletes a fully populated site in one transaction, retaining sibling sites, accounts and private backups', async () => {
  const client = await fixture();
  const site = await client.createSite();
  await populate(client, site);
  const sibling = await client.createSite('Sibling', site.workspaceId);
  await populate(client, sibling);
  const unrelated = await client.createSite('Other workspace');
  await populate(client, unrelated);
  const retained = [
    exportSite(client.db, sibling.id),
    exportSite(client.db, unrelated.id),
  ];
  const auth = client.db.prepare('SELECT * FROM users').all();
  const sessions = client.db.prepare('SELECT * FROM sessions').all();
  const backup = join(client.dataDir, 'backups', 'retained.sqlite');
  await backupDatabase(client.db, backup);
  const backupBytes = readFileSync(backup);
  const preview = await client.request(
    'GET',
    `/api/v1/sites/${site.id}/deletion-impact`,
  );
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toEqual({
    name: site.name,
    rowVersion: 1,
    impact: {
      sites: 1,
      devices: 2,
      ports: 2,
      vlans: 1,
      racks: 1,
      subnets: 1,
      dhcpScopes: 1,
      fields: 1,
      customValues: 1,
      connections: 1,
      logicalConnections: 0,
    },
  });
  expect(
    (
      await client.request('DELETE', `/api/v1/sites/${site.id}`, {
        rowVersion: 1,
      })
    ).statusCode,
  ).toBe(204);
  for (const table of tables)
    expect(
      client.db
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE site_id=?`)
        .get(site.id),
    ).toEqual({ count: 0 });
  expect(
    (await client.request('GET', `/api/v1/sites/${site.id}`)).statusCode,
  ).toBe(404);
  expect([
    exportSite(client.db, sibling.id),
    exportSite(client.db, unrelated.id),
  ]).toEqual(retained);
  expect(client.db.prepare('SELECT * FROM users').all()).toEqual(auth);
  expect(client.db.prepare('SELECT * FROM sessions').all()).toEqual(sessions);
  expect(readFileSync(backup)).toEqual(backupBytes);
  await client.restart();
  expect(client.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(exportSite(client.db, sibling.id)).toEqual(retained[0]);
});

it('deletes a workspace and every populated child site while retaining other workspaces', async () => {
  const client = await fixture();
  const workspace = await client.createWorkspace();
  const a = await client.createSite('First', workspace.id);
  const b = await client.createSite('Second', workspace.id);
  await populate(client, a);
  await populate(client, b);
  const other = await client.createSite('Other');
  await populate(client, other);
  const before = exportSite(client.db, other.id);
  const preview = (
    await client.request(
      'GET',
      `/api/v1/workspaces/${workspace.id}/deletion-impact`,
    )
  ).json();
  expect(preview.impact).toEqual({
    sites: 2,
    devices: 4,
    ports: 4,
    vlans: 2,
    racks: 2,
    subnets: 2,
    dhcpScopes: 2,
    fields: 2,
    customValues: 2,
    connections: 2,
    logicalConnections: 0,
  });
  expect(
    (
      await client.request('DELETE', `/api/v1/workspaces/${workspace.id}`, {
        rowVersion: workspace.rowVersion,
      })
    ).statusCode,
  ).toBe(204);
  for (const removed of [a, b])
    for (const table of tables)
      expect(
        client.db
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE site_id=?`)
          .get(removed.id),
      ).toEqual({ count: 0 });
  expect(
    (await client.request('GET', `/api/v1/workspaces/${workspace.id}`))
      .statusCode,
  ).toBe(404);
  expect(
    (await client.request('GET', `/api/v1/sites/${a.id}`)).statusCode,
  ).toBe(404);
  await client.restart();
  expect(exportSite(client.db, other.id)).toEqual(before);
  expect(client.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('refuses stale, missing and unauthorized deletion without changing any descendants', async () => {
  const client = await fixture();
  const site = await client.createSite();
  await populate(client, site);
  const base = `/api/v1/sites/${site.id}`;
  await client.request('PATCH', base, { rowVersion: 1, name: 'Renamed' });
  const before = exportSite(client.db, site.id);
  expect(
    (await client.request('DELETE', base, { rowVersion: 1 })).statusCode,
  ).toBe(409);
  const workspace = await client.request(
    'PATCH',
    `/api/v1/workspaces/${site.workspaceId}`,
    { rowVersion: 1, name: 'Renamed workspace' },
  );
  expect(workspace.statusCode).toBe(200);
  expect(
    (
      await client.request('DELETE', `/api/v1/workspaces/${site.workspaceId}`, {
        rowVersion: 1,
      })
    ).statusCode,
  ).toBe(409);
  for (const root of [base, `/api/v1/workspaces/${site.workspaceId}`]) {
    expect(
      (
        await client.app.inject({
          url: root + '/deletion-impact',
          headers: { host: '127.0.0.1:3088' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await client.request(
          'DELETE',
          root,
          { rowVersion: 2 },
          { 'x-csrf-token': 'wrong' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.app.inject({
          method: 'DELETE',
          url: root,
          payload: { rowVersion: 2 },
          headers: { host: '127.0.0.1:3088', origin: 'http://127.0.0.1:3088' },
        })
      ).statusCode,
    ).toBe(403);
  }
  for (const root of [
    `/api/v1/sites/${randomUUID()}`,
    `/api/v1/workspaces/${randomUUID()}`,
  ]) {
    expect(
      (await client.request('GET', root + '/deletion-impact')).statusCode,
    ).toBe(404);
    expect(
      (await client.request('DELETE', root, { rowVersion: 1 })).statusCode,
    ).toBe(404);
  }
  expect({
    ...exportSite(client.db, site.id),
    workspace: before.workspace,
  }).toEqual(before);
  expect(readdirSync(client.dataDir)).not.toContain('backups');
});

for (const kind of ['site', 'workspace'] as const)
  it(`rolls back the entire ${kind} tree if the final root deletion fails`, async () => {
    const client = await fixture();
    const site = await client.createSite();
    await populate(client, site);
    const second = await client.createSite('Second', site.workspaceId);
    await populate(client, second);
    const before = [
      exportSite(client.db, site.id),
      exportSite(client.db, second.id),
    ];
    client.db.exec(
      `CREATE TRIGGER fail_delete BEFORE DELETE ON ${kind === 'site' ? 'sites' : 'workspaces'} BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END`,
    );
    const path =
      kind === 'site'
        ? `/api/v1/sites/${site.id}`
        : `/api/v1/workspaces/${site.workspaceId}`;
    expect(
      (await client.request('DELETE', path, { rowVersion: 1 })).statusCode,
    ).toBe(400);
    expect([
      exportSite(client.db, site.id),
      exportSite(client.db, second.id),
    ]).toEqual(before);
    expect(client.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
