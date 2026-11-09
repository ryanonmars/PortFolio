import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { hashPassword } from './security.js';
import { openDatabase } from '../../../packages/db/src/index.js';
import { emptyBoardDocument } from '../../../packages/shared/src/board.js';

it('can upload attachments immediately after restoring an attachment-free backup and signing in again', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-backup-storage-'));
  const db = openDatabase({ dataDir });
  const password = 'Storage-regression-password-123';
  const token = 'cd'.repeat(32);
  try {
    db.prepare(
      'INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run('admin', 'admin', await hashPassword(password), 1, 1);
    db.prepare(
      'INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)',
    ).run(
      createHash('sha256').update(token).digest('hex'),
      'admin',
      'csrf',
      Date.now() + 900_000,
      Date.now(),
    );
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
      'INSERT INTO boards(id,name,document_json,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run('board', 'Example', JSON.stringify(document), 1, 1);
  } finally {
    db.close();
  }
  const app = await createApp({
    dataDir,
    publicOrigin: 'http://localhost:3088',
    webRoot: join(dataDir, 'no-web'),
  });
  const origin = { host: 'localhost:3088', origin: 'http://localhost:3088' };
  const headers = {
    ...origin,
    cookie: `portfolio_session=${token}`,
    'x-csrf-token': 'csrf',
  };
  try {
    const backup = await app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers,
    });
    expect(backup.statusCode, backup.body).toBe(200);
    const download = await app.inject({
      url: backup.json().backup.downloadUrl,
      headers,
    });
    expect(download.statusCode).toBe(200);
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/restore',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: download.rawPayload,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().restore.attachmentCount).toBe(0);
    const restored = await app.inject({
      method: 'POST',
      url: `/api/v1/backups/restore/${preview.json().restore.id}/confirm`,
      headers,
      payload: { confirm: 'RESTORE' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/settings', headers })).statusCode,
    ).toBe(401);
    const anonymous = await app.inject({
      url: '/api/v1/auth/session',
      headers: origin,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        ...origin,
        cookie: anonymous.cookies
          .map(({ name, value }) => `${name}=${value}`)
          .join('; '),
        'x-csrf-token': anonymous.json().csrfToken,
      },
      payload: { username: 'admin', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const signedIn = {
      ...origin,
      cookie: login.cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join('; '),
      'x-csrf-token': login.json().csrfToken,
    };
    const path = '/api/v1/boards/board/attachments';
    const query = '?ownerType=device&elementId=device';
    const bytes = Buffer.from('New reference after an empty restore');
    const upload = await app.inject({
      method: 'POST',
      url: path + query + '&filename=reference.txt',
      headers: { ...signedIn, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const record = upload.json().attachment;
    expect(record).toMatchObject({
      originalFilename: 'reference.txt',
      sizeBytes: bytes.length,
    });
    expect(
      readFileSync(
        join(dataDir, 'attachments', 'objects', record.id, 'original'),
      ),
    ).toEqual(bytes);
    expect(readdirSync(join(dataDir, 'attachments', 'staging'))).toEqual([]);
    const fetched = await app.inject({
      url: path + '/' + record.id + '/original' + query,
      headers: signedIn,
    });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.rawPayload).toEqual(bytes);
    const check = openDatabase({ dataDir });
    try {
      expect(
        check
          .prepare(
            'SELECT size_bytes,original_sha256 FROM board_attachments WHERE id=?',
          )
          .get(record.id),
      ).toEqual({
        size_bytes: bytes.length,
        original_sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } finally {
      check.close();
    }
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
