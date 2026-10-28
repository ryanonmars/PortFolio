import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { seedDemo } from './demo.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'portfolio-demo-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  const db = openDatabase({ dataDir: path });
  cleanup.push(() => db.close());
  return db;
}
const blueprint = () =>
  JSON.parse(readFileSync('examples/sample-site.json', 'utf8'));
describe('development fixture seed', () => {
  it('creates real synthetic VLAN, subnet and typed port records without credentials', () => {
    const db = fixture();
    const result = seedDemo(db, blueprint(), 'test');
    expect(result).toMatchObject({
      devices: 2,
      ports: 19,
      vlans: 3,
      subnets: 3,
      connections: 1,
    });
    expect(db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          'SELECT a.name AS source,b.name AS destination,c.cable_type AS cableType FROM connections c JOIN ports a ON a.id=c.endpoint_a_port_id JOIN ports b ON b.id=c.endpoint_b_port_id',
        )
        .get(),
    ).toEqual({ source: 'Port 5', destination: 'Port 1', cableType: 'Cat6' });
    expect(
      db
        .prepare(
          "SELECT mode,native_vlan_ref,pvid FROM ports WHERE name='Port 4' AND device_id=(SELECT id FROM devices WHERE type='router')",
        )
        .get(),
    ).toEqual({ mode: 'routed', native_vlan_ref: null, pvid: null });
    const router = db
      .prepare(
        "SELECT id FROM ports WHERE name='Port 5' AND device_id=(SELECT id FROM devices WHERE type='router')",
      )
      .get() as { id: string };
    expect(
      db
        .prepare(
          'SELECT v.vlan_id FROM port_tagged_vlans t JOIN vlans v ON v.id=t.vlan_ref WHERE t.port_id=? ORDER BY v.vlan_id',
        )
        .all(router.id),
    ).toEqual([{ vlan_id: 20 }, { vlan_id: 30 }]);
  });
  it('refuses production, unknown environment, and an existing inventory without changing it', () => {
    const db = fixture();
    expect(() => seedDemo(db, blueprint(), 'production')).toThrow(
      'development/test',
    );
    expect(() => seedDemo(db, blueprint(), '')).toThrow('development/test');
    const first = seedDemo(db, blueprint(), 'development');
    expect(() => seedDemo(db, blueprint(), 'test')).toThrow(
      'empty workspace inventory',
    );
    expect(db.prepare('SELECT id FROM sites').get()).toEqual({
      id: first.siteId,
    });
    expect(db.prepare('SELECT count(*) n FROM ports').get()).toEqual({ n: 19 });
  });
  it('rejects invalid references and configurations before writing any records', () => {
    const db = fixture();
    const bad = blueprint();
    bad.devices[1].ports[0].native_vlan = 4094;
    expect(() => seedDemo(db, bad, 'test')).toThrow('undefined VLAN');
    const overlap = blueprint();
    overlap.devices[1].ports[0].tagged_vlans = [1, 20];
    expect(() => seedDemo(db, overlap, 'test')).toThrow();
    const duplicate = blueprint();
    duplicate.connections.push(duplicate.connections[0]);
    expect(() => seedDemo(db, duplicate, 'test')).toThrow(
      'Duplicate fixture connection endpoint',
    );
    expect(db.prepare('SELECT count(*) n FROM workspaces').get()).toEqual({
      n: 0,
    });
  });
  it('rolls back the entire graph if a database write fails mid-seed', () => {
    const db = fixture();
    db.exec(
      "CREATE TRIGGER seed_failure BEFORE INSERT ON ports BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    expect(() => seedDemo(db, blueprint(), 'test')).toThrow(
      'synthetic failure',
    );
    for (const table of [
      'workspaces',
      'sites',
      'vlans',
      'subnets',
      'devices',
      'ports',
    ])
      expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({
        n: 0,
      });
  });
});
