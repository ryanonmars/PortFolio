import { randomUUID } from 'node:crypto';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import * as database from '../../../packages/db/src/index.js';
import { ARCHIVE_MAX_BYTES } from '../../../packages/shared/src/index.js';
import type {
  Connection,
  Device,
  Port,
  PortField,
  Site,
  SiteArchive,
  Vlan,
} from '../../../packages/shared/src/index.js';
import { exportSite, readTransferSnapshot } from './transfer-store.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
});

async function fixture() {
  const client = await apiFixture();
  clients.push(client);
  const site = await client.createSite('Export lab');
  const base = `/api/v1/sites/${site.id}`;
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await client.request('POST', base + path, data);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as T;
  };
  const vlans: Vlan[] = [];
  for (const vlanId of [1, 20, 30])
    vlans.push(
      (
        await post<{ vlan: Vlan }>('/vlans', {
          vlanId,
          name: String(vlanId),
          color: '#428deb',
        })
      ).vlan,
    );
  const rack = (
    await post<{ rack: { id: string } }>('/racks', { name: 'Optional rack' })
  ).rack;
  const subnet = (
    await post<{ subnet: { id: string } }>('/subnets', {
      cidr: '192.0.2.0/24',
      name: 'Synthetic network',
      vlanRef: vlans[1]!.id,
      gatewayIp: '192.0.2.1',
      dnsServers: ['192.0.2.53'],
    })
  ).subnet;
  await post(`/subnets/${subnet.id}/dhcp-scopes`, {
    name: 'Lease pool',
    startIp: '192.0.2.100',
    endIp: '192.0.2.150',
    enabled: false,
  });
  const devices: Device[] = [];
  const portLists: Port[][] = [];
  for (const [displayName, type, count] of [
    ['Synthetic router', 'router', 11],
    ['Synthetic switch', 'switch', 8],
  ] as const) {
    const device = (
      await post<{ device: Device }>('/devices', {
        displayName,
        type,
        rackId: type === 'switch' ? rack.id : null,
        description: '<script>window.importUnsafe=true</script>',
        tags: ['Metadata tag'],
        orderIndex: devices.length,
      })
    ).device;
    const generated = await post<{ device: Device; ports: Port[] }>(
      `/devices/${device.id}/ports/generate`,
      { count, rowVersion: device.rowVersion },
    );
    devices.push(generated.device);
    portLists.push(generated.ports);
  }
  const patch = async (port: Port, data: unknown) => {
    const response = await client.request('PATCH', base + '/ports/' + port.id, {
      rowVersion: port.rowVersion,
      ...(data as object),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().port as Port;
  };
  portLists[0]![3] = await patch(portLists[0]![3]!, {
    mode: 'routed',
    pvid: 4092,
    description: 'WAN uplink',
    face: 'rear',
  });
  portLists[0]![0] = await patch(portLists[0]![0]!, {
    kind: 'sfp_plus',
    speed: '10G',
  });
  portLists[0]![4] = await patch(portLists[0]![4]!, {
    mode: 'trunk',
    nativeVlanRef: vlans[0]!.id,
    taggedVlanRefs: [vlans[1]!.id, vlans[2]!.id],
    pvid: 1,
    documentedLinkState: 'up',
  });
  portLists[1]![0] = await patch(portLists[1]![0]!, {
    mode: 'trunk',
    nativeVlanRef: vlans[0]!.id,
    taggedVlanRefs: [vlans[1]!.id, vlans[2]!.id],
    pvid: 1,
    externalDestinationLabel: 'Separate manual annotation',
  });
  const fields: PortField[] = [];
  for (const [key, valueType, defaultValue] of [
    ['watts', 'number', 1],
    ['poe', 'boolean', true],
    ['note', 'text', 'Default'],
  ] as const)
    fields.push(
      (
        await post<{ field: PortField }>('/port-fields', {
          key,
          title: key,
          valueType,
          defaultValue,
        })
      ).field,
    );
  const custom = await client.request('POST', base + '/ports/bulk-edit', {
    updates: [
      {
        portId: portLists[1]![1]!.id,
        rowVersion: 1,
        changes: {},
        customValues: {
          [fields[0]!.id]: 0,
          [fields[1]!.id]: false,
          [fields[2]!.id]: null,
        },
      },
    ],
  });
  expect(custom.statusCode, custom.body).toBe(200);
  await post<{ connection: Connection }>('/connections', {
    endpointAPortId: portLists[0]![4]!.id,
    endpointBPortId: portLists[1]![0]!.id,
    endpointARowVersion: portLists[0]![4]!.rowVersion,
    endpointBRowVersion: portLists[1]![0]!.rowVersion,
    cableType: 'Cat6',
    notes: 'Synthetic reciprocal cable',
  });
  const archive = exportSite(client.db, site.id);
  return { client, site, base, archive };
}
async function preview(
  client: Fixture,
  site: Site,
  document: SiteArchive,
  policy: 'new-site' | 'replace' = 'new-site',
  siteName = 'Imported copy',
) {
  const input = {
    document,
    policy,
    ...(policy === 'new-site' ? { siteName } : {}),
  };
  const response = await client.request(
    'POST',
    `/api/v1/sites/${site.id}/import/preview`,
    input,
  );
  expect(response.statusCode, response.body).toBe(200);
  return { ...input, previewToken: response.json().preview.token as string };
}
function semantic(document: SiteArchive): unknown {
  const identities = new Map<string, string>([
    [document.workspace.id, 'workspace'],
    [document.site.id, 'site'],
  ]);
  for (const item of document.racks)
    identities.set(item.id, 'rack:' + item.name);
  for (const item of document.vlans)
    identities.set(item.id, 'vlan:' + item.vlanId);
  for (const item of document.subnets)
    identities.set(item.id, 'subnet:' + item.cidr);
  for (const item of document.dhcpScopes)
    identities.set(item.id, 'scope:' + item.name);
  for (const item of document.devices)
    identities.set(item.id, 'device:' + item.displayName);
  for (const item of document.ports)
    identities.set(item.id, identities.get(item.deviceId) + '/' + item.name);
  for (const item of document.fields)
    identities.set(item.id, 'field:' + item.key);
  for (const item of document.connections)
    identities.set(
      item.id,
      'connection:' +
        identities.get(item.endpointAPortId) +
        '/' +
        identities.get(item.endpointBPortId),
    );
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return identities.get(value) ?? value;
    if (Array.isArray(value))
      return value
        .map(visit)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'rowVersion')
          .map(([key, item]) => [key, visit(item)]),
      );
    return value;
  };
  const normalized = structuredClone(document);
  normalized.site.name = 'Import target';
  return visit(normalized);
}

describe('M5 site transfer', () => {
  it('preserves visible ordering when valid equipment, racks and custom fields share order indices', async () => {
    const { client, site, base } = await fixture();
    for (const name of ['Second rack', 'Third rack']) {
      expect(
        (await client.request('POST', base + '/racks', { name, orderIndex: 0 }))
          .statusCode,
      ).toBe(201);
    }
    expect(
      (
        await client.request('POST', base + '/devices', {
          displayName: 'Third device',
          orderIndex: 0,
        })
      ).statusCode,
    ).toBe(201);
    client.db
      .prepare('UPDATE devices SET order_index=0 WHERE site_id=?')
      .run(site.id);
    client.db
      .prepare('UPDATE racks SET order_index=0 WHERE site_id=?')
      .run(site.id);
    client.db
      .prepare(
        'UPDATE port_custom_field_defs SET column_order=100 WHERE site_id=?',
      )
      .run(site.id);
    const before = exportSite(client.db, site.id);
    const request = await preview(
      client,
      site,
      before,
      'new-site',
      'Ordered copy',
    );
    const response = await client.request(
      'POST',
      base + '/import/commit',
      request,
    );
    expect(response.statusCode, response.body).toBe(201);
    const copy = exportSite(client.db, response.json().site.id);
    expect(copy.devices.map((record) => record.displayName)).toEqual(
      before.devices.map((record) => record.displayName),
    );
    expect(copy.racks.map((record) => record.name)).toEqual(
      before.racks.map((record) => record.name),
    );
    expect(copy.fields.map((record) => record.key)).toEqual(
      before.fields.map((record) => record.key),
    );
    expect(copy.devices.map((record) => record.orderIndex)).toEqual(
      before.devices.map((record) => record.orderIndex),
    );
    expect(copy.fields.map((record) => record.columnOrder)).toEqual(
      before.fields.map((record) => record.columnOrder),
    );
    expect(semantic(copy)).toEqual(semantic(before));
  });
  it('imports a closed graph into another workspace without moving or changing its source', async () => {
    const { client, site, archive } = await fixture();
    const target = await client.createSite(
      'Destination in a different workspace',
    );
    expect(target.workspaceId).not.toBe(site.workspaceId);
    const before = exportSite(client.db, target.id);
    const request = await preview(
      client,
      target,
      archive,
      'new-site',
      'Cross-workspace copy',
    );
    const response = await client.request(
      'POST',
      `/api/v1/sites/${target.id}/import/commit`,
      request,
    );
    expect(response.statusCode, response.body).toBe(201);
    const imported: Site = response.json().site;
    expect(imported.workspaceId).toBe(target.workspaceId);
    const copy = exportSite(client.db, imported.id);
    expect(semantic(copy)).toEqual(
      semantic({
        ...archive,
        workspace: copy.workspace,
        site: { ...archive.site, workspaceId: copy.workspace.id },
      }),
    );
    expect(exportSite(client.db, site.id)).toEqual(archive);
    expect(exportSite(client.db, target.id)).toEqual(before);
  });
  it('reads complete graphs through one SQLite snapshot without nesting caller transactions', async () => {
    const { client, site, archive } = await fixture();
    const writer = new DatabaseSync(join(client.dataDir, 'app.sqlite'));
    try {
      readTransferSnapshot(client.db, () => {
        expect(exportSite(client.db, site.id)).toEqual(archive);
        writer
          .prepare(
            'UPDATE ports SET description=?,row_version=row_version+1 WHERE id=?',
          )
          .run('External SQLite writer', archive.ports[0]!.id);
        expect(exportSite(client.db, site.id)).toEqual(archive);
      });
      expect(client.db.isTransaction).toBe(false);
      expect(
        exportSite(client.db, site.id).ports.find(
          (port) => port.id === archive.ports[0]!.id,
        )?.description,
      ).toBe('External SQLite writer');
      expect(() =>
        readTransferSnapshot(client.db, () => {
          throw new Error('Synthetic read failure');
        }),
      ).toThrow('Synthetic read failure');
      expect(client.db.isTransaction).toBe(false);
    } finally {
      writer.close();
    }
  });
  it('exports stable private documentation and round-trips all graph semantics with fresh IDs, backups and restart', async () => {
    const { client, site, base, archive } = await fixture();
    const response = await client.request('GET', base + '/export?format=json');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(archive);
    expect(response.headers['content-disposition']).toContain(
      'attachment; filename="portfolio-site-',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await client.request('GET', base + '/export')).body).toBe(
      response.body,
    );
    for (const forbidden of [
      'password_hash',
      'csrf_token',
      'token_hash',
      'users',
      'sessions',
    ])
      expect(response.body).not.toContain(forbidden);
    const before = exportSite(client.db, site.id);
    const request = await preview(client, site, archive);
    expect(exportSite(client.db, site.id)).toEqual(before);
    expect(readdirSync(client.dataDir)).not.toContain('backups');
    const imported = await client.request(
      'POST',
      base + '/import/commit',
      request,
    );
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json()).toMatchObject({
      backupCreated: true,
      summary: {
        devices: 2,
        ports: 19,
        vlans: 3,
        connections: 1,
        customValues: 3,
      },
    });
    expect(imported.body).not.toContain(client.dataDir);
    const newSite: Site = imported.json().site;
    expect(newSite.name).toBe('Imported copy');
    expect(newSite.workspaceId).toBe(site.workspaceId);
    const copy = exportSite(client.db, newSite.id);
    expect(semantic(copy)).toEqual(semantic(archive));
    const oldIds = new Set(
      [
        ...archive.devices,
        ...archive.ports,
        ...archive.vlans,
        ...archive.racks,
        ...archive.fields,
        ...archive.connections,
      ].map((row) => row.id),
    );
    for (const row of [
      ...copy.devices,
      ...copy.ports,
      ...copy.vlans,
      ...copy.racks,
      ...copy.fields,
      ...copy.connections,
    ]) {
      expect(oldIds.has(row.id)).toBe(false);
      expect(row.rowVersion).toBe(1);
    }
    const backups = readdirSync(join(client.dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    const path = join(client.dataDir, 'backups', backups[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const backup = new DatabaseSync(path, { readOnly: true });
    try {
      expect(exportSite(backup, site.id)).toEqual(before);
      expect(backup.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        backup.prepare('SELECT id FROM sites WHERE id=?').get(newSite.id),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
    await client.restart();
    expect(exportSite(client.db, newSite.id)).toEqual(copy);
    expect(
      (
        await client.request('GET', `/api/v1/sites/${newSite.id}/export`)
      ).json(),
    ).toEqual(copy);
    expect(
      (await client.request('POST', base + '/import/commit', request))
        .statusCode,
    ).toBe(409);
    expect(exportSite(client.db, site.id)).toEqual(before);
  });

  it('requires explicit replacement, retains site identity, and rejects changed preview targets and source data', async () => {
    const { client, site, base, archive } = await fixture();
    const other = await client.createSite('Unrelated', site.workspaceId);
    const unrelated = exportSite(client.db, other.id);
    const request = await preview(client, site, archive, 'replace');
    expect(
      (await client.request('POST', base + '/import/commit', request))
        .statusCode,
    ).toBe(400);
    expect(exportSite(client.db, site.id)).toEqual(archive);
    const changed = structuredClone(request);
    changed.document.ports[0]!.description = 'Changed after preview';
    expect(
      (
        await client.request('POST', base + '/import/commit', {
          ...changed,
          confirmReplace: true,
        })
      ).statusCode,
    ).toBe(409);
    const port = archive.ports[0]!;
    expect(
      (
        await client.request('PATCH', base + '/ports/' + port.id, {
          rowVersion: port.rowVersion,
          description: 'Concurrent edit',
        })
      ).statusCode,
    ).toBe(200);
    const concurrent = exportSite(client.db, site.id);
    expect(
      (
        await client.request('POST', base + '/import/commit', {
          ...request,
          confirmReplace: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(exportSite(client.db, site.id)).toEqual(concurrent);
    const fresh = await preview(client, site, archive, 'replace');
    const result = await client.request('POST', base + '/import/commit', {
      ...fresh,
      confirmReplace: true,
    });
    expect(result.statusCode, result.body).toBe(200);
    const saved: Site = result.json().site;
    expect(saved).toMatchObject({
      id: site.id,
      workspaceId: site.workspaceId,
      name: site.name,
      rowVersion: site.rowVersion + 1,
    });
    expect(semantic(exportSite(client.db, site.id))).toEqual(semantic(archive));
    expect(exportSite(client.db, other.id)).toEqual(unrelated);
  });

  it('rejects invalid complete graphs and unauthorized requests without creating backups or changing data', async () => {
    const { client, site, base, archive } = await fixture();
    const invalids: unknown[] = [
      { ...archive, schemaVersion: 99 },
      { ...archive, users: [] },
      { ...archive, ports: [...archive.ports, archive.ports[0]] },
      {
        ...archive,
        connections: [
          ...archive.connections,
          { ...archive.connections[0], id: randomUUID() },
        ],
      },
      {
        ...archive,
        customValues: [
          {
            ...archive.customValues.find(
              (value) =>
                value.fieldId ===
                archive.fields.find((field) => field.key === 'watts')!.id,
            )!,
            value: 'wrong type',
          },
        ],
      },
    ];
    const cross = structuredClone(archive);
    cross.ports[0]!.nativeVlanRef = randomUUID();
    invalids.push(cross);
    const dhcp = structuredClone(archive);
    dhcp.dhcpScopes[0]!.endIp = '198.51.100.50';
    invalids.push(dhcp);
    for (const document of invalids) {
      const response = await client.request('POST', base + '/import/preview', {
        document,
        policy: 'replace',
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    const headers = { host: '127.0.0.1:3088', origin: 'http://127.0.0.1:3088' };
    expect(
      (
        await client.app.inject({
          method: 'GET',
          url: base + '/export',
          headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await client.request(
          'POST',
          base + '/import/preview',
          { document: archive, policy: 'replace' },
          { 'x-csrf-token': 'incorrect' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request('POST', base + '/import/preview', {
          document: archive,
          policy: 'new-site',
          siteName: site.name,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await client.request('GET', base + '/export?format=csv')).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request('POST', base + '/import/preview', {
          oversized: 'x'.repeat(ARCHIVE_MAX_BYTES + 65536),
        })
      ).statusCode,
    ).toBe(413);
    expect(exportSite(client.db, site.id)).toEqual(archive);
    expect(readdirSync(client.dataDir)).not.toContain('backups');
  });

  it('refuses token tampering, replay across routes, expired previews and restart-invalidated previews', async () => {
    const { client, site, base, archive } = await fixture();
    const other = await client.createSite('Other', site.workspaceId);
    const request = await preview(client, site, archive);
    expect(
      (
        await client.request('POST', base + '/import/commit', {
          ...request,
          previewToken: request.previewToken + '.invalid',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'POST',
          `/api/v1/sites/${other.id}/import/commit`,
          request,
        )
      ).statusCode,
    ).toBe(409);
    const expiredPayload = Buffer.from(
      JSON.stringify({ binding: 'irrelevant', expiresAt: 1 }),
    ).toString('base64url');
    expect(
      (
        await client.request('POST', base + '/import/commit', {
          ...request,
          previewToken:
            expiredPayload + '.' + request.previewToken.split('.')[1],
        })
      ).statusCode,
    ).toBe(409);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      expect(
        (await client.request('POST', base + '/import/commit', request))
          .statusCode,
      ).toBe(409);
    } finally {
      clock.mockRestore();
    }
    await client.restart();
    expect(
      (await client.request('POST', base + '/import/commit', request))
        .statusCode,
    ).toBe(409);
    expect(exportSite(client.db, site.id)).toEqual(archive);
  });

  it('does not import when backup creation fails and rolls back a late insertion failure after deletion', async () => {
    const { client, site, base, archive } = await fixture();
    const request = await preview(client, site, archive, 'replace');
    client.db.exec(
      "CREATE TRIGGER reject_import_port BEFORE INSERT ON ports BEGIN SELECT RAISE(ABORT,'Synthetic late import failure'); END;",
    );
    const failed = await client.request('POST', base + '/import/commit', {
      ...request,
      confirmReplace: true,
    });
    expect(failed.statusCode, failed.body).toBe(400);
    expect(exportSite(client.db, site.id)).toEqual(archive);
    expect(readdirSync(join(client.dataDir, 'backups'))).toHaveLength(1);
    const second = await apiFixture();
    clients.push(second);
    const empty = await second.createSite('Backup failure');
    const secondBase = `/api/v1/sites/${empty.id}`;
    const attempt = await preview(second, empty, archive);
    writeFileSync(
      join(second.dataDir, 'backups'),
      'A file prevents the backup directory',
    );
    const failure = await second.request(
      'POST',
      secondBase + '/import/commit',
      attempt,
    );
    expect(failure.statusCode, failure.body).toBe(500);
    expect(failure.json().error.code).toBe('BACKUP_FAILED');
    expect(second.db.prepare('SELECT id FROM sites').all()).toHaveLength(1);
    expect(exportSite(second.db, empty.id).ports).toEqual([]);
  });

  it('rechecks the target after asynchronous backup so concurrent edits cannot be overwritten', async () => {
    const { client, site, base, archive } = await fixture();
    const request = await preview(client, site, archive, 'replace');
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realBackup = database.backupDatabase;
    vi.spyOn(database, 'backupDatabase').mockImplementationOnce(
      async (...args) => {
        start();
        await gate;
        await realBackup(...args);
      },
    );
    const committing = client.request('POST', base + '/import/commit', {
      ...request,
      confirmReplace: true,
    });
    await started;
    const port = archive.ports[0]!;
    try {
      const edited = await client.request('PATCH', base + '/ports/' + port.id, {
        rowVersion: port.rowVersion,
        description: 'Edit while recovery snapshot is being created',
      });
      expect(edited.statusCode, edited.body).toBe(200);
    } finally {
      release();
    }
    const current = exportSite(client.db, site.id);
    const rejected = await committing;
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(exportSite(client.db, site.id)).toEqual(current);
    expect(readdirSync(join(client.dataDir, 'backups'))).toHaveLength(1);
  });
});
