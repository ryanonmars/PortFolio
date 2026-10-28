import { sidebarNavigate } from './sidebar-actions.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  siteArchiveSchema,
  type Device,
  type Port,
  type PortField,
  type Rack,
  type Subnet,
  type SiteArchive,
  type Vlan,
  type Workspace,
  type Site,
} from '../../packages/shared/src/index.js';

test.use({ actionTimeout: 15_000 });
const username = 'visual-admin';
const password = 'Synthetic-visual-password-42';
async function signIn(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
}

test('downloads a complete archive and previews, copies and explicitly replaces it atomically', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  const consoleErrors: { text: string; url: string }[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith('http') &&
      url.origin !== new URL(baseURL!).origin
    )
      externalRequests.push(url.toString());
  });
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
  const origin = new URL(baseURL!).origin;
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  async function read<T>(path: string): Promise<T> {
    const response = await page.request.get(`/api/v1${path}`);
    expect(response.status(), path).toBe(200);
    return response.json() as Promise<T>;
  }
  async function write<T>(
    path: string,
    method: 'POST' | 'PATCH',
    data: unknown,
    expected = method === 'POST' ? 201 : 200,
  ): Promise<T> {
    const response = await page.request.fetch(`/api/v1${path}`, {
      method,
      headers: { Origin: origin, 'x-csrf-token': session.csrfToken },
      data,
    });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(
      expected,
    );
    return response.json() as Promise<T>;
  }
  const unique = `${testInfo.project.name} ${randomUUID().slice(0, 8)}`;
  const { workspace } = await write<{ workspace: Workspace }>(
    '/workspaces',
    'POST',
    { name: `Transfer workspace ${unique}` },
  );
  const { site } = await write<{ site: Site }>(
    `/workspaces/${workspace.id}/sites`,
    'POST',
    {
      name: `Source ${unique}`,
      description: 'Synthetic source description',
      notes: 'Offline manual documentation',
    },
  );
  const root = `/sites/${site.id}`;
  const { vlan } = await write<{ vlan: Vlan }>(`${root}/vlans`, 'POST', {
    vlanId: 20,
    name: 'Synthetic VLAN',
    color: '#428deb',
  });
  const { rack } = await write<{ rack: Rack }>(`${root}/racks`, 'POST', {
    name: 'Synthetic rack',
  });
  const { subnet } = await write<{ subnet: Subnet }>(
    `${root}/subnets`,
    'POST',
    {
      cidr: '192.0.2.0/24',
      name: 'Documentation example',
      vlanRef: vlan.id,
      gatewayIp: '192.0.2.1',
    },
  );
  await write(`${root}/subnets/${subnet.id}/dhcp-scopes`, 'POST', {
    name: 'Synthetic DHCP',
    startIp: '192.0.2.10',
    endIp: '192.0.2.30',
    enabled: false,
  });
  const { device } = await write<{ device: Device }>(
    `${root}/devices`,
    'POST',
    { displayName: 'Archive switch', type: 'switch', rackId: rack.id },
  );
  const generated = await write<{ ports: Port[] }>(
    `${root}/devices/${device.id}/ports/generate`,
    'POST',
    { count: 8, rowVersion: device.rowVersion },
  );
  const { field } = await write<{ field: PortField }>(
    `${root}/port-fields`,
    'POST',
    { key: 'watts', title: 'Measured watts', valueType: 'number' },
  );
  const { field: booleanField } = await write<{ field: PortField }>(
    `${root}/port-fields`,
    'POST',
    { key: 'poe', title: 'PoE enabled', valueType: 'boolean' },
  );
  const saved = await write<{ ports: Port[] }>(
    `${root}/ports/bulk-edit`,
    'POST',
    {
      updates: generated.ports.map((port, index) => ({
        portId: port.id,
        rowVersion: port.rowVersion,
        changes: {
          mode: 'access',
          nativeVlanRef: vlan.id,
          pvid: 20,
          description:
            index === 0 ? '<img src=x onerror="window.transferUnsafe=1">' : '',
        },
        ...(index === 0
          ? { customValues: { [field.id]: 0, [booleanField.id]: false } }
          : {}),
      })),
    },
    200,
  );
  await write(`${root}/connections`, 'POST', {
    endpointAPortId: saved.ports[0]!.id,
    endpointBPortId: saved.ports[1]!.id,
    endpointARowVersion: saved.ports[0]!.rowVersion,
    endpointBRowVersion: saved.ports[1]!.rowVersion,
    cableType: 'Synthetic Cat6',
    notes: 'Preserve this cable',
  });
  async function openTransfer(siteId: string) {
    await page.goto(`${origin}/sites/${siteId}`);
    await sidebarNavigate(page, 'Equipment');
    await sidebarNavigate(page, 'Import & Export');
  }
  async function upload(document: unknown) {
    await page.getByLabel('Import JSON file', { exact: true }).setInputFiles({
      name: 'synthetic-site.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        typeof document === 'string' ? document : JSON.stringify(document),
      ),
    });
  }
  const archive = await read<SiteArchive>(`${root}/export`);
  siteArchiveSchema.parse(archive);
  expect(archive.ports).toHaveLength(8);
  expect(archive.connections).toHaveLength(1);
  await openTransfer(site.id);
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download site JSON', exact: true })
    .click();
  const download = await downloadPromise;
  const downloaded = JSON.parse(
    await readFile((await download.path())!, 'utf8'),
  ) as SiteArchive;
  expect(downloaded).toEqual(archive);
  const copyName = `Copy ${unique}`;
  const policy = page.getByRole('combobox', {
    name: 'Import policy',
    exact: true,
  });
  await expect(policy).toHaveValue('new-site');
  for (const invalid of [
    '{ invalid JSON',
    { ...archive, schemaVersion: 99 },
    {
      ...archive,
      ports: archive.ports.map((port, index) =>
        index ? port : { ...port, nativeVlanRef: randomUUID() },
      ),
    },
  ]) {
    await upload(invalid);
    await page
      .getByRole('textbox', { name: 'Imported site name', exact: true })
      .fill(copyName);
    await page
      .getByRole('button', { name: 'Preview import', exact: true })
      .click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await read<SiteArchive>(`${root}/export`)).toEqual(archive);
    expect(
      (await read<{ sites: Site[] }>(`/workspaces/${workspace.id}/sites`))
        .sites,
    ).toHaveLength(1);
  }
  await upload(downloaded);
  await page
    .getByRole('textbox', { name: 'Imported site name', exact: true })
    .fill(copyName);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  const importCopy = page.getByRole('button', {
    name: 'Import as new site',
    exact: true,
  });
  await expect(importCopy).toBeEnabled();
  const preview = page.getByRole('region', {
    name: 'Import preview',
    exact: true,
  });
  for (const [title, count] of [
    ['Racks', 1],
    ['VLANs', 1],
    ['Subnets', 1],
    ['DHCP scopes', 1],
    ['Devices', 1],
    ['Ports', 8],
    ['Custom fields', 2],
    ['Custom values', 2],
    ['Physical connections', 1],
  ] as const) {
    await expect(
      preview
        .locator('dt')
        .filter({ hasText: new RegExp(`^${title}$`) })
        .locator('xpath=following-sibling::dd[1]'),
    ).toHaveText(String(count));
  }
  expect(await read<SiteArchive>(`${root}/export`)).toEqual(archive);
  await page.screenshot({
    path: testInfo.outputPath('transfer-preview.png'),
    fullPage: true,
  });
  const copyResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${root}/import/commit`) &&
      response.request().method() === 'POST',
  );
  await importCopy.click();
  const copiedResponse = await copyResponse;
  expect(copiedResponse.status()).toBe(201);
  const copied = (await copiedResponse.json()).site as Site;
  expect(copied.id).not.toBe(site.id);
  expect(copied.name).toBe(copyName);
  await expect(
    page.getByRole('link', { name: 'Open imported site', exact: true }),
  ).toHaveAttribute('href', `/sites/${copied.id}`);
  const copyRoot = `/sites/${copied.id}`;
  const copyArchive = await read<SiteArchive>(`${copyRoot}/export`);
  siteArchiveSchema.parse(copyArchive);
  expect(copyArchive.devices).toHaveLength(1);
  expect(copyArchive.ports).toHaveLength(8);
  expect(copyArchive.connections).toHaveLength(1);
  expect(copyArchive.racks).toHaveLength(1);
  expect(copyArchive.subnets).toHaveLength(1);
  expect(copyArchive.dhcpScopes).toHaveLength(1);
  expect(copyArchive.devices[0]!.rackId).toBe(copyArchive.racks[0]!.id);
  expect(copyArchive.subnets[0]!.vlanRef).toBe(copyArchive.vlans[0]!.id);
  expect(copyArchive.dhcpScopes[0]!.subnetId).toBe(copyArchive.subnets[0]!.id);
  expect(copyArchive.dhcpScopes[0]!.enabled).toBe(false);
  expect(copyArchive.customValues.map((value) => value.value)).toEqual(
    expect.arrayContaining([0, false]),
  );
  expect(
    copyArchive.ports.every(
      (port) => !archive.ports.some((original) => original.id === port.id),
    ),
  ).toBe(true);
  expect(copyArchive.connections[0]!.endpointAPortId).not.toBe(
    archive.connections[0]!.endpointAPortId,
  );
  async function assertVisual(target: Page) {
    await target.goto(`${origin}/sites/${copied.id}`);
    await expect(
      target.locator('.sidebar-panel a[aria-current="location"]'),
    ).toHaveText('Visual Overview');
    await expect(target.locator('button[data-port-id]')).toHaveCount(8);
    const first = copyArchive.ports.find((port) => port.name === 'Port 1')!;
    await target.locator(`button[data-port-id="${first.id}"]`).click();
    const inspector = target.getByRole('complementary', {
      name: 'Port inspector',
      exact: true,
    });
    await expect(inspector).toContainText('Preserve this cable');
    await expect(
      inspector
        .locator('dt')
        .filter({ hasText: /^Measured watts$/ })
        .locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('0');
    await expect(
      inspector
        .locator('dt')
        .filter({ hasText: /^PoE enabled$/ })
        .locator('xpath=following-sibling::dd[1]'),
    ).toHaveText(/^false$/i);
    expect(await target.evaluate(() => 'transferUnsafe' in window)).toBe(false);
  }
  await assertVisual(page);
  await page.reload();
  await expect(page.locator('button[data-port-id]')).toHaveCount(8);
  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await second.goto(origin);
    await signIn(second);
    await assertVisual(second);
  } finally {
    await secondContext.close();
  }
  await openTransfer(copied.id);
  await upload(downloaded);
  await policy.selectOption('replace');
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  const replace = page.getByRole('button', {
    name: 'Replace current site',
    exact: true,
  });
  const confirmation = page.getByRole('checkbox', {
    name: 'I understand this replaces all contents of the current site',
    exact: true,
  });
  await expect(replace).toBeDisabled();
  await confirmation.check();
  await expect(replace).toBeEnabled();
  await confirmation.uncheck();
  await page.getByRole('button', { name: 'Clear import', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Import preview', exact: true }),
  ).toHaveCount(0);
  await expect(policy).toHaveValue('new-site');
  await expect(
    page.getByRole('button', { name: 'Edit site', exact: true }),
  ).toBeEnabled();
  await sidebarNavigate(page, 'Visual Overview');
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Visual Overview');
  expect(await read<SiteArchive>(`${copyRoot}/export`)).toEqual(copyArchive);
  await openTransfer(copied.id);
  await upload(downloaded);
  await policy.selectOption('replace');
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await confirmation.check();
  const freshPort = copyArchive.ports[0]!;
  await write(`${copyRoot}/ports/${freshPort.id}`, 'PATCH', {
    rowVersion: freshPort.rowVersion,
    description: 'Second writer after preview',
  });
  const staleBefore = await read<SiteArchive>(`${copyRoot}/export`);
  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith(`${copyRoot}/import/commit`),
  );
  await replace.click();
  expect((await staleResponse).status()).toBe(409);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(policy).toHaveValue('replace');
  await expect(
    page.getByRole('textbox', { name: 'JSON document', exact: true }),
  ).toHaveValue(JSON.stringify(downloaded));
  await expect(
    page.getByRole('region', { name: 'Import preview', exact: true }),
  ).toHaveCount(0);
  expect(await read<SiteArchive>(`${copyRoot}/export`)).toEqual(staleBefore);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await confirmation.check();
  const replaceResponse = page.waitForResponse((response) =>
    response.url().endsWith(`${copyRoot}/import/commit`),
  );
  await replace.click();
  expect((await replaceResponse).status()).toBe(200);
  const replaced = await read<SiteArchive>(`${copyRoot}/export`);
  siteArchiveSchema.parse(replaced);
  expect(replaced.site.id).toBe(copied.id);
  expect(replaced.site.name).toBe(copyName);
  expect(replaced.ports).toHaveLength(8);
  expect(replaced.connections).toHaveLength(1);
  expect(
    replaced.ports.every(
      (port) => !copyArchive.ports.some((previous) => previous.id === port.id),
    ),
  ).toBe(true);
  expect(
    replaced.ports.some(
      (port) => port.description === 'Second writer after preview',
    ),
  ).toBe(false);
  expect(await read<SiteArchive>(`${root}/export`)).toEqual(archive);
  // Replacement returns a newer root version; the app must use it immediately in site editing.
  await expect(
    page.getByRole('button', { name: 'Edit site', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Edit site', exact: true }).click();
  await page
    .getByRole('textbox', { name: /^Notes/ })
    .fill('Edited immediately after import');
  const siteSave = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1${copyRoot}`) &&
      response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await siteSave).status()).toBe(200);
  await expect(page.getByText('Site updated.', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // A server-invalidated session must remove private archive text and preview state.
  await openTransfer(copied.id);
  await upload(downloaded);
  await page
    .getByRole('textbox', { name: 'Imported site name', exact: true })
    .fill(`Unsaved ${unique}`);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Import preview', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'JSON document', exact: true }),
  ).toHaveValue(JSON.stringify(downloaded));
  const currentSession = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: { Origin: origin, 'x-csrf-token': currentSession.csrfToken },
    data: {},
  });
  expect(logout.status()).toBe(204);
  const rejectedPreview = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${copyRoot}/import/preview`) &&
      [401, 403].includes(response.status()),
  );
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await rejectedPreview;
  await expect(
    page.getByRole('heading', { name: 'Sign in to PortFolio.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'Unsaved configuration changes were not saved.',
  );
  await expect(
    page.getByRole('textbox', { name: 'JSON document', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Import preview', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(copied.name, { exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Preserve this cable');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Sign in to PortFolio.', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'JSON document', exact: true }),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(
    consoleErrors.filter(
      (error) =>
        !(
          /\/import\/(preview|commit)$/.test(error.url) &&
          /Failed to load resource: the server responded with a status of (401|403|409)\b/.test(
            error.text,
          )
        ),
    ),
  ).toEqual([]);
});
