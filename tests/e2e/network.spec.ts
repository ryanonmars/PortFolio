import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardRecord,
  type JsonValue,
} from '../../packages/shared/src/board.js';

test.use({ actionTimeout: 15_000 });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
async function saved(page: Page) {
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
}
async function selectNetwork(page: Page, element: Locator) {
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await element.locator('.board-network-summary p').first().click();
}
async function openDetails(owner: Locator, name: string) {
  const summary = owner
    .locator('summary')
    .filter({ hasText: new RegExp(`^${name}$`) });
  const details = summary.locator('..');
  if (!(await details.evaluate((node) => node.hasAttribute('open'))))
    await summary.click();
  return details;
}
async function read(page: Page, id: string): Promise<BoardRecord> {
  const response = await page.request.get(`/api/v1/boards/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).board;
}

test('network entries preserve annotations and autosave independent DHCP toggles', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
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
  document.elements.push({
    id: randomUUID(),
    type: 'network',
    name: 'Prior network',
    x: 20,
    y: 20,
    width: 340,
    height: 240,
    z: 0,
    color: '#235545',
    properties: {
      notes: 'Container-level notes',
      displayFields: ['name', 'vlanId'],
      entries: [
        {
          name: 'Previous label',
          vlanName: 'Management',
          vlanId: '20',
          addresses: '192.0.2.200; old.example',
          pvid: '77',
          dhcpStatus: ' Enabled ',
          dhcpStart: '192.0.2.10',
          dhcpEnd: '192.0.2.90',
          customFields: { Original: false },
        },
        {
          name: 'Ambiguous network',
          vlanId: 'odd-vlan',
          dhcpStatus: 'Relay to router?',
          dhcpStart: 'freeform start',
          dhcpEnd: 'freeform end',
        },
      ],
    },
  });
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Network refinement ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).board.id as string;
  await page.goto(`/boards/${id}`);
  await saved(page);
  const element = page.locator(
    `[data-board-element-id="${document.elements[0]!.id}"]`,
  );
  await selectNetwork(page, element);
  await inspector(page)
    .getByLabel('Network container name', { exact: true })
    .fill('Home Network');
  await saved(page);
  for (const label of ['Name', 'IP addresses', 'PVID', 'DHCP status'])
    await expect(
      inspector(page).getByLabel(label, { exact: true }),
    ).toHaveCount(0);
  const first = await openDetails(inspector(page), 'Management');
  await expect(
    first.getByRole('checkbox', { name: 'DHCP Server', exact: true }),
  ).toBeChecked();
  await expect(
    first.getByLabel('DHCP pool start', { exact: true }),
  ).toHaveValue('192.0.2.10');
  await first
    .getByRole('checkbox', { name: 'DHCP Server', exact: true })
    .uncheck();
  await saved(page);
  await expect(
    first.getByLabel('DHCP pool start', { exact: true }),
  ).toHaveCount(0);
  await expect(first.getByLabel('DHCP pool end', { exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await saved(page);
  await selectNetwork(page, element);
  await openDetails(inspector(page), 'Management');
  const entryDetails = inspector(page)
    .locator('details')
    .filter({
      has: page.getByLabel('VLAN ID', { exact: true }),
    });
  const reloaded = entryDetails.nth(0);
  await expect(
    reloaded.getByRole('checkbox', { name: 'DHCP Server', exact: true }),
  ).not.toBeChecked();
  await reloaded
    .getByRole('checkbox', { name: 'DHCP Server', exact: true })
    .check();
  await expect(
    reloaded.getByLabel('DHCP pool start', { exact: true }),
  ).toHaveValue('192.0.2.10');
  await expect(
    reloaded.getByLabel('DHCP pool end', { exact: true }),
  ).toHaveValue('192.0.2.90');
  await reloaded
    .getByLabel('DHCP pool start', { exact: true })
    .fill('pool begins here');
  await reloaded
    .getByLabel('Subnet/CIDR', { exact: true })
    .fill('any authored range');
  await reloaded.getByLabel('Gateway', { exact: true }).fill('gateway.example');
  await reloaded.getByLabel('VLAN name', { exact: true }).fill('Servers');
  await saved(page);
  await expect(element.locator('.board-network-summary')).toContainText(
    'Servers',
  );
  await expect(element.locator('.board-network-summary')).not.toContainText(
    'Previous label',
  );
  await reloaded.getByLabel('VLAN name', { exact: true }).fill('');
  await saved(page);
  await expect(element.locator('.board-network-summary')).not.toContainText(
    'Previous label',
  );
  await expect(element.locator('.board-network-summary')).not.toContainText(
    'Servers',
  );
  await reloaded.getByLabel('VLAN name', { exact: true }).fill('Servers');
  await saved(page);
  const preserved = await openDetails(reloaded, 'Preserved fields');
  await expect(
    preserved.getByLabel('Previous entry name', { exact: true }),
  ).toHaveValue('Previous label');
  await expect(
    preserved.getByLabel('Previous IP addresses', { exact: true }),
  ).toHaveValue('192.0.2.200; old.example');
  await expect(
    preserved.getByLabel('Previous PVID', { exact: true }),
  ).toHaveValue('77');
  await expect(
    preserved.getByLabel('Previous DHCP status', { exact: true }),
  ).toHaveValue(' Enabled ');
  const ambiguous = await openDetails(inspector(page), 'Ambiguous network');
  await expect(
    ambiguous.getByRole('checkbox', { name: 'DHCP Server', exact: true }),
  ).not.toBeChecked();
  await expect(
    ambiguous.getByLabel('DHCP pool start', { exact: true }),
  ).toHaveCount(0);
  const ambiguousPreserved = await openDetails(
    ambiguous,
    'Preserved fields · review DHCP',
  );
  await expect(
    ambiguousPreserved.getByLabel('Previous DHCP status', { exact: true }),
  ).toHaveValue('Relay to router?');
  await inspector(page)
    .getByRole('button', { name: 'Add network entry', exact: true })
    .click();
  await openDetails(inspector(page), 'Entry 3');
  const created = entryDetails.nth(2);
  await created.getByLabel('VLAN ID', { exact: true }).fill('99999 / custom');
  await created.getByLabel('VLAN name', { exact: true }).fill('User Devices');
  await created.getByLabel('Notes', { exact: true }).fill('Independent entry');
  await expect(
    created.getByRole('checkbox', { name: 'DHCP Server', exact: true }),
  ).not.toBeChecked();
  const custom = created
    .locator('summary')
    .filter({ hasText: /^Custom fields$/ })
    .locator('..');
  await expect(custom).not.toHaveAttribute('open');
  await saved(page);
  const entries = (await read(page, id)).document.elements[0]!.properties
    .entries as Record<string, JsonValue>[];
  expect(entries).toHaveLength(3);
  expect(entries[0]).toMatchObject({
    name: 'Previous label',
    addresses: '192.0.2.200; old.example',
    pvid: '77',
    dhcpStatus: ' Enabled ',
    vlanName: 'Servers',
    dhcpStart: 'pool begins here',
    dhcpEnd: '192.0.2.90',
    customFields: { Original: false },
  });
  expect(entries[1]).toMatchObject({
    name: 'Ambiguous network',
    dhcpStatus: 'Relay to router?',
    dhcpStart: 'freeform start',
    dhcpEnd: 'freeform end',
  });
  await inspector(page)
    .getByLabel('Network container name', { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('network-refinement.png') });
  await inspector(page)
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  const dock = page.getByRole('dialog', {
    name: 'Equipment Dock',
    exact: true,
  });
  await dock.getByRole('button', { name: 'Device', exact: true }).click();
  await dock.getByRole('button', { name: 'Switch', exact: true }).click();
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  const port = (await read(page, id)).document.ports[0]!;
  await inspector(page)
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  await page.locator(`button[data-port-id="${port.id}"]`).click();
  await inspector(page)
    .getByLabel('PVID', { exact: true })
    .fill('Independent port PVID');
  await saved(page);
  await page.reload();
  await saved(page);
  expect((await read(page, id)).document.ports[0]!.pvid).toBe(
    'Independent port PVID',
  );
  expect(
    (await read(page, id)).document.elements[0]!.properties.entries,
  ).toEqual(entries);
  expect(errors).toEqual([]);
});
