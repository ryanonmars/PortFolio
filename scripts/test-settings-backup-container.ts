/** Isolated Docker backup/restore matrix. Never mounts an existing application directory. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type APIRequestContext } from '@playwright/test';
import { emptyBoardDocument } from '../packages/shared/src/board.js';
import { attachmentPath } from '../packages/shared/src/attachments.js';
import sharp from 'sharp';

const image =
  process.env.PORTFOLIO_TEST_IMAGE ?? 'portfolio:settings-backup-local';
const prefix = `portfolio-backup-test-${randomUUID().slice(0, 8)}`;
const containers = new Set<string>();
const volumes = new Set<string>();
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
const mount = (volume: string) =>
  `type=volume,source=${volume},target=/data,volume-nocopy`;
function stop(name: string) {
  docker('stop', '--time', '10', name);
  docker('rm', name);
  containers.delete(name);
}
async function start(owner: string, volume: string, name: string) {
  docker(
    'run',
    '--detach',
    '--init',
    '--name',
    name,
    '--user',
    owner,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:rw,nosuid,noexec,mode=1777',
    '--mount',
    mount(volume),
    '--publish',
    '127.0.0.1::3088',
    image,
  );
  containers.add(name);
  const port = docker('port', name, '3088/tcp').split(':').at(-1)!;
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = JSON.parse(
      docker('inspect', '--format', '{{json .State}}', name),
    );
    assert(state.Running, `Container failed: ${docker('logs', name)}`);
    try {
      if ((await fetch(origin + '/healthz')).ok) return origin;
    } catch {
      /* Wait for actual readiness. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated container did not become ready');
}
async function authenticated(context: APIRequestContext, origin: string) {
  const session = await (
    await context.get(origin + '/api/v1/auth/session')
  ).json();
  const headers = {
    Origin: origin,
    'x-csrf-token': session.csrfToken as string,
  };
  const setup = await (
    await context.get(origin + '/api/v1/auth/setup-status')
  ).json();
  const response = await context.post(
    origin + `/api/v1/auth/${setup.setupRequired ? 'setup' : 'login'}`,
    {
      headers,
      data: {
        username: 'backup-test-admin',
        password: 'Synthetic-backup-test-password-42',
      },
    },
  );
  assert(response.ok(), `Sign-in failed: ${await response.text()}`);
  return {
    Origin: origin,
    'x-csrf-token': (await response.json()).csrfToken as string,
  };
}

const browser = await chromium.launch({ headless: true });
try {
  for (const owner of ['1000:1000', '568:568']) {
    const uid = Number(owner.split(':')[0]);
    const gid = Number(owner.split(':')[1]);
    const volume = `${prefix}-${uid}`;
    docker(
      'volume',
      'create',
      '--label',
      'portfolio.test=settings-backup',
      volume,
    );
    volumes.add(volume);
    // Root provisions only this new empty fixture; PortFolio itself runs unprivileged.
    docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      mount(volume),
      image,
      'node',
      '-e',
      `const fs=require('node:fs');fs.chownSync('/data',${uid},${gid});fs.chmodSync('/data',0o700);`,
    );
    const name = `${prefix}-${uid}`;
    let origin = await start(owner, volume, name);
    const context = await browser.newContext();
    let headers = await authenticated(context.request, origin);
    const document = emptyBoardDocument();
    document.elements.push({
      id: 'device',
      type: 'device',
      name: 'Synthetic restore equipment',
      x: 0,
      y: 0,
      width: 320,
      height: 224,
      z: 0,
      color: '',
      properties: {},
    });
    const create = await context.request.post(origin + '/api/v1/boards', {
      headers,
      data: { name: 'Before browser backup', document },
    });
    assert(create.ok(), await create.text());
    const board = (await create.json()).board;
    const ownerKey = { type: 'device' as const, elementId: 'device' };
    const attachmentBase = '/api/v1' + attachmentPath(board.id, ownerKey);
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#39765c' },
    })
      .png()
      .toBuffer();
    const text = Buffer.from(
      'Synthetic complete backup document\n'.repeat(32_768),
    );
    const originals: { id: string; bytes: Buffer }[] = [];
    for (const [filename, bytes] of [
      ['equipment.png', png],
      ['notes.txt', text],
    ] as const) {
      const upload = await context.request.post(
        origin + attachmentBase + '&filename=' + filename,
        {
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          data: bytes,
        },
      );
      assert(upload.ok(), await upload.text());
      originals.push({ id: (await upload.json()).attachment.id, bytes });
    }
    const settings = await context.request.get(origin + '/api/v1/settings');
    assert(
      settings.ok(),
      `Settings endpoint missing: ${await settings.text()}`,
    );
    const prepared = await context.request.post(origin + '/api/v1/backups', {
      headers,
      data: {},
    });
    assert(prepared.ok(), await prepared.text());
    const backup = (await prepared.json()).backup;
    const downloaded = await context.request.get(origin + backup.downloadUrl);
    assert(downloaded.ok(), await downloaded.text());
    assert.match(downloaded.headers()['content-type']!, /zip/);
    const zip = await downloaded.body();
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    const current = (
      await (
        await context.request.get(origin + `/api/v1/boards/${board.id}`)
      ).json()
    ).board;
    const change = await context.request.patch(
      origin + `/api/v1/boards/${board.id}`,
      {
        headers,
        data: { rowVersion: current.rowVersion, name: 'Changed after backup' },
      },
    );
    assert(change.ok(), await change.text());
    const staged = await context.request.post(
      origin + '/api/v1/backups/restore',
      {
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        data: zip,
      },
    );
    assert(staged.ok(), await staged.text());
    const restore = (await staged.json()).restore;
    assert.equal(restore.boardCount, 1);
    assert.equal(restore.attachmentCount, 2);
    assert.equal(restore.compatibility, 'compatible');
    const confirmed = await context.request.post(
      origin + `/api/v1/backups/restore/${restore.id}/confirm`,
      {
        headers,
        data: { confirm: 'RESTORE' },
      },
    );
    assert(confirmed.ok(), await confirmed.text());
    const activated = await confirmed.json();
    assert.equal(activated.restored, true);
    assert.equal(activated.reauthenticationRequired, true);
    assert.equal(
      (await context.request.get(origin + '/api/v1/boards')).status(),
      401,
    );
    headers = await authenticated(context.request, origin);
    async function verify() {
      const response = await context.request.get(
        origin + `/api/v1/boards/${board.id}`,
      );
      assert(response.ok(), await response.text());
      const recovered = (await response.json()).board;
      assert.equal(recovered.name, 'Before browser backup');
      assert.deepEqual(recovered.document, document);
      for (const original of originals) {
        const response = await context.request.get(
          origin +
            '/api/v1' +
            attachmentPath(board.id, ownerKey, original.id, 'original'),
        );
        assert(response.ok(), await response.text());
        assert.deepEqual(await response.body(), original.bytes);
      }
      const thumbnail = await context.request.get(
        origin +
          '/api/v1' +
          attachmentPath(board.id, ownerKey, originals[0]!.id, 'thumbnail'),
      );
      assert(thumbnail.ok(), await thumbnail.text());
      const metadata = await (
        await context.request.get(origin + '/api/v1/settings')
      ).json();
      assert(
        metadata.recoveries.some(
          (r: { id: string }) => r.id === activated.recoveryId,
        ),
      );
      return recovered;
    }
    await verify();
    stop(name);
    origin = await start(owner, volume, name);
    headers = await authenticated(context.request, origin);
    const persisted = await verify();
    const saved = await context.request.patch(
      origin + `/api/v1/boards/${board.id}`,
      {
        headers,
        data: {
          rowVersion: persisted.rowVersion,
          document: { ...persisted.document, grid: false },
        },
      },
    );
    assert(saved.ok(), `Restored editor cannot save: ${await saved.text()}`);
    await context.close();
    stop(name);
    console.log(
      `PASS ${owner}: complete ZIP, image/document byte integrity, browser-authenticated restore, session reset, recovery archive, container recreation, editing`,
    );
  }
} finally {
  await browser.close();
  for (const name of containers) {
    try {
      docker('rm', '--force', name);
    } catch {
      /* Already gone. */
    }
  }
  for (const name of volumes) {
    try {
      docker('volume', 'rm', name);
    } catch {
      /* Preserve original failure. */
    }
  }
}
