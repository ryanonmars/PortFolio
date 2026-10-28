import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';

test.use({ actionTimeout: 15_000 });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
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
async function closeInspector(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
}
async function add(page: Page, kind: 'Router' | 'Switch' | 'Cable') {
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  const dock = page.getByRole('dialog', {
    name: 'Equipment Dock',
    exact: true,
  });
  if (kind !== 'Cable')
    await dock.getByRole('button', { name: 'Device', exact: true }).click();
  await dock.getByRole('button', { name: kind, exact: true }).click();
}
async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 16 });
  await page.mouse.up();
  await saved(page);
}

test('physical port slots retain an eleven-port mixed face and explicit two-row layouts across viewports', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
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
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: {
      name: `Physical layout ${randomUUID().slice(0, 8)}`,
      document: emptyBoardDocument(),
    },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).board.id as string;
  await page.goto(`/boards/${id}`);
  await saved(page);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await add(page, 'Router');
  await inspector(page)
    .getByLabel('Name', { exact: true })
    .fill('TP-Link ER8411 example');
  for (const [quantity, connector] of [
    ['2', 'SFP+'],
    ['1', 'SFP'],
    ['8', 'RJ45'],
  ]) {
    await inspector(page)
      .getByLabel('Port quantity', { exact: true })
      .fill(quantity!);
    await inspector(page)
      .getByRole('button', { name: `Add ${connector} ports`, exact: true })
      .click();
    await saved(page);
  }
  let document = (await read(page, id)).document;
  const device = document.elements[0]!;
  const element = page.locator(`[data-board-element-id="${device.id}"]`);
  const ports = document.ports;
  expect(ports).toHaveLength(11);
  expect(ports.map((port) => port.kind)).toEqual([
    'sfp_plus',
    'sfp_plus',
    'sfp',
    ...Array(8).fill('rj45'),
  ]);
  expect(ports.map((port) => [port.row, port.column])).toEqual(
    Array.from({ length: 11 }, (_, column) => [0, column]),
  );
  await expect(element.locator('svg[data-connector="rj45"]')).toHaveCount(8);
  await expect(element.locator('svg[data-connector="sfp_plus"]')).toHaveCount(
    2,
  );
  await expect(element.locator('svg[data-connector="sfp"]')).toHaveCount(1);
  for (const socket of await element
    .locator('svg[data-connector="rj45"]')
    .all())
    await expect(socket.locator('[data-contact="gold"]')).toHaveCount(8);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const first = page.locator(`button[data-port-id="${ports[0]!.id}"]`);
  if (info.project.name.startsWith('mobile')) await first.tap();
  else await first.click();
  await inspector(page).getByLabel('Port name', { exact: true }).fill('WAN');
  await inspector(page).getByLabel('PVID', { exact: true }).fill('99');
  await inspector(page)
    .getByLabel('Port role', { exact: true })
    .fill('Custom uplink');
  await saved(page);
  await closeInspector(page);
  await add(page, 'Cable');
  await first.click();
  await page.locator(`button[data-port-id="${ports[10]!.id}"]`).click();
  await saved(page);
  document = (await read(page, id)).document;
  expect(document.cables).toHaveLength(1);
  const cable = document.cables[0]!;
  const path = page.locator(
    `[data-board-cable-id="${cable.id}"] .board-cable-line`,
  );
  await closeInspector(page);
  await page
    .getByRole('button', { name: 'Select objects', exact: true })
    .click();
  await element.locator('.board-element-header').click();
  const beforeResize = (await read(page, id)).document;
  const handle = page.getByRole('button', {
    name: 'Resize TP-Link ER8411 example se',
    exact: true,
  });
  for (let n = 0; n < 5; n++) await handle.press('Shift+ArrowRight');
  for (let n = 0; n < 3; n++) await handle.press('Shift+ArrowDown');
  await saved(page);
  document = (await read(page, id)).document;
  expect(document.elements[0]!.width).toBeGreaterThan(
    beforeResize.elements[0]!.width,
  );
  expect(document.ports).toEqual(beforeResize.ports);
  expect(document.cables).toEqual(beforeResize.cables);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  const beforeMove = (await read(page, id)).document;
  const zoom = beforeMove.viewport.zoom;
  const cableBefore = await path.getAttribute('d');
  await dragBy(
    page,
    page.getByRole('button', { name: 'Move WAN', exact: true }),
    12 * 72 * zoom,
    0,
  );
  const moved = (await read(page, id)).document;
  const movedPort = moved.ports.find((port) => port.id === ports[0]!.id)!;
  expect(movedPort.column).toBe(12);
  expect(movedPort.row).toBe(0);
  expect({ ...movedPort, column: 0 }).toEqual(beforeMove.ports[0]);
  expect(moved.cables).toEqual(beforeMove.cables);
  await expect(path).not.toHaveAttribute('d', cableBefore!);
  await closeInspector(page);
  // A drop on occupied column1 must retain the independent sparse placement.
  await dragBy(
    page,
    page.getByRole('button', { name: 'Move WAN', exact: true }),
    -11 * 72 * zoom,
    0,
  );
  expect((await read(page, id)).document.ports).toEqual(moved.ports);
  await closeInspector(page);
  // Restore the physical order after proving that intentional empty slots work.
  await dragBy(
    page,
    page.getByRole('button', { name: 'Move WAN', exact: true }),
    -12 * 72 * zoom,
    0,
  );
  await closeInspector(page);
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  await element.locator('.board-element-header').click();
  for (let n = 0; n < 12; n++) await handle.press('Shift+ArrowLeft');
  for (let n = 0; n < 12; n++) await handle.press('Shift+ArrowUp');
  await saved(page);
  const physical = (await read(page, id)).document;
  expect(physical.ports).toEqual(beforeMove.ports);
  expect(physical.cables).toEqual(beforeMove.cables);
  expect(physical.elements[0]!.width).toBeGreaterThanOrEqual(816);
  expect(physical.elements[0]!.height).toBeGreaterThanOrEqual(204);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page.screenshot({
    path: info.outputPath('er8411-eleven-port-face.png'),
  });

  await add(page, 'Switch');
  await inspector(page)
    .getByLabel('Name', { exact: true })
    .fill('Explicit two-row switch');
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('24');
  await inspector(page).getByLabel('Ports per row', { exact: true }).fill('12');
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  const all = (await read(page, id)).document;
  const second = all.elements.find(
    (item) => item.name === 'Explicit two-row switch',
  )!;
  const twentyFour = all.ports.filter((port) => port.deviceId === second.id);
  expect(twentyFour).toHaveLength(24);
  expect(twentyFour.map((port) => [port.row, port.column])).toEqual(
    Array.from({ length: 24 }, (_, index) => [
      Math.floor(index / 12),
      index % 12,
    ]),
  );
  expect(all.ports.filter((port) => port.deviceId === device.id)).toEqual(
    physical.ports,
  );
  await closeInspector(page);
  await page.reload();
  await saved(page);
  const persisted = (await read(page, id)).document;
  expect(persisted.ports).toEqual(all.ports);
  expect(persisted.cables).toEqual(all.cables);
  const layout = async () =>
    element.locator('[data-board-port-id]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-board-port-id'),
        left: (node as HTMLElement).style.left,
        top: (node as HTMLElement).style.top,
        width: (node as HTMLElement).style.width,
        height: (node as HTMLElement).style.height,
      })),
    );
  const originalLayout = await layout();
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize(
    originalViewport.width < 600
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 },
  );
  await page.reload();
  await saved(page);
  expect(await layout()).toEqual(originalLayout);
  expect((await read(page, id)).document.ports).toEqual(all.ports);
  expect((await read(page, id)).document.cables).toEqual(all.cables);
  expect(errors).toEqual([]);
});
