import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  realpathSync,
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  linkSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, restoreDatabase } from './index.js';

const marker = 'attachment_backup_version';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const names = ['original', 'thumbnail.webp', 'preview.webp'] as const;
const ttl = 5 * 60_000;
interface FileRecord {
  id: string;
  name: string;
  size: number;
  sha256: string;
}
interface Manifest {
  version: 1;
  databaseSha256: string;
  files: FileRecord[];
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function refuse(path: string) {
  if (exists(path))
    throw new Error(`Recovery/backup target already exists: ${path}`);
}
/** Reject symlinks in every existing path component, including the file itself. */
function safePath(path: string, directory = false) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split('/')
    .filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (
      stat.isSymbolicLink() &&
      !(
        (current === '/var' && realpathSync(current) === '/private/var') ||
        (current === '/tmp' && realpathSync(current) === '/private/tmp')
      )
    )
      throw new Error('Symlinks are not accepted in attachment backups');
    if (current !== absolute && !stat.isDirectory() && !stat.isSymbolicLink())
      throw new Error('Invalid attachment directory');
  }
  const stat = lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw new Error('Expected a regular backup file/directory');
}
/** Copy and hash from the same no-follow descriptor; never trust filenames from JSON. */
function digest(
  path: string,
  destination?: string,
): { size: number; sha256: string } {
  safePath(path);
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    if (destination) {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      output = openSync(destination, 'wx', 0o600);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(128 * 1024);
    let size = 0;
    let count: number;
    while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0) {
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      size += count;
      if (output !== undefined) {
        let offset = 0;
        while (offset < count)
          offset += writeSync(output, bytes, offset, count - offset);
      }
    }
    if (output !== undefined) fsyncSync(output);
    return { size, sha256: hash.digest('hex') };
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}
// Flush linked directory entries before the SQLite filename becomes the completion marker.
function syncParent(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) syncDirectory(join(path, entry.name));
  }
  syncParent(path);
}
function rows(
  db: DatabaseSync,
): { id: string; size_bytes: number; original_sha256: string }[] {
  if (
    !db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='board_attachments'",
      )
      .get()
  )
    return [];
  const records = db
    .prepare(
      'SELECT id, size_bytes, original_sha256 FROM board_attachments ORDER BY id',
    )
    .all() as { id: string; size_bytes: number; original_sha256: string }[];
  for (const record of records)
    if (
      !uuid.test(record.id) ||
      !Number.isSafeInteger(record.size_bytes) ||
      record.size_bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(record.original_sha256)
    )
      throw new Error('Invalid attachment identity or size in snapshot');
  return records;
}
function privateSnapshot(source: string, destination: string) {
  safePath(source);
  for (const suffix of ['-wal', '-journal'])
    if (exists(source + suffix) && lstatSync(source + suffix).size)
      throw new Error('Choose a completed SQLite backup, not a live database');
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
}

/** Complete offline-portable application backup. Keep the SQLite file and adjacent .attachments directory together. */
export async function backupApplication(
  db: DatabaseSync,
  dataDir: string,
  destination: string,
): Promise<void> {
  const target = resolve(destination);
  const sidecar = target + '.attachments';
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  safePath(dirname(target), true);
  refuse(target);
  refuse(sidecar);
  const stage = mkdtempSync(join(dirname(target), '.portfolio-backup-'));
  const snapshot = join(stage, 'snapshot.sqlite');
  const files = join(stage, 'attachments');
  mkdirSync(files, { mode: 0o700 });
  const id = randomUUID();
  const started = Date.now();
  let publishedSidecar = false;
  let publishedDatabase = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatError: unknown;
  const leased = !!db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='attachment_backup_leases'",
    )
    .get();
  const renew = () => {
    if (Date.now() - started > 60 * 60_000)
      throw new Error('Attachment backup exceeded its maximum duration');
    if (leased) {
      const now = Date.now();
      const renewed = db
        .prepare(
          'UPDATE attachment_backup_leases SET expires_at=? WHERE id=? AND expires_at>?',
        )
        .run(now + ttl, id, now);
      if (renewed.changes !== 1)
        throw new Error('Attachment backup lease expired');
    }
    if (heartbeatError) throw heartbeatError;
  };
  try {
    if (leased) {
      db.prepare(
        'INSERT INTO attachment_backup_leases(id,expires_at) VALUES (?,?)',
      ).run(id, Date.now() + ttl);
      heartbeat = setInterval(() => {
        try {
          renew();
        } catch (error) {
          heartbeatError = error;
        }
      }, 30_000);
      heartbeat.unref();
    }
    await backupDatabase(db, snapshot);
    renew();
    const copy = new DatabaseSync(snapshot);
    let records: ReturnType<typeof rows>;
    try {
      records = rows(copy);
      copy
        .prepare('INSERT OR REPLACE INTO app_metadata(key,value) VALUES (?,?)')
        .run(marker, '1');
      if (leased) copy.exec('DELETE FROM attachment_backup_leases');
      copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      copy.close();
    }
    const manifest: Manifest = {
      version: 1,
      databaseSha256: digest(snapshot).sha256,
      files: [],
    };
    for (const record of records) {
      renew();
      const object = join(
        resolve(dataDir),
        'attachments',
        'objects',
        record.id,
      );
      safePath(object, true);
      for (const name of names) {
        const source = join(object, name);
        if (name !== 'original' && !exists(source)) continue;
        const result = digest(source, join(files, 'objects', record.id, name));
        if (
          name === 'original' &&
          (result.size !== record.size_bytes ||
            result.sha256 !== record.original_sha256)
        )
          throw new Error('Attachment original size differs from metadata');
        manifest.files.push({ id: record.id, name, ...result });
        renew();
      }
    }
    writeFileSync(join(files, 'manifest.json'), JSON.stringify(manifest), {
      flag: 'wx',
      mode: 0o600,
    });
    const manifestFd = openSync(
      join(files, 'manifest.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(manifestFd);
    } finally {
      closeSync(manifestFd);
    }
    renew();
    // Exclusive directory reservation ensures another backup cannot be replaced, even if empty.
    mkdirSync(sidecar, { mode: 0o700 });
    publishedSidecar = true;
    for (const file of manifest.files) {
      renew();
      const path = join('objects', file.id, file.name);
      mkdirSync(dirname(join(sidecar, path)), { recursive: true, mode: 0o700 });
      linkSync(join(files, path), join(sidecar, path));
    }
    linkSync(join(files, 'manifest.json'), join(sidecar, 'manifest.json'));
    syncDirectory(sidecar);
    syncParent(dirname(target));
    renew();
    linkSync(snapshot, target);
    publishedDatabase = true;
    syncParent(dirname(target));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (leased)
        db.prepare('DELETE FROM attachment_backup_leases WHERE id=?').run(id);
    } finally {
      if (publishedSidecar && !publishedDatabase)
        rmSync(sidecar, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

/** Validate and stage every retained attachment before publishing a migrated database. */
export async function restoreApplication(
  source: string,
  dataDir: string,
  migrationsDir = resolve('packages/db/migrations'),
): Promise<void> {
  const directory = resolve(dataDir);
  const target = join(directory, 'app.sqlite');
  const attachmentTarget = join(directory, 'attachments');
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    refuse(target + suffix);
  refuse(attachmentTarget);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  safePath(directory, true);
  const stage = mkdtempSync(join(directory, '.portfolio-application-restore-'));
  let publishedAttachments = false;
  let publishedDatabase = false;
  try {
    const snapshot = join(stage, 'input.sqlite');
    privateSnapshot(resolve(source), snapshot);
    const db = new DatabaseSync(snapshot, { readOnly: true });
    let records: ReturnType<typeof rows>;
    let marked: boolean;
    try {
      records = rows(db);
      marked = !!db
        .prepare('SELECT value FROM app_metadata WHERE key=?')
        .get(marker);
    } finally {
      db.close();
    }
    const sidecar = resolve(source) + '.attachments';
    const stagedAttachments = join(stage, 'attachments');
    if (marked || records.length || exists(sidecar)) {
      safePath(sidecar, true);
      const manifestPath = join(sidecar, 'manifest.json');
      safePath(manifestPath);
      if (lstatSync(manifestPath).size > 16 * 1024 * 1024)
        throw new Error('Attachment manifest is too large');
      const manifest = JSON.parse(
        readFileSync(manifestPath, 'utf8'),
      ) as Manifest;
      if (
        manifest.version !== 1 ||
        manifest.databaseSha256 !== digest(snapshot).sha256 ||
        !Array.isArray(manifest.files)
      )
        throw new Error('Invalid attachment manifest or snapshot digest');
      const expected = new Map(records.map((record) => [record.id, record]));
      const seen = new Set<string>();
      mkdirSync(stagedAttachments, { mode: 0o700 });
      for (const file of manifest.files) {
        if (
          !file ||
          !uuid.test(file.id) ||
          !expected.has(file.id) ||
          !names.includes(file.name as (typeof names)[number]) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          !/^[a-f0-9]{64}$/.test(file.sha256)
        )
          throw new Error('Unsafe attachment manifest entry');
        const key = file.id + '/' + file.name;
        if (seen.has(key))
          throw new Error('Duplicate attachment manifest entry');
        seen.add(key);
        const result = digest(
          join(sidecar, 'objects', file.id, file.name),
          join(stagedAttachments, 'objects', file.id, file.name),
        );
        if (
          result.size !== file.size ||
          result.sha256 !== file.sha256 ||
          (file.name === 'original' &&
            (result.size !== expected.get(file.id)!.size_bytes ||
              result.sha256 !== expected.get(file.id)!.original_sha256))
        )
          throw new Error('Attachment integrity check failed');
      }
      for (const record of records)
        if (!seen.has(record.id + '/original'))
          throw new Error('Attachment original missing from manifest');
    }
    // Existing low-level recovery verifies integrity, version history and migrations on a private copy.
    const ready = join(stage, 'ready');
    await restoreDatabase(snapshot, ready, migrationsDir);
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      refuse(target + suffix);
    refuse(attachmentTarget);
    if (exists(stagedAttachments)) {
      mkdirSync(attachmentTarget, { mode: 0o700 });
      publishedAttachments = true;
      for (const record of records)
        for (const name of names) {
          const path = join('objects', record.id, name);
          if (!exists(join(stagedAttachments, path))) continue;
          mkdirSync(dirname(join(attachmentTarget, path)), {
            recursive: true,
            mode: 0o700,
          });
          linkSync(join(stagedAttachments, path), join(attachmentTarget, path));
        }
    }
    if (publishedAttachments) syncDirectory(attachmentTarget);
    syncParent(directory);
    linkSync(join(ready, 'app.sqlite'), target);
    publishedDatabase = true;
    syncParent(directory);
  } finally {
    if (publishedAttachments && !publishedDatabase)
      rmSync(attachmentTarget, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}
