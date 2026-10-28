import { sidebarAction } from './sidebar-actions.js';
import { expect, test, type Page } from '@playwright/test';
import type { Device, Port, Vlan } from '../../packages/shared/src/index.js';

const username = 'test-admin';
const password = 'Example-only-password-42';

async function signIn(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('secure account and workspace/site lifecycle persists across browsers', async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('PortFolio — Visual Network Documentation');
  await expect(
    page.getByText('Visual Network Documentation', { exact: true }),
  ).toBeVisible();
  const setupStatus = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  if (setupStatus.setupRequired) {
    await expect(
      page.getByRole('heading', { name: 'Set up your local account.' }),
    ).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page
      .getByRole('button', { name: 'Create administrator account' })
      .click();
    expect(
      await page
        .getByLabel('Password', { exact: true })
        .evaluate((element) => (element as HTMLInputElement).validity.tooShort),
    ).toBe(true);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page
      .getByRole('button', { name: 'Create administrator account' })
      .click();
  } else {
    await signIn(page);
  }
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in to PortFolio.' }),
  ).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await signIn(page);

  const workspaceName = `${testInfo.project.name} workspace`;
  const siteName = `${testInfo.project.name} lab`;
  await sidebarAction(page, 'Add workspace');
  await page.getByLabel('Workspace name').fill('   ');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('non-space');
  await page.getByLabel('Workspace name').fill(workspaceName);
  await page.getByLabel('Description').fill('Synthetic browser test workspace');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByText('Workspace created.', { exact: true }),
  ).toBeVisible();
  await page
    .locator('.breadcrumbs')
    .getByRole('button', { name: 'Workspaces', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: `Edit workspace ${workspaceName}`,
      exact: true,
    })
    .click();
  await page.getByLabel('Description').fill('Updated synthetic description');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText('Workspace updated.', { exact: true }),
  ).toBeVisible();
  await page.locator('.entity-link').filter({ hasText: workspaceName }).click();
  await expect(
    page
      .getByRole('main')
      .getByText('No sites configured yet.', { exact: true }),
  ).toBeVisible();
  await sidebarAction(page, `Add site in ${workspaceName}`);
  await page.getByLabel('Site name').fill(siteName);
  await page.getByLabel('Description').fill('A site with no rack or subnet');
  await page.getByLabel('Notes').fill('<script>window.untrusted=true</script>');
  await page.getByRole('button', { name: 'Create site', exact: true }).click();
  await expect(page.getByText('Site created.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: siteName, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Visual Overview');
  await expect(
    page.getByText('No equipment configured yet.', { exact: true }),
  ).toBeVisible();
  const siteUrl = page.url();
  const siteId = new URL(siteUrl).pathname.split('/').at(-1)!;
  async function write<T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    data: unknown,
  ): Promise<T> {
    const session = await (
      await page.request.get('/api/v1/auth/session')
    ).json();
    const response = await page.request.fetch(`/api/v1${path}`, {
      method,
      headers: {
        'x-csrf-token': session.csrfToken,
        Origin: new URL(siteUrl).origin,
      },
      data,
    });
    expect(
      response.ok(),
      `${method} ${path} returned ${response.status()}`,
    ).toBe(true);
    return response.status() === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  const { device } = await write<{ device: Device }>(
    'POST',
    `/sites/${siteId}/devices`,
    {
      displayName: 'Example router',
      type: 'router',
      manufacturer: 'Example',
      model: 'Eight-port router',
    },
  );
  const generated = await write<{ ports: Port[]; device: Device }>(
    'POST',
    `/sites/${siteId}/devices/${device.id}/ports/generate`,
    { count: 8, kind: 'rj45', rowVersion: device.rowVersion },
  );
  const { vlan: vlan20 } = await write<{ vlan: Vlan }>(
    'POST',
    `/sites/${siteId}/vlans`,
    { vlanId: 20, name: 'Servers', color: '#428deb' },
  );
  const { vlan: vlan30 } = await write<{ vlan: Vlan }>(
    'POST',
    `/sites/${siteId}/vlans`,
    { vlanId: 30, name: 'Clients', color: '#e5be36' },
  );
  await write('PATCH', `/sites/${siteId}/ports/${generated.ports[0]!.id}`, {
    rowVersion: 1,
    mode: 'access',
    nativeVlanRef: vlan20.id,
    pvid: 20,
  });
  await write('PATCH', `/sites/${siteId}/ports/${generated.ports[1]!.id}`, {
    rowVersion: 1,
    mode: 'routed',
    pvid: 4092,
    description: 'WAN configuration documented manually',
  });
  await write('PATCH', `/sites/${siteId}/ports/${generated.ports[2]!.id}`, {
    rowVersion: 1,
    mode: 'trunk',
    nativeVlanRef: vlan20.id,
    taggedVlanRefs: [vlan30.id],
  });
  await page.getByRole('button', { name: 'Refresh equipment' }).click();
  await expect(
    page.getByRole('heading', { name: 'Example router', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('8 documented ports', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('8 RJ45', { exact: true })).toBeVisible();
  await expect(
    page.getByText('1 routed/WAN interface', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('No equipment configured yet.', { exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: siteName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('<script>window.untrusted=true</script>', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Example router', exact: true }),
  ).toBeVisible();
  const storedPorts = (await (
    await page.request.get(`/api/v1/sites/${siteId}/devices/${device.id}/ports`)
  ).json()) as { ports: Port[] };
  expect(storedPorts.ports[0]).toMatchObject({
    mode: 'access',
    nativeVlanRef: vlan20.id,
    pvid: 20,
    taggedVlanRefs: [],
  });
  expect(storedPorts.ports[1]).toMatchObject({
    mode: 'routed',
    nativeVlanRef: null,
    pvid: 4092,
    taggedVlanRefs: [],
  });
  expect(storedPorts.ports[2]).toMatchObject({
    mode: 'trunk',
    nativeVlanRef: vlan20.id,
    taggedVlanRefs: [vlan30.id],
  });

  expect(await page.evaluate(() => 'untrusted' in window)).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('site-visual.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'Edit site', exact: true }).click();
  await page.getByLabel('Description').fill('Keep these unsaved fields');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .locator('.breadcrumbs')
    .getByRole('button', { name: 'Workspaces', exact: true })
    .click();
  await expect(page.getByLabel('Description')).toHaveValue(
    'Keep these unsaved fields',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  const secondContext = await browser.newContext();
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.goto(siteUrl);
    await signIn(secondPage);
    await expect(
      secondPage.getByRole('heading', { name: 'Example router', exact: true }),
    ).toBeVisible();
    await expect(
      secondPage.getByText('8 documented ports', { exact: true }),
    ).toBeVisible();
    await expect(
      secondPage.getByRole('heading', { name: siteName, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit site', exact: true }).click();
    await secondPage
      .getByRole('button', { name: 'Edit site', exact: true })
      .click();
    await secondPage.getByLabel('Site name').fill(`${siteName} updated`);
    await secondPage.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      secondPage.getByRole('heading', {
        name: `${siteName} updated`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel('Description').fill('Stale update');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toContainText('latest records');
    await expect(page.getByLabel('Description')).toHaveValue('Stale update');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Load latest version' }).click();
    await expect(page.getByLabel('Site name')).toHaveValue(
      `${siteName} updated`,
    );
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: `${siteName} updated`, exact: true }),
    ).toBeVisible();
  } finally {
    await secondContext.close();
  }

  async function read<T>(path: string): Promise<T> {
    const response = await page.request.get(`/api/v1${path}`);
    expect(response.status(), path).toBe(200);
    return response.json() as Promise<T>;
  }
  const currentSite = (
    await read<{ site: { workspaceId: string } }>(`/sites/${siteId}`)
  ).site;
  const workspaceId = currentSite.workspaceId;
  const isolatedWorkspace = (
    await write<{ workspace: { id: string } }>('POST', '/workspaces', {
      name: `${workspaceName} isolated`,
    })
  ).workspace;
  const isolatedSite = (
    await write<{ site: { id: string } }>(
      'POST',
      `/workspaces/${isolatedWorkspace.id}/sites`,
      { name: 'Retained isolated site' },
    )
  ).site;
  const isolatedDevice = (
    await write<{ device: Device }>(
      'POST',
      `/sites/${isolatedSite.id}/devices`,
      { displayName: 'Retained isolated router', type: 'router' },
    )
  ).device;
  await write(
    'POST',
    `/sites/${isolatedSite.id}/devices/${isolatedDevice.id}/ports/generate`,
    { count: 1, rowVersion: isolatedDevice.rowVersion },
  );
  const isolatedBefore = await read(`/sites/${isolatedSite.id}/export`);

  const rack = (
    await write<{ rack: { id: string } }>('POST', `/sites/${siteId}/racks`, {
      name: 'Cascade rack',
    })
  ).rack;
  const subnet = (
    await write<{ subnet: { id: string } }>(
      'POST',
      `/sites/${siteId}/subnets`,
      { cidr: '192.0.2.0/24', vlanRef: vlan20.id },
    )
  ).subnet;
  await write('POST', `/sites/${siteId}/subnets/${subnet.id}/dhcp-scopes`, {
    startIp: '192.0.2.10',
    endIp: '192.0.2.20',
  });
  const field = (
    await write<{ field: { id: string } }>(
      'POST',
      `/sites/${siteId}/port-fields`,
      { key: 'cascade_note', title: 'Cascade note', valueType: 'text' },
    )
  ).field;
  const peerDevice = (
    await write<{ device: Device }>('POST', `/sites/${siteId}/devices`, {
      displayName: 'Cascade peer',
      type: 'switch',
      rackId: rack.id,
    })
  ).device;
  const peerPorts = (
    await write<{ ports: Port[] }>(
      'POST',
      `/sites/${siteId}/devices/${peerDevice.id}/ports/generate`,
      { count: 1, rowVersion: peerDevice.rowVersion },
    )
  ).ports;
  const currentPorts = (
    await read<{ ports: Port[] }>(`/sites/${siteId}/devices/${device.id}/ports`)
  ).ports;
  await write('POST', `/sites/${siteId}/ports/bulk-edit`, {
    updates: [
      {
        portId: currentPorts[0]!.id,
        rowVersion: currentPorts[0]!.rowVersion,
        changes: {},
        customValues: { [field.id]: 'Delete this nested value' },
      },
    ],
  });
  const linkedPort = (
    await read<{ port: Port }>(`/sites/${siteId}/ports/${currentPorts[0]!.id}`)
  ).port;
  await write('POST', `/sites/${siteId}/connections`, {
    endpointAPortId: linkedPort.id,
    endpointBPortId: peerPorts[0]!.id,
    endpointARowVersion: linkedPort.rowVersion,
    endpointBRowVersion: peerPorts[0]!.rowVersion,
  });
  const populatedBefore = await read(`/sites/${siteId}/export`);
  await page
    .locator('.breadcrumbs')
    .getByRole('button', { name: workspaceName, exact: true })
    .click();
  const siteDelete = page.getByRole('button', {
    name: `Delete site ${siteName} updated`,
    exact: true,
  });
  const deletionRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletionRequests.push(request.url());
  });
  let deletionMessage = '';
  const siteDeleteDialog = page.waitForEvent('dialog');
  page.once('dialog', async (dialog) => {
    deletionMessage = dialog.message();
    await dialog.dismiss();
  });
  await siteDelete.click();
  await siteDeleteDialog;
  expect(deletionMessage).toContain(`${siteName} updated`);
  expect(deletionMessage).toMatch(/2\s+devices?|devices?\s*:\s*2/i);
  expect(deletionMessage).toMatch(/9\s+ports?|ports?\s*:\s*9/i);
  for (const [label, count] of [
    ['Sites', 1],
    ['Devices', 2],
    ['Ports', 9],
    ['VLANs', 2],
    ['Racks', 1],
    ['Subnets', 1],
    ['DHCP scopes', 1],
    ['Custom fields', 1],
    ['Custom values', 1],
    ['Physical connections', 1],
  ] as const)
    expect(deletionMessage).toMatch(new RegExp(`${label}: ${count}(?:\\n|$)`));
  expect(deletionRequests).toHaveLength(0);
  expect(await read(`/sites/${siteId}/export`)).toEqual(populatedBefore);
  expect(await read(`/sites/${isolatedSite.id}/export`)).toEqual(
    isolatedBefore,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await siteDelete.click();
  await expect(page.getByText('Site deleted.', { exact: true })).toBeVisible();
  expect(deletionRequests).toHaveLength(1);
  for (const path of [
    `/sites/${siteId}`,
    `/sites/${siteId}/devices/${device.id}`,
    `/sites/${siteId}/ports/${linkedPort.id}`,
  ])
    expect((await page.request.get(`/api/v1${path}`)).status()).toBe(404);

  const nestedSites: { id: string; deviceId: string; portId: string }[] = [];
  for (let index = 1; index <= 2; index++) {
    const nested = (
      await write<{ site: { id: string } }>(
        'POST',
        `/workspaces/${workspaceId}/sites`,
        { name: `Cascade child ${index}` },
      )
    ).site;
    const nestedDevice = (
      await write<{ device: Device }>('POST', `/sites/${nested.id}/devices`, {
        displayName: 'Nested switch',
        type: 'switch',
      })
    ).device;
    const nestedPorts = (
      await write<{ ports: Port[] }>(
        'POST',
        `/sites/${nested.id}/devices/${nestedDevice.id}/ports/generate`,
        { count: 2, rowVersion: nestedDevice.rowVersion },
      )
    ).ports;
    await write('POST', `/sites/${nested.id}/vlans`, {
      vlanId: 20,
      name: 'Nested VLAN',
    });
    await write('POST', `/sites/${nested.id}/connections`, {
      endpointAPortId: nestedPorts[0]!.id,
      endpointBPortId: nestedPorts[1]!.id,
      endpointARowVersion: nestedPorts[0]!.rowVersion,
      endpointBRowVersion: nestedPorts[1]!.rowVersion,
    });
    nestedSites.push({
      id: nested.id,
      deviceId: nestedDevice.id,
      portId: nestedPorts[0]!.id,
    });
  }
  const nestedBefore = await Promise.all(
    nestedSites.map((site) => read(`/sites/${site.id}/export`)),
  );
  await page
    .locator('.breadcrumbs')
    .getByRole('button', { name: 'Workspaces', exact: true })
    .click();
  const workspaceDelete = page.getByRole('button', {
    name: `Delete workspace ${workspaceName}`,
    exact: true,
  });
  const workspaceDeleteDialog = page.waitForEvent('dialog');
  page.once('dialog', async (dialog) => {
    deletionMessage = dialog.message();
    await dialog.dismiss();
  });
  await workspaceDelete.click();
  await workspaceDeleteDialog;
  expect(deletionMessage).toContain(workspaceName);
  expect(deletionMessage).toMatch(/2\s+sites?|sites?\s*:\s*2/i);
  expect(deletionMessage).toMatch(/4\s+ports?|ports?\s*:\s*4/i);
  for (const [label, count] of [
    ['Sites', 2],
    ['Devices', 2],
    ['Ports', 4],
    ['VLANs', 2],
    ['Racks', 0],
    ['Subnets', 0],
    ['DHCP scopes', 0],
    ['Custom fields', 0],
    ['Custom values', 0],
    ['Physical connections', 2],
  ] as const)
    expect(deletionMessage).toMatch(new RegExp(`${label}: ${count}(?:\\n|$)`));
  expect(deletionRequests).toHaveLength(1);
  expect(
    await Promise.all(
      nestedSites.map((site) => read(`/sites/${site.id}/export`)),
    ),
  ).toEqual(nestedBefore);
  await expect(
    page.getByRole('button', {
      name: `Delete workspace ${workspaceName}`,
      exact: true,
    }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await workspaceDelete.click();
  await expect(
    page.getByText('Workspace deleted.', { exact: true }),
  ).toBeVisible();
  expect(deletionRequests).toHaveLength(2);
  expect(
    (await page.request.get(`/api/v1/workspaces/${workspaceId}`)).status(),
  ).toBe(404);
  for (const nested of nestedSites) {
    for (const path of [
      `/sites/${nested.id}`,
      `/sites/${nested.id}/devices/${nested.deviceId}`,
      `/sites/${nested.id}/ports/${nested.portId}`,
    ])
      expect((await page.request.get(`/api/v1${path}`)).status()).toBe(404);
  }
  expect(await read(`/sites/${isolatedSite.id}/export`)).toEqual(
    isolatedBefore,
  );
  await expect(
    page
      .locator('.entity-link')
      .filter({ hasText: `${workspaceName} isolated` }),
  ).toBeVisible();
  const currentSession = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: {
      'x-csrf-token': currentSession.csrfToken,
      Origin: new URL(page.url()).origin,
    },
    data: {},
  });
  expect(logout.status()).toBe(204);
  const anonymousSession = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/session') &&
      response.status() === 200,
  );
  await sidebarAction(page, 'Add workspace');
  await anonymousSession;
  await expect(
    page.getByRole('heading', { name: 'Sign in to PortFolio.' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('session ended');
  await expect(
    page.getByRole('heading', { name: 'Workspaces', exact: true }),
  ).not.toBeVisible();
  await signIn(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in to PortFolio.' }),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await page.getByRole('link', { name: 'Skip to content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  expect(errors).toEqual([]);
});
