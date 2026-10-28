import {
  readFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { seedDemo } from './demo.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function folder() {
  const p = mkdtempSync(join(tmpdir(), 'portfolio-upgrade-'));
  cleanup.push(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
function fresh() {
  const db = openDatabase({ dataDir: folder() });
  cleanup.push(() => db.close());
  return db;
}
describe('M2 migration and database invariants', () => {
  it('upgrades M1 preserving admin, session, organization, notes and versions', () => {
    const dataDir = folder(),
      migrationsDir = join(dataDir, 'migrations');
    mkdirSync(migrationsDir);
    for (const name of ['001_foundation.sql', '002_auth_organization.sql'])
      copyFileSync(`packages/db/migrations/${name}`, join(migrationsDir, name));
    const old = openDatabase({ dataDir, migrationsDir });
    old.exec(
      "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES ('u','preserved-admin','synthetic-hash',1,1); INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES ('hash','u','csrf',9999999999999,1); INSERT INTO workspaces(id,name,row_version,created_at,updated_at) VALUES ('w','Preserved',3,1,1); INSERT INTO sites(id,workspace_id,name,notes,row_version,created_at,updated_at) VALUES ('s','w','Retained','Synthetic note',4,1,1)",
    );
    old.close();
    copyFileSync(
      'packages/db/migrations/003_network_equipment.sql',
      join(migrationsDir, '003_network_equipment.sql'),
    );
    const db = openDatabase({ dataDir, migrationsDir });
    cleanup.push(() => db.close());
    expect(
      db.prepare('SELECT username,password_hash FROM users').get(),
    ).toEqual({ username: 'preserved-admin', password_hash: 'synthetic-hash' });
    expect(db.prepare('SELECT user_id,csrf_token FROM sessions').get()).toEqual(
      { user_id: 'u', csrf_token: 'csrf' },
    );
    expect(db.prepare('SELECT name,row_version FROM workspaces').get()).toEqual(
      { name: 'Preserved', row_version: 3 },
    );
    expect(db.prepare('SELECT notes,row_version FROM sites').get()).toEqual({
      notes: 'Synthetic note',
      row_version: 4,
    });
    expect(
      db.prepare('SELECT count(*) n FROM schema_migrations').get(),
    ).toEqual({ n: 3 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('enforces cross-site rack/device/native/tagged ownership even through direct SQL', () => {
    const db = fresh();
    const seed = seedDemo(
      db,
      JSON.parse(readFileSync('examples/sample-site.json', 'utf8')),
      'test',
    );
    const site = randomUUID(),
      rack = randomUUID();
    db.prepare(
      'INSERT INTO sites(id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run(site, seed.workspaceId, 'Other', 1, 1);
    db.prepare(
      'INSERT INTO racks(id,site_id,name,order_index,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run(rack, site, 'Other rack', 0, 1, 1);
    const device = db
      .prepare("SELECT id FROM devices WHERE type='router'")
      .get() as { id: string };
    const port = db
      .prepare('SELECT id FROM ports WHERE device_id=? AND name=?')
      .get(device.id, 'Port 5') as { id: string };
    const otherVlan = randomUUID();
    db.prepare(
      'INSERT INTO vlans(id,site_id,vlan_id,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run(otherVlan, site, 20, 1, 1);
    expect(() =>
      db
        .prepare('UPDATE devices SET rack_id=? WHERE id=?')
        .run(rack, device.id),
    ).toThrow();
    expect(() =>
      db
        .prepare('UPDATE ports SET native_vlan_ref=? WHERE id=?')
        .run(otherVlan, port.id),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          'INSERT INTO port_tagged_vlans(port_id,site_id,vlan_ref) VALUES (?,?,?)',
        )
        .run(port.id, seed.siteId, otherVlan),
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE ports SET site_id=? WHERE id=?').run(site, port.id),
    ).toThrow();
    expect(() =>
      db.prepare('DELETE FROM sites WHERE id=?').run(seed.siteId),
    ).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('rejects native/tagged overlap in both update directions and invalid port modes', () => {
    const db = fresh();
    const seed = seedDemo(
      db,
      JSON.parse(readFileSync('examples/sample-site.json', 'utf8')),
      'test',
    );
    const port = db
      .prepare(
        "SELECT p.id,p.native_vlan_ref FROM ports p JOIN devices d ON d.id=p.device_id WHERE d.type='router' AND p.name='Port 5'",
      )
      .get() as { id: string; native_vlan_ref: string };
    const tagged = db
      .prepare('SELECT vlan_ref FROM port_tagged_vlans WHERE port_id=? LIMIT 1')
      .get(port.id) as { vlan_ref: string };
    expect(() =>
      db
        .prepare(
          'INSERT INTO port_tagged_vlans(port_id,site_id,vlan_ref) VALUES (?,?,?)',
        )
        .run(port.id, seed.siteId, port.native_vlan_ref),
    ).toThrow();
    expect(() =>
      db
        .prepare('UPDATE ports SET native_vlan_ref=? WHERE id=?')
        .run(tagged.vlan_ref, port.id),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          'UPDATE port_tagged_vlans SET vlan_ref=? WHERE port_id=? AND vlan_ref=?',
        )
        .run(port.native_vlan_ref, port.id, tagged.vlan_ref),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE ports SET mode='access' WHERE id=?").run(port.id),
    ).toThrow();
    db.prepare("UPDATE ports SET mode='routed' WHERE id=?").run(port.id);
    expect(
      db
        .prepare('SELECT mode,native_vlan_ref FROM ports WHERE id=?')
        .get(port.id),
    ).toEqual({ mode: 'routed', native_vlan_ref: port.native_vlan_ref });
    expect(() =>
      db.prepare('UPDATE vlans SET vlan_id=0 WHERE site_id=?').run(seed.siteId),
    ).toThrow();
  });
  it('guards a connected device, then deletes only its own ports/memberships after disconnection', () => {
    const db = fresh();
    seedDemo(
      db,
      JSON.parse(readFileSync('examples/sample-site.json', 'utf8')),
      'test',
    );
    expect(() => db.exec("DELETE FROM devices WHERE type='router'")).toThrow();
    expect(db.prepare('SELECT count(*) n FROM ports').get()).toEqual({ n: 19 });
    db.exec('DELETE FROM connections');
    db.exec("DELETE FROM devices WHERE type='router'");
    expect(db.prepare('SELECT count(*) n FROM ports').get()).toEqual({ n: 8 });
    expect(db.prepare('SELECT count(*) n FROM vlans').get()).toEqual({ n: 3 });
    expect(
      db.prepare('SELECT count(*) n FROM port_tagged_vlans').get(),
    ).toEqual({ n: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
