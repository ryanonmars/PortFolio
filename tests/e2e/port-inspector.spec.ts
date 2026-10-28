import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardPort,
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
async function collapseBrowser(page: Page) {
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
}
async function selectPort(page: Page, id: string, touch = false) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
  await collapseBrowser(page);
  const socket = page.locator(`button[data-port-id="${id}"]`);
  if (touch) await socket.tap();
  else await socket.click();
  await expect(inspector(page)).toBeVisible();
}
function port(deviceId: string, index: number, linkState: string): BoardPort {
  return {
    id: randomUUID(),
    deviceId,
    face: 'front',
    row: 0,
    column: index,
    name: `Port ${index + 1}`,
    kind: 'rj45',
    color: '#428deb',
    role: 'Provider handoff / custom purpose',
    speed: 'Documented custom speed',
    linkState,
    nativeVlan: '20',
    taggedVlans: ['30', 'unlisted'],
    pvid: '77',
    address: '2001:db8::10/64; DHCP',
    externalDestination: 'Wall Jack A12',
    notes: 'Existing authored notes',
    customFields: { Count: 0, Enabled: false },
  };
}
const helpCases = [
  [
    'Port Purpose',
    'What this port is used for.',
    'WAN, LAN, Uplink, Trunk, Management, Server',
  ],
  [
    'Speed',
    'The documented port speed or negotiated link speed.',
    'not automatically detected',
  ],
  [
    'Link Status',
    'manually documented physical link state',
    'PortFolio does not monitor live port status',
  ],
  ['Native VLAN', 'outgoing untagged traffic', 'may differ from the PVID'],
  ['Tagged VLANs', '802.1Q tag', 'multiple tagged VLANs'],
  ['PVID', 'incoming untagged traffic', 'independent of the Native VLAN field'],
  [
    'Interface IP / Address',
    'Optional IP addressing information',
    'Layer 2 switch ports',
  ],
  [
    'External Connection',
    'not represented by another port',
    'visual Cable tool',
  ],
] as const;

test('Port inspector clarifies independent documentation and accessible contextual help without changing stored legacy values', async ({
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
  const deviceId = randomUUID();
  document.elements.push({
    id: deviceId,
    type: 'device',
    name: 'Legacy documentation',
    x: 20,
    y: 20,
    width: 600,
    height: 400,
    z: 0,
    color: '#24332b',
    properties: { deviceType: 'Custom', face: 'front', portSpacing: 8 },
  });
  document.ports = [
    port(deviceId, 0, ' Documented UP '),
    port(deviceId, 1, 'intermittent / provider notes'),
    port(deviceId, 2, ''),
  ];
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Port inspector ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).board.id as string;
  await page.goto(`/boards/${id}`);
  await saved(page);
  const touch = info.project.name.startsWith('mobile');
  await selectPort(page, document.ports[0]!.id, touch);
  await expect(
    inspector(page).getByLabel('Link Status', { exact: true }),
  ).toHaveValue('up');
  await expect(
    inspector(page).getByLabel('Port Purpose', { exact: true }),
  ).toHaveValue(document.ports[0]!.role);
  await expect(
    inspector(page).getByLabel('Interface IP / Address', { exact: true }),
  ).toHaveValue(document.ports[0]!.address);
  await expect(
    inspector(page).getByLabel('External Connection', { exact: true }),
  ).toHaveValue('Wall Jack A12');
  for (const old of [
    'Port role',
    'Documented link state',
    'Native/untagged VLAN',
    'Address information',
    'External destination',
  ])
    await expect(inspector(page).getByLabel(old, { exact: true })).toHaveCount(
      0,
    );
  await expect(
    inspector(page).getByRole('button', { name: /^Help for / }),
  ).toHaveCount(8);
  expect(
    await inspector(page)
      .getByLabel('Port Purpose', { exact: true })
      .evaluate((node) =>
        [...((node as HTMLInputElement).list?.options ?? [])].map(
          (option) => option.value,
        ),
      ),
  ).toEqual(expect.arrayContaining(['WAN', 'LAN', 'Uplink', 'Other']));
  expect(
    await inspector(page)
      .getByLabel('Speed', { exact: true })
      .evaluate((node) =>
        [...((node as HTMLInputElement).list?.options ?? [])].map(
          (option) => option.value,
        ),
      ),
  ).toEqual(expect.arrayContaining(['100M', '1G', '10G', '100G']));
  const beforeHelp = await read(page, id);
  for (const [label, first, second] of helpCases) {
    const help = inspector(page).getByRole('button', {
      name: `Help for ${label}`,
      exact: true,
    });
    await help.scrollIntoViewIfNeeded();
    if (touch) await help.tap();
    else await help.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(first);
    await expect(tooltip).toContainText(second);
    const tooltipId = await tooltip.getAttribute('id');
    expect(tooltipId).toBeTruthy();
    expect(
      (
        await inspector(page)
          .getByLabel(label, { exact: true })
          .getAttribute('aria-describedby')
      )?.split(' '),
    ).toContain(tooltipId);
    const bounds = (await tooltip.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
    await page.keyboard.press('Escape');
    await expect(tooltip).not.toBeVisible();
  }
  const keyboardHelp = inspector(page).getByRole('button', {
    name: 'Help for Port Purpose',
    exact: true,
  });
  await keyboardHelp.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(keyboardHelp).toBeFocused();
  await keyboardHelp.press('Escape');
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  await keyboardHelp.press('Enter');
  await expect(page.getByRole('tooltip')).toBeVisible();
  await inspector(page).getByLabel('Port name', { exact: true }).click();
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  if (touch) await keyboardHelp.tap();
  else await keyboardHelp.click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  if (touch) await keyboardHelp.tap();
  else await keyboardHelp.click();
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  expect(await read(page, id)).toEqual(beforeHelp);
  const status = inspector(page).getByLabel('Link Status', { exact: true });
  await status.selectOption('down');
  await saved(page);
  expect((await read(page, id)).document.ports[0]!.linkState).toBe('down');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document.ports[0]!.linkState).toBe(
    ' Documented UP ',
  );
  await selectPort(page, document.ports[0]!.id, touch);
  await expect(status).toHaveValue('up');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document.ports[0]!.linkState).toBe('down');
  await selectPort(page, document.ports[0]!.id, touch);
  await inspector(page)
    .getByLabel('Port Purpose', { exact: true })
    .fill('Temporary uplink / unusual custom role');
  await inspector(page)
    .getByLabel('Speed', { exact: true })
    .fill('Private negotiated speed');
  await inspector(page)
    .getByLabel('Native VLAN', { exact: true })
    .fill('VLAN not defined / 1234');
  await inspector(page)
    .getByLabel('Tagged VLANs', { exact: true })
    .fill('20, 30, anything');
  await inspector(page)
    .getByLabel('PVID', { exact: true })
    .fill('99 independently');
  await inspector(page)
    .getByLabel('Interface IP / Address', { exact: true })
    .fill('DHCP / host.example / 2001:db8::20');
  await inspector(page)
    .getByLabel('External Connection', { exact: true })
    .fill('ISP Modem / wall handoff');
  await saved(page);
  let stored = await read(page, id);
  expect(stored.document.ports[0]).toMatchObject({
    role: 'Temporary uplink / unusual custom role',
    speed: 'Private negotiated speed',
    linkState: 'down',
    nativeVlan: 'VLAN not defined / 1234',
    taggedVlans: ['20', '30', 'anything'],
    pvid: '99 independently',
    address: 'DHCP / host.example / 2001:db8::20',
    externalDestination: 'ISP Modem / wall handoff',
    customFields: { Count: 0, Enabled: false },
  });
  expect(stored.document.cables).toEqual([]);
  expect(stored.document.elements).toEqual(document.elements);
  await selectPort(page, document.ports[1]!.id, touch);
  await expect(
    inspector(page)
      .getByLabel('Link Status', { exact: true })
      .locator('option:checked'),
  ).toContainText('intermittent / provider notes');
  await inspector(page)
    .getByLabel('Speed', { exact: true })
    .fill('Unusual stored speed');
  await saved(page);
  stored = await read(page, id);
  expect(stored.document.ports[1]!.linkState).toBe(
    'intermittent / provider notes',
  );
  await selectPort(page, document.ports[2]!.id, touch);
  await expect(
    inspector(page).getByLabel('Link Status', { exact: true }),
  ).toHaveValue('unknown');
  expect((await read(page, id)).document.ports[2]!.linkState).toBe('');
  await inspector(page)
    .getByRole('button', { name: 'Close inspector', exact: true })
    .click();
  await page
    .locator(`[data-board-element-id="${deviceId}"] .board-element-header`)
    .click();
  await inspector(page).getByLabel('Port quantity', { exact: true }).fill('1');
  await inspector(page)
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await saved(page);
  stored = await read(page, id);
  expect(stored.document.ports[3]!.linkState).toBe('unknown');
  await page.reload();
  await saved(page);
  await selectPort(page, document.ports[0]!.id, touch);
  await expect(
    inspector(page).getByLabel('Link Status', { exact: true }),
  ).toHaveValue('down');
  await expect(
    inspector(page).getByLabel('Port Purpose', { exact: true }),
  ).toHaveValue('Temporary uplink / unusual custom role');
  await expect(inspector(page).getByLabel('PVID', { exact: true })).toHaveValue(
    '99 independently',
  );
  const externalHelp = inspector(page).getByRole('button', {
    name: 'Help for External Connection',
    exact: true,
  });
  await externalHelp.scrollIntoViewIfNeeded();
  if (touch) await externalHelp.tap();
  else await externalHelp.click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await inspector(page)
    .locator('.board-inspector-body')
    .evaluate((node) => {
      node.scrollTop += 20;
    });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const scrolledTooltip = (await page.getByRole('tooltip').boundingBox())!;
  expect(scrolledTooltip.x).toBeGreaterThanOrEqual(0);
  expect(scrolledTooltip.y).toBeGreaterThanOrEqual(0);
  expect(scrolledTooltip.x + scrolledTooltip.width).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  );
  expect(scrolledTooltip.y + scrolledTooltip.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await page.screenshot({ path: info.outputPath('port-contextual-help.png') });
  await inspector(page)
    .locator('.board-inspector-body')
    .evaluate((node) => {
      node.scrollTop = 0;
    });
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('port-inspector.png') });
  const archive = await (
    await page.request.get(`/api/v1/boards/${id}/export`)
  ).json();
  expect(archive.document.ports).toEqual((await read(page, id)).document.ports);
  expect(archive.document.ports[1].linkState).toBe(
    'intermittent / provider notes',
  );
  expect(errors).toEqual([]);
});
