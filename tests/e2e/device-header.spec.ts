import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardPort,
  type BoardRecord,
} from '../../packages/shared/src/board.js';

test.use({ actionTimeout: 15_000 });
const fieldNames = [
  'Manufacturer',
  'Model',
  'Management Address',
  'Device Type',
  'Port Count',
  'Notes',
  'Custom Fields',
];
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
async function collapseBrowser(page: Page) {
  const button = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await button.isVisible()) await button.click();
}
async function select(page: Page, device: Locator) {
  await closeInspector(page);
  await collapseBrowser(page);
  const header = device.locator('.board-element-header');
  const box = await header.boundingBox();
  if (!box) throw new Error('Device header unavailable');
  await header.click({ position: { x: 3, y: Math.max(1, box.height - 3) } });
  await expect(inspector(page)).toBeVisible();
}
async function visibleFields(page: Page) {
  const summary = inspector(page)
    .locator('summary')
    .filter({ hasText: /^Visible fields$/i });
  const details = summary.locator('..');
  if (!(await details.evaluate((node) => node.hasAttribute('open'))))
    await summary.click();
  return details;
}
async function bounds(device: Locator) {
  return device.evaluate((node) => {
    const header = node.querySelector<HTMLElement>('.board-element-header')!;
    const deviceRect = node.getBoundingClientRect();
    const scale = deviceRect.width / (node as HTMLElement).offsetWidth;
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      width: (node as HTMLElement).style.width,
      height: (node as HTMLElement).style.height,
      headerHeight: header.offsetHeight,
      ports: [...node.querySelectorAll<HTMLElement>('.board-port')].map(
        (port) => ({
          id: port.dataset.boardPortId,
          left: port.style.left,
          top: port.style.top,
          width: port.style.width,
          height: port.style.height,
          actualLeft: round(
            (port.getBoundingClientRect().left - deviceRect.left) / scale,
          ),
          actualTop: round(
            (port.getBoundingClientRect().top - deviceRect.top) / scale,
          ),
          actualWidth: round(port.getBoundingClientRect().width / scale),
          actualHeight: round(port.getBoundingClientRect().height / scale),
        }),
      ),
    };
  });
}
async function contained(device: Locator) {
  const result = await device
    .locator('.board-element-header')
    .evaluate((header) => {
      const frame = header.getBoundingClientRect();
      const chips = [
        ...header.querySelectorAll<HTMLElement>('.board-device-info-chip'),
      ];
      const name = header.querySelector<HTMLElement>('.board-element-name')!;
      const buttons = [
        ...header.querySelectorAll<HTMLElement>('.board-face-switch button'),
      ];
      return {
        height: (header as HTMLElement).offsetHeight,
        scrollWidth: header.scrollWidth,
        width: header.clientWidth,
        scrollHeight: header.scrollHeight,
        clientHeight: header.clientHeight,
        escaped: chips.filter((chip) => {
          const b = chip.getBoundingClientRect();
          return (
            b.left < frame.left - 1 ||
            b.right > frame.right + 1 ||
            b.top < frame.top - 1 ||
            b.bottom > frame.bottom + 1
          );
        }).length,
        nameWidth: name.getBoundingClientRect().width,
        buttons: buttons.map((button) => {
          const b = button.getBoundingClientRect();
          return (
            b.left >= frame.left - 1 &&
            b.right <= frame.right + 1 &&
            b.top >= frame.top - 1 &&
            b.bottom <= frame.bottom + 1
          );
        }),
      };
    });
  expect(result.height).toBe(80);
  expect(result.escaped).toBe(0);
  expect(result.scrollWidth).toBeLessThanOrEqual(result.width + 1);
  expect(result.scrollHeight).toBeLessThanOrEqual(result.clientHeight + 1);
  expect(result.nameWidth).toBeGreaterThan(0);
  expect(result.buttons).toEqual([true, true]);
}
function port(
  deviceId: string,
  face: BoardPort['face'],
  name: string,
): BoardPort {
  return {
    id: randomUUID(),
    deviceId,
    face,
    row: 0,
    column: 0,
    name,
    kind: 'rj45',
    color: '#428deb',
    role: 'Authored uplink',
    speed: '10G',
    linkState: 'unknown',
    nativeVlan: '20',
    taggedVlans: ['30'],
    pvid: '99',
    address: 'host.example',
    externalDestination: '',
    notes: '',
    customFields: { Count: 0, Enabled: false },
  };
}

test('device header information fits a fixed eighty-pixel header without changing device or port geometry', async ({
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
  const document = emptyBoardDocument();
  const deviceId = randomUUID(),
    peerId = randomUUID();
  document.elements = [
    {
      id: deviceId,
      type: 'device',
      name: 'Core Router with a long editable name',
      x: 40,
      y: 100,
      width: 800,
      height: 340,
      z: 0,
      color: '#24332b',
      properties: {
        face: 'front',
        manufacturer:
          'Manufacturer International Research and Infrastructure Systems '.repeat(
            3,
          ),
        model: 'Long Model ' + 'ABC123-'.repeat(15),
        managementAddress:
          '2001:db8:' + 'abcd:'.repeat(20) + '64 / router.management.example',
        deviceType: 'Custom routed documentation appliance',
        notes:
          'Authored device notes remain available in the inspector.\nSecond line.',
        customFields: {
          Capacity: 0,
          Monitored: false,
          Owner: 'Network operations',
        },
      },
    },
    {
      id: peerId,
      type: 'device',
      name: 'Peer Switch',
      x: 40,
      y: 600,
      width: 300,
      height: 220,
      z: 1,
      color: '',
      properties: {
        manufacturer: 'Peer maker',
        model: 'Peer model',
        managementAddress: 'peer.example',
      },
    },
  ];
  document.ports = [
    port(deviceId, 'front', 'Uplink'),
    port(deviceId, 'rear', 'Rear interface'),
    port(peerId, 'front', 'Peer'),
  ];
  document.cables = [
    {
      id: randomUUID(),
      sourcePortId: document.ports[0]!.id,
      targetPortId: document.ports[2]!.id,
      name: 'Documented cable',
      cableType: 'Cat6A',
      sourceConnector: '',
      targetConnector: '',
      color: '#b8c6d0',
      length: '',
      notes: '',
    },
  ];
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: 'Fixed header ' + randomUUID().slice(0, 8), document },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).board.id as string;
  await page.goto(`/boards/${id}`);
  await saved(page);
  await collapseBrowser(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const device = page.locator(`[data-board-element-id="${deviceId}"]`);
  const peer = page.locator(`[data-board-element-id="${peerId}"]`);
  const cable = page.locator(
    `[data-board-cable-id="${document.cables[0]!.id}"] .board-cable-line`,
  );
  const initialGeometry = await bounds(device);
  const initialPath = await cable.getAttribute('d');
  const original = await read(page, id);
  await contained(device);
  await expect(
    device.locator('.board-device-info-chip[data-field="manufacturer"]'),
  ).toBeVisible();
  await expect(
    device.locator('.board-device-info-chip[data-field="model"]'),
  ).toBeVisible();
  await expect(
    device.locator('.board-device-info-chip[data-field="managementAddress"]'),
  ).toBeVisible();
  await expect(
    device.locator('.board-device-info-chip[data-field="manufacturer"]'),
  ).toHaveAttribute(
    'title',
    `Manufacturer: ${document.elements[0]!.properties.manufacturer}`,
  );
  await expect(
    device.locator(
      '.board-device-info-chip[data-field="model"] .board-device-info-value',
    ),
  ).toHaveCSS('text-overflow', 'ellipsis');
  expect(
    await device
      .locator(
        '.board-device-info-chip[data-field="model"] .board-device-info-value',
      )
      .evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  await select(page, device);
  let fields = await visibleFields(page);
  for (const name of fieldNames)
    await expect(
      fields.getByRole('checkbox', {
        name: `Show header ${name}`,
        exact: true,
      }),
    ).toBeChecked({
      checked: ['Manufacturer', 'Model', 'Management Address'].includes(name),
    });
  for (const name of ['Manufacturer', 'Model', 'Management Address'])
    await fields
      .getByRole('checkbox', { name: `Show header ${name}`, exact: true })
      .uncheck();
  await saved(page);
  expect(await bounds(device)).toEqual(initialGeometry);
  await expect(device.locator('.board-device-info-chip')).toHaveCount(0);
  await expect(cable).toHaveAttribute('d', initialPath!);
  await closeInspector(page);
  await page.screenshot({ path: info.outputPath('device-header-none.png') });
  await select(page, device);
  fields = await visibleFields(page);
  for (const name of fieldNames)
    await fields
      .getByRole('checkbox', { name: `Show header ${name}`, exact: true })
      .check();
  await saved(page);
  expect(await bounds(device)).toEqual(initialGeometry);
  await contained(device);
  await expect(cable).toHaveAttribute('d', initialPath!);
  let current = await read(page, id);
  expect(current.document.ports).toEqual(original.document.ports);
  expect(current.document.cables).toEqual(original.document.cables);
  expect(current.document.elements[1]).toEqual(original.document.elements[1]);
  expect(current.document.elements[0]).toMatchObject({
    x: 40,
    y: 100,
    width: 800,
    height: 340,
  });
  // Change priority without changing any physical data.
  for (let i = 0; i < 6; i++)
    await fields
      .getByRole('button', { name: 'Move Custom Fields earlier', exact: true })
      .click();
  await saved(page);
  await expect(
    device.locator(
      '.board-device-info-chip[data-field="customFields.Capacity"]',
    ),
  ).toContainText('0');
  await expect(
    device.locator(
      '.board-device-info-chip[data-field="customFields.Monitored"]',
    ),
  ).toContainText('false');
  expect(
    (await read(page, id)).document.elements[0]!.properties.headerFields,
  ).toEqual([
    'customFields',
    'manufacturer',
    'model',
    'managementAddress',
    'deviceType',
    'portCount',
    'notes',
  ]);
  await closeInspector(page);
  await contained(device);
  await page.screenshot({
    path: info.outputPath('device-header-all-wide.png'),
  });
  // User resizing changes only the container dimensions, never occupied slots.
  await select(page, device);
  const resize = page.getByRole('button', {
    name: 'Resize Core Router with a long editable name e',
    exact: true,
  });
  for (let i = 0; i < 16; i++) await resize.press('Alt+Shift+ArrowLeft');
  await saved(page);
  current = await read(page, id);
  expect(current.document.elements[0]!.width).toBe(160);
  expect(current.document.elements[0]!.height).toBe(340);
  expect(current.document.ports).toEqual(original.document.ports);
  expect(current.document.cables).toEqual(original.document.cables);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await contained(device);
  const narrowGeometry = await bounds(device);
  expect(narrowGeometry.headerHeight).toBe(80);
  expect(
    await device
      .locator('.board-element-name')
      .evaluate((node) => (node as HTMLElement).offsetWidth),
  ).toBeGreaterThanOrEqual(120);
  expect(narrowGeometry.ports).toEqual(initialGeometry.ports);
  await expect(device.locator('.board-element-name')).toBeVisible();
  expect(await device.locator('.board-device-info-chip').count()).toBeLessThan(
    8,
  );
  expect(
    await device
      .locator('.board-device-info-chip')
      .first()
      .getAttribute('data-field'),
  ).toBe('customFields.Capacity');
  await expect(
    device.locator('.board-device-info-chip[data-field="manufacturer"]'),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('device-header-all-narrow.png'),
  });
  const narrowSaved = await read(page, id);
  await page.reload();
  await saved(page);
  await collapseBrowser(page);
  expect(await bounds(device)).toEqual(narrowGeometry);
  await contained(device);
  expect(
    (await read(page, id)).document.elements[0]!.properties.headerFields,
  ).toEqual(narrowSaved.document.elements[0]!.properties.headerFields);
  expect((await read(page, id)).document.ports).toEqual(
    original.document.ports,
  );
  expect((await read(page, id)).document.cables).toEqual(
    original.document.cables,
  );
  const beforeZoom = await bounds(device);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await saved(page);
  await contained(device);
  expect(await bounds(device)).toEqual(beforeZoom);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await saved(page);
  await contained(device);
  expect(await bounds(device)).toEqual(beforeZoom);
  // Face controls keep their behavior, and rear coordinates are preserved too.
  await device
    .getByRole('button', { name: 'Rear', exact: true })
    .press('Enter');
  await saved(page);
  await expect(
    page.locator(`button[data-port-id="${document.ports[1]!.id}"]`),
  ).toBeVisible();
  expect((await read(page, id)).document.ports).toEqual(
    original.document.ports,
  );
  await device
    .getByRole('button', { name: 'Front', exact: true })
    .press('Enter');
  await saved(page);
  await contained(device);
  expect((await read(page, id)).document.cables).toEqual(
    original.document.cables,
  );
  await expect(
    peer.locator('.board-device-info-chip[data-field="manufacturer"]'),
  ).toContainText('Peer maker');
  expect(errors).toEqual([]);
});
