import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  lstatSync,
  mkdtempSync,
  linkSync,
  copyFileSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { migrateLegacyBoards } from './board-migration.js';

export interface DatabaseOptions {
  dataDir: string;
  migrationsDir?: string;
}

interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

/** Only trusted, bundled SQL files are accepted as migrations. */
export function migrateDatabase(db: DatabaseSync, migrationsDir: string): void {
  const migrations: Migration[] = readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(resolve(migrationsDir, name), 'utf8');
      return {
        name,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    });
  if (migrations.length === 0) throw new Error('No database migrations found');
  const versions = new Set<string>();
  for (const migration of migrations) {
    const version = migration.name.split('_')[0]!;
    if (versions.has(version)) throw new Error('Duplicate migration version');
    versions.add(version);
  }

  // Serialize startup across processes and roll back the entire pending batch.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT`);
    const applied = db
      .prepare('SELECT name, checksum FROM schema_migrations ORDER BY name')
      .all() as { name: string; checksum: string }[];
    // Applied history must be an exact prefix: no edits, deletions or inserts.
    for (const [index, previous] of applied.entries()) {
      const migration = migrations[index];
      if (
        !migration ||
        migration.name !== previous.name ||
        migration.checksum !== previous.checksum
      ) {
        throw new Error(`Migration history mismatch: ${previous.name}`);
      }
    }
    const record = db.prepare(
      'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
    );
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      record.run(migration.name, migration.checksum);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Caller owns the connection and must close it during shutdown. */
export function openDatabase({
  dataDir,
  migrationsDir = resolve('packages/db/migrations'),
}: DatabaseOptions): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = resolve(dataDir, 'app.sqlite');
  // Reserve new database files privately before SQLite can write sensitive data.
  try {
    closeSync(openSync(databasePath, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  chmodSync(databasePath, 0o600);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    migrateDatabase(db, migrationsDir);
    migrateLegacyBoards(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** SQLite online backup includes committed WAL data. Existing files are refused. */
export async function backupDatabase(
  db: DatabaseSync,
  destination: string,
): Promise<void> {
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  closeSync(openSync(target, 'wx', 0o600));
  try {
    await backup(db, target);
    chmodSync(target, 0o600);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
}

/** Restore a private snapshot into a new data directory; never overwrite a live DB. */
export async function restoreDatabase(
  source: string,
  dataDir: string,
  migrationsDir = resolve('packages/db/migrations'),
): Promise<void> {
  const snapshot = resolve(source);
  const destination = resolve(dataDir, 'app.sqlite');
  const refuseExisting = () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        lstatSync(destination + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error(
        'Recovery requires a new data directory without an existing database or journal',
      );
    }
  };
  refuseExisting();
  if (!lstatSync(snapshot).isFile())
    throw new Error('Choose a regular SQLite snapshot file');
  for (const suffix of ['-wal', '-journal']) {
    try {
      if (lstatSync(snapshot + suffix).size > 0)
        throw new Error(
          'Choose a completed SQLite backup snapshot, not a live database with a pending journal',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const stage = mkdtempSync(join(tmpdir(), 'portfolio-restore-'));
  let original: DatabaseSync | undefined;
  let staged: DatabaseSync | undefined;
  let publishDirectory: string | undefined;
  try {
    // A completed backup may retain WAL mode in its header. Inspect a private copy so
    // SQLite can create its empty sidecars without requiring writes to the backup mount.
    const privateInput = join(stage, 'input.sqlite');
    copyFileSync(snapshot, privateInput, fsConstants.COPYFILE_EXCL);
    chmodSync(privateInput, 0o600);
    original = new DatabaseSync(privateInput, { readOnly: true });
    const integrity = original.prepare('PRAGMA integrity_check').all() as {
      integrity_check: string;
    }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error('Snapshot integrity check failed');
    if (original.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Snapshot has invalid references');
    if (!original.prepare('SELECT name FROM schema_migrations LIMIT 1').get())
      throw new Error('Snapshot is not a versioned PortFolio database');
    await backupDatabase(original, join(stage, 'app.sqlite'));
    original.close();
    original = undefined;
    staged = openDatabase({ dataDir: stage, migrationsDir });
    for (const table of [
      'users',
      'sessions',
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
    ]) {
      staged.prepare(`SELECT count(*) FROM ${table}`).get();
    }
    if (staged.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Restored snapshot has invalid references');
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
    publishDirectory = mkdtempSync(
      join(resolve(dataDir), '.portfolio-restore-'),
    );
    const complete = join(publishDirectory, 'complete.sqlite');
    await backupDatabase(staged, complete);
    refuseExisting();
    // Exclusive hard-link publication exposes only a complete snapshot and cannot overwrite a concurrent writer.
    linkSync(complete, destination);
  } finally {
    original?.close();
    staged?.close();
    if (publishDirectory)
      rmSync(publishDirectory, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}
