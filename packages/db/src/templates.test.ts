import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { seedDemo } from './demo.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});
it('adds reusable templates through005 while preserving all M4 records, memberships, accounts and sessions', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-template-upgrade-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const migrationsDir = join(dataDir, 'migrations');
  mkdirSync(migrationsDir);
  for (const name of [
    '001_foundation.sql',
    '002_auth_organization.sql',
    '003_network_equipment.sql',
    '004_configure_grid.sql',
  ])
    copyFileSync('packages/db/migrations/' + name, join(migrationsDir, name));
  const old = openDatabase({ dataDir, migrationsDir });
  seedDemo(
    old,
    JSON.parse(readFileSync('examples/sample-site.json', 'utf8')),
    'test',
  );
  const site = old.prepare('SELECT id FROM sites').get() as { id: string };
  const port = old.prepare('SELECT id FROM ports').get() as { id: string };
  old.exec(
    "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('u','preserved','synthetic-hash',1,1); INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES('session','u','csrf',9999999999999,1)",
  );
  old
    .prepare(
      "INSERT INTO port_custom_field_defs(id,site_id,key,title,value_type,created_at,updated_at) VALUES('field',?,'poe','PoE','boolean',1,1)",
    )
    .run(site.id);
  old
    .prepare(
      "INSERT INTO port_custom_values(port_id,field_def_id,site_id,value_json) VALUES(?,'field',?,'false')",
    )
    .run(port.id, site.id);
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
    'connections',
    'port_custom_field_defs',
    'port_custom_values',
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
  copyFileSync(
    'packages/db/migrations/005_device_templates.sql',
    join(migrationsDir, '005_device_templates.sql'),
  );
  const upgraded = openDatabase({ dataDir, migrationsDir });
  expect(
    Object.fromEntries(
      tables.map((table) => [
        table,
        upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  ).toEqual(before);
  expect(
    upgraded
      .prepare('SELECT * FROM schema_migrations ORDER BY name')
      .all()
      .slice(0, 4),
  ).toEqual(history);
  expect(
    upgraded.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
  ).toEqual({ count: 5 });
  const id = randomUUID();
  const groups = JSON.stringify([
    {
      count: 24,
      kind: 'rj45',
      speed: '1G',
      mode: 'other',
      face: 'front',
      namePrefix: 'Port ',
    },
  ]);
  upgraded
    .prepare(
      'INSERT INTO device_templates(id,name,type,description,groups_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      id,
      'Reusable 24-port switch',
      'switch',
      'Retained layout',
      groups,
      1,
      1,
    );
  expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  upgraded.close();
  const reopened = openDatabase({ dataDir, migrationsDir });
  cleanup.push(() => reopened.close());
  expect(
    reopened
      .prepare(
        'SELECT groups_json,row_version FROM device_templates WHERE id=?',
      )
      .get(id),
  ).toEqual({ groups_json: groups, row_version: 1 });
  expect(reopened.prepare('SELECT count(*) AS count FROM ports').get()).toEqual(
    { count: 19 },
  );
  expect(
    reopened.prepare('SELECT count(*) AS count FROM connections').get(),
  ).toEqual({ count: 1 });
});
