import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
  type BoardPort,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
const cookies = new Map<
  string,
  Awaited<ReturnType<BrowserContext['cookies']>>
>();
const mobile = () => test.info().project.name.startsWith('mobile');
const panel = (page: Page) =>
  page.getByRole('dialog', { name: 'VLAN Spotlight', exact: true });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
const port = (page: Page, id: string) =>
  page.locator('[data-board-port-id="' + id + '"]');
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
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
  const response = await page.request.get('/api/v1/boards/' + id);
  expect(response.status()).toBe(200);
  return (await response.json()).board;
}
async function setup(page: Page, document: BoardDocument) {
  const key = test.info().project.name;
  const session = cookies.get(key);
  if (session) await page.context().addCookies(session);
  await page.goto('/');
  if (!session) {
    const status = await (
      await page.request.get('/api/v1/auth/setup-status')
    ).json();
    await page.getByLabel('Username', { exact: true }).fill('spotlight-admin');
    await page
      .getByLabel('Password', { exact: true })
      .fill('Synthetic-spotlight-password-42');
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
  if (!session) cookies.set(key, await page.context().cookies());
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: 'Spotlight QA ' + randomUUID().slice(0, 8), document },
  });
  expect(response.status()).toBe(201);
  const board: BoardRecord = (await response.json()).board;
  await page.goto('/boards/' + board.id);
  await saved(page);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  return board;
}
async function choose(page: Page, vlan: string | null) {
  await page
    .getByRole('button', { name: 'VLAN Spotlight', exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
  const field = panel(page).getByLabel('VLAN ID', { exact: true });
  await expect(field).not.toBeFocused();
  await field.focus();
  await expect(field).toHaveCSS('outline-style', 'none');
  await expect(panel(page).getByRole('button')).toHaveCount(3);
  if (vlan === null)
    await panel(page)
      .getByRole('button', { name: 'Clear Spotlight', exact: true })
      .click();
  else {
    await panel(page).getByLabel('VLAN ID', { exact: true }).fill(vlan);
    await panel(page)
      .getByRole('button', { name: 'Apply', exact: true })
      .click();
  }
  await expect(panel(page)).toHaveCount(0);
}
async function svg(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
  const menu = page.locator('details.board-more');
  if ((await menu.getAttribute('open')) === null)
    await page.getByLabel('Board menu', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export image', exact: true }).click();
  const result = await readFile((await (await download).path())!, 'utf8');
  if ((await menu.getAttribute('open')) !== null)
    await page.getByLabel('Board menu', { exact: true }).click();
  return result;
}
function fixture(): BoardDocument {
  const document = emptyBoardDocument();
  document.grid = false;
  document.viewport = {
    x: 16,
    y: mobile() ? 120 : 70,
    zoom: mobile() ? 0.17 : 0.65,
  };
  document.elements = [
    {
      id: 'router',
      type: 'device',
      name: 'Synthetic Router',
      x: 30,
      y: 80,
      width: 1800,
      height: 300,
      z: 0,
      color: '#24332b',
      properties: { deviceType: 'Router', face: 'front' },
    },
    {
      id: 'switch',
      type: 'device',
      name: 'Synthetic Switch',
      x: 30,
      y: 450,
      width: 1800,
      height: 300,
      z: 1,
      color: '#24332b',
      properties: { deviceType: 'Switch', face: 'front' },
    },
    {
      id: 'network',
      type: 'network',
      name: 'Synthetic Networks',
      x: 30,
      y: 820,
      width: 800,
      height: 180,
      z: 2,
      color: '#24332b',
      properties: {
        entries: [
          {
            vlanId: 42,
            vlanName: 'Network-only VLAN',
            color: '#987ac4',
            subnet: '192.0.2.0/24',
          },
        ],
      },
    },
  ];
  for (const owner of ['router', 'switch'])
    for (let index = 0; index < 24; index++) {
      const item: BoardPort = {
        ...makeBoardPort(
          owner,
          index === 0 ? 'sfp_plus' : 'rj45',
          0,
          index,
          'Port ' + (index + 1),
        ),
        id: owner + '-' + index,
        color: index % 2 ? '#e49d62' : '#488ded',
        role: 'Freeform routed purpose',
        nativeVlan: '',
        taggedVlans: [],
        pvid: '',
      };
      if (index % 6 === 0) item.nativeVlan = '20';
      if (index % 6 === 1) item.taggedVlans = ['10', '20', '30'];
      if (index % 6 === 2) {
        item.nativeVlan = '20';
        item.taggedVlans = ['20'];
      }
      if (index % 6 === 3) item.pvid = '20';
      if (index % 6 === 4) item.nativeVlan = '0';
      if (index % 6 === 5) item.taggedVlans = ['Guest voice'];
      document.ports.push(item);
    }
  for (let index = 0; index < 4; index++)
    document.ports.push({
      ...makeBoardPort(
        'router',
        'rj45',
        0,
        index,
        'Rear ' + (index + 1),
        'rear',
      ),
      id: 'rear-' + index,
      nativeVlan: index ? '' : '20',
      taggedVlans: index === 1 ? ['20'] : [],
      pvid: index === 2 ? '20' : '',
    });
  document.cables = [
    {
      id: 'uplink',
      sourcePortId: 'router-0',
      targetPortId: 'switch-0',
      name: 'Synthetic uplink',
      cableType: 'Cat6A',
      sourceConnector: '',
      targetConnector: '',
      color: '#aebec8',
      length: '',
      notes: 'Do not infer VLAN routes',
    },
  ];
  return document;
}

test('Spotlight distinguishes memberships across a 24-port board without writes, recoloring, cable changes or export changes', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const board = await setup(page, fixture());
  if (mobile()) {
    const toolbar = (await page.locator('.board-toolbar').boundingBox())!;
    expect(toolbar.height).toBeLessThanOrEqual(44);
    await expect(page.locator('.board-save-status')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Hide cables', exact: true }),
    ).toBeVisible();
  }
  const before = await read(page, board.id);
  const normalSvg = await svg(page);
  const colors = await page
    .locator('.board-port-socket svg')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
  const cable = await page.locator('.board-cable-line').getAttribute('d');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === '/api/v1/boards/' + board.id
    )
      writes.push(request.postData() ?? '');
  });
  await choose(page, '20');
  await expect(port(page, 'router-0')).toHaveClass(/spotlight-native/);
  await expect(port(page, 'router-1')).toHaveClass(/spotlight-tagged/);
  await expect(port(page, 'router-2')).toHaveClass(/spotlight-both/);
  await expect(port(page, 'router-3')).toHaveClass(/spotlight-muted/);
  await expect(port(page, 'router-4')).toHaveClass(/spotlight-muted/);
  await expect(
    page.locator('.spotlight-native,.spotlight-tagged,.spotlight-both'),
  ).toHaveCount(24);
  await expect(
    page.getByLabel('Spotlight legend', { exact: true }),
  ).toContainText('Native/Untagged');
  await expect(
    page.getByLabel('Spotlight legend', { exact: true }),
  ).toContainText('Tagged');
  await page.screenshot({
    path: info.outputPath('mixed-24-port-native-tagged-spotlight.png'),
  });
  await port(page, 'router-0').screenshot({
    path: info.outputPath('native-spotlight.png'),
  });
  await port(page, 'router-1').screenshot({
    path: info.outputPath('tagged-spotlight.png'),
  });
  expect(
    await page
      .locator('.board-port-socket svg')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).color),
      ),
  ).toEqual(colors);
  expect(await page.locator('.board-cable-line').getAttribute('d')).toBe(cable);
  expect(await svg(page)).toBe(normalSvg);
  await choose(page, '0');
  await expect(port(page, 'router-4')).toHaveClass(/spotlight-native/);
  await expect(port(page, 'router-0')).toHaveClass(/spotlight-muted/);
  await choose(page, '42');
  await expect(page.locator('.board-port.spotlight-muted')).toHaveCount(48);
  await choose(page, null);
  await expect(page.locator('.board-port[class*="spotlight-"]')).toHaveCount(0);
  expect(
    await page
      .locator('.board-port-socket svg')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).color),
      ),
  ).toEqual(colors);
  expect((await read(page, board.id)).document).toEqual(before.document);
  expect((await read(page, board.id)).rowVersion).toBe(before.rowVersion);
  expect(writes).toEqual([]);
  if (mobile()) {
    await page
      .getByRole('button', { name: 'VLAN Spotlight', exact: true })
      .click();
    const bounds = (await panel(page).boundingBox())!,
      viewport = page.viewportSize()!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: info.outputPath('mobile-vlan-spotlight.png'),
    });
  }
});

test('Spotlight accepts port-only and manual values, survives face switches and recalculates after port editing', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const document = fixture();
  document.elements = document.elements.filter(
    (element) => element.type !== 'network',
  );
  const board = await setup(page, document);
  await choose(page, '20');
  await page
    .locator('[data-board-element-id="router"]')
    .getByRole('button', { name: 'Rear', exact: true })
    .click();
  await saved(page);
  await expect(port(page, 'rear-0')).toHaveClass(/spotlight-native/);
  await expect(port(page, 'rear-1')).toHaveClass(/spotlight-tagged/);
  await expect(port(page, 'rear-2')).toHaveClass(/spotlight-muted/);
  await expect(
    page.getByRole('button', { name: 'VLAN Spotlight', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .locator('[data-board-element-id="router"]')
    .getByRole('button', { name: 'Front', exact: true })
    .click();
  await saved(page);
  const beforeEdit = await read(page, board.id);
  const editPort = page.locator('[data-port-id="router-3"]');
  if (mobile()) await editPort.tap();
  else await editPort.click();
  await expect(inspector(page)).toBeVisible();
  await inspector(page).getByLabel('Native VLAN', { exact: true }).fill('20');
  await inspector(page).getByLabel('PVID', { exact: true }).focus();
  await saved(page);
  await expect(port(page, 'router-3')).toHaveClass(/spotlight-native/);
  const edited = await read(page, board.id);
  expect(
    edited.document.ports.find((item) => item.id === 'router-3')!.nativeVlan,
  ).toBe('20');
  expect({
    ...edited.document.ports.find((item) => item.id === 'router-3')!,
    nativeVlan: '',
  }).toEqual(beforeEdit.document.ports.find((item) => item.id === 'router-3'));
  expect(
    edited.document.ports.filter((item) => item.id !== 'router-3'),
  ).toEqual(beforeEdit.document.ports.filter((item) => item.id !== 'router-3'));
  expect(edited.document.elements).toEqual(beforeEdit.document.elements);
  expect(edited.document.cables).toEqual(beforeEdit.document.cables);
  await inspector(page)
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'VLAN Spotlight', exact: true })
    .click();
  await panel(page).getByLabel('VLAN ID', { exact: true }).fill('Guest voice');
  await panel(page).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(port(page, 'router-5')).toHaveClass(/spotlight-tagged/);
  await expect(port(page, 'router-0')).toHaveClass(/spotlight-muted/);
  await page.screenshot({
    path: info.outputPath('manual-port-only-spotlight.png'),
  });
  await page
    .getByRole('button', { name: 'Clear Spotlight', exact: true })
    .click();
  await expect(page.locator('.board-port[class*="spotlight-"]')).toHaveCount(0);
  expect((await read(page, board.id)).document).toEqual(edited.document);
  await page.reload();
  await saved(page);
  await expect(
    page.getByRole('button', { name: 'VLAN Spotlight', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.board-port[class*="spotlight-"]')).toHaveCount(0);
  expect((await read(page, board.id)).document).toEqual(edited.document);
});

test('ellipsis menus dismiss on outside pointer, switching menus and Escape without swallowing other controls', async ({
  page,
}) => {
  const board = await setup(page, emptyBoardDocument());
  const toolbar = page.locator('details.board-more');
  const trigger = page.getByLabel('Board menu', { exact: true });
  await trigger.click();
  await expect(toolbar).toHaveAttribute('open', '');
  const canvas = page.getByTestId('board-canvas');
  const bounds = (await canvas.boundingBox())!;
  const outside = { position: { x: bounds.width - 8, y: bounds.height - 8 } };
  if (mobile()) await canvas.tap(outside);
  else await canvas.click(outside);
  await expect(toolbar).not.toHaveAttribute('open');
  await trigger.click();
  await page
    .getByRole('button', { name: 'VLAN Spotlight', exact: true })
    .click();
  await expect(toolbar).not.toHaveAttribute('open');
  await expect(panel(page)).toBeVisible();
  await panel(page)
    .getByRole('button', { name: 'Close VLAN Spotlight', exact: true })
    .click();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(toolbar).not.toHaveAttribute('open');
  await expect(trigger).toBeFocused();

  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: {
      name: 'Sibling menu ' + randomUUID().slice(0, 8),
      document: emptyBoardDocument(),
    },
  });
  expect(response.status()).toBe(201);
  const sibling: BoardRecord = (await response.json()).board;
  await page.reload();
  await saved(page);
  const opener = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await opener.getAttribute('aria-expanded')) !== 'true')
    await opener.click();
  // Open the lower row first so its downward menu does not cover the next trigger.
  const first = page.getByLabel('Actions for board ' + sibling.name, {
    exact: true,
  });
  const second = page.getByLabel('Actions for board ' + board.name, {
    exact: true,
  });
  const firstMenu = first.locator('..');
  const secondMenu = second.locator('..');
  await first.click();
  await expect(firstMenu).toHaveAttribute('open', '');
  await second.click();
  await expect(firstMenu).not.toHaveAttribute('open');
  await expect(secondMenu).toHaveAttribute('open', '');
  await page.getByLabel('Find board', { exact: true }).click();
  await expect(secondMenu).not.toHaveAttribute('open');
  await first.click();
  await page.keyboard.press('Escape');
  await expect(firstMenu).not.toHaveAttribute('open');
  await expect(first).toBeFocused();
  await expect(page.getByLabel('Find board', { exact: true })).toBeVisible();
  const current = await read(page, board.id);
  expect(current.document).toEqual(board.document);
  expect(current.rowVersion).toBe(board.rowVersion);
});
