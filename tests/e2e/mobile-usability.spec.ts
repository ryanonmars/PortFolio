import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
const sessions = new Map<
  string,
  Awaited<ReturnType<BrowserContext['cookies']>>
>();
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
const sheet = (page: Page) => page.locator('.board-mobile-sheet');
const object = (page: Page, id: string) =>
  page.locator(`[data-board-element-id="${id}"]`);
const socket = (page: Page, id = 'router-0') =>
  page.locator(`button[data-port-id="${id}"]`);
const menu = (page: Page) => page.getByRole('menu', { name: 'Port actions' });
const isTouch = () => Boolean(test.info().project.use.hasTouch);
const isChromium = () => test.info().project.use.browserName !== 'webkit';
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const current: string[] = [];
  errors.set(page, current);
  page.on('pageerror', (error) => current.push(error.message));
  page.on('console', (message) => {
    if (/ResizeObserver loop/i.test(message.text()))
      current.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

function fixture(): BoardDocument {
  const doc = emptyBoardDocument();
  doc.viewport = { x: 10, y: 10, zoom: isTouch() ? 0.65 : 1 };
  doc.elements = [
    {
      id: 'router',
      type: 'device',
      name: 'Touch router',
      x: 24,
      y: 140,
      width: 440,
      height: 220,
      z: 0,
      color: '',
      properties: {
        manufacturer: 'Synthetic',
        model: 'R4',
        deviceType: 'Router',
        notes: 'Existing device notes',
      },
    },
    {
      id: 'switch',
      type: 'device',
      name: 'Touch switch',
      x: 24,
      y: 420,
      width: 440,
      height: 220,
      z: 1,
      color: '',
      properties: { deviceType: 'Switch' },
    },
    {
      id: 'network',
      type: 'network',
      name: 'Touch network',
      x: 520,
      y: 140,
      width: 360,
      height: 240,
      z: 2,
      color: '',
      properties: {
        entries: [
          {
            vlanId: '20',
            vlanName: 'Server',
            subnet: '192.0.2.0/24',
            color: '#488ded',
          },
        ],
      },
    },
    {
      id: 'summary',
      type: 'summary',
      name: 'Touch summary',
      x: 520,
      y: 440,
      width: 400,
      height: 300,
      z: 3,
      color: '',
      properties: { linkedDeviceId: 'router' },
    },
  ];
  doc.ports = ['router', 'switch'].flatMap((deviceId) =>
    Array.from({ length: 4 }, (_, column) => ({
      ...makeBoardPort(
        deviceId,
        column === 3 ? 'sfp_plus' : 'rj45',
        0,
        column,
        `Port ${column + 1}`,
      ),
      id: `${deviceId}-${column}`,
      role: column === 0 ? 'LAN trunk' : 'Server',
      nativeVlan: '0',
      pvid: '0',
      speed: '1G',
    })),
  );
  doc.cables = [
    {
      id: 'stable-cable',
      sourcePortId: 'router-0',
      targetPortId: 'switch-0',
      name: 'Documented uplink',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    },
  ];
  return doc;
}
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
  return (await (await page.request.get(`/api/v1/boards/${id}`)).json()).board;
}
async function setup(page: Page) {
  const project = test.info().project.name;
  if (sessions.has(project))
    await page.context().addCookies(sessions.get(project)!);
  await page.goto('/');
  if (!sessions.has(project)) {
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
  sessions.set(project, await page.context().cookies());
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': session.csrfToken,
    },
    data: {
      name: `Mobile usability ${randomUUID().slice(0, 8)}`,
      document: fixture(),
    },
  });
  expect(response.status()).toBe(201);
  const board = (await response.json()).board as BoardRecord;
  await page.goto(`/boards/${board.id}`);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await saved(page);
  return board;
}
async function boundsWithinViewport(target: Locator, page: Page) {
  const rect = (await target.boundingBox())!;
  const viewport = await page.evaluate(() => ({
    top: window.visualViewport?.offsetTop ?? 0,
    left: window.visualViewport?.offsetLeft ?? 0,
    width: window.visualViewport?.width ?? innerWidth,
    height: window.visualViewport?.height ?? innerHeight,
  }));
  expect(rect.x).toBeGreaterThanOrEqual(viewport.left - 1);
  expect(rect.y).toBeGreaterThanOrEqual(viewport.top - 1);
  expect(rect.x + rect.width).toBeLessThanOrEqual(
    viewport.left + viewport.width + 1,
  );
  expect(rect.y + rect.height).toBeLessThanOrEqual(
    viewport.top + viewport.height + 1,
  );
  expect(
    await target.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
}
async function tapContainer(page: Page, id: string) {
  const target = object(page, id);
  const box = (await target.locator('.board-element-header').boundingBox())!;
  if (id === 'summary') await target.locator('.board-summary-content').tap();
  else if (id === 'network')
    await target.locator('.board-network-summary').tap();
  else
    await target
      .locator('.board-element-header')
      .tap({ position: { x: 3, y: Math.max(1, box.height - 3) } });
  await expect(target).toHaveAttribute('data-selected', 'true');
  await expect(inspector(page)).toHaveCount(0);
}
async function configure(page: Page, name = 'Touch router') {
  await page
    .getByRole('button', { name: `Configure ${name}`, exact: true })
    .tap();
  await expect(inspector(page)).toBeVisible();
  await expect(sheet(page)).toBeVisible();
}
async function closeInspector(page: Page) {
  await inspector(page)
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await expect(inspector(page)).toHaveCount(0);
}
async function drag(
  page: Page,
  handle: Locator,
  dx: number,
  dy: number,
  screenshot?: string,
) {
  const rect = (await handle.boundingBox())!;
  const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (isChromium() && isTouch()) {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    for (let i = 1; i <= 6; i++)
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x + (dx * i) / 6, y: start.y + (dy * i) / 6 }],
      });
    if (screenshot)
      await page.screenshot({ path: test.info().outputPath(screenshot) });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await client.detach();
  } else {
    // WebKit exposes native tap but no touch-swipe API. Verify handle geometry
    // with its pointer path here; real iPhone touch/keyboard signoff stays manual.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 });
    if (screenshot)
      await page.screenshot({ path: test.info().outputPath(screenshot) });
    await page.mouse.up();
  }
}
async function contextMenu(page: Page, id: string) {
  const port = socket(page, id),
    box = (await port.boundingBox())!;
  if (isChromium()) {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    await expect(menu(page)).toBeVisible();
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await client.detach();
  } else await port.click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await boundsWithinViewport(menu(page), page);
}

async function pinchDuringTouch(page: Page, target: Locator) {
  const client = await page.context().newCDPSession(page);
  const anchor = (await target.boundingBox())!;
  const first = {
    x: anchor.x + anchor.width / 2,
    y: anchor.y + anchor.height / 2,
    id: 1,
  };
  const moved = { ...first, x: first.x + 12, y: first.y + 8 };
  const second = {
    x: page.viewportSize()!.width - 20,
    y: page.viewportSize()!.height - 30,
    id: 2,
  };
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [first],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [moved],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [moved, second],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [moved, { ...second, x: second.x - 12, y: second.y - 20 }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await client.detach();
}

test('touch selection and handle movement preserve ports, cables, undo and autosave', async ({
  page,
}) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  await page.screenshot({ path: test.info().outputPath('normal-board.png') });
  await tapContainer(page, 'router');
  const move = page.getByRole('button', {
    name: 'Move Touch router',
    exact: true,
  });
  const moveBounds = (await move.boundingBox())!;
  expect(moveBounds.width).toBeGreaterThanOrEqual(44);
  expect(moveBounds.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: test.info().outputPath('selected-container.png'),
  });
  if (isChromium()) {
    await pinchDuringTouch(page, move);
    await saved(page);
    const interrupted = (await read(page, board.id)).document;
    expect(interrupted.elements).toEqual(before.elements);
    expect(interrupted.ports).toEqual(before.ports);
    expect(interrupted.cables).toEqual(before.cables);
    await expect(object(page, 'router')).toHaveAttribute(
      'data-selected',
      'true',
    );
    await expect(inspector(page)).toHaveCount(0);
  }
  await drag(page, move, 32, 24, 'container-moving.png');
  await saved(page);
  const after = (await read(page, board.id)).document;
  expect(after.elements[0]!.x).not.toBe(before.elements[0]!.x);
  expect(after.elements[0]!.y).not.toBe(before.elements[0]!.y);
  expect(after.ports).toEqual(before.ports);
  expect(after.cables).toEqual(before.cables);
  await expect(inspector(page)).toHaveCount(0);
  await configure(page);
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);
  await expect(object(page, 'router')).toHaveAttribute('data-selected', 'true');
  expect((await read(page, board.id)).document.viewport).toEqual(
    after.viewport,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, board.id)).document.elements).toEqual(
    before.elements,
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  await page.reload();
  await saved(page);
  expect((await read(page, board.id)).document.elements).toEqual(
    after.elements,
  );
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  for (const id of ['network', 'summary']) {
    await tapContainer(page, id);
    await configure(page, `Touch ${id}`);
    await closeInspector(page);
    await expect(object(page, id)).toHaveAttribute('data-selected', 'true');
  }
  if (isChromium()) {
    const beforeScroll = (await read(page, board.id)).document;
    const content = object(page, 'summary').locator('.board-summary-content');
    const oldScroll = await content.evaluate((node) => node.scrollTop);
    await drag(page, content, 0, -14, 'summary-scrolling.png');
    await expect
      .poll(() => content.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(oldScroll);
    await tapContainer(page, 'router');
    await saved(page);
    const afterScroll = (await read(page, board.id)).document;
    expect(afterScroll).toEqual(beforeScroll);
    await tapContainer(page, 'summary');
    await pinchDuringTouch(page, content);
    await saved(page);
    const pinched = (await read(page, board.id)).document;
    expect(pinched.elements).toEqual(beforeScroll.elements);
    expect(pinched.ports).toEqual(beforeScroll.ports);
    expect(pinched.cables).toEqual(beforeScroll.cables);
    expect(pinched.viewport.zoom).not.toBe(beforeScroll.viewport.zoom);
    await tapContainer(page, 'router');
  }
});

test('sheet expands, scrolls and fits a simulated keyboard without changing the board viewport', async ({
  page,
}) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  await tapContainer(page, 'router');
  await configure(page);
  const half = (await sheet(page).boundingBox())!;
  expect(half.height / page.viewportSize()!.height).toBeGreaterThan(0.45);
  expect(half.height / page.viewportSize()!.height).toBeLessThan(0.7);
  await boundsWithinViewport(sheet(page), page);
  expect(
    (await inspector(page).locator(':scope > header').boundingBox())!.height,
  ).toBeLessThanOrEqual(46);
  await expect(inspector(page).locator(':scope > footer')).toHaveCount(0);
  const actions = inspector(page).locator('.board-inspector-body > footer');
  await expect(
    actions.getByRole('button', { name: 'Duplicate', exact: true }),
  ).toHaveCount(1);
  await expect(
    actions.getByRole('button', { name: 'Delete device', exact: true }),
  ).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath('half-height-inspector.png'),
  });
  const handle = sheet(page).locator('.board-mobile-sheet-handle');
  await drag(page, handle, 0, -page.viewportSize()!.height * 0.4);
  await expect
    .poll(async () => (await sheet(page).boundingBox())!.height)
    .toBeGreaterThan(half.height + 20);
  await actions
    .getByRole('button', { name: 'Duplicate', exact: true })
    .scrollIntoViewIfNeeded();
  await boundsWithinViewport(actions, page);
  await page.screenshot({
    path: test.info().outputPath('expanded-inspector.png'),
  });
  const notes = inspector(page).getByLabel('Notes', { exact: true });
  await notes.fill('Mobile notes near the end of a long inspector');
  await notes.focus();
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  await page.evaluate(() => {
    // Safari can report its reduced visual viewport after focus without
    // delivering a resize at the time an editing surface needs to adjust.
    setTimeout(() => {
      Object.defineProperty(window.visualViewport!, 'height', {
        configurable: true,
        get: () => Math.round(innerHeight * 0.58),
      });
    }, 120);
  });
  await expect
    .poll(
      async () =>
        (await sheet(page).boundingBox())!.y +
        (await sheet(page).boundingBox())!.height,
    )
    .toBeLessThanOrEqual(Math.round(page.viewportSize()!.height * 0.58) + 1);
  await boundsWithinViewport(sheet(page), page);
  await expect(notes).toHaveCSS('font-size', '16px');
  await expect
    .poll(async () => {
      const input = (await notes.boundingBox())!,
        body = (await inspector(page)
          .locator('.board-inspector-body')
          .boundingBox())!;
      return (
        input.y >= body.y - 1 &&
        input.y + input.height <= body.y + body.height + 1
      );
    })
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath('simulated-keyboard-inspector.png'),
  });
  expect((await read(page, board.id)).document.viewport).toEqual(
    before.viewport,
  );
  // Reproduce the measured iPhone orientation failure: Safari temporarily
  // reported only 14px of visual height. A readable focus row must survive
  // those bad metrics; this does not simulate the OS keyboard's occlusion.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', {
      configurable: true,
      get: () => 14,
    });
    window.dispatchEvent(new Event('orientationchange'));
  });
  await expect
    .poll(async () => (await sheet(page).boundingBox())!.height)
    .toBeLessThanOrEqual(100);
  await expect
    .poll(async () => (await sheet(page).boundingBox())!.height)
    .toBeGreaterThanOrEqual(56);
  await expect
    .poll(async () => {
      const frame = (await sheet(page).boundingBox())!;
      const field = (await notes.boundingBox())!;
      return (
        field.height >= 44 &&
        field.y >= frame.y - 1 &&
        field.y + field.height <= frame.y + frame.height + 1
      );
    })
    .toBe(true);
  const close = inspector(page).getByRole('button', {
    name: 'Close inspector',
    exact: true,
  });
  await expect(close).toBeVisible();
  const focusFrame = (await sheet(page).boundingBox())!,
    closeBounds = (await close.boundingBox())!;
  expect(closeBounds.height).toBeGreaterThanOrEqual(44);
  expect(closeBounds.y).toBeGreaterThanOrEqual(focusFrame.y - 1);
  expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(
    focusFrame.y + focusFrame.height + 1,
  );
  expect((await read(page, board.id)).document.viewport).toEqual(
    before.viewport,
  );
  await page.screenshot({
    path: test.info().outputPath('safari-tiny-viewport-focus-row.png'),
  });
  await page.evaluate(() => {
    setTimeout(() => {
      Object.defineProperty(window.visualViewport!, 'height', {
        configurable: true,
        get: () => Math.round(innerHeight * 0.58),
      });
    }, 120);
  });
  await expect
    .poll(async () => (await sheet(page).boundingBox())!.height)
    .toBeGreaterThan(100);
  await expect(handle).toBeVisible();
  expect(
    (await inspector(page).locator(':scope > header').boundingBox())!.height,
  ).toBeLessThanOrEqual(46);
  await boundsWithinViewport(sheet(page), page);
  await page.screenshot({
    path: test.info().outputPath('safari-viewport-recovered.png'),
  });
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, 'height');
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(async () => (await sheet(page).boundingBox())!.height)
    .toBeGreaterThan(half.height + 20);
  const meta = await page
    .locator('meta[name="viewport"]')
    .getAttribute('content');
  expect(meta).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/i);
  await drag(page, handle, 0, page.viewportSize()!.height * 0.4);
  await expect
    .poll(async () => (await sheet(page).boundingBox())!.height)
    .toBeLessThan(page.viewportSize()!.height * 0.7);
  await drag(page, handle, 0, page.viewportSize()!.height * 0.6);
  await expect(sheet(page)).toHaveCount(0);
  await expect(object(page, 'router')).toHaveAttribute('data-selected', 'true');
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements[0]!.properties.notes,
  ).toBe('Mobile notes near the end of a long inspector');

  // Custom field names commit on blur. Outside navigation must flush that
  // draft before unmounting the inspector, including native touch taps.
  await configure(page);
  const custom = inspector(page)
    .locator('details')
    .filter({
      has: page.locator('summary', { hasText: /^Custom fields$/ }),
    });
  await custom.locator('summary').scrollIntoViewIfNeeded();
  await custom.locator('summary').tap();
  await custom
    .getByRole('button', { name: 'Add custom field', exact: true })
    .tap();
  await saved(page);
  const customName = custom.getByRole('textbox', {
    name: 'Custom field name',
    exact: true,
  });
  await customName.fill('Draft before Explorer');
  await expect(customName).toBeFocused();
  expect(
    (await read(page, board.id)).document.elements[0]!.properties.customFields,
  ).toEqual({ 'Field 1': '' });
  await page
    .getByRole('button', { name: 'Open board browser', exact: true })
    .tap();
  await expect(sheet(page)).toHaveCount(0);
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements[0]!.properties.customFields,
  ).toEqual({ 'Draft before Explorer': '' });
  await page.keyboard.press('Escape');
  await configure(page);
  await custom.locator('summary').scrollIntoViewIfNeeded();
  await custom.locator('summary').tap();
  await customName.fill('Draft before Close');
  await expect(customName).toBeFocused();
  await inspector(page)
    .getByRole('button', { name: 'Close inspector', exact: true })
    .tap();
  await expect(sheet(page)).toHaveCount(0);
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements[0]!.properties.customFields,
  ).toEqual({ 'Draft before Close': '' });
  await page.reload();
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements[0]!.properties.customFields,
  ).toEqual({ 'Draft before Close': '' });
});

test('Explorer, Equipment Dock and creation actions fit the mobile viewport and dismiss conflicting overlays', async ({
  page,
  browser,
}) => {
  const board = await setup(page);
  const explorer = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  await page.getByRole('button', { name: 'Add object', exact: true }).tap();
  const dock = page.getByRole('dialog', {
    name: 'Equipment Dock',
    exact: true,
  });
  await expect(dock).toBeVisible();
  await boundsWithinViewport(dock, page);
  await expect(explorer).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('equipment-dock.png') });
  await explorer.tap();
  await expect(dock).toHaveCount(0);
  await expect(page.locator('.board-browser')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.board-browser')).not.toBeVisible();
  await expect(explorer).toBeFocused();
  await explorer.tap();
  await expect(
    page.getByRole('searchbox', { name: 'Find board', exact: true }),
  ).toHaveCSS('font-size', '16px');
  await page.screenshot({ path: test.info().outputPath('explorer.png') });
  await page.getByRole('button', { name: 'Add board', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New board', exact: true });
  await boundsWithinViewport(dialog, page);
  await expect(dialog.getByLabel('Board name', { exact: true })).toHaveCSS(
    'font-size',
    '16px',
  );
  await page.screenshot({
    path: test.info().outputPath('new-board-dialog.png'),
  });
  const name = `Created on mobile ${randomUUID().slice(0, 6)}`;
  const nameInput = dialog.getByLabel('Board name', { exact: true });
  await nameInput.focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', {
      configurable: true,
      get: () => 14,
    });
    window.dispatchEvent(new Event('orientationchange'));
  });
  await expect
    .poll(async () => (await dialog.boundingBox())!.height)
    .toBeLessThanOrEqual(100);
  await expect
    .poll(async () => (await dialog.boundingBox())!.height)
    .toBeGreaterThanOrEqual(56);
  await nameInput.fill(name);
  const cramped = (await dialog.boundingBox())!;
  for (const control of [
    nameInput,
    dialog.getByRole('button', { name: 'Create board', exact: true }),
    dialog.getByRole('button', { name: 'Close dialog', exact: true }),
  ]) {
    await expect(control).toBeVisible();
    const controlBounds = (await control.boundingBox())!;
    expect(controlBounds.height).toBeGreaterThanOrEqual(44);
    expect(controlBounds.x).toBeGreaterThanOrEqual(cramped.x - 1);
    expect(controlBounds.x + controlBounds.width).toBeLessThanOrEqual(
      cramped.x + cramped.width + 1,
    );
    expect(controlBounds.y).toBeGreaterThanOrEqual(cramped.y - 1);
    expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(
      cramped.y + cramped.height + 1,
    );
  }
  await page.screenshot({
    path: test.info().outputPath('safari-tiny-new-board-dialog.png'),
  });
  await page.evaluate(() => {
    setTimeout(
      () => Reflect.deleteProperty(window.visualViewport!, 'height'),
      120,
    );
  });
  await expect
    .poll(async () => (await dialog.boundingBox())!.height)
    .toBeGreaterThan(100);
  await expect(nameInput).toHaveValue(name);
  await expect(
    dialog.getByRole('heading', { name: 'New board', exact: true }),
  ).toBeVisible();
  await boundsWithinViewport(dialog, page);
  await dialog
    .getByRole('button', { name: 'Create board', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(name);
  await expect(dialog).toHaveCount(0);
  await explorer.tap();
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  const group = page.getByRole('dialog', { name: 'New group', exact: true });
  await boundsWithinViewport(group, page);
  await group
    .getByLabel('Group name', { exact: true })
    .fill(`Mobile group ${randomUUID().slice(0, 6)}`);
  await group
    .getByRole('button', { name: 'Create group', exact: true })
    .click();
  await expect(group).toHaveCount(0);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await page.getByRole('button', { name: 'Add object', exact: true }).tap();
  await dock.getByRole('button', { name: 'Device', exact: true }).tap();
  await boundsWithinViewport(dock, page);
  await page.screenshot({
    path: test.info().outputPath('new-device-picker.png'),
  });
  await dock.getByRole('button', { name: 'Router', exact: true }).tap();
  await expect(dock).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();
  await boundsWithinViewport(sheet(page), page);
  await inspector(page)
    .getByLabel('Name', { exact: true })
    .fill('Mobile-created router');
  await saved(page);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Add object', exact: true }).tap();
  await dock.getByRole('button', { name: 'Network', exact: true }).tap();
  await expect(dock).toHaveCount(0);
  await inspector(page)
    .getByLabel('Network container name', { exact: true })
    .fill('Mobile-created network');
  await saved(page);
  await closeInspector(page);
  await explorer.tap();
  await page
    .getByRole('navigation', { name: 'Boards', exact: true })
    .getByRole('button', { name: board.name, exact: true })
    .click();
  await expect(page.locator('.board-browser')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(board.name);
  const anonymous = await browser.newContext({
    viewport: page.viewportSize()!,
    hasTouch: true,
    isMobile: true,
    userAgent: await page.evaluate(() => navigator.userAgent),
  });
  const login = await anonymous.newPage();
  await login.goto(new URL(page.url()).origin);
  await expect(login.getByLabel('Username', { exact: true })).toHaveCSS(
    'font-size',
    '16px',
  );
  await expect(login.getByLabel('Password', { exact: true })).toHaveCSS(
    'font-size',
    '16px',
  );
  await anonymous.close();
});

test('port inspection and context menus remain independent from container handles and cable creation', async ({
  page,
}) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  await socket(page).tap();
  await expect(
    inspector(page).getByLabel('Port Purpose', { exact: true }),
  ).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  await closeInspector(page);
  if (isChromium()) {
    await page
      .getByRole('button', { name: 'Edit port layout', exact: true })
      .tap();
    const current = (await read(page, board.id)).document;
    const originalPort = current.ports.find((port) => port.id === 'router-2')!;
    const grip = object(page, 'router').getByRole('button', {
      name: 'Move Port 3',
      exact: true,
    });
    const box = (await grip.boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const distance = 2 * 72 * current.viewport.zoom;
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [start],
      });
      for (let step = 1; step <= 6; step++)
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start.x + (distance * step) / 6, y: start.y }],
        });
      await expect(sheet(page)).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath('port-layout-touch-drag.png'),
      });
    } finally {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();
    }
    await saved(page);
    const moved = (await read(page, board.id)).document;
    expect(moved.ports.find((port) => port.id === originalPort.id)).toEqual({
      ...originalPort,
      column: 4,
    });
    expect(moved.cables).toEqual(current.cables);
    await expect(sheet(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await saved(page);
    expect((await read(page, board.id)).document.ports).toEqual(current.ports);
    if (await inspector(page).count()) await closeInspector(page);
    await page
      .getByRole('button', { name: 'Edit port layout', exact: true })
      .tap();
  }
  await contextMenu(page, 'router-0');
  await expect(inspector(page)).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('port-context-menu.png'),
  });
  await menu(page)
    .getByRole('menuitem', { name: 'Copy Port Settings', exact: true })
    .click();
  await contextMenu(page, 'router-1');
  await menu(page)
    .getByRole('menuitem', { name: 'Paste Settings', exact: true })
    .click();
  await saved(page);
  const copied = (await read(page, board.id)).document;
  expect(copied.ports.find((port) => port.id === 'router-1')!.role).toBe(
    'LAN trunk',
  );
  expect(copied.cables).toEqual(before.cables);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page.getByRole('button', { name: 'Add object', exact: true }).tap();
  await page
    .getByRole('dialog', { name: 'Equipment Dock' })
    .getByRole('button', { name: 'Cable', exact: true })
    .tap();
  await expect(page.getByTestId('board-canvas')).toHaveClass(/tool-cable/);
  await socket(page, 'router-2').tap();
  await expect(socket(page, 'router-2').locator('..')).toHaveAttribute(
    'data-cable-source',
    'true',
  );
  await socket(page, 'switch-2').tap();
  await saved(page);
  const after = (await read(page, board.id)).document;
  expect(after.cables).toHaveLength(before.cables.length + 1);
  expect(after.cables[0]).toEqual(before.cables[0]);
  expect(after.ports).toEqual(copied.ports);
  await expect(
    inspector(page).getByRole('button', { name: 'Delete cable', exact: true }),
  ).toBeVisible();
  await expect(sheet(page)).toBeVisible();
});

test('desktop container click inspection and body dragging keep their existing behavior', async ({
  page,
}) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  await object(page, 'router')
    .locator('.board-element-header')
    .click({ position: { x: 4, y: 75 } });
  await expect(inspector(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await closeInspector(page);
  const body = object(page, 'router');
  const rect = (await body.boundingBox())!;
  await page.mouse.move(rect.x + rect.width - 30, rect.y + rect.height - 30);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width + 10, rect.y + rect.height - 6, {
    steps: 6,
  });
  await page.mouse.up();
  await saved(page);
  const after = (await read(page, board.id)).document;
  expect(after.elements[0]!.x).not.toBe(before.elements[0]!.x);
  expect(after.ports).toEqual(before.ports);
  expect(after.cables).toEqual(before.cables);
});
