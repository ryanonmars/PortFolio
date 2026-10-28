import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, openDatabase, restoreDatabase } from './index.js';
import { migrateLegacyBoards } from './board-migration.js';
import { seedDemo } from './demo.js';
import {
  boardDocumentSchema,
  type BoardDocument,
} from '../../shared/src/board.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function directory() {
  const result = mkdtempSync(join(tmpdir(), 'portfolio-board-migration-'));
  cleanups.push(() => rmSync(result, { recursive: true, force: true }));
  return result;
}
function prior() {
  const dataDir = directory();
  const migrationsDir = join(dataDir, 'migrations');
  mkdirSync(migrationsDir);
  for (const name of readdirSync('packages/db/migrations').filter((name) =>
    /^00[1-6]_/.test(name),
  ))
    copyFileSync(
      join('packages/db/migrations', name),
      join(migrationsDir, name),
    );
  const db = openDatabase({ dataDir, migrationsDir });
  const seeded = seedDemo(
    db,
    JSON.parse(readFileSync('examples/sample-site.json', 'utf8')),
    'test',
  );
  return { dataDir, db, seeded };
}
const readDocument = (
  db: ReturnType<typeof openDatabase>,
  id: string,
): BoardDocument =>
  JSON.parse(
    String(
      db.prepare('SELECT document_json FROM boards WHERE id=?').get(id)!
        .document_json,
    ),
  ) as BoardDocument;

describe('additive board migration', () => {
  it('makes legacy VLANs, subnets and every DHCP scope visible and editable as independent network entries', () => {
    const { dataDir, db: old, seeded } = prior();
    const vlan = old
      .prepare('SELECT id FROM vlans WHERE site_id=? AND vlan_id=20')
      .get(seeded.siteId) as { id: string };
    old
      .prepare('UPDATE sites SET description=?,notes=? WHERE id=?')
      .run('Site description', 'Site notes', seeded.siteId);
    old
      .prepare('UPDATE vlans SET description=? WHERE id=?')
      .run('VLAN notes', vlan.id);
    const subnetId = randomUUID();
    old
      .prepare(
        'INSERT INTO subnets (id,site_id,vlan_ref,cidr,name,gateway_ip,dns_servers_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1)',
      )
      .run(
        subnetId,
        seeded.siteId,
        vlan.id,
        '192.0.2.0/24',
        'Office subnet',
        '192.0.2.1',
        '["192.0.2.53","192.0.2.54"]',
        'Subnet notes',
      );
    const insertScope = old.prepare(
      'INSERT INTO dhcp_scopes (id,site_id,subnet_id,name,start_ip,end_ip,enabled,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1)',
    );
    insertScope.run(
      randomUUID(),
      seeded.siteId,
      subnetId,
      'Primary pool',
      '192.0.2.50',
      '192.0.2.80',
      1,
      'Primary notes',
    );
    insertScope.run(
      randomUUID(),
      seeded.siteId,
      subnetId,
      'Spare pool',
      '192.0.2.90',
      '192.0.2.100',
      0,
      'Spare notes',
    );
    old.close();
    const db = openDatabase({ dataDir });
    cleanups.push(() => db.close());
    const document = readDocument(db, seeded.siteId);
    const network = document.elements.find(
      (element) => element.type === 'network',
    )!;
    expect(network.properties.notes).toBe('Site description\n\nSite notes');
    const entries = network.properties.entries as Record<string, string>[];
    expect(
      entries.find((entry) => entry.vlanId === '20' && entry.subnet === ''),
    ).toMatchObject({ vlanName: 'Servers', notes: 'VLAN notes', pvid: '' });
    expect(
      entries.find((entry) => entry.name === 'Office subnet'),
    ).toMatchObject({
      vlanId: '20',
      vlanName: 'Servers',
      subnet: '192.0.2.0/24',
      gateway: '192.0.2.1',
      dns: '192.0.2.53, 192.0.2.54',
      notes: 'Subnet notes',
      pvid: '',
      dhcpStatus: '',
    });
    expect(
      entries.find((entry) => entry.name === 'Primary pool'),
    ).toMatchObject({
      subnet: '192.0.2.0/24',
      dhcpStatus: 'Enabled',
      dhcpStart: '192.0.2.50',
      dhcpEnd: '192.0.2.80',
      notes: 'Subnet notes\n\nPrimary notes',
    });
    expect(entries.find((entry) => entry.name === 'Spare pool')).toMatchObject({
      subnet: '192.0.2.0/24',
      dhcpStatus: 'Disabled',
      dhcpStart: '192.0.2.90',
      dhcpEnd: '192.0.2.100',
    });
    expect(network.properties.subnets).toBeDefined();
    expect(network.properties.dhcpScopes).toBeDefined();
    expect(
      db
        .prepare('SELECT description,notes FROM sites WHERE id=?')
        .get(seeded.siteId),
    ).toEqual({ description: 'Site description', notes: 'Site notes' });
  });
  it('preserves every legacy row and stable equipment identity while converting sites to grouped boards', () => {
    const { dataDir, db: old, seeded } = prior();
    const ports = old
      .prepare('SELECT id,device_id FROM ports ORDER BY order_index,id')
      .all() as { id: string; device_id: string }[];
    const devices = old.prepare('SELECT id FROM devices ORDER BY id').all() as {
      id: string;
    }[];
    old.prepare('UPDATE ports SET face=? WHERE id=?').run('rear', ports[0]!.id);
    old
      .prepare(
        "INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES ('user','admin','synthetic-secret-hash',1,1)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES ('token','user','csrf',9999999999999,1)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO port_custom_field_defs (id,site_id,key,title,value_type,default_value_json,created_at,updated_at) VALUES ('field',?,'poe','PoE','boolean','true',1,1)",
      )
      .run(seeded.siteId);
    old
      .prepare(
        "INSERT INTO port_custom_values (port_id,field_def_id,site_id,value_json) VALUES (?,'field',?,'false')",
      )
      .run(ports[0]!.id, seeded.siteId);
    old
      .prepare(
        'INSERT INTO logical_connections (id,site_id,endpoint_a_device_id,endpoint_b_device_id,name,protocol,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)',
      )
      .run(
        'logical',
        seeded.siteId,
        devices[0]!.id,
        devices[1]!.id,
        'VPN',
        'WireGuard',
      );
    old
      .prepare(
        "INSERT INTO device_templates(id,name,type,groups_json,created_at,updated_at) VALUES ('template','Custom','custom','[]',1,1)",
      )
      .run();
    const tables = [
      'workspaces',
      'sites',
      'racks',
      'vlans',
      'subnets',
      'dhcp_scopes',
      'devices',
      'ports',
      'port_tagged_vlans',
      'port_custom_field_defs',
      'port_custom_values',
      'connections',
      'logical_connections',
      'device_templates',
      'users',
      'sessions',
    ];
    const before = Object.fromEntries(
      tables.map((table) => [
        table,
        old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
    const history = old
      .prepare('SELECT * FROM schema_migrations ORDER BY name')
      .all();
    old.close();
    const db = openDatabase({ dataDir });
    cleanups.push(() => db.close());
    for (const table of tables)
      expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(
        before[table],
      );
    expect(
      db
        .prepare('SELECT * FROM schema_migrations ORDER BY name')
        .all()
        .slice(0, 6),
    ).toEqual(history);
    expect(db.prepare('SELECT id,group_id,name FROM boards').get()).toEqual({
      id: seeded.siteId,
      group_id: seeded.workspaceId,
      name: 'Example Lab',
    });
    const document = readDocument(db, seeded.siteId);
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      document.elements
        .filter((element) => element.type === 'device')
        .map((element) => element.id)
        .sort(),
    ).toEqual(devices.map((device) => device.id).sort());
    expect(document.ports.map((port) => port.id).sort()).toEqual(
      ports.map((port) => port.id).sort(),
    );
    expect(
      document.ports.find((port) => port.id === ports[0]!.id),
    ).toMatchObject({ face: 'rear', customFields: { poe: false } });
    expect(
      document.ports.find((port) => port.nativeVlan === '20'),
    ).toBeDefined();
    expect(document.ports.find((port) => port.role === 'routed')).toMatchObject(
      { nativeVlan: '', pvid: '' },
    );
    expect(document.cables).toHaveLength(seeded.connections);
    expect(
      document.elements.some((element) => element.type === 'network'),
    ).toBe(true);
    expect(document.legacy!.format).toBe('portfolio-relational-snapshot-v1');
    const serialized = JSON.stringify(document.legacy);
    expect(serialized).toContain('WireGuard');
    expect(serialized).toContain('Custom');
    expect(serialized).not.toContain('synthetic-secret-hash');
    const saved = db.prepare('SELECT document_json FROM boards').get();
    migrateLegacyBoards(db);
    expect(db.prepare('SELECT document_json FROM boards').get()).toEqual(saved);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps deleted boards and groups deleted across migration retries and restarts', () => {
    const { dataDir, db: old, seeded } = prior();
    old.close();
    let db = openDatabase({ dataDir });
    db.prepare('DELETE FROM boards WHERE id=?').run(seeded.siteId);
    db.prepare('DELETE FROM board_groups WHERE id=?').run(seeded.workspaceId);
    migrateLegacyBoards(db);
    expect(db.prepare('SELECT count(*) n FROM boards').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM board_groups').get()).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT board_id FROM board_legacy_sites').get()).toEqual(
      { board_id: null },
    );
    db.close();
    db = openDatabase({ dataDir });
    cleanups.push(() => db.close());
    expect(db.prepare('SELECT count(*) n FROM boards').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM board_groups').get()).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT id FROM sites').get()).toEqual({
      id: seeded.siteId,
    });
  });

  it('rolls back the entire data conversion on failure and can retry without damaging legacy records', () => {
    const { dataDir, db: old, seeded } = prior();
    old.close();
    const db = openDatabase({ dataDir });
    cleanups.push(() => db.close());
    db.exec(
      'DELETE FROM boards; DELETE FROM board_legacy_sites; DELETE FROM board_legacy_groups; DELETE FROM board_groups;',
    );
    db.exec(
      "CREATE TRIGGER fail_board_insert BEFORE INSERT ON boards BEGIN SELECT RAISE(ABORT,'simulated conversion failure'); END;",
    );
    expect(() => migrateLegacyBoards(db)).toThrow(
      'simulated conversion failure',
    );
    expect(db.prepare('SELECT count(*) n FROM board_groups').get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare('SELECT count(*) n FROM board_legacy_sites').get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM ports').get()).toEqual({
      n: seeded.ports,
    });
    db.exec('DROP TRIGGER fail_board_insert');
    migrateLegacyBoards(db);
    expect(db.prepare('SELECT id FROM boards').get()).toEqual({
      id: seeded.siteId,
    });
  });

  it('preserves overflow equipment and long source strings losslessly in the recoverable legacy payload', () => {
    const { dataDir, db: old, seeded } = prior();
    const insert = old.prepare(
      "INSERT INTO devices (id,site_id,type,display_name,description,order_index,created_at,updated_at) VALUES (?,?,'other',?,?,?,?,1)",
    );
    for (let index = 0; index < 260; index++)
      insert.run(
        randomUUID(),
        seeded.siteId,
        'Extra ' + index,
        index === 0 ? 'x'.repeat(60000) : '',
        100 + index,
        1,
      );
    old.close();
    const db = openDatabase({ dataDir });
    cleanups.push(() => db.close());
    const document = readDocument(db, seeded.siteId);
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    expect(document.elements.length).toBeLessThanOrEqual(256);
    const legacyTables = document.legacy!.tables as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(Object.keys(legacyTables.devices!)).toHaveLength(262);
    const long = Object.values(legacyTables.devices!).find(
      (row) => row.display_name === 'Extra 0',
    )!.description as { encoding: string; chunks: Record<string, string> };
    expect(long.encoding).toBe('portfolio-text-chunks-v1');
    expect(Object.values(long.chunks).join('')).toBe('x'.repeat(60000));
    expect(document.legacy!.migrationWarnings).not.toEqual([]);
  });

  it('includes canonical boards and ledgers in private SQLite backup and restore', async () => {
    const { dataDir, db: old, seeded } = prior();
    old.close();
    const db = openDatabase({ dataDir });
    const document = readDocument(db, seeded.siteId);
    const snapshot = join(directory(), 'snapshot.sqlite');
    await backupDatabase(db, snapshot);
    db.close();
    const target = join(directory(), 'restored');
    await restoreDatabase(snapshot, target);
    const restored = openDatabase({ dataDir: target });
    cleanups.push(() => restored.close());
    expect(readDocument(restored, seeded.siteId)).toEqual(document);
    expect(
      restored.prepare('SELECT board_id FROM board_legacy_sites').get(),
    ).toEqual({ board_id: seeded.siteId });
  });
});
