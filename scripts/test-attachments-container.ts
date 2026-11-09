/** Optional Docker smoke test; uses only a new private, synthetic data directory. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { emptyBoardDocument } from '../packages/shared/src/board.js';
import { attachmentPath } from '../packages/shared/src/attachments.js';

const root = mkdtempSync(join(tmpdir(), 'portfolio-docker-attachments-'));
const container = `portfolio-attachments-test-${Date.now()}`;
const image = process.env.PORTFOLIO_TEST_IMAGE ?? 'portfolio:phase3-local';
const port = Number(process.env.PORTFOLIO_TEST_PORT ?? 3191);
const origin = `http://127.0.0.1:${port}`;
let cookie = '',
  csrf = '',
  running = false;
function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const runtime = [
  '--user',
  `${process.getuid!()}:${process.getgid!()}`,
  '--read-only',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,mode=1777',
  '--mount',
  `type=bind,source=${root},target=/data`,
];
async function start(dataDir = '/data') {
  docker([
    'run',
    '--detach',
    '--name',
    container,
    ...runtime,
    '--publish',
    `127.0.0.1:${port}:3088`,
    '-e',
    `PUBLIC_ORIGIN=${origin}`,
    '-e',
    `DATA_DIR=${dataDir}`,
    image,
  ]);
  running = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin + '/healthz')).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Container did not become ready');
}
function stop() {
  if (running) {
    docker(['stop', container]);
    // Explicit removal is synchronous; --rm can retain the name briefly after stop.
    docker(['rm', container]);
    running = false;
  }
}
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  raw = false,
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      'x-csrf-token': csrf,
      ...(body === undefined
        ? {}
        : {
            'content-type': raw
              ? 'application/octet-stream'
              : 'application/json',
          }),
    },
    body:
      body === undefined
        ? undefined
        : raw
          ? new Uint8Array(body as Buffer)
          : JSON.stringify(body),
  });
  for (const value of response.headers.getSetCookie())
    if (value.startsWith('portfolio_session=')) cookie = value.split(';')[0]!;
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
  );
  return response;
}
try {
  await start();
  csrf = (await (await request('/api/v1/auth/session')).json()).csrfToken;
  csrf = (
    await (
      await request('/api/v1/auth/setup', 'POST', {
        username: 'synthetic-admin',
        password: 'Synthetic-docker-attachments-42',
      })
    ).json()
  ).csrfToken;
  const document = emptyBoardDocument();
  document.elements = [
    {
      id: 'device',
      type: 'device',
      name: 'Synthetic equipment',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      z: 0,
      color: '',
      properties: {},
    },
  ];
  const board = (
    await (
      await request('/api/v1/boards', 'POST', {
        name: 'Docker attachment fixture',
        document,
      })
    ).json()
  ).board;
  const owner = { type: 'device' as const, elementId: 'device' };
  const path = '/api/v1' + attachmentPath(board.id, owner);
  const png = await sharp({
    create: { width: 800, height: 600, channels: 3, background: '#447755' },
  })
    .png()
    .toBuffer();
  const attachment = (
    await (
      await request(path + '&filename=equipment.png', 'POST', png, true)
    ).json()
  ).attachment;
  const originalPath =
    '/api/v1' + attachmentPath(board.id, owner, attachment.id, 'original');
  const thumbPath =
    '/api/v1' + attachmentPath(board.id, owner, attachment.id, 'thumbnail');
  const verify = async () => {
    const list = await (await request(path)).json();
    assert.equal(list.attachments[0].id, attachment.id);
    assert.equal(list.attachments[0].available, true);
    assert.deepEqual(
      Buffer.from(await (await request(originalPath)).arrayBuffer()),
      png,
    );
    const thumbnail = await sharp(
      Buffer.from(await (await request(thumbPath)).arrayBuffer()),
    ).metadata();
    assert.ok(thumbnail.width! <= 480 && thumbnail.height! <= 320);
  };
  await verify();
  docker([
    'exec',
    container,
    'node',
    'dist/scripts/database.js',
    'backup',
    '/data/backups/smoke.sqlite',
  ]);
  stop();
  await start();
  await verify();
  stop();
  docker([
    'run',
    '--rm',
    ...runtime,
    '-e',
    'DATA_DIR=/data/restored',
    image,
    'node',
    'dist/scripts/database.js',
    'restore',
    '/data/backups/smoke.sqlite',
  ]);
  await start('/data/restored');
  await verify();
  console.log(
    'PASS: read-only Docker, thumbnails, container recreation, complete backup/restore, exact original bytes',
  );
} finally {
  try {
    stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
