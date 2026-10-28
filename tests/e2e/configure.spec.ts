import { gridCell, openBulk } from './grid-actions.js';
import { sidebarAction, sidebarNavigate } from './sidebar-actions.js';
import { expect, test, type Page } from '@playwright/test';
import type {
  Connection,
  Device,
  Port,
  PortField,
  PortCustomValues,
  Vlan,
} from '../../packages/shared/src/index.js';

const username = 'configure-admin';
const password = 'Synthetic-configure-password-42';
const switchName = 'QA eight-port switch';
const peerName = 'QA router';

test.use({ actionTimeout: 15_000 });

async function openDetails(page: Page, title: string) {
  const summary = page
    .locator('summary')
    .filter({ hasText: new RegExp(`^${title}$`) });
  if (
    !(await summary.evaluate((element) =>
      element.parentElement?.hasAttribute('open'),
    ))
  )
    await summary.click();
  return summary.locator('..');
}
async function saveAll(page: Page, count: number) {
  await page
    .getByRole('button', { name: 'Save all changes', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('status')).toHaveText(
    `${count} port${count === 1 ? '' : 's'} saved.`,
  );
  await expect(
    page.getByRole('button', { name: 'Save all changes', exact: true }),
  ).toBeDisabled();
}
async function selectDevice(page: Page, name: string) {
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeEnabled();
  if (
    await page
      .getByRole('heading', { name: `Ports · ${name}`, exact: true })
      .isVisible()
  )
    return;
  const inventory = page.getByRole('button', {
    name: `Configure ${name}`,
    exact: true,
  });
  if (await inventory.count()) await inventory.click();
  else {
    await openDetails(page, 'Device actions');
    await page
      .getByRole('combobox', { name: 'Device', exact: true })
      .selectOption({ label: name });
  }
  await page
    .getByRole('button', { name: 'Configure interfaces', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: `Ports · ${name}`, exact: true }),
  ).toBeVisible();
}
async function createDevice(page: Page, name: string, type = 'switch') {
  await sidebarAction(page, 'Add device');
  await page.getByRole('button', { name: /^Custom device/ }).click();
  await page.getByLabel('Device name', { exact: true }).fill(name);
  await page
    .getByRole('combobox', { name: 'Device type', exact: true })
    .selectOption(type);
  await page
    .getByLabel('Manufacturer', { exact: true })
    .fill('Synthetic equipment');
  await page.getByLabel('Model', { exact: true }).fill('Manual test model');
  await page
    .getByRole('button', { name: 'Create device', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Configure interfaces', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: `Ports · ${name}`, exact: true }),
  ).toBeVisible();
}
async function signIn(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
}

test('configures eight ports in site context with typed values, persistence and conflict protection', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const setup = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  if (setup.setupRequired) {
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page
      .getByRole('button', { name: 'Create administrator account' })
      .click();
  } else await signIn(page);
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
  await sidebarAction(page, 'Add workspace');
  await page.getByLabel('Workspace name').fill('Configure workspace');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await sidebarAction(page, 'Add site in Configure workspace');
  await page.getByLabel('Site name').fill('Configure lab');
  await page.getByRole('button', { name: 'Create site', exact: true }).click();
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Visual Overview');
  const siteUrl = page.url();
  const siteId = new URL(siteUrl).pathname.split('/').at(-1)!;
  const base = `/api/v1/sites/${siteId}`;
  async function read<T>(path: string): Promise<T> {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    return response.json() as Promise<T>;
  }
  const ports = async (deviceId: string) =>
    (await read<{ ports: Port[] }>(`${base}/devices/${deviceId}/ports`)).ports;
  const cell = (number: number, column: string) =>
    gridCell(page, number, column);
  await sidebarNavigate(page, 'Equipment');
  await expect(
    page.getByRole('heading', { name: 'Equipment', exact: true }),
  ).toBeVisible();
  await createDevice(page, switchName);
  await openDetails(page, 'Add ports');
  await page.getByRole('button', { name: 'Add 8 ports', exact: true }).click();
  await expect(
    page.getByRole('table', { name: `${switchName} ports` }).getByRole('row'),
  ).toHaveCount(9);
  const quick = await openDetails(page, 'Quick-add VLAN');
  for (const [id, name] of [
    [1, 'Management'],
    [20, 'Servers'],
    [30, 'Clients'],
  ] as const) {
    await quick.getByLabel('VLAN ID', { exact: true }).fill(String(id));
    await quick.getByLabel('VLAN name', { exact: true }).fill(name);
    await quick.getByLabel('VLAN color', { exact: true }).fill('#428deb');
    await quick
      .getByRole('button', { name: 'Create VLAN', exact: true })
      .click();
    await expect(page.locator('.port-grid').getByRole('status')).toHaveText(
      `VLAN ${id} created.`,
    );
  }
  expect((await read<{ racks: unknown[] }>(`${base}/racks`)).racks).toEqual([]);
  expect(
    (await read<{ subnets: unknown[] }>(`${base}/subnets`)).subnets,
  ).toEqual([]);
  const switchDevice = (
    await read<{ devices: Device[] }>(`${base}/devices`)
  ).devices.find((device) => device.displayName === switchName)!;
  const vlans = (await read<{ vlans: Vlan[] }>(`${base}/vlans`)).vlans;
  const vlan = (number: number) =>
    vlans.find((item) => item.vlanId === number)!.id;
  await (await cell(1, 'Mode')).selectOption('trunk');
  await (await cell(1, 'Native/Untagged VLAN')).selectOption(vlan(1));
  await expect(await cell(1, 'PVID')).toHaveValue('');
  await (await cell(1, 'PVID')).fill('1');
  await (await cell(1, 'Tagged VLANs')).selectOption([vlan(20), vlan(30)]);
  await (await cell(1, 'Description/Notes')).fill('Documented trunk uplink');
  await (await cell(2, 'Mode')).selectOption('access');
  await (await cell(2, 'Native/Untagged VLAN')).selectOption(vlan(20));
  await expect(await cell(2, 'PVID')).toHaveValue('');
  await (await cell(2, 'PVID')).fill('20');
  await (await cell(2, 'Link state (documented)')).selectOption('up');
  await (await cell(3, 'Mode')).selectOption('routed');
  await (await cell(3, 'PVID')).fill('4092');
  await (
    await cell(3, 'Description/Notes')
  ).fill('Routed WAN without an invented access VLAN');
  for (const number of [4, 5, 6, 7, 8])
    await page.getByLabel(`Select Port ${number}`, { exact: true }).check();
  await openBulk(page);
  await page
    .getByRole('combobox', { name: 'Selected rows mode', exact: true })
    .selectOption('access');
  await page
    .getByRole('combobox', { name: 'Selected rows native VLAN', exact: true })
    .selectOption(vlan(20));
  await page
    .getByRole('button', { name: 'Apply to selected', exact: true })
    .click();
  for (const number of [4, 5, 6, 7, 8]) {
    await expect(await cell(number, 'PVID')).toHaveValue('');
    await (await cell(number, 'PVID')).fill('20');
  }
  await saveAll(page, 8);
  let stored = await ports(switchDevice.id);
  expect(stored[0]).toMatchObject({
    mode: 'trunk',
    nativeVlanRef: vlan(1),
    pvid: 1,
  });
  expect(new Set(stored[0]!.taggedVlanRefs)).toEqual(
    new Set([vlan(20), vlan(30)]),
  );
  expect(stored[1]).toMatchObject({
    mode: 'access',
    nativeVlanRef: vlan(20),
    pvid: 20,
    documentedLinkState: 'up',
    taggedVlanRefs: [],
  });
  expect(stored[2]).toMatchObject({
    mode: 'routed',
    nativeVlanRef: null,
    pvid: 4092,
    taggedVlanRefs: [],
  });
  expect(stored.every((port) => port.rowVersion === 2)).toBe(true);
  await (await cell(3, 'PVID')).fill('30');
  await saveAll(page, 1);
  await sidebarNavigate(page, 'VLANs');
  const memberships = page.getByRole('table', { name: 'VLANs', exact: true });
  const clientVlanRow = memberships
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: '30', exact: true }) });
  await expect(clientVlanRow.locator('td').nth(3)).toHaveText('0 ports');
  await expect(
    clientVlanRow.locator('td').nth(4).locator('summary'),
  ).toHaveText('1 port');
  const serverVlanRow = memberships
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: '20', exact: true }) });
  await expect(
    serverVlanRow.locator('td').nth(3).locator('summary'),
  ).toHaveText('6 ports');
  await expect(
    serverVlanRow.locator('td').nth(4).locator('summary'),
  ).toHaveText('1 port');
  await sidebarNavigate(page, 'Equipment');
  await selectDevice(page, switchName);

  // Refresh must recheck draft consent after its response, including edits made in flight.
  let releaseRefresh!: () => void;
  let reportHeld!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshHeld = new Promise<void>((resolve) => {
    reportHeld = resolve;
  });
  await page.route(
    `${new URL(siteUrl).origin}${base}/devices`,
    async (route) => {
      const response = await route.fetch();
      reportHeld();
      await refreshGate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await openDetails(page, 'Device actions');
  await page
    .getByRole('button', { name: 'Refresh saved records', exact: true })
    .click();
  await refreshHeld;
  await (
    await cell(1, 'Description/Notes')
  ).fill('Draft typed while refresh is in flight');
  const refreshDialog = page.waitForEvent('dialog');
  page.once('dialog', (dialog) => dialog.dismiss());
  releaseRefresh();
  await refreshDialog;
  await expect(await cell(1, 'Description/Notes')).toHaveValue(
    'Draft typed while refresh is in flight',
  );
  await expect(
    page.getByRole('button', { name: 'Save all changes', exact: true }),
  ).toBeEnabled();
  await (await cell(1, 'Description/Notes')).press('Escape');
  await expect(await cell(1, 'Description/Notes')).toHaveValue(
    'Documented trunk uplink',
  );
  await expect(
    page.getByRole('button', { name: 'Save all changes', exact: true }),
  ).toBeDisabled();

  // Invalid cell details are programmatically associated and disappear when the draft is reverted.
  await (await cell(1, 'PVID')).fill('0');
  await page
    .getByRole('button', { name: 'Save all changes', exact: true })
    .click();
  await expect(await cell(1, 'PVID')).toHaveAttribute('aria-invalid', 'true');
  const pvidErrorId = await (
    await cell(1, 'PVID')
  ).getAttribute('aria-describedby');
  expect(pvidErrorId).toBeTruthy();
  const pvidError = page.locator(`[id="${pvidErrorId}"]`);
  await expect(pvidError).toBeVisible();
  await expect(pvidError).not.toHaveText('');
  await (await cell(1, 'PVID')).press('Escape');
  await expect(await cell(1, 'PVID')).toHaveValue('1');
  await expect(await cell(1, 'PVID')).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(pvidError).toHaveCount(0);

  await page.getByRole('button', { name: 'Port 2 Mode', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('combobox', { name: 'Port 2 Mode', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', {
      name: 'Port 2 Native/Untagged VLAN',
      exact: true,
    }),
  ).toBeFocused();
  await (await cell(2, 'Speed')).fill('1G');
  await (await cell(2, 'Speed')).press('Enter');
  await expect(
    page.getByRole('button', { name: 'Save all changes', exact: true }),
  ).toBeEnabled();
  await saveAll(page, 1);
  await (await cell(2, 'Speed')).fill('Discard this speed');
  await (await cell(2, 'Speed')).press('Escape');
  await expect(await cell(2, 'Speed')).toHaveValue('1G');
  await expect(
    page.getByRole('button', { name: 'Save all changes', exact: true }),
  ).toBeDisabled();
  await (await cell(4, 'Description/Notes')).fill('Keep unsaved edit');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sidebarNavigate(page, 'Visual Overview', true);
  await expect(await cell(4, 'Description/Notes')).toHaveValue(
    'Keep unsaved edit',
  );
  await (await cell(4, 'Description/Notes')).press('Escape');
  const navigationMenu = page.getByRole('button', {
    name: 'Menu',
    exact: true,
  });
  if (
    (await navigationMenu.isVisible()) &&
    (await navigationMenu.getAttribute('aria-expanded')) === 'true'
  )
    await navigationMenu.click();

  const paste = await openDetails(page, 'Spreadsheet copy/paste');
  const header =
    'Port\tMode\tNativeVLAN\tPVID\tTaggedVLANs\tSpeed\tDescription';
  await paste
    .getByRole('textbox', { name: 'Port table TSV', exact: true })
    .fill(`${header}\nPort 4\taccess\t999\t20\t\t1G\t`);
  await paste
    .getByRole('button', { name: 'Preview paste', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('alert')).toContainText(
    'does not exist',
  );
  await expect(
    paste.getByRole('button', { name: 'Stage paste', exact: true }),
  ).toBeDisabled();
  await paste
    .getByRole('textbox', { name: 'Port table TSV', exact: true })
    .fill(`${header}\nPort 4\taccess\t20\t20\t\t1G\t`);
  await paste
    .getByRole('button', { name: 'Preview paste', exact: true })
    .click();
  await expect(paste.getByRole('status')).toContainText('1 valid rows');
  await paste.getByRole('button', { name: 'Stage paste', exact: true }).click();
  await saveAll(page, 1);

  const custom = await openDetails(page, 'Custom columns');
  for (const field of [
    { key: 'measured_watts', title: 'Measured watts', type: 'number' },
    { key: 'poe_enabled', title: 'PoE enabled', type: 'boolean' },
    { key: 'review_date', title: 'Review date', type: 'date' },
    { key: 'device_role', title: 'Device role', type: 'select' },
  ]) {
    await custom
      .getByRole('button', { name: 'Add custom column', exact: true })
      .click();
    await custom.getByLabel('Field key', { exact: true }).fill(field.key);
    await custom.getByLabel('Column title', { exact: true }).fill(field.title);
    await custom
      .getByRole('combobox', { name: 'Value type', exact: true })
      .selectOption(field.type);
    if (field.type === 'select')
      await custom
        .getByLabel('Choices (one per line)', { exact: true })
        .fill('Production\nTest');
    await custom
      .getByRole('button', { name: 'Save custom column', exact: true })
      .click();
    await expect(
      custom.getByRole('heading', { name: 'New custom column', exact: true }),
    ).not.toBeVisible();
  }
  await (await cell(2, 'Measured watts')).fill('0');
  await (await cell(2, 'PoE enabled')).selectOption('false');
  await (await cell(2, 'Review date')).fill('2026-10-27');
  await (await cell(2, 'Device role')).selectOption('Test');
  await saveAll(page, 1);
  const fields = (await read<{ fields: PortField[] }>(`${base}/port-fields`))
    .fields;
  const values = (
    await read<{ customValues: PortCustomValues }>(
      `${base}/devices/${switchDevice.id}/port-values`,
    )
  ).customValues;
  stored = await ports(switchDevice.id);
  for (const [key, value] of [
    ['measured_watts', 0],
    ['poe_enabled', false],
    ['review_date', '2026-10-27'],
    ['device_role', 'Test'],
  ] as const)
    expect(
      values[stored[1]!.id]?.[fields.find((field) => field.key === key)!.id],
    ).toBe(value);
  await page.reload();
  await expect(await cell(2, 'Measured watts')).toHaveValue('0');
  await expect(await cell(2, 'PoE enabled')).toHaveValue('false');
  await expect(await cell(2, 'Review date')).toHaveValue('2026-10-27');
  await expect(await cell(2, 'Device role')).toHaveValue('Test');
  const columns = await openDetails(page, 'Columns');
  await columns.getByRole('checkbox', { name: 'Speed', exact: true }).check();
  await columns.getByRole('checkbox', { name: 'Speed', exact: true }).uncheck();
  await columns.getByRole('checkbox', { name: 'PVID', exact: true }).check();
  await columns
    .getByRole('button', { name: 'Move PVID column up', exact: true })
    .click();
  await page.reload();
  const table = page.getByRole('table', { name: `${switchName} ports` });
  await expect(table).toBeVisible();
  await expect(
    table.getByRole('columnheader', { name: 'Speed', exact: true }),
  ).not.toBeVisible();
  const headers = await table.getByRole('columnheader').allTextContents();
  expect(headers.indexOf('PVID')).toBeLessThan(
    headers.indexOf('Native/Untagged VLAN'),
  );
  for (const [key, value] of await page.evaluate(() =>
    Object.entries(localStorage),
  )) {
    expect(key).toMatch(/^portfolio:columns:v1:/);
    expect(Array.isArray(JSON.parse(value))).toBe(true);
    expect(value).not.toContain('Documented trunk uplink');
  }
  await (
    await openDetails(page, 'Columns')
  )
    .getByRole('checkbox', { name: 'Speed', exact: true })
    .check();

  await createDevice(page, peerName, 'router');
  await openDetails(page, 'Add ports');
  for (const name of ['Uplink', 'Backup']) {
    await page.getByLabel('New port name', { exact: true }).fill(name);
    await page
      .getByRole('button', { name: 'Add single port', exact: true })
      .click();
    await expect(
      page.getByLabel(`${name} Mode`, { exact: true }),
    ).toBeVisible();
  }
  const peerPaste = await openDetails(page, 'Spreadsheet copy/paste');
  const unsavedPaste = `${header}\nUplink\tother\t\t\t\t\t`;
  await peerPaste
    .getByRole('textbox', { name: 'Port table TSV', exact: true })
    .fill(unsavedPaste);
  const generation = await openDetails(page, 'Add ports');
  await generation.getByLabel('Port count', { exact: true }).fill('1');
  await generation.getByLabel('Start number', { exact: true }).fill('3');
  await generation
    .getByLabel('Name prefix', { exact: true })
    .fill('Generated ');
  await generation
    .getByRole('button', { name: 'Generate ports', exact: true })
    .click();
  await expect(
    page.getByLabel('Generated 3 Mode', { exact: true }),
  ).toBeVisible();
  await expect(
    peerPaste.getByRole('textbox', { name: 'Port table TSV', exact: true }),
  ).toHaveValue(unsavedPaste);
  await peerPaste
    .getByRole('button', { name: 'Clear paste', exact: true })
    .click();
  await selectDevice(page, switchName);
  await (
    await cell(1, 'Connection peer')
  ).selectOption({
    label: `${peerName} / Uplink`,
  });
  await page
    .getByRole('button', { name: 'Connect Port 1', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('status')).toHaveText(
    'Connection saved at both endpoints.',
  );
  const first = (
    await read<{ connections: Connection[] }>(`${base}/connections`)
  ).connections;
  expect(first).toHaveLength(1);
  await selectDevice(page, peerName);
  await expect(
    page
      .getByRole('table', { name: `${peerName} ports` })
      .getByText(`${switchName} / Port 1`, { exact: true }),
  ).toBeVisible();
  await (
    await gridCell(page, 'Uplink', 'Connection peer')
  ).selectOption({ label: `${switchName} / Port 2` });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Connect Uplink', exact: true })
    .click();
  expect(
    (await read<{ connections: Connection[] }>(`${base}/connections`))
      .connections,
  ).toEqual(first);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Connect Uplink', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('status')).toHaveText(
    'Connection saved at both endpoints.',
  );
  const replaced = (
    await read<{ connections: Connection[] }>(`${base}/connections`)
  ).connections;
  expect(replaced).toHaveLength(1);
  expect(replaced[0]!.id).not.toBe(first[0]!.id);
  await page.reload();
  await selectDevice(page, switchName);
  await expect(
    page
      .getByRole('table', { name: `${switchName} ports` })
      .getByText(`${peerName} / Uplink`, { exact: true }),
  ).toBeVisible();

  await gridCell(page, 2, 'Connection peer');
  const cableDetails = await openDetails(page, 'Cable details');
  await (
    await gridCell(page, 2, 'Cable notes')
  ).fill('Preserve this unsaved cable note');
  await expect(
    page.getByRole('searchbox', { name: 'Search ports', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('combobox', { name: 'Sort ports', exact: true }),
  ).toBeDisabled();
  const cableColumns = await openDetails(page, 'Columns');
  await expect(
    cableColumns.getByRole('checkbox', { name: 'Connected to', exact: true }),
  ).toBeDisabled();
  await expect(
    cableColumns.getByRole('checkbox', { name: 'Speed', exact: true }),
  ).toBeDisabled();
  await (await gridCell(page, 2, 'Cable notes')).press('Escape');
  await expect(await gridCell(page, 2, 'Cable notes')).toHaveValue(
    'Preserve this unsaved cable note',
  );
  await expect(
    page.getByRole('searchbox', { name: 'Search ports', exact: true }),
  ).toBeDisabled();
  const currentSession = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  const remoteCableEdit = await page.request.patch(
    `${base}/connections/${replaced[0]!.id}`,
    {
      headers: {
        Origin: new URL(siteUrl).origin,
        'x-csrf-token': currentSession.csrfToken,
      },
      data: {
        rowVersion: replaced[0]!.rowVersion,
        notes: 'Saved by another client',
      },
    },
  );
  expect(remoteCableEdit.status()).toBe(200);
  const cableGeneration = await openDetails(page, 'Add ports');
  await expect(
    cableGeneration.getByRole('button', {
      name: 'Generate ports',
      exact: true,
    }),
  ).toBeDisabled();
  expect(await ports(switchDevice.id)).toHaveLength(8);
  await expect(await gridCell(page, 2, 'Cable notes')).toHaveValue(
    'Preserve this unsaved cable note',
  );
  await cableDetails
    .getByRole('button', { name: 'Save cable details', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('alert')).toContainText(
    'changed',
  );
  await expect(await gridCell(page, 2, 'Cable notes')).toHaveValue(
    'Preserve this unsaved cable note',
  );
  expect(
    (await read<{ connections: Connection[] }>(`${base}/connections`))
      .connections[0]!.notes,
  ).toBe('Saved by another client');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Refresh ports', exact: true })
    .click();
  await expect(await gridCell(page, 2, 'Cable notes')).toHaveValue(
    'Saved by another client',
  );

  const secondContext = await browser.newContext();
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.goto(`${siteUrl}?view=configure`);
    await signIn(secondPage);
    await selectDevice(secondPage, switchName);
    await expect(await gridCell(secondPage, 2, 'Measured watts')).toHaveValue(
      '0',
    );
    await (
      await cell(2, 'Description/Notes')
    ).fill('Preserved first-browser draft');
    await (
      await cell(3, 'Description/Notes')
    ).fill('Second row must not be partially saved');
    await (
      await gridCell(secondPage, 2, 'Description/Notes')
    ).fill('Saved in second browser');
    await saveAll(secondPage, 1);
    await page
      .getByRole('button', { name: 'Save all changes', exact: true })
      .click();
    await expect(page.locator('.port-grid').getByRole('alert')).toContainText(
      'staged changes are preserved',
    );
    await expect(await cell(2, 'Description/Notes')).toHaveValue(
      'Preserved first-browser draft',
    );
    await expect(await cell(3, 'Description/Notes')).toHaveValue(
      'Second row must not be partially saved',
    );
    stored = await ports(switchDevice.id);
    expect(stored[1]!.description).toBe('Saved in second browser');
    expect(stored[2]!.description).toBe(
      'Routed WAN without an invented access VLAN',
    );
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('button', { name: 'Reload and discard drafts', exact: true })
      .click();
    await expect(await cell(2, 'Description/Notes')).toHaveValue(
      'Saved in second browser',
    );
  } finally {
    await secondContext.close();
  }

  expect(new URL(page.url()).pathname).toBe(new URL(siteUrl).pathname);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('.port-table-scroll')
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  const openSummaries = page.locator('.port-grid details[open] > summary');
  while (await openSummaries.count()) await openSummaries.first().click();
  await page.locator('.port-table-scroll').evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath('configure-grid.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const denseDeviceName = 'QA 48-port switch';
  await createDevice(page, denseDeviceName);
  await openDetails(page, 'Add ports');
  await page.getByRole('button', { name: 'Add 48 ports', exact: true }).click();
  const denseTable = page.getByRole('table', {
    name: `${denseDeviceName} ports`,
  });
  await expect(denseTable.getByRole('row')).toHaveCount(49);
  const denseDevice = (
    await read<{ devices: Device[] }>(`${base}/devices`)
  ).devices.find((device) => device.displayName === denseDeviceName)!;
  const densePorts = await ports(denseDevice.id);
  expect(densePorts).toHaveLength(48);
  expect(
    densePorts.every(
      (port) =>
        port.kind === 'rj45' &&
        port.mode === 'other' &&
        port.documentedLinkState === 'unknown',
    ),
  ).toBe(true);
  const denseColumns = await openDetails(page, 'Columns');
  await denseColumns
    .getByRole('button', { name: 'Reset column layout', exact: true })
    .click();
  await page.getByRole('button', { name: 'Port 48 Mode', exact: true }).focus();
  await page.keyboard.press('Tab');
  const lastNative = page.getByLabel('Port 48 Native/Untagged VLAN', {
    exact: true,
  });
  await expect(lastNative).toBeFocused();
  await expect(lastNative).toBeInViewport();
  expect(
    await lastNative.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    ),
  ).not.toBe('none');
  expect(
    await page
      .locator('.port-table-scroll')
      .evaluate(
        (element) =>
          element.scrollTop > 0 && element.scrollWidth > element.clientWidth,
      ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  while (await openSummaries.count()) await openSummaries.first().click();
  await page.locator('.port-table-scroll').evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath('configure-grid-48.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await sidebarNavigate(page, 'Visual Overview');
  await expect(
    page.getByRole('heading', { name: switchName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('8 documented ports', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Visual Overview');
  await page.getByRole('link', { name: 'Skip to content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  // Maximum-size devices bound rendered rows and peer pickers while saving drafts across pages.
  const boundarySession = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  const boundaryHeaders = {
    Origin: new URL(siteUrl).origin,
    'x-csrf-token': boundarySession.csrfToken,
  };
  const boundaryCreated = await page.request.post(`${base}/devices`, {
    headers: boundaryHeaders,
    data: { displayName: 'QA maximum-size switch', type: 'switch' },
  });
  expect(boundaryCreated.status()).toBe(201);
  const boundaryDevice = (await boundaryCreated.json()).device as Device;
  const boundaryGenerated = await page.request.post(
    `${base}/devices/${boundaryDevice.id}/ports/generate`,
    {
      headers: boundaryHeaders,
      data: { rowVersion: boundaryDevice.rowVersion, count: 256 },
    },
  );
  expect(boundaryGenerated.status()).toBe(201);
  const firstBatch = (await boundaryGenerated.json()) as {
    device: Device;
    ports: Port[];
  };
  const secondBatchResponse = await page.request.post(
    `${base}/devices/${boundaryDevice.id}/ports/generate`,
    {
      headers: boundaryHeaders,
      data: {
        rowVersion: firstBatch.device.rowVersion,
        count: 256,
        startNumber: 257,
      },
    },
  );
  expect(secondBatchResponse.status()).toBe(201);
  const secondBatch = (await secondBatchResponse.json()) as { ports: Port[] };
  const boundaryPorts = [...firstBatch.ports, ...secondBatch.ports].sort(
    (a, b) => a.orderIndex - b.orderIndex,
  );
  expect(boundaryPorts).toHaveLength(512);
  await page.goto(
    `${siteUrl}?view=configure&deviceId=${boundaryDevice.id}&portId=${boundaryPorts[0]!.id}`,
  );
  const boundaryTable = page.getByRole('table', {
    name: 'QA maximum-size switch ports',
    exact: true,
  });
  await expect(boundaryTable.getByRole('row')).toHaveCount(65);
  await expect(
    page.getByText('Showing 1–64 of 512 ports', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('select[aria-label$=" Connection peer"]'),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Choose connection for Port 1', exact: true })
    .click();
  await expect(
    page.locator('select[aria-label$=" Connection peer"]'),
  ).toHaveCount(1);
  expect(await boundaryTable.locator('option').count()).toBeLessThan(3000);
  await (
    await gridCell(page, 1, 'Description/Notes')
  ).fill('First-page unsaved draft');
  for (let index = 0; index < 7; index++)
    await page
      .getByRole('button', { name: 'Next port page', exact: true })
      .click();
  await expect(
    page.getByText('Showing 449–512 of 512 ports', { exact: true }),
  ).toBeVisible();
  await expect(boundaryTable.getByRole('row')).toHaveCount(65);
  await (
    await gridCell(page, 512, 'Description/Notes')
  ).fill('Last-page unsaved draft');
  await saveAll(page, 2);
  const boundarySaved = await ports(boundaryDevice.id);
  expect(
    boundarySaved.find((port) => port.name === 'Port 1')!.description,
  ).toBe('First-page unsaved draft');
  expect(
    boundarySaved.find((port) => port.name === 'Port 512')!.description,
  ).toBe('Last-page unsaved draft');
  await page.goto(
    `${siteUrl}?view=configure&deviceId=${boundaryDevice.id}&portId=${boundaryPorts.at(-1)!.id}`,
  );
  await expect(page.getByLabel('Port 512 Port', { exact: true })).toBeFocused();
  await expect(
    page.getByLabel('Port 512 Port', { exact: true }),
  ).toBeInViewport();
  await expect(boundaryTable.getByRole('row')).toHaveCount(65);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
