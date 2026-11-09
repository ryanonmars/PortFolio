import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  emptyBoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import {
  attachmentPath,
  type AttachmentList,
  type AttachmentOwner,
} from '../../packages/shared/src/attachments.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

const username = 'settings-admin';
const password = 'Synthetic-settings-password-42';
async function signIn(page: Page) {
  await page.goto('/settings/general');
  const setup = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', {
      name: setup.setupRequired ? 'Create administrator account' : 'Sign in',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
}

test('Settings supports direct URLs, history, empty boards and mobile navigation', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/');
  await expect(
    page.getByText('No board selected.', { exact: true }),
  ).toBeVisible();
  const rootExplorer = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await rootExplorer.getAttribute('aria-expanded')) !== 'true')
    await rootExplorer.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByText('No board selected.', { exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByText(username, { exact: true }).last()).toBeVisible();
  await page
    .getByRole('link', { name: 'Backup & Restore', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/backup$/);
  await expect(
    page.getByRole('button', { name: 'Download Backup', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Source code', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/ryanonmars/portfolio');
  await page.goBack();
  await expect(
    page.getByRole('button', { name: 'Download Backup', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/backup$/);
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  const explorer = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await explorer.getAttribute('aria-expanded')) !== 'true')
    await explorer.click();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.board-browser footer')).not.toContainText('pnpm');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('link', { name: 'General', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.screenshot({
    path: test.info().outputPath('settings.png'),
    animations: 'disabled',
  });
});

async function requestHeaders(page: Page) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  return {
    Origin: new URL(page.url()).origin,
    'x-csrf-token': session.csrfToken,
  };
}
async function openSettings(page: Page) {
  const explorer = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await explorer.getAttribute('aria-expanded')) !== 'true')
    await explorer.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('link', { name: 'Backup & Restore', exact: true })
    .click();
}

test('complete browser backup restores boards, cables, image and document bytes and remains editable', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const document = emptyBoardDocument();
  const deviceId = randomUUID(),
    networkId = randomUUID(),
    entryId = randomUUID();
  document.elements.push(
    {
      id: deviceId,
      type: 'device',
      name: 'Backup switch',
      x: 40,
      y: 40,
      width: 400,
      height: 220,
      z: 0,
      color: '#24332b',
      properties: {},
    },
    {
      id: networkId,
      type: 'network',
      name: 'Backup networks',
      x: 480,
      y: 40,
      width: 400,
      height: 260,
      z: 1,
      color: '#24332b',
      properties: {
        entries: [
          {
            networkEntryId: entryId,
            networkEntryVersion: 2,
            vlanId: '20',
            vlanName: 'Backup reference',
            subnet: '192.0.2.0/24',
          },
        ],
      },
    },
  );
  const source = makeBoardPort(deviceId, 'rj45', 0, 0, 'Source');
  const target = makeBoardPort(deviceId, 'rj45', 0, 1, 'Target');
  document.ports.push(source, target);
  document.cables.push({
    id: randomUUID(),
    sourcePortId: source.id,
    targetPortId: target.id,
    name: 'Backup cable',
    cableType: 'Cat6',
    sourceConnector: 'RJ45',
    targetConnector: 'RJ45',
    color: '#83b494',
    length: '1m',
    notes: 'Synthetic reference',
  });
  const created = await page.request.post('/api/v1/boards', {
    headers: await requestHeaders(page),
    data: { name: 'Complete backup reference', document },
  });
  expect(created.status(), await created.text()).toBe(201);
  const board = (await created.json()).board as BoardRecord;
  const owner: AttachmentOwner = { type: 'device', elementId: deviceId };
  await page.goto(`/boards/${board.id}/devices/${deviceId}`);
  const upload = page.getByLabel('Add photos or files', { exact: true });
  const image = await sharp({
    create: { width: 48, height: 32, channels: 3, background: '#42875a' },
  })
    .png()
    .toBuffer();
  const text = Buffer.from('Synthetic backup reference\nport=Source\n');
  await upload.setInputFiles([
    { name: 'backup-switch.png', mimeType: 'image/png', buffer: image },
    { name: 'backup-reference.txt', mimeType: 'text/plain', buffer: text },
  ]);
  await expect(page.locator('.attachment-card')).toHaveCount(2);
  const before = (await (
    await page.request.get(`/api/v1${attachmentPath(board.id, owner)}`)
  ).json()) as AttachmentList;
  await openSettings(page);
  const received = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download Backup', exact: true })
    .click();
  const download = await received;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const archive = test.info().outputPath('complete-backup.zip');
  await download.saveAs(archive);
  expect((await readFile(archive)).length).toBeGreaterThan(0);
  const mutation = structuredClone(board.document);
  mutation.elements[0]!.name = 'Changed after backup';
  const updated = await page.request.patch(`/api/v1/boards/${board.id}`, {
    headers: await requestHeaders(page),
    data: {
      name: 'Mutated board',
      rowVersion: board.rowVersion,
      document: mutation,
    },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  await page
    .getByLabel('Backup ZIP file', { exact: true })
    .setInputFiles(archive);
  await expect(
    page.getByRole('form', { name: 'Verified backup' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('backup-preview.png'),
    animations: 'disabled',
  });
  await expect(
    page.getByRole('button', { name: 'Restore backup', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Type RESTORE to replace current data', { exact: true })
    .fill('restore');
  await expect(
    page.getByRole('button', { name: 'Restore backup', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Type RESTORE to replace current data', { exact: true })
    .fill('RESTORE');
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Sign in with an account and password from the backup',
  );
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  const restored = await (
    await page.request.get(`/api/v1/boards/${board.id}`)
  ).json();
  expect(restored.board.name).toBe(board.name);
  expect(restored.board.document).toEqual(board.document);
  for (const attachment of before.attachments) {
    const original = await page.request.get(
      `/api/v1${attachmentPath(board.id, owner, attachment.id, 'original')}`,
    );
    expect(original.status()).toBe(200);
    expect(await original.body()).toEqual(
      attachment.originalFilename.endsWith('.png') ? image : text,
    );
  }
  await page.goto(`/boards/${board.id}/devices/${deviceId}`);
  await page.getByRole('button', { name: 'Edit device', exact: true }).click();
  const name = page.getByLabel('Device name', { exact: true });
  await name.fill('Edited after restore');
  await name.blur();
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Edit device', exact: true }).click();
  await expect(page.getByLabel('Device name', { exact: true })).toHaveValue(
    'Edited after restore',
  );
});

test('invalid restores and expired previews can be cancelled or retried without changing data', async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole('link', { name: 'Backup & Restore', exact: true })
    .click();
  await page.getByLabel('Backup ZIP file', { exact: true }).setInputFiles({
    name: 'invalid.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('not a backup'),
  });
  await expect(
    page.locator('.backup-restore').getByRole('alert'),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Verified backup' })).toHaveCount(
    0,
  );
  const received = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download Backup', exact: true })
    .click();
  const download = await received;
  const archive = test.info().outputPath('cancel-backup.zip');
  await download.saveAs(archive);
  await page
    .getByLabel('Backup ZIP file', { exact: true })
    .setInputFiles(archive);
  await expect(
    page.getByRole('form', { name: 'Verified backup' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await expect(page.getByRole('form', { name: 'Verified backup' })).toHaveCount(
    0,
  );
  await expect(
    page.locator('.backup-restore').getByRole('status'),
  ).toContainText('Current data was not changed');
  expect((await page.request.get('/api/v1/boards')).status()).toBe(200);
  let previewId = '';
  await page.route('**/api/v1/backups/restore', async (route) => {
    const response = await route.fetch({ postData: await readFile(archive) });
    if (response.ok()) previewId = (await response.json()).restore.id;
    await route.fulfill({ response });
  });
  for (const action of ['cancel', 'confirm']) {
    await page
      .getByLabel('Backup ZIP file', { exact: true })
      .setInputFiles(archive);
    await expect(
      page.getByRole('form', { name: 'Verified backup' }),
    ).toBeVisible();
    // Remove the server preview as expiry or a failed activation would do.
    const removed = await page.request.delete(
      `/api/v1/backups/restore/${previewId}`,
      { headers: await requestHeaders(page), data: {} },
    );
    expect(removed.ok(), await removed.text()).toBe(true);
    if (action === 'cancel') {
      await page
        .getByRole('button', { name: 'Cancel restore', exact: true })
        .click();
    } else {
      await page
        .getByLabel('Type RESTORE to replace current data', { exact: true })
        .fill('RESTORE');
      await page
        .getByRole('button', { name: 'Restore backup', exact: true })
        .click();
      await expect(
        page.locator('.backup-restore').getByRole('alert'),
      ).toBeVisible();
    }
    await expect(
      page.getByRole('form', { name: 'Verified backup' }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Backup ZIP file', { exact: true }),
    ).toBeEnabled();
    expect((await page.request.get('/api/v1/boards')).status()).toBe(200);
  }
});

test('Settings waits for pending board autosave and Back returns to the same detail page', async ({
  page,
}) => {
  await signIn(page);
  const document = emptyBoardDocument();
  const deviceId = randomUUID();
  document.elements.push({
    id: deviceId,
    type: 'device',
    name: 'Unsaved reference',
    x: 40,
    y: 40,
    width: 400,
    height: 220,
    z: 0,
    color: '#24332b',
    properties: {},
  });
  const response = await page.request.post('/api/v1/boards', {
    headers: await requestHeaders(page),
    data: { name: 'Autosave before Settings', document },
  });
  expect(response.status()).toBe(201);
  const { board } = (await response.json()) as { board: BoardRecord };
  const detailPath = `/boards/${board.id}/devices/${deviceId}`;
  await page.goto(detailPath);
  await page.getByRole('button', { name: 'Edit device', exact: true }).click();
  await page.route(`**/api/v1/boards/${board.id}`, async (route) => {
    if (route.request().method() === 'PATCH')
      await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page
    .getByLabel('Device name', { exact: true })
    .fill('Saved before Settings');
  const explorer = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await explorer.getAttribute('aria-expanded')) !== 'true')
    await explorer.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  const saved = await (
    await page.request.get(`/api/v1/boards/${board.id}`)
  ).json();
  expect(saved.board.document.elements[0].name).toBe('Saved before Settings');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
  await expect(page.getByLabel('Device name', { exact: true })).toHaveValue(
    'Saved before Settings',
  );
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
});

test('a failed autosave keeps unsaved board edits when opening Settings', async ({
  page,
}) => {
  await signIn(page);
  const document = emptyBoardDocument();
  const deviceId = randomUUID();
  document.elements.push({
    id: deviceId,
    type: 'device',
    name: 'Original unsaved reference',
    x: 40,
    y: 40,
    width: 400,
    height: 220,
    z: 0,
    color: '#24332b',
    properties: {},
  });
  const response = await page.request.post('/api/v1/boards', {
    headers: await requestHeaders(page),
    data: { name: 'Failed autosave reference', document },
  });
  expect(response.status()).toBe(201);
  const { board } = (await response.json()) as { board: BoardRecord };
  const path = `/boards/${board.id}/devices/${deviceId}`;
  await page.goto(path);
  await page.getByRole('button', { name: 'Edit device', exact: true }).click();
  await page.route(`**/api/v1/boards/${board.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Synthetic save failure' } }),
    });
  });
  await page
    .getByLabel('Device name', { exact: true })
    .fill('Keep this unsaved edit');
  const explorer = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await explorer.getAttribute('aria-expanded')) !== 'true')
    await explorer.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.board-global-error')).toContainText(
    'Synthetic save failure',
  );
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await page
    .getByRole('button', { name: 'Collapse board browser', exact: true })
    .click();
  await expect(page.getByLabel('Device name', { exact: true })).toHaveValue(
    'Keep this unsaved edit',
  );
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toHaveCount(0);
});
