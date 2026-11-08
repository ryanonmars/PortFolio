import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { openDatabase } from '../../../packages/db/src/index.js';
import { emptyBoardDocument } from '../../../packages/shared/src/board.js';
import { registerAttachments } from './attachments.js';
import { ApiError } from './errors.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(maxFileBytes = 1024 * 1024, maxStorageBytes?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-attachments-'));
  const db = openDatabase({ dataDir });
  const document = emptyBoardDocument();
  document.elements.push({
    id: 'device',
    type: 'device',
    name: 'Appliance',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    z: 0,
    color: '#428deb',
    properties: {},
  });
  db.prepare(
    'INSERT INTO boards(id,name,order_index,document_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run(
    'board',
    'Example',
    0,
    JSON.stringify(document),
    Date.now(),
    Date.now(),
  );
  const app = Fastify();
  const service = await registerAttachments(
    app,
    db,
    (r) => {
      if (r.headers.authorization !== 'test')
        throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    },
    {
      dataDir,
      maxFileBytes,
      ...(maxStorageBytes === undefined ? {} : { maxStorageBytes }),
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    const e = error as { statusCode?: number; message: string };
    reply.code(e.statusCode ?? 500).send({ message: e.message });
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const path = '/api/v1/boards/board/attachments';
  const query = '?ownerType=device&elementId=device';
  const upload = (payload: Buffer, name = 'notes.txt') =>
    app.inject({
      method: 'POST',
      url: path + query + '&filename=' + encodeURIComponent(name),
      headers: {
        authorization: 'test',
        'content-type': 'application/octet-stream',
      },
      payload,
    });
  return { app, db, dataDir, document, service, path, query, upload };
}
describe('private board attachments', () => {
  it.each(['PATCH', 'DELETE'] as const)(
    'rejects a concurrent metadata writer between validation and %s publication',
    async (method) => {
      const f = await fixture();
      const record = (await f.upload(Buffer.from('Original reference'))).json()
        .attachment;
      const competing = openDatabase({ dataDir: f.dataDir });
      const prepare = f.db.prepare.bind(f.db);
      const spy = vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
        if (
          sql.startsWith(
            method === 'PATCH'
              ? 'UPDATE board_attachments SET display_name'
              : 'UPDATE board_attachments SET deleted_at',
          )
        ) {
          competing
            .prepare(
              'UPDATE board_attachments SET display_name=?,row_version=row_version+1 WHERE id=?',
            )
            .run('Concurrent edit', record.id);
        }
        return prepare(sql);
      });
      try {
        const response = await f.app.inject({
          method,
          url: f.path + '/' + record.id + f.query,
          headers: { authorization: 'test' },
          payload:
            method === 'PATCH'
              ? { displayName: 'Stale edit', description: '', rowVersion: 1 }
              : { rowVersion: 1 },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(
          competing
            .prepare(
              'SELECT display_name,deleted_at,row_version FROM board_attachments WHERE id=?',
            )
            .get(record.id),
        ).toEqual({
          display_name: 'Concurrent edit',
          deleted_at: null,
          row_version: 2,
        });
      } finally {
        spy.mockRestore();
        competing.close();
      }
    },
  );
  it.each(['jpeg', 'png', 'webp'] as const)(
    'accepts real %s images and preserves their original bytes',
    async (format) => {
      const f = await fixture();
      const bytes = await sharp({
        create: { width: 32, height: 48, channels: 3, background: '#367c62' },
      })
        .toFormat(format)
        .toBuffer();
      const upload = await f.upload(
        bytes,
        `equipment.${format === 'jpeg' ? 'jpg' : format}`,
      );
      expect(upload.statusCode, upload.body).toBe(201);
      const record = upload.json().attachment;
      expect(record).toMatchObject({
        mimeType: `image/${format}`,
        width: 32,
        height: 48,
        available: true,
      });
      const file = await f.app.inject({
        url: f.path + '/' + record.id + '/original' + f.query,
        headers: { authorization: 'test' },
      });
      expect(file.rawPayload).toEqual(bytes);
    },
  );
  it('cleans interrupted socket uploads without publishing metadata or blocking subsequent uploads', async () => {
    const f = await fixture();
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(
      origin + f.path + f.query + '&filename=interrupted.txt',
      {
        method: 'POST',
        headers: {
          authorization: 'test',
          'content-type': 'application/octet-stream',
          'content-length': '10000',
        },
      },
    );
    request.on('error', () => {});
    request.write('partial bytes');
    const staging = join(f.dataDir, 'attachments', 'staging');
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Upload cleanup did not settle');
    };
    try {
      await waitFor(() => readdirSync(staging).length === 1);
    } finally {
      request.destroy();
    }
    await waitFor(() => readdirSync(staging).length === 0);
    expect(
      f.db.prepare('SELECT count(*) AS n FROM board_attachments').get(),
    ).toEqual({ n: 0 });
    expect((await f.upload(Buffer.from('Retry succeeds'))).statusCode).toBe(
      201,
    );
  });
  it('persists immutable originals, edits metadata with versions and isolates owners', async () => {
    const f = await fixture();
    const result = await f.upload(Buffer.from('documented settings'));
    expect(result.statusCode, result.body).toBe(201);
    const r = result.json().attachment;
    expect(r.available).toBe(true);
    expect(r).not.toHaveProperty('path');
    const file = await f.app.inject({
      url: f.path + '/' + r.id + '/original' + f.query,
      headers: { authorization: 'test' },
    });
    expect(file.body).toBe('documented settings');
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    const wrong = await f.app.inject({
      url: f.path + '/' + r.id + '/original?ownerType=device&elementId=other',
      headers: { authorization: 'test' },
    });
    expect(wrong.statusCode).toBe(404);
    const update = await f.app.inject({
      method: 'PATCH',
      url: f.path + '/' + r.id + f.query,
      headers: { authorization: 'test' },
      payload: { displayName: 'Manual', description: 'Caption', rowVersion: 1 },
    });
    expect(update.json().attachment.rowVersion).toBe(2);
    const stale = await f.app.inject({
      method: 'DELETE',
      url: f.path + '/' + r.id + f.query,
      headers: { authorization: 'test' },
      payload: { rowVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
  });
  it('rejects unauthenticated, unsupported, malformed, empty and oversized files without metadata', async () => {
    const f = await fixture(1024);
    const noauth = await f.app.inject({
      method: 'POST',
      url: f.path + f.query + '&filename=a.txt',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('test'),
    });
    expect(noauth.statusCode).toBe(401);
    for (const [bytes, name, status] of [
      [Buffer.from('hello'), 'x.exe', 415],
      [Buffer.from('not a jpeg'), 'x.jpg', 415],
      [Buffer.alloc(0), 'x.txt', 400],
      [Buffer.alloc(1025, 65), 'x.txt', 413],
      [Buffer.from('<svg></svg>'), 'x.txt', 415],
      [Buffer.from('a'), '../x.txt', 400],
    ] as const) {
      const r = await f.upload(bytes, name);
      expect(r.statusCode, r.body).toBe(status);
    }
    expect(
      f.db.prepare('SELECT count(*) AS n FROM board_attachments').get(),
    ).toEqual({ n: 0 });
  });
  it('creates safe image variants, regenerates missing variants and reports missing original', async () => {
    const f = await fixture();
    const bytes = await sharp({
      create: { width: 20, height: 30, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const r = await f.upload(bytes, 'photo.png');
    expect(r.statusCode, r.body).toBe(201);
    const a = r.json().attachment;
    expect(a.width).toBe(20);
    const dir = join(f.dataDir, 'attachments', 'objects', a.id);
    unlinkSync(join(dir, 'thumbnail.webp'));
    const thumb = await f.app.inject({
      url: f.path + '/' + a.id + '/thumbnail' + f.query,
      headers: { authorization: 'test' },
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/webp');
    unlinkSync(join(dir, 'original'));
    symlinkSync('/etc/hosts', join(dir, 'original'));
    const original = await f.app.inject({
      url: f.path + '/' + a.id + '/original' + f.query,
      headers: { authorization: 'test' },
    });
    expect(original.statusCode).toBe(410);
  });
  it('retains orphaned attachments and restores them by stable owner identity', async () => {
    const f = await fixture();
    const r = await f.upload(Buffer.from('settings'));
    const a = r.json().attachment;
    f.service.reconcile('board', emptyBoardDocument());
    expect(
      (
        f.db.prepare('SELECT orphaned_at FROM board_attachments').get() as {
          orphaned_at: number;
        }
      ).orphaned_at,
    ).toBeGreaterThan(0);
    f.service.reconcile('board', f.document);
    expect(
      f.db.prepare('SELECT orphaned_at FROM board_attachments').get(),
    ).toEqual({ orphaned_at: null });
    expect(
      existsSync(join(f.dataDir, 'attachments', 'objects', a.id, 'original')),
    ).toBe(true);
  });
  it('rechecks owner after streaming and serializes retained storage quota', async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from('part one');
        started();
        await waiting;
        yield Buffer.from('part two');
      })(),
    );
    const pending = f.app.inject({
      method: 'POST',
      url: f.path + f.query + '&filename=notes.txt',
      headers: {
        authorization: 'test',
        'content-type': 'application/octet-stream',
      },
      payload: stream,
    });
    void pending.then(() => {});
    await reading;
    f.db
      .prepare('UPDATE boards SET document_json=? WHERE id=?')
      .run(JSON.stringify(emptyBoardDocument()), 'board');
    release();
    const result = await pending;
    expect(result.statusCode).toBe(404);
    expect(
      f.db.prepare('SELECT count(*) AS n FROM board_attachments').get(),
    ).toEqual({ n: 0 });
  });
  it('startup cleanup honors backup leases and never purges active owners', async () => {
    const f = await fixture();
    const r = await f.upload(Buffer.from('retained'));
    const a = r.json().attachment;
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000;
    f.db.prepare('UPDATE board_attachments SET orphaned_at=?').run(expired);
    let app = Fastify();
    await registerAttachments(app, f.db, () => {}, { dataDir: f.dataDir });
    await app.close();
    expect(
      f.db.prepare('SELECT orphaned_at FROM board_attachments').get(),
    ).toEqual({ orphaned_at: null });
    f.db.prepare('UPDATE board_attachments SET deleted_at=?').run(expired);
    f.db
      .prepare(
        'INSERT INTO attachment_backup_leases(id,expires_at) VALUES(?,?)',
      )
      .run('backup', Date.now() + 60000);
    app = Fastify();
    await registerAttachments(app, f.db, () => {}, { dataDir: f.dataDir });
    await app.close();
    expect(
      existsSync(join(f.dataDir, 'attachments', 'objects', a.id, 'original')),
    ).toBe(true);
    f.db.prepare('DELETE FROM attachment_backup_leases').run();
    app = Fastify();
    await registerAttachments(app, f.db, () => {}, { dataDir: f.dataDir });
    await app.close();
    expect(
      f.db.prepare('SELECT count(*) AS n FROM board_attachments').get(),
    ).toEqual({ n: 0 });
    expect(existsSync(join(f.dataDir, 'attachments', 'objects', a.id))).toBe(
      false,
    );
  });
  it('counts derived image bytes in retained quota and keeps duplicate filenames independent', async () => {
    const bytes = await sharp({
      create: { width: 20, height: 30, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const limited = await fixture(1024 * 1024, bytes.length);
    const rejected = await limited.upload(bytes, 'photo.png');
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(
      limited.db.prepare('SELECT count(*) AS n FROM board_attachments').get(),
    ).toEqual({ n: 0 });
    const f = await fixture();
    const first = await f.upload(Buffer.from('one'), 'same.txt');
    const second = await f.upload(Buffer.from('two'), 'same.txt');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().attachment.id).not.toBe(second.json().attachment.id);
  });
  it('rejects ambiguous device entry IDs and marks damaged originals unavailable', async () => {
    const f = await fixture();
    const uploaded = await f.upload(Buffer.from('settings'));
    const a = uploaded.json().attachment;
    const ambiguous = await f.app.inject({
      url: f.path + f.query + '&entryId=unrelated',
      headers: { authorization: 'test' },
    });
    expect(ambiguous.statusCode).toBe(400);
    const original = join(
      f.dataDir,
      'attachments',
      'objects',
      a.id,
      'original',
    );
    writeFileSync(original, 'truncated');
    const list = await f.app.inject({
      url: f.path + f.query,
      headers: { authorization: 'test' },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().attachments[0].available).toBe(false);
    const download = await f.app.inject({
      url: f.path + '/' + a.id + '/original' + f.query,
      headers: { authorization: 'test' },
    });
    expect(download.statusCode).toBe(410);
    const directory = join(f.dataDir, 'attachments', 'objects', a.id);
    renameSync(directory, directory + '-elsewhere');
    symlinkSync(directory + '-elsewhere', directory);
    const linked = await f.app.inject({
      url: f.path + f.query,
      headers: { authorization: 'test' },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().attachments[0].available).toBe(false);
  });
  it('clears upload deadline timers after successful and rejected bodies', async () => {
    const f = await fixture();
    const timer = vi.spyOn(globalThis, 'setTimeout'),
      clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      expect((await f.upload(Buffer.from('settings'))).statusCode).toBe(201);
      expect(
        (await f.upload(Buffer.from('broken'), 'image.png')).statusCode,
      ).toBe(415);
      const deadlines = timer.mock.calls.flatMap((call, index) =>
        call[1] === 60000 ? [timer.mock.results[index]!.value] : [],
      );
      expect(deadlines).toHaveLength(2);
      for (const deadline of deadlines)
        expect(clear).toHaveBeenCalledWith(deadline);
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });
});
