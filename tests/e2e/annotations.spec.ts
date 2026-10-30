import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardElement,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';
import { annotationEndpoints } from '../../apps/web/src/board/annotations.js';

test.use({ actionTimeout: 15_000 });
const cookies = new Map<
  string,
  Awaited<ReturnType<BrowserContext['cookies']>>
>();
const mobile = () => test.info().project.name.startsWith('mobile');
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
const object = (page: Page, id: string) =>
  page.locator('[data-board-element-id="' + id + '"]');
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
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
  const response = await page.request.get('/api/v1/boards/' + id);
  expect(response.status()).toBe(200);
  return (await response.json()).board;
}
async function request(
  page: Page,
  method: string,
  path: string,
  data?: unknown,
) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  return page.request.fetch('/api/v1' + path, {
    method,
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': session.csrfToken,
    },
    data,
  });
}
async function setup(page: Page, document = emptyBoardDocument()) {
  const key = test.info().project.name;
  const session = cookies.get(key);
  if (session) await page.context().addCookies(session);
  await page.goto('/');
  if (!session) {
    const status = await (
      await page.request.get('/api/v1/auth/setup-status')
    ).json();
    await page.getByLabel('Username', { exact: true }).fill('annotation-admin');
    await page
      .getByLabel('Password', { exact: true })
      .fill('Synthetic-annotation-password-42');
    await page
      .getByRole('button', {
        name: status.setupRequired ? 'Create administrator account' : 'Sign in',
        exact: true,
      })
      .click();
  }
  await expect(
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
  if (!session) cookies.set(key, await page.context().cookies());
  const response = await request(page, 'POST', '/boards', {
    name: 'Annotation QA ' + randomUUID().slice(0, 8),
    document,
  });
  expect(response.status()).toBe(201);
  const board: BoardRecord = (await response.json()).board;
  await page.goto('/boards/' + board.id);
  await saved(page);
  const collapse = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  return board;
}
async function closeInspector(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
}
async function openSection(page: Page, label: string) {
  const summary = inspector(page)
    .locator('summary')
    .filter({ hasText: new RegExp('^' + label + '$') });
  if (
    !(await summary.evaluate(
      (node) => (node.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
}
async function drag(
  page: Page,
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  if (mobile()) {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [a],
    });
    for (let step = 1; step <= 10; step++)
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: a.x + ((b.x - a.x) * step) / 10,
            y: a.y + ((b.y - a.y) * step) / 10,
          },
        ],
      });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await client.detach();
  } else {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
  }
}
async function select(page: Page, element: BoardElement) {
  await closeInspector(page);
  const box = (await object(page, element.id).boundingBox())!;
  const frame = element.type === 'rectangle' || element.type === 'highlight';
  const point = {
    x: box.x + (frame ? 1 : box.width / 2),
    y: box.y + box.height / 2,
  };
  if (mobile()) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  if (mobile() && !(await inspector(page).isVisible()))
    await page
      .getByRole('button', { name: 'Configure ' + element.name, exact: true })
      .click();
  await expect(inspector(page)).toBeVisible();
}
async function svg(page: Page) {
  await closeInspector(page);
  await page.getByLabel('Board menu', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export image', exact: true }).click();
  return readFile((await (await download).path())!, 'utf8');
}
function annotation(
  type: 'text' | 'arrow' | 'rectangle' | 'highlight',
  x: number,
  y: number,
  width: number,
  height: number,
  z: number,
): BoardElement {
  return {
    id: type,
    type,
    name:
      type === 'text'
        ? 'Server label'
        : type === 'arrow'
          ? 'WAN Connection'
          : type === 'rectangle'
            ? 'Cabinet A'
            : 'Server region',
    x,
    y,
    width,
    height,
    z,
    color: '',
    properties: {
      text: type === 'text' ? 'Server Infrastructure' : '',
      textColor: '#d8e5dc',
      fontSize: 24,
      align: 'left',
      fillColor: type === 'highlight' ? '#56a77c' : '',
      fillOpacity: type === 'highlight' ? 0.14 : 0,
      strokeColor: '#78b8dc',
      strokeWidth: 2,
      cornerRadius: 8,
      startX: 0,
      startY: 0.5,
      endX: 1,
      endY: 0.5,
      arrowhead: true,
    },
  };
}
function fixture(): BoardDocument {
  const document = emptyBoardDocument();
  document.grid = false;
  document.viewport = { x: 16, y: 30, zoom: mobile() ? 0.35 : 0.9 };
  document.elements = [
    annotation('highlight', 20, 140, 900, 320, 0),
    annotation('rectangle', 620, 200, 240, 220, 1),
    {
      id: 'router',
      type: 'device',
      name: 'Synthetic Router',
      x: 260,
      y: 200,
      width: 320,
      height: 220,
      z: 2,
      color: '#24332b',
      properties: {
        deviceType: 'Router',
        manufacturer: 'Synthetic',
        managementAddress: '192.0.2.1',
      },
    },
    {
      id: 'summary',
      type: 'summary',
      name: 'Summary',
      x: 620,
      y: 500,
      width: 300,
      height: 220,
      z: 3,
      color: '',
      properties: { linkedDeviceId: 'router' },
    },
    annotation('arrow', 80, 500, 440, 40, 4),
    annotation('text', 40, 40, 380, 72, 5),
  ];
  document.ports = [
    makeBoardPort('router', 'rj45', 0, 0, 'Port 1'),
    makeBoardPort('router', 'sfp_plus', 0, 1, 'Port 2'),
  ];
  document.cables = [
    {
      id: 'documented-cable',
      sourcePortId: document.ports[0]!.id,
      targetPortId: document.ports[1]!.id,
      name: 'Documented connection',
      cableType: 'Cat6A',
      sourceConnector: '',
      targetConnector: '',
      color: '#aebec8',
      length: '',
      notes: 'Annotation operations must preserve this stable connection',
    },
  ];
  return document;
}

test('dock creates all annotations, edits relevant fields and persists safe text through JSON and SVG', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const document = emptyBoardDocument();
  document.viewport = { x: 16, y: 16, zoom: mobile() ? 0.55 : 1 };
  const board = await setup(page, document);
  const canvas = (await page.getByTestId('board-canvas').boundingBox())!;
  const placements = [
    { type: 'text', label: 'Text', a: [60, 130], b: [60, 130] },
    { type: 'arrow', label: 'Arrow', a: [40, 290], b: [270, 300] },
    { type: 'rectangle', label: 'Rectangle', a: [30, 370], b: [180, 480] },
    {
      type: 'highlight',
      label: 'Highlight Region',
      a: [210, 130],
      b: [330, 250],
    },
  ] as const;
  for (const placement of placements) {
    await closeInspector(page);
    await page.getByRole('button', { name: 'Add object', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Equipment Dock', exact: true })
      .getByRole('button', { name: placement.label, exact: true })
      .click();
    const a = { x: canvas.x + placement.a[0], y: canvas.y + placement.a[1] };
    const b = { x: canvas.x + placement.b[0], y: canvas.y + placement.b[1] };
    if (placement.type === 'text') {
      if (mobile()) await page.touchscreen.tap(a.x, a.y);
      else await page.mouse.click(a.x, a.y);
    } else await drag(page, a, b);
    await saved(page);
    const element = (await read(page, board.id)).document.elements.find(
      (item) => item.type === placement.type,
    )!;
    expect(element).toBeTruthy();
    await expect(object(page, element.id)).toHaveAttribute(
      'data-annotation-type',
      placement.type,
    );
    await expect(inspector(page)).toBeVisible();
    if (placement.type === 'text') {
      await inspector(page)
        .getByLabel('Text', { exact: true })
        .fill('Server Infrastructure');
      await inspector(page).getByLabel('Font size', { exact: true }).fill('28');
      await inspector(page)
        .getByLabel('Text color', { exact: true })
        .fill('#d8e5dc');
      await inspector(page)
        .getByLabel('Alignment', { exact: true })
        .selectOption('center');
    } else {
      await inspector(page)
        .getByLabel('Label', { exact: true })
        .fill(
          placement.type === 'arrow'
            ? 'WAN Connection'
            : placement.type === 'rectangle'
              ? 'Equipment Cabinet A'
              : 'Management Network',
        );
      if (placement.type === 'arrow') {
        await inspector(page)
          .getByLabel('Line color', { exact: true })
          .fill('#78b8dc');
        await inspector(page)
          .getByLabel('Line width', { exact: true })
          .fill('3');
      } else {
        if (placement.type === 'rectangle')
          await inspector(page)
            .getByLabel('Show fill', { exact: true })
            .check();
        await inspector(page)
          .getByLabel('Fill color', { exact: true })
          .fill('#56a77c');
        await inspector(page)
          .getByLabel('Fill opacity (%)', { exact: true })
          .fill('20');
      }
    }
    await saved(page);
    await closeInspector(page);
    await page.screenshot({
      path: info.outputPath(placement.type + '-annotation.png'),
    });
  }
  let current = await read(page, board.id);
  expect(current.document.elements).toHaveLength(4);
  const text = current.document.elements.find(
    (element) => element.type === 'text',
  )!;
  if (!mobile()) {
    await closeInspector(page);
    await object(page, text.id).dblclick();
    const inline = page.getByLabel('Annotation text', { exact: true });
    await inline.fill('Server Infrastructure edited inline');
    await inline.press('Control+Enter');
    await saved(page);
    expect(
      (await read(page, board.id)).document.elements.find(
        (element) => element.id === text.id,
      )!.properties.text,
    ).toBe('Server Infrastructure edited inline');
  }
  await select(page, text);
  if (mobile())
    await page.screenshot({
      path: info.outputPath('mobile-annotation-editing.png'),
    });
  const unsafe =
    '<img src=x onerror="window.__annotationExecuted=true"> Server Infrastructure';
  // The exported text must be visible on the live board rather than clipped
  // below the annotation's user-controlled fixed bounds.
  await openSection(page, 'Position and size');
  await inspector(page).getByLabel('Width', { exact: true }).fill('360');
  await inspector(page).getByLabel('Height', { exact: true }).fill('200');
  await inspector(page).getByLabel('Text', { exact: true }).fill(unsafe);
  await saved(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __annotationExecuted?: boolean })
          .__annotationExecuted,
    ),
  ).toBeUndefined();
  await expect(object(page, text.id).locator('img,script')).toHaveCount(0);
  const image = await svg(page);
  const content = await page.evaluate((source) => {
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    return {
      unsafe: parsed.querySelectorAll(
        'script,img,image,foreignObject,[onerror]',
      ).length,
      text: parsed.documentElement.textContent,
    };
  }, image);
  for (const label of [
    'Server Infrastructure',
    'WAN Connection',
    'Equipment Cabinet A',
    'Management Network',
  ])
    expect(content.text).toContain(label);
  expect(content.unsafe).toBe(0);
  expect(content.text).toContain('<img');
  expect(content.text).toContain('onerror');
  const archiveResponse = await page.request.get(
    '/api/v1/boards/' + board.id + '/export',
  );
  expect(archiveResponse.status()).toBe(200);
  const importedResponse = await request(
    page,
    'POST',
    '/boards/import',
    await archiveResponse.json(),
  );
  expect(importedResponse.status()).toBe(201);
  const imported: BoardRecord = (await importedResponse.json()).board;
  const duplicatedResponse = await request(
    page,
    'POST',
    '/boards/' + board.id + '/duplicate',
    {},
  );
  expect(duplicatedResponse.status()).toBe(201);
  const duplicated: BoardRecord = (await duplicatedResponse.json()).board;
  current = await read(page, board.id);
  for (const copy of [imported, duplicated]) {
    expect(copy.id).not.toBe(current.id);
    expect(
      copy.document.elements.map(({ id: _id, ...element }) => element),
    ).toEqual(
      current.document.elements.map(({ id: _id, ...element }) => element),
    );
    expect(
      copy.document.elements.every(
        (element) =>
          !current.document.elements.some(
            (original) => original.id === element.id,
          ),
      ),
    ).toBe(true);
  }
  await page.reload();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(current.document);
  await expect(page.locator('[data-annotation-type]')).toHaveCount(4);
});

test('annotation layers, endpoints, resizing and mixed movement preserve equipment and support undo', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const board = await setup(page, fixture());
  const initial = await read(page, board.id);
  const firstPort = page.locator('[data-port-id]').first();
  if (mobile()) await firstPort.tap();
  else await firstPort.click();
  await expect(
    inspector(page).getByLabel('Native VLAN', { exact: true }),
  ).toBeVisible();
  await closeInspector(page);
  await select(
    page,
    initial.document.elements.find((element) => element.id === 'highlight')!,
  );
  await openSection(page, 'Order');
  await inspector(page)
    .getByRole('button', { name: 'Bring to front', exact: true })
    .click();
  await saved(page);
  let current = await read(page, board.id);
  const layers = await page.evaluate(() => ({
    region: Number(
      getComputedStyle(
        document.querySelector('[data-board-element-id="highlight"]')!,
      ).zIndex,
    ),
    device: Number(
      getComputedStyle(
        document.querySelector('[data-board-element-id="router"]')!,
      ).zIndex,
    ),
  }));
  expect(layers.region).toBeLessThan(layers.device);
  await closeInspector(page);
  // Even a foreground region must let users reach equipment through its fill.
  if (mobile()) await firstPort.tap();
  else await firstPort.click();
  await expect(
    inspector(page).getByLabel('Native VLAN', { exact: true }),
  ).toBeVisible();
  await closeInspector(page);
  await select(
    page,
    current.document.elements.find((element) => element.id === 'highlight')!,
  );
  await openSection(page, 'Order');
  await inspector(page)
    .getByRole('button', { name: 'Send to back', exact: true })
    .click();
  await saved(page);
  await closeInspector(page);
  await page.screenshot({
    path: info.outputPath('highlight-behind-equipment.png'),
  });
  await select(
    page,
    initial.document.elements.find((element) => element.id === 'arrow')!,
  );
  if (mobile()) await closeInspector(page);
  else
    await inspector(page).getByLabel('Line width', { exact: true }).fill('17');
  const endpointBox = (await page
    .getByRole('button', { name: 'Arrow end', exact: true })
    .boundingBox())!;
  await drag(
    page,
    {
      x: endpointBox.x + endpointBox.width / 2,
      y: endpointBox.y + endpointBox.height / 2,
    },
    {
      x: endpointBox.x + endpointBox.width / 2 - 24,
      y: endpointBox.y + endpointBox.height / 2 + 25,
    },
  );
  await saved(page);
  current = await read(page, board.id);
  expect(
    current.document.elements.find((element) => element.id === 'arrow'),
  ).not.toEqual(
    initial.document.elements.find((element) => element.id === 'arrow'),
  );
  if (!mobile())
    expect(
      current.document.elements.find((element) => element.id === 'arrow')!
        .properties.strokeWidth,
    ).toBe(16);
  const rectangle = current.document.elements.find(
    (element) => element.id === 'rectangle',
  )!;
  await select(page, rectangle);
  await openSection(page, 'Order');
  await inspector(page)
    .getByRole('button', { name: 'Bring to front', exact: true })
    .click();
  await saved(page);
  const raised = (await read(page, board.id)).document.elements;
  expect(
    raised.find((element) => element.id === rectangle.id)!.z,
  ).toBeGreaterThan(raised.find((element) => element.id === 'router')!.z);
  await inspector(page)
    .getByRole('button', { name: 'Send to back', exact: true })
    .click();
  await saved(page);
  if (mobile()) await closeInspector(page);
  const resize = (await object(page, 'rectangle')
    .getByRole('button', { name: /Resize .* se$/ })
    .boundingBox())!;
  await drag(
    page,
    { x: resize.x + resize.width / 2, y: resize.y + resize.height / 2 },
    {
      x: resize.x + resize.width / 2 + 20,
      y: resize.y + resize.height / 2 + 18,
    },
  );
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements.find(
      (element) => element.id === 'rectangle',
    )!.width,
  ).toBeGreaterThan(rectangle.width);
  if (mobile()) {
    const text = current.document.elements.find(
      (element) => element.id === 'text',
    )!;
    await select(page, text);
    await closeInspector(page);
    const box = (await page
      .getByRole('button', { name: 'Move ' + text.name, exact: true })
      .boundingBox())!;
    await drag(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + box.width / 2 + 24, y: box.y + box.height / 2 + 18 },
    );
    await saved(page);
    expect(
      (await read(page, board.id)).document.elements.find(
        (element) => element.id === text.id,
      )!.x,
    ).not.toBe(text.x);
    await page.screenshot({
      path: info.outputPath('mobile-annotation-move-handle.png'),
    });
  } else {
    const canvas = (await page.getByTestId('board-canvas').boundingBox())!;
    const camera = (await read(page, board.id)).document.viewport;
    const world = (x: number, y: number) => ({
      x: canvas.x + camera.x + x * camera.zoom,
      y: canvas.y + camera.y + y * camera.zoom,
    });
    await drag(page, world(25, 36), world(590, 435));
    const selected = await page
      .locator('[data-board-element-id][data-selected="true"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-board-element-id')).sort(),
      );
    expect(selected).toEqual(['router', 'text']);
    await page.screenshot({
      path: info.outputPath('multiple-selected-annotations-and-device.png'),
    });
    const before = (await read(page, board.id)).document;
    const header = (await object(page, 'router')
      .locator('.board-element-header')
      .boundingBox())!;
    await page.keyboard.down('Alt');
    await drag(
      page,
      { x: header.x + header.width - 12, y: header.y + header.height - 10 },
      {
        x: header.x + header.width - 12 + 32,
        y: header.y + header.height - 10 + 24,
      },
    );
    await page.keyboard.up('Alt');
    await saved(page);
    const after = (await read(page, board.id)).document;
    for (const id of ['router', 'text']) {
      const a = before.elements.find((element) => element.id === id)!,
        b = after.elements.find((element) => element.id === id)!;
      expect(b.x - a.x).toBeCloseTo(32 / camera.zoom);
      expect(b.y - a.y).toBeCloseTo(24 / camera.zoom);
    }
    expect(after.ports).toEqual(before.ports);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await saved(page);
    expect((await read(page, board.id)).document.elements).toEqual(
      before.elements,
    );
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await saved(page);
    expect((await read(page, board.id)).document.elements).toEqual(
      after.elements,
    );
  }
  current = await read(page, board.id);
  await select(
    page,
    current.document.elements.find((element) => element.id === 'text')!,
  );
  await inspector(page)
    .getByRole('button', { name: 'Duplicate', exact: true })
    .click();
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements.filter(
      (element) => element.type === 'text',
    ),
  ).toHaveLength(2);
  await inspector(page)
    .getByRole('button', { name: 'Delete text', exact: true })
    .click();
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements.filter(
      (element) => element.type === 'text',
    ),
  ).toHaveLength(1);
  await page.reload();
  await saved(page);
  const reloaded = await read(page, board.id);
  expect(reloaded.document.ports).toEqual(initial.document.ports);
  expect(reloaded.document.cables).toEqual(initial.document.cables);
});

test('keyboard placement, inline editing and cancelling a tool preserve a single annotation', async ({
  page,
}) => {
  const board = await setup(page);
  async function arm(label: string) {
    await closeInspector(page);
    await page.getByRole('button', { name: 'Add object', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Equipment Dock', exact: true })
      .getByRole('button', { name: label, exact: true })
      .click();
    await page.getByTestId('board-canvas').focus();
  }
  await arm('Text');
  await page.keyboard.press('Enter');
  await saved(page);
  const first = (await read(page, board.id)).document.elements[0]!;
  await expect(object(page, first.id)).toBeVisible();
  await object(page, first.id).focus();
  await page.keyboard.press('F2');
  const editor = page.getByLabel('Annotation text', { exact: true });
  await editor.fill('Keyboard annotation');
  await editor.press('Control+Enter');
  await saved(page);
  const before = (await read(page, board.id)).document;
  expect(before.elements[0]!.properties.text).toBe('Keyboard annotation');
  await arm('Arrow');
  await page.keyboard.press('Escape');
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(before);
});

test('keyboard face controls do not place an armed annotation', async ({
  page,
}) => {
  const board = await setup(page, fixture());
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Equipment Dock', exact: true })
    .getByRole('button', { name: 'Arrow', exact: true })
    .click();
  const rear = object(page, 'router').getByRole('button', {
    name: 'Rear',
    exact: true,
  });
  await rear.focus();
  await page.keyboard.press('Enter');
  await saved(page);
  const current = (await read(page, board.id)).document;
  expect(current.elements).toHaveLength(fixture().elements.length);
  expect(
    current.elements.find((element) => element.id === 'router')!.properties
      .face,
  ).toBe('rear');
  await page.keyboard.press('Escape');
});

test('long arrows stay axis-aligned through drawing, off-center endpoint grabs and reload', async ({
  page,
}, info) => {
  const document = emptyBoardDocument();
  document.viewport = { x: 16.25, y: 24.5, zoom: mobile() ? 0.35 : 1 };
  const board = await setup(page, document);
  const canvas = (await page.getByTestId('board-canvas').boundingBox())!;
  async function armArrow() {
    await closeInspector(page);
    await page.getByRole('button', { name: 'Add object', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Equipment Dock', exact: true })
      .getByRole('button', { name: 'Arrow', exact: true })
      .click();
  }
  await armArrow();
  const start = { x: canvas.x + 116.3, y: canvas.y + 130.7 };
  await drag(page, start, {
    x: start.x + 12,
    y: canvas.y + canvas.height - 90,
  });
  await saved(page);
  let current = await read(page, board.id);
  const vertical = current.document.elements[0]!;
  const points = annotationEndpoints(vertical);
  expect(points.start.x).toBe(points.end.x);
  expect(points.end.y - points.start.y).toBeGreaterThan(350);
  expect(points.start.x).toBeCloseTo(
    (116.3 - document.viewport.x) / document.viewport.zoom,
    2,
  );
  await expect(
    object(page, vertical.id).locator('.board-annotation-shape line'),
  ).toHaveAttribute('x1', '8');
  await expect(
    object(page, vertical.id).locator('.board-annotation-shape line'),
  ).toHaveAttribute('x2', '8');
  if (mobile()) await closeInspector(page);
  const handle = (await page
    .getByRole('button', { name: 'Arrow end', exact: true })
    .boundingBox())!;
  const grab = {
    x: handle.x + handle.width / 2,
    y: handle.y + handle.height / 2 + 6,
  };
  await drag(page, grab, {
    x: grab.x,
    y: grab.y - 56 * document.viewport.zoom,
  });
  await saved(page);
  current = await read(page, board.id);
  const adjusted = annotationEndpoints(
    current.document.elements.find((element) => element.id === vertical.id)!,
  );
  expect(adjusted.start).toEqual(points.start);
  expect(adjusted.end.x).toBe(adjusted.start.x);
  expect(adjusted.end.y).toBeCloseTo(points.end.y - 56, 3);
  await page.screenshot({
    path: info.outputPath('straight-vertical-arrow.png'),
  });

  await armArrow();
  const horizontalStart = { x: canvas.x + 75.3, y: canvas.y + 310.5 };
  await drag(page, horizontalStart, {
    x: canvas.x + canvas.width - 40,
    y: horizontalStart.y + 7,
  });
  await saved(page);
  current = await read(page, board.id);
  const horizontal = current.document.elements.find(
    (element) => element.id !== vertical.id,
  )!;
  const across = annotationEndpoints(horizontal);
  expect(across.start.y).toBe(across.end.y);
  expect(across.end.x).toBeGreaterThan(across.start.x);

  if (!mobile()) {
    await armArrow();
    await page.keyboard.down('Shift');
    try {
      await drag(
        page,
        { x: canvas.x + 300.3, y: canvas.y + 150.5 },
        { x: canvas.x + 400, y: canvas.y + 650 },
      );
    } finally {
      await page.keyboard.up('Shift');
    }
    await saved(page);
    const forced = (await read(page, board.id)).document.elements.at(-1)!;
    const aligned = annotationEndpoints(forced);
    expect(aligned.start.x).toBe(aligned.end.x);
  }
  const beforeReload = (await read(page, board.id)).document;
  await page.reload();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(beforeReload);
  expect(
    annotationEndpoints(
      (await read(page, board.id)).document.elements.find(
        (element) => element.id === vertical.id,
      )!,
    ),
  ).toEqual(adjusted);
});
