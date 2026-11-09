import { createHash } from 'node:crypto';
import {
  constants,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  copyFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { z } from 'zod';
import { backupApplication, restoreApplication } from './application-backup.js';
import { migrateDatabase } from './index.js';
import { boardDocumentSchema } from '../../shared/src/board.js';

export const PORTABLE_BACKUP_MAX_BYTES = 4 * 1024 ** 3;
export interface PortableBackupOptions {
  maxBytes?: number;
  maxExpandedBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxManifestBytes?: number;
  maxCompressionRatio?: number;
  maxDurationMs?: number;
  applicationVersion?: string;
  signal?: AbortSignal;
}
export interface PortableBackupManifest {
  format: 'portfolio-complete-backup';
  formatVersion: 1;
  applicationVersion: string;
  createdAt: string;
  databaseSchemaVersion: string;
  migrations: { name: string; checksum: string }[];
  components: string[];
  files: { path: string; size: number; sha256: string }[];
}
export interface PortableBackupSummary {
  createdAt: string;
  applicationVersion: string;
  databaseSchemaVersion: string;
  boardCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  compatibility: 'compatible';
  manifest: PortableBackupManifest;
}
const components = ['database', 'attachments'];
const digestPattern = /^[a-f0-9]{64}$/;
const objectPattern =
  /^snapshot\.sqlite\.attachments\/objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(original|thumbnail\.webp|preview\.webp)$/i;
const allowed = (name: string) =>
  name === 'manifest.json' ||
  name === 'snapshot.sqlite' ||
  name === 'snapshot.sqlite.attachments/manifest.json' ||
  objectPattern.test(name);
const fileSchema = z
  .object({
    path: z.string().max(240),
    size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(digestPattern),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal('portfolio-complete-backup'),
    formatVersion: z.literal(1),
    applicationVersion: z.string().min(1).max(240),
    createdAt: z.iso.datetime(),
    databaseSchemaVersion: z.string().min(1).max(240),
    migrations: z
      .array(
        z
          .object({
            name: z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/),
            checksum: z.string().regex(digestPattern),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    components: z.tuple([z.literal('database'), z.literal('attachments')]),
    files: z.array(fileSchema).min(2).max(100000),
  })
  .strict();
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
      throw new Error('Backup paths cannot contain symlinks');
    if (current !== absolute && !stat.isDirectory() && !stat.isSymbolicLink())
      throw new Error('Invalid backup directory');
  }
  const stat = lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw new Error('Expected a regular backup file/directory');
  return stat;
}
function operation(options: PortableBackupOptions) {
  const value = (n: number | undefined, fallback: number) => {
    if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0))
      throw new Error('Invalid backup limit');
    return n ?? fallback;
  };
  const maxBytes = value(options.maxBytes, PORTABLE_BACKUP_MAX_BYTES);
  const maxExpandedBytes = value(
    options.maxExpandedBytes,
    PORTABLE_BACKUP_MAX_BYTES,
  );
  const duration = value(options.maxDurationMs, 15 * 60_000);
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(duration),
  ]);
  const check = () => signal.throwIfAborted();
  check();
  return {
    maxBytes,
    maxExpandedBytes,
    maxEntries: value(options.maxEntries, 100000),
    maxFileBytes: value(options.maxFileBytes, PORTABLE_BACKUP_MAX_BYTES),
    maxManifestBytes: value(options.maxManifestBytes, 16 * 1024 * 1024),
    maxCompressionRatio: value(options.maxCompressionRatio, 200),
    signal,
    check,
  };
}
type Limits = ReturnType<typeof operation>;
async function hashFile(path: string, limits: Limits) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, {
    fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    signal: limits.signal,
  })) {
    limits.check();
    size += chunk.length;
    if (size > limits.maxFileBytes)
      throw new Error('Backup file exceeds byte limit');
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}
function walk(path: string, prefix: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Backup contains a symlink');
    const child = join(path, entry.name);
    const name = prefix + '/' + entry.name;
    if (entry.isDirectory()) result.push(...walk(child, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Backup contains a nonregular file');
  }
  return result;
}
function metadata(snapshot: string, limits: Limits) {
  limits.check();
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    const bundled = resolve('packages/db/migrations');
    const names = readdirSync(bundled)
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const trusted = new DatabaseSync(':memory:');
    let subset: string | undefined;
    let migrations: { name: string; checksum: string }[];
    try {
      migrateDatabase(trusted, bundled);
      const historySchema =
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='schema_migrations'";
      if (
        JSON.stringify(db.prepare(historySchema).all()) !==
        JSON.stringify(trusted.prepare(historySchema).all())
      )
        throw new Error(
          'Backup migration table schema differs from trusted migrations',
        );
      migrations = db
        .prepare(
          'SELECT name,checksum FROM schema_migrations ORDER BY name LIMIT 1001',
        )
        .all() as { name: string; checksum: string }[];
      if (!migrations.length || migrations.length > names.length)
        throw new Error('Backup migration history exceeds limit or is empty');
      for (const [index, migration] of migrations.entries()) {
        const name = names[index];
        if (
          name !== migration.name ||
          createHash('sha256')
            .update(readFileSync(join(bundled, name!)))
            .digest('hex') !== migration.checksum
        )
          throw new Error('Backup migration history mismatch');
      }
      let expected = trusted;
      let prefix: DatabaseSync | undefined;
      try {
        if (migrations.length !== names.length) {
          subset = mkdtempSync(join(dirname(snapshot), '.portable-schema-'));
          for (const migration of migrations)
            copyFileSync(
              join(bundled, migration.name),
              join(subset, migration.name),
              constants.COPYFILE_EXCL,
            );
          prefix = new DatabaseSync(':memory:');
          migrateDatabase(prefix, subset);
          expected = prefix;
        }
        const schema =
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 10001";
        if (
          JSON.stringify(db.prepare(schema).all()) !==
          JSON.stringify(expected.prepare(schema).all())
        )
          throw new Error(
            'Backup database schema differs from trusted migrations',
          );
      } finally {
        prefix?.close();
      }
    } finally {
      trusted.close();
      if (subset) rmSync(subset, { recursive: true, force: true });
    }
    const integrity = db.prepare('PRAGMA integrity_check(1)').all() as {
      integrity_check: string;
    }[];
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()
    )
      throw new Error('Backup database integrity check failed');
    let boardCount = 0;
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='boards'").get()) {
      if (
        db
          .prepare(
            'SELECT 1 FROM boards WHERE length(CAST(document_json AS BLOB)) > ? LIMIT 1',
          )
          .get(16 * 1024 * 1024)
      )
        throw new Error('Backup board document is too large');
      for (const row of db
        .prepare('SELECT document_json FROM boards')
        .iterate() as Iterable<{ document_json: string }>) {
        limits.check();
        boardDocumentSchema.parse(JSON.parse(row.document_json));
        boardCount++;
      }
    }
    let attachmentCount = 0,
      attachmentBytes = 0;
    if (
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='board_attachments'")
        .get()
    ) {
      const row = db
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(size_bytes),0) AS bytes FROM board_attachments',
        )
        .get() as { count: number; bytes: number };
      attachmentCount = row.count;
      attachmentBytes = row.bytes;
      if (!Number.isSafeInteger(attachmentBytes) || attachmentBytes < 0)
        throw new Error('Invalid backup attachment bytes');
    }
    limits.check();
    return {
      migrations,
      databaseSchemaVersion: migrations.at(-1)!.name,
      boardCount,
      attachmentCount,
      attachmentBytes,
    };
  } finally {
    db.close();
  }
}
function summary(
  manifest: PortableBackupManifest,
  meta: ReturnType<typeof metadata>,
): PortableBackupSummary {
  return {
    createdAt: manifest.createdAt,
    applicationVersion: manifest.applicationVersion,
    databaseSchemaVersion: manifest.databaseSchemaVersion,
    boardCount: meta.boardCount,
    attachmentCount: meta.attachmentCount,
    attachmentBytes: manifest.files
      .filter((file) => objectPattern.test(file.path))
      .reduce((total, file) => total + file.size, 0),
    compatibility: 'compatible',
    manifest,
  };
}
/** Stream an online complete SQLite/attachment snapshot into a private store-only ZIP. */
export async function createPortableBackup(
  db: DatabaseSync,
  dataDir: string,
  destination: string,
  options: PortableBackupOptions = {},
): Promise<PortableBackupSummary> {
  const limits = operation(options),
    target = resolve(destination);
  safePath(dirname(target), true);
  const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  // Await exclusive reservation before taking ownership of any cleanup.
  await new Promise<void>((resolve, reject) => {
    output.once('open', () => resolve());
    output.once('error', reject);
  });
  let stage: string | undefined;
  let complete = false;
  try {
    limits.check();
    stage = mkdtempSync(join(dirname(target), '.portfolio-portable-'));
    const snapshot = join(stage, 'snapshot.sqlite');
    await backupApplication(db, dataDir, snapshot);
    limits.check();
    const meta = metadata(snapshot, limits);
    const paths = [
      'snapshot.sqlite',
      ...walk(snapshot + '.attachments', 'snapshot.sqlite.attachments'),
    ].sort();
    if (paths.length + 1 > limits.maxEntries)
      throw new Error('Backup entry count exceeds limit');
    const files: PortableBackupManifest['files'] = [];
    let expanded = 0;
    for (const path of paths) {
      if (!allowed(path)) throw new Error('Unexpected backup file');
      const digest = await hashFile(join(stage, path), limits);
      expanded += digest.size;
      if (expanded > limits.maxExpandedBytes)
        throw new Error('Backup exceeds expanded byte limit');
      files.push({ path, ...digest });
    }
    const version =
      options.applicationVersion ??
      (
        JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
          version: string;
        }
      ).version;
    const manifest: PortableBackupManifest = {
      format: 'portfolio-complete-backup',
      formatVersion: 1,
      applicationVersion: version,
      createdAt: new Date().toISOString(),
      databaseSchemaVersion: meta.databaseSchemaVersion,
      migrations: meta.migrations,
      components,
      files,
    };
    manifestSchema.parse(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (
      bytes.length > limits.maxManifestBytes ||
      expanded + bytes.length > limits.maxExpandedBytes
    )
      throw new Error('Backup manifest exceeds byte limit');
    const zip = new yazl.ZipFile();
    zip.on('error', (error: Error) =>
      (zip.outputStream as Readable).destroy(error),
    );
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        if (compressed > limits.maxBytes)
          callback(new Error('Backup archive exceeds byte limit'));
        else callback(null, chunk);
      },
    });
    let compressed = 0;
    const written = pipeline(zip.outputStream, counter, output, {
      signal: limits.signal,
    });
    for (const file of files)
      zip.addFile(join(stage, file.path), file.path, {
        compress: false,
        mode: 0o100600,
      });
    zip.addBuffer(bytes, 'manifest.json', { compress: false, mode: 0o100600 });
    zip.end();
    await written;
    for (const path of [target, dirname(target)]) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    limits.check();
    complete = true;
    return summary(manifest, meta);
  } finally {
    output.destroy();
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (!complete) rmSync(target, { force: true });
  }
}
async function extract(source: string, stage: string, limits: Limits) {
  const records = new Map<string, { size: number; sha256: string }>();
  let expanded = 0;
  await new Promise<void>((resolve, reject) => {
    yauzl.open(
      source,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error('Invalid ZIP'));
          return;
        }
        let settled = false;
        let active: Promise<void> | undefined;
        const fail = (reason: unknown) => {
          if (settled) return;
          settled = true;
          zip.close();
          limits.signal.removeEventListener('abort', abort);
          // Settle the active extractor before the caller removes its private stage.
          void Promise.resolve(active)
            .catch(() => {})
            .then(() => reject(reason));
        };
        const abort = () => fail(limits.signal.reason);
        limits.signal.addEventListener('abort', abort, { once: true });
        zip.on('error', fail);
        zip.on('end', () => {
          if (!settled) {
            settled = true;
            limits.signal.removeEventListener('abort', abort);
            resolve();
          }
        });
        if (zip.entryCount > limits.maxEntries) {
          fail(new Error('Backup entry count exceeds limit'));
          return;
        }
        zip.on('entry', (entry: yauzl.Entry) => {
          active = (async () => {
            limits.check();
            const name = entry.fileName;
            const unixMode = entry.externalFileAttributes >>> 16;
            const kind = unixMode & 0o170000;
            if (
              !allowed(name) ||
              name.includes('\\') ||
              records.has(name) ||
              entry.generalPurposeBitFlag & 1 ||
              ![0, 8].includes(entry.compressionMethod) ||
              (kind !== 0 && kind !== 0o100000) ||
              entry.externalFileAttributes & 0x10
            )
              throw new Error('Unsafe, duplicate or unexpected ZIP entry');
            if (
              records.size >= limits.maxEntries ||
              entry.uncompressedSize > limits.maxFileBytes ||
              entry.uncompressedSize > limits.maxExpandedBytes - expanded ||
              ((name === 'manifest.json' || name.endsWith('/manifest.json')) &&
                entry.uncompressedSize > limits.maxManifestBytes) ||
              entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
                limits.maxCompressionRatio
            )
              throw new Error('Backup ZIP entry exceeds resource limit');
            const stream = await new Promise<NodeJS.ReadableStream>(
              (resolve, reject) =>
                zip.openReadStream(entry, (err, input) =>
                  err || !input
                    ? reject(err ?? new Error('Invalid ZIP stream'))
                    : resolve(input),
                ),
            );
            if (settled || limits.signal.aborted) {
              (stream as Readable).destroy();
              limits.check();
              throw new Error('Backup extraction was interrupted');
            }
            const hash = createHash('sha256');
            let size = 0;
            const bound = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length;
                expanded += chunk.length;
                if (
                  size > entry.uncompressedSize ||
                  size > limits.maxFileBytes ||
                  expanded > limits.maxExpandedBytes
                )
                  callback(new Error('Backup expanded bytes exceed limit'));
                else {
                  hash.update(chunk);
                  callback(null, chunk);
                }
              },
            });
            const target = join(stage, name);
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            await pipeline(
              stream,
              bound,
              createWriteStream(target, { flags: 'wx', mode: 0o600 }),
              { signal: limits.signal },
            );
            if (size !== entry.uncompressedSize)
              throw new Error('Backup ZIP size mismatch');
            records.set(name, { size, sha256: hash.digest('hex') });
            limits.check();
            zip.readEntry();
          })();
          void active.catch(fail);
        });
        zip.readEntry();
      },
    );
  });
  return records;
}
/** Validate hostile input and publish a complete ready directory only into a new destination. */
export async function validatePortableBackup(
  source: string,
  destination: string,
  options: PortableBackupOptions = {},
): Promise<PortableBackupSummary> {
  const limits = operation(options);
  const input = resolve(source),
    target = resolve(destination);
  const stat = safePath(input);
  if (stat.size > limits.maxBytes)
    throw new Error('Backup archive exceeds byte limit');
  safePath(dirname(target), true);
  mkdirSync(target, { mode: 0o700 });
  let stage: string | undefined;
  let complete = false;
  try {
    stage = mkdtempSync(join(dirname(target), '.portfolio-validate-'));
    const records = await extract(input, stage, limits);
    if (!records.has('manifest.json'))
      throw new Error('Backup manifest is missing');
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8')),
    );
    if (records.size !== manifest.files.length + 1)
      throw new Error('Backup manifest file set differs from ZIP');
    const seen = new Set<string>();
    for (const file of manifest.files) {
      const actual = records.get(file.path);
      if (
        file.path === 'manifest.json' ||
        !allowed(file.path) ||
        seen.has(file.path) ||
        !actual ||
        actual.size !== file.size ||
        actual.sha256 !== file.sha256
      )
        throw new Error('Backup file checksum or manifest mismatch');
      seen.add(file.path);
    }
    if (
      !seen.has('snapshot.sqlite') ||
      !seen.has('snapshot.sqlite.attachments/manifest.json')
    )
      throw new Error('Backup required files are missing');
    const attachmentManifest = JSON.parse(
      readFileSync(
        join(stage, 'snapshot.sqlite.attachments/manifest.json'),
        'utf8',
      ),
    ) as { files?: { id: string; name: string }[] };
    if (!Array.isArray(attachmentManifest.files))
      throw new Error('Invalid attachment manifest');
    const objects = attachmentManifest.files.map(
      (file) =>
        'snapshot.sqlite.attachments/objects/' + file.id + '/' + file.name,
    );
    if (
      new Set(objects).size !== objects.length ||
      objects.length !== manifest.files.length - 2 ||
      objects.some((path) => !seen.has(path))
    )
      throw new Error('Backup attachment file set differs from manifest');
    const meta = metadata(join(stage, 'snapshot.sqlite'), limits);
    if (
      meta.databaseSchemaVersion !== manifest.databaseSchemaVersion ||
      JSON.stringify(meta.migrations) !== JSON.stringify(manifest.migrations)
    )
      throw new Error('Backup database metadata differs from manifest');
    await restoreApplication(join(stage, 'snapshot.sqlite'), target);
    limits.check();
    // Validate the final migrated result too, including canonical board graph integrity.
    metadata(join(target, 'app.sqlite'), limits);
    complete = true;
    return summary(manifest, meta);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (!complete) rmSync(target, { recursive: true, force: true });
  }
}
