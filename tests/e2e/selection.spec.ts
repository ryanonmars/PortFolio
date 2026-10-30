import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
// Each test retains a fresh browser context; reuse the suite's own login cookie
// instead of consuming the real sign-in throttle for every interaction case.
const authenticatedCookies = new Map<
  string,
  Awaited<ReturnType<BrowserContext['cookies']>>
>();
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
  const project = test.info().project.name;
  const cookies = authenticatedCookies.get(project);
  if (cookies) await page.context().addCookies(cookies);
  await page.goto('/');
  if (!cookies) {
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
  }
  await expect(
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
  if (!cookies)
    authenticatedCookies.set(project, await page.context().cookies());
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
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(page.locator('.board-marquee')).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await expect(page.locator('.board-marquee')).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
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

async function labelPoint(page: Page, id: string) {
  return object(page, id)
    .locator('.board-element-name')
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      return {
        x: rect.x + Math.min(rect.width / 2, 20),
        y: rect.y + rect.height / 2,
      };
    });
}
async function dragFrom(
  page: Page,
  start: { x: number; y: number },
  dx: number,
  dy: number,
) {
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 });
  await expect(page.getByLabel('Object name', { exact: true })).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved(page);
}
function expectTranslation(
  before: BoardDocument,
  after: BoardDocument,
  ids: string[],
  dx: number,
  dy: number,
) {
  for (const element of before.elements) {
    const moved = after.elements.find((item) => item.id === element.id)!;
    expect(moved.x).toBeCloseTo(
      element.x + (ids.includes(element.id) ? dx : 0),
    );
    expect(moved.y).toBeCloseTo(
      element.y + (ids.includes(element.id) ? dy : 0),
    );
    expect({ ...moved, x: element.x, y: element.y }).toEqual(element);
  }
  expect(after.ports).toEqual(before.ports);
  expect(after.cables).toEqual(before.cables);
}

test('device body and title grabs move the whole selection without accidental renaming', async ({
  page,
}, info) => {
  const initial = await setup(page),
    ids = ['network', 'router', 'summary', 'switch'];
  await marquee(page, { x: 60, y: 80 }, { x: 750, y: 600 });
  await expect(selected(page)).toHaveCount(4);
  let before = (await read(page, initial.id)).document;
  const box = (await object(page, 'router').boundingBox())!;
  const body = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.7 };
  // Clicking an already-selected member must not discard the marquee group.
  await page.mouse.click(body.x, body.y);
  expect(await selectedIds(page)).toEqual(ids);
  await dragFrom(page, body, 40, 24);
  let after = (await read(page, initial.id)).document;
  expectTranslation(before, after, ids, 40, 24);
  expect(await selectedIds(page)).toEqual(ids);
  before = after;
  await dragFrom(page, await labelPoint(page, 'router'), 35, -12);
  after = (await read(page, initial.id)).document;
  expectTranslation(before, after, ids, 35, -12);
  expect(await selectedIds(page)).toEqual(ids);
  for (const id of ['network', 'summary']) {
    before = after;
    await dragFrom(page, await labelPoint(page, id), 10, 8);
    after = (await read(page, initial.id)).document;
    expectTranslation(before, after, ids, 10, 8);
    expect(await selectedIds(page)).toEqual(ids);
  }
  const label = await labelPoint(page, 'router');
  await page.mouse.click(label.x, label.y);
  await expect(page.getByLabel('Object name', { exact: true })).toHaveCount(0);
  expect(await selectedIds(page)).toEqual(ids);
  before = after;
  const chip = (await object(page, 'router')
    .locator('.board-device-info-chip')
    .first()
    .boundingBox())!;
  await dragFrom(
    page,
    { x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 },
    -15,
    16,
  );
  after = (await read(page, initial.id)).document;
  expectTranslation(before, after, ids, -15, 16);
  expect(await selectedIds(page)).toEqual(ids);
  await page.screenshot({
    path: info.outputPath('group-moved-from-body-title-and-chip.png'),
  });
  await page.keyboard.press('Escape');
  const singleLabel = await labelPoint(page, 'router');
  await page.mouse.click(singleLabel.x, singleLabel.y);
  const input = page.getByLabel('Object name', { exact: true });
  await expect(input).toBeVisible();
  await input.fill('Renamed router');
  await input.press('Enter');
  await saved(page);
  await object(page, 'router')
    .getByRole('button', { name: 'Rename object Renamed router', exact: true })
    .press('F2');
  await expect(input).toHaveValue('Renamed router');
  await input.press('Escape');
  before = (await read(page, initial.id)).document;
  await dragFrom(page, await labelPoint(page, 'router'), 20, 16);
  after = (await read(page, initial.id)).document;
  expectTranslation(before, after, ['router'], 20, 16);
  const controlsBefore = (await read(page, initial.id)).document;
  for (const control of [
    object(page, 'router').getByRole('button', { name: 'Rear', exact: true }),
    page.locator(`button[data-port-id="${controlsBefore.ports[0]!.id}"]`),
  ]) {
    const rect = (await control.boundingBox())!;
    await dragFrom(
      page,
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      64,
      30,
    );
    expect((await read(page, initial.id)).document).toEqual(controlsBefore);
  }
  const address = page
    .getByRole('complementary', { name: 'Object inspector', exact: true })
    .getByLabel('Management address', { exact: true });
  await address.fill('router.example');
  await saved(page);
  expect(positions((await read(page, initial.id)).document)).toEqual(
    positions(controlsBefore),
  );
  const doubleLabel = await labelPoint(page, 'router');
  await page.mouse.dblclick(doubleLabel.x, doubleLabel.y);
  await expect(page.getByLabel('Object name', { exact: true })).toBeVisible();
  await page.getByLabel('Object name', { exact: true }).press('Escape');
});

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
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
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
  await clickObject(page, 'router');
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
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
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
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
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
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
  const box = (await object(page, 'router').boundingBox())!;
  const body = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.7 };
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    modifiers: 1,
    touchPoints: [{ x: body.x, y: body.y }],
  });
  for (let step = 1; step <= 6; step++)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      modifiers: 1,
      touchPoints: [
        { x: body.x + (14 * step) / 6, y: body.y + (7 * step) / 6 },
      ],
    });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    modifiers: 1,
    touchPoints: [],
  });
  await saved(page);
  expect((await read(page, initial.id)).document.elements).toEqual(
    after.elements,
  );
  await expect(object(page, 'router')).toHaveAttribute('data-selected', 'true');
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
  const handle = (await page
    .getByRole('button', { name: 'Move Router', exact: true })
    .boundingBox())!;
  const handleStart = {
    x: handle.x + handle.width / 2,
    y: handle.y + handle.height / 2,
  };
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    modifiers: 1,
    touchPoints: [handleStart],
  });
  for (let step = 1; step <= 6; step++)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      modifiers: 1,
      touchPoints: [
        {
          x: handleStart.x + (14 * step) / 6,
          y: handleStart.y + (7 * step) / 6,
        },
      ],
    });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    modifiers: 1,
    touchPoints: [],
  });
  await saved(page);
  expectTranslation(
    after,
    (await read(page, initial.id)).document,
    ['router'],
    40,
    20,
  );
  await expect(page.getByLabel('Object name', { exact: true })).toHaveCount(0);
  const close = page.getByRole('button', {
    name: 'Close inspector',
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  await page.locator(`button[data-port-id="${before.ports[0]!.id}"]`).tap();
  await expect(page.getByLabel('PVID', { exact: true })).toBeVisible();
});

test('narrow devices keep body and actual title drag targets usable at half, normal and high zoom', async ({
  page,
}, info) => {
  const document = fixture(0.5);
  document.elements = document.elements.map((element) =>
    element.id === 'outside'
      ? element
      : {
          ...element,
          x: element.id === 'switch' || element.id === 'summary' ? 300 : 40,
          width: 190,
        },
  );
  const initial = await setup(page, document),
    ids = ['network', 'router', 'summary', 'switch'];
  for (const zoom of [0.5, 1, 1.5]) {
    const current = await read(page, initial.id);
    const auth = await (await page.request.get('/api/v1/auth/session')).json();
    const response = await page.request.patch(`/api/v1/boards/${initial.id}`, {
      headers: {
        Origin: new URL(page.url()).origin,
        'x-csrf-token': auth.csrfToken,
      },
      data: {
        rowVersion: current.rowVersion,
        document: { ...current.document, viewport: { x: 40, y: 40, zoom } },
      },
    });
    expect(response.status()).toBe(200);
    await page.reload();
    await saved(page);
    const collapse = page.getByRole('button', {
      name: 'Collapse board browser',
      exact: true,
    });
    if (await collapse.isVisible()) await collapse.click();
    const before = (await read(page, initial.id)).document;
    const members = before.elements.filter((element) =>
      ids.includes(element.id),
    );
    const left = Math.min(...members.map((element) => element.x)) - 10;
    const top = Math.min(...members.map((element) => element.y)) - 10;
    const right =
      Math.max(...members.map((element) => element.x + element.width)) + 10;
    const bottom =
      Math.max(...members.map((element) => element.y + element.height)) + 10;
    await marquee(
      page,
      { x: 40 + left * zoom, y: 40 + top * zoom },
      { x: 40 + right * zoom, y: 40 + bottom * zoom },
    );
    expect(await selectedIds(page)).toEqual(ids);
    const box = (await object(page, 'router').boundingBox())!;
    await dragFrom(
      page,
      { x: box.x + box.width * 0.7, y: box.y + box.height * 0.75 },
      20 * zoom,
      12 * zoom,
    );
    let after = (await read(page, initial.id)).document;
    expectTranslation(before, after, ids, 20, 12);
    const bodyMoved = after;
    await dragFrom(
      page,
      await labelPoint(page, 'router'),
      -12 * zoom,
      8 * zoom,
    );
    after = (await read(page, initial.id)).document;
    expectTranslation(bodyMoved, after, ids, -12, 8);
    expect(await selectedIds(page)).toEqual(ids);
    await page.screenshot({
      path: info.outputPath(`narrow-body-title-${zoom}.png`),
    });
  }
});

test('touch background navigation keeps mouse title editing and deliberate touch configuration', async ({
  page,
  context,
}, info) => {
  const document = fixture(0.49);
  document.elements = [
    {
      ...document.elements[0]!,
      name: 'Edge switch',
      x: 100,
      y: 100,
      width: 600,
      height: 220,
      properties: {
        deviceType: 'Switch',
        managementAddress: '2001:db8::2, switch.example.test',
      },
    },
  ];
  document.ports = Array.from({ length: 8 }, (_, column) =>
    makeBoardPort('router', 'rj45', 0, column, `Port ${column + 1}`),
  );
  document.cables = [];
  const initial = await setup(page, document);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const before = (await read(page, initial.id)).document;
  expect(before.viewport.zoom).toBeLessThan(0.6);
  await object(page, 'router').locator('.board-element-name').dblclick();
  const input = page.getByLabel('Object name', { exact: true });
  await expect(input).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
  await input.fill('Double-click renamed');
  await input.press('Enter');
  await saved(page);
  let after = (await read(page, initial.id)).document;
  expect(after.elements[0]!.name).toBe('Double-click renamed');
  expect(positions(after)).toEqual(positions(before));
  expect(after.ports).toEqual(before.ports);
  await object(page, 'router').locator('.board-element-name').tap();
  await expect(input).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Object inspector', exact: true }),
  ).toHaveCount(0);
  await expect(object(page, 'router')).toHaveAttribute('data-selected', 'true');
  await page
    .getByRole('button', {
      name: 'Configure Double-click renamed',
      exact: true,
    })
    .tap();
  const configuration = page.getByRole('complementary', {
    name: 'Object inspector',
    exact: true,
  });
  await expect(configuration).toBeVisible();
  await page.screenshot({
    path: info.outputPath('low-zoom-mobile-title-configuration.png'),
  });
  await configuration.getByLabel('Name', { exact: true }).fill('Tapped name');
  await configuration
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await saved(page);
  after = (await read(page, initial.id)).document;
  expect(after.elements[0]!.name).toBe('Tapped name');
  expect(positions(after)).toEqual(positions(before));
  expect(after.ports).toEqual(before.ports);
  const handle = (await page
      .getByRole('button', { name: 'Move Tapped name', exact: true })
      .boundingBox())!,
    start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
    client = await context.newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    modifiers: 1,
    touchPoints: [{ x: start.x, y: start.y }],
  });
  for (let step = 1; step <= 6; step++)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      modifiers: 1,
      touchPoints: [
        { x: start.x + (14 * step) / 6, y: start.y + (7 * step) / 6 },
      ],
    });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    modifiers: 1,
    touchPoints: [],
  });
  await saved(page);
  await expect(input).toHaveCount(0);
  expectTranslation(
    after,
    (await read(page, initial.id)).document,
    ['router'],
    14 / before.viewport.zoom,
    7 / before.viewport.zoom,
  );
});
