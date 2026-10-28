import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import type {
  Device,
  Site,
  SiteArchive,
} from '../../../packages/shared/src/index.js';
import type { LogicalConnection } from '../../../packages/shared/src/logical.js';
import { exportSite } from './transfer-store.js';
import { openDatabase } from '../../../packages/db/src/index.js';

type Client = Awaited<ReturnType<typeof apiFixture>>;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture();
  clients.push(client);
  const site = await client.createSite('Logical lab');
  const base = `/api/v1/sites/${site.id}`;
  const devices: Device[] = [];
  for (const displayName of ['Router', 'Switch', 'Server']) {
    const response = await client.request('POST', base + '/devices', {
      displayName,
    });
    expect(response.statusCode, response.body).toBe(201);
    devices.push(response.json().device);
  }
  const create = async (body: Record<string, unknown> = {}) => {
    const response = await client.request(
      'POST',
      base + '/logical-connections',
      {
        endpointADeviceId: devices[0]!.id,
        endpointBDeviceId: devices[1]!.id,
        ...body,
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().logicalConnection as LogicalConnection;
  };
  return { client, site, base, devices, create };
}
async function importRequest(
  client: Client,
  site: Site,
  document: SiteArchive,
  policy: 'new-site' | 'replace' = 'new-site',
  siteName = 'Logical copy',
) {
  const body = {
    document,
    policy,
    ...(policy === 'new-site' ? { siteName } : {}),
  };
  const response = await client.request(
    'POST',
    `/api/v1/sites/${site.id}/import/preview`,
    body,
  );
  expect(response.statusCode, response.body).toBe(200);
  return { ...body, previewToken: response.json().preview.token };
}

describe('logical device connections', () => {
  it('upgrades an existing template database without changing its template or earlier migration history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'portfolio-logical-upgrade-'));
    const migrationsDir = join(directory, 'migrations');
    const dataDir = join(directory, 'data');
    mkdirSync(migrationsDir);
    let db: DatabaseSync | undefined;
    try {
      for (const name of [
        '001_foundation.sql',
        '002_auth_organization.sql',
        '003_network_equipment.sql',
        '004_configure_grid.sql',
        '005_device_templates.sql',
      ])
        copyFileSync(
          resolve('packages/db/migrations', name),
          join(migrationsDir, name),
        );
      db = openDatabase({ dataDir, migrationsDir });
      const id = randomUUID();
      db.prepare(
        'INSERT INTO device_templates (id,name,type,description,groups_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, 'Existing custom template', 'custom', 'Preserved', '[]', 1, 1);
      const before = db
        .prepare('SELECT * FROM device_templates WHERE id=?')
        .get(id);
      const history = db
        .prepare('SELECT name,checksum FROM schema_migrations ORDER BY name')
        .all();
      db.close();
      db = undefined;
      copyFileSync(
        resolve('packages/db/migrations/006_logical_connections.sql'),
        join(migrationsDir, '006_logical_connections.sql'),
      );
      db = openDatabase({ dataDir, migrationsDir });
      expect(
        db.prepare('SELECT * FROM device_templates WHERE id=?').get(id),
      ).toEqual(before);
      expect(
        db
          .prepare(
            'SELECT name,checksum FROM schema_migrations ORDER BY name LIMIT 5',
          )
          .all(),
      ).toEqual(history);
      expect(
        db.prepare('SELECT count(*) n FROM logical_connections').get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare('SELECT count(*) n FROM schema_migrations').get(),
      ).toEqual({ n: 6 });
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('documents multiple logical links between distinct devices without requiring physical ports', async () => {
    const { client, base, devices, create } = await fixture();
    const first = await create({
      name: 'Site tunnel',
      protocol: 'WireGuard',
      notes: '<script>inert documentation</script>',
    });
    expect(first).toMatchObject({
      endpointADeviceId: devices[0]!.id,
      endpointBDeviceId: devices[1]!.id,
      name: 'Site tunnel',
      protocol: 'WireGuard',
      notes: '<script>inert documentation</script>',
      rowVersion: 1,
    });
    const second = await create({
      name: 'Routing adjacency',
      protocol: 'OSPF',
    });
    expect(second.id).not.toBe(first.id);
    expect(
      (await client.request('GET', base + '/logical-connections')).json()
        .logicalConnections,
    ).toHaveLength(2);
    expect(client.db.prepare('SELECT count(*) n FROM ports').get()).toEqual({
      n: 0,
    });
    const patched = await client.request(
      'PATCH',
      base + '/logical-connections/' + first.id,
      { endpointBDeviceId: devices[2]!.id, protocol: 'IPsec', rowVersion: 1 },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    const updated = patched.json().logicalConnection;
    expect(updated).toMatchObject({
      endpointBDeviceId: devices[2]!.id,
      protocol: 'IPsec',
      name: 'Site tunnel',
      rowVersion: 2,
    });
    expect(
      (
        await client.request(
          'PATCH',
          base + '/logical-connections/' + first.id,
          { notes: 'Lost edit', rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'DELETE',
          base + '/logical-connections/' + first.id,
          { rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(409);
    await client.restart();
    expect(
      (await client.request('GET', base + '/logical-connections')).json()
        .logicalConnections,
    ).toContainEqual(updated);
    expect(
      (
        await client.request(
          'DELETE',
          base + '/logical-connections/' + first.id,
          { rowVersion: 2 },
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await client.request('GET', base + '/logical-connections')).json()
        .logicalConnections,
    ).toEqual([second]);
  });

  it('enforces session, CSRF, origin and encoded-route checks plus strict bounded fields', async () => {
    const { client, base, devices } = await fixture();
    const url = base + '/logical-connections';
    const payload = {
      endpointADeviceId: devices[0]!.id,
      endpointBDeviceId: devices[1]!.id,
    };
    const unauth = await client.app.inject({
      url,
      headers: { host: '127.0.0.1:3088' },
    });
    expect(unauth.statusCode).toBe(401);
    expect(
      (await client.request('POST', url, payload, { 'x-csrf-token': 'forged' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await client.request('POST', url, payload, {
          origin: 'https://attacker.invalid',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request(
          'GET',
          url.replace('/api/', '/%61pi/'),
          undefined,
          { host: 'attacker.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    for (const body of [
      { ...payload, name: 'x'.repeat(121) },
      { ...payload, protocol: 'x'.repeat(121) },
      { ...payload, notes: 'x'.repeat(2001) },
      { ...payload, siteId: randomUUID() },
      { ...payload, endpointBDeviceId: devices[0]!.id },
    ])
      expect((await client.request('POST', url, body)).statusCode).toBe(400);
    const good = await client.request('POST', url, {
      ...payload,
      name: 'x'.repeat(120),
      protocol: 'x'.repeat(120),
      notes: 'x'.repeat(2000),
    });
    expect(good.statusCode).toBe(201);
    expect(good.headers['cache-control']).toBe('no-store');
    expect(
      (await client.request('GET', '/api/v1/sites/missing/logical-connections'))
        .statusCode,
    ).toBe(404);
  });

  it('isolates endpoints and records by site and preserves the graph after invalid patches', async () => {
    const { client, site, base, devices, create } = await fixture();
    const other = await client.createSite('Other');
    const remote = (
      await client.request('POST', `/api/v1/sites/${other.id}/devices`, {
        displayName: 'Remote',
      })
    ).json().device as Device;
    expect(
      (
        await client.request('POST', base + '/logical-connections', {
          endpointADeviceId: devices[0]!.id,
          endpointBDeviceId: remote.id,
        })
      ).statusCode,
    ).toBe(404);
    const connection = await create();
    expect(
      (
        await client.request(
          'PATCH',
          base + '/logical-connections/' + connection.id,
          { endpointBDeviceId: remote.id, rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request(
          'PATCH',
          base + '/logical-connections/' + connection.id,
          { endpointBDeviceId: devices[0]!.id, rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(400);
    const wrong = `/api/v1/sites/${other.id}/logical-connections/${connection.id}`;
    expect(
      (await client.request('PATCH', wrong, { name: 'Lost', rowVersion: 1 }))
        .statusCode,
    ).toBe(404);
    expect(
      (await client.request('DELETE', wrong, { rowVersion: 1 })).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request(
          'GET',
          `/api/v1/sites/${other.id}/logical-connections`,
        )
      ).json().logicalConnections,
    ).toEqual([]);
    expect(
      (await client.request('GET', base + '/logical-connections')).json()
        .logicalConnections,
    ).toEqual([connection]);
    expect(() =>
      client.db
        .prepare(
          'UPDATE logical_connections SET endpoint_b_device_id=? WHERE id=?',
        )
        .run(remote.id, connection.id),
    ).toThrow();
    expect(() =>
      client.db
        .prepare(
          'UPDATE logical_connections SET endpoint_b_device_id=? WHERE id=?',
        )
        .run(devices[0]!.id, connection.id),
    ).toThrow();
    expect(
      client.db
        .prepare('SELECT site_id FROM logical_connections WHERE id=?')
        .get(connection.id),
    ).toEqual({ site_id: site.id });
  });

  it('guards direct deletion of a logically linked device until its logical link is disconnected', async () => {
    const { client, base, devices, create } = await fixture();
    const connection = await create();
    const blocked = await client.request(
      'DELETE',
      base + '/devices/' + devices[0]!.id,
      { rowVersion: 1 },
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CONNECTED_DEVICE');
    expect(
      (await client.request('GET', base + '/devices/' + devices[0]!.id))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await client.request(
          'DELETE',
          base + '/logical-connections/' + connection.id,
          { rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await client.request('DELETE', base + '/devices/' + devices[0]!.id, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
  });

  it('round-trips logical links with remapped identities and accepts older v1 archives without the additive field', async () => {
    const { client, site, base, devices, create } = await fixture();
    await create({
      name: 'Tunnel',
      protocol: 'WireGuard',
      notes: 'Documented',
    });
    await create({ name: 'Adjacency', protocol: 'BGP' });
    const archive = exportSite(client.db, site.id);
    expect(archive.schemaVersion).toBe(1);
    expect(archive.logicalConnections).toHaveLength(2);
    const input = await importRequest(client, site, archive);
    const commit = await client.request('POST', base + '/import/commit', input);
    expect(commit.statusCode, commit.body).toBe(201);
    expect(commit.json().summary.logicalConnections).toBe(2);
    const copy = exportSite(client.db, commit.json().site.id);
    expect(copy.logicalConnections).toHaveLength(2);
    const oldIds = new Set(archive.logicalConnections.map((link) => link.id));
    const copiedDevices = new Map(
      copy.devices.map((device) => [device.id, device.displayName]),
    );
    for (const link of copy.logicalConnections) {
      expect(oldIds.has(link.id)).toBe(false);
      expect(link.rowVersion).toBe(1);
      expect(link.siteId).toBe(copy.site.id);
      expect(copiedDevices.get(link.endpointADeviceId)).toBe(
        devices[0]!.displayName,
      );
      expect(copiedDevices.get(link.endpointBDeviceId)).toBe(
        devices[1]!.displayName,
      );
    }
    expect(copy.logicalConnections.map((link) => link.name).sort()).toEqual([
      'Adjacency',
      'Tunnel',
    ]);
    const oldDocument: Partial<SiteArchive> = { ...archive };
    delete oldDocument.logicalConnections;
    const oldPreview = await client.request('POST', base + '/import/preview', {
      document: oldDocument,
      policy: 'new-site',
      siteName: 'Legacy copy',
    });
    expect(oldPreview.statusCode, oldPreview.body).toBe(200);
    expect(oldPreview.json().preview.summary.logicalConnections).toBe(0);
    const legacy = await client.request('POST', base + '/import/commit', {
      document: oldDocument,
      policy: 'new-site',
      siteName: 'Legacy copy',
      previewToken: oldPreview.json().preview.token,
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(
      exportSite(client.db, legacy.json().site.id).logicalConnections,
    ).toEqual([]);
  });

  it('rejects invalid logical archive references and rolls back a late logical insert failure after replacement deletion', async () => {
    const { client, site, base, devices, create } = await fixture();
    const connection = await create({ name: 'Keep' });
    const archive = exportSite(client.db, site.id);
    for (const logical of [
      { ...connection, endpointBDeviceId: randomUUID() },
      { ...connection, endpointBDeviceId: devices[0]!.id },
      { ...connection, siteId: randomUUID() },
      { ...connection, id: devices[0]!.id },
    ]) {
      const response = await client.request('POST', base + '/import/preview', {
        document: { ...archive, logicalConnections: [logical] },
        policy: 'replace',
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    const input = await importRequest(client, site, archive, 'replace');
    client.db.exec(
      "CREATE TRIGGER reject_logical_import BEFORE INSERT ON logical_connections BEGIN SELECT RAISE(ABORT,'Synthetic logical import failure'); END;",
    );
    const failed = await client.request('POST', base + '/import/commit', {
      ...input,
      confirmReplace: true,
    });
    expect(failed.statusCode, failed.body).toBe(400);
    expect(exportSite(client.db, site.id)).toEqual(archive);
    client.db.exec('DROP TRIGGER reject_logical_import');
    const replaced = await client.request('POST', base + '/import/commit', {
      ...input,
      confirmReplace: true,
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const copy = exportSite(client.db, site.id);
    expect(copy.logicalConnections).toHaveLength(1);
    expect(copy.logicalConnections[0]!.name).toBe('Keep');
    expect(copy.logicalConnections[0]!.id).not.toBe(connection.id);
  });

  it('invalidates an import preview when its target logical link changes', async () => {
    const { client, site, base, create } = await fixture();
    const link = await create({ name: 'Initial' });
    const archive = exportSite(client.db, site.id);
    const input = await importRequest(client, site, archive, 'replace');
    expect(
      (
        await client.request(
          'PATCH',
          base + '/logical-connections/' + link.id,
          { name: 'Concurrent edit', rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(200);
    const before = exportSite(client.db, site.id);
    const commit = await client.request('POST', base + '/import/commit', {
      ...input,
      confirmReplace: true,
    });
    expect(commit.statusCode).toBe(409);
    expect(exportSite(client.db, site.id)).toEqual(before);
  });

  it('removes logical links child-first on site/workspace cascade while preserving unrelated sites and rolling back failures', async () => {
    const { client, site, base, create } = await fixture();
    await create();
    const other = await client.createSite('Unrelated');
    const unrelated = exportSite(client.db, other.id);
    const impact = (
      await client.request('GET', base + '/deletion-impact')
    ).json();
    expect(impact.impact.logicalConnections).toBe(1);
    const before = exportSite(client.db, site.id);
    client.db.exec(
      "CREATE TRIGGER reject_device_cascade BEFORE DELETE ON devices BEGIN SELECT RAISE(ABORT,'Synthetic cascade failure'); END;",
    );
    const failed = await client.request('DELETE', base, { rowVersion: 1 });
    expect(failed.statusCode).toBe(400);
    expect(exportSite(client.db, site.id)).toEqual(before);
    client.db.exec('DROP TRIGGER reject_device_cascade');
    const cascade = await client.request('DELETE', base, { rowVersion: 1 });
    expect(cascade.statusCode, cascade.body).toBe(204);
    expect(
      client.db
        .prepare('SELECT id FROM logical_connections WHERE site_id=?')
        .all(site.id),
    ).toEqual([]);
    expect(exportSite(client.db, other.id)).toEqual(unrelated);
    const copySite = await client.createSite(
      'Workspace child',
      site.workspaceId,
    );
    const created: Device[] = [];
    for (const displayName of ['A', 'B'])
      created.push(
        (
          await client.request('POST', `/api/v1/sites/${copySite.id}/devices`, {
            displayName,
          })
        ).json().device,
      );
    expect(
      (
        await client.request(
          'POST',
          `/api/v1/sites/${copySite.id}/logical-connections`,
          {
            endpointADeviceId: created[0]!.id,
            endpointBDeviceId: created[1]!.id,
          },
        )
      ).statusCode,
    ).toBe(201);
    const workspaceImpact = (
      await client.request(
        'GET',
        `/api/v1/workspaces/${site.workspaceId}/deletion-impact`,
      )
    ).json();
    expect(workspaceImpact.impact.logicalConnections).toBe(1);
    expect(
      (
        await client.request(
          'DELETE',
          `/api/v1/workspaces/${site.workspaceId}`,
          { rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(204);
    expect(
      client.db.prepare('SELECT id FROM logical_connections').all(),
    ).toEqual([]);
    expect(exportSite(client.db, other.id)).toEqual(unrelated);
  });
});
