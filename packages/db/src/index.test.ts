import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, migrateDatabase, openDatabase } from './index.js';

const temporary: string[] = [];
const connections: DatabaseSync[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'portfolio-db-'));
  temporary.push(path);
  return path;
}
function database(dataDir = folder(), migrationsDir?: string): DatabaseSync {
  const db = openDatabase({ dataDir, migrationsDir });
  connections.push(db);
  return db;
}
function migrationFixture(): string {
  const path = join(folder(), 'migrations');
  mkdirSync(path);
  copyFileSync(
    resolve('packages/db/migrations/001_foundation.sql'),
    join(path, '001_foundation.sql'),
  );
  return path;
}
afterEach(() => {
  for (const db of connections.splice(0)) {
    try {
      db.close();
    } catch {
      /* Already explicitly closed by durability tests. */
    }
  }
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('SQLite foundation', () => {
  it('applies migrations once and preserves values when reopened', () => {
    const dataDir = folder();
    const db = database(dataDir);
    db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)').run(
      'persistence-probe',
      'saved',
    );
    db.close();
    const reopened = database(dataDir);
    expect(
      reopened
        .prepare('SELECT value FROM app_metadata WHERE key = ?')
        .get('persistence-probe'),
    ).toEqual({ value: 'saved' });
    expect(
      reopened.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 7 });
    expect(statSync(join(dataDir, 'app.sqlite')).mode & 0o777).toBe(0o600);
  });

  it('upgrades an existing fixture without resetting stored records', () => {
    const dataDir = folder();
    const migrationsDir = migrationFixture();
    const old = database(dataDir, migrationsDir);
    old
      .prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
      .run('before-upgrade', 'retained');
    old.close();
    writeFileSync(
      join(migrationsDir, '002_upgrade.sql'),
      'CREATE TABLE upgrade_probe (id TEXT PRIMARY KEY) STRICT;',
    );
    const upgraded = database(dataDir, migrationsDir);
    expect(
      upgraded
        .prepare('SELECT value FROM app_metadata WHERE key = ?')
        .get('before-upgrade'),
    ).toEqual({ value: 'retained' });
    expect(
      upgraded.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 2 });
    expect(
      upgraded.prepare('SELECT count(*) AS count FROM upgrade_probe').get(),
    ).toEqual({ count: 0 });
  });

  it('upgrades the M0 foundation to auth and organization without resetting data', () => {
    const dataDir = folder();
    const migrationsDir = migrationFixture();
    const old = database(dataDir, migrationsDir);
    old
      .prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
      .run('m0-data', 'retained');
    old.close();
    copyFileSync(
      resolve('packages/db/migrations/002_auth_organization.sql'),
      join(migrationsDir, '002_auth_organization.sql'),
    );
    const upgraded = database(dataDir, migrationsDir);
    expect(
      upgraded
        .prepare('SELECT value FROM app_metadata WHERE key = ?')
        .get('m0-data'),
    ).toEqual({ value: 'retained' });
    expect(
      upgraded.prepare('SELECT count(*) AS count FROM users').get(),
    ).toEqual({ count: 0 });
    expect(
      upgraded.prepare('SELECT count(*) AS count FROM sites').get(),
    ).toEqual({ count: 0 });
    expect(() =>
      upgraded
        .prepare(
          'INSERT INTO sites (id, workspace_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
        )
        .run('s', 'missing', 'Invalid', 1, 1),
    ).toThrow('FOREIGN KEY constraint failed');
  });

  it('rolls back every pending migration if one fails', () => {
    const migrationsDir = migrationFixture();
    const db = database(folder(), migrationsDir);
    writeFileSync(
      join(migrationsDir, '002_pending.sql'),
      'CREATE TABLE pending_probe (id TEXT PRIMARY KEY) STRICT;',
    );
    writeFileSync(
      join(migrationsDir, '003_broken.sql'),
      'INSERT INTO nonexistent_table VALUES (1);',
    );
    expect(() => migrateDatabase(db, migrationsDir)).toThrow();
    expect(
      db.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'pending_probe'")
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT value FROM app_metadata WHERE key = 'application'")
        .get(),
    ).toEqual({ value: 'PortFolio' });
  });

  it('rejects edited or missing applied history', () => {
    const migrationsDir = migrationFixture();
    const db = database(folder(), migrationsDir);
    writeFileSync(join(migrationsDir, '001_foundation.sql'), 'SELECT 1;');
    expect(() => migrateDatabase(db, migrationsDir)).toThrow(
      'Migration history mismatch',
    );
    rmSync(join(migrationsDir, '001_foundation.sql'));
    writeFileSync(join(migrationsDir, '002_other.sql'), 'SELECT 2;');
    expect(() => migrateDatabase(db, migrationsDir)).toThrow(
      'Migration history mismatch',
    );
  });

  it('rejects duplicate migration versions', () => {
    const migrationsDir = migrationFixture();
    const db = database();
    writeFileSync(join(migrationsDir, '001_duplicate.sql'), 'SELECT 1;');
    expect(() => migrateDatabase(db, migrationsDir)).toThrow(
      'Duplicate migration version',
    );
  });

  it('enforces foreign keys on every opened connection', () => {
    const db = database();
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    });
    db.exec(
      'CREATE TABLE parents (id TEXT PRIMARY KEY); CREATE TABLE children (parent_id TEXT REFERENCES parents(id));',
    );
    expect(() =>
      db.prepare('INSERT INTO children VALUES (?)').run('missing'),
    ).toThrow('FOREIGN KEY constraint failed');
  });

  it('backs up committed WAL values privately and refuses to overwrite a backup', async () => {
    const db = database();
    db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)').run(
      'backup-probe',
      'in-wal',
    );
    const target = join(folder(), 'snapshot.sqlite');
    await backupDatabase(db, target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const snapshot = new DatabaseSync(target, { readOnly: true });
    connections.push(snapshot);
    expect(snapshot.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(
      snapshot
        .prepare('SELECT value FROM app_metadata WHERE key = ?')
        .get('backup-probe'),
    ).toEqual({ value: 'in-wal' });
    await expect(backupDatabase(db, target)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(
      snapshot
        .prepare('SELECT value FROM app_metadata WHERE key = ?')
        .get('backup-probe'),
    ).toEqual({ value: 'in-wal' });
  });
});
