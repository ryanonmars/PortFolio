import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardPort,
} from '../../packages/shared/src/board.js';

const media = '.tmp/qa-media/export-fidelity';
test.use({ actionTimeout: 15_000 });
function fixture(): BoardDocument {
  const document = emptyBoardDocument();
  const networkPrefixes = ['192.0.2', '198.51.100', '203.0.113'];
  document.grid = false;
  document.viewport = { x: 120, y: 100, zoom: 0.7 };
  document.elements = [
    {
      id: 'networks',
      type: 'network',
      name: 'Management Network',
      x: -180,
      y: -100,
      width: 960,
      height: 300,
      z: 0,
      color: '#00e676',
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
        entries: [1, 20, 30].map((id, index) => ({
          vlanId: String(id),
          vlanName: ['Management', 'Server', 'User Devices'][index]!,
          color: ['#428deb', '#37ef29', '#f14646'][index]!,
          subnet: `${networkPrefixes[index]}.0/24`,
          gateway: `${networkPrefixes[index]}.1`,
          dhcpServer: index !== 2,
          dhcpStart: `${networkPrefixes[index]}.100`,
          dhcpEnd: `${networkPrefixes[index]}.200`,
          dns: '203.0.113.53',
          notes: index === 2 ? 'Authored network notes remain readable.' : '',
          customFields: {
            Capacity: index === 1 ? 0 : '',
            Monitored: index === 1 ? false : '',
          },
        })),
      },
    },
    ...['', '#ef3434', '#27ee71', '#29d5e7'].map((color, index) => ({
      id: `device-${index}`,
      type: 'device' as const,
      name:
        index === 3
          ? 'Very long equipment name that must use ellipsis without changing its container'
          : ['Router', 'Switch', 'Server'][index]!,
      x: -180 + (index % 2) * 500,
      y: 240 + Math.floor(index / 2) * 280,
      width: 460,
      height: 220,
      z: index + 1,
      color,
      properties: {
        face: index === 3 ? 'rear' : 'front',
        manufacturer: 'Synthetic Equipment',
        model: 'Example 8411',
        managementAddress:
          index === 3
            ? '2001:db8:' + 'abcd'.repeat(12_000)
            : 'router.documentation.example',
      },
    })),
  ];
  document.ports = document.elements.slice(1).flatMap((device, deviceIndex) =>
    [0, 1, 2, 3, 4].map((column): BoardPort => ({
      id: `${device.id}-port-${column}`,
      deviceId: device.id,
      face: deviceIndex === 3 ? 'rear' : 'front',
      row: 0,
      column,
      name:
        column === 4
          ? 'Long port name that needs truncation'
          : `Port ${column + 1}`,
      kind: column === 0 ? 'sfp_plus' : column === 1 ? 'sfp' : 'rj45',
      color: ['#428deb', '#37ef29', '#f14646'][column % 3]!,
      role: column === 0 ? 'Router Uplink with a long purpose' : 'LAN Trunk',
      speed: '10G',
      linkState: 'unknown',
      nativeVlan: '1',
      taggedVlans: ['20', '30'],
      pvid: '',
      address: '',
      externalDestination: '',
      notes: '',
      customFields: {},
    })),
  );
  document.cables = [
    {
      id: 'cable',
      sourcePortId: document.ports[4]!.id,
      targetPortId: document.ports[10]!.id,
      name: 'Documented uplink',
      cableType: 'Cat6A',
      sourceConnector: '',
      targetConnector: '',
      color: '#e8f1f5',
      length: '',
      notes: '',
    },
  ];
  return document;
}
async function exportSvg(page: Page) {
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await page.getByLabel('Board menu', { exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export image', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
  const path = await download.path();
  if (!path) throw new Error('Missing SVG download');
  await page.getByLabel('Board menu', { exact: true }).click();
  return readFile(path, 'utf8');
}
async function visualComparison(page: Page, svg: string, label: string) {
  const dimensions = await page.evaluate((source) => {
    const root = new DOMParser().parseFromString(
      source,
      'image/svg+xml',
    ).documentElement;
    const view = root.getAttribute('viewBox')!.split(/[ ,]+/).map(Number);
    return { x: view[0]!, y: view[1]!, width: view[2]!, height: view[3]! };
  }, svg);
  expect(dimensions.width).toBeGreaterThan(960);
  expect(dimensions.width).toBeLessThan(1100);
  expect(dimensions.x).toBeLessThan(-180);
  const width = Math.ceil(dimensions.width),
    height = Math.ceil(dimensions.height);
  await page.setViewportSize({ width: width + 20, height: height + 20 });
  await page.evaluate(
    ({ x, y, width, height }) => {
      const canvas = document.querySelector<HTMLElement>('.board-canvas')!;
      Object.assign(canvas.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: `${width}px`,
        height: `${height}px`,
        minHeight: '0',
        zIndex: '999999',
        pointerEvents: 'none',
      });
      document.querySelector<HTMLElement>('.board-world')!.style.transform =
        `translate(${-x}px, ${-y}px) scale(1)`;
      document
        .querySelectorAll<HTMLElement>(
          '.board-resize-handle,.board-slot-grid,.board-guide-layer',
        )
        .forEach((node) => {
          node.style.display = 'none';
        });
    },
    { ...dimensions, width, height },
  );
  await page.mouse.move(width + 10, height + 10);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const live = await page
    .locator('.board-canvas')
    .screenshot({ animations: 'disabled' });
  const regions = await page.locator('.board-element').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        x: Math.ceil(box.x),
        y: Math.ceil(box.y),
        width: Math.floor(box.width),
        height: Math.floor(box.height),
      };
    }),
  );
  const rendered = await page.evaluate(
    async ({ source, reference, width, height, regions }) => {
      async function image(url: string) {
        const result = new Image();
        result.src = url;
        await result.decode();
        return result;
      }
      const vector = await image(
        `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`,
      );
      const original = await image(`data:image/png;base64,${reference}`);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.drawImage(vector, 0, 0);
      const png = canvas.toDataURL('image/png');
      const actual = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      context.drawImage(original, 0, 0, width, height);
      const expected = context.getImageData(0, 0, width, height).data;
      let error = 0,
        changed = 0;
      for (let offset = 0; offset < actual.length; offset += 4) {
        let maximum = 0;
        for (let channel = 0; channel < 3; channel++) {
          const difference = Math.abs(
            actual[offset + channel]! - expected[offset + channel]!,
          );
          error += difference;
          maximum = Math.max(maximum, difference);
        }
        if (maximum > 35) changed++;
      }
      return {
        png,
        meanError: error / (width * height * 3),
        changedRatio: changed / (width * height),
        regionErrors: regions.map((region) => {
          let error = 0;
          for (let y = region.y; y < region.y + region.height; y++) {
            for (let x = region.x; x < region.x + region.width; x++) {
              const offset = (y * width + x) * 4;
              for (let channel = 0; channel < 3; channel++)
                error += Math.abs(
                  actual[offset + channel]! - expected[offset + channel]!,
                );
            }
          }
          return error / (region.width * region.height * 3);
        }),
      };
    },
    { source: svg, reference: live.toString('base64'), width, height, regions },
  );
  await mkdir(media, { recursive: true });
  await writeFile(join(media, `${label}-live.png`), live);
  await writeFile(
    join(media, `${label}-export.png`),
    Buffer.from(rendered.png.split(',')[1]!, 'base64'),
  );
  await writeFile(join(media, `${label}.svg`), svg);
  console.log(
    `${label}: mean RGB error ${rendered.meanError.toFixed(3)}, changed ${(rendered.changedRatio * 100).toFixed(2)}%`,
  );
  expect(rendered.meanError).toBeLessThan(3);
  expect(rendered.changedRatio).toBeLessThan(0.04);
  for (const error of rendered.regionErrors) expect(error).toBeLessThan(4);
  return dimensions;
}

test('standalone vector export matches the shared board presentation, content bounds and saved configuration', async ({
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
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: {
      name: `Export fidelity ${randomUUID().slice(0, 8)}`,
      document: fixture(),
    },
  });
  expect(response.status()).toBe(201);
  const board = (await response.json()).board;
  await page.goto(`/boards/${board.id}`);
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
  await expect(page.locator('.board-network-entry')).toHaveCount(3);
  const before = (
    await (await page.request.get(`/api/v1/boards/${board.id}`)).json()
  ).board;
  const cablePath = await page.locator('.board-cable-line').getAttribute('d');
  expect(cablePath).toBeTruthy();
  const svg = await exportSvg(page);
  expect(svg).toContain(`d="${cablePath}"`);
  expect(svg).not.toMatch(
    /foreignObject|<image\b|<script\b|onload=|https?:\/\/(?!www\.w3\.org)/i,
  );
  for (const text of [
    'Management Network',
    'Management',
    'Server',
    'User Devices',
    'Subnet',
    'Gateway',
    'Enabled',
    'Disabled',
    'DHCP Pool',
    '203.0.113.53',
    'Front',
    'Rear',
    'LAN Trunk',
  ])
    expect(svg).toContain(text);
  expect(svg).toContain('…');
  await visualComparison(page, svg, info.project.name);
  const after = (
    await (await page.request.get(`/api/v1/boards/${board.id}`)).json()
  ).board;
  expect(after).toEqual(before);
  await page.reload();
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
  const reloaded = await exportSvg(page);
  await visualComparison(page, reloaded, `${info.project.name}-reload`);
  expect(
    (await (await page.request.get(`/api/v1/boards/${board.id}`)).json()).board,
  ).toEqual(before);
  async function replace(document: BoardDocument) {
    const current = (
      await (await page.request.get(`/api/v1/boards/${board.id}`)).json()
    ).board;
    const response = await page.request.patch(`/api/v1/boards/${board.id}`, {
      headers: {
        Origin: new URL(page.url()).origin,
        'x-csrf-token': auth.csrfToken,
      },
      data: { rowVersion: current.rowVersion, document },
    });
    expect(response.status()).toBe(200);
    await page.reload();
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
  }
  let zoomIndependent = '';
  for (const zoom of [0.25, 2.5]) {
    const changed = structuredClone(before.document) as BoardDocument;
    changed.viewport = { x: -600, y: 450, zoom };
    await replace(changed);
    const result = await exportSvg(page);
    if (zoomIndependent) expect(result).toBe(zoomIndependent);
    zoomIndependent = result;
  }
  const compact = structuredClone(before.document) as BoardDocument;
  compact.grid = true;
  compact.showCables = false;
  compact.elements[0]!.properties.displayFields = [
    'vlanId',
    'vlanName',
    'subnet',
  ];
  compact.elements.slice(1).forEach((element) => {
    element.properties.headerFields = [];
  });
  await replace(compact);
  const reduced = await exportSvg(page);
  expect(reduced).toContain('board-export-grid');
  expect(reduced).not.toContain('DHCP');
  expect(reduced).not.toContain('Management Address');
  expect(reduced).not.toContain(`d="${cablePath}"`);
  expect(reduced).toContain('LAN Trunk');
  await visualComparison(page, reduced, `${info.project.name}-grid-fields`);
  expect(errors).toEqual([]);
});

for (const boxless of [false, true]) {
  test(`narrow custom device export preserves native header text${boxless ? ' through display-contents wrappers' : ''}`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
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
    document.grid = false;
    document.viewport = { x: 210, y: 160, zoom: 0.7 };
    const names = ['NAS', 'AP', 'Firewall', 'PDU'];
    document.elements = [160, 180, 200, 240].map((width, index) => ({
      id: `narrow-${index}`,
      type: 'device',
      name: names[index]!,
      x: -180 + index * 220,
      y: -100,
      width,
      height: 220,
      z: index,
      color: '',
      properties: {
        face: index % 2 ? 'rear' : 'front',
        deviceType: index % 2 ? 'Custom' : 'Other',
        manufacturer: 'Enabled maker',
        model: 'Hidden model',
        headerFields: boxless ? [] : ['deviceType'],
      },
    }));
    document.ports = document.elements.map((element, index): BoardPort => ({
      id: `narrow-port-${index}`,
      deviceId: element.id,
      face: index % 2 ? 'rear' : 'front',
      row: 0,
      column: 0,
      name: 'Port 1',
      kind: index % 2 ? 'sfp' : 'rj45',
      color: '#428deb',
      role: 'Uplink',
      speed: '',
      linkState: 'unknown',
      nativeVlan: '',
      taggedVlans: [],
      pvid: '',
      address: '',
      externalDestination: '',
      notes: '',
      customFields: {},
    }));
    const response = await page.request.post('/api/v1/boards', {
      headers: {
        Origin: new URL(page.url()).origin,
        'x-csrf-token': auth.csrfToken,
      },
      data: { name: `Narrow export ${randomUUID().slice(0, 8)}`, document },
    });
    expect(response.status()).toBe(201);
    const board = (await response.json()).board;
    await page.goto(`/boards/${board.id}`);
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    if (boxless) {
      // Reproduce the previous compact-header layout in both the live board and
      // its offscreen shared renderer. A display:contents wrapper owns no box.
      await page.route('**/test-boxless-header.css', (route) =>
        route.fulfill({
          contentType: 'text/css',
          body: `
        .board-device-header-content { display:grid!important; grid-template-rows:21px 21px 0!important; gap:3px!important; }
        .board-device-header-top { display:contents!important; }
        .board-device-header-content .board-device-header-name { grid-row:1!important; grid-column:1!important; }
        .board-device-header-content .board-device-header-faces { grid-row:2!important; grid-column:1!important; justify-self:start; }
        .board-device-info { display:none!important; }
      `,
        }),
      );
      await page.addStyleTag({ url: '/test-boxless-header.css' });
      expect(
        await page
          .locator('.board-device-header-top')
          .first()
          .evaluate((node) => getComputedStyle(node).display),
      ).toBe('contents');
    }
    const before = (
      await (await page.request.get(`/api/v1/boards/${board.id}`)).json()
    ).board;
    const svg = await exportSvg(page);
    const nativeText = await page.evaluate((source) => {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
      return [...parsed.querySelectorAll('text')].map(
        (node) => node.textContent,
      );
    }, svg);
    for (const name of names) expect(nativeText).toContain(name);
    expect(nativeText.filter((value) => value === 'Front')).toHaveLength(4);
    expect(nativeText.filter((value) => value === 'Rear')).toHaveLength(4);
    expect(svg).not.toContain('Hidden model');
    expect(svg).not.toContain('Enabled maker');
    if (!boxless) {
      const icons = await page
        .locator('.board-device-info-overflow button')
        .count();
      expect(nativeText.filter((value) => value === 'i')).toHaveLength(icons);
      const displayed = await page
        .locator(
          '.board-device-info-chip .board-device-info-label,.board-device-info-chip .board-device-info-value',
        )
        .allTextContents();
      for (const value of displayed) expect(nativeText).toContain(value);
    }
    await visualComparison(
      page,
      svg,
      `${info.project.name}-narrow-${boxless ? 'contents' : 'current'}`,
    );
    expect(
      (await (await page.request.get(`/api/v1/boards/${board.id}`)).json())
        .board,
    ).toEqual(before);
    expect(errors).toEqual([]);
  });
}
