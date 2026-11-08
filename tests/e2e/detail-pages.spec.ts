import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
  type JsonValue,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });

const csrfTokens = new Map<string, string>();
const sessionFile = (port: string) =>
  join(
    test.info().config.metadata.e2eDataDir as string,
    `detail-session-${port}.json`,
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

async function saved(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
}

async function ready(page: Page) {
  await expect(page.locator('.board-studio-layout')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}

async function browser(page: Page) {
  const open = page.getByRole('button', {
    name: 'Open board browser',
    exact: true,
  });
  if ((await open.getAttribute('aria-expanded')) !== 'true') await open.click();
  return page.locator('.board-browser');
}

async function inspectCanvasObject(page: Page, id: string) {
  await ready(page);
  const header = page.locator(
    `[data-board-element-id="${id}"] .board-element-header`,
  );
  const position = await header.evaluate((node) => ({
    x: node.clientWidth / 2,
    y: node.clientHeight - 2,
  }));
  await header.click({ position });
}

function fixture(count = 3) {
  const document = emptyBoardDocument();
  const containerId = randomUUID();
  const routerId = randomUUID();
  const switchId = randomUUID();
  document.elements.push({
    id: containerId,
    type: 'network',
    name: 'Network Details',
    x: 40,
    y: 60,
    width: 960,
    height: 390,
    z: 0,
    color: '#192b2b',
    properties: {
      displayMode: 'detailed',
      displayFields: ['vlanId', 'vlanName', 'subnet'],
      entries: Array.from({ length: count }, (_, index) => ({
        networkEntryVersion: 2,
        vlanId: index < 2 ? '20' : String(index + 20),
        vlanName:
          index < 2
            ? 'Duplicate network'
            : `Network ${String(index).padStart(3, '0')}`,
        color: '#488ded',
        subnet: `192.0.${index + 2}.0/24`,
        gateway: `192.0.${index + 2}.1`,
        dhcpServer: index !== 1,
        dhcpStart: `192.0.${index + 2}.100`,
        dhcpEnd: `192.0.${index + 2}.150`,
        dns: '192.0.2.53, 198.51.100.53',
        notes: `Documented network ${index}`,
        customFields: { Owner: 'Synthetic QA' },
      })),
    },
  });
  document.elements.push(
    {
      id: routerId,
      type: 'device',
      name: 'Documentation Router',
      x: 60,
      y: 500,
      width: 380,
      height: 220,
      z: 1,
      color: '#192b2b',
      properties: {
        manufacturer: 'Example Networks',
        model: 'Reference router',
        managementAddress: '192.0.2.1',
      },
    },
    {
      id: switchId,
      type: 'device',
      name: 'Partially configured switch',
      x: 550,
      y: 500,
      width: 380,
      height: 220,
      z: 2,
      color: '#192b2b',
      properties: {},
    },
  );
  const upstream = makeBoardPort(routerId, 'rj45', 0, 0, 'LAN');
  upstream.pvid = '20';
  upstream.taggedVlans = ['30', '40'];
  const downstream = makeBoardPort(switchId, 'rj45', 0, 0, 'Uplink');
  document.ports.push(
    upstream,
    downstream,
    makeBoardPort(routerId, 'rj45', 0, 1, 'Unconnected'),
  );
  document.cables.push({
    id: randomUUID(),
    sourcePortId: upstream.id,
    targetPortId: downstream.id,
    name: 'Documented cable',
    cableType: 'Cat6',
    sourceConnector: 'rj45',
    targetConnector: 'rj45',
    color: '#488ded',
    length: '',
    notes: '',
  });
  return { document, containerId, routerId, switchId };
}

test('existing objects have shared-shell category and detail pages with stable deep links', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await authenticate(page);
  const { document, containerId, routerId } = fixture();
  const board = await create(page, document);
  await page.goto(`/boards/${board.id}`);
  await saved(page);
  const original = (await read(page, board.id)).document;
  await expect(
    page.locator(`[data-board-element-id="${containerId}"]`),
  ).toBeAttached();
  let sidebar = await browser(page);
  await sidebar
    .getByRole('button', { name: `Expand board ${board.name}`, exact: true })
    .click();
  const tree = sidebar.locator('.board-object-tree');
  await expect(
    tree.getByRole('button', { name: 'Networks', exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole('button', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await tree.getByRole('button', { name: 'Networks', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}/networks$`));
  const content = page.locator('.board-detail-pages');
  await expect(
    content.getByRole('heading', { name: 'Networks', exact: true }),
  ).toBeVisible();
  await ready(page);
  await expect(content.getByRole('table')).toContainText('192.0.2.0/24');
  await expect(content.getByRole('table')).toContainText('192.0.3.0/24');
  await page.screenshot({
    path: info.outputPath('networks-overview.png'),
    fullPage: true,
  });
  await content.getByRole('button', { name: 'VLAN', exact: true }).click();
  await expect(content.getByRole('columnheader').first()).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect(content.locator('tbody tr').first()).toContainText(
    'Network 002',
  );
  await content
    .getByRole('searchbox', { name: 'Search networks', exact: true })
    .fill('192.0.3.0');
  await expect(
    content.getByRole('button', { name: /^Open network / }),
  ).toHaveCount(1);
  await content.getByRole('button', { name: /^Open network / }).click();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${board.id}/networks/${containerId}/[^/?]+$`),
  );
  const networkUrl = page.url();
  await expect(content).toContainText('192.0.3.0/24');
  await expect(content).toContainText('192.0.3.1');
  await expect(content).toContainText('198.51.100.53');
  await expect(content).toContainText('Documented network 1');
  await page.reload();
  await expect(content).toContainText('192.0.3.0/24');
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await expect(
    page.locator(`[data-board-element-id="${containerId}"]`),
  ).toHaveAttribute('data-selected', 'true');
  await saved(page);
  expect((await read(page, board.id)).document.elements).toEqual(
    original.elements,
  );
  await page.goBack();
  await expect(page).toHaveURL(networkUrl);
  await expect(content).toContainText('192.0.3.0/24');
  await page.goForward();
  await expect(
    page.locator(`[data-board-element-id="${containerId}"]`),
  ).toHaveAttribute('data-selected', 'true');
  sidebar = await browser(page);
  const expand = sidebar.getByRole('button', {
    name: `Expand board ${board.name}`,
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  await sidebar
    .locator('.board-object-tree')
    .getByRole('button', { name: 'Devices', exact: true })
    .click();
  await expect(
    content.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await ready(page);
  await page.screenshot({
    path: info.outputPath('devices-overview.png'),
    fullPage: true,
  });
  await content
    .getByRole('searchbox', { name: 'Search devices', exact: true })
    .fill('192.0.2.1');
  await expect(
    content.getByRole('button', { name: /^Open device / }),
  ).toHaveCount(1);
  await content
    .getByRole('button', {
      name: 'Open device Documentation Router',
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${board.id}/devices/${routerId}$`),
  );
  await expect(content).toContainText('Reference router');
  await expect(content.getByRole('table')).toContainText(
    'Partially configured switch',
  );
  await expect(content.getByRole('table')).toContainText('Uplink');
  await expect(content.getByRole('table')).toContainText('Unconnected');
  await page.reload();
  await expect(
    content.getByRole('heading', { name: 'Documentation Router', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('device-detail.png'),
    fullPage: true,
  });
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await expect(
    page.locator(`[data-board-element-id="${routerId}"]`),
  ).toHaveAttribute('data-selected', 'true');
  expect(errors).toEqual([]);
});

test('empty and large boards derive their navigation and bounded searchable inventories from existing objects', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const empty = await create(page, emptyBoardDocument(), 'Empty inventory');
  await page.goto(`/boards/${empty.id}`);
  let sidebar = await browser(page);
  await sidebar
    .getByRole('button', { name: `Expand board ${empty.name}`, exact: true })
    .click();
  await expect(sidebar.locator('.object-tree-category')).toHaveCount(0);
  await page.goto(`/boards/${empty.id}/networks`);
  await expect(page.locator('.board-detail-pages')).toContainText(
    /No networks/i,
  );
  const { document } = fixture(80);
  const board = await create(page, document, 'Large inventory');
  await page.goto(`/boards/${board.id}`);
  sidebar = await browser(page);
  await sidebar
    .getByRole('button', { name: `Expand board ${board.name}`, exact: true })
    .click();
  await expect(
    sidebar.getByRole('searchbox', {
      name: 'Filter board objects',
      exact: true,
    }),
  ).toBeVisible();
  await sidebar
    .locator('.board-object-tree')
    .getByRole('button', { name: 'Networks', exact: true })
    .click();
  const content = page.locator('.board-detail-pages');
  await ready(page);
  await expect(
    content.getByRole('button', { name: /^Open network / }),
  ).toHaveCount(64);
  await content
    .getByRole('button', { name: 'Show more networks', exact: true })
    .click();
  await expect(
    content.getByRole('button', { name: /^Open network / }),
  ).toHaveCount(80);
  await content
    .getByRole('searchbox', { name: 'Search networks', exact: true })
    .fill('Network 079');
  await expect(
    content.getByRole('button', { name: /^Open network / }),
  ).toHaveCount(1);
  await content.getByRole('button', { name: /^Open network / }).click();
  await expect(content).toContainText('192.0.81.0/24');
  await page.screenshot({
    path: info.outputPath('network-detail.png'),
    fullPage: true,
  });
  await content.locator('.detail-address-space').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('network-address-space.png'),
    fullPage: true,
  });
});

test('legacy network deep links survive duplicate labels, reorder, additions and reload without changing authored data', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(page);
  const { document, containerId } = fixture();
  const board = await create(page, document);
  await page.goto(`/boards/${board.id}/networks`);
  const content = page.locator('.board-detail-pages');
  await ready(page);
  await content
    .getByRole('searchbox', { name: 'Search networks', exact: true })
    .fill('192.0.3.0');
  await content.getByRole('button', { name: /^Open network / }).click();
  const url = page.url();
  const current = await read(page, board.id);
  const next = structuredClone(current.document);
  const container = next.elements.find(
    (element) => element.id === containerId,
  )!;
  const entries = container.properties.entries as Record<string, JsonValue>[];
  expect(new Set(entries.map((entry) => entry.networkEntryId)).size).toBe(3);
  expect(
    entries.every((entry) => typeof entry.networkEntryId === 'string'),
  ).toBe(true);
  const target = entries[1]!;
  target.vlanName = 'Renamed duplicate';
  container.properties.entries = [
    entries[2]!,
    { ...entries[0]!, networkEntryId: randomUUID(), vlanName: 'Added entry' },
    target,
  ];
  const response = await page.request.patch(`/api/v1/boards/${board.id}`, {
    headers: await headers(page),
    data: { rowVersion: current.rowVersion, document: next },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(content).toContainText('Renamed duplicate');
  await expect(content).toContainText('192.0.3.0/24');
  const persisted = await read(page, board.id);
  expect(
    persisted.document.elements.find((element) => element.id === containerId)!
      .properties.entries,
  ).toEqual(container.properties.entries);
});

test('canvas rename, deletion and undo stay synchronized with detail navigation and ordinary returns preserve the viewport', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, routerId } = fixture(1);
  const board = await create(page, document);
  const detailUrl = `/boards/${board.id}/devices/${routerId}`;
  await page.goto(detailUrl);
  const content = page.locator('.board-detail-pages');
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await inspectCanvasObject(page, routerId);
  const inspector = page.getByRole('complementary', {
    name: 'Object inspector',
    exact: true,
  });
  await inspector
    .getByLabel('Name', { exact: true })
    .fill('Renamed documentation router');
  await inspector.getByLabel('Name', { exact: true }).blur();
  await saved(page);
  await inspector
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await saved(page);
  const viewport = (await read(page, board.id)).document.viewport;
  let sidebar = await browser(page);
  await sidebar
    .getByRole('button', { name: `Expand board ${board.name}`, exact: true })
    .click();
  await sidebar
    .getByRole('button', { name: 'Expand devices', exact: true })
    .click();
  await sidebar
    .getByRole('button', { name: 'Renamed documentation router', exact: true })
    .click();
  await expect(
    content.getByRole('heading', {
      name: 'Renamed documentation router',
      exact: true,
    }),
  ).toBeVisible();
  await content.getByRole('button', { name: board.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  await saved(page);
  expect((await read(page, board.id)).document.viewport).toEqual(viewport);
  sidebar = await browser(page);
  await sidebar
    .getByRole('button', { name: 'Renamed documentation router', exact: true })
    .click();
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await inspectCanvasObject(page, routerId);
  page.once('dialog', (dialog) => dialog.accept());
  await inspector
    .getByRole('button', { name: 'Delete device', exact: true })
    .click();
  await saved(page);
  sidebar = await browser(page);
  await expect(
    sidebar.getByRole('button', {
      name: 'Renamed documentation router',
      exact: true,
    }),
  ).toHaveCount(0);
  await sidebar
    .getByRole('button', { name: 'Collapse board browser', exact: true })
    .click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  sidebar = await browser(page);
  await expect(
    sidebar.getByRole('button', {
      name: 'Renamed documentation router',
      exact: true,
    }),
  ).toBeVisible();
  await sidebar
    .getByRole('button', { name: 'Collapse board browser', exact: true })
    .click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  await page.goto(detailUrl);
  await expect(
    content.getByRole('heading', { name: 'Object unavailable', exact: true }),
  ).toBeVisible();
  expect(
    (await read(page, board.id)).document.elements.some(
      (element) => element.id === routerId,
    ),
  ).toBe(false);
});

test('expanded inactive boards retain their own object tree when another board opens', async ({
  page,
}) => {
  await authenticate(page);
  const first = await create(page, fixture(1).document, 'First tree');
  const secondFixture = fixture(1);
  secondFixture.document.elements[1]!.name = 'Second board device';
  const second = await create(page, secondFixture.document, 'Second tree');
  await page.goto(`/boards/${first.id}`);
  const sidebar = await browser(page);
  const firstRow = sidebar.locator('.board-browser-item').filter({
    has: page.getByRole('button', { name: first.name, exact: true }),
  });
  await firstRow
    .getByRole('button', { name: `Expand board ${first.name}`, exact: true })
    .click();
  await firstRow
    .getByRole('button', { name: 'Expand devices', exact: true })
    .click();
  await expect(
    firstRow.getByRole('button', { name: 'Documentation Router', exact: true }),
  ).toBeVisible();
  await sidebar.getByRole('button', { name: second.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${second.id}$`));
  await browser(page);
  await expect(
    firstRow.getByRole('button', { name: 'Documentation Router', exact: true }),
  ).toBeVisible();
  await expect(
    firstRow.getByRole('button', { name: 'Second board device', exact: true }),
  ).toHaveCount(0);
  await firstRow
    .getByRole('button', { name: 'Documentation Router', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/boards/${first.id}/devices/`));
  await expect(
    page
      .locator('.board-detail-pages')
      .getByRole('heading', { name: 'Documentation Router', exact: true }),
  ).toBeVisible();
});

test('removing and recreating the last network entry never retargets its old detail link', async ({
  page,
}) => {
  await authenticate(page);
  const { document, containerId } = fixture(1);
  const board = await create(page, document);
  await page.goto(`/boards/${board.id}/networks`);
  const content = page.locator('.board-detail-pages');
  await content.getByRole('button', { name: /^Open network / }).click();
  const oldUrl = page.url();
  const oldEntryId = new URL(oldUrl).pathname.split('/').at(-1);
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await inspectCanvasObject(page, containerId);
  const inspector = page.getByRole('complementary', {
    name: 'Object inspector',
    exact: true,
  });
  await inspector
    .getByRole('button', { name: 'Remove entry', exact: true })
    .click();
  await saved(page);
  await inspector
    .getByRole('button', { name: 'Add network entry', exact: true })
    .click();
  await saved(page);
  const current = await read(page, board.id);
  const entries = current.document.elements.find(
    (element) => element.id === containerId,
  )!.properties.entries as Record<string, JsonValue>[];
  expect(entries).toHaveLength(1);
  expect(entries[0]!.networkEntryId).not.toBe(oldEntryId);
  await page.goto(oldUrl);
  await expect(
    content.getByRole('heading', { name: 'Object unavailable', exact: true }),
  ).toBeVisible();
});

test('malformed detail destinations stay unavailable on boot and history changes', async ({
  page,
}) => {
  await authenticate(page);
  const board = await create(page, fixture(1).document);
  await page.goto(`/boards/${board.id}/devices/invalid/extra`);
  const content = page.locator('.board-detail-pages');
  await expect(
    content.getByRole('heading', { name: 'Page unavailable', exact: true }),
  ).toBeVisible();
  await page.goto(`/boards/${board.id}/devices`);
  await expect(
    content.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await page.evaluate((id) => {
    history.pushState(null, '', `/boards/${id}/networks/%ZZ/invalid`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, board.id);
  await expect(
    content.getByRole('heading', { name: 'Page unavailable', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-board-element-id]')).toHaveCount(0);
});

test('network detail edits and optional documentation persist on the existing entry with shared undo history', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, containerId } = fixture(1);
  const board = await create(page, document);
  await page.goto(`/boards/${board.id}/networks`);
  await ready(page);
  const content = page.locator('.board-detail-pages');
  await content.getByRole('button', { name: /^Open network / }).click();
  await ready(page);
  await content
    .getByRole('button', { name: 'Edit network', exact: true })
    .click();
  await content
    .getByLabel('Network name', { exact: true })
    .fill('Updated network documentation');
  await content
    .getByLabel('Subnet/CIDR', { exact: true })
    .fill('198.51.100.0/26');
  await content.getByLabel('Gateway', { exact: true }).fill('198.51.100.1');
  await content
    .getByLabel('DHCP state', { exact: true })
    .selectOption('enabled');
  await content
    .getByLabel('DHCP pool start', { exact: true })
    .fill('198.51.100.30');
  await content
    .getByLabel('DHCP pool end', { exact: true })
    .fill('198.51.100.40');
  await content
    .getByLabel('DNS servers', { exact: true })
    .fill('192.0.2.53, 198.51.100.53');
  await content
    .getByLabel('Network notes', { exact: true })
    .fill('Shared network notes');
  await content
    .getByRole('button', { name: 'Done editing', exact: true })
    .click();
  const docs = content
    .locator('summary')
    .filter({ hasText: /^(Add|Edit) documentation$/ });
  await docs.click();
  await content
    .getByLabel('Network Description', { exact: true })
    .fill('Optional extended network description');
  await content
    .getByLabel('Network General notes', { exact: true })
    .fill('Additional reference information');
  await content.getByLabel('Network General notes', { exact: true }).blur();
  await saved(page);
  const current = await read(page, board.id);
  const container = current.document.elements.find(
    (element) => element.id === containerId,
  )!;
  const entry = (
    container.properties.entries as Record<string, JsonValue>[]
  )[0]!;
  expect(entry).toMatchObject({
    vlanName: 'Updated network documentation',
    subnet: '198.51.100.0/26',
    gateway: '198.51.100.1',
    notes: 'Shared network notes',
    documentation: {
      description: 'Optional extended network description',
      notes: 'Additional reference information',
    },
  });
  expect({
    x: container.x,
    y: container.y,
    width: container.width,
    height: container.height,
  }).toEqual({ x: 40, y: 60, width: 960, height: 390 });
  expect(container.properties.displayFields).toEqual([
    'vlanId',
    'vlanName',
    'subnet',
  ]);
  await content
    .getByRole('button', { name: 'Edit network', exact: true })
    .click();
  await content.getByLabel('Gateway', { exact: true }).fill('198.51.100.9');
  await content
    .getByRole('button', { name: 'Done editing', exact: true })
    .click();
  await saved(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  await expect(content).toContainText('198.51.100.1');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  await expect(content).toContainText('198.51.100.9');
  await page.reload();
  await ready(page);
  await expect(content).toContainText('Updated network documentation');
  await expect(content).toContainText('Optional extended network description');
  await expect(content).toContainText('62 usable IPv4 addresses');
  await expect(
    content.locator('[aria-label*="configured DHCP pool"]'),
  ).toHaveAttribute('aria-label', /11 addresses/);
});

test('device edits share the existing object and recover a failed autosave without discarding the draft', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(page);
  const { document, routerId } = fixture(1);
  const board = await create(page, document);
  await page.goto(`/boards/${board.id}/devices/${routerId}`);
  await ready(page);
  const content = page.locator('.board-detail-pages');
  await content
    .getByRole('button', { name: 'Edit device', exact: true })
    .click();
  await content
    .getByLabel('Device name', { exact: true })
    .fill('Documented edge router');
  await content
    .getByLabel('Management IP', { exact: true })
    .fill('198.51.100.7');
  await content
    .getByLabel('Device notes', { exact: true })
    .fill('Shared device notes');
  await content
    .getByRole('button', { name: 'Done editing', exact: true })
    .click();
  await content
    .locator('summary')
    .filter({ hasText: /^(Add|Edit) documentation$/ })
    .click();
  await content
    .getByLabel('Device Serial number', { exact: true })
    .fill('SYNTHETIC-REF-001');
  await content
    .getByLabel('Device Description', { exact: true })
    .fill('Optional device reference');
  await content.getByLabel('Device Description', { exact: true }).blur();
  await saved(page);
  await content
    .getByRole('button', { name: 'Edit port LAN', exact: true })
    .click();
  await content.getByLabel('Port name', { exact: true }).fill('Core uplink');
  await content
    .getByLabel('Port purpose', { exact: true })
    .fill('Documented uplink');
  await content.getByLabel('Tagged VLANs', { exact: true }).fill('20');
  await content.getByLabel('Tagged VLANs', { exact: true }).press('End');
  await content
    .getByLabel('Tagged VLANs', { exact: true })
    .pressSequentially(', 30');
  await content
    .getByRole('button', { name: 'Done editing port Core uplink', exact: true })
    .click();
  await saved(page);
  let current = await read(page, board.id);
  expect(
    current.document.elements.find((element) => element.id === routerId),
  ).toMatchObject({
    name: 'Documented edge router',
    properties: {
      managementAddress: '198.51.100.7',
      notes: 'Shared device notes',
      documentation: {
        serialNumber: 'SYNTHETIC-REF-001',
        description: 'Optional device reference',
      },
    },
  });
  expect(current.document.ports[0]).toEqual({
    ...document.ports[0],
    name: 'Core uplink',
    role: 'Documented uplink',
    taggedVlans: ['20', '30'],
  });
  expect(current.document.ports.slice(1)).toEqual(document.ports.slice(1));
  expect(current.document.cables).toEqual(document.cables);
  let failSave = true;
  await page.route(`**/api/v1/boards/${board.id}`, async (route) => {
    if (route.request().method() === 'PATCH' && failSave) {
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'UNAVAILABLE', message: 'Synthetic save unavailable' },
        },
      });
    } else await route.continue();
  });
  await content
    .getByRole('button', { name: 'Edit device', exact: true })
    .click();
  await content
    .getByLabel('Management IP', { exact: true })
    .fill('198.51.100.8');
  await content
    .getByRole('button', { name: 'Done editing', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic save unavailable',
  );
  await expect(content).toContainText('198.51.100.8');
  current = await read(page, board.id);
  expect(
    current.document.elements.find((element) => element.id === routerId)!
      .properties.managementAddress,
  ).toBe('198.51.100.7');
  failSave = false;
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await saved(page);
  await page.reload();
  await ready(page);
  await expect(content).toContainText('198.51.100.8');
  await expect(content).toContainText('SYNTHETIC-REF-001');
  await expect(content.getByRole('table')).toContainText('Core uplink');
  await expect(content.getByRole('table')).toContainText(
    'Partially configured switch',
  );
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await ready(page);
  await inspectCanvasObject(page, routerId);
  const inspector = page.getByRole('complementary', {
    name: 'Object inspector',
    exact: true,
  });
  await expect(inspector.getByLabel('Name', { exact: true })).toHaveValue(
    'Documented edge router',
  );
  await expect(
    inspector.getByLabel('Management address', { exact: true }),
  ).toHaveValue('198.51.100.8');
});

test('signing in to a missing board deep link never opens a different board with that object destination', async ({
  page,
}) => {
  await authenticate(page);
  const board = await create(page, fixture(1).document, 'Available fallback');
  await page.context().clearCookies();
  await page.goto('/boards/missing-board/devices/missing-device');
  await page.getByLabel('Username', { exact: true }).fill('board-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-board-password-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/board.*unavailable/i);
  await expect(page.locator('.board-detail-pages')).toHaveCount(0);
  const sidebar = await browser(page);
  await sidebar.getByRole('button', { name: board.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  await expect(
    page.getByRole('region', { name: 'Board canvas', exact: true }),
  ).toBeVisible();
});

test('clearing normalized legacy fields keeps the cleared values after reload and on the canvas', async ({
  page,
}) => {
  await authenticate(page);
  const { document, containerId } = fixture(1);
  const entry = (
    document.elements[0]!.properties.entries as Record<string, JsonValue>[]
  )[0]!;
  delete entry.networkEntryVersion;
  delete entry.subnet;
  delete entry.vlanName;
  delete entry.dhcpServer;
  entry.name = 'Legacy authored network';
  entry.cidr = '198.51.100.0/24';
  entry.dhcpStatus = 'enabled';
  const board = await create(page, document);
  await page.goto(`/boards/${board.id}/networks`);
  await ready(page);
  const content = page.locator('.board-detail-pages');
  await content.getByRole('button', { name: /^Open network / }).click();
  await ready(page);
  await content
    .getByRole('button', { name: 'Edit network', exact: true })
    .click();
  await content.getByLabel('Network name', { exact: true }).fill('');
  await content.getByLabel('Subnet/CIDR', { exact: true }).fill('');
  await content.getByLabel('DHCP state', { exact: true }).selectOption('unset');
  await content
    .getByRole('button', { name: 'Done editing', exact: true })
    .click();
  await saved(page);
  await page.reload();
  await ready(page);
  await content
    .getByRole('button', { name: 'Edit network', exact: true })
    .click();
  await expect(content.getByLabel('Network name', { exact: true })).toHaveValue(
    '',
  );
  await expect(content.getByLabel('Subnet/CIDR', { exact: true })).toHaveValue(
    '',
  );
  await expect(content.getByLabel('DHCP state', { exact: true })).toHaveValue(
    'unset',
  );
  const current = await read(page, board.id);
  const stored = (
    current.document.elements.find((element) => element.id === containerId)!
      .properties.entries as Record<string, JsonValue>[]
  )[0]!;
  expect(stored).toMatchObject({
    vlanName: '',
    subnet: '',
    dhcpServer: null,
    name: 'Legacy authored network',
    cidr: '198.51.100.0/24',
    dhcpStatus: 'enabled',
  });
  await content
    .getByRole('button', { name: 'Done editing', exact: true })
    .click();
  await content
    .getByRole('button', { name: 'View on Board', exact: true })
    .click();
  await ready(page);
  const network = page.locator(`[data-board-element-id="${containerId}"]`);
  await expect(network.locator('.board-network-visual-identity')).toHaveCount(
    1,
  );
  await expect(
    network.locator('.board-network-visual-identity'),
  ).not.toContainText('Legacy authored network');
  await expect(
    network.locator('.board-network-visual-identity'),
  ).not.toContainText('198.51.100.0/24');
});
