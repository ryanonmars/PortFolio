import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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

test('device headers display complete natural pills or accessible overflow without moving physical ports', async ({
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
      name: 'ER8411 Router',
      x: 40,
      y: 100,
      width: 800,
      height: 340,
      z: 0,
      color: '#24332b',
      properties: {
        face: 'front',
        manufacturer: 'TP-Link',
        model: 'ER8411',
        managementAddress: '192.168.0.1',
        deviceType: 'Router',
        notes:
          'Authored device notes remain complete in the information popover.',
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
    data: { name: 'Readable header ' + randomUUID().slice(0, 8), document },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).board.id as string;
  await page.goto(`/boards/${id}`);
  await saved(page);
  await collapseBrowser(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const device = page.locator(`[data-board-element-id="${deviceId}"]`);
  const chips = device.locator('.board-device-info-chip');
  const icon = device.getByRole('button', {
    name: 'Device information',
    exact: true,
  });
  const cable = page.locator(
    `[data-board-cable-id="${document.cables[0]!.id}"] .board-cable-line`,
  );
  const initial = await bounds(device),
    initialCable = await cable.getAttribute('d');
  const original = await read(page, id);
  await mkdir('.tmp/qa-media/device-header-layout', { recursive: true });
  async function screenshot(name: string) {
    await page.screenshot({
      path: `.tmp/qa-media/device-header-layout/${info.project.name}-${name}.png`,
    });
  }
  async function completePills() {
    const sizes = await chips.evaluateAll((nodes) =>
      nodes.map((node) => ({
        height: (node as HTMLElement).offsetHeight,
        clipped: [
          ...node.querySelectorAll<HTMLElement>(
            '.board-device-info-label,.board-device-info-value',
          ),
        ].some((child) => child.scrollWidth > child.clientWidth + 1),
      })),
    );
    for (const size of sizes) {
      expect(size.height).toBe(32);
      expect(size.clipped).toBe(false);
    }
    await contained(device);
  }
  async function unchangedGeometry() {
    const current = await bounds(device);
    expect(current.headerHeight).toBe(80);
    expect(current.height).toBe(initial.height);
    expect(current.ports).toEqual(initial.ports);
    await expect(cable).toHaveAttribute('d', initialCable!);
    const stored = await read(page, id);
    expect(stored.document.ports).toEqual(original.document.ports);
    expect(stored.document.cables).toEqual(original.document.cables);
  }
  async function resize(
    width: number,
    properties: Record<string, string> = {},
  ) {
    await closeInspector(page);
    const current = await read(page, id);
    const changed = structuredClone(current.document);
    const element = changed.elements.find((item) => item.id === deviceId)!;
    element.width = width;
    Object.assign(element.properties, properties);
    const update = await page.request.patch(`/api/v1/boards/${id}`, {
      headers: {
        Origin: new URL(page.url()).origin,
        'x-csrf-token': auth.csrfToken,
      },
      data: { rowVersion: current.rowVersion, document: changed },
    });
    expect(update.status()).toBe(200);
    await page.reload();
    await saved(page);
    await collapseBrowser(page);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await saved(page);
    await unchangedGeometry();
  }
  async function popup() {
    const target = await icon.getAttribute('aria-controls');
    expect(target).toBeTruthy();
    return page.locator(`[id="${target}"]`);
  }
  async function popupWithinViewport() {
    const panel = await popup();
    await expect(panel).toBeVisible();
    const visible = await panel.evaluate((node) => {
      const box = node.getBoundingClientRect(),
        viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0,
        top = viewport?.offsetTop ?? 0;
      return (
        box.left >= left &&
        box.top >= top &&
        box.right <= left + (viewport?.width ?? innerWidth) + 1 &&
        box.bottom <= top + (viewport?.height ?? innerHeight) + 1
      );
    });
    expect(visible).toBe(true);
    return panel;
  }
  async function wide() {
    await expect(chips).toHaveCount(3);
    for (const [field, value] of [
      ['manufacturer', 'TP-Link'],
      ['model', 'ER8411'],
      ['managementAddress', '192.168.0.1'],
    ])
      await expect(
        device.locator(
          `.board-device-info-chip[data-field="${field}"] .board-device-info-value`,
        ),
      ).toHaveText(value!);
    await expect(icon).toHaveCount(0);
    await completePills();
    await unchangedGeometry();
  }
  await wide();
  await screenshot('wide-800');
  // Real resize actions must refit the mounted header without a reload.
  await select(page, device);
  const resizeHandle = device.getByRole('button', {
    name: 'Resize ER8411 Router e',
    exact: true,
  });
  for (let step = 0; step < 16; step++)
    await resizeHandle.press('Shift+ArrowLeft');
  await saved(page);
  await expect(chips).toHaveCount(0);
  await expect(icon).toBeVisible();
  await unchangedGeometry();
  for (let step = 0; step < 16; step++)
    await resizeHandle.press('Shift+ArrowRight');
  await saved(page);
  await closeInspector(page);
  await wide();
  await resize(1200);
  await wide();
  await screenshot('wide-1200');
  await resize(360);
  await expect(icon).toBeVisible();
  const shown = await chips.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.field),
  );
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(3);
  expect(shown).toEqual(
    ['manufacturer', 'model', 'managementAddress'].slice(0, shown.length),
  );
  await completePills();
  await icon.click();
  let panel = await popupWithinViewport();
  const fullFields = [
    ['manufacturer', 'TP-Link'],
    ['model', 'ER8411'],
    ['managementAddress', '192.168.0.1'],
  ];
  for (const [field, value] of fullFields) {
    if (shown.includes(field)) await expect(panel).not.toContainText(value!);
    else await expect(panel).toContainText(value!);
  }
  await screenshot('medium-popover');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await resize(160);
  // Read-only information must isolate canvas/editor keyboard shortcuts.
  await select(page, device);
  const beforeInformation = await read(page, id);
  await icon.focus();
  await icon.press('Space');
  await expect(icon).toHaveAttribute('aria-expanded', 'true');
  await icon.press('Space');
  await expect(icon).toHaveAttribute('aria-expanded', 'false');
  await icon.press('Space');
  await expect(icon).toHaveAttribute('aria-expanded', 'true');
  for (const key of [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Delete',
    'Backspace',
  ])
    await icon.press(key);
  await expect(page.locator('.board-canvas')).not.toHaveClass(/space-pan/);
  expect(await read(page, id)).toEqual(beforeInformation);
  await page.keyboard.press('Escape');
  await expect(await popup()).toBeHidden();
  await closeInspector(page);
  await expect(chips).toHaveCount(0);
  await expect(icon).toBeVisible();
  await contained(device);
  await icon.focus();
  panel = await popupWithinViewport();
  for (const value of ['TP-Link', 'ER8411', '192.168.0.1'])
    await expect(panel).toContainText(value);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  if (info.project.name.startsWith('desktop')) {
    await icon.hover();
    await popupWithinViewport();
    await page.keyboard.press('Escape');
  }
  await icon.click();
  panel = await popupWithinViewport();
  await screenshot('narrow-popover');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(panel).toBeHidden();
  await saved(page);
  await unchangedGeometry();
  await resize(800);
  await wide();
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
  await expect(chips).toHaveCount(0);
  await expect(icon).toHaveCount(0);
  await unchangedGeometry();
  for (const name of fieldNames)
    await fields
      .getByRole('checkbox', { name: `Show header ${name}`, exact: true })
      .check();
  for (let index = 0; index < 6; index++)
    await fields
      .getByRole('button', { name: 'Move Custom Fields earlier', exact: true })
      .click();
  await saved(page);
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
  await expect(chips.first()).toHaveAttribute(
    'data-field',
    'customFields.Capacity',
  );
  await expect(chips.first()).toContainText('0');
  await expect(
    device.locator(
      '.board-device-info-chip[data-field="customFields.Monitored"]',
    ),
  ).toContainText('false');
  await completePills();
  await unchangedGeometry();
  await screenshot('all-fields-priority');
  const longManufacturer =
    'Manufacturer International Research and Infrastructure Systems '.repeat(3);
  const longModel = 'Long Model ' + 'ABC123-'.repeat(15);
  await resize(800, { manufacturer: longManufacturer, model: longModel });
  await expect(icon).toBeVisible();
  await completePills();
  await icon.click();
  panel = await popupWithinViewport();
  await expect(panel).toContainText(longManufacturer.trim());
  await expect(panel).toContainText(longModel);
  await screenshot('long-values');
  if (info.project.name.startsWith('desktop')) {
    await page.keyboard.press('Escape');
    await resize(800, {
      notes: 'Full device notes remain independently readable. '.repeat(150),
    });
    await icon.click();
    panel = await popupWithinViewport();
    const beforeScroll = await read(page, id);
    const panelBounds = await panel.boundingBox();
    if (!panelBounds) throw new Error('Missing information popover');
    await page.mouse.move(
      panelBounds.x + panelBounds.width / 2,
      panelBounds.y + panelBounds.height / 2,
    );
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => panel.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    expect((await read(page, id)).document).toEqual(beforeScroll.document);
    await unchangedGeometry();
  }
  await page.keyboard.press('Escape');
  await select(page, device);
  fields = await visibleFields(page);
  await fields
    .getByRole('checkbox', { name: 'Show header Model', exact: true })
    .uncheck();
  await saved(page);
  await closeInspector(page);
  await icon.click();
  panel = await popupWithinViewport();
  await expect(panel).toContainText(longManufacturer.trim());
  await expect(panel).not.toContainText(longModel);
  await page.keyboard.press('Escape');
  const preferences = (await read(page, id)).document.elements[0]!.properties
    .headerFields;
  await page.reload();
  await saved(page);
  await collapseBrowser(page);
  expect(
    (await read(page, id)).document.elements[0]!.properties.headerFields,
  ).toEqual(preferences);
  await unchangedGeometry();
  for (const action of ['Zoom in', 'Zoom out']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await saved(page);
    await completePills();
    await unchangedGeometry();
  }
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
  await unchangedGeometry();
  expect(errors).toEqual([]);
});
