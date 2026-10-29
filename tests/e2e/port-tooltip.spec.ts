import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
const cookies = new Map<
  string,
  Awaited<ReturnType<BrowserContext['cookies']>>
>();
const mobile = () => test.info().project.name.startsWith('mobile');
const card = (page: Page) =>
  page.locator('.board-port-tooltip[role="tooltip"]');
const socket = (page: Page, id = 'source-0') =>
  page.locator(`button[data-port-id="${id}"]`);
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Port actions' });
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/ResizeObserver loop/i.test(message.text()))
      errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

function fixture(long = false): BoardDocument {
  const document = emptyBoardDocument();
  document.viewport = { x: 20, y: 20, zoom: mobile() ? 0.34 : 1 };
  document.elements = [
    {
      id: 'router',
      type: 'device',
      name: 'Synthetic eight-port router',
      x: 20,
      y: 100,
      width: 660,
      height: 240,
      z: 0,
      color: '',
      properties: {
        manufacturer: 'Synthetic',
        model: 'R8',
        deviceType: 'Router',
      },
    },
    {
      id: 'switch',
      type: 'device',
      name: 'Synthetic 24-port switch',
      x: 20,
      y: 410,
      width: 1000,
      height: 360,
      z: 1,
      color: '',
      properties: {
        manufacturer: 'Synthetic',
        model: 'S24',
        deviceType: 'Switch',
      },
    },
    {
      id: 'network',
      type: 'network',
      name: 'Synthetic network',
      x: 740,
      y: 100,
      width: 550,
      height: 250,
      z: 2,
      color: '',
      properties: {
        displayFields: ['vlanId', 'vlanName', 'subnet', 'gateway'],
        entries: [
          {
            vlanId: '0',
            vlanName: 'Management',
            color: '#488ded',
            subnet: '192.0.2.0/24',
            gateway: '192.0.2.1',
          },
        ],
      },
    },
  ];
  document.ports = Array.from({ length: 8 }, (_, index) => ({
    ...makeBoardPort(
      'router',
      index === 0 ? 'sfp_plus' : 'rj45',
      0,
      index,
      `Port ${index + 1}`,
    ),
    id: `source-${index}`,
    role: '',
    linkState: '',
  }));
  Object.assign(document.ports[0]!, {
    name: long ? 'Long authored port name '.repeat(10) : 'Router uplink',
    role: 'LAN trunk',
    linkState: 'up',
    nativeVlan: '0',
    taggedVlans: ['20', '30', 'Guest voice'],
    pvid: '0',
    speed: '10G',
    address: long ? '2001:db8:' + 'abcd'.repeat(250) + '::1' : '192.0.2.10',
    externalDestination: long
      ? 'External authored endpoint '.repeat(35)
      : 'Provider handoff',
    color: '#488ded',
  });
  document.ports[1]!.linkState = 'down';
  document.ports[2]!.linkState = 'unknown';
  document.ports[3]!.linkState = 'Authored standby';
  document.ports.push(
    ...Array.from({ length: 24 }, (_, index) => ({
      ...makeBoardPort(
        'switch',
        'rj45',
        Math.floor(index / 12),
        index % 12,
        `Switch ${index + 1}`,
      ),
      id: `target-${index}`,
    })),
  );
  document.cables = [
    {
      id: 'stable-cable',
      sourcePortId: 'source-0',
      targetPortId: 'target-0',
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    },
  ];
  return document;
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
async function collapse(page: Page) {
  const control = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await control.isVisible()) await control.click();
}
async function setup(page: Page, document = fixture()) {
  const project = test.info().project.name;
  if (cookies.has(project))
    await page.context().addCookies(cookies.get(project)!);
  await page.goto('/');
  if (!cookies.has(project)) {
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
  cookies.set(project, await page.context().cookies());
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Tooltip ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const board = (await response.json()).board as BoardRecord;
  await page.goto(`/boards/${board.id}`);
  await saved(page);
  await collapse(page);
  return board;
}
async function read(page: Page, id: string): Promise<BoardRecord> {
  return (await (await page.request.get(`/api/v1/boards/${id}`)).json()).board;
}
async function patch(page: Page, board: BoardRecord, document: BoardDocument) {
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.patch(`/api/v1/boards/${board.id}`, {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { rowVersion: board.rowVersion, document },
  });
  expect(response.status()).toBe(200);
  await page.reload();
  await saved(page);
  await collapse(page);
}
async function show(page: Page, id = 'source-0') {
  await page.mouse.move(5, 5);
  if (mobile()) {
    await page.keyboard.press('Tab');
    await socket(page, id).focus();
  } else await socket(page, id).hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-summary-port-id', id);
}
async function openMenu(page: Page, id = 'source-0') {
  if (!mobile()) await socket(page, id).click({ button: 'right' });
  else {
    const box = (await socket(page, id).boundingBox())!;
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 },
      ],
    });
    try {
      await expect(menu(page)).toBeVisible();
    } finally {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();
    }
  }
  await expect(menu(page)).toBeVisible();
}
async function positioned(page: Page, id = 'source-0') {
  const tip = (await card(page).boundingBox())!,
    port = (await socket(page, id).boundingBox())!,
    canvas = (await page.getByTestId('board-canvas').boundingBox())!;
  const viewport = page.viewportSize()!;
  const toolbar = (await page
    .getByRole('toolbar', { name: 'Board tools', exact: true })
    .boundingBox())!;
  expect(tip.width).toBeLessThanOrEqual(481);
  expect(tip.x).toBeGreaterThanOrEqual(0);
  expect(tip.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  expect(tip.x + tip.width).toBeLessThanOrEqual(
    Math.min(viewport.width, canvas.x + canvas.width) + 1,
  );
  expect(tip.y + tip.height).toBeLessThanOrEqual(
    Math.min(viewport.height, canvas.y + canvas.height) + 1,
  );
  expect(
    tip.x < port.x + port.width &&
      tip.x + tip.width > port.x &&
      tip.y < port.y + port.height &&
      tip.y + tip.height > port.y,
  ).toBe(false);
  expect(
    await card(page).evaluate((node) => node.parentElement === document.body),
  ).toBe(true);
  expect(
    await card(page).evaluate(
      (node) => node.scrollWidth <= node.clientWidth + 1,
    ),
  ).toBe(true);
}

test('structured summaries use existing pills and current authored fields without changing records', async ({
  page,
}, info) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  await show(page);
  await expect(card(page).locator('.board-port-tooltip-name')).toHaveText(
    'Router uplink',
  );
  await expect(card(page).locator('[data-field="role"]')).toHaveText(
    'LAN trunk',
  );
  await expect(card(page).locator('[data-field="kind"]')).toHaveText('SFP+');
  await expect(card(page).locator('[data-field="linkState"]')).toContainText(
    'Documented',
  );
  await expect(card(page).locator('[data-field="linkState"]')).toContainText(
    'Up',
  );
  for (const [key, value] of Object.entries({
    nativeVlan: '0',
    pvid: '0',
    speed: '10G',
    taggedVlans: '20, 30, Guest voice',
    address: '192.0.2.10',
    externalDestination: 'Provider handoff',
    connection: 'Synthetic 24-port switch / Switch 1',
  })) {
    await expect(
      card(page).locator(`[data-field="${key}"] .board-network-chip-value`),
    ).toHaveText(value);
  }
  await positioned(page);
  await expect(card(page).locator('.board-port-tooltip-name')).toHaveCSS(
    'font-size',
    '20px',
  );
  await expect(
    card(page).locator('[data-field="pvid"] .board-network-chip-value'),
  ).toHaveCSS('font-size', '16px');
  await expect(
    card(page).locator('input, select, button, textarea'),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('configured-router-switch-network-tooltip.png'),
  });
  for (const [index, status] of [
    [1, 'Down'],
    [2, 'Unknown'],
    [3, 'Authored standby'],
  ] as const) {
    await show(page, `source-${index}`);
    await expect(card(page).locator('[data-field="linkState"]')).toContainText(
      status,
    );
  }
  await show(page, 'source-4');
  await expect(card(page).locator('.board-network-chip')).toHaveCount(0);
  await expect(card(page).locator('[data-field="linkState"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.reload();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(before);
});

test('overlay remains attached, unclipped and outside the connector at edges across zoom and pan', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const document = fixture();
  document.elements = [document.elements[0]!];
  document.elements[0]!.x = -240;
  document.elements[0]!.y = -110;
  document.cables = [];
  document.ports = document.ports.filter((port) => port.deviceId === 'router');
  const board = await setup(page, document);
  for (const [index, zoom] of [0.4, 1, 1.7].entries()) {
    let current = await read(page, board.id);
    await patch(page, current, {
      ...current.document,
      viewport: { x: 460, y: 300, zoom },
    });
    const canvas = (await page.getByTestId('board-canvas').boundingBox())!,
      viewport = page.viewportSize()!;
    const positions =
      index === 1
        ? [
            [
              canvas.x + 65,
              Math.min(viewport.height, canvas.y + canvas.height) - 60,
            ],
            [
              Math.min(viewport.width, canvas.x + canvas.width) - 65,
              canvas.y + 145,
            ],
          ]
        : [
            [canvas.x + 65, canvas.y + 145],
            [
              Math.min(viewport.width, canvas.x + canvas.width) - 65,
              Math.min(viewport.height, canvas.y + canvas.height) - 60,
            ],
          ];
    for (const [x, y] of positions) {
      current = await read(page, board.id);
      const port = (await socket(page).boundingBox())!;
      await patch(page, current, {
        ...current.document,
        viewport: {
          x: current.document.viewport.x + x! - port.x - port.width / 2,
          y: current.document.viewport.y + y! - port.y - port.height / 2,
          zoom,
        },
      });
      await show(page);
      await positioned(page);
    }
    await page.screenshot({
      path: info.outputPath(`edge-tooltip-zoom-${zoom}.png`),
    });
  }
});

test('long values wrap and scroll with keyboard and pointer while Escape stays dismissed', async ({
  page,
}, info) => {
  const board = await setup(page, fixture(true)),
    before = (await read(page, board.id)).document;
  await show(page);
  await positioned(page);
  await expect
    .poll(() =>
      card(page).evaluate((node) => node.scrollHeight > node.clientHeight),
    )
    .toBe(true);
  await page.keyboard.press('Tab');
  await card(page).focus();
  await page.keyboard.press('PageDown');
  await expect
    .poll(() => card(page).evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const old = await card(page).evaluate((node) => node.scrollTop);
  await page.keyboard.press('PageUp');
  await expect
    .poll(() => card(page).evaluate((node) => node.scrollTop))
    .toBeLessThan(old);
  if (!mobile()) {
    await socket(page).hover();
    const tip = (await card(page).boundingBox())!;
    await page.mouse.move(tip.x + tip.width / 2, tip.y + tip.height / 2);
    await page.waitForTimeout(250);
    await expect(card(page)).toBeVisible();
    await page.mouse.wheel(0, 180);
    await expect
      .poll(() => card(page).evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
  }
  await page.screenshot({
    path: info.outputPath('long-scrollable-tooltip.png'),
  });
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(250);
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press('Tab');
  await socket(page, 'source-1').focus();
  await socket(page).focus();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-summary-port-id', 'source-0');
  await page.keyboard.press('Escape');
  if (!mobile()) {
    await page.getByTestId('board-canvas').focus();
    await page.mouse.move(5, 5);
    await socket(page).hover();
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await page.keyboard.press('Tab');
    await socket(page).focus();
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(before);
});

test('context menus, copy and paste, and inspection dismiss the floating summary and retain cable identities', async ({
  page,
}) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  if (!mobile()) await show(page);
  await openMenu(page);
  await expect(card(page)).toHaveCount(0);
  if (mobile()) {
    await expect(menu(page).getByRole('tooltip')).toBeVisible();
    await expect(menu(page).getByRole('tooltip')).toContainText(
      'Router uplink',
    );
  }
  await menu(page)
    .getByRole('menuitem', { name: 'Copy Port Settings', exact: true })
    .click();
  await openMenu(page, 'source-1');
  await menu(page)
    .getByRole('menuitem', { name: 'Paste Settings', exact: true })
    .click();
  await saved(page);
  await page.keyboard.press('Escape');
  const close = inspector(page).getByRole('button', {
    name: 'Close inspector',
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  await show(page, 'source-1');
  await expect(card(page).locator('[data-field="role"]')).toHaveText(
    'LAN trunk',
  );
  await expect(
    card(page).locator('[data-field="pvid"] .board-network-chip-value'),
  ).toHaveText('0');
  await expect(card(page).locator('[data-field="connection"]')).toHaveCount(0);
  await socket(page, 'source-1').click();
  await expect(card(page)).toHaveCount(0);
  await expect(
    inspector(page).getByLabel('Port name', { exact: true }),
  ).toHaveValue('Port 2');
  const after = (await read(page, board.id)).document;
  expect(after.cables).toEqual(before.cables);
  expect(
    after.ports.map(({ id, row, column, name }) => ({ id, row, column, name })),
  ).toEqual(
    before.ports.map(({ id, row, column, name }) => ({
      id,
      row,
      column,
      name,
    })),
  );
});

test('pointer leave and dragging dismiss summaries without changing port configuration', async ({
  page,
}) => {
  const board = await setup(page),
    before = (await read(page, board.id)).document;
  await show(page);
  if (mobile()) {
    await socket(page).tap();
    await expect(card(page)).toHaveCount(0);
    await expect(
      inspector(page).getByLabel('Port name', { exact: true }),
    ).toBeVisible();
    return;
  }
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
  await show(page);
  await page.mouse.wheel(20, 10);
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(250);
  await expect(card(page)).toHaveCount(0);
  await expect
    .poll(async () => (await read(page, board.id)).document.viewport.x)
    .not.toEqual(before.viewport.x);
  await show(page);
  const device = page.locator('[data-board-element-id="router"]');
  const bounds = (await device.boundingBox())!;
  const point = {
    x: bounds.x + bounds.width - 35,
    y: bounds.y + bounds.height - 30,
  };
  await page.keyboard.down('Alt');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 20, { steps: 5 });
  await expect(card(page)).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved(page);
  const after = (await read(page, board.id)).document;
  expect(after.ports).toEqual(before.ports);
  expect(after.cables).toEqual(before.cables);
  expect(after.elements[0]!.x).not.toEqual(before.elements[0]!.x);
});
