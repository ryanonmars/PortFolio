import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
const device = (page: Page, id = 'device') =>
  page.locator(`[data-board-element-id="${id}"]`);
const preview = (page: Page, existing = false) =>
  inspector(page).getByRole('group', {
    name: existing ? 'Existing port layout preview' : 'New port layout preview',
    exact: true,
  });
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
async function login(page: Page) {
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
}
async function create(page: Page, document: BoardDocument) {
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Port presets ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const board = (await response.json()).board as BoardRecord;
  await page.goto(`/boards/${board.id}`);
  await saved(page);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await device(page).locator('.board-element-header').click();
  await expect(
    inspector(page).getByLabel('Device type', { exact: true }),
  ).toBeVisible();
  return board.id;
}
function fixture(type = 'Switch', width = 1800, height = 600): BoardDocument {
  const document = emptyBoardDocument();
  document.elements = [
    {
      id: 'device',
      type: 'device',
      name: `${type} example`,
      x: 40,
      y: 100,
      width,
      height,
      z: 0,
      color: '#428deb',
      properties: { deviceType: type },
    },
  ];
  document.viewport = { x: 40, y: 40, zoom: 0.6 };
  return document;
}
async function details(page: Page, name: string) {
  const summary = inspector(page)
    .locator('summary')
    .filter({ hasText: new RegExp(`^${name}$`) });
  const parent = summary.locator('..');
  if ((await parent.getAttribute('open')) === null) await summary.click();
  return parent;
}
async function selectPreset(
  page: Page,
  preset: string,
  count: number,
  columns?: number,
) {
  await inspector(page)
    .getByLabel('Layout preset', { exact: true })
    .selectOption(preset);
  await inspector(page)
    .getByLabel('Port quantity', { exact: true })
    .fill(String(count));
  const rowWidth = inspector(page).getByLabel('Ports per row', { exact: true });
  if (await rowWidth.isVisible())
    await rowWidth.fill(columns === undefined ? '' : String(columns));
}
async function bank(
  page: Page,
  count: number,
  kind: string,
  start: number,
  column: number,
  row = 1,
) {
  await selectPreset(page, 'single-row', count);
  await inspector(page)
    .getByLabel('Connector type', { exact: true })
    .selectOption(kind);
  await details(page, 'Bank placement');
  await inspector(page)
    .getByLabel('Starting number', { exact: true })
    .fill(String(start));
  await inspector(page)
    .getByLabel('Start column', { exact: true })
    .fill(String(column));
  await inspector(page)
    .getByLabel('Start row', { exact: true })
    .fill(String(row));
  await expect(preview(page).locator('[data-preview-port-id]')).toHaveCount(
    count,
  );
  await inspector(page)
    .getByRole('button', { name: 'Add port bank', exact: true })
    .click();
  await saved(page);
}
function slots(count: number, preset: string, columns: number, start = 1) {
  return Array.from({ length: count }, (_, index) => {
    if (preset === 'single-row') return [0, index];
    if (preset === 'sequential')
      return [Math.floor(index / columns), index % columns];
    const pair = Math.floor(index / 2),
      parity = (start + index) % 2;
    return [
      Math.floor(pair / columns) * 2 +
        (preset === 'odd-top' ? 1 - parity : parity),
      pair % columns,
    ];
  });
}
function noOverlap(document: BoardDocument) {
  const keys = document.ports.map(
    ({ deviceId, face, row, column }) => `${deviceId}:${face}:${row}:${column}`,
  );
  expect(new Set(keys).size).toBe(keys.length);
}
async function screenshot(page: Page, path: string) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page.screenshot({ path });
}

test('universal presets preview and create numbered 8, 24, 48 and odd-port layouts without resizing', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await login(page);
  const cases = [
    {
      type: 'Switch',
      preset: 'single-row',
      count: 8,
      columns: 8,
      label: 'eight-single-row',
    },
    {
      type: 'Switch',
      preset: 'odd-top',
      count: 24,
      columns: 12,
      label: 'twenty-four-odd-top',
    },
    {
      type: 'Switch',
      preset: 'odd-bottom',
      count: 24,
      columns: 12,
      label: 'twenty-four-odd-bottom',
    },
    {
      type: 'Server',
      preset: 'sequential',
      count: 48,
      columns: 24,
      label: 'forty-eight-sequential',
    },
    {
      type: 'Access Point',
      preset: 'odd-bottom',
      count: 9,
      columns: 5,
      label: 'nine-odd-bottom',
    },
    {
      type: 'Custom',
      preset: 'odd-top',
      count: 7,
      columns: 2,
      label: 'seven-custom-blocks',
    },
    {
      type: 'Router',
      preset: 'single-row',
      count: 5,
      columns: 5,
      label: 'router-five-single',
    },
    {
      type: 'Firewall',
      preset: 'odd-top',
      count: 3,
      columns: 2,
      label: 'firewall-three-odd-top',
    },
  ];
  for (const item of cases) {
    const id = await create(page, fixture(item.type)),
      before = (await read(page, id)).document;
    await selectPreset(
      page,
      item.preset,
      item.count,
      item.preset === 'single-row' ? undefined : item.columns,
    );
    await expect(preview(page).locator('[data-preview-port-id]')).toHaveCount(
      item.count,
    );
    expect((await read(page, id)).document).toEqual(before);
    const coordinates = await preview(page)
      .locator('[data-preview-port-id]')
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          Number(node.getAttribute('data-row')),
          Number(node.getAttribute('data-column')),
        ]),
      );
    expect(coordinates).toEqual(slots(item.count, item.preset, item.columns));
    if (item.count === 24 || item.count === 48) {
      await preview(page).screenshot({
        path: info.outputPath(item.label + '-preview.png'),
      });
      const comparison = await details(page, 'Compare layouts');
      await expect(comparison.locator('button')).toHaveCount(4);
      await expect(
        comparison.locator('svg[data-connector="rj45"]'),
      ).toHaveCount(32);
      const contained = await comparison
        .locator('.port-layout-miniature')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const bounds = node.getBoundingClientRect();
            return [
              ...node.querySelectorAll('.port-layout-preview-port'),
            ].every((port) => {
              const box = port.getBoundingClientRect();
              return (
                box.left >= bounds.left &&
                box.top >= bounds.top &&
                box.right <= bounds.right + 1 &&
                box.bottom <= bounds.bottom + 1
              );
            });
          }),
        );
      expect(contained).toEqual([true, true, true, true]);

      await comparison.screenshot({
        path: info.outputPath(item.label + '-comparison.png'),
      });
      await comparison.locator('summary').click();
    }
    await inspector(page)
      .getByRole('button', { name: 'Add port bank', exact: true })
      .click();
    await saved(page);
    const after = (await read(page, id)).document;
    expect(after.elements).toEqual(before.elements);
    expect(after.ports.map(({ row, column }) => [row, column])).toEqual(
      slots(item.count, item.preset, item.columns),
    );
    expect(after.ports.map(({ name }) => name)).toEqual(
      Array.from({ length: item.count }, (_, index) => `Port ${index + 1}`),
    );
    noOverlap(after);
    await screenshot(page, info.outputPath(`${item.label}.png`));
    const withCamera = (await read(page, id)).document;
    await page.reload();
    await saved(page);
    expect((await read(page, id)).document).toEqual(withCamera);
    await expect(
      device(page).locator('svg[data-connector="rj45"]'),
    ).toHaveCount(item.count);
    if (!info.project.name.startsWith('mobile')) {
      await page.setViewportSize({ width: 430, height: 850 });
      expect((await read(page, id)).document.ports).toEqual(after.ports);
      const actual = await device(page)
        .locator('.board-port')
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            Number.parseFloat((node as HTMLElement).style.left),
            Number.parseFloat((node as HTMLElement).style.top),
          ]),
        );
      expect(actual).toEqual(
        after.ports.map(({ row, column }) => [
          16 + column * 72,
          96 + row * 100,
        ]),
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
});

test('mixed connector banks retain intentional gaps, front/rear slots and even-start numbering', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await login(page);
  const id = await create(page, fixture('Router', 1200));
  await bank(page, 2, 'sfp_plus', 1, 1);
  await bank(page, 1, 'sfp', 3, 3);
  await bank(page, 8, 'rj45', 4, 5);
  let document = (await read(page, id)).document;
  expect(
    document.ports.map(({ name, kind, row, column }) => [
      name,
      kind,
      row,
      column,
    ]),
  ).toEqual([
    ['Port 1', 'sfp_plus', 0, 0],
    ['Port 2', 'sfp_plus', 0, 1],
    ['Port 3', 'sfp', 0, 2],
    ...Array.from({ length: 8 }, (_, index) => [
      `Port ${index + 4}`,
      'rj45',
      0,
      index + 4,
    ]),
  ]);
  noOverlap(document);
  await screenshot(page, info.outputPath('er8411-mixed-banks.png'));
  await device(page).locator('.board-element-header').click();
  await selectPreset(page, 'single-row', 1);
  await details(page, 'Bank placement');
  await inspector(page).getByLabel('Start column', { exact: true }).fill('1');
  const beforeCollision = (await read(page, id)).document;
  await expect(
    inspector(page).getByRole('button', { name: 'Add port bank', exact: true }),
  ).toBeDisabled();
  expect((await read(page, id)).document).toEqual(beforeCollision);
  await device(page)
    .getByRole('button', { name: 'Rear', exact: true })
    .press('Enter');
  await saved(page);
  await selectPreset(page, 'odd-top', 3, 2);
  await details(page, 'Bank placement');
  await inspector(page)
    .getByLabel('Starting number', { exact: true })
    .fill('4');
  await inspector(page)
    .getByLabel('Label prefix', { exact: true })
    .fill('Rear ');
  await inspector(page).getByLabel('Start row', { exact: true }).fill('1');
  await inspector(page).getByLabel('Start column', { exact: true }).fill('1');
  await inspector(page)
    .getByRole('button', { name: 'Add port bank', exact: true })
    .click();
  await saved(page);
  document = (await read(page, id)).document;
  expect(document.ports.filter(({ face }) => face === 'front')).toEqual(
    beforeCollision.ports,
  );
  expect(
    document.ports
      .filter(({ face }) => face === 'rear')
      .map(({ name, row, column }) => [name, row, column]),
  ).toEqual([
    ['Rear 4', 1, 0],
    ['Rear 5', 0, 0],
    ['Rear 6', 1, 1],
  ]);
  noOverlap(document);
});

function configured(): BoardDocument {
  const document = fixture('Switch', 1200);
  document.elements.push({
    ...document.elements[0]!,
    id: 'peer',
    name: 'Peer',
    x: 1400,
    width: 300,
    z: 1,
  });
  document.ports = Array.from({ length: 8 }, (_, index) => ({
    ...makeBoardPort(
      'device',
      index % 2 ? 'sfp_plus' : 'rj45',
      0,
      index,
      `Custom ${index}`,
    ),
    color: index % 2 ? '#37ef29' : '#428deb',
    role: `Unconventional purpose ${index}`,
    speed: 'anything',
    linkState: 'authored state',
    nativeVlan: 'Freeform VLAN',
    taggedVlans: ['voice', '0'],
    pvid: '0',
    address: 'arbitrary network annotation',
    externalDestination: 'remote place',
    notes: 'Preserve these notes',
    customFields: { Enabled: false, Count: 0 },
  }));
  document.ports.push(
    makeBoardPort('device', 'sfp', 0, 0, 'Rear custom', 'rear'),
  );
  const peer = makeBoardPort('peer', 'rj45', 0, 0, 'Peer port');
  document.ports.push(peer);
  document.cables = [
    {
      id: 'cable',
      sourcePortId: document.ports[0]!.id,
      targetPortId: peer.id,
      name: 'Keep cable',
      cableType: 'Authored',
      sourceConnector: '',
      targetConnector: '',
      color: '#eeeeee',
      length: 'freeform',
      notes: 'Keep all cable data',
    },
  ];
  return document;
}

test('applying existing layouts preserves all configuration and cable identities with undo and refresh', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await login(page);
  const id = await create(page, configured()),
    before = (await read(page, id)).document;
  const cable = page.locator('[data-board-cable-id="cable"] .board-cable-line'),
    oldPath = await cable.getAttribute('d');
  await selectPreset(page, 'odd-bottom', 1, 4);
  await details(page, 'Arrange existing ports');
  await expect(
    preview(page, true).locator('[data-preview-port-id]'),
  ).toHaveCount(8);
  await expect(preview(page, true)).toContainText('Custom 0');
  expect((await read(page, id)).document).toEqual(before);
  await inspector(page)
    .getByRole('button', { name: 'Apply layout', exact: true })
    .click();
  await saved(page);
  const moved = (await read(page, id)).document;
  expect(moved.elements).toEqual(before.elements);
  expect(moved.cables).toEqual(before.cables);
  expect(
    moved.ports
      .filter(({ deviceId, face }) => deviceId === 'device' && face === 'front')
      .map(({ row, column }) => [row, column]),
  ).toEqual(slots(8, 'odd-bottom', 4));
  expect(
    moved.ports.map((port, index) => ({
      ...port,
      row: before.ports[index]!.row,
      column: before.ports[index]!.column,
    })),
  ).toEqual(before.ports);
  await expect(cable).not.toHaveAttribute('d', oldPath!);
  noOverlap(moved);
  await screenshot(page, info.outputPath('configured-device-with-cable.png'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document.ports).toEqual(before.ports);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document.ports).toEqual(moved.ports);
  const afterCamera = (await read(page, id)).document;
  await page.reload();
  await saved(page);
  expect((await read(page, id)).document).toEqual(afterCamera);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await device(page).locator('.board-element-header').click();
  const beforeResize = (await read(page, id)).document;
  await device(page)
    .getByRole('button', { name: 'Resize Switch example se', exact: true })
    .press('Shift+ArrowRight');
  await saved(page);
  const resized = (await read(page, id)).document;
  expect(resized.elements[0]!.width).toBeGreaterThan(
    beforeResize.elements[0]!.width,
  );
  expect(resized.ports).toEqual(beforeResize.ports);
  expect(resized.cables).toEqual(beforeResize.cables);
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Move Custom 0', exact: true })
    .press('ArrowDown');
  await saved(page);
  const freeform = (await read(page, id)).document;
  expect(freeform.ports[0]!.column).toBe(0);
  expect(freeform.ports[0]!.row).toBe(2);
  expect(freeform.cables).toEqual(before.cables);
});

test('new preset banks grow small devices atomically and retain dimensions through undo and reload', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await login(page);
  for (const layout of [
    { preset: 'single-row', count: 24, columns: 24 },
    { preset: 'odd-bottom', count: 24, columns: 12 },
    { preset: 'sequential', count: 48, columns: 24 },
  ]) {
    const id = await create(page, fixture('Custom', 320, 200));
    const before = (await read(page, id)).document;
    await selectPreset(page, layout.preset, layout.count, layout.columns);
    await expect(preview(page).locator('[data-preview-port-id]')).toHaveCount(
      layout.count,
    );
    await expect(
      inspector(page).getByRole('button', {
        name: 'Add port bank',
        exact: true,
      }),
    ).toBeEnabled();
    expect((await read(page, id)).document).toEqual(before);
    await inspector(page)
      .getByRole('button', { name: 'Add port bank', exact: true })
      .click();
    await saved(page);
    const after = (await read(page, id)).document;
    const expected = slots(layout.count, layout.preset, layout.columns);
    const maxRow = Math.max(...expected.map(([row]) => row!));
    const maxColumn = Math.max(...expected.map(([, column]) => column!));
    expect(after.ports.map(({ row, column }) => [row, column])).toEqual(
      expected,
    );
    expect(after.elements[0]).toEqual({
      ...before.elements[0]!,
      width: Math.max(320, 32 + (maxColumn + 1) * 64 + maxColumn * 8),
      height: Math.max(200, 112 + (maxRow + 1) * 92 + maxRow * 8),
    });
    expect(after.viewport).toEqual(before.viewport);
    noOverlap(after);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await saved(page);
    expect((await read(page, id)).document).toEqual(before);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await saved(page);
    expect((await read(page, id)).document).toEqual(after);
    await page.reload();
    await saved(page);
    expect((await read(page, id)).document).toEqual(after);
    const collapse = page.getByRole('button', {
      name: 'Collapse board browser',
      exact: true,
    });
    if (await collapse.isVisible()) await collapse.click();
    await screenshot(
      page,
      info.outputPath('auto-grown-' + layout.preset + '.png'),
    );
  }
});

test('adding an offset bank grows around existing front and rear ports without changing cables or authored data', async ({
  page,
}, info) => {
  await login(page);
  const document = configured();
  document.elements[0] = { ...document.elements[0]!, width: 600, height: 220 };
  const id = await create(page, document),
    before = (await read(page, id)).document;
  const cable = page.locator('[data-board-cable-id="cable"] .board-cable-line');
  const oldPath = await cable.getAttribute('d');
  await bank(page, 3, 'qsfp', 10, 10, 3);
  const after = (await read(page, id)).document;
  expect(after.ports.slice(0, before.ports.length)).toEqual(before.ports);
  expect(
    after.ports
      .slice(before.ports.length)
      .map(({ name, kind, face, row, column }) => [
        name,
        kind,
        face,
        row,
        column,
      ]),
  ).toEqual([
    ['Port 10', 'qsfp', 'front', 2, 9],
    ['Port 11', 'qsfp', 'front', 2, 10],
    ['Port 12', 'qsfp', 'front', 2, 11],
  ]);
  expect(after.elements[0]).toEqual({
    ...before.elements[0]!,
    width: 888,
    height: 404,
  });
  expect(after.elements[1]).toEqual(before.elements[1]);
  expect(after.cables).toEqual(before.cables);
  await expect(cable).toHaveAttribute('d', oldPath!);
  noOverlap(after);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document).toEqual(after);
  await screenshot(
    page,
    info.outputPath('auto-grown-mixed-bank-with-cable.png'),
  );
});

test('rearranging existing ports still requires sufficient space and cannot resize or alter configuration implicitly', async ({
  page,
}) => {
  await login(page);
  const document = configured();
  document.elements[0] = { ...document.elements[0]!, width: 600, height: 220 };
  const id = await create(page, document),
    before = (await read(page, id)).document;
  await selectPreset(page, 'odd-bottom', 1, 4);
  await details(page, 'Arrange existing ports');
  await expect(
    preview(page, true).locator('[data-preview-port-id]'),
  ).toHaveCount(8);
  await expect(
    inspector(page).getByRole('button', { name: 'Apply layout', exact: true }),
  ).toBeDisabled();
  await expect(inspector(page)).toContainText(/resize|space|fit/i);
  expect((await read(page, id)).document).toEqual(before);
});
