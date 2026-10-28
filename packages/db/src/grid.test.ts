import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { seedDemo } from './demo.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
it('upgrades M2 in place without losing typed hardware, memberships, accounts or sessions', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-m3-upgrade-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const migrationsDir = join(dataDir, 'migrations');
  mkdirSync(migrationsDir);
  for (const file of [
    '001_foundation.sql',
    '002_auth_organization.sql',
    '003_network_equipment.sql',
  ])
    copyFileSync(`packages/db/migrations/${file}`, join(migrationsDir, file));
  const old = openDatabase({ dataDir, migrationsDir });
  seedDemo(
    old,
    {
      ...JSON.parse(readFileSync('examples/sample-site.json', 'utf8')),
      connections: [],
    },
    'test',
  );
  old.exec(
    "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('u','preserved','synthetic-hash',1,1);INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES('hash','u','csrf',9999999999999,1)",
  );
  const before = old.prepare('SELECT * FROM ports ORDER BY id').all();
  const tags = old
    .prepare('SELECT * FROM port_tagged_vlans ORDER BY port_id,vlan_ref')
    .all();
  old.close();
  copyFileSync(
    'packages/db/migrations/004_configure_grid.sql',
    join(migrationsDir, '004_configure_grid.sql'),
  );
  const db = openDatabase({ dataDir, migrationsDir });
  cleanup.push(() => db.close());
  expect(db.prepare('SELECT * FROM ports ORDER BY id').all()).toEqual(before);
  expect(
    db
      .prepare('SELECT * FROM port_tagged_vlans ORDER BY port_id,vlan_ref')
      .all(),
  ).toEqual(tags);
  expect(db.prepare('SELECT username FROM users').get()).toEqual({
    username: 'preserved',
  });
  expect(db.prepare('SELECT user_id,csrf_token FROM sessions').get()).toEqual({
    user_id: 'u',
    csrf_token: 'csrf',
  });
  expect(db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({
    n: 4,
  });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('SELECT count(*) n FROM connections').get()).toEqual({
    n: 0,
  });
  expect(
    db.prepare('SELECT count(*) n FROM port_custom_field_defs').get(),
  ).toEqual({ n: 0 });
});
