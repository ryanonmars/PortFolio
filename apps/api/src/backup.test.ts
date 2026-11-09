import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { openDatabase } from '../../../packages/db/src/index.js';
import { validatePortableBackup } from '../../../packages/db/src/portable-backup.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
async function fixture(maxBytes?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-browser-backup-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = openDatabase({ dataDir });
  db.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)',
  ).run('admin', 'admin', 'unused-hash', Date.now(), Date.now());
  const token = 'ab'.repeat(32);
  db.prepare(
    'INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)',
  ).run(
    createHash('sha256').update(token).digest('hex'),
    'admin',
    'csrf',
    Date.now() + 15 * 60_000,
    Date.now(),
  );
  db.close();
  const app = await createApp({
    dataDir,
    backupMaxBytes: maxBytes,
    publicOrigin: 'http://localhost:3088',
    webRoot: join(dataDir, 'no-web'),
  });
  cleanup.push(() => app.close());
  const headers = {
    host: 'localhost:3088',
    origin: 'http://localhost:3088',
    cookie: `portfolio_session=${token}`,
    'x-csrf-token': 'csrf',
  };
  return { app, dataDir, headers };
}
it('exposes authenticated settings metadata and denies unauthenticated backup access', async () => {
  const f = await fixture();
  const settings = await f.app.inject({
    url: '/api/v1/settings',
    headers: f.headers,
  });
  expect(settings.statusCode).toBe(200);
  expect(settings.json().account.username).toBe('admin');
  expect(settings.json().application.version).toBe(
    JSON.parse(readFileSync('package.json', 'utf8')).version,
  );
  expect(
    (
      await f.app.inject({
        url: '/api/v1/settings',
        headers: { host: 'localhost:3088' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: { host: 'localhost:3088', origin: 'http://localhost:3088' },
      })
    ).statusCode,
  ).toBe(403);
});
it('creates a complete backup, previews it, activates and requires reauthentication', async () => {
  const f = await fixture();
  const backup = await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups',
    headers: f.headers,
  });
  expect(backup.statusCode, backup.body).toBe(200);
  const download = await f.app.inject({
    url: backup.json().backup.downloadUrl,
    headers: f.headers,
  });
  expect(download.statusCode).toBe(200);
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups/restore',
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: download.rawPayload,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const id = preview.json().restore.id;
  const confirm = await f.app.inject({
    method: 'POST',
    url: `/api/v1/backups/restore/${id}/confirm`,
    headers: f.headers,
    payload: { confirm: 'RESTORE' },
  });
  expect(confirm.statusCode, confirm.body).toBe(200);
  expect(confirm.json()).toMatchObject({
    restored: true,
    reauthenticationRequired: true,
  });
  expect(
    (await f.app.inject({ url: '/api/v1/settings', headers: f.headers }))
      .statusCode,
  ).toBe(401);
  const db = openDatabase({ dataDir: f.dataDir });
  expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0,
  });
  db.close();
});

async function bytes(f: Awaited<ReturnType<typeof fixture>>) {
  const backup = await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups',
    headers: f.headers,
  });
  expect(backup.statusCode, backup.body).toBe(200);
  const download = await f.app.inject({
    url: backup.json().backup.downloadUrl,
    headers: f.headers,
  });
  expect(download.statusCode).toBe(200);
  expect(download.headers['content-disposition']).toContain(
    backup.json().backup.filename,
  );
  return download.rawPayload;
}
async function preview(
  f: Awaited<ReturnType<typeof fixture>>,
  payload: Buffer,
) {
  const result = await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups/restore',
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload,
  });
  expect(result.statusCode, result.body).toBe(200);
  return result.json().restore;
}
it('rejects corrupt and oversized uploads without leaving staged data', async () => {
  const f = await fixture(1024);
  for (const [payload, status] of [
    [Buffer.from('not zip'), 400],
    [Buffer.alloc(1025), 413],
  ] as const) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/backups/restore',
      headers: { ...f.headers, 'content-type': 'application/octet-stream' },
      payload,
    });
    expect(response.statusCode, response.body).toBe(status);
    expect(readdirSync(join(f.dataDir, '.browser-backups'))).toEqual([]);
  }
  expect(
    (await f.app.inject({ url: '/api/v1/settings', headers: f.headers }))
      .statusCode,
  ).toBe(200);
});
it('requires cookie authentication and CSRF before accepting upload bytes', async () => {
  const f = await fixture();
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups/restore',
    headers: {
      host: 'localhost:3088',
      origin: 'http://localhost:3088',
      authorization: 'Bearer pf_' + 'ab'.repeat(32),
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from('untrusted'),
  });
  expect(response.statusCode).toBe(403);
  expect(readdirSync(join(f.dataDir, '.browser-backups'))).toEqual([]);
  const noAuth = await f.app.inject({
    url: '/api/v1/backups/recovery/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    headers: {
      host: 'localhost:3088',
      authorization: 'Bearer pf_' + 'ab'.repeat(32),
    },
  });
  expect(noAuth.statusCode).toBe(401);
});
it('bounds pending downloads and allows only one preparation operation', async () => {
  const f = await fixture();
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: f.headers,
      }),
    ),
  );
  expect(responses.map((item) => item.statusCode).sort()).toEqual([200, 409]);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  const prepared = responses
    .find((item) => item.statusCode === 200)!
    .json().backup;
  expect(
    (await f.app.inject({ url: prepared.downloadUrl, headers: f.headers }))
      .statusCode,
  ).toBe(200);
  expect(
    (await f.app.inject({ url: prepared.downloadUrl, headers: f.headers }))
      .statusCode,
  ).toBe(404);
});
it('binds previews to the issuing session and requires explicit confirmation', async () => {
  const f = await fixture();
  const p = await preview(f, await bytes(f));
  const db = openDatabase({ dataDir: f.dataDir });
  const token = 'cd'.repeat(32);
  db.prepare(
    'INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)',
  ).run(
    createHash('sha256').update(token).digest('hex'),
    'admin',
    'other-csrf',
    Date.now() + 60_000,
    Date.now(),
  );
  db.close();
  const alternate = {
    ...f.headers,
    cookie: `portfolio_session=${token}`,
    'x-csrf-token': 'other-csrf',
  };
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/backups/restore/${p.id}/confirm`,
        headers: alternate,
        payload: { confirm: 'RESTORE' },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/backups/restore/${p.id}/confirm`,
        headers: f.headers,
        payload: { confirm: 'yes' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'DELETE',
        url: `/api/v1/backups/restore/${p.id}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/backups/restore/${p.id}/confirm`,
        headers: f.headers,
        payload: { confirm: 'RESTORE' },
      })
    ).statusCode,
  ).toBe(404);
  expect(readdirSync(join(f.dataDir, '.browser-backups'))).toEqual([]);
});
it('expires previews and removes them on the next operation', async () => {
  const f = await fixture();
  const p = await preview(f, await bytes(f));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(p.expiresAt + 1);
  // Keep authentication valid while expiring just the private preview capability.
  const db = openDatabase({ dataDir: f.dataDir });
  db.prepare('UPDATE sessions SET expires_at=?').run(Date.now() + 60_000);
  db.close();
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/backups/restore/${p.id}/confirm`,
        headers: f.headers,
        payload: { confirm: 'RESTORE' },
      })
    ).statusCode,
  ).toBe(404);
  await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups/restore',
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('invalid'),
  });
  expect(readdirSync(join(f.dataDir, '.browser-backups'))).toEqual([]);
  vi.useRealTimers();
});
it('does not activate if the current application cannot produce a verified recovery', async () => {
  const f = await fixture();
  const p = await preview(f, await bytes(f));
  const db = openDatabase({ dataDir: f.dataDir });
  db.prepare(
    `INSERT INTO board_attachments(id,board_id,owner_type,element_id,original_filename,display_name,mime_type,size_bytes,stored_bytes,original_sha256,created_at,updated_at) VALUES(?,?,'device',?,'a.txt','a','text/plain',1,1,?,?,?)`,
  ).run(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'missing-board',
    'missing-device',
    createHash('sha256').update('a').digest('hex'),
    Date.now(),
    Date.now(),
  );
  db.close();
  const result = await f.app.inject({
    method: 'POST',
    url: `/api/v1/backups/restore/${p.id}/confirm`,
    headers: f.headers,
    payload: { confirm: 'RESTORE' },
  });
  expect(result.statusCode).toBe(500);
  expect(existsSync(join(f.dataDir, '.activation.json'))).toBe(false);
  expect(
    (await f.app.inject({ url: '/api/v1/settings', headers: f.headers }))
      .statusCode,
  ).toBe(200);
  const current = openDatabase({ dataDir: f.dataDir });
  expect(
    current.prepare('SELECT count(*) AS n FROM board_attachments').get(),
  ).toEqual({ n: 1 });
  current.close();
});

it('restores retained attachment bytes and keeps a verified recovery of replaced data', async () => {
  const f = await fixture();
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const object = join(f.dataDir, 'attachments', 'objects', id);
  mkdirSync(object, { recursive: true });
  writeFileSync(join(object, 'original'), 'old file');
  writeFileSync(join(object, 'thumbnail.webp'), 'old derivative');
  const db = openDatabase({ dataDir: f.dataDir });
  db.prepare(
    `INSERT INTO board_attachments(id,board_id,owner_type,element_id,original_filename,display_name,mime_type,size_bytes,stored_bytes,original_sha256,created_at,updated_at,deleted_at) VALUES(?,?,'device',?,'a.txt','a','text/plain',8,22,?,?,?,?)`,
  ).run(
    id,
    'deleted-board',
    'deleted-device',
    createHash('sha256').update('old file').digest('hex'),
    Date.now(),
    Date.now(),
    Date.now(),
  );
  const archive = await bytes(f);
  db.prepare('UPDATE users SET username=?').run('replacement');
  writeFileSync(join(object, 'original'), 'new file');
  db.prepare('UPDATE board_attachments SET original_sha256=?').run(
    createHash('sha256').update('new file').digest('hex'),
  );
  db.close();
  const p = await preview(f, archive);
  expect(p).toMatchObject({ attachmentCount: 1, attachmentBytes: 22 });
  const result = await f.app.inject({
    method: 'POST',
    url: `/api/v1/backups/restore/${p.id}/confirm`,
    headers: f.headers,
    payload: { confirm: 'RESTORE' },
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(readFileSync(join(object, 'original'), 'utf8')).toBe('old file');
  expect(readFileSync(join(object, 'thumbnail.webp'), 'utf8')).toBe(
    'old derivative',
  );
  const recovery = join(
    f.dataDir,
    'backups',
    'recovery',
    result.json().recoveryId + '.zip',
  );
  const ready = join(f.dataDir, 'verify-recovery');
  await validatePortableBackup(recovery, ready);
  expect(
    readFileSync(join(ready, 'attachments', 'objects', id, 'original'), 'utf8'),
  ).toBe('new file');
  const recovered = openDatabase({ dataDir: ready });
  expect(recovered.prepare('SELECT username FROM users').get()).toEqual({
    username: 'replacement',
  });
  recovered.close();
  await f.app.close();
  const restarted = await createApp({
    dataDir: f.dataDir,
    publicOrigin: 'http://localhost:3088',
    webRoot: join(f.dataDir, 'no-web'),
  });
  cleanup.push(() => restarted.close());
  expect((await restarted.inject('/healthz')).statusCode).toBe(200);
});

it('cleans a disconnected streaming upload and releases the operation mutex', async () => {
  const f = await fixture();
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const address = f.app.server.address() as { port: number };
  let ended!: () => void;
  const closed = new Promise<void>((resolve) => {
    ended = resolve;
  });
  f.app.server.once('request', (incoming) => incoming.once('close', ended));
  const request = httpRequest({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/v1/backups/restore',
    method: 'POST',
    headers: {
      ...f.headers,
      'content-type': 'application/octet-stream',
      'content-length': '1000',
    },
  });
  request.on('error', () => {});
  request.write('PK');
  await vi.waitFor(() =>
    expect(readdirSync(join(f.dataDir, '.browser-backups')).length).toBe(1),
  );
  request.destroy();
  await closed;
  await vi.waitFor(() =>
    expect(readdirSync(join(f.dataDir, '.browser-backups'))).toEqual([]),
  );
  const backup = await f.app.inject({
    method: 'POST',
    url: '/api/v1/backups',
    headers: f.headers,
  });
  expect(backup.statusCode, backup.body).toBe(200);
});

it('aborts preparation on storage exhaustion without changing current data', async () => {
  const f = await fixture();
  const spy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
    throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: f.headers,
    });
    expect(response.statusCode, response.body).toBe(507);
    expect(readdirSync(join(f.dataDir, '.browser-backups'))).toEqual([]);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(
    (await f.app.inject({ url: '/api/v1/settings', headers: f.headers }))
      .statusCode,
  ).toBe(200);
});

it.each([false, true])(
  'handles activation failure with rollback failure=%s and recovers after restart',
  async (failRollback) => {
    const f = await fixture();
    const p = await preview(f, await bytes(f));
    const db = openDatabase({ dataDir: f.dataDir });
    db.prepare('UPDATE users SET username=?').run('current-account');
    db.close();
    const originalRename = fs.renameSync;
    const spy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        const path = String(source);
        if (
          path ===
            join(f.dataDir, '.browser-backups', p.id, 'ready', 'app.sqlite') ||
          (failRollback &&
            path.includes('.activation-rollback-') &&
            path.endsWith('/app.sqlite'))
        )
          throw Object.assign(new Error('simulated rename failure'), {
            code: 'EIO',
          });
        originalRename(source, destination);
      });
    syncBuiltinESMExports();
    try {
      const result = await f.app.inject({
        method: 'POST',
        url: `/api/v1/backups/restore/${p.id}/confirm`,
        headers: f.headers,
        payload: { confirm: 'RESTORE' },
      });
      expect(result.statusCode, result.body).toBe(500);
      const settings = await f.app.inject({
        url: '/api/v1/settings',
        headers: f.headers,
      });
      expect(settings.statusCode).toBe(failRollback ? 503 : 200);
      if (!failRollback)
        expect(settings.json().account.username).toBe('current-account');
      expect(existsSync(join(f.dataDir, '.activation.json'))).toBe(
        failRollback,
      );
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    await f.app.close();
    const restarted = await createApp({
      dataDir: f.dataDir,
      publicOrigin: 'http://localhost:3088',
      webRoot: join(f.dataDir, 'no-web'),
    });
    cleanup.push(() => restarted.close());
    const settings = await restarted.inject({
      url: '/api/v1/settings',
      headers: f.headers,
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json().account.username).toBe('current-account');
    expect(settings.json().recoveries).toHaveLength(1);
  },
);

// Four full recovery/rollback cycles spawn multiple isolated verification workers.
it('retains at most three verified recovery archives even when activation repeatedly fails', async () => {
  const f = await fixture();
  const archive = await bytes(f);
  const originalRename = fs.renameSync;
  const spy = vi
    .spyOn(fs, 'renameSync')
    .mockImplementation((source, destination) => {
      if (
        String(source).includes('.browser-backups') &&
        String(source).endsWith('/ready/app.sqlite')
      )
        throw new Error('simulated install failure');
      originalRename(source, destination);
    });
  syncBuiltinESMExports();
  try {
    for (let index = 0; index < 4; index++) {
      const p = await preview(f, archive);
      const result = await f.app.inject({
        method: 'POST',
        url: `/api/v1/backups/restore/${p.id}/confirm`,
        headers: f.headers,
        payload: { confirm: 'RESTORE' },
      });
      expect(result.statusCode, result.body).toBe(500);
      const settings = await f.app.inject({
        url: '/api/v1/settings',
        headers: f.headers,
      });
      expect(settings.json().recoveries).toHaveLength(Math.min(3, index + 1));
    }
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(readdirSync(join(f.dataDir, 'backups', 'recovery'))).toHaveLength(3);
}, 30_000);

it('reports successful activation even if disposable preview cleanup must be retried at startup', async () => {
  const f = await fixture();
  const p = await preview(f, await bytes(f));
  const originalRemove = fs.rmSync;
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path) === join(f.dataDir, '.browser-backups', p.id))
      throw new Error('simulated scratch cleanup failure');
    originalRemove(path, options);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.app.inject({
      method: 'POST',
      url: `/api/v1/backups/restore/${p.id}/confirm`,
      headers: f.headers,
      payload: { confirm: 'RESTORE' },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().restored).toBe(true);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});
