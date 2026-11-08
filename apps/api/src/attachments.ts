import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  chmodSync,
  fsyncSync,
  renameSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import {
  attachmentExtensions,
  attachmentRecoveryMs,
  attachmentOwnerSchema,
  attachmentUpdateSchema,
  type AttachmentOwner,
  type AttachmentRecord,
} from '../../../packages/shared/src/attachments.js';
import {
  normalizeNetworkDocument,
  type BoardDocument,
} from '../../../packages/shared/src/board.js';
import { ApiError, validate } from './errors.js';
import { transaction, staleVersion } from './resources.js';

type Row = {
  id: string;
  board_id: string;
  owner_type: string;
  element_id: string;
  entry_id: string;
  original_filename: string;
  display_name: string;
  description: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: number;
  updated_at: number;
  row_version: number;
  orphaned_at: number | null;
  deleted_at: number | null;
};
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function ownerKey(type: string, elementId: string, entryId = '') {
  return JSON.stringify([type, elementId, entryId]);
}
function ownerKeys(document: BoardDocument | null) {
  const keys = new Set<string>();
  if (!document) return keys;
  for (const element of normalizeNetworkDocument(document).elements) {
    if (element.type === 'device') keys.add(ownerKey('device', element.id));
    if (element.type === 'network' && Array.isArray(element.properties.entries))
      for (const entry of element.properties.entries) {
        if (
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          typeof entry.networkEntryId === 'string'
        )
          keys.add(ownerKey('network', element.id, entry.networkEntryId));
      }
  }
  return keys;
}
function owns(document: BoardDocument, owner: AttachmentOwner) {
  return ownerKeys(document).has(
    ownerKey(
      owner.type,
      owner.elementId,
      owner.type === 'network' ? owner.entryId : '',
    ),
  );
}
function unsafeControls(text: string, allowWhitespace: boolean) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code === 127 ||
      (code < 32 &&
        (!allowWhitespace || (code !== 9 && code !== 10 && code !== 13)))
    )
      return true;
  }
  return false;
}
function regular(path: string) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error('Unsafe attachment directory');
}
async function inspect(path: string, filename: string) {
  const bytes = await readFile(path);
  const ext = filename.split('.').pop()!.toLowerCase();
  if (!(attachmentExtensions as readonly string[]).includes(ext))
    fail(415, 'UNSUPPORTED_FILE', 'This file type is not supported');
  const image = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
  if (image) {
    const format = ext === 'jpg' ? 'jpeg' : ext;
    const signatures: Record<string, boolean> = {
      jpeg: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
      png: bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      webp:
        bytes.subarray(0, 4).toString() === 'RIFF' &&
        bytes.subarray(8, 12).toString() === 'WEBP',
    };
    if (!signatures[format])
      fail(415, 'INVALID_FILE', 'Image signature does not match filename');
    const decoder = sharp(bytes, {
      limitInputPixels: 64_000_000,
      failOn: 'warning',
      animated: false,
    }).timeout({ seconds: 15 });
    const temporary = randomUUID();
    const thumb = join(path, '..', temporary + '-thumbnail.webp'),
      preview = join(path, '..', temporary + '-preview.webp');
    try {
      const meta = await decoder.metadata();
      if (
        meta.format !== format ||
        !meta.width ||
        !meta.height ||
        (meta.pages ?? 1) > 1
      )
        fail(415, 'INVALID_FILE', 'The image does not match its filename');
      await decoder
        .clone()
        .rotate()
        .resize(480, 320, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toFile(thumb);
      await decoder
        .clone()
        .rotate()
        .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toFile(preview);
      chmodSync(thumb, 0o600);
      chmodSync(preview, 0o600);
      renameSync(thumb, join(path, '..', 'thumbnail.webp'));
      renameSync(preview, join(path, '..', 'preview.webp'));
      return {
        mime: `image/${format}`,
        width: meta.width,
        height: meta.height,
      };
    } catch {
      return fail(
        415,
        'INVALID_FILE',
        'The image is invalid or exceeds supported limits',
      );
    } finally {
      rmSync(thumb, { force: true });
      rmSync(preview, { force: true });
    }
  }
  if (ext === 'pdf') {
    if (
      !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
    )
      fail(415, 'INVALID_FILE', 'Invalid PDF');
    return { mime: 'application/pdf', width: null, height: null };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(415, 'INVALID_FILE', 'Text files must contain UTF-8 text');
  }
  if (
    unsafeControls(text, true) ||
    /^\s*(?:<!doctype\s+html|<html|<svg|<script)/i.test(text)
  )
    fail(415, 'INVALID_FILE', 'Unsafe text content');
  return { mime: 'text/plain', width: null, height: null };
}
export async function registerAttachments(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
  options: { dataDir: string; maxFileBytes?: number; maxStorageBytes?: number },
) {
  sharp.cache({ memory: 32, files: 0, items: 20 });
  sharp.concurrency(2);
  let closing = false;
  const regenerations = new Map<string, Promise<unknown>>();
  const root = join(options.dataDir, 'attachments');
  privateDirectory(root);
  const objects = join(root, 'objects'),
    staging = join(root, 'staging');
  privateDirectory(objects);
  privateDirectory(staging);
  const maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024,
    maxStorageBytes = options.maxStorageBytes ?? 2 * 1024 * 1024 * 1024;
  const active = new Set<string>();
  const pendingUploads = new Map<
    string,
    { request: FastifyRequest; done: Promise<void>; resolve: () => void }
  >();
  let uploads = 0;
  const directory = (id: string) => {
    if (!uuid.test(id)) fail(404, 'NOT_FOUND', 'Attachment not found');
    const p = join(objects, id);
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      fail(410, 'FILE_MISSING', 'Attachment is unavailable');
    return p;
  };
  const safeOriginal = (r: Row) => {
    try {
      if (!uuid.test(r.id)) return null;
      for (const path of [root, objects, join(objects, r.id)]) {
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
      }
      const info = lstatSync(join(objects, r.id, 'original'));
      return info.isFile() && info.size === r.size_bytes ? info : null;
    } catch {
      return null;
    }
  };
  const record = (r: Row): AttachmentRecord => ({
    id: r.id,
    originalFilename: r.original_filename,
    displayName: r.display_name,
    description: r.description,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rowVersion: r.row_version,
    available: safeOriginal(r) !== null,
  });
  const identity = (request: FastifyRequest) => {
    const query = request.query as Record<string, unknown>;
    const owner = validate(attachmentOwnerSchema, {
      type: query.ownerType,
      elementId: query.elementId,
      ...(Object.hasOwn(query, 'entryId') ? { entryId: query.entryId } : {}),
    });
    const boardId = (request.params as { boardId: string }).boardId;
    const row = db
      .prepare('SELECT document_json FROM boards WHERE id=?')
      .get(boardId) as { document_json: string } | undefined;
    if (!row || !owns(JSON.parse(row.document_json) as BoardDocument, owner))
      fail(404, 'NOT_FOUND', 'Attachment owner not found');
    return {
      boardId,
      owner,
      entryId: owner.type === 'network' ? owner.entryId : '',
    };
  };
  const find = (request: FastifyRequest) => {
    const i = identity(request);
    const id = (request.params as { id: string }).id;
    const row = db
      .prepare(
        'SELECT * FROM board_attachments WHERE id=? AND board_id=? AND owner_type=? AND element_id=? AND entry_id=? AND orphaned_at IS NULL AND deleted_at IS NULL',
      )
      .get(id, i.boardId, i.owner.type, i.owner.elementId, i.entryId) as
      Row | undefined;
    if (!row) fail(404, 'NOT_FOUND', 'Attachment not found');
    return row!;
  };
  const auth = {
    onRequest: async (request: FastifyRequest) => {
      requireAuth(request);
    },
  };
  // Parser hands the raw stream to the authenticated handler; no aggregate buffering.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );
  const base = '/api/v1/boards/:boardId/attachments';
  app.get(base, auth, async (request) => {
    const i = identity(request);
    return {
      attachments: (
        db
          .prepare(
            'SELECT * FROM board_attachments WHERE board_id=? AND owner_type=? AND element_id=? AND entry_id=? AND orphaned_at IS NULL AND deleted_at IS NULL ORDER BY created_at,id',
          )
          .all(i.boardId, i.owner.type, i.owner.elementId, i.entryId) as Row[]
      ).map(record),
      limits: {
        maxFileBytes,
        maxStorageBytes,
        maxFilesPerOwner: 100,
        allowedExtensions: attachmentExtensions,
      },
    };
  });
  app.post(
    base,
    {
      ...auth,
      bodyLimit: maxFileBytes,
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      identity(request);
      if (closing) fail(503, 'SHUTTING_DOWN', 'Server is shutting down');
      if (Number(request.headers['content-length'] ?? 0) > maxFileBytes)
        fail(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
      if (
        request.headers['content-type']?.split(';')[0] !==
        'application/octet-stream'
      )
        fail(415, 'UNSUPPORTED_FILE', 'Upload application/octet-stream');
      const filename = validate(
        z
          .string()
          .min(1)
          .max(240)
          .refine((n) => !/[\\/]/u.test(n) && !unsafeControls(n, false)),
        (request.query as { filename?: string }).filename,
      );
      if (
        !(attachmentExtensions as readonly string[]).includes(
          filename.split('.').pop()!.toLowerCase(),
        )
      )
        fail(415, 'UNSUPPORTED_FILE', 'This file type is not supported');
      if (uploads + regenerations.size >= 2)
        fail(429, 'UPLOAD_BUSY', 'Two uploads are already in progress');
      uploads++;
      const id = randomUUID();
      active.add(id);
      const stage = join(staging, id);
      let resolveUpload!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveUpload = resolve;
      });
      pendingUploads.set(id, { request, done, resolve: resolveUpload });
      let published = false;
      let committed = false;
      let abortTimer: NodeJS.Timeout | undefined;
      try {
        privateDirectory(stage);
        abortTimer = setTimeout(() => request.raw.destroy(), 60_000);
        abortTimer.unref();

        let size = 0;
        const handle = await open(join(stage, 'original'), 'wx', 0o600);
        try {
          for await (const chunk of request.body as Readable) {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as string);
            size += buffer.length;
            if (size > maxFileBytes)
              fail(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
            let offset = 0;
            while (offset < buffer.length) {
              const written = await handle.write(
                buffer,
                offset,
                buffer.length - offset,
              );
              offset += written.bytesWritten;
            }
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (request.raw.aborted || !size)
          fail(400, 'INVALID_FILE', 'The upload is empty or interrupted');
        if (closing) fail(503, 'SHUTTING_DOWN', 'Server is shutting down');
        const details = await inspect(join(stage, 'original'), filename);
        const originalSha256 = createHash('sha256')
          .update(await readFile(join(stage, 'original')))
          .digest('hex');
        const storedBytes = readdirSync(stage).reduce(
          (sum, name) => sum + lstatSync(join(stage, name)).size,
          0,
        );
        for (const name of readdirSync(stage)) {
          const fd = openSync(join(stage, name), constants.O_RDONLY);
          try {
            chmodSync(join(stage, name), 0o600);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        const stageFd = openSync(stage, constants.O_RDONLY);
        try {
          fsyncSync(stageFd);
        } finally {
          closeSync(stageFd);
        }
        const result = transaction(db, () => {
          if (closing) fail(503, 'SHUTTING_DOWN', 'Server is shutting down');
          const i = identity(request);
          const count = db
            .prepare(
              'SELECT count(*) AS n FROM board_attachments WHERE board_id=? AND owner_type=? AND element_id=? AND entry_id=? AND deleted_at IS NULL',
            )
            .get(i.boardId, i.owner.type, i.owner.elementId, i.entryId) as {
            n: number;
          };
          const total = db
            .prepare(
              'SELECT coalesce(sum(stored_bytes),0) AS n FROM board_attachments',
            )
            .get() as { n: number };
          if (count.n >= 100 || total.n + storedBytes > maxStorageBytes)
            fail(409, 'STORAGE_LIMIT', 'Attachment storage limit reached');
          renameSync(stage, join(objects, id));
          published = true;
          const fd = openSync(objects, constants.O_RDONLY);
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          const now = Date.now();
          db.prepare(
            'INSERT INTO board_attachments(id,board_id,owner_type,element_id,entry_id,original_filename,display_name,mime_type,size_bytes,stored_bytes,original_sha256,width,height,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            id,
            i.boardId,
            i.owner.type,
            i.owner.elementId,
            i.entryId,
            filename,
            filename,
            details.mime,
            size,
            storedBytes,
            originalSha256,
            details.width,
            details.height,
            now,
            now,
          );
          return record(
            db
              .prepare('SELECT * FROM board_attachments WHERE id=?')
              .get(id) as Row,
          );
        });
        committed = true;
        return reply.code(201).send({ attachment: result });
      } catch (error) {
        if (published && !committed)
          rmSync(join(objects, id), { recursive: true, force: true });
        throw error;
      } finally {
        clearTimeout(abortTimer);
        try {
          rmSync(stage, { recursive: true, force: true });
        } finally {
          active.delete(id);
          uploads--;
          pendingUploads.get(id)?.resolve();
          pendingUploads.delete(id);
        }
      }
    },
  );
  app.patch(base + '/:id', auth, async (request) => {
    const input = validate(attachmentUpdateSchema, request.body);
    const row = find(request);
    if (row.row_version !== input.rowVersion) staleVersion();
    const changed = db
      .prepare(
        'UPDATE board_attachments SET display_name=?,description=?,updated_at=?,row_version=row_version+1 WHERE id=? AND row_version=? AND deleted_at IS NULL AND orphaned_at IS NULL',
      )
      .run(
        input.displayName,
        input.description,
        Date.now(),
        row.id,
        input.rowVersion,
      );
    if (changed.changes !== 1) staleVersion();
    return {
      attachment: record(
        db
          .prepare('SELECT * FROM board_attachments WHERE id=?')
          .get(row.id) as Row,
      ),
    };
  });
  app.delete(base + '/:id', auth, async (request, reply) => {
    const input = validate(
      z.object({ rowVersion: z.number().int().min(1) }).strict(),
      request.body,
    );
    const row = find(request);
    if (row.row_version !== input.rowVersion) staleVersion();
    const changed = db
      .prepare(
        'UPDATE board_attachments SET deleted_at=?,updated_at=?,row_version=row_version+1 WHERE id=? AND row_version=? AND deleted_at IS NULL AND orphaned_at IS NULL',
      )
      .run(Date.now(), Date.now(), row.id, input.rowVersion);
    if (changed.changes !== 1) staleVersion();
    return reply.code(204).send();
  });
  for (const variant of ['original', 'thumbnail', 'preview'] as const)
    app.get(base + '/:id/' + variant, auth, async (request, reply) => {
      const row = find(request);
      const dir = directory(row.id);
      const original = join(dir, 'original');
      const originalInfo = safeOriginal(row);
      if (!originalInfo)
        fail(410, 'FILE_MISSING', 'The attachment file is missing or damaged');
      const path =
        variant === 'original' ? original : join(dir, variant + '.webp');
      if (variant !== 'original' && !regular(path)) {
        if (!row.mime_type.startsWith('image/'))
          fail(404, 'NOT_FOUND', 'No image preview');
        try {
          let pending = regenerations.get(row.id);
          if (!pending) {
            if (uploads + regenerations.size >= 2)
              fail(429, 'UPLOAD_BUSY', 'Image processing is busy');
            pending = inspect(original, row.original_filename)
              .then(() => {
                for (const name of ['thumbnail.webp', 'preview.webp'])
                  chmodSync(join(dir, name), 0o600);
              })
              .finally(() => regenerations.delete(row.id));
            regenerations.set(row.id, pending);
          }
          await pending;
        } catch (error) {
          if (error instanceof ApiError && error.statusCode === 429)
            throw error;
          fail(410, 'FILE_MISSING', 'Preview is unavailable');
        }
      }
      const expected = (() => {
        try {
          return lstatSync(path);
        } catch {
          return fail(410, 'FILE_MISSING', 'Attachment is unavailable');
        }
      })();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch(() => fail(410, 'FILE_MISSING', 'Attachment is unavailable'));
      const stat = await handle.stat();
      const currentOriginal = safeOriginal(row);
      if (
        !stat.isFile() ||
        stat.ino !== expected.ino ||
        stat.dev !== expected.dev ||
        !currentOriginal ||
        currentOriginal.ino !== originalInfo!.ino ||
        currentOriginal.dev !== originalInfo!.dev
      ) {
        await handle.close();
        fail(410, 'FILE_MISSING', 'Attachment is unavailable');
      }
      reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header(
          'Content-Disposition',
          variant === 'original'
            ? `attachment; filename="attachment${
                row.original_filename.includes('.')
                  ? '.' +
                    row.original_filename
                      .split('.')
                      .pop()!
                      .replace(/[^a-z0-9]/gi, '')
                  : ''
              }"; filename*=UTF-8''${encodeURIComponent(row.original_filename).replace(/'/g, '%27')}`
            : 'inline',
        )
        .type(variant === 'original' ? row.mime_type : 'image/webp');
      return reply.send(handle.createReadStream());
    });
  const reconcile = (boardId: string, document: BoardDocument | null) => {
    const keys = ownerKeys(document);
    const rows = db
      .prepare(
        'SELECT * FROM board_attachments WHERE board_id=? AND deleted_at IS NULL',
      )
      .all(boardId) as Row[];
    const update = db.prepare(
      'UPDATE board_attachments SET orphaned_at=? WHERE id=?',
    );
    const now = Date.now();
    for (const row of rows) {
      const present = keys.has(
        ownerKey(row.owner_type, row.element_id, row.entry_id),
      );
      const next = present ? null : (row.orphaned_at ?? now);
      if (next !== row.orphaned_at) update.run(next, row.id);
    }
  };
  const cleanup = () => {
    const removed: string[] = [];
    transaction(db, () => {
      db.prepare(
        'DELETE FROM attachment_backup_leases WHERE expires_at<=?',
      ).run(Date.now());
      if (
        db
          .prepare(
            'SELECT id FROM attachment_backup_leases WHERE expires_at>? LIMIT 1',
          )
          .get(Date.now())
      )
        return;
      const rows = db
        .prepare(
          'SELECT * FROM board_attachments WHERE coalesce(deleted_at,orphaned_at)>0 AND coalesce(deleted_at,orphaned_at)<?',
        )
        .all(Date.now() - attachmentRecoveryMs) as Row[];
      for (const row of rows) {
        const b = db
          .prepare('SELECT document_json FROM boards WHERE id=?')
          .get(row.board_id) as { document_json: string } | undefined;
        const owner: AttachmentOwner =
          row.owner_type === 'device'
            ? { type: 'device', elementId: row.element_id }
            : {
                type: 'network',
                elementId: row.element_id,
                entryId: row.entry_id,
              };
        if (
          !row.deleted_at &&
          b &&
          owns(JSON.parse(b.document_json) as BoardDocument, owner)
        )
          continue;
        removed.push(directory(row.id));
        db.prepare('DELETE FROM board_attachments WHERE id=?').run(row.id);
      }
      for (const parent of [staging, objects])
        for (const id of readdirSync(parent)) {
          if (!uuid.test(id) || active.has(id)) continue;
          const p = join(parent, id);
          const info = lstatSync(p);
          if (info.isSymbolicLink()) continue;
          if (info.mtimeMs > Date.now() - 24 * 60 * 60 * 1000) continue;
          if (
            parent === objects &&
            db.prepare('SELECT id FROM board_attachments WHERE id=?').get(id)
          )
            continue;
          removed.push(p);
        }
    });
    // Metadata commits first: a crash leaves only safely collectible unindexed bytes.
    for (const path of removed) rmSync(path, { recursive: true, force: true });
  };
  for (const row of db
    .prepare('SELECT DISTINCT board_id FROM board_attachments')
    .all() as { board_id: string }[]) {
    const board = db
      .prepare('SELECT document_json FROM boards WHERE id=?')
      .get(row.board_id) as { document_json: string } | undefined;
    reconcile(
      row.board_id,
      board ? (JSON.parse(board.document_json) as BoardDocument) : null,
    );
  }
  cleanup();
  const timer = setInterval(
    () => {
      try {
        cleanup();
      } catch (error) {
        app.log.error(error, 'Attachment cleanup failed');
      }
    },
    60 * 60 * 1000,
  );
  timer.unref();
  app.addHook('preClose', async () => {
    closing = true;
    for (const pending of pendingUploads.values())
      pending.request.raw.destroy();
  });
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(timer);
    await Promise.allSettled([
      ...regenerations.values(),
      ...Array.from(pendingUploads.values(), (pending) => pending.done),
    ]);
  });
  return { reconcile };
}
