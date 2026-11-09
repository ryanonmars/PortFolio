import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
  constants,
  statfsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  PORTABLE_BACKUP_MAX_BYTES,
  type PortableBackupSummary,
} from '../../../packages/db/src/portable-backup.js';
import { createBackupJob, validateBackupJob } from './backup-jobs.js';
import { activatePreparedApplication } from '../../../packages/db/src/activation.js';
import type { DatabaseRuntime } from './database-runtime.js';
import type { Maintenance } from './maintenance.js';
import type { User } from './security.js';
import { ApiError } from './errors.js';

const ttl = 15 * 60_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface Artifact {
  id: string;
  directory: string;
  path: string;
  owner: string;
  expiresAt: number;
  downloading?: boolean;
  filename?: string;
}
interface Preview extends Artifact {
  ready: string;
  summary: PortableBackupSummary;
}
function privateDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Unsafe backup storage directory');
}
function flush(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function storageError(error: unknown): unknown {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOSPC'
    ? new ApiError(
        507,
        'INSUFFICIENT_STORAGE',
        'There is not enough free storage to prepare a verified backup',
      )
    : error;
}

export function registerBackups(
  app: FastifyInstance,
  runtime: DatabaseRuntime,
  requireAuth: (request: FastifyRequest) => User,
  maintenance: Maintenance,
  attachments: { quiesce(): Promise<void>; prepare(): void; resume(): void },
  options: { dataDir: string; maxBytes?: number },
) {
  const maxBytes = options.maxBytes ?? PORTABLE_BACKUP_MAX_BYTES;
  const dataDir = resolve(options.dataDir);
  const root = join(dataDir, '.browser-backups');
  const recoveryRoot = join(dataDir, 'backups', 'recovery');
  privateDirectory(root);
  for (const name of readdirSync(root))
    if (uuid.test(name)) {
      const path = join(root, name);
      if (!lstatSync(path).isSymbolicLink())
        rmSync(path, { recursive: true, force: true });
    }
  const artifacts = new Map<string, Artifact>();
  const previews = new Map<string, Preview>();
  const operations = new Set<AbortController>();
  let closing = false;
  const packageInfo = JSON.parse(
    readFileSync(resolve('package.json'), 'utf8'),
  ) as { version: string };
  const identity = (request: FastifyRequest) => {
    const user = requireAuth(request);
    return createHash('sha256')
      .update(user.id + ':' + (request.cookies.portfolio_session ?? ''))
      .digest('hex');
  };
  const space = (bytes: number) => {
    const stat = statfsSync(dataDir);
    if (stat.bavail * stat.bsize < bytes + 16 * 1024 * 1024)
      throw new ApiError(
        507,
        'INSUFFICIENT_STORAGE',
        'There is not enough free storage to prepare a verified backup',
      );
  };
  const applicationBytes = () => {
    const row = runtime.real
      .prepare(
        'SELECT coalesce(sum(stored_bytes),0) AS bytes FROM board_attachments',
      )
      .get() as { bytes: number };
    return (
      lstatSync(join(dataDir, 'app.sqlite')).size +
      row.bytes +
      (existsSync(join(dataDir, 'app.sqlite-wal'))
        ? lstatSync(join(dataDir, 'app.sqlite-wal')).size
        : 0)
    );
  };
  const cleanup = () => {
    for (const collection of [artifacts, previews])
      for (const [id, item] of collection) {
        if (item.expiresAt <= Date.now() && !item.downloading) {
          collection.delete(id);
          rmSync(item.directory, { recursive: true, force: true });
        }
      }
  };
  const begin = (request: FastifyRequest, reply: FastifyReply) => {
    const owner = identity(request);
    if (closing)
      throw new ApiError(503, 'SHUTTING_DOWN', 'Server is shutting down');
    const release = maintenance.acquire();
    try {
      cleanup();
      const id = randomUUID(),
        directory = join(root, id);
      privateDirectory(directory);
      const controller = new AbortController();
      operations.add(controller);
      const disconnect = () => controller.abort();
      const responseClosed = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      request.raw.once('aborted', disconnect);
      reply.raw.once('close', responseClosed);
      return {
        id,
        directory,
        owner,
        signal: controller.signal,
        finish() {
          request.raw.removeListener('aborted', disconnect);
          reply.raw.removeListener('close', responseClosed);
          operations.delete(controller);
          release();
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  };
  const recoveries = () => {
    if (!existsSync(recoveryRoot)) return [];
    privateDirectory(join(dataDir, 'backups'));
    privateDirectory(recoveryRoot);
    return readdirSync(recoveryRoot)
      .filter((name) => name.endsWith('.zip') && uuid.test(name.slice(0, -4)))
      .flatMap((name) => {
        const stat = lstatSync(join(recoveryRoot, name));
        return stat.isFile() && !stat.isSymbolicLink()
          ? [
              {
                id: name.slice(0, -4),
                createdAt: stat.mtime.toISOString(),
                bytes: stat.size,
                downloadUrl: `/api/v1/backups/recovery/${name.slice(0, -4)}`,
              },
            ]
          : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const auth = async (request: FastifyRequest) => {
    requireAuth(request);
  };
  if (!app.hasContentTypeParser('application/octet-stream'))
    app.addContentTypeParser(
      'application/octet-stream',
      (_request, payload, done) => done(null, payload),
    );
  app.get('/api/v1/settings', { onRequest: auth }, async (request) => {
    const user = requireAuth(request);
    const migration = runtime.real
      .prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')
      .get() as { name: string };
    return {
      application: {
        name: 'PortFolio',
        version: packageInfo.version,
        databaseSchemaVersion: migration.name,
      },
      account: { username: user.username },
      deployment: {
        runtime: `Node.js ${process.versions.node}`,
        storage: 'SQLite and local attachment storage',
      },
      backup: {
        maxUploadBytes: maxBytes,
        recoveryPolicy:
          'The latest three verified pre-restore recovery backups are retained on this server.',
      },
      recoveries: recoveries(),
    };
  });
  app.post('/api/v1/backups', { onRequest: auth }, async (request, reply) => {
    const operation = begin(request, reply);
    const path = join(operation.directory, 'backup.zip');
    try {
      if (artifacts.size)
        throw new ApiError(
          409,
          'DOWNLOAD_PENDING',
          'Download the prepared backup before creating another',
        );
      space(applicationBytes() * 3);
      await createBackupJob(dataDir, path, {
        instanceOwner: runtime.owner,
        maxBytes,
        signal: operation.signal,
      });
      const filename = `portfolio-backup-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.zip`;
      artifacts.set(operation.id, {
        ...operation,
        path,
        filename,
        expiresAt: Date.now() + ttl,
      });
      return {
        backup: {
          id: operation.id,
          filename,
          downloadUrl: `/api/v1/backups/${operation.id}/download`,
        },
      };
    } catch (error) {
      rmSync(operation.directory, { recursive: true, force: true });
      throw storageError(error);
    } finally {
      operation.finish();
      reply.header('Cache-Control', 'no-store');
    }
  });
  app.get<{ Params: { id: string } }>(
    '/api/v1/backups/:id/download',
    { onRequest: auth },
    async (request, reply) => {
      const owner = identity(request),
        artifact = artifacts.get(request.params.id);
      if (
        !artifact ||
        artifact.owner !== owner ||
        artifact.expiresAt <= Date.now() ||
        artifact.downloading
      )
        throw new ApiError(404, 'NOT_FOUND', 'Backup download is unavailable');
      const release = maintenance.acquire();
      artifact.downloading = true;
      const stream = createReadStream(artifact.path);
      let discarded = false;
      const discard = () => {
        if (discarded) return;
        discarded = true;
        stream.destroy();
        artifacts.delete(artifact.id);
        try {
          rmSync(artifact.directory, { recursive: true, force: true });
        } catch (error) {
          request.log.error(error, 'Backup download cleanup failed');
        } finally {
          release();
        }
      };
      reply.raw.once('close', discard);
      reply.raw.once('finish', discard);
      return reply
        .header(
          'Content-Disposition',
          `attachment; filename="${artifact.filename}"`,
        )
        .type('application/zip')
        .send(stream);
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/backups/recovery/:id',
    { onRequest: auth },
    async (request, reply) => {
      const record = recoveries().find((item) => item.id === request.params.id);
      if (!record)
        throw new ApiError(404, 'NOT_FOUND', 'Recovery backup not found');
      const release = maintenance.acquire();
      const stream = createReadStream(join(recoveryRoot, record.id + '.zip'));
      const done = () => {
        stream.destroy();
        release();
      };
      reply.raw.once('finish', done);
      reply.raw.once('close', done);
      return reply
        .header(
          'Content-Disposition',
          'attachment; filename="portfolio-recovery.zip"',
        )
        .type('application/zip')
        .send(stream);
    },
  );
  app.post(
    '/api/v1/backups/restore',
    { onRequest: auth, bodyLimit: maxBytes },
    async (request, reply) => {
      if (
        request.headers['content-type']?.split(';')[0] !==
        'application/octet-stream'
      )
        throw new ApiError(415, 'INVALID_BACKUP', 'Upload a ZIP backup');
      const operation = begin(request, reply);
      const path = join(operation.directory, 'upload.zip'),
        ready = join(operation.directory, 'ready');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (previews.size)
          throw new ApiError(
            409,
            'RESTORE_PENDING',
            'Cancel the existing restore preview before uploading another backup',
          );
        const length = request.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes))
          throw new ApiError(
            413,
            'BACKUP_TOO_LARGE',
            'Backup exceeds the upload limit',
          );
        space(length ? Number(length) * 4 : 16 * 1024 * 1024);
        const input = request.body as Readable;
        if (!input || typeof input.pipe !== 'function')
          throw new ApiError(400, 'INVALID_BACKUP', 'Upload a ZIP backup');
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(
              bytes > maxBytes
                ? new ApiError(
                    413,
                    'BACKUP_TOO_LARGE',
                    'Backup exceeds the upload limit',
                  )
                : null,
              chunk,
            );
          },
        });
        timer = setTimeout(
          () =>
            input.destroy(
              new ApiError(408, 'UPLOAD_TIMEOUT', 'Backup upload timed out'),
            ),
          15 * 60_000,
        );
        await pipeline(
          input,
          bounded,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          { signal: operation.signal },
        );
        clearTimeout(timer);
        timer = undefined;
        const summary = await validateBackupJob(path, ready, {
          maxBytes,
          signal: operation.signal,
        });
        const expiresAt = Date.now() + ttl;
        previews.set(operation.id, {
          ...operation,
          path,
          ready,
          summary,
          expiresAt,
        });
        const {
          createdAt,
          applicationVersion,
          databaseSchemaVersion,
          boardCount,
          attachmentCount,
          attachmentBytes,
          compatibility,
        } = summary;
        return {
          restore: {
            id: operation.id,
            createdAt,
            applicationVersion,
            databaseSchemaVersion,
            boardCount,
            attachmentCount,
            attachmentBytes,
            compatibility,
            expiresAt,
          },
        };
      } catch (error) {
        rmSync(operation.directory, { recursive: true, force: true });
        const safeError = storageError(error);
        if (safeError instanceof ApiError) throw safeError;
        request.log.info('Backup validation failed');
        throw new ApiError(
          400,
          'INVALID_BACKUP',
          'The backup could not be verified. Select a complete compatible PortFolio backup',
        );
      } finally {
        if (timer) clearTimeout(timer);
        operation.finish();
      }
    },
  );
  const previewFor = (request: FastifyRequest<{ Params: { id: string } }>) => {
    const owner = identity(request),
      preview = previews.get(request.params.id);
    if (!preview || preview.owner !== owner || preview.expiresAt <= Date.now())
      throw new ApiError(
        404,
        'NOT_FOUND',
        'Restore preview has expired or is unavailable',
      );
    return preview;
  };
  app.delete<{ Params: { id: string } }>(
    '/api/v1/backups/restore/:id',
    { onRequest: auth },
    async (request) => {
      const preview = previewFor(request),
        release = maintenance.acquire();
      try {
        previews.delete(preview.id);
        rmSync(preview.directory, { recursive: true, force: true });
        return { cancelled: true };
      } finally {
        release();
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/backups/restore/:id/confirm',
    { onRequest: auth },
    async (request, reply) => {
      const preview = previewFor(request);
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        (request.body as { confirm?: unknown }).confirm !== 'RESTORE'
      )
        throw new ApiError(
          400,
          'CONFIRMATION_REQUIRED',
          'Type RESTORE to confirm',
        );
      const release = maintenance.acquire();
      let closed = false,
        usable = true;
      const controller = new AbortController();
      operations.add(controller);
      previews.delete(preview.id);
      maintenance.enter();
      try {
        await maintenance.drain(request);
        await attachments.quiesce();
        space(applicationBytes() * 5);
        const recoveryId = randomUUID(),
          recoveryStage = join(preview.directory, 'recovery.zip');
        await createBackupJob(dataDir, recoveryStage, {
          instanceOwner: runtime.owner,
          maxBytes,
          signal: controller.signal,
        });
        await validateBackupJob(
          recoveryStage,
          join(preview.directory, 'recovery-verified'),
          { maxBytes, signal: controller.signal },
        );
        controller.signal.throwIfAborted();
        flush(recoveryStage);
        privateDirectory(join(dataDir, 'backups'));
        privateDirectory(recoveryRoot);
        renameSync(recoveryStage, join(recoveryRoot, recoveryId + '.zip'));
        flush(recoveryRoot);
        flush(join(dataDir, 'backups'));
        flush(dataDir);
        for (const record of recoveries()
          .filter((record) => record.id !== recoveryId)
          .slice(2))
          rmSync(join(recoveryRoot, record.id + '.zip'));
        flush(recoveryRoot);
        runtime.close();
        closed = true;
        try {
          await activatePreparedApplication(
            dataDir,
            preview.ready,
            async () => {
              runtime.open();
              runtime.real.prepare('SELECT 1').get();
              attachments.prepare();
              runtime.real.exec('DELETE FROM sessions');
            },
            {
              beforeRollback: () => runtime.close(),
              onCleanupError: (error) =>
                request.log.error(
                  error,
                  'Committed restore cleanup is deferred until startup',
                ),
            },
          );
          closed = false;
        } catch (error) {
          if (existsSync(join(dataDir, '.activation.json'))) {
            usable = false;
            throw error;
          }
          runtime.close();
          runtime.open();
          closed = false;
          throw error;
        }
        for (const artifact of artifacts.values()) {
          try {
            rmSync(artifact.directory, { recursive: true, force: true });
          } catch (error) {
            request.log.error(
              error,
              'Restored backup artifact cleanup is deferred until startup',
            );
          }
        }
        artifacts.clear();
        reply.clearCookie('portfolio_session', { path: '/' });
        return { restored: true, reauthenticationRequired: true, recoveryId };
      } catch (error) {
        throw storageError(error);
      } finally {
        operations.delete(controller);
        if (closed) usable = false;
        if (usable) {
          attachments.resume();
          maintenance.resume();
        }
        release();
        if (usable) {
          try {
            rmSync(preview.directory, { recursive: true, force: true });
          } catch (error) {
            request.log.error(
              error,
              'Restore preview cleanup is deferred until startup',
            );
          }
        }
      }
    },
  );
  const timer = setInterval(() => {
    try {
      cleanup();
    } catch (error) {
      app.log.error(error, 'Backup staging cleanup failed');
    }
  }, 60_000);
  timer.unref();
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(timer);
    for (const controller of operations) controller.abort();
  });
  app.addHook('onClose', async () => {
    if (!maintenance.active) {
      for (const item of [...artifacts.values(), ...previews.values()])
        rmSync(item.directory, { recursive: true, force: true });
    }
  });
}
