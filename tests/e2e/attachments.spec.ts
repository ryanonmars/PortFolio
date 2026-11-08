import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import {
  attachmentPath,
  type AttachmentList,
  type AttachmentOwner,
} from '../../packages/shared/src/attachments.js';
test.use({ actionTimeout: 15_000 });
const csrfTokens = new Map<string, string>();
const sessionFile = (port: string) =>
  join(
    test.info().config.metadata.e2eDataDir as string,
    `attachment-session-${port}.json`,
  );
async function authenticate(page: Page) {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const cache = sessionFile(new URL(origin).port);
  let restored = false;
  try {
    const session = JSON.parse(await readFile(cache, 'utf8'));
    await page.context().addCookies(session.cookies);
    csrfTokens.set(origin, session.csrfToken);
    restored = true;
  } catch {
    // The first test creates this isolated server's administrator and session.
  }
  await page.goto('/');
  if (restored) {
    await expect(
      page.getByRole('button', { name: 'Open board browser', exact: true }),
    ).toBeVisible();
    return;
  }
  const setup = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  await page.getByLabel('Username', { exact: true }).fill('board-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-board-password-42');
  await page
    .getByRole('button', {
      name: setup.setupRequired ? 'Create administrator account' : 'Sign in',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  csrfTokens.set(origin, auth.csrfToken);
  await writeFile(
    cache,
    JSON.stringify({
      cookies: await page.context().cookies(),
      csrfToken: auth.csrfToken,
    }),
    { mode: 0o600 },
  );
}

async function headers(page: Page) {
  const origin = new URL(page.url()).origin;
  return { Origin: origin, 'x-csrf-token': csrfTokens.get(origin)! };
}

async function create(
  page: Page,
  document: BoardDocument,
  prefix = 'Detail pages',
) {
  const response = await page.request.post('/api/v1/boards', {
    headers: await headers(page),
    data: { name: `${prefix} ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).board as BoardRecord;
}

async function read(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/boards/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).board as BoardRecord;
}

function fixture() {
  const document = emptyBoardDocument();
  const deviceId = randomUUID();
  const siblingId = randomUUID();
  const containerId = randomUUID();
  const entries = [randomUUID(), randomUUID()];
  document.elements.push(
    {
      id: deviceId,
      type: 'device',
      name: 'Reference switch',
      x: 50,
      y: 40,
      width: 400,
      height: 200,
      z: 0,
      color: '#24332b',
      properties: {},
    },
    {
      id: siblingId,
      type: 'device',
      name: 'Reference switch',
      x: 500,
      y: 40,
      width: 400,
      height: 200,
      z: 1,
      color: '#24332b',
      properties: {},
    },
    {
      id: containerId,
      type: 'network',
      name: 'Reference networks',
      x: 50,
      y: 300,
      width: 900,
      height: 300,
      z: 2,
      color: '#24332b',
      properties: {
        entries: entries.map((networkEntryId) => ({
          networkEntryId,
          networkEntryVersion: 2,
          vlanId: '20',
          vlanName: 'Duplicate network',
          subnet: '192.0.2.0/24',
        })),
      },
    },
  );
  return { document, deviceId, siblingId, containerId, entries };
}
async function ready(page: Page) {
  await expect(page.locator('.board-studio-layout')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}
async function openOwner(page: Page, boardId: string, owner: AttachmentOwner) {
  await page.goto(
    owner.type === 'device'
      ? `/boards/${boardId}/devices/${owner.elementId}`
      : `/boards/${boardId}/networks/${owner.elementId}/${owner.entryId}`,
  );
  await ready(page);
  const section = page.getByRole('region', {
    name: 'Attachments',
    exact: true,
  });
  await expect(
    section.getByLabel('Add photos or files', { exact: true }),
  ).toBeEnabled();
  return section;
}
async function list(
  page: Page,
  boardId: string,
  owner: AttachmentOwner,
): Promise<AttachmentList> {
  const response = await page.request.get(
    `/api/v1${attachmentPath(boardId, owner)}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
const textFile = (name = 'reference.conf') => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from('# Synthetic documentation\ninterface=reference\n'),
});

test('sidebar navigation loads attachments after switching boards without a stuck interaction warning', async ({
  page,
}) => {
  await authenticate(page);
  const source = await create(page, emptyBoardDocument(), 'Navigation source');
  const { document, deviceId } = fixture();
  const target = await create(page, document, 'Attachment destination');
  await page.goto(`/boards/${source.id}`);
  await ready(page);
  const toggle = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  const sidebar = page.locator('.board-browser');
  await sidebar
    .getByRole('button', { name: `Expand board ${target.name}`, exact: true })
    .click();
  const row = sidebar.locator('.board-browser-item').filter({
    has: page.getByRole('button', {
      name: `Collapse board ${target.name}`,
      exact: true,
    }),
  });
  await row
    .getByRole('button', { name: 'Expand devices', exact: true })
    .click();
  await row
    .getByRole('button', { name: 'Reference switch', exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${target.id}/devices/${deviceId}$`),
  );
  await ready(page);
  const section = page.getByRole('region', {
    name: 'Attachments',
    exact: true,
  });
  await expect(section.getByLabel('Add photos or files')).toBeEnabled();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await section
    .getByLabel('Add photos or files')
    .setInputFiles(textFile('sidebar-reference.txt'));
  await expect(section.locator('.attachment-card')).toHaveCount(1);
});

test('undo restores owner attachments before an immediate detail-page visit while autosave is pending', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, deviceId, siblingId } = fixture();
  document.elements = document.elements.filter(
    (element) => element.id !== siblingId,
  );
  const board = await create(page, document, 'Attachment restoration');
  const owner: AttachmentOwner = { type: 'device', elementId: deviceId };
  const section = await openOwner(page, board.id, owner);
  await section
    .getByLabel('Add photos or files')
    .setInputFiles(textFile('recoverable.txt'));
  await expect(section.locator('.attachment-card')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await ready(page);
  const header = page.locator(
    `[data-board-element-id="${deviceId}"] .board-element-header`,
  );
  const position = await header.evaluate((node) => ({
    x: node.clientWidth / 2,
    y: node.clientHeight - 2,
  }));
  await header.click({ position });
  const inspector = page.getByRole('complementary', {
    name: 'Object inspector',
    exact: true,
  });
  page.once('dialog', (dialog) => dialog.accept());
  await inspector
    .getByRole('button', { name: 'Delete device', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await read(page, board.id)).document.elements.some(
        (element) => element.id === deviceId,
      ),
    )
    .toBe(false);
  const listStatuses: number[] = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'GET' &&
      response.url().includes(`/boards/${board.id}/attachments?`)
    )
      listStatuses.push(response.status());
  });
  await page.route(`**/api/v1/boards/${board.id}`, async (route) => {
    if (route.request().method() === 'PATCH')
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.evaluate(
    ({ boardId, deviceId }) => {
      history.pushState(null, '', `/boards/${boardId}/devices/${deviceId}`);
      dispatchEvent(new PopStateEvent('popstate'));
    },
    { boardId: board.id, deviceId },
  );
  await expect(section.getByLabel('Add photos or files')).toBeEnabled();
  await expect(
    section.getByRole('heading', { name: 'recoverable.txt', exact: true }),
  ).toBeVisible();
  expect(listStatuses.length).toBeGreaterThan(0);
  expect(listStatuses.every((status) => status === 200)).toBe(true);
  expect((await list(page, board.id, owner)).attachments).toHaveLength(1);
});

test('sequential document batches stay scoped to exact device, network entry and duplicated board', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, deviceId, siblingId, containerId, entries } = fixture();
  const board = await create(page, document, 'Attachment isolation');
  const owner: AttachmentOwner = { type: 'device', elementId: deviceId };
  let section = await openOwner(page, board.id, owner);
  await section
    .getByLabel('Add photos or files')
    .setInputFiles([
      textFile('reference.conf'),
      textFile('reference.md'),
      textFile('reference.json'),
    ]);
  await expect(section.locator('.attachment-card')).toHaveCount(3);
  expect((await list(page, board.id, owner)).attachments).toHaveLength(3);
  section = await openOwner(page, board.id, {
    type: 'device',
    elementId: siblingId,
  });
  await expect(section).toContainText('No attachments yet');
  const first: AttachmentOwner = {
    type: 'network',
    elementId: containerId,
    entryId: entries[0]!,
  };
  const second: AttachmentOwner = {
    type: 'network',
    elementId: containerId,
    entryId: entries[1]!,
  };
  section = await openOwner(page, board.id, first);
  await section
    .getByLabel('Add photos or files')
    .setInputFiles(textFile('network-reference.txt'));
  await expect(section.locator('.attachment-card')).toHaveCount(1);
  const attachment = (await list(page, board.id, first)).attachments[0]!;
  section = await openOwner(page, board.id, second);
  await expect(section).toContainText('No attachments yet');
  const denied = await page.request.get(
    `/api/v1${attachmentPath(board.id, second, attachment.id, 'original')}`,
  );
  expect(denied.status()).toBe(404);
  const duplicateResponse = await page.request.post(
    `/api/v1/boards/${board.id}/duplicate`,
    { headers: await headers(page), data: {} },
  );
  expect(duplicateResponse.status(), await duplicateResponse.text()).toBe(201);
  const duplicate = (await duplicateResponse.json()).board as BoardRecord;
  const copiedDevice = duplicate.document.elements.find(
    (element) => element.type === 'device',
  )!;
  section = await openOwner(page, duplicate.id, {
    type: 'device',
    elementId: copiedDevice.id,
  });
  await expect(section).toContainText('No attachments yet');
  const originalDocument = (await read(page, board.id)).document;
  expect(JSON.stringify(originalDocument)).not.toContain('reference.conf');
  expect(JSON.stringify(originalDocument)).not.toContain(
    'network-reference.txt',
  );
  await page.goto(`/boards/${board.id}`);
  await ready(page);
  await expect(
    page.getByRole('region', { name: 'Attachments', exact: true }),
  ).toHaveCount(0);
});

test('invalid files show feedback and permanent deletion requires explicit confirmation', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, deviceId } = fixture();
  const board = await create(page, document, 'Attachment validation');
  const owner: AttachmentOwner = { type: 'device', elementId: deviceId };
  const section = await openOwner(page, board.id, owner);
  await section.getByLabel('Add photos or files').setInputFiles({
    name: 'unsafe.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(section.getByRole('alert')).toContainText(
    'supported image or document',
  );
  const limits = (await list(page, board.id, owner)).limits;
  await section.getByLabel('Add photos or files').setInputFiles({
    name: 'oversize.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(limits.maxFileBytes + 1, 65),
  });
  await expect(section.getByRole('alert')).toContainText('too large');
  expect((await list(page, board.id, owner)).attachments).toHaveLength(0);
  await section
    .getByLabel('Add photos or files')
    .setInputFiles(textFile('delete-me.txt'));
  await expect(section.locator('.attachment-card')).toHaveCount(1);
  const attachment = (await list(page, board.id, owner)).attachments[0]!;
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('cannot be undone');
    await dialog.dismiss();
  });
  await section
    .getByRole('button', {
      name: 'Delete attachment delete-me.txt',
      exact: true,
    })
    .click();
  await expect(section.locator('.attachment-card')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await section
    .getByRole('button', {
      name: 'Delete attachment delete-me.txt',
      exact: true,
    })
    .click();
  await expect(section).toContainText('Attachment permanently deleted');
  await expect(section).toContainText('No attachments yet');
  expect(
    (
      await page.request.get(
        `/api/v1${attachmentPath(board.id, owner, attachment.id, 'original')}`,
      )
    ).status(),
  ).toBe(404);
  await page.reload();
  await ready(page);
  await expect(section).toContainText('No attachments yet');
});

test('photos preserve original bytes, bounded derivatives, editable details and persistent downloads', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, deviceId } = fixture();
  const board = await create(page, document, 'Attachments');
  const owner: AttachmentOwner = { type: 'device', elementId: deviceId };
  const section = await openOwner(page, board.id, owner);
  await expect(section).toContainText('No attachments yet');
  const original = await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: '#426c58' },
  })
    .png()
    .toBuffer();
  const changedDocument = (await read(page, board.id)).document;
  await section.getByLabel('Add photos or files').setInputFiles({
    name: 'front-panel.png',
    mimeType: 'image/png',
    buffer: original,
  });
  await expect(
    section.getByRole('heading', { name: 'front-panel.png', exact: true }),
  ).toBeVisible();
  const attachment = (await list(page, board.id, owner)).attachments[0]!;
  const thumb = section.locator('img[loading="lazy"]');
  await thumb.scrollIntoViewIfNeeded();
  await expect(thumb).toHaveAttribute('src', /\/thumbnail\?/);
  await expect
    .poll(() => thumb.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  const dimensions = await thumb.evaluate((node: HTMLImageElement) => ({
    width: node.naturalWidth,
    height: node.naturalHeight,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(480);
  expect(dimensions.height).toBeLessThanOrEqual(320);
  await section
    .getByRole('button', { name: 'Preview front-panel.png', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Preview front-panel.png',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog
        .locator('img')
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(0);
  const preview = await dialog
    .locator('img')
    .evaluate((node: HTMLImageElement) => ({
      width: node.naturalWidth,
      height: node.naturalHeight,
    }));
  expect(preview.width).toBeLessThanOrEqual(1800);
  expect(preview.height).toBeLessThanOrEqual(1800);
  await page.screenshot({
    path: info.outputPath('attachment-image-preview.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  const downloading = page.waitForEvent('download');
  await section
    .getByRole('link', { name: 'Download original', exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('front-panel.png');
  expect(await readFile((await download.path())!)).toEqual(original);
  await section
    .getByRole('button', {
      name: 'Edit attachment front-panel.png',
      exact: true,
    })
    .click();
  await section
    .getByLabel('Display name', { exact: true })
    .fill('Rack front reference');
  await section
    .getByLabel('Caption', { exact: true })
    .fill('Synthetic photo of the documented front panel.');
  await section
    .getByRole('button', { name: 'Save details', exact: true })
    .click();
  await expect(section).toContainText('Attachment details saved');
  await page.reload();
  await ready(page);
  await expect(
    section.getByRole('heading', { name: 'Rack front reference', exact: true }),
  ).toBeVisible();
  await expect(section).toContainText(
    'Synthetic photo of the documented front panel.',
  );
  expect((await list(page, board.id, owner)).attachments[0]).toMatchObject({
    id: attachment.id,
    displayName: 'Rack front reference',
    description: 'Synthetic photo of the documented front panel.',
    originalFilename: 'front-panel.png',
  });
  expect((await read(page, board.id)).document).toEqual(changedDocument);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('attachments-detail-gallery.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => window.document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
