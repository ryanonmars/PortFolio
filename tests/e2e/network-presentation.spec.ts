import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
async function select(page: Page, element: Locator) {
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await element.locator('.board-network-entry-heading').first().click();
  await expect(inspector(page)).toBeVisible();
}
async function fields(page: Page) {
  const summary = inspector(page)
    .locator('summary')
    .filter({ hasText: /^Visible fields$/ });
  const owner = summary.locator('..');
  if (!(await owner.evaluate((node) => node.hasAttribute('open'))))
    await summary.click();
  return owner;
}
async function noHorizontalOverflow(element: Locator) {
  const result = await element
    .locator('.board-network-summary')
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        client: node.clientWidth,
        scroll: node.scrollWidth,
        escaped: [...node.querySelectorAll('.board-network-chip')].filter(
          (chip) => {
            const bounds = chip.getBoundingClientRect();
            return bounds.left < rect.left - 1 || bounds.right > rect.right + 1;
          },
        ).length,
      };
    });
  expect(result.scroll).toBeLessThanOrEqual(result.client + 1);
  expect(result.escaped).toBe(0);
}

test('Network information chips respect independent visible fields and wrap within saved dimensions', async ({
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
  const networkId = randomUUID();
  const longAddress = '2001:db8:' + 'abcd'.repeat(50) + '::64';
  document.elements.push({
    id: networkId,
    type: 'network',
    name: 'Home Network',
    x: 20,
    y: 80,
    width: 640,
    height: 500,
    z: 0,
    color: '#192b2b',
    properties: {
      displayFields: [
        'vlanId',
        'vlanName',
        'subnet',
        'gateway',
        'dhcpServer',
        'dhcpStart',
        'dhcpEnd',
        'dns',
        'notes',
        'customFields',
      ],
      entries: [
        {
          vlanId: '1',
          vlanName: 'Management',
          color: '#488ded',
          subnet: '192.0.2.0/24',
          gateway: '192.0.2.1',
          dhcpServer: true,
          dhcpStart: '192.0.2.100',
          dhcpEnd: '192.0.2.200',
          dns: longAddress,
          notes:
            'Primary network notes stay readable.\nSecond line of authored context.',
          customFields: {
            Capacity: 0,
            Monitored: false,
            Owner: 'Network operations',
            Empty: '',
          },
        },
        {
          vlanId: '20',
          vlanName: 'Users',
          color: '#56a77c',
          subnet: '198.51.100.0/24',
          gateway: '',
          dhcpServer: false,
          dhcpStart: '198.51.100.100',
          dhcpEnd: '198.51.100.200',
          dns: '203.0.113.53',
          notes: '',
          customFields: {},
        },
        {
          vlanId: '',
          vlanName: '',
          subnet: '',
          gateway: '',
          notes: '',
          customFields: { Empty: '' },
        },
      ],
    },
  });
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: {
      name: `Network presentation ${randomUUID().slice(0, 8)}`,
      document,
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
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const element = page.locator(`[data-board-element-id="${networkId}"]`);
  const entries = element.locator('.board-network-entry');
  await expect(entries).toHaveCount(2);
  const first = entries.first();
  const chips = first.locator('.board-network-chip');
  const chip = (field: string) =>
    first.locator(`.board-network-chip[data-field="${field}"]`);
  await expect(first.locator('.board-network-entry-heading')).toContainText(
    'VLAN 1',
  );
  await expect(first.locator('.board-network-entry-heading')).toContainText(
    'Management',
  );
  await expect(chip('subnet')).toContainText('Subnet');
  await expect(chip('subnet')).toContainText('192.0.2.0/24');
  await expect(chip('gateway')).toContainText('Gateway');
  await expect(chip('dhcpServer')).toContainText('Enabled');
  await expect(
    entries.nth(1).locator('.board-network-chip[data-field="dhcpServer"]'),
  ).toContainText('Disabled');
  await expect(
    entries.nth(1).locator('.board-network-chip[data-field="gateway"]'),
  ).toHaveCount(0);
  await expect(
    entries.nth(1).locator('.board-network-chip[data-field="dhcpPool"]'),
  ).toContainText('198.51.100.100 → 198.51.100.200');
  await expect(chip('dhcpPool')).toContainText('DHCP Pool');
  await expect(chip('dhcpPool')).toContainText('192.0.2.100 → 192.0.2.200');
  await expect(chip('dhcpStart')).toHaveCount(0);
  await expect(chip('dhcpEnd')).toHaveCount(0);
  await expect(chip('dns')).toContainText(longAddress);
  await expect(chips.filter({ hasText: 'Capacity' })).toContainText('0');
  await expect(chips.filter({ hasText: 'Monitored' })).toContainText('false');
  await expect(chips.filter({ hasText: 'Empty' })).toHaveCount(0);
  await expect(first.locator('.board-network-entry-notes')).toContainText(
    'Primary network notes stay readable.',
  );
  await expect(
    first.locator('.board-network-entry-notes .board-network-chip'),
  ).toHaveCount(0);
  await noHorizontalOverflow(element);
  const original = (await read(page, id)).document;
  await page.screenshot({ path: info.outputPath('network-pills-wide.png') });

  await select(page, element);
  const visible = await fields(page);
  await visible
    .getByRole('checkbox', { name: 'Show gateway', exact: true })
    .uncheck();
  await visible
    .getByRole('checkbox', { name: 'Show dhcpEnd', exact: true })
    .uncheck();
  await visible
    .getByRole('checkbox', { name: 'Show vlanId', exact: true })
    .uncheck();
  await saved(page);
  await closeInspector(page);
  await expect(chip('gateway')).toHaveCount(0);
  await expect(chip('dhcpPool')).toHaveCount(0);
  await expect(chip('dhcpStart')).toContainText('192.0.2.100');
  await expect(chip('dhcpStart')).toContainText('DHCP');
  await expect(chip('dhcpEnd')).toHaveCount(0);
  await expect(first.locator('.board-network-entry-heading')).not.toContainText(
    'VLAN 1',
  );
  await expect(first.locator('.board-network-entry-heading')).toContainText(
    'Management',
  );
  expect(
    (await read(page, id)).document.elements[0]!.properties.entries,
  ).toEqual(original.elements[0]!.properties.entries);

  await select(page, element);
  const endpoints = await fields(page);
  await endpoints
    .getByRole('checkbox', { name: 'Show dhcpStart', exact: true })
    .uncheck();
  await endpoints
    .getByRole('checkbox', { name: 'Show dhcpEnd', exact: true })
    .check();
  await saved(page);
  await closeInspector(page);
  await expect(chip('dhcpPool')).toHaveCount(0);
  await expect(chip('dhcpStart')).toHaveCount(0);
  await expect(chip('dhcpEnd')).toContainText('192.0.2.200');

  await select(page, element);
  await (
    await fields(page)
  )
    .getByRole('checkbox', { name: 'Show customFields', exact: true })
    .uncheck();
  await saved(page);
  await closeInspector(page);
  await expect(chips.filter({ hasText: 'Capacity' })).toHaveCount(0);
  await select(page, element);
  const restored = await fields(page);
  for (const field of [
    'gateway',
    'dhcpStart',
    'dhcpEnd',
    'vlanId',
    'customFields',
  ])
    await restored
      .getByRole('checkbox', { name: `Show ${field}`, exact: true })
      .check();
  await saved(page);
  await closeInspector(page);

  await select(page, element);
  const handle = page.getByRole('button', {
    name: 'Resize Home Network e',
    exact: true,
  });
  for (let count = 0; count < 12; count++)
    await handle.press('Alt+Shift+ArrowLeft');
  await saved(page);
  expect((await read(page, id)).document.elements[0]!.width).toBe(160);
  await closeInspector(page);
  await noHorizontalOverflow(element);
  const heights = await chips.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height),
  );
  expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page.screenshot({ path: info.outputPath('network-pills-narrow.png') });
  const narrow = (await read(page, id)).document;
  for (const action of ['Zoom in', 'Zoom out']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await saved(page);
    await noHorizontalOverflow(element);
    const zoomed = (await read(page, id)).document;
    expect(zoomed.elements).toEqual(narrow.elements);
    expect(zoomed.ports).toEqual(narrow.ports);
    expect(zoomed.cables).toEqual(narrow.cables);
  }
  await page.reload();
  await saved(page);
  expect((await read(page, id)).document.elements).toEqual(narrow.elements);
  await expect(chip('dhcpPool')).toContainText('192.0.2.100 → 192.0.2.200');
  await noHorizontalOverflow(element);
  await select(page, element);
  const bottom = page.getByRole('button', {
    name: 'Resize Home Network s',
    exact: true,
  });
  for (let count = 0; count < 10; count++)
    await bottom.press('Alt+Shift+ArrowUp');
  await saved(page);
  const short = (await read(page, id)).document;
  await closeInspector(page);
  expect(short.elements[0]!.height).toBe(120);
  await noHorizontalOverflow(element);
  const summary = element.locator('.board-network-summary');
  expect(
    await summary.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  expect(short.elements[0]!.properties).toEqual({
    ...original.elements[0]!.properties,
    displayFields: short.elements[0]!.properties.displayFields,
  });
  expect(short.ports).toEqual(original.ports);
  expect(short.cables).toEqual(original.cables);
  await page.screenshot({ path: info.outputPath('network-pills-short.png') });
  expect(errors).toEqual([]);
});

test('Detailed canvas layout preserves Compact presentation, authored data and saved geometry', async ({
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
  const networkId = randomUUID();
  const networkName = 'Network visual layout';
  const longName = 'Management with a deliberately long documentation name';
  const configuredEntries = Array.from({ length: 12 }, (_, index) => ({
    networkEntryId: randomUUID(),
    networkEntryVersion: 2,
    vlanId: String(index + 1),
    vlanName: index === 0 ? longName : `Network ${index + 1}`,
    color: ['#488ded', '#56a77c', '#ce5663'][index % 3]!,
    subnet:
      index === 0
        ? '192.0.2.0/25'
        : index === 1
          ? '198.51.100.0/31'
          : index === 2
            ? '203.0.113.9/32'
            : index === 3
              ? 'authored subnet'
              : index === 5
                ? '2001:db8::/64'
                : '192.0.2.0/24',
    gateway: index === 3 ? '' : '192.0.2.1',
    dhcpServer: index !== 1,
    dhcpStart:
      index === 1 ? '198.51.100.0' : index === 2 ? '203.0.113.9' : '192.0.2.32',
    dhcpEnd:
      index === 1 ? '198.51.100.1' : index === 2 ? '203.0.113.9' : '192.0.2.95',
    dns: '203.0.113.53, 198.51.100.53, 2001:db8::53',
    notes: index === 0 ? 'Documented configuration only.' : '',
    customFields: { Capacity: 0, Monitored: false },
  }));
  document.elements.push({
    id: networkId,
    type: 'network',
    name: networkName,
    x: 20,
    y: 40,
    width: 1120,
    height: 540,
    z: 0,
    color: '#192b2b',
    properties: {
      displayFields: [
        'vlanId',
        'vlanName',
        'subnet',
        'gateway',
        'dhcpServer',
        'dhcpStart',
        'dhcpEnd',
        'dns',
        'notes',
        'customFields',
      ],
      entries: configuredEntries,
    },
  });
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Visual layout ${randomUUID().slice(0, 8)}`, document },
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
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const element = page.locator(`[data-board-element-id="${networkId}"]`);
  const summary = element.locator('.board-network-summary');
  const detail = element.locator('.board-network-detailed');
  const rows = element.locator('.board-network-visual-row');
  const original = (await read(page, id)).document;
  const screenshot = async (name: string) => {
    const path = info.outputPath(name);
    await page.screenshot({ path });
    const directory = '.tmp/qa-media/visual-layout';
    await mkdir(directory, { recursive: true });
    await copyFile(path, join(directory, `${info.project.name}-${name}`));
  };
  const unchanged = async () => {
    const current = (await read(page, id)).document;
    const { properties, ...geometry } = current.elements[0]!;
    const { properties: originalProperties, ...originalGeometry } =
      original.elements[0]!;
    expect(geometry).toEqual(originalGeometry);
    expect(properties.entries).toEqual(originalProperties.entries);
    expect(current.ports).toEqual(original.ports);
    expect(current.cables).toEqual(original.cables);
  };
  const compactMarkup = await summary.innerHTML();
  const compactStyle = await summary.evaluate((node) => {
    const style = getComputedStyle(node);
    const chip = getComputedStyle(node.querySelector('.board-network-chip')!);
    return {
      padding: style.padding,
      font: chip.font,
      background: chip.backgroundColor,
      radius: chip.borderRadius,
    };
  });
  await expect(detail).toHaveCount(0);
  await screenshot('network-compact-original.png');
  await select(page, element);
  const mode = inspector(page).getByLabel('Network display mode', {
    exact: true,
  });
  await expect(mode).toHaveValue('compact');
  await mode.selectOption('detailed');
  await saved(page);
  await closeInspector(page);
  await expect(detail).toBeVisible();
  await expect(rows).toHaveCount(12);
  await expect(rows.first()).toContainText(longName);
  await expect(rows.first()).toContainText('192.0.2.0/25');
  await expect(rows.first()).toContainText('126');
  await expect(rows.first()).toContainText('203.0.113.53');
  await expect(rows.first()).toContainText('2001:db8::53');
  await expect(rows.nth(1)).toContainText(/disabled/i);
  await expect(rows.nth(2)).toContainText('203.0.113.9');
  await expect(rows.nth(3)).toContainText('authored subnet');
  await expect(detail.locator('.board-network-visual-totals')).toContainText(
    '257',
  );
  await expect(detail.locator('.board-network-chip')).toHaveCount(0);
  await expect(rows.getByRole('button')).toHaveCount(0);
  await expect(detail.locator('details')).toHaveCount(0);
  await unchanged();
  await noHorizontalOverflow(element);
  await screenshot('network-detailed-wide.png');

  // The bar describes the configured pool within usable /25 bounds, not utilization.
  const pool = rows.first().locator('.board-network-pool');
  const percentages = await pool.evaluate((node) => ({
    left: parseFloat((node as HTMLElement).style.left),
    width: parseFloat((node as HTMLElement).style.width),
  }));
  expect(percentages.left).toBeCloseTo((31 / 126) * 100, 3);
  expect(percentages.width).toBeCloseTo((64 / 126) * 100, 3);
  await expect(rows.nth(1).locator('.board-network-pool')).toHaveCount(0);

  // Row clicks keep the normal container inspector; no per-VLAN navigation exists.
  await rows.first().click({ position: { x: 8, y: 8 } });
  await expect(
    inspector(page).getByLabel('Network container name', { exact: true }),
  ).toHaveValue(networkName);
  await expect(
    inspector(page).getByRole('button', {
      name: 'Back to container',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(mode).toHaveValue('detailed');
  await unchanged();
  await inspector(page)
    .getByRole('checkbox', { name: 'Show network summary', exact: true })
    .uncheck();
  await saved(page);
  await closeInspector(page);
  await page.reload();
  await saved(page);
  expect((await read(page, id)).document.elements[0]!.properties).toMatchObject(
    { displayMode: 'detailed', showNetworkSummary: false },
  );
  await expect(detail).toBeVisible();
  await expect(detail.locator('.board-network-visual-totals')).toHaveCount(0);
  await unchanged();

  // Switching back reproduces the original Compact DOM and computed style exactly.
  await rows.first().click({ position: { x: 8, y: 8 } });
  await mode.selectOption('compact');
  await saved(page);
  await closeInspector(page);
  expect(await summary.innerHTML()).toBe(compactMarkup);
  expect(
    await summary.evaluate((node) => {
      const style = getComputedStyle(node);
      const chip = getComputedStyle(node.querySelector('.board-network-chip')!);
      return {
        padding: style.padding,
        font: chip.font,
        background: chip.backgroundColor,
        radius: chip.borderRadius,
      };
    }),
  ).toEqual(compactStyle);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  await expect(detail).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  await expect(detail).toHaveCount(0);
  await select(page, element);
  await mode.selectOption('detailed');
  await inspector(page)
    .getByRole('checkbox', { name: 'Show network summary', exact: true })
    .check();
  await saved(page);
  const shown = await fields(page);
  await shown
    .getByRole('checkbox', { name: 'Show gateway', exact: true })
    .uncheck();
  await shown
    .getByRole('checkbox', { name: 'Show dhcpEnd', exact: true })
    .uncheck();
  await saved(page);
  await closeInspector(page);
  await expect(rows.first().getByText('Gateway', { exact: true })).toHaveCount(
    0,
  );
  await expect(rows.first().locator('.board-network-pool')).toHaveCount(0);
  await rows.first().click({ position: { x: 8, y: 8 } });
  const restore = await fields(page);
  await restore
    .getByRole('checkbox', { name: 'Show gateway', exact: true })
    .check();
  await restore
    .getByRole('checkbox', { name: 'Show dhcpEnd', exact: true })
    .check();
  await saved(page);
  await closeInspector(page);
  await unchanged();

  // Detail content owns ordinary scrolling without moving authored canvas objects.
  expect(
    await summary.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  const viewportBeforeScroll = (await read(page, id)).document.viewport;
  await summary.hover();
  await page.mouse.wheel(0, 350);
  await expect
    .poll(() => summary.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  expect((await read(page, id)).document.viewport).toEqual(
    viewportBeforeScroll,
  );
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => summary.evaluate((node) => node.scrollTop)).toBe(0);
  if (info.project.name.startsWith('mobile')) {
    const box = (await summary.boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const point = {
      x: box.x + box.width / 2,
      y: box.y + Math.min(90, box.height - 10),
    };
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...point, y: point.y - 55 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await client.detach();
    await expect
      .poll(() => summary.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    expect((await read(page, id)).document.viewport).toEqual(
      viewportBeforeScroll,
    );
    await summary.evaluate((node) => {
      node.scrollTop = 0;
    });
  }
  const panBox = (await summary.boundingBox())!;
  await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + 40);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(panBox.x + panBox.width / 2 + 35, panBox.y + 75, {
    steps: 5,
  });
  await page.mouse.up({ button: 'middle' });
  await saved(page);
  expect((await read(page, id)).document.viewport).not.toEqual(
    viewportBeforeScroll,
  );
  await unchanged();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);

  // Existing inspector editing still changes one canonical network entry.
  await rows.first().click({ position: { x: 8, y: 8 } });
  const entryForm = inspector(page)
    .locator('details')
    .filter({ has: page.getByLabel('VLAN ID', { exact: true }) })
    .first();
  const heading = entryForm.locator('summary').first();
  if (!(await entryForm.evaluate((node) => node.hasAttribute('open'))))
    await heading.click();
  await entryForm.getByLabel('Gateway', { exact: true }).fill('192.0.2.2');
  await saved(page);
  await closeInspector(page);
  await expect(rows.first()).toContainText('192.0.2.2');
  const edited = (await read(page, id)).document;
  const editedEntries = edited.elements[0]!.properties.entries as Record<
    string,
    unknown
  >[];
  expect(editedEntries[0]!.gateway).toBe('192.0.2.2');
  expect(editedEntries.slice(1)).toEqual(configuredEntries.slice(1));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  await expect(rows.first()).toContainText('192.0.2.1');
  await unchanged();

  await rows.first().click({ position: { x: 8, y: 8 } });
  const handle = page.getByRole('button', {
    name: `Resize ${networkName} e`,
    exact: true,
  });
  for (let count = 0; count < 18; count++)
    await handle.press('Alt+Shift+ArrowLeft');
  await saved(page);
  await closeInspector(page);
  expect((await read(page, id)).document.elements[0]!.width).toBe(400);
  await noHorizontalOverflow(element);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await screenshot('network-detailed-narrow.png');
  const narrow = (await read(page, id)).document;
  for (const action of ['Zoom in', 'Zoom out']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await saved(page);
    await noHorizontalOverflow(element);
    expect((await read(page, id)).document.elements).toEqual(narrow.elements);
  }
  await page.reload();
  await saved(page);
  expect((await read(page, id)).document.elements).toEqual(narrow.elements);
  await expect(detail).toBeVisible();
  const downloadText = async (name: string) => {
    const menu = page.getByLabel('Board menu', { exact: true });
    if (
      !(await menu.locator('..').evaluate((node) => node.hasAttribute('open')))
    )
      await menu.click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    return readFile((await (await pending).path())!, 'utf8');
  };
  const exported = JSON.parse(await downloadText('Export JSON'));
  expect(exported.document.elements).toEqual(narrow.elements);
  const svg = await downloadText('Export image');
  expect(svg).toContain('<svg');
  expect(svg).not.toContain('foreignObject');
  expect(svg).toContain('192.0.2.0/25');
  expect(svg).toMatch(/fill="rgb\(52, 218, 101\)"/);
  expect(svg).not.toContain('Back to container');
  expect(errors).toEqual([]);
});

test('Detailed layout gives one and three VLANs the reference hierarchy without resizing', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
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
  for (const count of [1, 3]) {
    const document = emptyBoardDocument();
    const networkId = randomUUID();
    document.elements.push({
      id: networkId,
      type: 'network',
      name: 'Network Details',
      x: 20,
      y: 40,
      width: 1260,
      height: 480,
      z: 0,
      color: '#192b2b',
      properties: {
        displayMode: 'detailed',
        displayFields: [
          'vlanId',
          'vlanName',
          'subnet',
          'gateway',
          'dns',
          'dhcpServer',
          'dhcpStart',
          'dhcpEnd',
        ],
        entries: Array.from({ length: count }, (_, index) => ({
          networkEntryId: randomUUID(),
          networkEntryVersion: 2,
          vlanId: String([1, 20, 30][index]),
          vlanName: ['Management', 'Server', 'User Devices'][index]!,
          color: ['#488ded', '#56d373', '#ce5663'][index]!,
          subnet: `${['192.0.2', '198.51.100', '203.0.113'][index]}.0/24`,
          gateway: `${['192.0.2', '198.51.100', '203.0.113'][index]}.1`,
          dns: '203.0.113.53',
          dhcpServer: true,
          dhcpStart: `${['192.0.2', '198.51.100', '203.0.113'][index]}.100`,
          dhcpEnd: `${['192.0.2', '198.51.100', '203.0.113'][index]}.${[199, 150, 254][index]}`,
        })),
      },
    });
    const response = await page.request.post('/api/v1/boards', {
      headers: {
        Origin: new URL(page.url()).origin,
        'x-csrf-token': auth.csrfToken,
      },
      data: {
        name: `Detailed ${count} VLAN ${randomUUID().slice(0, 8)}`,
        document,
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
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await saved(page);
    const element = page.locator(`[data-board-element-id="${networkId}"]`);
    await expect(element.locator('.board-network-visual-row')).toHaveCount(
      count,
    );
    await expect(element.locator('.board-network-detailed')).toContainText(
      '254',
    );
    await noHorizontalOverflow(element);
    expect((await read(page, id)).document.elements).toEqual(document.elements);
    const name = `network-detailed-${count === 1 ? 'single' : 'three'}.png`;
    const path = info.outputPath(name);
    await page.screenshot({ path });
    const directory = '.tmp/qa-media/visual-layout';
    await mkdir(directory, { recursive: true });
    await copyFile(path, join(directory, `${info.project.name}-${name}`));
  }
});
