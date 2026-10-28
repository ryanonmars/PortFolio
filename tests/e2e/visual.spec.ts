import {
  gridCell,
  openTaggedVlans,
  selectTaggedVlans,
} from './grid-actions.js';
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
  const cableLine = page.locator(
    `g[data-connection-id="${linked.connection.id}"]`,
  );
  async function showCableEndpoints() {
    await portButton(eight.ports[0]!).scrollIntoViewIfNeeded();
    await portButton(router.ports[4]!).scrollIntoViewIfNeeded();
  }
  async function assertCableAlignment() {
    await expect(cableLine).toHaveCount(1);
    await expect(cableLine).toHaveAttribute(
      'data-endpoint-a',
      eight.ports[0]!.id,
    );
    await expect(cableLine).toHaveAttribute(
      'data-endpoint-b',
      router.ports[4]!.id,
    );
    await expect
      .poll(() =>
        cableLine.locator('path.cable-overlay-stroke').evaluate(
          (element, ids) => {
            const path = element as SVGPathElement;
            const transform = path.getScreenCTM();
            if (!transform) return Infinity;
            const points = [
              path.getPointAtLength(0),
              path.getPointAtLength(path.getTotalLength()),
            ];
            return Math.max(
              ...ids.map((id, index) => {
                const socket = document
                  .querySelector(
                    `[id="visual-port-${CSS.escape(id)}"] [data-socket]`,
                  )!
                  .getBoundingClientRect();
                const rendered = points[index]!.matrixTransform(transform);
                return Math.hypot(
                  rendered.x - (socket.left + socket.right) / 2,
                  rendered.y - socket.top,
                );
              }),
            );
          },
          [eight.ports[0]!.id, router.ports[4]!.id],
        ),
      )
      .toBeLessThan(1.5);
  }
  for (const fixture of Object.values(fixtures))
    await expect(
      panel(fixture.device).locator('button[data-port-id]'),
    ).toHaveCount(fixture.ports.length);
  await showCableEndpoints();
  await assertCableAlignment();
  const showCables = page.getByRole('checkbox', {
    name: 'Show documented connections',
    exact: true,
  });
  await showCables.uncheck();
  await expect(cableLine).toHaveCount(0);
  await showCables.check();
  await assertCableAlignment();
  const originalViewport = page.viewportSize()!;
  if (originalViewport.width > 640)
    await page.setViewportSize({ width: 390, height: originalViewport.height });
  await showCableEndpoints();
  await portButton(router.ports[4]!)
    .locator('xpath=ancestor::*[contains(@class,"visual-panel-scroll")][1]')
    .evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
  await expect(cableLine).toHaveCount(0);
  await page.setViewportSize(originalViewport);
  await showCableEndpoints();
  await assertCableAlignment();
  await page.setViewportSize({
    width: originalViewport.width + 24,
    height: originalViewport.height,
  });
  await showCableEndpoints();
  await assertCableAlignment();
  await page.setViewportSize(originalViewport);
  await showCableEndpoints();
  await assertCableAlignment();
  await portButton(eight.ports[1]!).hover();
  await expect(cableLine).toHaveAttribute('data-dimmed', 'false');
  await showCables.hover();
  await expect(cableLine).toHaveAttribute('data-dimmed', 'false');
  await expect(cableLine).toHaveAttribute('data-highlighted', 'false');
  const cableHit = cableLine.locator('path.cable-overlay-hit');
  await cableHit.focus();
  await expect(page.locator('.cable-overlay-caption')).toContainText(
    `${deviceNames.eight} / Port 1`,
  );
  await cableHit.press('Enter');
  const cableDialog = page.getByRole('dialog', {
    name: 'Port inspector',
    exact: true,
  });
  await expect(
    cableDialog.getByRole('region', { name: 'Cable endpoints', exact: true }),
  ).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(cableDialog).toHaveCount(0);
  await expect(portButton(eight.ports[0]!)).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('visual-cable-overview.png'),
    fullPage: true,
    animations: 'disabled',
  });
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
  for (const fixture of [twentyFour, fortyEight]) {
    const front = fixture.ports.filter((port) => port.face === 'front');
    const first = (await portButton(front[0]!).boundingBox())!;
    const second = (await portButton(front[1]!).boundingBox())!;
    const lower = (await portButton(
      front[Math.ceil(front.length / 2)]!,
    ).boundingBox())!;
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeCloseTo(first.y, 0);
    expect(lower.y).toBeGreaterThan(first.y);
    expect(
      (
        await read<{ ports: Port[] }>(
          `${root}/devices/${fixture.device.id}/ports`,
        )
      ).ports.map((port) => port.id),
    ).toEqual(fixture.ports.map((port) => port.id));
  }
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
  await expect(
    page.getByRole('combobox', { name: 'Port size', exact: true }),
  ).toHaveCount(0);
  expect((await portButton(eight.ports[0]!).boundingBox())!.width).toBe(
    testInfo.project.name.startsWith('mobile') ? 60 : 80,
  );
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

  const equipmentGeometry = await panel(eight.device).boundingBox();
  await portButton(eight.ports[0]!).click();
  const inspector = page.getByRole('dialog', {
    name: 'Port inspector',
    exact: true,
  });
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute('aria-modal', 'true');
  await expect(cableLine).toHaveAttribute('data-highlighted', 'true');
  const cableEndpoints = inspector.getByRole('region', {
    name: 'Cable endpoints',
    exact: true,
  });
  await expect(cableEndpoints).toBeInViewport();
  await expect(cableEndpoints).toContainText(`${deviceNames.eight} / Port 1`);
  await expect(cableEndpoints).toContainText(`${deviceNames.router} / Port 5`);
  await page.screenshot({
    path: testInfo.outputPath('visual-cable-endpoints.png'),
    fullPage: false,
    animations: 'disabled',
  });
  const openedGeometry = await panel(eight.device).boundingBox();
  expect(openedGeometry!.width).toBeCloseTo(equipmentGeometry!.width, 0);
  expect(openedGeometry!.height).toBeCloseTo(equipmentGeometry!.height, 0);
  expect(openedGeometry!.x).toBeCloseTo(equipmentGeometry!.x, 0);
  await expect(inspector.getByLabel('PVID', { exact: true })).toHaveValue('1');
  const initialTagged = await openTaggedVlans(page, 'Tagged VLANs');
  await expect(
    initialTagged.getByRole('button', { name: 'Remove VLAN 20', exact: true }),
  ).toBeVisible();
  await expect(
    initialTagged.getByRole('button', { name: 'Remove VLAN 30', exact: true }),
  ).toBeVisible();
  await initialTagged
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect(
    inspector.getByLabel('Measured watts', { exact: true }),
  ).toHaveValue('0');
  await expect(
    inspector.getByLabel('PoE enabled', { exact: true }),
  ).toHaveValue('false');
  await expect(inspector).toContainText(deviceNames.router);
  await expect(inspector).toContainText('Port 5');
  await expect(
    inspector.getByLabel('External destination annotation', { exact: true }),
  ).toHaveValue('Manually documented annotation');
  const description = inspector.getByLabel('Description/Notes', {
    exact: true,
  });
  const savePort = inspector.getByRole('button', {
    name: 'Save port',
    exact: true,
  });
  await description.fill('Saved directly from the faceplate');
  await selectTaggedVlans(page, 'Tagged VLANs', [vlan(30).id]);
  await inspector
    .getByLabel('Native/Untagged VLAN', { exact: true })
    .selectOption(vlan(20).id);
  await inspector.locator('.port-drawer-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(savePort).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('visual-editable-port-drawer.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await inspector.locator('.port-drawer-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(savePort).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('visual-editable-port-fields.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await savePort.click();
  await expect(
    inspector.getByText('Port saved.', { exact: true }),
  ).toBeVisible();
  await expect(inspector).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/sites/${site.id}`);
  const savedPort = (
    await read<{ ports: Port[] }>(`${root}/devices/${eight.device.id}/ports`)
  ).ports.find((port) => port.id === eight.ports[0]!.id)!;
  expect(savedPort.description).toBe('Saved directly from the faceplate');
  expect(savedPort.pvid).toBe(1);
  expect(savedPort.nativeVlanRef).toBe(vlan(20).id);
  expect(savedPort.taggedVlanRefs).toEqual([vlan(30).id]);
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(
    portButton(eight.ports[0]!).locator('[data-vlan-border]'),
  ).toHaveAttribute('stroke', vlan(20).color!);
  const nativeBadge = portButton(eight.ports[0]!).locator(
    `[data-membership="native"][data-vlan-id="${vlan(20).id}"]`,
  );
  const taggedBadge = portButton(eight.ports[0]!).locator(
    `[data-membership="tagged"][data-vlan-id="${vlan(30).id}"]`,
  );
  await expect(nativeBadge).toHaveText('VLAN 20');
  await expect(taggedBadge).toHaveText('Tagged 30');
  for (const [badge, color] of [
    [nativeBadge, vlan(20).color!],
    [taggedBadge, vlan(30).color!],
  ] as const) {
    expect(
      await badge.evaluate((element, expectedColor) => {
        const swatch = document.createElement('span');
        swatch.style.borderColor = expectedColor;
        return (
          getComputedStyle(element).borderColor === swatch.style.borderColor
        );
      }, color),
    ).toBe(true);
  }
  await page.reload();
  await portButton(eight.ports[0]!).click();
  await expect(description).toHaveValue('Saved directly from the faceplate');
  await description.fill('Unsaved drawer edit');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(description).toHaveValue('Unsaved drawer edit');
  await expect(inspector).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(portButton(eight.ports[0]!)).toBeFocused();
  await portButton(eight.ports[0]!).click();
  await expect(description).toHaveValue('Saved directly from the faceplate');
  await description.fill('Preserve stale drawer draft');
  await write(`${root}/ports/${savedPort.id}`, 'PATCH', {
    rowVersion: savedPort.rowVersion,
    description: 'Saved by another drawer client',
  });
  await savePort.click();
  await expect(
    inspector
      .getByRole('alert')
      .filter({ hasText: 'Your edits are preserved' }),
  ).toBeVisible();
  await expect(description).toHaveValue('Preserve stale drawer draft');
  await expect(savePort).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await inspector
    .getByRole('button', { name: 'Reload saved port', exact: true })
    .click();
  await expect(description).toHaveValue('Saved by another drawer client');
  await inspector
    .getByRole('button', {
      name: `Inspect connected port ${deviceNames.router} Port 5`,
      exact: true,
    })
    .click();
  await expect(
    inspector.getByRole('heading', { name: 'Port 5', exact: true }),
  ).toBeVisible();
  await expect(definition(inspector, 'Connected to')).toContainText(
    `${deviceNames.eight} / Port 1`,
  );
  await expect(definition(inspector, 'Cable notes')).toHaveText(
    'Manual cable documentation',
  );
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(portButton(router.ports[4]!)).toBeFocused();
  expect(await page.evaluate(() => 'visualUnsafe' in window)).toBe(false);
  const beforeDrag = (
    await read<{ ports: Port[] }>(`${root}/devices/${eight.device.id}/ports`)
  ).ports;
  const cablesBeforeDrag = await read(`${root}/connections`);
  const customBeforeDrag = await read(
    `${root}/devices/${eight.device.id}/port-values`,
  );
  const visualGrip = (port: Port) =>
    page.getByRole('button', {
      name: `Reorder ${deviceNames.eight} ${port.name}`,
      exact: true,
    });
  await visualGrip(eight.ports[2]!).dragTo(visualGrip(eight.ports[1]!));
  const visualOrder = [...beforeDrag];
  [visualOrder[1], visualOrder[2]] = [visualOrder[2]!, visualOrder[1]!];
  await expect
    .poll(async () =>
      (
        await read<{ ports: Port[] }>(
          `${root}/devices/${eight.device.id}/ports`,
        )
      ).ports.map((port) => port.id),
    )
    .toEqual(visualOrder.map((port) => port.id));
  const afterDrag = (
    await read<{ ports: Port[] }>(`${root}/devices/${eight.device.id}/ports`)
  ).ports;
  const withoutPosition = (ports: Port[]) =>
    ports
      .map(({ orderIndex: _order, rowVersion: _version, ...port }) => port)
      .sort((left, right) => left.id.localeCompare(right.id));
  expect(withoutPosition(afterDrag)).toEqual(withoutPosition(beforeDrag));
  expect(await read(`${root}/connections`)).toEqual(cablesBeforeDrag);
  expect(await read(`${root}/devices/${eight.device.id}/port-values`)).toEqual(
    customBeforeDrag,
  );
  await page.screenshot({
    path: testInfo.outputPath('visual-drag-port-order.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await page.reload();
  await expect
    .poll(() =>
      panel(eight.device)
        .locator('button[data-port-id]')
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('data-port-id')),
        ),
    )
    .toEqual(visualOrder.map((port) => port.id));
  const renumberSummary = panel(eight.device)
    .locator('summary')
    .filter({ hasText: /^Renumber ports$/ });
  await renumberSummary.click();
  const renumberForm = panel(eight.device).getByRole('form', {
    name: `Renumber ports on ${deviceNames.eight}`,
    exact: true,
  });
  await renumberForm
    .getByLabel(`${deviceNames.eight} port name prefix`, { exact: true })
    .fill('Port ');
  await renumberForm
    .getByLabel(`${deviceNames.eight} port start number`, { exact: true })
    .fill('1');
  await renumberForm
    .getByRole('button', { name: 'Preview port names', exact: true })
    .click();
  await expect(
    renumberForm.getByRole('region', {
      name: 'Port name preview',
      exact: true,
    }),
  ).toContainText('Port 3');
  expect(
    (await read<{ ports: Port[] }>(`${root}/devices/${eight.device.id}/ports`))
      .ports,
  ).toEqual(afterDrag);
  await page.screenshot({
    path: testInfo.outputPath('visual-renumber-preview.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await renumberForm
    .getByRole('button', { name: 'Rename ports', exact: true })
    .click();
  await expect(
    page.getByText('Port names saved.', { exact: true }),
  ).toBeVisible();
  const renamedVisual = (
    await read<{ ports: Port[] }>(`${root}/devices/${eight.device.id}/ports`)
  ).ports;
  expect(renamedVisual.map((port) => port.id)).toEqual(
    afterDrag.map((port) => port.id),
  );
  expect(renamedVisual.map((port) => port.name)).toEqual(
    afterDrag.map((_, index) => `Port ${index + 1}`),
  );
  const withoutName = (records: Port[]) =>
    records.map(({ name: _name, rowVersion: _version, ...port }) => port);
  expect(withoutName(renamedVisual)).toEqual(withoutName(afterDrag));
  expect(await read(`${root}/connections`)).toEqual(cablesBeforeDrag);
  expect(await read(`${root}/devices/${eight.device.id}/port-values`)).toEqual(
    customBeforeDrag,
  );
  await page.reload();
  await expect(portButton(eight.ports[2]!)).toHaveAttribute(
    'aria-label',
    new RegExp(`${deviceNames.eight} Port 2,`),
  );
  await write(
    `${root}/ports/bulk-edit`,
    'POST',
    {
      updates: renamedVisual.map((port) => ({
        portId: port.id,
        rowVersion: port.rowVersion,
        changes: {
          name: afterDrag.find((original) => original.id === port.id)!.name,
        },
      })),
    },
    200,
  );
  await page.reload();
  await panel(eight.device)
    .getByRole('button', {
      name: `Configure ${deviceNames.eight}`,
      exact: true,
    })
    .click();
  await expect(
    page.locator('.sidebar-panel a[aria-current="location"]'),
  ).toHaveText('Equipment');
  const focusedRow = page.locator(
    `.port-grid tr[data-port-id="${eight.ports[1]!.id}"]`,
  );
  await expect(
    focusedRow.getByRole('button', { name: 'Port 2 Port', exact: true }),
  ).toBeVisible();
  await (
    await gridCell(page, 2, 'Native/Untagged VLAN')
  ).selectOption(vlan(30).id);
  await expect(await gridCell(page, 2, 'PVID')).toHaveValue('20');
  await page
    .getByRole('button', { name: 'Save all changes', exact: true })
    .click();
  await expect(page.locator('.port-grid').getByRole('status')).toHaveText(
    '1 port saved.',
  );
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
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
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(portButton(fortyEight.ports.at(-1)!)).toBeFocused();
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
  await expect(cableLine).toHaveCount(0);
  await expect(portButton(twentyFour.ports.at(-1)!)).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Panel face', exact: true })
    .selectOption({ label: 'Both' });
  await expect(
    panel(twentyFour.device).locator('button[data-port-id]'),
  ).toHaveCount(24);
  await showCableEndpoints();
  await assertCableAlignment();
  const pathBeforeStackMove = await cableLine
    .locator('path.cable-overlay-stroke')
    .getAttribute('d');
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
  await showCableEndpoints();
  await assertCableAlignment();
  await expect(
    cableLine.locator('path.cable-overlay-stroke'),
  ).not.toHaveAttribute('d', pathBeforeStackMove!);
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
    'Synthetic equipment fetch failure.',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh equipment', exact: true }),
  ).toBeEnabled();
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
