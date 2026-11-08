import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { openDatabase, backupDatabase } from './index.js';
import { backupApplication, restoreApplication } from './application-backup.js';
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'portfolio-files-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = folder();
  const db = openDatabase({ dataDir: dir });
  dbs.push(db);
  const id = randomUUID();
  const object = join(dir, 'attachments', 'objects', id);
  mkdirSync(object, { recursive: true });
  writeFileSync(join(object, 'original'), 'retained bytes');
  db.prepare(
    `INSERT INTO board_attachments (id,board_id,owner_type,element_id,entry_id,original_filename,display_name,description,mime_type,size_bytes,stored_bytes,original_sha256,created_at,updated_at,row_version,orphaned_at,deleted_at) VALUES (?, 'deleted-board','device','device','', 'a.txt','a','', 'text/plain',14,14,?,1,1,1,1,1)`,
  ).run(id, createHash('sha256').update('retained bytes').digest('hex'));
  return { dir, db, id, object };
}
it('round trips retained attachments and survives reopening', async () => {
  const { dir, db, id } = fixture();
  const target = join(folder(), 'backup.sqlite');
  await backupApplication(db, dir, target);
  expect(
    db.prepare('SELECT count(*) AS n FROM attachment_backup_leases').get(),
  ).toEqual({ n: 0 });
  const restored = folder();
  await restoreApplication(target, restored);
  expect(
    readFileSync(
      join(restored, 'attachments', 'objects', id, 'original'),
      'utf8',
    ),
  ).toBe('retained bytes');
  const reopened = openDatabase({ dataDir: restored });
  dbs.push(reopened);
  expect(reopened.prepare('SELECT id FROM board_attachments').get()).toEqual({
    id,
  });
});
it('fails missing originals without publishing or retaining leases', async () => {
  const { dir, db, object } = fixture();
  rmSync(join(object, 'original'));
  const target = join(folder(), 'backup.sqlite');
  await expect(backupApplication(db, dir, target)).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  expect(existsSync(target + '.attachments')).toBe(false);
  expect(
    db.prepare('SELECT count(*) AS n FROM attachment_backup_leases').get(),
  ).toEqual({ n: 0 });
});
it('rejects missing sidecars and tampered files without publication', async () => {
  const { dir, db, id } = fixture();
  const target = join(folder(), 'backup.sqlite');
  await backupApplication(db, dir, target);
  const original = join(target + '.attachments', 'objects', id, 'original');
  writeFileSync(original, 'tampered bytes');
  const dest = folder();
  await expect(restoreApplication(target, dest)).rejects.toThrow();
  expect(existsSync(join(dest, 'app.sqlite'))).toBe(false);
  expect(existsSync(join(dest, 'attachments'))).toBe(false);
  rmSync(target + '.attachments', { recursive: true });
  await expect(restoreApplication(target, dest)).rejects.toThrow();
});
it('restores legacy database-only backups with no attachments', async () => {
  const dir = folder();
  const db = openDatabase({ dataDir: dir });
  dbs.push(db);
  const target = join(folder(), 'legacy.sqlite');
  await backupDatabase(db, target);
  const dest = folder();
  await restoreApplication(target, dest);
  expect(existsSync(join(dest, 'app.sqlite'))).toBe(true);
});
it('refuses existing targets and symlinked source files', async () => {
  const { dir, db, object } = fixture();
  const target = join(folder(), 'backup.sqlite');
  mkdirSync(target + '.attachments');
  await expect(backupApplication(db, dir, target)).rejects.toThrow();
  rmSync(target + '.attachments', { recursive: true });
  rmSync(join(object, 'original'));
  const outside = join(folder(), 'bytes');
  writeFileSync(outside, 'retained bytes');
  symlinkSync(outside, join(object, 'original'));
  await expect(backupApplication(db, dir, target)).rejects.toThrow();
});

it('preserves optional derivatives and does not include unreferenced objects', async () => {
  const { dir, db, id, object } = fixture();
  writeFileSync(join(object, 'thumbnail.webp'), 'thumbnail');
  const unused = join(dir, 'attachments', 'objects', randomUUID());
  mkdirSync(unused);
  writeFileSync(join(unused, 'original'), 'unindexed');
  const target = join(folder(), 'backup.sqlite');
  await backupApplication(db, dir, target);
  const manifest = JSON.parse(
    readFileSync(join(target + '.attachments', 'manifest.json'), 'utf8'),
  );
  expect(manifest.files).toHaveLength(2);
  const dest = folder();
  await restoreApplication(target, dest);
  expect(
    readFileSync(
      join(dest, 'attachments', 'objects', id, 'thumbnail.webp'),
      'utf8',
    ),
  ).toBe('thumbnail');
});
it('rejects unsafe metadata identities before copying outside the object root', async () => {
  const { dir, db } = fixture();
  db.exec("UPDATE board_attachments SET id='../escape'");
  const target = join(folder(), 'backup.sqlite');
  await expect(backupApplication(db, dir, target)).rejects.toThrow('identity');
  expect(existsSync(target)).toBe(false);
});
it('rejects manifest traversal, missing entries, duplicate files and symlinks', async () => {
  const { dir, db, id } = fixture();
  const target = join(folder(), 'backup.sqlite');
  await backupApplication(db, dir, target);
  const manifestPath = join(target + '.attachments', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const files of [
    [{ ...manifest.files[0], name: '../../escape' }],
    [],
    [manifest.files[0], manifest.files[0]],
  ]) {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }));
    const dest = folder();
    await expect(restoreApplication(target, dest)).rejects.toThrow();
    expect(existsSync(join(dest, 'app.sqlite'))).toBe(false);
    expect(existsSync(join(dest, 'attachments'))).toBe(false);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const original = join(target + '.attachments', 'objects', id, 'original');
  rmSync(original);
  const outside = join(folder(), 'outside');
  writeFileSync(outside, 'retained bytes');
  symlinkSync(outside, original);
  await expect(restoreApplication(target, folder())).rejects.toThrow(
    'Symlinks',
  );
});
it('refuses existing attachment trees or database journals without changing them', async () => {
  const { dir, db } = fixture();
  const target = join(folder(), 'backup.sqlite');
  await backupApplication(db, dir, target);
  const attachmentsDest = folder();
  mkdirSync(join(attachmentsDest, 'attachments'));
  writeFileSync(join(attachmentsDest, 'attachments', 'keep'), 'keep');
  await expect(restoreApplication(target, attachmentsDest)).rejects.toThrow(
    'already exists',
  );
  expect(
    readFileSync(join(attachmentsDest, 'attachments', 'keep'), 'utf8'),
  ).toBe('keep');
  const journalDest = folder();
  writeFileSync(join(journalDest, 'app.sqlite-wal'), 'keep');
  await expect(restoreApplication(target, journalDest)).rejects.toThrow(
    'already exists',
  );
  expect(readFileSync(join(journalDest, 'app.sqlite-wal'), 'utf8')).toBe(
    'keep',
  );
});
it('an expired lease aborts publication and is removed', async () => {
  const { dir, db } = fixture();
  db.exec(
    'CREATE TRIGGER expire_backup AFTER INSERT ON attachment_backup_leases BEGIN UPDATE attachment_backup_leases SET expires_at=0 WHERE id=NEW.id; END',
  );
  const target = join(folder(), 'backup.sqlite');
  await expect(backupApplication(db, dir, target)).rejects.toThrow(
    'lease expired',
  );
  expect(existsSync(target)).toBe(false);
  expect(existsSync(target + '.attachments')).toBe(false);
  expect(
    db.prepare('SELECT count(*) AS n FROM attachment_backup_leases').get(),
  ).toEqual({ n: 0 });
});
it('only one concurrent restore can publish and the winner stays complete', async () => {
  const { dir, db, id } = fixture();
  const target = join(folder(), 'backup.sqlite');
  await backupApplication(db, dir, target);
  const dest = folder();
  const attempts = await Promise.allSettled([
    restoreApplication(target, dest),
    restoreApplication(target, dest),
  ]);
  expect(
    attempts.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    readFileSync(join(dest, 'attachments', 'objects', id, 'original'), 'utf8'),
  ).toBe('retained bytes');
  expect(existsSync(join(dest, 'app.sqlite'))).toBe(true);
});

it('forward-migrates a foundation-only snapshot without changing the source', async () => {
  const migrations = folder();
  copyFileSync(
    resolve('packages/db/migrations/001_foundation.sql'),
    join(migrations, '001_foundation.sql'),
  );
  const db = openDatabase({ dataDir: folder(), migrationsDir: migrations });
  dbs.push(db);
  const target = join(folder(), 'old.sqlite');
  await backupDatabase(db, target);
  const original = readFileSync(target);
  const dest = folder();
  await restoreApplication(target, dest);
  const restored = openDatabase({ dataDir: dest });
  dbs.push(restored);
  expect(
    restored.prepare('SELECT count(*) AS n FROM board_attachments').get(),
  ).toEqual({ n: 0 });
  expect(readFileSync(target)).toEqual(original);
  expect(existsSync(target + '-wal')).toBe(false);
});
it('CLI backup/restore includes attachments and keeps source bytes unchanged', async () => {
  const { dir, id } = fixture();
  const target = join(folder(), 'cli.sqlite');
  const backup = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/database.ts', 'backup', target],
    { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' },
  );
  expect(backup.status, backup.stderr).toBe(0);
  const original = readFileSync(target);
  const manifestPath = join(target + '.attachments', 'manifest.json');
  const manifest = readFileSync(manifestPath);
  const dest = folder();
  const restore = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/database.ts', 'restore', target],
    { env: { ...process.env, DATA_DIR: dest }, encoding: 'utf8' },
  );
  expect(restore.status, restore.stderr).toBe(0);
  expect(
    readFileSync(join(dest, 'attachments', 'objects', id, 'original'), 'utf8'),
  ).toBe('retained bytes');
  expect(readFileSync(target)).toEqual(original);
  expect(readFileSync(manifestPath)).toEqual(manifest);
  expect(existsSync(target + '-wal')).toBe(false);
});
it('concurrent backups publish one complete matching snapshot and sidecar', async () => {
  const { dir, db, id } = fixture();
  const target = join(folder(), 'backup.sqlite');
  const attempts = await Promise.allSettled([
    backupApplication(db, dir, target),
    backupApplication(db, dir, target),
  ]);
  expect(
    attempts.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const dest = folder();
  await restoreApplication(target, dest);
  expect(
    readFileSync(join(dest, 'attachments', 'objects', id, 'original'), 'utf8'),
  ).toBe('retained bytes');
  expect(
    db.prepare('SELECT count(*) AS n FROM attachment_backup_leases').get(),
  ).toEqual({ n: 0 });
});
