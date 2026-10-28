import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardElement,
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
async function closeInspector(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
}
async function collapseBrowser(page: Page) {
  await saved(page);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await expect(page.locator('.board-studio')).toHaveClass(/browser-collapsed/);
}
async function fit(page: Page) {
  await collapseBrowser(page);
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
}
function fixture(): BoardDocument {
  const document = emptyBoardDocument();
  const device = (
    id: string,
    name: string,
    x: number,
    y: number,
    width: number,
  ): BoardElement => ({
    id,
    type: 'device',
    name,
    x,
    y,
    width,
    height: 260,
    z: id === 'router' ? 0 : 1,
    color: '#24332b',
    properties: { deviceType: name, face: 'front', portSpacing: 8 },
  });
  document.elements = [
    device('router', 'Router', 80, 80, 816),
    device('switch', 'Switch', 200, 460, 600),
  ];
  for (const [deviceId, count] of [
    ['router', 11],
    ['switch', 8],
  ] as const)
    for (let column = 0; column < count; column++) {
      const port: BoardPort = {
        id: `${deviceId}-${column + 1}`,
        deviceId,
        face: 'front',
        row: 0,
        column,
        name: `Port ${column + 1}`,
        kind:
          deviceId === 'router' && column < 2
            ? 'sfp_plus'
            : deviceId === 'router' && column === 2
              ? 'sfp'
              : 'rj45',
        color: '#428deb',
        role: column === 4 ? 'VLAN Trunk' : 'Documented uplink',
        speed: '1G',
        linkState: 'unknown',
        nativeVlan: '1',
        taggedVlans: ['20', '30'],
        pvid: '99',
        address: '',
        externalDestination: '',
        notes: 'Retain configuration while routing',
        customFields: { active: false, value: 0 },
      };
      document.ports.push(port);
    }
  document.cables = [
    {
      id: 'primary-cable',
      sourcePortId: 'router-5',
      targetPortId: 'switch-1',
      name: 'Router Port 5 to Switch Port 1',
      cableType: 'Cat6A',
      sourceConnector: 'RJ45',
      targetConnector: 'RJ45',
      color: '#c1d7e1',
      length: '2m',
      notes: 'Saved physical connection',
    },
    {
      id: 'second-cable',
      sourcePortId: 'router-6',
      targetPortId: 'switch-2',
      name: 'Secondary physical cable',
      cableType: 'Cat6',
      sourceConnector: 'RJ45',
      targetConnector: 'RJ45',
      color: '#b5a8d2',
      length: '',
      notes: '',
    },
  ];
  return document;
}

async function assertAttachments(page: Page, cableId: string) {
  const group = page.locator(`[data-board-cable-id="${cableId}"]`);
  for (const attribute of [
    'data-source-x',
    'data-source-y',
    'data-target-x',
    'data-target-y',
  ])
    await expect(group).toHaveAttribute(attribute, /^-?[0-9.]+$/);
  const result = await page
    .locator(`[data-board-cable-id="${cableId}"]`)
    .evaluate((group, cableId) => {
      const line = group.querySelector<SVGPathElement>('.board-cable-line')!;
      const transform = line.getScreenCTM()!;
      const length = line.getTotalLength();
      const ids =
        cableId === 'primary-cable'
          ? ['router-5', 'switch-1']
          : ['router-6', 'switch-2'];
      return ids.map((id, index) => {
        const endpoint = line
          .getPointAtLength(index === 0 ? 0 : length)
          .matrixTransform(transform);
        const socket = document
          .querySelector(`button[data-port-id="${id}"] [data-vlan-border]`)!
          .getBoundingClientRect();
        return {
          x: (endpoint.x - socket.left) / socket.width,
          y: (endpoint.y - socket.top) / socket.height,
        };
      });
    }, cableId);
  for (const point of result) {
    expect(point.x).toBeGreaterThanOrEqual(-0.08);
    expect(point.x).toBeLessThanOrEqual(1.08);
    expect(point.y).toBeGreaterThanOrEqual(-0.08);
    expect(point.y).toBeLessThanOrEqual(1.08);
    expect(
      Math.min(
        Math.abs(point.x),
        Math.abs(point.x - 1),
        Math.abs(point.y),
        Math.abs(point.y - 1),
      ),
    ).toBeLessThan(0.09);
  }
}

async function assertReadable(page: Page) {
  // Wide transparent cable hit strokes must not steal a label/header click.
  for (const [selector, kind, objectId] of [
    [
      '[data-board-element-id="router"] .board-element-name',
      'header',
      'router',
    ],
    [
      '[data-board-element-id="switch"] .board-element-name',
      'header',
      'switch',
    ],
    ['[data-board-port-id="router-5"] .board-port-name', 'label', 'router-5'],
    ['[data-board-port-id="switch-1"] .board-port-name', 'label', 'switch-1'],
    ['[data-board-port-id="router-5"] .board-port-role', 'label', 'router-5'],
    ['[data-board-port-id="switch-1"] .board-port-role', 'label', 'switch-1'],
  ] as const) {
    const label = page.locator(selector);
    const readable = await label.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = window.document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return Boolean(hit && (hit === node || node.contains(hit)));
    });
    expect(readable, selector).toBe(true);
    const mask = page.locator(
      `.board-cable-protection-mask .board-cable-protected-${kind}[data-protected-object="${objectId}"]`,
    );
    await expect(mask).toHaveAttribute('fill', 'black');
    const coverage = await mask.evaluate((node, selector) => {
      const rect = node as SVGRectElement;
      const matrix = rect.ownerSVGElement!.getScreenCTM()!;
      const topLeft = new DOMPoint(
        rect.x.baseVal.value,
        rect.y.baseVal.value,
      ).matrixTransform(matrix);
      const bottomRight = new DOMPoint(
        rect.x.baseVal.value + rect.width.baseVal.value,
        rect.y.baseVal.value + rect.height.baseVal.value,
      ).matrixTransform(matrix);
      const label = window.document
        .querySelector(selector)!
        .getBoundingClientRect();
      return (
        topLeft.x <= label.left + 1 &&
        topLeft.y <= label.top + 1 &&
        bottomRight.x >= label.right - 1 &&
        bottomRight.y >= label.bottom - 1
      );
    }, selector);
    expect(coverage, `Cable mask covers ${selector}`).toBe(true);
  }
}

async function outsideCablePoint(line: Locator, unique = false) {
  return line.evaluate((node, unique) => {
    const path = node as SVGPathElement;
    const matrix = path.getScreenCTM()!;
    const length = path.getTotalLength();
    const others = unique
      ? Array.from(
          window.document.querySelectorAll<SVGPathElement>('.board-cable-line'),
        )
          .filter((other) => other !== path)
          .map((other) => {
            const count = Math.max(2, Math.ceil(other.getTotalLength() / 3));
            return Array.from({ length: count + 1 }, (_, index) =>
              other
                .getPointAtLength((other.getTotalLength() * index) / count)
                .matrixTransform(other.getScreenCTM()!),
            );
          })
      : [];
    function distance(point: DOMPoint, a: DOMPoint, b: DOMPoint) {
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point.x - a.x) * dx + (point.y - a.y) * dy) /
            (dx * dx + dy * dy || 1),
        ),
      );
      return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
    }
    for (let sample = 1; sample < 50; sample++) {
      const point = path
        .getPointAtLength((length * sample) / 50)
        .matrixTransform(matrix);
      if (
        point.x < 12 ||
        point.x > window.innerWidth - 12 ||
        point.y < 130 ||
        point.y > window.innerHeight - 12
      )
        continue;
      const separated = others.every((points) =>
        points
          .slice(1)
          .every((other, index) => distance(point, points[index]!, other) > 1),
      );
      if (
        separated &&
        window.document
          .elementFromPoint(point.x, point.y)
          ?.closest('.board-cable-hit')
      )
        return { x: point.x, y: point.y };
    }
    return null;
  }, unique);
}

async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 12 },
  );
  await page.mouse.up();
  await saved(page);
}

test('physical cable routes attach at connector edges and preserve readable equipment across layouts', async ({
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
  const headers = {
    Origin: new URL(page.url()).origin,
    'x-csrf-token': auth.csrfToken,
  };
  const document = fixture();
  const response = await page.request.post('/api/v1/boards', {
    headers,
    data: { name: `Cable routing ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).board.id as string;
  await page.goto(`/boards/${id}`);
  await fit(page);
  const cable = page.locator('[data-board-cable-id="primary-cable"]');
  const line = cable.locator('.board-cable-line');
  const hit = cable.locator('.board-cable-hit');
  const router = page.locator('[data-board-element-id="router"]');
  const switchElement = page.locator('[data-board-element-id="switch"]');
  await expect(page.locator('[data-board-cable-id]')).toHaveCount(2);
  await assertAttachments(page, 'primary-cable');
  await assertAttachments(page, 'second-cable');
  await assertReadable(page);
  await expect(cable).toHaveAttribute('mask', /^url\(#.+\)$/);
  expect(
    Number(await line.evaluate((node) => getComputedStyle(node).opacity)),
  ).toBeGreaterThanOrEqual(0.65);
  expect(await line.getAttribute('d')).not.toBe(
    await page
      .locator('[data-board-cable-id="second-cable"] .board-cable-line')
      .getAttribute('d'),
  );
  const initial = (await read(page, id)).document;
  expect(initial.ports).toEqual(document.ports);
  expect(initial.cables).toEqual(document.cables);
  await page.screenshot({ path: info.outputPath('stacked-cables.png') });

  const clickPoint = await outsideCablePoint(line);
  if (!clickPoint)
    await info.attach('cable-hit-diagnostics', {
      contentType: 'application/json',
      body: JSON.stringify(
        await hit.evaluate((node) => {
          const path = node as SVGPathElement;
          const transform = path.getScreenCTM()!;
          return {
            path: path.getAttribute('d'),
            pointerEvents: getComputedStyle(path).pointerEvents,
            targets: Array.from({ length: 20 }, (_, index) => {
              const point = path
                .getPointAtLength((path.getTotalLength() * (index + 1)) / 21)
                .matrixTransform(transform);
              const target = window.document.elementFromPoint(point.x, point.y);
              return {
                x: point.x,
                y: point.y,
                class: target?.getAttribute('class'),
                cable: target
                  ?.closest('[data-board-cable-id]')
                  ?.getAttribute('data-board-cable-id'),
              };
            }),
          };
        }),
      ),
    });
  expect(clickPoint).not.toBeNull();
  if (info.project.name.startsWith('mobile'))
    await page.touchscreen.tap(clickPoint!.x, clickPoint!.y);
  else await page.mouse.click(clickPoint!.x, clickPoint!.y);
  await expect(
    inspector(page).getByLabel('Cable type', { exact: true }),
  ).toHaveValue('Cat6A');
  await closeInspector(page);
  await page.getByRole('button', { name: 'Hide cables', exact: true }).click();
  await saved(page);
  await expect(cable).toHaveCount(0);
  await page.getByRole('button', { name: 'Show cables', exact: true }).click();
  await saved(page);
  await expect(cable).toHaveCount(1);
  expect((await read(page, id)).document.cables).toEqual(document.cables);

  await router.locator('.board-element-header').click();
  const beforeResize = (await read(page, id)).document;
  const handle = page.getByRole('button', {
    name: 'Resize Router se',
    exact: true,
  });
  await handle.press('Shift+ArrowDown');
  await handle.press('Shift+ArrowDown');
  await handle.press('Shift+ArrowRight');
  await saved(page);
  const resized = (await read(page, id)).document;
  expect(resized.elements[0]!.height).toBeGreaterThan(
    beforeResize.elements[0]!.height,
  );
  expect(resized.ports).toEqual(beforeResize.ports);
  expect(resized.cables).toEqual(beforeResize.cables);
  await closeInspector(page);
  await fit(page);
  await page
    .getByRole('button', { name: 'Edit port layout', exact: true })
    .click();
  const beforePort = (await read(page, id)).document;
  const beforePortPath = await line.getAttribute('d');
  await router
    .getByRole('button', { name: 'Move Port 5', exact: true })
    .press('ArrowDown');
  await saved(page);
  const afterPort = (await read(page, id)).document;
  expect(afterPort.ports[4]!.row).toBe(1);
  expect({ ...afterPort.ports[4]!, row: 0 }).toEqual(beforePort.ports[4]);
  expect(afterPort.cables).toEqual(document.cables);
  await expect(line).not.toHaveAttribute('d', beforePortPath!);
  await assertAttachments(page, 'primary-cable');
  await router
    .getByRole('button', { name: 'Move Port 5', exact: true })
    .press('ArrowUp');
  await saved(page);
  await page
    .getByRole('button', { name: 'Select objects', exact: true })
    .click();
  const beforeMove = await line.getAttribute('d');
  await dragBy(page, router.locator('.board-element-header'), 35, 20);
  await expect(line).not.toHaveAttribute('d', beforeMove!);
  expect((await read(page, id)).document.ports).toEqual(document.ports);
  expect((await read(page, id)).document.cables).toEqual(document.cables);
  await closeInspector(page);
  await fit(page);
  await assertAttachments(page, 'primary-cable');
  await assertReadable(page);
  const pathBeforeZoom = await line.getAttribute('d');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await saved(page);
  expect(await line.getAttribute('d')).toBe(pathBeforeZoom);
  await assertAttachments(page, 'primary-cable');
  await fit(page);

  for (const [name, switchX, switchY] of [
    ['side-by-side', 1100, 80],
    ['diagonal', 1050, 460],
  ] as const) {
    const current = await read(page, id);
    const arranged = structuredClone(current.document);
    arranged.elements[0] = { ...arranged.elements[0]!, x: 80, y: 80 };
    arranged.elements[1] = { ...arranged.elements[1]!, x: switchX, y: switchY };
    const patched = await page.request.patch(`/api/v1/boards/${id}`, {
      headers,
      data: { rowVersion: current.rowVersion, document: arranged },
    });
    expect(patched.status()).toBe(200);
    await page.reload();
    await fit(page);
    await assertAttachments(page, 'primary-cable');
    await assertAttachments(page, 'second-cable');
    await assertReadable(page);
    expect((await read(page, id)).document.ports).toEqual(document.ports);
    expect((await read(page, id)).document.cables).toEqual(document.cables);
    await page.screenshot({ path: info.outputPath(`${name}-cables.png`) });
    const secondLine = page.locator(
      '[data-board-cable-id="second-cable"] .board-cable-line',
    );
    const secondPoint = await outsideCablePoint(secondLine, true);
    expect(
      secondPoint,
      `${name} exposes a distinct selectable second cable segment`,
    ).not.toBeNull();
    if (info.project.name.startsWith('mobile'))
      await page.touchscreen.tap(secondPoint!.x, secondPoint!.y);
    else await page.mouse.click(secondPoint!.x, secondPoint!.y);
    await expect(
      inspector(page).getByLabel('Cable type', { exact: true }),
    ).toHaveValue('Cat6');
    await closeInspector(page);
  }
  // Screen-space hit clearance must still protect text at low zoom.
  const beforeLowZoom = await read(page, id);
  const lowZoom = structuredClone(beforeLowZoom.document);
  lowZoom.viewport = { x: 20, y: 190, zoom: 0.25 };
  const beforeLowZoomPath = await line.getAttribute('d');
  const lowZoomResponse = await page.request.patch(`/api/v1/boards/${id}`, {
    headers,
    data: { rowVersion: beforeLowZoom.rowVersion, document: lowZoom },
  });
  expect(lowZoomResponse.status()).toBe(200);
  await page.reload();
  await collapseBrowser(page);
  expect(await line.getAttribute('d')).toBe(beforeLowZoomPath);
  await assertAttachments(page, 'primary-cable');
  await assertReadable(page);
  expect((await read(page, id)).document.ports).toEqual(document.ports);
  expect((await read(page, id)).document.cables).toEqual(document.cables);
  await hit.focus();
  await hit.press('Enter');
  await expect(
    inspector(page).getByLabel('Cable type', { exact: true }),
  ).toHaveValue('Cat6A');
  await inspector(page)
    .getByRole('button', { name: 'Delete cable', exact: true })
    .click();
  await saved(page);
  await expect(cable).toHaveCount(0);
  expect((await read(page, id)).document.cables.map((item) => item.id)).toEqual(
    ['second-cable'],
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, id)).document.cables).toEqual(document.cables);
  await page.reload();
  await saved(page);
  expect((await read(page, id)).document.ports).toEqual(document.ports);
  expect((await read(page, id)).document.cables).toEqual(document.cables);
  expect(errors).toEqual([]);
  await expect(switchElement.locator('.board-element-name')).toHaveText(
    'Switch',
  );
});
