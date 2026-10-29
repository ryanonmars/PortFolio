import { expect, test, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardPort,
  type BoardRecord,
} from '../../packages/shared/src/board.js';

test.use({ actionTimeout: 15_000 });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
async function login(page: Page) {
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
}
async function saved(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
}
async function closeInspector(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
}
async function collapse(page: Page) {
  const button = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await button.isVisible()) await button.click();
}
async function read(page: Page, id: string): Promise<BoardRecord> {
  const response = await page.request.get(`/api/v1/boards/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).board;
}
async function create(page: Page, document: BoardDocument) {
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: 'Summary QA ' + randomUUID().slice(0, 8), document },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).board as BoardRecord;
}
async function open(page: Page, id: string) {
  await page.goto(`/boards/${id}`);
  await saved(page);
  await collapse(page);
}
test('Summary is available from the Equipment Dock', async ({ page }) => {
  await login(page);
  const board = await create(page, emptyBoardDocument());
  await open(page, board.id);
  await collapse(page);
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Equipment Dock', exact: true })
      .getByRole('button', { name: 'Summary', exact: true }),
  ).toBeVisible();
});

function sourceDocument(count = 8): BoardDocument {
  const document = emptyBoardDocument();
  document.grid = false;
  document.viewport = { x: 20, y: 20, zoom: 0.75 };
  document.elements = [
    {
      id: 'router',
      type: 'device',
      name: 'Reference Router',
      x: 20,
      y: 20,
      width: 1000,
      height: 550,
      z: 0,
      color: '#3e8bed',
      properties: {
        deviceType: 'Router',
        manufacturer: 'Synthetic Maker',
        model: 'Model 48',
        managementAddress: 'router.example',
        notes: 'Long authored device notes '.repeat(12),
        customFields: { Capacity: 0, Monitored: false },
      },
    },
    {
      id: 'peer',
      type: 'device',
      name: 'Peer Switch',
      x: 1100,
      y: 20,
      width: 300,
      height: 220,
      z: 1,
      color: '',
      properties: {},
    },
  ];
  document.ports = Array.from({ length: count }, (_, index): BoardPort => ({
    id: `router-port-${index}`,
    deviceId: 'router',
    name: `Port ${index + 1}`,
    face: index % 2 ? 'rear' : 'front',
    row: Math.floor(index / 12),
    column: index % 12,
    kind: index === 0 ? 'sfp_plus' : index === 1 ? 'sfp' : 'rj45',
    color: index % 2 ? '#37ef29' : '#428deb',
    role: `Purpose ${index + 1}`,
    speed: '10G',
    linkState: 'Down',
    nativeVlan: '0',
    taggedVlans: ['20', '30'],
    pvid: '0',
    address: `192.0.2.${index + 1}`,
    externalDestination: 'Authored external destination',
    notes: index === 0 ? 'Long port notes '.repeat(30) : '',
    customFields: {
      Enabled: false,
      Count: 0,
      Long: index === 0 ? 'abcdef'.repeat(70) : '',
    },
  }));
  document.ports.push({
    ...document.ports[0]!,
    id: 'peer-port',
    deviceId: 'peer',
    name: 'Uplink',
    row: 0,
    column: 0,
    face: 'front',
    notes: '',
  });
  document.cables = [
    {
      id: 'uplink',
      sourcePortId: document.ports[0]!.id,
      targetPortId: 'peer-port',
      name: 'Documented uplink',
      cableType: 'Cat6A',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    },
  ];
  return document;
}
async function selectSummary(page: Page, summary: Locator) {
  await closeInspector(page);
  await collapse(page);
  const header = summary.locator('.board-element-header');
  const box = await header.boundingBox();
  if (!box) throw new Error('Summary header missing');
  await header.click({
    position: {
      x: Math.max(0.5, box.width - 1),
      y: Math.max(0.5, box.height - 1),
    },
  });
  await expect(inspector(page)).toBeVisible();
}
async function summaryLayout(summary: Locator) {
  return summary.evaluate((node) => {
    const content = node.querySelector<HTMLElement>('.board-summary-content')!;
    const box = content.getBoundingClientRect();
    const tiles = [
      ...content.querySelectorAll<HTMLElement>('.board-summary-tile'),
    ];
    return {
      width: (node as HTMLElement).style.width,
      height: (node as HTMLElement).style.height,
      scrollWidth: content.scrollWidth,
      clientWidth: content.clientWidth,
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      horizontalOverflow: tiles.some((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.left < box.left - 1 || rect.right > box.right + 1;
      }),
      accordions: content.querySelectorAll('details').length,
    };
  });
}
async function compareSummarySvg(
  page: Page,
  svg: string,
  element: { x: number; y: number; width: number; height: number },
  label: string,
) {
  const viewport = page.viewportSize()!;
  const previous = await page.evaluate(({ x, y, width, height }) => {
    const canvas = document.querySelector<HTMLElement>('.board-canvas')!;
    const world = document.querySelector<HTMLElement>('.board-world')!;
    const previous = {
      canvas: canvas.style.cssText,
      world: world.style.cssText,
    };
    Object.assign(canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${width}px`,
      height: `${height}px`,
      minHeight: '0',
      zIndex: '99999',
    });
    world.style.transform = `translate(${-x}px,${-y}px) scale(1)`;
    document
      .querySelectorAll<HTMLElement>('.board-summary-content')
      .forEach((node) => (node.scrollTop = 0));
    return previous;
  }, element);
  try {
    await page.setViewportSize({
      width: Math.max(800, element.width + 20),
      height: Math.max(600, element.height + 20),
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const live = await page.locator('.board-canvas').screenshot();
    const comparison = await page.evaluate(
      async ({ svg, reference, element }) => {
        const root = new DOMParser().parseFromString(
          svg,
          'image/svg+xml',
        ).documentElement;
        const view = root.getAttribute('viewBox')!.split(/[ ,]+/).map(Number);
        const image = async (src: string) => {
          const value = new Image();
          value.src = src;
          await value.decode();
          return value;
        };
        const vector = await image(
          'data:image/svg+xml,' + encodeURIComponent(svg),
        );
        const original = await image('data:image/png;base64,' + reference);
        const canvas = document.createElement('canvas');
        canvas.width = element.width;
        canvas.height = element.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(
          vector,
          element.x - view[0]!,
          element.y - view[1]!,
          element.width,
          element.height,
          0,
          0,
          element.width,
          element.height,
        );
        const png = canvas.toDataURL('image/png').split(',')[1]!;
        const actual = context.getImageData(
          0,
          0,
          element.width,
          element.height,
        ).data;
        context.clearRect(0, 0, element.width, element.height);
        context.drawImage(original, 0, 0, element.width, element.height);
        const expected = context.getImageData(
          0,
          0,
          element.width,
          element.height,
        ).data;
        let difference = 0;
        for (let i = 0; i < actual.length; i += 4)
          for (let channel = 0; channel < 3; channel++)
            difference += Math.abs(
              actual[i + channel]! - expected[i + channel]!,
            );
        return {
          png,
          error: difference / (element.width * element.height * 3),
        };
      },
      { svg, reference: live.toString('base64'), element },
    );
    await writeFile(`.tmp/qa-media/summary/${label}-live-crop.png`, live);
    await writeFile(
      `.tmp/qa-media/summary/${label}-export-crop.png`,
      Buffer.from(comparison.png, 'base64'),
    );
    console.log(
      `${label} Summary SVG mean RGB error ${comparison.error.toFixed(3)}`,
    );
    expect(comparison.error).toBeLessThan(4);
  } finally {
    await page.evaluate((previous) => {
      document.querySelector<HTMLElement>('.board-canvas')!.style.cssText =
        previous.canvas;
      document.querySelector<HTMLElement>('.board-world')!.style.cssText =
        previous.world;
    }, previous);
    await page.setViewportSize(viewport);
  }
}

test('linked Summary stays synchronized, scrolls inside fixed dimensions and preserves references through board operations', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const board = await create(page, sourceDocument());
  await create(page, {
    ...emptyBoardDocument(),
    elements: [
      {
        id: 'foreign-device',
        type: 'device',
        name: 'Unrelated board device',
        x: 0,
        y: 0,
        width: 160,
        height: 220,
        z: 0,
        color: '',
        properties: {},
      },
    ],
  });
  await open(page, board.id);
  await page.getByRole('button', { name: 'Add object', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Equipment Dock', exact: true })
    .getByRole('button', { name: 'Summary', exact: true })
    .click();
  await saved(page);
  const created = (await read(page, board.id)).document.elements.find(
    (element) => element.type === 'summary',
  );
  expect(created).toMatchObject({ width: 640, height: 480 });
  const summary = page.locator(`[data-board-element-id="${created!.id}"]`);
  const linked = inspector(page).getByLabel('Linked Device', { exact: true });
  await expect(linked).toBeVisible();
  await expect(linked.locator('option')).not.toContainText([
    'Unrelated board device',
  ]);
  await linked.selectOption('router');
  await saved(page);
  await expect(summary).toContainText('Reference Router');
  await expect(summary.locator('.board-summary-port')).toHaveCount(8);
  for (const value of [
    'Synthetic Maker',
    'Model 48',
    'router.example',
    'Capacity',
    'Monitored',
    'false',
    'Down',
    '192.0.2.1',
    'Authored external destination',
    '20, 30',
    'Peer Switch',
  ])
    await expect(summary).toContainText(value);
  const firstPort = summary
    .locator('.board-summary-port')
    .filter({ hasText: 'Purpose 1' });
  await expect(firstPort).toContainText('PVID');
  await expect(firstPort).toContainText('0');
  await expect(summary).toContainText('Front');
  await expect(summary).toContainText('Rear');
  await closeInspector(page);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await saved(page);
  const originalCamera = (await read(page, board.id)).document.viewport;
  // Inspect a physical header at a usable zoom before dragging it on a phone.
  await replace((document) => {
    document.viewport = { x: 24 - created!.x, y: 120 - created!.y, zoom: 1 };
  });
  const beforeDrag = await read(page, board.id);
  const dragHeader = await summary
    .locator('.board-element-header')
    .boundingBox();
  if (!dragHeader) throw new Error('Missing Summary drag header');
  await page.keyboard.down('Alt');
  await page.mouse.move(
    dragHeader.x + Math.min(120, dragHeader.width / 2),
    dragHeader.y + 6,
  );
  await page.mouse.down();
  await page.mouse.move(
    dragHeader.x + Math.min(120, dragHeader.width / 2) + 20,
    dragHeader.y + 18,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved(page);
  const afterDrag = await read(page, board.id);
  const oldSummary = beforeDrag.document.elements.find(
    (element) => element.id === created!.id,
  )!;
  const movedSummary = afterDrag.document.elements.find(
    (element) => element.id === created!.id,
  )!;
  expect([movedSummary.x, movedSummary.y]).not.toEqual([
    oldSummary.x,
    oldSummary.y,
  ]);
  expect([movedSummary.width, movedSummary.height]).toEqual([
    oldSummary.width,
    oldSummary.height,
  ]);
  expect(
    afterDrag.document.elements.filter((element) => element.type !== 'summary'),
  ).toEqual(
    beforeDrag.document.elements.filter(
      (element) => element.type !== 'summary',
    ),
  );
  expect(afterDrag.document.ports).toEqual(beforeDrag.document.ports);
  expect(afterDrag.document.cables).toEqual(beforeDrag.document.cables);
  await closeInspector(page);
  async function replace(change: (document: BoardDocument) => void) {
    const current = await read(page, board.id);
    const document = structuredClone(current.document);
    change(document);
    const auth = await (await page.request.get('/api/v1/auth/session')).json();
    const response = await page.request.patch(`/api/v1/boards/${board.id}`, {
      headers: {
        Origin: new URL(page.url()).origin,
        'x-csrf-token': auth.csrfToken,
      },
      data: { rowVersion: current.rowVersion, document },
    });
    expect(response.status()).toBe(200);
    await page.reload();
    await saved(page);
    await collapse(page);
  }
  await replace((document) => {
    const element = document.elements.find((item) => item.id === created!.id)!;
    element.x = 1100;
    element.y = 300;
    document.viewport = originalCamera;
  });
  await mkdir('.tmp/qa-media/summary', { recursive: true });
  for (const count of [8, 24, 48]) {
    if (count !== 8)
      await replace((document) => {
        document.ports = sourceDocument(count).ports;
      });
    await expect(summary.locator('.board-summary-port')).toHaveCount(count);
    const layout = await summaryLayout(summary);
    expect(layout.width).toBe('640px');
    expect(layout.height).toBe('480px');
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.horizontalOverflow).toBe(false);
    expect(layout.accordions).toBe(0);
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    const beforeScroll = await read(page, board.id);
    const body = summary.locator('.board-summary-content');
    await body.hover();
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => body.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect
      .poll(() => body.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await expect(summary.locator('.board-summary-port').last()).toContainText(
      `Port ${count}`,
    );
    expect((await read(page, board.id)).document).toEqual(
      beforeScroll.document,
    );
    await body.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await saved(page);
    await page.screenshot({
      path: `.tmp/qa-media/summary/${info.project.name}-${count}-ports.png`,
    });
  }
  // Resizing changes only the user-controlled dimensions and available scroll area.
  const scrollBody = summary.locator('.board-summary-content');
  const beforeKeys = await read(page, board.id);
  await scrollBody.focus();
  await scrollBody.press('Delete');
  await scrollBody.press('Backspace');
  await scrollBody.press('ArrowDown');
  expect((await read(page, board.id)).document).toEqual(beforeKeys.document);
  if (info.project.name.startsWith('mobile')) {
    await scrollBody.evaluate((node) => {
      node.scrollTop = 0;
    });
    const box = await scrollBody.boundingBox();
    if (!box) throw new Error('Summary scroll area missing');
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2,
      startY = box.y + Math.min(box.height - 8, 90);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY }],
    });
    for (let step = 1; step <= 6; step++)
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY - step * 8 }],
      });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect
      .poll(() => scrollBody.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    expect((await read(page, board.id)).document).toEqual(beforeKeys.document);
    await client.detach();
  }
  await scrollBody.evaluate((node) => {
    node.scrollTop = 0;
  });
  await selectSummary(page, summary);
  const resize = page.getByRole('button', {
    name: 'Resize Summary e',
    exact: true,
  });
  for (let index = 0; index < 8; index++)
    await resize.press('Alt+Shift+ArrowLeft');
  await saved(page);
  let resized = await summaryLayout(summary);
  expect(resized.width).toBe('320px');
  expect(resized.height).toBe('480px');
  expect(resized.horizontalOverflow).toBe(false);
  expect(resized.scrollWidth).toBeLessThanOrEqual(resized.clientWidth + 1);
  await closeInspector(page);
  await page.screenshot({
    path: `.tmp/qa-media/summary/${info.project.name}-narrow.png`,
  });
  await selectSummary(page, summary);
  for (let index = 0; index < 8; index++)
    await resize.press('Alt+Shift+ArrowRight');
  await saved(page);
  await closeInspector(page);
  resized = await summaryLayout(summary);
  expect(resized.width).toBe('640px');
  expect(resized.height).toBe('480px');
  // Real inspector edits update the linked view immediately through the same document.
  const device = page.locator('[data-board-element-id="router"]');
  await selectSummary(page, device);
  await inspector(page)
    .getByLabel('Name', { exact: true })
    .fill('Renamed Router');
  await inspector(page)
    .getByLabel('Manufacturer', { exact: true })
    .fill('Updated Maker');
  await saved(page);
  await closeInspector(page);
  await expect(summary).toContainText('Renamed Router');
  await expect(summary).toContainText('Updated Maker');
  await page.locator('button[data-port-id="router-port-0"]').press('Enter');
  await expect(inspector(page)).toBeVisible();
  await inspector(page).getByLabel('Speed', { exact: true }).fill('25G');
  await inspector(page).getByLabel('PVID', { exact: true }).fill('77');
  await saved(page);
  await closeInspector(page);
  await expect(
    summary.locator('.board-summary-port[data-port-id="router-port-0"]'),
  ).toContainText('25G');
  await expect(
    summary.locator('.board-summary-port[data-port-id="router-port-0"]'),
  ).toContainText('77');
  await replace((document) => {
    const port = document.ports.find((item) => item.id === 'router-port-0')!;
    port.name = 'Changed uplink';
    port.kind = 'qsfp';
    port.role = 'Updated purpose';
    port.color = '#ef3434';
    port.row = 4;
    port.column = 1;
    document.elements.find((item) => item.id === 'router')!.height = 700;
  });
  await expect(summary).toContainText('Changed uplink');
  await expect(summary).toContainText('Updated purpose');
  await replace((document) => {
    document.ports = document.ports.filter(
      (port) => port.id !== 'router-port-47',
    );
  });
  await expect(summary.locator('.board-summary-port')).toHaveCount(47);
  await expect(summary).not.toContainText('Port 48');
  await selectSummary(page, summary);
  await inspector(page)
    .getByLabel('Linked Device', { exact: true })
    .selectOption('peer');
  await saved(page);
  await expect(summary.locator('.board-summary-port')).toHaveCount(1);
  await inspector(page)
    .getByLabel('Linked Device', { exact: true })
    .selectOption('');
  await saved(page);
  await expect(summary.locator('.board-summary-port')).toHaveCount(0);
  await inspector(page)
    .getByLabel('Linked Device', { exact: true })
    .selectOption('router');
  await saved(page);
  await inspector(page)
    .getByRole('button', { name: 'Duplicate', exact: true })
    .click();
  await saved(page);
  let summaries = (await read(page, board.id)).document.elements.filter(
    (element) => element.type === 'summary',
  );
  expect(summaries).toHaveLength(2);
  for (const element of summaries)
    expect(element.properties.linkedDeviceId).toBe('router');
  await closeInspector(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect(
    (await read(page, board.id)).document.elements.filter(
      (element) => element.type === 'summary',
    ),
  ).toHaveLength(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  summaries = (await read(page, board.id)).document.elements.filter(
    (element) => element.type === 'summary',
  );
  expect(summaries).toHaveLength(2);
  await replace((document) => {
    const copy = document.elements.find(
      (element) => element.type === 'summary' && element.id !== created!.id,
    )!;
    copy.y = 900;
  });
  // SVG shares the visible fixed-size container; its vectors are clipped, never rasterized.
  await page.getByLabel('Board menu', { exact: true }).click();
  const imageDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export image', exact: true }).click();
  const svg = await readFile((await (await imageDownload).path())!, 'utf8');
  expect(svg).toContain('Updated Maker');
  expect(svg).toContain('Port Configuration');
  expect(svg).toContain('clipPath');
  expect(svg).not.toMatch(/foreignObject|<image\b/);
  const exportPng = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = 'data:image/svg+xml,' + encodeURIComponent(source);
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error('SVG did not render independently');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, svg);
  await writeFile(
    `.tmp/qa-media/summary/${info.project.name}-export.png`,
    Buffer.from(exportPng, 'base64'),
  );
  const summaryElement = (await read(page, board.id)).document.elements.find(
    (element) => element.id === created!.id,
  )!;
  await compareSummarySvg(page, svg, summaryElement, info.project.name);
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const archive = JSON.parse(
    await readFile((await (await jsonDownload).path())!, 'utf8'),
  );
  await page.getByLabel('Board menu', { exact: true }).click();
  await page.getByLabel('Import board file', { exact: true }).setInputFiles({
    name: 'summary-board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await page
    .getByRole('dialog', { name: 'Import board preview', exact: true })
    .getByRole('button', { name: 'Import as new board', exact: true })
    .click();
  await saved(page);
  const importedId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(importedId).not.toBe(board.id);
  const imported = await read(page, importedId);
  const importedDevice = imported.document.elements.find(
    (element) => element.name === 'Renamed Router',
  )!;
  expect(importedDevice.id).not.toBe('router');
  for (const element of imported.document.elements.filter(
    (item) => item.type === 'summary',
  ))
    expect(element.properties.linkedDeviceId).toBe(importedDevice.id);
  await open(page, board.id);
  await replace((document) => {
    document.elements = document.elements.filter(
      (element) => element.id !== 'router',
    );
    document.ports = document.ports.filter(
      (port) => port.deviceId !== 'router',
    );
    document.cables = [];
  });
  await expect(summary).toContainText(/unavailable/i);
  expect(
    (await read(page, board.id)).document.elements.filter(
      (element) => element.type === 'summary',
    ),
  ).toHaveLength(2);
  await selectSummary(page, summary);
  await expect(
    inspector(page).getByLabel('Linked Device', { exact: true }),
  ).toHaveValue('router');
  await inspector(page)
    .getByLabel('Linked Device', { exact: true })
    .selectOption('peer');
  await saved(page);
  await closeInspector(page);
  await expect(summary).toContainText('Peer Switch');
  expect(errors).toEqual([]);
});
