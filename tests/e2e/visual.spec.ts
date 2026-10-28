import { sidebarNavigate } from './sidebar-actions.js';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  Connection,
  Device,
  Port,
  PortField,
  Vlan,
  Workspace,
  Site,
} from '../../packages/shared/src/index.js';

test.use({ actionTimeout: 15_000 });
const username = 'visual-admin';
const password = 'Synthetic-visual-password-42';
const deviceNames = {
  eight: 'Eight-port switch',
  twentyFour: 'Twenty-four-port switch',
  fortyEight: 'Forty-eight-port switch',
  router: 'Mixed eleven-port router',
};

async function signIn(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
}
function definition(inspector: Locator, label: string) {
  return inspector
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

test('renders canonical illustrated equipment at 8/24/48-port densities and keeps inspector, grid and order synchronized', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
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
    method: 'POST' | 'PATCH' | 'DELETE',
    data: unknown,
    expected = method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200,
  ): Promise<T> {
    const response = await page.request.fetch(`/api/v1${path}`, {
      method,
      headers: { Origin: origin, 'x-csrf-token': session.csrfToken },
      data,
    });
    expect(
      response.status(),
      `${method} ${path}: ${await response.text()}`,
    ).toBe(expected);
    return response.status() === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
  const unique = `${testInfo.project.name} ${randomUUID().slice(0, 8)}`;
  const { workspace } = await write<{ workspace: Workspace }>(
    '/workspaces',
    'POST',
    { name: `Visual workspace ${unique}` },
  );
  const { site } = await write<{ site: Site }>(
    `/workspaces/${workspace.id}/sites`,
    'POST',
    { name: `Visual lab ${unique}` },
  );
  const root = `/sites/${site.id}`;
  const siteUrl = `${origin}/sites/${site.id}`;
  const vlans: Vlan[] = [];
  for (const item of [
    { vlanId: 1, name: 'Management', color: '#31a37b' },
    { vlanId: 20, name: 'Servers', color: '#428deb' },
    { vlanId: 30, name: 'Clients', color: '#e5be36' },
  ])
    vlans.push(
      (await write<{ vlan: Vlan }>(`${root}/vlans`, 'POST', item)).vlan,
    );
  const vlan = (number: number) =>
    vlans.find((item) => item.vlanId === number)!;
  type FixtureDevice = { device: Device; ports: Port[] };
  const fixtures: Record<string, FixtureDevice> = {};
  for (const [name, count, type] of [
    [deviceNames.eight, 8, 'switch'],
    [deviceNames.twentyFour, 24, 'switch'],
    [deviceNames.fortyEight, 48, 'switch'],
    [deviceNames.router, 11, 'router'],
  ] as const) {
    const { device } = await write<{ device: Device }>(
      `${root}/devices`,
      'POST',
      {
        displayName: name,
        type,
        manufacturer: 'Synthetic equipment',
        model: `${count}-port example`,
      },
    );
    const generated = await write<{ device: Device; ports: Port[] }>(
      `${root}/devices/${device.id}/ports/generate`,
      'POST',
      { count, rowVersion: device.rowVersion },
    );
    const result = await write<{ ports: Port[] }>(
      `${root}/ports/bulk-edit`,
      'POST',
      {
        updates: generated.ports.map((port, index) => {
          const native = [1, 20, 30][index % 3]!;
          return {
            portId: port.id,
            rowVersion: port.rowVersion,
            changes: {
              mode: 'access',
              nativeVlanRef: vlan(native).id,
              pvid: native,
              speed: '1G',
              ...(count === 24 && index === 23 ? { face: 'rear' } : {}),
            },
          };
        }),
      },
      200,
    );
    fixtures[name] = {
      device: generated.device,
      ports: result.ports.sort((a, b) => a.orderIndex - b.orderIndex),
    };
  }
  const eight = fixtures[deviceNames.eight]!;
  const twentyFour = fixtures[deviceNames.twentyFour]!;
  const fortyEight = fixtures[deviceNames.fortyEight]!;
  const router = fixtures[deviceNames.router]!;
  async function patchPort(port: Port, changes: Record<string, unknown>) {
    return (
      await write<{ port: Port }>(`${root}/ports/${port.id}`, 'PATCH', {
        rowVersion: port.rowVersion,
        ...changes,
      })
    ).port;
  }
  eight.ports[0] = await patchPort(eight.ports[0]!, {
    mode: 'trunk',
    nativeVlanRef: vlan(1).id,
    pvid: 1,
    taggedVlanRefs: [vlan(20).id, vlan(30).id],
    description: '<img src=x onerror="window.visualUnsafe=1">',
    externalDestinationLabel: 'Manually documented annotation',
  });
  eight.ports[3] = await patchPort(eight.ports[3]!, {
    mode: 'disabled',
    documentedLinkState: 'down',
  });
  for (const [index, kind] of [
    [0, 'sfp_plus'],
    [1, 'sfp'],
    [2, 'qsfp'],
    [10, 'other'],
  ] as const)
    router.ports[index] = await patchPort(router.ports[index]!, {
      kind,
      ...(index === 10 ? { face: 'rear' } : {}),
    });
  router.ports[3] = await patchPort(router.ports[3]!, {
    mode: 'routed',
    nativeVlanRef: null,
    taggedVlanRefs: [],
    pvid: null,
    description: 'Documented WAN interface',
  });
  router.ports[4] = await patchPort(router.ports[4]!, {
    mode: 'trunk',
    nativeVlanRef: vlan(1).id,
    pvid: 1,
    taggedVlanRefs: [vlan(20).id, vlan(30).id],
  });
  const customFields: PortField[] = [];
  for (const field of [
    { key: 'measured_watts', title: 'Measured watts', valueType: 'number' },
    { key: 'poe_enabled', title: 'PoE enabled', valueType: 'boolean' },
  ])
    customFields.push(
      (await write<{ field: PortField }>(`${root}/port-fields`, 'POST', field))
        .field,
    );
  const customSaved = await write<{ ports: Port[] }>(
    `${root}/ports/bulk-edit`,
    'POST',
    {
      updates: [
        {
          portId: eight.ports[0]!.id,
          rowVersion: eight.ports[0]!.rowVersion,
          changes: {},
          customValues: {
            [customFields[0]!.id]: 0,
            [customFields[1]!.id]: false,
          },
        },
      ],
    },
    200,
  );
  eight.ports[0] = customSaved.ports[0]!;
  const linked = await write<{ connection: Connection; ports: Port[] }>(
    `${root}/connections`,
    'POST',
    {
      endpointAPortId: eight.ports[0]!.id,
      endpointBPortId: router.ports[4]!.id,
      endpointARowVersion: eight.ports[0]!.rowVersion,
      endpointBRowVersion: router.ports[4]!.rowVersion,
      cableType: 'Synthetic Cat6',
      notes: 'Manual cable documentation',
    },
  );
  expect(linked.ports).toHaveLength(2);

  await page.goto(siteUrl);
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Visual Overview');
  const panel = (device: Device) =>
    page.locator(`article[data-device-id="${device.id}"]`);
  const portButton = (port: Port) =>
    page.locator(`button[data-port-id="${port.id}"]`);
  for (const fixture of Object.values(fixtures))
    await expect(
      panel(fixture.device).locator('button[data-port-id]'),
    ).toHaveCount(fixture.ports.length);
  const socketDesigns: string[] = [];
  for (const fixture of [eight, twentyFour, fortyEight]) {
    const sockets = panel(fixture.device).locator('svg[data-connector="rj45"]');
    await expect(sockets).toHaveCount(fixture.ports.length);
    for (const svg of await sockets.all()) {
      await expect(svg.locator('rect[data-contact="gold"]')).toHaveCount(8);
      expect(await svg.getAttribute('viewBox')).toBe('0 0 120 112');
      socketDesigns.push(
        (await svg.locator('path[data-socket="rj45"]').getAttribute('d'))!,
      );
    }
  }
  expect(new Set(socketDesigns).size).toBe(1);
  expect(socketDesigns[0]!.length).toBeGreaterThan(20);
  expect(
    (
      await portButton(eight.ports[0]!)
        .locator('[data-vlan-border]')
        .getAttribute('stroke')
    )?.toLowerCase(),
  ).toBe(vlan(1).color);
  expect(
    (
      await portButton(eight.ports[1]!)
        .locator('[data-vlan-border]')
        .getAttribute('stroke')
    )?.toLowerCase(),
  ).toBe(vlan(20).color);
  expect(await portButton(router.ports[3]!).getAttribute('data-mode')).toBe(
    'routed',
  );
  expect(vlans.map((item) => item.color)).not.toContain(
    (
      await portButton(router.ports[3]!)
        .locator('[data-vlan-border]')
        .getAttribute('stroke')
    )?.toLowerCase(),
  );
  for (const kind of ['sfp_plus', 'sfp', 'qsfp', 'other'])
    await expect(
      panel(router.device).locator(`svg[data-connector="${kind}"]`),
    ).toHaveCount(1);
  await page
    .getByRole('combobox', { name: 'Port size', exact: true })
    .selectOption({ label: 'Compact' });
  expect(
    await portButton(fortyEight.ports[0]!)
      .locator('path[data-socket="rj45"]')
      .getAttribute('d'),
  ).toBe(socketDesigns[0]);
  for (const [count, fixture] of [
    [8, eight],
    [24, twentyFour],
    [48, fortyEight],
  ] as const) {
    await panel(fixture.device).screenshot({
      path: testInfo.outputPath(`faceplate-${count}.png`),
      animations: 'disabled',
    });
  }

  await portButton(eight.ports[0]!).click();
  const inspector = page.getByRole('complementary', {
    name: 'Port inspector',
    exact: true,
  });
  await expect(inspector).toBeVisible();
  await expect(definition(inspector, 'PVID')).toHaveText('1');
  await expect(definition(inspector, 'Tagged VLANs')).toContainText('20');
  await expect(definition(inspector, 'Tagged VLANs')).toContainText('30');
  await expect(definition(inspector, 'Measured watts')).toHaveText('0');
  await expect(definition(inspector, 'PoE enabled')).toHaveText(/false/i);
  await expect(inspector).toContainText(deviceNames.router);
  await expect(inspector).toContainText('Port 5');
  await expect(inspector).toContainText('Manually documented annotation');
  await inspector
    .getByRole('button', { name: 'Inspect connected port' })
    .click();
  await expect(
    inspector.getByRole('heading', { name: 'Port 5', exact: true }),
  ).toBeVisible();
  await expect(definition(inspector, 'Documented connection')).toContainText(
    `${deviceNames.eight} / Port 1`,
  );
  await expect(definition(inspector, 'Cable notes')).toHaveText(
    'Manual cable documentation',
  );
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(portButton(router.ports[4]!)).toBeFocused();
  expect(await page.evaluate(() => 'visualUnsafe' in window)).toBe(false);
  await portButton(eight.ports[1]!).click();
  await inspector
    .getByRole('button', { name: 'Configure this port', exact: true })
    .click();
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Equipment');
  const focusedRow = page.locator(
    `.port-grid tr[data-port-id="${eight.ports[1]!.id}"]`,
  );
  await expect(
    focusedRow.locator('td[data-column="name"] input'),
  ).toBeFocused();
  await page
    .getByLabel('Port 2 Native/Untagged VLAN', { exact: true })
    .selectOption(vlan(30).id);
  await expect(page.getByLabel('Port 2 PVID', { exact: true })).toHaveValue(
    '20',
  );
  await page
    .getByRole('button', { name: 'Save all changes', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('status')).toHaveText(
    '1 port saved.',
  );
  await expect(
    page.getByRole('button', { name: 'Edit site', exact: true }),
  ).toBeEnabled();
  await sidebarNavigate(page, 'Visual Overview');
  await expect(
    portButton(eight.ports[1]!).locator('[data-vlan-border]'),
  ).toHaveAttribute('stroke', vlan(30).color!);
  await page.reload();
  await expect(
    portButton(eight.ports[1]!).locator('[data-vlan-border]'),
  ).toHaveAttribute('stroke', vlan(30).color!);
  const updated = await write<{ vlan: Vlan }>(
    `${root}/vlans/${vlan(30).id}`,
    'PATCH',
    { color: '#d66b85', rowVersion: vlan(30).rowVersion },
  );
  await page
    .getByRole('button', { name: 'Refresh equipment', exact: true })
    .click();
  await expect(
    portButton(eight.ports[1]!).locator('[data-vlan-border]'),
  ).toHaveAttribute('stroke', updated.vlan.color!);
  await expect(
    portButton(fortyEight.ports[2]!).locator('[data-vlan-border]'),
  ).toHaveAttribute('stroke', updated.vlan.color!);

  await page.keyboard.press('Tab');
  await portButton(fortyEight.ports.at(-1)!).focus();
  await expect(portButton(fortyEight.ports.at(-1)!)).toBeFocused();
  await expect(portButton(fortyEight.ports.at(-1)!)).toBeInViewport();
  expect(
    await portButton(fortyEight.ports.at(-1)!).evaluate((element) => {
      const scroller = element.closest('.visual-panel-scroll')!;
      const style = getComputedStyle(element);
      return {
        hasOverflow: scroller.scrollWidth > scroller.clientWidth,
        scrollsToLastPort: scroller.scrollLeft > 0,
        focusVisible: style.outlineStyle !== 'none',
      };
    }),
  ).toEqual({ hasOverflow: true, scrollsToLastPort: true, focusVisible: true });
  await panel(fortyEight.device).screenshot({
    path: testInfo.outputPath('faceplate-48-focused.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Enter');
  await expect(
    inspector.getByRole('heading', { name: 'Port 48', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('combobox', { name: 'Panel face', exact: true })
    .selectOption({ label: 'Front' });
  await expect(portButton(twentyFour.ports.at(-1)!)).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Panel face', exact: true })
    .selectOption({ label: 'Rear' });
  await expect(portButton(twentyFour.ports.at(-1)!)).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Panel face', exact: true })
    .selectOption({ label: 'Both' });
  await expect(
    panel(twentyFour.device).locator('button[data-port-id]'),
  ).toHaveCount(24);
  await page
    .getByRole('button', {
      name: `Move ${deviceNames.eight} down`,
      exact: true,
    })
    .click();
  await expect(page.locator('article[data-device-id]').first()).toHaveAttribute(
    'data-device-id',
    twentyFour.device.id,
  );
  const ordered = (
    await read<{ devices: Device[] }>(`${root}/devices`)
  ).devices.map((item) => item.id);
  expect(ordered.slice(0, 2)).toEqual([twentyFour.device.id, eight.device.id]);
  await page.reload();
  await expect(page.locator('article[data-device-id]').first()).toHaveAttribute(
    'data-device-id',
    twentyFour.device.id,
  );

  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await second.goto(siteUrl);
    await signIn(second);
    await expect(
      second.locator('article[data-device-id]').first(),
    ).toHaveAttribute('data-device-id', twentyFour.device.id);
    await expect(
      second.locator(
        `button[data-port-id="${eight.ports[1]!.id}"] [data-vlan-border]`,
      ),
    ).toHaveAttribute('stroke', '#d66b85');
  } finally {
    await secondContext.close();
  }
  await page.goto(`${siteUrl}?view=configure&deviceId=${randomUUID()}`);
  await expect(page.getByRole('alert')).toContainText(
    'The requested device is unavailable in this site.',
  );
  await expect(page.locator('.port-grid')).toHaveCount(0);
  await page.goto(
    `${siteUrl}?view=configure&deviceId=${eight.device.id}&portId=${randomUUID()}`,
  );
  await expect(page.getByRole('alert')).toContainText(
    'The requested port is unavailable on this device.',
  );
  await page.goto(siteUrl);
  await expect(page.locator('article[data-device-id]').first()).toHaveAttribute(
    'data-device-id',
    twentyFour.device.id,
  );
  const devicesUrl = `${origin}/api/v1${root}/devices`;
  await page.route(devicesUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Synthetic equipment fetch failure.',
        },
      }),
    }),
  );
  await page
    .getByRole('button', { name: 'Refresh equipment', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic equipment fetch failure. Use Refresh equipment to try again.',
  );
  await expect(
    page.getByText('No equipment configured yet.', { exact: true }),
  ).toHaveCount(0);
  await page.unroute(devicesUrl);
  await page
    .getByRole('button', { name: 'Refresh equipment', exact: true })
    .click();
  await expect(page.locator('article[data-device-id]')).toHaveCount(4);
  await expect(
    portButton(eight.ports[1]!).locator('[data-vlan-border]'),
  ).toHaveAttribute('stroke', '#d66b85');
  expect(pageErrors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('visual-equipment.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
