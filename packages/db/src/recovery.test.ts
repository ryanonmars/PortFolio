import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, openDatabase, restoreDatabase } from './index.js';

const directories: string[] = [];
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'portfolio-recovery-test-'));
  directories.push(value);
  return value;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('private SQLite recovery', () => {
  it('restores committed WAL data privately without changing the original snapshot or existing destination', async () => {
    const source = directory();
    const destination = join(directory(), 'recovered');
    const db = openDatabase({ dataDir: source });
    const snapshot = join(directory(), 'snapshot.sqlite');
    try {
      db.prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)').run(
        'retained',
        'committed',
      );
      await backupDatabase(db, snapshot);
    } finally {
      db.close();
    }
    const original = readFileSync(snapshot);
    expect(existsSync(snapshot + '-wal')).toBe(false);
    await restoreDatabase(snapshot, destination);
    const restored = openDatabase({ dataDir: destination });
    expect(
      restored
        .prepare("SELECT value FROM app_metadata WHERE key='retained'")
        .get(),
    ).toEqual({ value: 'committed' });
    expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    restored.close();
    expect(statSync(join(destination, 'app.sqlite')).mode & 0o777).toBe(0o600);
    expect(readFileSync(snapshot)).toEqual(original);
    expect(existsSync(snapshot + '-wal')).toBe(false);
    expect(existsSync(snapshot + '-shm')).toBe(false);
    await expect(restoreDatabase(snapshot, destination)).rejects.toThrow(
      'new data directory',
    );
    expect(readFileSync(snapshot)).toEqual(original);
    const concurrent = join(directory(), 'concurrent');
    const attempts = await Promise.allSettled([
      restoreDatabase(snapshot, concurrent),
      restoreDatabase(snapshot, concurrent),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    const winner = openDatabase({ dataDir: concurrent });
    expect(
      winner
        .prepare("SELECT value FROM app_metadata WHERE key='retained'")
        .get(),
    ).toEqual({ value: 'committed' });
    winner.close();
  });
  it('forward-migrates an old valid snapshot in staging while preserving its history and source', async () => {
    const migrations = directory();
    copyFileSync(
      resolve('packages/db/migrations/001_foundation.sql'),
      join(migrations, '001_foundation.sql'),
    );
    const source = directory();
    const old = openDatabase({ dataDir: source, migrationsDir: migrations });
    const snapshot = join(directory(), 'm0.sqlite');
    await backupDatabase(old, snapshot);
    old.close();
    const original = readFileSync(snapshot);
    const target = join(directory(), 'upgraded');
    await restoreDatabase(snapshot, target);
    const restored = openDatabase({ dataDir: target });
    expect(
      restored.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 7 });
    expect(
      restored.prepare('SELECT count(*) AS count FROM connections').get(),
    ).toEqual({ count: 0 });
    restored.close();
    expect(readFileSync(snapshot)).toEqual(original);
  });
  it('refuses malformed snapshots, invalid references, incompatible migration history and orphaned journals', async () => {
    const folder = directory();
    const snapshot = join(folder, 'bad.sqlite');
    const target = join(folder, 'target');
    writeFileSync(snapshot, 'not sqlite');
    await expect(restoreDatabase(snapshot, target)).rejects.toThrow();
    expect(existsSync(join(target, 'app.sqlite'))).toBe(false);
    rmSync(snapshot);
    const db = openDatabase({ dataDir: directory() });
    db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO racks(id,site_id,name,order_index,created_at,updated_at) VALUES ('bad','missing','Bad',0,0,0)",
    );
    await backupDatabase(db, snapshot);
    await expect(restoreDatabase(snapshot, target)).rejects.toThrow(
      'invalid references',
    );
    db.exec(
      "DELETE FROM racks; UPDATE schema_migrations SET checksum='untrusted' WHERE name='001_foundation.sql'",
    );
    rmSync(snapshot);
    await backupDatabase(db, snapshot);
    db.close();
    await expect(restoreDatabase(snapshot, target)).rejects.toThrow(
      'Migration history mismatch',
    );
    expect(existsSync(join(target, 'app.sqlite'))).toBe(false);
    const journalDir = directory();
    writeFileSync(join(journalDir, 'app.sqlite-wal'), 'retain');
    await expect(restoreDatabase(snapshot, journalDir)).rejects.toThrow(
      'new data directory',
    );
    expect(readFileSync(join(journalDir, 'app.sqlite-wal'), 'utf8')).toBe(
      'retain',
    );
    writeFileSync(snapshot + '-wal', 'pending');
    await expect(restoreDatabase(snapshot, target)).rejects.toThrow(
      'completed SQLite backup snapshot',
    );
  });
  it('refuses an unrelated SQLite database and requires explicit CLI destination before opening anything', async () => {
    const snapshot = join(directory(), 'unrelated.sqlite');
    const db = new DatabaseSync(snapshot);
    db.exec('CREATE TABLE unrelated(value TEXT)');
    db.close();
    const target = join(directory(), 'target');
    await expect(restoreDatabase(snapshot, target)).rejects.toThrow();
    expect(existsSync(join(target, 'app.sqlite'))).toBe(false);
    const env = { ...process.env };
    delete env.DATA_DIR;
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/database.ts', 'restore', snapshot],
      { env, encoding: 'utf8' },
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('DATA_DIR=/new/empty/directory');
  });
});
