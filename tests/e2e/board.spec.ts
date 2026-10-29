import { expect, test, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RJ45_SOCKET_PATH } from '../../apps/web/src/visual/Connector.js';
import {
  emptyBoardDocument,
  type BoardRecord,
  type BoardDocument,
} from '../../packages/shared/src/board.js';

// The board-first brief explicitly replaces the former organization/configure/
// visual/transfer/navigation screens. Their source remains in Git baseline
// 3dd2fbf; these cases retain auth, canonical artwork, persistence, isolation,
// atomic failure and import coverage against the actual replacement product.
const username = 'board-admin';
const password = 'Synthetic-board-password-42';
const pageErrors = new WeakMap<Page, string[]>();
test.use({ actionTimeout: 15_000 });
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
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
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
async function browser(page: Page) {
  await expect(page.locator('.board-studio-layout')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  if (await page.locator('.board-studio.browser-collapsed').count())
    await page
      .getByRole('button', { name: 'Open board browser', exact: true })
      .click();
  return page.getByRole('complementary', {
    name: 'Board browser',
    exact: true,
  });
}
async function saved(page: Page) {
  // Fit commits its measured viewport on the next frame; observe that change
  // before waiting for the debounced persistence indicator.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
  await expect(page.locator('.board-save-status')).toBeVisible();
}
async function holdRead(page: Page, id: string) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/v1/boards/${id}`,
    async (route) => {
      const response = await route.fetch();
      enter();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  return { entered, release };
}
async function expectEditingBlocked(page: Page) {
  await expect
    .poll(() =>
      page
        .locator('button[aria-label="Add object"]')
        .evaluate(
          (element) =>
            element.matches(':disabled') || Boolean(element.closest('[inert]')),
        ),
    )
    .toBe(true);
}
async function readBoard(page: Page, id: string): Promise<BoardRecord> {
  const response = await page.request.get(`/api/v1/boards/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).board as BoardRecord;
}
async function createBoard(page: Page, name: string) {
  await (
    await browser(page)
  )
    .getByRole('button', { name: 'Add board', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New board', exact: true });
  await dialog.getByLabel('Board name', { exact: true }).fill(name);
  await dialog
    .getByRole('button', { name: 'Create board', exact: true })
    .click();
  await expect(page).toHaveURL(/\/boards\/[^/?]+$/);
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(name);
  await saved(page);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
async function selectBoard(page: Page, name: string) {
  await (
    await browser(page)
  )
    .getByRole('navigation', { name: 'Boards', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(name);
  await saved(page);
}
async function boardActions(page: Page, name: string) {
  const summary = (await browser(page)).locator(
    `summary[aria-label="Actions for board ${name}"]`,
  );
  if (
    !(await summary
      .locator('..')
      .evaluate((element) => element.hasAttribute('open')))
  )
    await summary.click();
  return summary.locator('..');
}
async function add(
  page: Page,
  kind: 'Network' | 'Cable' | 'Switch' | 'Router',
) {
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  const dock = page.getByRole('dialog', {
    name: 'Equipment Dock',
    exact: true,
  });
  if (kind === 'Switch' || kind === 'Router')
    await dock.getByRole('button', { name: 'Device', exact: true }).click();
  await dock.getByRole('button', { name: kind, exact: true }).click();
}
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
async function closeInspector(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
}
async function field(page: Page, label: string, value: string) {
  await inspector(page).getByLabel(label, { exact: true }).fill(value);
  await saved(page);
}
async function customValue(page: Page, key: string, value: string) {
  const custom = await details(inspector(page), 'Custom fields');
  await custom
    .getByRole('button', { name: 'Add custom field', exact: true })
    .click();
  await custom
    .getByLabel('Custom field name', { exact: true })
    .last()
    .fill(key);
  await custom
    .getByLabel('Custom field name', { exact: true })
    .last()
    .press('Tab');
  await custom.getByLabel(`Custom value ${key}`, { exact: true }).fill(value);
  await custom.getByLabel(`Custom value ${key}`, { exact: true }).press('Tab');
  await saved(page);
}
function withoutIds(document: BoardDocument) {
  return {
    ...document,
    elements: document.elements.map(({ id: _id, ...element }) => element),
    ports: document.ports.map(({ id: _id, deviceId, ...port }) => ({
      ...port,
      device: document.elements.find((element) => element.id === deviceId)!
        .name,
    })),
    cables: document.cables.map(
      ({ id: _id, sourcePortId, targetPortId, ...cable }) => ({
        ...cable,
        source: document.ports.find((port) => port.id === sourcePortId)!.name,
        target: document.ports.find((port) => port.id === targetPortId)!.name,
      }),
    ),
  };
}
async function details(locator: Locator, name: string) {
  const summary = locator
    .locator('summary')
    .filter({ hasText: new RegExp(`^${name}$`) });
  if (
    !(await summary
      .locator('..')
      .evaluate((element) => element.hasAttribute('open')))
  )
    await summary.click();
  return summary.locator('..');
}
async function dragBy(page: Page, locator: Locator, dx: number, dy: number) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const x = box.x + box.width - Math.min(16, box.width / 4),
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await saved(page);
}
async function menu(page: Page) {
  const summary = page.locator('summary[aria-label="Board menu"]');
  if (
    !(await summary
      .locator('..')
      .evaluate((element) => element.hasAttribute('open')))
  )
    await summary.click();
  return summary.locator('..');
}
async function jsonDownload(page: Page) {
  const pending = page.waitForEvent('download');
  await (
    await menu(page)
  )
    .getByRole('button', { name: 'Export JSON', exact: true })
    .click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    format: string;
    schemaVersion: number;
    name: string;
    document: BoardDocument;
  };
}

test('standalone boards and optional groups have real lifecycle and private session state', async ({
  page,
}, info) => {
  const first = unique('Standalone'),
    other = unique('Other'),
    group = unique('Work');
  const id = await createBoard(page, first);
  expect((await readBoard(page, id)).groupId).toBeNull();
  await expect(page.locator('[data-board-element-id]')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Equipment', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('empty-board.png'),
    fullPage: false,
  });
  await add(page, 'Network');
  await field(page, 'Network container name', 'Standalone network');
  await inspector(page)
    .getByRole('button', { name: 'Add network entry', exact: true })
    .click();
  await field(page, 'VLAN ID', '42');
  await field(page, 'Subnet/CIDR', '2001:db8:42::/64');
  await closeInspector(page);
  await (
    await browser(page)
  )
    .getByRole('button', { name: 'Add group', exact: true })
    .click();
  const groupDialog = page.getByRole('dialog', {
    name: 'New group',
    exact: true,
  });
  await groupDialog.getByLabel('Group name', { exact: true }).fill(group);
  await groupDialog
    .getByRole('button', { name: 'Create group', exact: true })
    .click();
  await (
    await boardActions(page, first)
  )
    .getByLabel(`Group for ${first}`, { exact: true })
    .selectOption({ label: group });
  await expect
    .poll(async () => (await readBoard(page, id)).groupId)
    .not.toBeNull();
  await (
    await browser(page)
  )
    .getByRole('button', { name: `Rename group ${group}`, exact: true })
    .click();
  const renameGroup = page.getByRole('dialog', {
    name: 'Rename group',
    exact: true,
  });
  await renameGroup
    .getByLabel('Group name', { exact: true })
    .fill(`${group} renamed`);
  await renameGroup
    .getByRole('button', { name: 'Rename', exact: true })
    .click();
  await (
    await boardActions(page, first)
  )
    .getByLabel(`Group for ${first}`, { exact: true })
    .selectOption('');
  await expect.poll(async () => (await readBoard(page, id)).groupId).toBeNull();
  await createBoard(page, other);
  await selectBoard(page, first);
  const standaloneElement = (await readBoard(page, id)).document.elements[0]!;
  await page
    .locator(
      `[data-board-element-id="${standaloneElement.id}"] .board-network-summary`,
    )
    .click();
  await inspector(page)
    .getByLabel('Network container name', { exact: true })
    .fill('Private network');
  await saved(page);
  await closeInspector(page);
  const beforeSwitch = (await readBoard(page, id)).document;
  const boardIndex = await (await page.request.get('/api/v1/boards')).json();
  const otherId = (boardIndex.boards as BoardRecord[]).find(
    (board) => board.name === other,
  )!.id;
  const switchRead = await holdRead(page, otherId);
  await (
    await browser(page)
  )
    .getByRole('navigation', { name: 'Boards', exact: true })
    .getByRole('button', { name: other, exact: true })
    .click();
  await switchRead.entered;
  await expectEditingBlocked(page);
  await page.keyboard.press('Control+z');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.locator(
      `[data-board-element-id="${standaloneElement.id}"] .board-element-name`,
    ),
  ).toHaveText('Private network');
  expect((await readBoard(page, id)).document).toEqual(beforeSwitch);
  switchRead.release();
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(other);
  await expect(page).toHaveURL(new RegExp(`/boards/${otherId}$`));
  await selectBoard(page, first);
  await (
    await boardActions(page, first)
  )
    .getByRole('button', { name: 'Rename board', exact: true })
    .click();
  const rename = page.getByRole('dialog', {
    name: 'Rename board',
    exact: true,
  });
  await rename
    .getByLabel('Board name', { exact: true })
    .fill(`${first} renamed`);
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  const renamed = `${first} renamed`;
  await (
    await boardActions(page, renamed)
  )
    .getByRole('button', { name: 'Duplicate board', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(`${renamed} copy`);
  const copyId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(copyId).not.toBe(id);
  const duplicated = await readBoard(page, copyId);
  expect(duplicated.document.elements).toHaveLength(1);
  expect(duplicated.document.elements[0]!.id).not.toBe(standaloneElement.id);
  expect(duplicated.document.elements[0]!.properties).toEqual(
    beforeSwitch.elements[0]!.properties,
  );
  // A → B → C, then two Back actions while B's first read is held.
  await selectBoard(page, renamed);
  await selectBoard(page, other);
  await selectBoard(page, `${renamed} copy`);
  const historyRead = await holdRead(page, otherId);
  await page.goBack();
  await historyRead.entered;
  await expectEditingBlocked(page);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/boards/${copyId}$`));
  await expect(page.locator('.board-title')).toHaveText(`${renamed} copy`);
  historyRead.release();
  await expect(page).toHaveURL(new RegExp(`/boards/${otherId}$`));
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(other);
  page.once('dialog', (dialog) => dialog.dismiss());
  await (
    await boardActions(page, `${renamed} copy`)
  )
    .getByRole('button', { name: 'Delete board', exact: true })
    .click();
  expect((await readBoard(page, copyId)).id).toBe(copyId);
  page.once('dialog', (dialog) => dialog.accept());
  await (
    await boardActions(page, `${renamed} copy`)
  )
    .getByRole('button', { name: 'Delete board', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await page.request.get(`/api/v1/boards/${copyId}`)).status(),
    )
    .toBe(404);
  await (
    await boardActions(page, renamed)
  )
    .getByLabel(`Group for ${renamed}`, { exact: true })
    .selectOption({ label: `${group} renamed` });
  page.once('dialog', (dialog) => dialog.accept());
  await (
    await browser(page)
  )
    .getByRole('button', { name: `Delete group ${group} renamed`, exact: true })
    .click();
  await expect.poll(async () => (await readBoard(page, id)).groupId).toBeNull();
  await selectBoard(page, renamed);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Rename current board', exact: true }),
  ).toHaveText(renamed);
  await (
    await browser(page)
  )
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-board-element-id]')).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Board browser', exact: true }),
  ).toHaveCount(0);
});

test('canvas equipment, flexible ports, network data and cables autosave and survive manipulation', async ({
  page,
  browser: playwrightBrowser,
}, info) => {
  test.setTimeout(180_000);
  const id = await createBoard(page, unique('Designer'));
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('equipment-dock.png'),
    fullPage: false,
  });
  await page
    .getByRole('button', { name: 'Close Equipment Dock', exact: true })
    .click();
  await add(page, 'Switch');
  await expect(inspector(page).getByLabel('Name', { exact: true })).toHaveValue(
    'Switch',
  );
  expect((await readBoard(page, id)).document.ports).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath('equipment-dock-created.png'),
    fullPage: false,
  });
  await field(page, 'Name', 'Edge switch');
  await field(page, 'Management address', '2001:db8::2, switch.example.test');
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('8');
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  let board = await readBoard(page, id);
  const switchId = board.document.elements[0]!.id;
  const element = (elementId: string) =>
    page.locator(`[data-board-element-id="${elementId}"]`);
  const portButton = (portId: string) =>
    page.locator(`button[data-port-id="${portId}"]`);
  expect(board.document.ports).toHaveLength(8);
  const artwork = element(switchId).locator('svg[data-connector="rj45"]');
  await expect(artwork).toHaveCount(8);
  for (const socket of await artwork.all())
    await expect(socket.locator('[data-contact="gold"]')).toHaveCount(8);
  const firstPort = board.document.ports[0]!;
  await element(switchId)
    .getByRole('button', { name: 'Rear', exact: true })
    .press('Enter');
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('1');
  await inspector(page)
    .getByRole('button', { name: 'Add SFP+ ports', exact: true })
    .click();
  await saved(page);
  const rearPort = (await readBoard(page, id)).document.ports.find(
    (port) => port.face === 'rear',
  )!;
  expect(rearPort.kind).toBe('sfp_plus');
  await expect(
    element(switchId).locator('svg[data-connector="sfp_plus"]'),
  ).toHaveCount(1);
  await element(switchId)
    .getByRole('button', { name: 'Front', exact: true })
    .press('Enter');
  await saved(page);
  await expect(portButton(rearPort.id)).toHaveCount(0);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const beforeMove = (await readBoard(page, id)).document.elements[0]!;
  await dragBy(
    page,
    element(switchId).locator('.board-element-header'),
    -70,
    30,
  );
  const moved = (await readBoard(page, id)).document.elements.find(
    (item) => item.id === switchId,
  )!;
  expect([moved.x, moved.y]).not.toEqual([beforeMove.x, beforeMove.y]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await readBoard(page, id)).document.elements[0]!.x).toBe(
    beforeMove.x,
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  expect((await readBoard(page, id)).document.elements[0]!.x).toBe(moved.x);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await element(switchId).locator('.board-element-name').dblclick();
  await page
    .getByLabel('Object name', { exact: true })
    .fill('Edge switch renamed');
  await page.getByLabel('Object name', { exact: true }).press('Enter');
  await saved(page);
  await element(switchId).locator('.board-element-header').click();
  const beforeResize = (await readBoard(page, id)).document;
  await page
    .getByRole('button', { name: 'Resize Edge switch renamed se', exact: true })
    .press('ArrowRight');
  await saved(page);
  board = await readBoard(page, id);
  expect(board.document.elements[0]!.width).toBeGreaterThan(
    beforeResize.elements[0]!.width,
  );
  expect(board.document.ports).toEqual(beforeResize.ports);
  for (let count = 0; count < 3; count++)
    await page
      .getByRole('button', {
        name: 'Resize Edge switch renamed se',
        exact: true,
      })
      .press('Shift+ArrowDown');
  await saved(page);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await portButton(firstPort.id).press('F2');
  await page.locator('input.board-inline-name').fill('Uplink');
  await page.locator('input.board-inline-name').press('Enter');
  await saved(page);
  expect(
    (await readBoard(page, id)).document.ports.find(
      (port) => port.id === firstPort.id,
    )!.name,
  ).toBe('Uplink');
  await portButton(firstPort.id).click();
  await field(page, 'Port Purpose', 'Provider handoff / routed WAN');
  await field(page, 'Native VLAN', '20');
  await field(page, 'Tagged VLANs', '30, Guest voice');
  await field(page, 'PVID', '99');
  await field(
    page,
    'Interface IP / Address',
    '192.0.2.2/30; 2001:db8:42::2/64',
  );
  const custom = await details(inspector(page), 'Custom fields');
  await custom
    .getByRole('button', { name: 'Add custom field', exact: true })
    .click();
  await custom.getByLabel('Custom field name', { exact: true }).fill('Watts');
  await custom.getByLabel('Custom field name', { exact: true }).press('Tab');
  await custom.getByLabel('Custom value Watts', { exact: true }).fill('0');
  await custom.getByLabel('Custom value Watts', { exact: true }).press('Tab');
  await saved(page);
  await custom
    .getByRole('button', { name: 'Add custom field', exact: true })
    .click();
  await custom
    .getByLabel('Custom field name', { exact: true })
    .last()
    .fill('PoE');
  await custom
    .getByLabel('Custom field name', { exact: true })
    .last()
    .press('Tab');
  await custom.getByLabel('Custom value PoE', { exact: true }).fill('false');
  await custom.getByLabel('Custom value PoE', { exact: true }).press('Tab');
  await saved(page);
  board = await readBoard(page, id);
  expect(
    board.document.ports.find((port) => port.id === firstPort.id),
  ).toMatchObject({
    nativeVlan: '20',
    pvid: '99',
    taggedVlans: ['30', 'Guest voice'],
    customFields: { Watts: 0, PoE: false },
  });
  await page.screenshot({
    path: info.outputPath('port-inspector-custom.png'),
    fullPage: false,
  });
  await inspector(page)
    .locator('.board-inspector-body')
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  await page.screenshot({
    path: info.outputPath('port-inspector.png'),
    fullPage: false,
  });
  await closeInspector(page);
  const tooltip = page.getByRole('tooltip');
  if (info.project.name === 'mobile-board') {
    const beforeTouch = (await readBoard(page, id)).document;
    const touch = await page.context().newCDPSession(page);
    let touching = false;
    try {
      const socket = (await portButton(firstPort.id).boundingBox())!;
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          {
            x: socket.x + socket.width / 2,
            y: socket.y + socket.height / 2,
            id: 1,
          },
        ],
      });
      touching = true;
      // Keep an actual native touch down until the authored hold summary appears.
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveAttribute(
        'data-summary-port-id',
        firstPort.id,
      );
      await expect(tooltip).toContainText('Provider handoff / routed WAN');
      await expect(tooltip).toContainText('PVID 99');
      await expect(tooltip).toContainText('Native VLAN 20');
      await expect(tooltip).not.toContainText('undefined');
      await page.screenshot({
        path: info.outputPath('port-longpress-summary.png'),
        fullPage: false,
      });
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      touching = false;
      await expect(inspector(page)).toHaveCount(0);
      await portButton(firstPort.id).tap();
      await expect(
        inspector(page).getByLabel('Port name', { exact: true }),
      ).toHaveValue('Uplink');
      await expect(tooltip).toHaveCount(0);
      expect((await readBoard(page, id)).document).toEqual(beforeTouch);
      await closeInspector(page);
    } finally {
      if (touching)
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchCancel',
          touchPoints: [],
        });
      await touch.detach();
    }
  } else {
    await portButton(firstPort.id).hover();
    await expect(
      tooltip.locator('[data-field="pvid"] .board-network-chip-value'),
    ).toHaveText('99');
    await expect(
      tooltip.locator('[data-field="nativeVlan"] .board-network-chip-value'),
    ).toHaveText('20');
    await portButton(firstPort.id).focus();
    await expect(portButton(firstPort.id)).toHaveAttribute(
      'aria-describedby',
      (await tooltip.getAttribute('id')) as string,
    );
    await page
      .getByRole('button', { name: 'Select objects', exact: true })
      .hover();
    await page
      .getByRole('button', { name: 'Select objects', exact: true })
      .focus();
    await expect(tooltip).toHaveCount(0);
  }
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  const beforeSlot = (await readBoard(page, id)).document.ports[0]!;
  await page
    .getByRole('button', { name: `Move ${beforeSlot.name}`, exact: true })
    .press('ArrowDown');
  await saved(page);
  const afterSlot = (await readBoard(page, id)).document.ports.find(
    (port) => port.id === firstPort.id,
  )!;
  expect(afterSlot.row).toBe(beforeSlot.row + 1);
  expect({ ...afterSlot, row: beforeSlot.row }).toEqual(beforeSlot);
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  await add(page, 'Router');
  await field(page, 'Name', 'Core router');
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('2');
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  board = await readBoard(page, id);
  const router = board.document.elements.find(
    (item) => item.name === 'Core router',
  )!;
  const routerPort = board.document.ports.find(
    (port) => port.deviceId === router.id,
  )!;
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await dragBy(
    page,
    element(router.id).locator('.board-element-header'),
    100,
    80,
  );
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await add(page, 'Cable');
  await portButton(firstPort.id).click();
  await portButton(routerPort.id).click();
  await saved(page);
  board = await readBoard(page, id);
  expect(board.document.cables).toHaveLength(1);
  const cable = board.document.cables[0]!;
  expect(new Set([cable.sourcePortId, cable.targetPortId])).toEqual(
    new Set([firstPort.id, routerPort.id]),
  );
  await field(page, 'Cable type', 'Cat6A');
  await field(page, 'Notes', 'Synthetic documented cable');
  await closeInspector(page);
  await page
    .getByRole('button', { name: 'Select objects', exact: true })
    .click();
  await expect(
    page.locator(`[data-board-cable-id="${cable.id}"]`),
  ).toBeVisible();
  const cablePath = page.locator(
    `[data-board-cable-id="${cable.id}"] path.board-cable-line`,
  );
  const beforeCableMove = await cablePath.getAttribute('d');
  const connectedState = (await readBoard(page, id)).document;
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await dragBy(
    page,
    element(router.id).locator('.board-element-header'),
    -40,
    40,
  );
  await expect(cablePath).not.toHaveAttribute('d', beforeCableMove!);
  expect((await readBoard(page, id)).document.cables).toEqual(
    connectedState.cables,
  );
  await closeInspector(page);
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  const beforePortMove = await cablePath.getAttribute('d');
  await page
    .getByRole('button', { name: 'Move Uplink', exact: true })
    .press('ArrowRight');
  await saved(page);
  await expect(cablePath).not.toHaveAttribute('d', beforePortMove!);
  expect((await readBoard(page, id)).document.cables).toEqual(
    connectedState.cables,
  );
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  await element(switchId)
    .getByRole('button', { name: 'Rear', exact: true })
    .press('Enter');
  await saved(page);
  await expect(page.locator(`[data-board-cable-id="${cable.id}"]`)).toHaveCount(
    0,
  );
  await element(switchId)
    .getByRole('button', { name: 'Front', exact: true })
    .press('Enter');
  await saved(page);
  await expect(cablePath).toBeVisible();
  await page.getByRole('button', { name: 'Hide cables', exact: true }).click();
  await saved(page);
  await expect(page.locator(`[data-board-cable-id="${cable.id}"]`)).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Show cables', exact: true }).click();
  await saved(page);
  const switchScreenWidth = (await element(switchId).boundingBox())!.width;
  await dragBy(
    page,
    element(switchId).locator('.board-element-header'),
    -Math.round(switchScreenWidth * 0.82),
    0,
  );
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const arranged = (await readBoard(page, id)).document;
  const leftDevice = arranged.elements.find((item) => item.id === switchId)!;
  const rightDevice = arranged.elements.find((item) => item.id === router.id)!;
  expect(leftDevice.x + leftDevice.width).toBeLessThanOrEqual(rightDevice.x);
  expect(arranged.cables).toEqual(connectedState.cables);
  await page.screenshot({
    path: info.outputPath('connected-board.png'),
    fullPage: false,
  });
  await add(page, 'Network');
  await field(page, 'Network container name', 'Independent network');
  await inspector(page)
    .getByRole('button', { name: 'Add network entry', exact: true })
    .click();
  await field(page, 'VLAN ID', '20');
  await field(page, 'Subnet/CIDR', '192.0.2.0/24');
  await field(page, 'Gateway', '192.0.2.1');
  await inspector(page)
    .getByRole('checkbox', { name: 'DHCP Server', exact: true })
    .check();
  await field(page, 'DHCP pool start', '192.0.2.50');
  await field(page, 'DHCP pool end', '192.0.2.80');
  await field(page, 'VLAN color', '#3377aa');
  const network = (await readBoard(page, id)).document.elements.find(
    (item) => item.name === 'Independent network',
  )!;
  const networkSummary = element(network.id).locator('.board-network-summary');
  await expect(networkSummary).not.toContainText('192.0.2.1');
  const display = await details(inspector(page), 'Visible fields');
  await display
    .getByRole('checkbox', { name: 'Show gateway', exact: true })
    .check();
  await saved(page);
  await expect(networkSummary).toContainText('192.0.2.1');
  expect(
    (await readBoard(page, id)).document.elements.find(
      (item) => item.id === network.id,
    )!.properties.entries,
  ).toEqual(network.properties.entries);
  await display
    .getByRole('checkbox', { name: 'Show gateway', exact: true })
    .uncheck();
  await saved(page);
  await expect(networkSummary).not.toContainText('192.0.2.1');
  await display
    .getByRole('checkbox', { name: 'Show gateway', exact: true })
    .check();
  await saved(page);
  await page.screenshot({
    path: info.outputPath('network-container.png'),
    fullPage: false,
  });
  await closeInspector(page);
  await expect(
    portButton(firstPort.id).locator('rect[data-vlan-border]'),
  ).toHaveAttribute('stroke', '#3377aa');
  const viewportBefore = (await readBoard(page, id)).document.viewport;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await saved(page);
  expect((await readBoard(page, id)).document.viewport.zoom).toBeGreaterThan(
    viewportBefore.zoom,
  );
  await page.getByRole('button', { name: 'Pan board', exact: true }).click();
  await page
    .getByRole('region', { name: 'Board canvas', exact: true })
    .press('ArrowRight');
  await saved(page);
  expect((await readBoard(page, id)).document.viewport.x).not.toBe(
    viewportBefore.x,
  );
  const persisted = (await readBoard(page, id)).document;
  await page.reload();
  await saved(page);
  expect((await readBoard(page, id)).document).toEqual(persisted);
  const secondContext = await playwrightBrowser.newContext();
  try {
    const second = await secondContext.newPage();
    await second.goto(page.url());
    await second.getByLabel('Username', { exact: true }).fill(username);
    await second.getByLabel('Password', { exact: true }).fill(password);
    await second.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(second.locator('[data-board-element-id]')).toHaveCount(3);
    expect((await readBoard(second, id)).document).toEqual(persisted);
  } finally {
    await secondContext.close();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('board archive roundtrip, image export and rejected writes preserve canonical data', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const id = await createBoard(page, unique('Archive'));
  await add(page, 'Switch');
  await field(page, 'Name', 'Archive switch');
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('24');
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page.screenshot({
    path: info.outputPath('twenty-four-port-board.png'),
    fullPage: false,
  });
  const sourcePorts = (await readBoard(page, id)).document.ports;
  await page.locator(`button[data-port-id="${sourcePorts[0]!.id}"]`).click();
  await field(page, 'Native VLAN', '20');
  await field(page, 'PVID', '99');
  await field(
    page,
    'Interface IP / Address',
    '198.51.100.2/24; archive.example.test',
  );
  await customValue(page, 'Zero', '0');
  await customValue(page, 'Enabled', 'false');
  await closeInspector(page);
  await add(page, 'Cable');
  await page.locator(`button[data-port-id="${sourcePorts[0]!.id}"]`).click();
  await page.locator(`button[data-port-id="${sourcePorts[1]!.id}"]`).click();
  await saved(page);
  await field(page, 'Cable type', 'Cat6A');
  await field(page, 'Notes', 'Archive cable proof');
  await closeInspector(page);
  await page
    .getByRole('button', { name: 'Select objects', exact: true })
    .click();
  const archive = await jsonDownload(page);
  expect(archive.format).toBe('portfolio-board');
  expect(archive.document.ports).toHaveLength(24);
  const original = await readBoard(page, id);
  await page.getByLabel('Import board file', { exact: true }).setInputFiles({
    name: 'malformed.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ broken'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await readBoard(page, id)).document).toEqual(original.document);
  await page
    .getByRole('button', { name: 'Dismiss error', exact: true })
    .click();
  const invalid = structuredClone(archive);
  invalid.document.ports[0]!.deviceId = 'foreign-device';
  await page.getByLabel('Import board file', { exact: true }).setInputFiles({
    name: 'foreign.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.getByRole('alert')).toContainText('not a valid');
  expect((await readBoard(page, id)).document).toEqual(original.document);
  await page
    .getByRole('button', { name: 'Dismiss error', exact: true })
    .click();
  await page.getByLabel('Import board file', { exact: true }).setInputFiles({
    name: 'board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  const preview = page.getByRole('dialog', {
    name: 'Import board preview',
    exact: true,
  });
  await expect(preview).toContainText('24 ports');
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await readBoard(page, id)).document).toEqual(original.document);
  await page.getByLabel('Import board file', { exact: true }).setInputFiles({
    name: 'board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await page
    .getByRole('dialog', { name: 'Import board preview', exact: true })
    .getByRole('button', { name: 'Import as new board', exact: true })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`/boards/${id}$`));
  await saved(page);
  const copyId = new URL(page.url()).pathname.split('/').at(-1)!;
  const copy = await readBoard(page, copyId);
  expect(copy.document.ports).toHaveLength(24);
  expect(copy.document.cables).toHaveLength(1);
  expect(withoutIds(copy.document)).toEqual(withoutIds(original.document));
  const originalIds = new Set(
    [
      ...original.document.elements,
      ...original.document.ports,
      ...original.document.cables,
    ].map((item) => item.id),
  );
  expect(
    [
      ...copy.document.elements,
      ...copy.document.ports,
      ...copy.document.cables,
    ].every((item) => !originalIds.has(item.id)),
  ).toBe(true);
  expect(copy.document.elements[0]!.id).not.toBe(
    original.document.elements[0]!.id,
  );
  expect(copy.document.ports.map((port) => port.name)).toEqual(
    original.document.ports.map((port) => port.name),
  );
  expect((await readBoard(page, id)).document).toEqual(original.document);
  const imagePending = page.waitForEvent('download');
  await (
    await menu(page)
  )
    .getByRole('button', { name: 'Export image', exact: true })
    .click();
  const image = await imagePending;
  const svg = await readFile((await image.path())!, 'utf8');
  await page.locator('summary[aria-label="Board menu"]').click();
  expect(svg).toContain('<svg');
  expect(svg).toContain(RJ45_SOCKET_PATH);
  expect(svg).not.toContain('Resize Archive switch');
  const token = (await (await page.request.get('/api/v1/auth/session')).json())
    .csrfToken;
  const origin = new URL(page.url()).origin;
  const csrf = await page.request.patch(`/api/v1/boards/${copyId}`, {
    headers: { Origin: origin },
    data: { rowVersion: copy.rowVersion, document: emptyBoardDocument() },
  });
  expect(csrf.status()).toBe(403);
  expect((await readBoard(page, copyId)).document).toEqual(copy.document);
  const external = await page.request.patch(`/api/v1/boards/${copyId}`, {
    headers: { Origin: origin, 'x-csrf-token': token },
    data: { rowVersion: copy.rowVersion, name: 'Remote rename' },
  });
  expect(external.status()).toBe(200);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.board-save-status')).toHaveText('Not saved');
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await readBoard(page, copyId)).document).toEqual(copy.document);
  page.once('dialog', (dialog) => dialog.accept());
  const acceptedUrl = page.url();
  const reloadRead = await holdRead(page, copyId);
  await page
    .getByRole('button', { name: 'Load saved board', exact: true })
    .click();
  await reloadRead.entered;
  await expectEditingBlocked(page);
  await page.goBack();
  await expect(page).toHaveURL(acceptedUrl);
  expect((await readBoard(page, copyId)).document).toEqual(copy.document);
  reloadRead.release();
  await saved(page);
  expect((await readBoard(page, copyId)).document).toEqual(copy.document);
  await page
    .locator(
      `[data-board-element-id="${copy.document.elements[0]!.id}"] .board-element-header`,
    )
    .click();
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('24');
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  expect((await readBoard(page, copyId)).document.ports).toHaveLength(48);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await expect(page.locator('svg[data-connector="rj45"]')).toHaveCount(48);
  await page.screenshot({
    path: info.outputPath('forty-eight-port-board.png'),
    fullPage: false,
  });
});
