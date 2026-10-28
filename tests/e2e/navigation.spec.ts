import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  openSidebar,
  sidebarAction,
  sidebarNavigate,
} from './sidebar-actions.js';
import type {
  Device,
  Port,
  Site,
  SiteArchive,
  Workspace,
} from '../../packages/shared/src/index.js';

test.use({ actionTimeout: 15_000 });
test('persistent context navigation, template snapshots and physical/logical connections', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = new URL(baseURL!).origin,
    unique = `${testInfo.project.name} ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  const setup = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  await page.getByLabel('Username', { exact: true }).fill('navigation-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-navigation-password-42');
  await page
    .getByRole('button', {
      name: setup.setupRequired ? 'Create administrator account' : 'Sign in',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  async function read<T>(path: string): Promise<T> {
    const response = await page.request.get(`/api/v1${path}`);
    expect(response.status(), path).toBe(200);
    return response.json() as Promise<T>;
  }
  async function write<T>(path: string, data: unknown): Promise<T> {
    const response = await page.request.post(`/api/v1${path}`, {
      headers: { Origin: origin, 'x-csrf-token': session.csrfToken },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<T>;
  }
  const nav = page.getByRole('navigation', {
    name: 'Workspace navigation',
    exact: true,
  });
  const current = page.locator('.sidebar-panel a[aria-current="location"]');
  const categories = [
    'Visual Overview',
    'Equipment',
    'VLANs',
    'Networks & Subnets',
    'Connections',
    'Racks',
    'Templates',
    'Import & Export',
  ];
  async function openTreeSite(
    target: Site,
    parentName: string,
    keyboard = false,
  ) {
    await openSidebar(page);
    const link = nav.getByRole('link', {
      name: `Open site ${target.name} in ${parentName}`,
      exact: true,
    });
    if (keyboard) {
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
    } else await link.click();
    await expect(page).toHaveURL(`${origin}/sites/${target.id}`);
    await expect(current).toHaveText('Visual Overview');
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    if (await toggle.isVisible())
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
  await page.screenshot({
    path: testInfo.outputPath('navigation-empty-root.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const workspaceName = `Workflow ${unique}`;
  await sidebarAction(page, 'Add workspace');
  await page.getByLabel('Workspace name', { exact: true }).fill(workspaceName);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByText('Workspace created.', { exact: true }),
  ).toBeVisible();
  const workspace = (
    await read<{ workspaces: Workspace[] }>('/workspaces')
  ).workspaces.find((item) => item.name === workspaceName)!;
  await sidebarAction(page, `Add site in ${workspaceName}`);
  const siteName = `Site ${unique}`;
  await page.getByLabel('Site name', { exact: true }).fill(siteName);
  await page.getByRole('button', { name: 'Create site', exact: true }).click();
  await expect(page.getByText('Site created.', { exact: true })).toBeVisible();
  const site = (
    await read<{ sites: Site[] }>(`/workspaces/${workspace.id}/sites`)
  ).sites.find((item) => item.name === siteName)!;
  await expect(page).toHaveURL(`${origin}/sites/${site.id}`);
  await expect(current).toHaveText('Visual Overview');
  await openSidebar(page);
  await expect(nav.getByRole('combobox')).toHaveCount(0);
  const searchBounds = await nav
    .getByRole('searchbox', { name: 'Search navigation', exact: true })
    .boundingBox();
  const workspaceBounds = await nav
    .getByRole('button', { name: 'Manage workspaces', exact: true })
    .boundingBox();
  expect(searchBounds!.y + searchBounds!.height).toBeLessThan(
    workspaceBounds!.y,
  );
  await expect(
    nav.getByRole('button', {
      name: `Collapse workspace ${workspaceName}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    nav.getByRole('link', {
      name: `Open site ${siteName} in ${workspaceName}`,
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(
    nav.getByRole('button', { name: /Expand site|Collapse site/ }),
  ).toHaveCount(0);
  for (const name of categories)
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'Global Settings', exact: true }),
  ).toBeVisible();
  if (testInfo.project.name.startsWith('desktop'))
    for (const name of [...categories, 'Global Settings'])
      await expect(
        nav.getByRole('link', { name, exact: true }),
      ).toBeInViewport();
  await nav
    .getByRole('button', {
      name: `Collapse workspace ${workspaceName}`,
      exact: true,
    })
    .click();
  await expect(
    nav.getByRole('link', {
      name: `Open site ${siteName} in ${workspaceName}`,
      exact: true,
    }),
  ).not.toBeVisible();
  await sidebarNavigate(page, 'VLANs');
  await expect(current).toHaveText('VLANs');
  await openSidebar(page);
  await expect(
    nav.getByRole('button', {
      name: `Expand workspace ${workspaceName}`,
      exact: true,
    }),
  ).toBeVisible();
  for (const name of categories)
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await nav
    .getByRole('button', {
      name: `Expand workspace ${workspaceName}`,
      exact: true,
    })
    .click();
  await openTreeSite(site, workspaceName, true);
  const otherWorkspace = (
    await write<{ workspace: Workspace }>('/workspaces', {
      name: `Other ${unique}`,
    })
  ).workspace;
  const otherSite = (
    await write<{ site: Site }>(`/workspaces/${otherWorkspace.id}/sites`, {
      name: `Other site ${unique}`,
    })
  ).site;
  const emptyWorkspace = (
    await write<{ workspace: Workspace }>('/workspaces', {
      name: `Empty ${unique}`,
    })
  ).workspace;
  await page.reload();
  await openSidebar(page);
  for (const item of [workspace, otherWorkspace, emptyWorkspace])
    await expect(
      nav.getByRole('button', {
        name: `Collapse workspace ${item.name}`,
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    nav.getByRole('link', {
      name: `Open site ${otherSite.name} in ${otherWorkspace.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await sidebarNavigate(page, `Open workspace ${emptyWorkspace.name}`);
  await expect(page).toHaveURL(`${origin}/workspaces/${emptyWorkspace.id}`);
  await expect(
    page
      .getByRole('main')
      .getByText('No sites configured yet.', { exact: true }),
  ).toBeVisible();
  await openSidebar(page);
  await expect(
    nav.getByRole('link', { name: 'Equipment', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  await expect(
    nav.getByRole('button', { name: 'Add device', exact: true }),
  ).toBeDisabled();
  await expect(
    nav.locator('a[aria-label^="Open site "][aria-current="true"]'),
  ).toHaveCount(0);
  await openTreeSite(site, workspaceName);
  await openSidebar(page);
  await nav
    .getByRole('button', {
      name: `Collapse workspace ${workspaceName}`,
      exact: true,
    })
    .click();
  await sidebarAction(page, `Add site in ${otherWorkspace.name}`);
  const parentSiteName = `Correct parent ${unique}`;
  await page.getByLabel('Site name', { exact: true }).fill(parentSiteName);
  await page.getByRole('button', { name: 'Create site', exact: true }).click();
  await expect(page.getByText('Site created.', { exact: true })).toBeVisible();
  const sibling = (
    await read<{ sites: Site[] }>(`/workspaces/${otherWorkspace.id}/sites`)
  ).sites.find((item) => item.name === parentSiteName)!;
  expect(sibling.workspaceId).toBe(otherWorkspace.id);
  expect(
    (await read<{ sites: Site[] }>(`/workspaces/${workspace.id}/sites`)).sites,
  ).toHaveLength(1);
  await openSidebar(page);
  await expect(
    nav.getByRole('button', {
      name: `Expand workspace ${workspaceName}`,
      exact: true,
    }),
  ).toBeVisible();
  await nav
    .getByRole('button', {
      name: `Expand workspace ${workspaceName}`,
      exact: true,
    })
    .click();
  await openTreeSite(otherSite, otherWorkspace.name);
  await openTreeSite(site, workspaceName, true);
  for (const [action, field] of [
    ['Add VLAN', 'VLAN ID'],
    ['Add subnet', 'IPv4 network CIDR'],
    ['Add rack', 'Rack name'],
  ] as const) {
    await sidebarAction(page, action);
    await expect(page.getByLabel(field, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel(field, { exact: true })).toHaveCount(0);
  }
  await sidebarNavigate(page, 'VLANs');
  await expect(current).toHaveText('VLANs');
  await sidebarNavigate(page, 'Networks & Subnets');
  await expect(current).toHaveText('Networks & Subnets');
  await page.goBack();
  await expect(current).toHaveText('VLANs');
  await page.goForward();
  await expect(current).toHaveText('Networks & Subnets');
  await sidebarNavigate(page, 'Equipment');
  await expect(
    page.getByRole('combobox', { name: 'Device', exact: true }),
  ).toHaveValue('');
  await sidebarAction(page, 'Add device');
  for (const name of [
    'Router',
    'Switch',
    'Firewall',
    'Wireless access point',
    'Server',
    'Custom device',
  ])
    await expect(
      page.getByRole('button', { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await page.getByRole('button', { name: /^Switch/ }).click();
  await page.getByLabel('Device name', { exact: true }).fill('Workflow switch');
  await page.getByLabel('Group 1 port count', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Add port group', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Group 2 connector', exact: true })
    .selectOption('sfp_plus');
  await page
    .getByRole('combobox', { name: 'Group 2 face', exact: true })
    .selectOption('rear');
  await page
    .getByRole('button', { name: 'Create device', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Ports · Workflow switch', exact: true }),
  ).toBeVisible();
  const root = `/sites/${site.id}`;
  const switchDevice = (
    await read<{ devices: Device[] }>(`${root}/devices`)
  ).devices.find((item) => item.displayName === 'Workflow switch')!;
  const switchPorts = (
    await read<{ ports: Port[] }>(`${root}/devices/${switchDevice.id}/ports`)
  ).ports;
  expect(switchPorts).toHaveLength(3);
  expect(switchPorts.filter((port) => port.face === 'rear')).toHaveLength(1);
  expect(switchPorts.find((port) => port.face === 'rear')!.kind).toBe(
    'sfp_plus',
  );
  expect(switchPorts.every((port) => port.siteId === site.id)).toBe(true);
  const description = page.getByLabel('Port 1 Description/Notes', {
    exact: true,
  });
  await description.fill('Unsaved context draft');
  const dirtyUrl = page.url();
  await openSidebar(page);
  const declined = page.waitForEvent('dialog');
  page.once('dialog', (dialog) => dialog.dismiss());
  await nav
    .getByRole('link', {
      name: `Open site ${otherSite.name} in ${otherWorkspace.name}`,
      exact: true,
    })
    .click();
  await declined;
  await expect(page).toHaveURL(dirtyUrl);
  await expect(description).toHaveValue('Unsaved context draft');
  await expect(
    nav.getByRole('link', {
      name: `Open site ${site.name} in ${workspace.name}`,
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'true');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await description.press('Escape');
  await sidebarAction(page, 'Create template');
  const templateName = `Reusable ${unique}`;
  await page.getByLabel('Template name', { exact: true }).fill(templateName);
  await page
    .getByRole('button', { name: 'Add port group', exact: true })
    .click();
  await page.getByLabel('Group 1 port count', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save template', exact: true })
    .click();
  await expect(
    page.getByText('Template saved.', { exact: true }),
  ).toBeVisible();
  await sidebarAction(page, 'Add device');
  await page
    .getByRole('button', { name: new RegExp(`^${templateName}`) })
    .click();
  await page.getByLabel('Device name', { exact: true }).fill('Snapshot device');
  await page
    .getByRole('button', { name: 'Create device', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Ports · Snapshot device', exact: true }),
  ).toBeVisible();
  const snapshotDevice = (
    await read<{ devices: Device[] }>(`${root}/devices`)
  ).devices.find((item) => item.displayName === 'Snapshot device')!;
  const snapshotPorts = (
    await read<{ ports: Port[] }>(`${root}/devices/${snapshotDevice.id}/ports`)
  ).ports;
  expect(snapshotPorts).toHaveLength(2);
  await sidebarNavigate(page, 'Templates');
  await page
    .getByRole('button', { name: `Edit template ${templateName}`, exact: true })
    .click();
  await page.getByLabel('Group 1 port count', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Save template', exact: true })
    .click();
  await expect(
    page.getByText('Template saved.', { exact: true }),
  ).toBeVisible();
  expect(
    (
      await read<{ ports: Port[] }>(
        `${root}/devices/${snapshotDevice.id}/ports`,
      )
    ).ports,
  ).toHaveLength(2);
  await page
    .getByRole('button', { name: `Copy template ${templateName}`, exact: true })
    .click();
  const copyName = `${templateName} copy`;
  await page.getByLabel('Template name', { exact: true }).fill(copyName);
  await page
    .getByRole('button', { name: 'Save template', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: `Edit template ${copyName}`,
      exact: true,
    }),
  ).toBeVisible();
  const copiedTemplates = (
    await read<{ templates: { name: string; groups: { count: number }[] }[] }>(
      '/device-templates',
    )
  ).templates;
  expect(
    copiedTemplates.find((template) => template.name === copyName)!.groups[0]!
      .count,
  ).toBe(4);
  await page
    .getByRole('button', { name: `Edit template ${templateName}`, exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', {
      name: `Delete template ${templateName}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('region', { name: 'Edit template', exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await read<{ ports: Port[] }>(
        `${root}/devices/${snapshotDevice.id}/ports`,
      )
    ).ports,
  ).toHaveLength(2);
  await sidebarAction(page, 'Add connection');
  await page
    .getByRole('combobox', { name: 'Endpoint A device', exact: true })
    .selectOption(switchDevice.id);
  await page
    .getByRole('combobox', { name: 'Endpoint B device', exact: true })
    .selectOption(snapshotDevice.id);
  await page
    .getByRole('combobox', { name: 'Endpoint A port', exact: true })
    .selectOption(switchPorts[0]!.id);
  await page
    .getByRole('combobox', { name: 'Endpoint B port', exact: true })
    .selectOption(snapshotPorts[0]!.id);
  await page.getByLabel('Cable type', { exact: true }).fill('Synthetic Cat6');
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Connection management', exact: true }),
  ).toContainText('Synthetic Cat6');
  await sidebarAction(page, 'Add connection');
  await page
    .getByRole('button', { name: 'Logical relationship', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Endpoint A device', exact: true })
    .selectOption(switchDevice.id);
  await page
    .getByRole('combobox', { name: 'Endpoint B device', exact: true })
    .selectOption(snapshotDevice.id);
  await page
    .getByLabel('Connection name (optional)', { exact: true })
    .fill('Documented adjacency');
  await page
    .getByLabel('Protocol (optional)', { exact: true })
    .fill('Synthetic protocol');
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click();
  await expect(
    page.getByText('Connection saved.', { exact: true }),
  ).toBeVisible();
  const archive = await read<SiteArchive>(`${root}/export`);
  expect(archive.devices).toHaveLength(2);
  expect(archive.ports).toHaveLength(5);
  expect(archive.connections).toHaveLength(1);
  expect(archive.logicalConnections).toHaveLength(1);
  expect(
    (await read<{ devices: Device[] }>(`/sites/${otherSite.id}/devices`))
      .devices,
  ).toHaveLength(0);
  await sidebarNavigate(page, 'Import & Export');
  await page
    .getByRole('textbox', { name: 'JSON document', exact: true })
    .fill(JSON.stringify(archive));
  const fullCopyName = `Full copy ${unique}`;
  await page
    .getByRole('textbox', { name: 'Imported site name', exact: true })
    .fill(fullCopyName);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Import as new site', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Open imported site', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit site', exact: true }),
  ).toBeEnabled();
  const fullCopy = (
    await read<{ sites: Site[] }>(`/workspaces/${workspace.id}/sites`)
  ).sites.find((item) => item.name === fullCopyName)!;
  const fullCopyArchive = await read<SiteArchive>(
    `/sites/${fullCopy.id}/export`,
  );
  expect(fullCopyArchive.connections).toHaveLength(1);
  expect(fullCopyArchive.logicalConnections).toHaveLength(1);
  expect(fullCopyArchive.logicalConnections[0]!.endpointADeviceId).not.toBe(
    archive.logicalConnections[0]!.endpointADeviceId,
  );
  const { logicalConnections: _logical, ...legacyArchive } = archive;
  void _logical;
  await page
    .getByRole('textbox', { name: 'JSON document', exact: true })
    .fill(JSON.stringify(legacyArchive));
  await page
    .getByRole('textbox', { name: 'Imported site name', exact: true })
    .fill(`Legacy copy ${unique}`);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Import as new site', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Open imported site', exact: true }),
  ).toBeVisible();
  const imported = (
    await read<{ sites: Site[] }>(`/workspaces/${workspace.id}/sites`)
  ).sites.find((item) => item.name === `Legacy copy ${unique}`)!;
  const importedArchive = await read<SiteArchive>(
    `/sites/${imported.id}/export`,
  );
  expect(importedArchive.connections).toHaveLength(1);
  expect(importedArchive.logicalConnections).toHaveLength(0);
  await expect(
    page.getByRole('button', { name: 'Edit site', exact: true }),
  ).toBeEnabled();
  await openTreeSite(imported, workspaceName);
  await page.reload();
  await expect(current).toHaveText('Visual Overview');
  await expect(page.locator('button[data-port-id]')).toHaveCount(5);
  await page.screenshot({
    path: testInfo.outputPath('navigation-equipment.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await openSidebar(page);
  const treeScroll = nav.locator('.workspace-tree-scroll');
  const equipmentY = await nav
    .getByRole('link', { name: 'Equipment', exact: true })
    .evaluate((element) => element.getBoundingClientRect().y);
  await treeScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(
    await treeScroll.evaluate(
      (element) =>
        element.scrollHeight > element.clientHeight && element.scrollTop > 0,
    ),
  ).toBe(true);
  expect(
    await nav
      .getByRole('link', { name: 'Equipment', exact: true })
      .evaluate((element) => element.getBoundingClientRect().y),
  ).toBe(equipmentY);
  await expect(nav.locator('.site-tools-heading')).toContainText(imported.name);
  await treeScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  if (testInfo.project.name.startsWith('desktop')) {
    for (const name of [...categories, 'Global Settings'])
      await expect(nav.getByRole('link', { name, exact: true })).toBeInViewport(
        { ratio: 1 },
      );
  }
  await nav
    .getByRole('link', {
      name: `Open site ${imported.name} in ${workspaceName}`,
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('navigation-sidebar.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // Management is directly beside each selector, including from a selected site.
  await sidebarAction(page, 'Manage sites');
  await expect(page).toHaveURL(`${origin}/workspaces/${workspace.id}`);
  await expect(
    page.getByRole('button', {
      name: `Delete site ${imported.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await sidebarAction(page, 'Manage workspaces');
  await expect(page).toHaveURL(`${origin}/`);
  const deleteWorkspace = page.getByRole('button', {
    name: `Delete workspace ${workspaceName}`,
    exact: true,
  });
  await expect(deleteWorkspace).toBeVisible();
  let workspaceDeletes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname === `/api/v1/workspaces/${workspace.id}`
    )
      workspaceDeletes++;
  });
  page.once('dialog', (dialog) => dialog.dismiss());
  await deleteWorkspace.click();
  await expect(deleteWorkspace).toBeEnabled();
  expect(workspaceDeletes).toBe(0);
  await expect(deleteWorkspace).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('everything below it');
    await dialog.accept();
  });
  await deleteWorkspace.click();
  await expect(deleteWorkspace).toHaveCount(0);
  expect(workspaceDeletes).toBe(1);
  const remaining = await read<{ workspaces: Workspace[] }>('/workspaces');
  expect(remaining.workspaces.some((item) => item.id === workspace.id)).toBe(
    false,
  );
  expect(remaining.workspaces.length).toBeGreaterThan(0);
  await openSidebar(page);

  if (await menu.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
  }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in to PortFolio.', exact: true }),
  ).toBeVisible();
  await expect(nav).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(workspaceName);
  await expect(page.locator('body')).not.toContainText(
    remaining.workspaces[0]!.name,
  );
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
