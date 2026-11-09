import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  readdirSync,
  symlinkSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { openDatabase } from './index.js';
import {
  createPortableBackup,
  validatePortableBackup,
} from './portable-backup.js';
const dirs: string[] = [];
const databases: DatabaseSync[] = [];
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'portfolio-portable-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      /* closed */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(attachment = true) {
  const dir = folder();
  const db = openDatabase({ dataDir: dir });
  databases.push(db);
  const id = randomUUID();
  if (attachment) {
    const object = join(dir, 'attachments', 'objects', id);
    mkdirSync(object, { recursive: true });
    writeFileSync(join(object, 'original'), 'retained bytes');
    writeFileSync(join(object, 'thumbnail.webp'), 'thumbnail');
    writeFileSync(join(object, 'preview.webp'), 'preview');
    db.prepare(
      `INSERT INTO board_attachments (id,board_id,owner_type,element_id,entry_id,original_filename,display_name,description,mime_type,size_bytes,stored_bytes,original_sha256,created_at,updated_at,row_version,orphaned_at,deleted_at) VALUES (?, 'deleted-board','device','device','', 'a.txt','a','', 'text/plain',14,14,?,1,1,1,1,1)`,
    ).run(id, createHash('sha256').update('retained bytes').digest('hex'));
  }
  return { dir, db, id };
}
async function zipEntries(source: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) =>
    yauzl.open(source, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const entries = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry: yauzl.Entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}
async function writeZip(
  entries: Map<string, Buffer>,
  destination: string,
  compress = false,
) {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of entries) zip.addBuffer(bytes, name, { compress });
  const result = pipeline(
    zip.outputStream,
    createWriteStream(destination, { flags: 'wx' }),
  );
  zip.end();
  await result;
}
async function archive() {
  const f = fixture();
  const path = join(folder(), 'backup.zip');
  await createPortableBackup(f.db, f.dir, path, {
    applicationVersion: '0.3.0-test',
  });
  return { ...f, path };
}
it('round trips retained originals and derivatives with verified real metadata and private files', async () => {
  const { dir, db, id } = fixture();
  const path = join(folder(), 'backup.zip');
  const created = await createPortableBackup(db, dir, path);
  expect(created.applicationVersion).toBe('0.3.0');
  expect(created.attachmentCount).toBe(1);
  expect(created.attachmentBytes).toBe(30);
  const entries = await zipEntries(path);
  expect(entries.size).toBe(6);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const ready = join(folder(), 'ready');
  const summary = await validatePortableBackup(path, ready);
  expect(summary.manifest).toEqual(created.manifest);
  expect(summary.compatibility).toBe('compatible');
  for (const [name, text] of [
    ['original', 'retained bytes'],
    ['thumbnail.webp', 'thumbnail'],
    ['preview.webp', 'preview'],
  ])
    expect(
      readFileSync(join(ready, 'attachments', 'objects', id, name!), 'utf8'),
    ).toBe(text);
  const reopened = openDatabase({ dataDir: ready });
  databases.push(reopened);
  expect(reopened.prepare('SELECT id FROM board_attachments').get()).toEqual({
    id,
  });
});
it('backs up an empty installation and includes committed WAL writes', async () => {
  const { dir, db } = fixture(false);
  db.prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)').run(
    'portable-test',
    'committed',
  );
  const path = join(folder(), 'empty.zip');
  await createPortableBackup(db, dir, path);
  const ready = join(folder(), 'ready');
  const summary = await validatePortableBackup(path, ready);
  expect(summary.boardCount).toBe(0);
  expect(summary.attachmentCount).toBe(0);
  const reopened = openDatabase({ dataDir: ready });
  databases.push(reopened);
  expect(
    reopened
      .prepare("SELECT value FROM app_metadata WHERE key='portable-test'")
      .get(),
  ).toEqual({ value: 'committed' });
});
it('rejects overwritten targets without deleting user files', async () => {
  const { dir, db } = fixture(false);
  const path = join(folder(), 'keep.zip');
  writeFileSync(path, 'keep');
  await expect(createPortableBackup(db, dir, path)).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe('keep');
  const { path: valid } = await archive();
  const ready = folder();
  writeFileSync(join(ready, 'keep'), 'keep');
  await expect(validatePortableBackup(valid, ready)).rejects.toThrow();
  expect(readFileSync(join(ready, 'keep'), 'utf8')).toBe('keep');
});
it('enforces archive, expanded byte, file count and abort limits with partial cleanup', async () => {
  const { path } = await archive();
  for (const options of [
    { maxBytes: 100 },
    { maxExpandedBytes: 100 },
    { maxEntries: 2 },
    { signal: AbortSignal.abort() },
  ]) {
    const ready = join(folder(), 'ready');
    await expect(
      validatePortableBackup(path, ready, options),
    ).rejects.toThrow();
    expect(existsSync(ready)).toBe(false);
  }
  const { dir, db } = fixture(false);
  const out = join(folder(), 'limited.zip');
  await expect(
    createPortableBackup(db, dir, out, { maxBytes: 100 }),
  ).rejects.toThrow();
  expect(existsSync(out)).toBe(false);
});
it('rejects altered bytes, missing files, inconsistent metadata and unknown files', async () => {
  const { path } = await archive();
  const original = await zipEntries(path);
  const manifest = JSON.parse(original.get('manifest.json')!.toString());
  const cases: Map<string, Buffer>[] = [];
  const altered = new Map(original);
  altered.set('snapshot.sqlite', Buffer.from('broken'));
  cases.push(altered);
  const missing = new Map(original);
  missing.delete('snapshot.sqlite.attachments/manifest.json');
  cases.push(missing);
  const metadata = new Map(original);
  metadata.set(
    'manifest.json',
    Buffer.from(
      JSON.stringify({ ...manifest, boardCount: 99, migrations: [] }),
    ),
  );
  cases.push(metadata);
  const extra = new Map(original);
  extra.set('secret.env', Buffer.from('secret'));
  cases.push(extra);
  for (const entries of cases) {
    const bad = join(folder(), 'bad.zip');
    await writeZip(entries, bad);
    const ready = join(folder(), 'ready');
    await expect(validatePortableBackup(bad, ready)).rejects.toThrow();
    expect(existsSync(ready)).toBe(false);
  }
});
it('accepts bounded deflate and rejects compression bombs', async () => {
  const { path } = await archive();
  const entries = await zipEntries(path);
  const compressed = join(folder(), 'compressed.zip');
  await writeZip(entries, compressed, true);
  await validatePortableBackup(compressed, join(folder(), 'ready'), {
    maxCompressionRatio: 10000,
  });
  await expect(
    validatePortableBackup(compressed, join(folder(), 'limited'), {
      maxCompressionRatio: 1,
    }),
  ).rejects.toThrow();
});
it('rejects executable schema additions even when checksums and migration history match', async () => {
  const { dir, db } = fixture(false);
  db.exec(
    'CREATE TRIGGER unexpected AFTER INSERT ON app_metadata BEGIN DELETE FROM sessions; END',
  );
  await expect(
    createPortableBackup(db, dir, join(folder(), 'bad.zip')),
  ).rejects.toThrow(/schema/i);
});
it('streams a large attachment without omitting retained bytes', async () => {
  const { dir, db, id } = fixture();
  const original = join(dir, 'attachments', 'objects', id, 'original');
  const large = Buffer.alloc(8 * 1024 * 1024, 7);
  writeFileSync(original, large);
  db.prepare(
    'UPDATE board_attachments SET size_bytes=?, stored_bytes=?, original_sha256=? WHERE id=?',
  ).run(
    large.length,
    large.length,
    createHash('sha256').update(large).digest('hex'),
    id,
  );
  const path = join(folder(), 'large.zip');
  await createPortableBackup(db, dir, path);
  const ready = join(folder(), 'ready');
  await validatePortableBackup(path, ready);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(
    join(ready, 'attachments', 'objects', id, 'original'),
  ))
    hash.update(chunk);
  expect(hash.digest('hex')).toBe(
    createHash('sha256').update(large).digest('hex'),
  );
});

it('rejects traversal, absolute, backslash, duplicate, encrypted, symlink and nonregular ZIP entries', async () => {
  const { path } = await archive();
  const base = readFileSync(path);
  const rename = (name: string) => {
    const bytes = Buffer.from(base);
    const needle = Buffer.from('snapshot.sqlite');
    for (let index = 0; index <= bytes.length - needle.length; index++) {
      if (bytes.subarray(index, index + needle.length).equals(needle)) {
        Buffer.from(name).copy(bytes, index);
        index += needle.length - 1;
      }
    }
    return bytes;
  };
  const cases = [
    rename('../evil.sqlite!'),
    rename('/evil.sqlite!!!'),
    rename('evil\\x.sqlite!!'),
  ];
  for (const mode of [0o120600, 0o040700]) {
    const bytes = Buffer.from(base);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE((mode * 65536) >>> 0, central + 38);
    cases.push(bytes);
  }
  const encrypted = Buffer.from(base);
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  cases.push(encrypted);
  for (const bytes of cases) {
    const bad = join(folder(), 'hostile.zip');
    writeFileSync(bad, bytes);
    const ready = join(folder(), 'ready');
    await expect(validatePortableBackup(bad, ready)).rejects.toThrow();
    expect(existsSync(ready)).toBe(false);
  }
  const duplicate = join(folder(), 'duplicate.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('{}'), 'manifest.json');
  zip.addBuffer(Buffer.from('{}'), 'manifest.json');
  const result = pipeline(zip.outputStream, createWriteStream(duplicate));
  zip.end();
  await result;
  await expect(
    validatePortableBackup(duplicate, join(folder(), 'ready')),
  ).rejects.toThrow(/duplicate/i);
});
it('cleans up an interrupted archive stream and leaves no validation directory', async () => {
  const { dir, db } = fixture(false);
  const path = join(folder(), 'interrupted.zip');
  const controller = new AbortController();
  const creation = createPortableBackup(db, dir, path, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(creation).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
});
it('rejects bounded manifest files and truncated ZIPs', async () => {
  const { path } = await archive();
  const ready = join(folder(), 'ready');
  await expect(
    validatePortableBackup(path, ready, { maxManifestBytes: 10 }),
  ).rejects.toThrow();
  expect(existsSync(ready)).toBe(false);
  const truncated = join(folder(), 'truncated.zip');
  writeFileSync(truncated, readFileSync(path).subarray(0, 100));
  await expect(validatePortableBackup(truncated, ready)).rejects.toThrow();
  expect(existsSync(ready)).toBe(false);
});

function refreshChecksums(entries: Map<string, Buffer>) {
  const manifest = JSON.parse(entries.get('manifest.json')!.toString());
  const inner = JSON.parse(
    entries.get('snapshot.sqlite.attachments/manifest.json')!.toString(),
  );
  inner.databaseSha256 = createHash('sha256')
    .update(entries.get('snapshot.sqlite')!)
    .digest('hex');
  entries.set(
    'snapshot.sqlite.attachments/manifest.json',
    Buffer.from(JSON.stringify(inner)),
  );
  manifest.files = [...entries]
    .filter(([path]) => path !== 'manifest.json')
    .map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
}
it('rejects missing required originals even if both manifests omit the original', async () => {
  const { path, id } = await archive();
  const entries = await zipEntries(path);
  const inner = JSON.parse(
    entries.get('snapshot.sqlite.attachments/manifest.json')!.toString(),
  );
  inner.files = inner.files.filter(
    (file: { name: string }) => file.name !== 'original',
  );
  entries.set(
    'snapshot.sqlite.attachments/manifest.json',
    Buffer.from(JSON.stringify(inner)),
  );
  entries.delete(`snapshot.sqlite.attachments/objects/${id}/original`);
  refreshChecksums(entries);
  const bad = join(folder(), 'missing.zip');
  await writeZip(entries, bad);
  const ready = join(folder(), 'ready');
  await expect(validatePortableBackup(bad, ready)).rejects.toThrow(
    /original missing/i,
  );
  expect(existsSync(ready)).toBe(false);
});
it('rejects same-size checksum corruption and newer archive formats', async () => {
  const { path, id } = await archive();
  const entries = await zipEntries(path);
  entries.set(
    `snapshot.sqlite.attachments/objects/${id}/original`,
    Buffer.from('altered! bytes'),
  );
  const corrupt = join(folder(), 'corrupt.zip');
  await writeZip(entries, corrupt);
  await expect(
    validatePortableBackup(corrupt, join(folder(), 'ready')),
  ).rejects.toThrow(/checksum/i);
  const future = await zipEntries(path);
  const manifest = JSON.parse(future.get('manifest.json')!.toString());
  manifest.formatVersion = 2;
  future.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const newer = join(folder(), 'newer.zip');
  await writeZip(future, newer);
  await expect(
    validatePortableBackup(newer, join(folder(), 'new')),
  ).rejects.toThrow();
});
it('rejects invalid SQLite, forged migration history and trigger payloads after valid manifest checksums', async () => {
  const { path } = await archive();
  for (const mutation of [
    'invalid',
    'migration',
    'trigger',
    'sqlite-prefix-trigger',
    'board',
  ] as const) {
    const entries = await zipEntries(path);
    if (mutation === 'invalid')
      entries.set('snapshot.sqlite', Buffer.from('this is not a database'));
    else {
      const snapshot = join(folder(), 'snapshot.sqlite');
      writeFileSync(snapshot, entries.get('snapshot.sqlite')!);
      const db = new DatabaseSync(snapshot);
      try {
        if (mutation === 'migration')
          db.exec(
            "UPDATE schema_migrations SET checksum='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE name=(SELECT min(name) FROM schema_migrations)",
          );
        if (mutation === 'trigger')
          db.exec(
            'CREATE TRIGGER bad AFTER INSERT ON app_metadata BEGIN DELETE FROM users; END',
          );
        if (mutation === 'sqlite-prefix-trigger')
          db.exec(
            'CREATE TRIGGER sqliteXevil AFTER INSERT ON app_metadata BEGIN DELETE FROM users; END',
          );
        if (mutation === 'board')
          db.prepare(
            "INSERT INTO boards(id,name,document_json,created_at,updated_at) VALUES ('bad','bad',?,1,1)",
          ).run(
            '{"elements":[],"ports":[],"cables":[],"viewport":{"x":0,"y":0,"zoom":0}}',
          );
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      entries.set('snapshot.sqlite', readFileSync(snapshot));
    }
    refreshChecksums(entries);
    const bad = join(folder(), mutation + '.zip');
    await writeZip(entries, bad);
    const ready = join(folder(), 'ready');
    await expect(validatePortableBackup(bad, ready)).rejects.toThrow();
    expect(existsSync(ready)).toBe(false);
  }
});
it('captures a transactionally consistent snapshot while another WAL connection keeps writing', async () => {
  const { dir, db } = fixture(false);
  db.prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)').run('a', '0');
  db.prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)').run('b', '0');
  // A larger SQLite snapshot gives the online backup work to interleave with writes.
  db.prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)').run(
    'padding',
    'x'.repeat(8 * 1024 * 1024),
  );
  const writer = openDatabase({ dataDir: dir });
  databases.push(writer);
  let writes = 0;
  const timer = setInterval(() => {
    writer.exec('BEGIN IMMEDIATE');
    writer
      .prepare("UPDATE app_metadata SET value=? WHERE key IN ('a','b')")
      .run(String(++writes));
    writer.exec('COMMIT');
    if (writes === 10) clearInterval(timer);
  }, 1);
  const path = join(folder(), 'wal.zip');
  try {
    await createPortableBackup(db, dir, path);
  } finally {
    clearInterval(timer);
  }
  expect(writes).toBeGreaterThan(0);
  const ready = join(folder(), 'ready');
  await validatePortableBackup(path, ready);
  const restored = openDatabase({ dataDir: ready });
  databases.push(restored);
  const values = restored
    .prepare(
      "SELECT value FROM app_metadata WHERE key IN ('a','b') ORDER BY key",
    )
    .all() as { value: string }[];
  expect(values[0]!.value).toBe(values[1]!.value);
});
it('forward migrates an exact historical prefix and refuses symlink input paths', async () => {
  const migrations = folder();
  copyFileSync(
    resolve('packages/db/migrations/001_foundation.sql'),
    join(migrations, '001_foundation.sql'),
  );
  const dir = folder();
  const db = openDatabase({ dataDir: dir, migrationsDir: migrations });
  databases.push(db);
  const path = join(folder(), 'old.zip');
  const created = await createPortableBackup(db, dir, path);
  expect(created.databaseSchemaVersion).toBe('001_foundation.sql');
  const ready = join(folder(), 'ready');
  await validatePortableBackup(path, ready);
  const reopened = openDatabase({ dataDir: ready });
  databases.push(reopened);
  expect(reopened.prepare('SELECT count(*) AS n FROM boards').get()).toEqual({
    n: 0,
  });
  const symlink = join(folder(), 'linked.zip');
  symlinkSync(path, symlink);
  await expect(
    validatePortableBackup(symlink, join(folder(), 'bad')),
  ).rejects.toThrow(/symlink/i);
});
it('cancels an in-progress extraction without leaving owned files or stages', async () => {
  const { dir, db, id } = fixture();
  const bytes = Buffer.alloc(8 * 1024 * 1024, 4);
  writeFileSync(join(dir, 'attachments', 'objects', id, 'original'), bytes);
  db.prepare(
    'UPDATE board_attachments SET size_bytes=?,stored_bytes=?,original_sha256=? WHERE id=?',
  ).run(
    bytes.length,
    bytes.length,
    createHash('sha256').update(bytes).digest('hex'),
    id,
  );
  const path = join(folder(), 'large.zip');
  await createPortableBackup(db, dir, path);
  const parent = folder();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    await expect(
      validatePortableBackup(path, join(parent, 'ready'), {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
  expect(readdirSync(parent)).toEqual([]);
});
it('rejects a corrupt inner attachment digest even when the outer manifest is updated', async () => {
  const { path } = await archive();
  const entries = await zipEntries(path);
  const inner = JSON.parse(
    entries.get('snapshot.sqlite.attachments/manifest.json')!.toString(),
  );
  inner.files[0].sha256 = 'a'.repeat(64);
  entries.set(
    'snapshot.sqlite.attachments/manifest.json',
    Buffer.from(JSON.stringify(inner)),
  );
  refreshChecksums(entries);
  const bad = join(folder(), 'inner.zip');
  await writeZip(entries, bad);
  const ready = join(folder(), 'ready');
  await expect(validatePortableBackup(bad, ready)).rejects.toThrow(
    /integrity/i,
  );
  expect(existsSync(ready)).toBe(false);
});
