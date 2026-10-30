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
