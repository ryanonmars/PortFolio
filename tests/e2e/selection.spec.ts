import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
const object = (page: Page, id: string) =>
  page.locator(`[data-board-element-id="${id}"]`);
const selected = (page: Page) =>
  page.locator('.board-element[data-selected="true"]');
async function saved(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
}
async function read(page: Page, id: string): Promise<BoardRecord> {
  const response = await page.request.get(`/api/v1/boards/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).board;
}
function fixture(zoom = 1, negative = false): BoardDocument {
  const document = emptyBoardDocument(),
    offset = negative ? -400 : 0;
  document.viewport = { x: negative ? 440 : 40, y: 40, zoom };
  document.elements = [
    {
      id: 'router',
      type: 'device',
      name: 'Router',
      x: 40 + offset,
      y: 60,
      width: 280,
      height: 220,
      z: 0,
      color: '',
      properties: { manufacturer: 'Synthetic', model: 'Router model' },
    },
    {
      id: 'switch',
      type: 'device',
      name: 'Switch',
      x: 400 + offset,
      y: 60,
      width: 280,
      height: 220,
      z: 1,
      color: '',
      properties: {},
    },
    {
      id: 'network',
      type: 'network',
      name: 'Network',
      x: 40 + offset,
      y: 360,
      width: 280,
      height: 180,
      z: 2,
      color: '',
      properties: {},
    },
    {
      id: 'summary',
      type: 'summary',
      name: 'Summary',
      x: 400 + offset,
      y: 360,
      width: 280,
      height: 180,
      z: 3,
      color: '',
      properties: { linkedDeviceId: 'router' },
    },
    {
      id: 'outside',
      type: 'network',
      name: 'Untouched',
      x: 800 + offset,
      y: 620,
      width: 180,
      height: 120,
      z: 4,
      color: '',
      properties: {},
    },
  ];
  document.ports = [
    makeBoardPort('router', 'rj45', 0, 0, 'Port 1'),
    makeBoardPort('switch', 'sfp_plus', 0, 0, 'Port 1'),
  ];
  document.cables = [
    {
      id: 'cable',
      sourcePortId: document.ports[0]!.id,
      targetPortId: document.ports[1]!.id,
      name: 'Uplink',
      cableType: 'Cat6A',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: 'Must remain unchanged',
    },
  ];
  return document;
}
async function setup(page: Page, document = fixture()) {
  await page.goto('/');
  const status = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  await page.getByLabel('Username', { exact: true }).fill('board-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-board-password-42');
  await page
    .getByRole('button', {
      name: status.setupRequired ? 'Create administrator account' : 'Sign in',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Selection ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const board: BoardRecord = (await response.json()).board;
  await page.goto(`/boards/${board.id}`);
  await saved(page);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  return board;
}
async function point(page: Page, x: number, y: number) {
  const canvas = (await page.getByTestId('board-canvas').boundingBox())!;
  return { x: canvas.x + x, y: canvas.y + y };
}
async function marquee(
  page: Page,
  a: { x: number; y: number },
  b: { x: number; y: number },
  shift = false,
) {
  const start = await point(page, a.x, a.y),
    end = await point(page, b.x, b.y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(page.locator('.board-marquee')).toBeVisible();
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await expect(page.locator('.board-marquee')).toHaveCount(0);
}
async function clickObject(
  page: Page,
  id: string,
  modifier?: 'Shift' | 'Control' | 'Meta',
) {
  const box = (await object(page, id).boundingBox())!;
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(box.x + box.width - 14, box.y + box.height - 14);
  if (modifier) await page.keyboard.up(modifier);
}
async function selectedIds(page: Page) {
  return selected(page).evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-board-element-id'))
      .sort(),
  );
}
async function startDrag(page: Page, id: string, dx: number, dy: number) {
  const header = (await object(page, id)
    .locator('.board-element-header')
    .boundingBox())!;
  const x = header.x + header.width - 14,
    y = header.y + header.height - 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
}
async function headerClick(
  page: Page,
  id: string,
  modifier?: 'Shift' | 'Meta',
) {
  const header = (await object(page, id)
    .locator('.board-element-header')
    .boundingBox())!;
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(
    header.x + header.width - 14,
    header.y + header.height - 10,
  );
  if (modifier) await page.keyboard.up(modifier);
}
function positions(document: BoardDocument) {
  return document.elements.map(({ id, x, y }) => ({ id, x, y }));
}

test('marquee, modifiers, enclosure and cancellation keep mixed container selections', async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith('mobile'));
  await setup(page);
  await clickObject(page, 'router');
  expect(await selectedIds(page)).toEqual(['router']);
  await clickObject(page, 'switch', 'Shift');
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  await expect(
    page.getByText('2 objects selected', { exact: true }),
  ).toBeVisible();
  // Native Control-click on macOS opens the OS context menu; Meta is the
  // native toggle gesture here. Dispatch a Control-click separately below.
  await clickObject(page, 'router', 'Meta');
  expect(await selectedIds(page)).toEqual(['switch']);
  await clickObject(page, 'router', 'Meta');
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  await object(page, 'router').dispatchEvent('click', { ctrlKey: true });
  expect(await selectedIds(page)).toEqual(['switch']);
  await object(page, 'router').dispatchEvent('click', { ctrlKey: true });
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  await page.keyboard.press('Escape');
  await expect(selected(page)).toHaveCount(0);
  await headerClick(page, 'router');
  await headerClick(page, 'switch', 'Shift');
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  await headerClick(page, 'router', 'Meta');
  expect(await selectedIds(page)).toEqual(['switch']);
  await page.keyboard.press('Escape');
  await marquee(page, { x: 60, y: 80 }, { x: 560, y: 340 });
  expect(await selectedIds(page)).toEqual(['router']);
  await marquee(page, { x: 420, y: 380 }, { x: 740, y: 600 }, true);
  expect(await selectedIds(page)).toEqual(['router', 'summary']);
  for (const [a, b] of [
    [
      { x: 750, y: 600 },
      { x: 60, y: 80 },
    ],
    [
      { x: 60, y: 600 },
      { x: 750, y: 80 },
    ],
    [
      { x: 750, y: 80 },
      { x: 60, y: 600 },
    ],
  ]) {
    await marquee(page, a!, b!);
    expect(await selectedIds(page)).toEqual([
      'network',
      'router',
      'summary',
      'switch',
    ]);
  }
  const start = await point(page, 20, 320),
    end = await point(page, 360, 340);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await selectedIds(page)).toEqual([
    'network',
    'router',
    'summary',
    'switch',
  ]);
  await page.screenshot({ path: info.outputPath('mixed-selection.png') });
  // Additive membership uses the initial selection, not earlier marquee frames.
  await page.keyboard.press('Escape');
  await clickObject(page, 'router');
  const additiveStart = await point(page, 420, 80),
    additiveWide = await point(page, 750, 600),
    additiveSmall = await point(page, 750, 340);
  await page.keyboard.down('Shift');
  await page.mouse.move(additiveStart.x, additiveStart.y);
  await page.mouse.down();
  await page.mouse.move(additiveWide.x, additiveWide.y, { steps: 8 });
  expect(await selectedIds(page)).toEqual(['router', 'summary', 'switch']);
  await page.screenshot({ path: info.outputPath('active-marquee.png') });
  await page.mouse.move(additiveSmall.x, additiveSmall.y, { steps: 8 });
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.mouse.click(start.x, start.y);
  await expect(selected(page)).toHaveCount(0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 1, start.y + 1);
  await page.mouse.up();
  await expect(page.locator('.board-marquee')).toHaveCount(0);
});

test('group drag previews without writes, saves atomically and supports cancel, undo, redo and reload', async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith('mobile'));
  const initial = await setup(page),
    before = (await read(page, initial.id)).document;
  await marquee(page, { x: 60, y: 80 }, { x: 750, y: 600 });
  const path = page.locator('[data-board-cable-id="cable"] .board-cable-line'),
    oldPath = await path.getAttribute('d');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      request.url().endsWith(`/boards/${initial.id}`)
    )
      writes.push(request.postData() ?? '');
  });
  await page.keyboard.down('Alt');
  await startDrag(page, 'router', 51, 35);
  await expect(path).not.toHaveAttribute('d', oldPath!);
  await page.waitForTimeout(550);
  expect(writes).toHaveLength(0);
  expect(positions((await read(page, initial.id)).document)).toEqual(
    positions(before),
  );
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved(page);
  expect(writes).toHaveLength(1);
  const moved = (await read(page, initial.id)).document;
  for (const element of before.elements) {
    const after = moved.elements.find((item) => item.id === element.id)!;
    expect(after.x - element.x).toBe(element.id === 'outside' ? 0 : 51);
    expect(after.y - element.y).toBe(element.id === 'outside' ? 0 : 35);
  }
  expect(moved.ports).toEqual(before.ports);
  expect(moved.cables).toEqual(before.cables);
  await expect(selected(page)).toHaveCount(4);
  await page.keyboard.down('Alt');
  await startDrag(page, 'switch', -25, 20);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved(page);
  expect(positions((await read(page, initial.id)).document)).toEqual(
    positions(moved),
  );
  await expect(selected(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect(positions((await read(page, initial.id)).document)).toEqual(
    positions(before),
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  expect(positions((await read(page, initial.id)).document)).toEqual(
    positions(moved),
  );
  await page.reload();
  await saved(page);
  expect((await read(page, initial.id)).document).toEqual(moved);
  await page.screenshot({
    path: info.outputPath('moved-connected-mixed-board.png'),
  });
  await marquee(page, { x: 100, y: 115 }, { x: 810, y: 650 });
  await expect(selected(page)).toHaveCount(4);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Delete');
  expect((await read(page, initial.id)).document).toEqual(moved);
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Delete');
  await saved(page);
  expect(
    (await read(page, initial.id)).document.elements.map((item) => item.id),
  ).toEqual(['outside']);
  expect((await read(page, initial.id)).document.cables).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, initial.id)).document).toEqual(moved);
});

test('group snapping preserves offsets and zoomed negative-coordinate marquee matches geometry', async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith('mobile'));
  const initial = await setup(page, fixture(0.75, true));
  await marquee(page, { x: 155, y: 70 }, { x: 680, y: 260 });
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  const before = (await read(page, initial.id)).document;
  await startDrag(page, 'switch', 20, 13);
  await page.mouse.up();
  await saved(page);
  const moved = (await read(page, initial.id)).document,
    router = moved.elements.find((item) => item.id === 'router')!,
    peer = moved.elements.find((item) => item.id === 'switch')!;
  expect(peer.x - router.x).toBe(360);
  expect(peer.y - router.y).toBe(0);
  expect(Math.abs(router.x % 8)).toBe(0);
  expect(router.y % 8).toBe(0);
  expect(moved.elements.find((item) => item.id === 'network')).toEqual(
    before.elements.find((item) => item.id === 'network'),
  );
  await page.screenshot({
    path: info.outputPath('zoomed-negative-selection.png'),
  });
});

test('high zoom selection and movement use board coordinates', async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith('mobile'));
  const initial = await setup(page, fixture(1.5));
  await marquee(page, { x: 80, y: 100 }, { x: 1090, y: 490 });
  expect(await selectedIds(page)).toEqual(['router', 'switch']);
  const before = (await read(page, initial.id)).document;
  await page.keyboard.down('Alt');
  await startDrag(page, 'router', 30, 45);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved(page);
  const moved = (await read(page, initial.id)).document;
  for (const id of ['router', 'switch']) {
    const original = before.elements.find((item) => item.id === id)!,
      after = moved.elements.find((item) => item.id === id)!;
    expect(after.x - original.x).toBeCloseTo(20);
    expect(after.y - original.y).toBeCloseTo(30);
  }
});

test('single-object controls, port editing, resize, and navigation do not start marquee', async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith('mobile'));
  const initial = await setup(page),
    document = (await read(page, initial.id)).document;
  await page.locator(`button[data-port-id="${document.ports[0]!.id}"]`).click();
  await expect(page.getByLabel('PVID', { exact: true })).toBeVisible();
  await page.getByLabel('PVID', { exact: true }).fill('77');
  await saved(page);
  await expect(page.locator('.board-marquee')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await clickObject(page, 'router');
  await startDrag(page, 'router', 16, 16);
  await page.mouse.up();
  await saved(page);
  const moved = (await read(page, initial.id)).document;
  expect(moved.elements[0]!.x).not.toBe(document.elements[0]!.x);
  expect(moved.elements[1]).toEqual(document.elements[1]);
  const box = (await page
    .getByRole('button', { name: 'Resize Router se', exact: true })
    .boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 24,
    box.y + box.height / 2 + 16,
    { steps: 5 },
  );
  await page.mouse.up();
  await saved(page);
  expect(
    (await read(page, initial.id)).document.elements[0]!.width,
  ).toBeGreaterThan(moved.elements[0]!.width);
  const beforePan = (await read(page, initial.id)).document.viewport,
    start = await point(page, 20, 320);
  await page.getByTestId('board-canvas').focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('board-canvas')).toHaveClass(/space-pan/);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 25, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await saved(page);
  expect((await read(page, initial.id)).document.viewport.x).toBe(
    beforePan.x + 30,
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(start.x + 20, start.y + 15, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await saved(page);
  expect((await read(page, initial.id)).document.viewport.x).toBe(
    beforePan.x + 50,
  );
  await expect(page.locator('.board-marquee')).toHaveCount(0);
});

test('touch background drag preserves panning and port inspection', async ({
  page,
  context,
}, info) => {
  test.skip(!info.project.name.startsWith('mobile'));
  const initial = await setup(page, fixture(0.35)),
    before = (await read(page, initial.id)).document,
    start = await point(page, 20, 260);
  const client = await context.newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: start.x, y: start.y }],
  });
  for (let step = 1; step <= 6; step++)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: start.x + step * 5, y: start.y + step * 4 }],
    });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await saved(page);
  const after = (await read(page, initial.id)).document;
  expect(after.viewport.x).toBeCloseTo(before.viewport.x + 30);
  expect(after.viewport.y).toBeCloseTo(before.viewport.y + 24);
  expect(after.elements).toEqual(before.elements);
  await expect(page.locator('.board-marquee')).toHaveCount(0);
  await page.locator(`button[data-port-id="${before.ports[0]!.id}"]`).tap();
  await expect(page.getByLabel('PVID', { exact: true })).toBeVisible();
});
