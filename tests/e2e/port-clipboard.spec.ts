import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardPort,
  type BoardRecord,
} from '../../packages/shared/src/board.js';
import { makeBoardPort } from '../../apps/web/src/board/commands.js';

test.use({ actionTimeout: 15_000 });
const cookies = new Map<
  string,
  Awaited<ReturnType<BrowserContext['cookies']>>
>();
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Object inspector', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Port actions' });
const socket = (page: Page, id: string) =>
  page.locator(`button[data-port-id="${id}"]`);
const mobile = () => test.info().project.name.startsWith('mobile');
const targets = ['target-0', 'target-1', 'target-2'];

function fixture(): BoardDocument {
  const document = emptyBoardDocument();
  document.viewport = mobile()
    ? { x: 12, y: 60, zoom: 0.34 }
    : { x: 20, y: 20, zoom: 1 };
  document.elements = [
    {
      id: 'source-device',
      type: 'device',
      name: 'Source eight-port router',
      x: 20,
      y: 90,
      width: 640,
      height: 240,
      z: 0,
      color: '',
      properties: { deviceType: 'Router', manufacturer: 'Synthetic' },
    },
    {
      id: 'target-device',
      type: 'device',
      name: 'Destination 24-port switch',
      x: 20,
      y: 410,
      width: 1000,
      height: 360,
      z: 1,
      color: '',
      properties: { deviceType: 'Switch', manufacturer: 'Synthetic' },
    },
  ];
  document.ports = Array.from({ length: 8 }, (_, index) => ({
    ...makeBoardPort(
      'source-device',
      index === 0 ? 'sfp_plus' : 'rj45',
      0,
      index,
      `Source ${index + 1}`,
    ),
    id: `source-${index}`,
  }));
  Object.assign(document.ports[0]!, {
    role: 'LAN trunk',
    speed: '10G',
    linkState: 'up',
    nativeVlan: '20',
    taggedVlans: ['30', 'Guest voice'],
    pvid: '20',
    address: '',
    externalDestination: '',
    color: '',
    notes: '',
    customFields: {
      Zero: 0,
      Disabled: false,
      Tags: [],
      Nested: { value: 'source' },
      Empty: '',
    },
  });
  document.ports.push(
    ...Array.from({ length: 24 }, (_, index) => ({
      ...makeBoardPort(
        'target-device',
        'rj45',
        Math.floor(index / 12),
        index % 12,
        `Destination ${index + 1}`,
      ),
      id: `target-${index}`,
      role: 'Old purpose',
      speed: 'old speed',
      linkState: 'authored old state',
      nativeVlan: 'Old network',
      taggedVlans: ['Old tagged'],
      pvid: 'old PVID',
      address: `192.0.2.${index + 1}`,
      externalDestination: `Unique destination ${index}`,
      color: '#ef7733',
      notes: 'Old notes',
      customFields: {
        Keep: 'destination only',
        Zero: 9,
        Disabled: true,
        Tags: ['old'],
      },
    })),
  );
  document.cables = [
    {
      id: 'stable-cable',
      sourcePortId: 'source-0',
      targetPortId: 'target-0',
      name: 'Documented stable connection',
      cableType: 'Authored cable',
      sourceConnector: 'SFP+',
      targetConnector: 'RJ45',
      color: '#aabbcc',
      length: 'arbitrary length',
      notes: 'Never copied or replaced',
    },
  ];
  return document;
}

async function saved(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('.board-save-status')).toHaveText('Saved');
  await expect(page.locator('.board-editor')).not.toHaveAttribute('inert', '');
}
async function login(page: Page, force = false) {
  const project = test.info().project.name;
  if (!force && cookies.has(project))
    await page.context().addCookies(cookies.get(project)!);
  await page.goto('/');
  if (force || !cookies.has(project)) {
    const status = await (
      await page.request.get('/api/v1/auth/setup-status')
    ).json();
    await page.getByLabel('Username', { exact: true }).fill('board-admin');
    await page
      .getByLabel('Password', { exact: true })
      .fill('Synthetic-board-password-42');
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
  cookies.set(project, await page.context().cookies());
}
async function create(page: Page, document = fixture(), navigate = true) {
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/boards', {
    headers: {
      Origin: new URL(page.url()).origin,
      'x-csrf-token': auth.csrfToken,
    },
    data: { name: `Clipboard ${randomUUID().slice(0, 8)}`, document },
  });
  expect(response.status()).toBe(201);
  const board = (await response.json()).board as BoardRecord;
  if (navigate) {
    await page.goto(`/boards/${board.id}`);
    await saved(page);
    await collapse(page);
  }
  return board;
}
async function setup(page: Page) {
  await login(page);
  return create(page);
}
async function read(page: Page, id: string): Promise<BoardRecord> {
  const response = await page.request.get(`/api/v1/boards/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).board;
}
async function collapse(page: Page) {
  const control = page.getByRole('button', {
    name: 'Collapse board browser',
    exact: true,
  });
  if (await control.isVisible()) await control.click();
}
async function closeInspector(page: Page) {
  if (await inspector(page).count())
    await inspector(page)
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
}
async function openMenu(page: Page, id: string) {
  if (mobile()) {
    const box = (await socket(page, id).boundingBox())!;
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 },
      ],
    });
    try {
      await expect(menu(page)).toBeVisible();
    } finally {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();
    }
  } else await socket(page, id).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
}
async function copyFull(page: Page, id = 'source-0') {
  await closeInspector(page);
  await openMenu(page, id);
  await menu(page)
    .getByRole('menuitem', { name: 'Copy Port Settings', exact: true })
    .click();
  await expect(
    page.getByText('Port settings copied', { exact: true }),
  ).toBeVisible();
  await closeInspector(page);
}
async function inspectPort(page: Page, id: string) {
  await page.keyboard.press('Escape');
  await closeInspector(page);
  if (mobile()) await socket(page, id).tap();
  else await socket(page, id).click();
  await expect(
    inspector(page).getByLabel('Port name', { exact: true }),
  ).toBeVisible();
}
async function copyField(
  page: Page,
  field: string,
  id = 'source-0',
  viaLabel = false,
) {
  await inspectPort(page, id);
  if (viaLabel)
    await inspector(page)
      .locator('label')
      .filter({
        hasText: new RegExp(
          `^${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        ),
      })
      .click();
  else
    await inspector(page)
      .getByRole('button', { name: `Copy ${field}`, exact: true })
      .click();
  await closeInspector(page);
}
async function selectPorts(page: Page, ids: string[]) {
  await page.keyboard.press('Escape');
  await closeInspector(page);
  if (mobile()) {
    await openMenu(page, ids[0]!);
    await menu(page)
      .getByRole('menuitem', { name: 'Select Multiple Ports', exact: true })
      .click();
    for (const id of ids.slice(1)) await socket(page, id).tap();
  } else {
    await socket(page, ids[0]!).click();
    for (const id of ids.slice(1))
      await socket(page, id).click({ modifiers: ['Meta'] });
  }
  expect(await selectedIds(page)).toEqual([...ids].sort());
}
async function selectedIds(page: Page) {
  return page
    .locator('.board-port[data-selected="true"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-board-port-id')).sort(),
    );
}
async function paste(page: Page, id: string, wait = true) {
  await openMenu(page, id);
  await expect(
    menu(page).getByRole('menuitem', { name: 'Paste Settings', exact: true }),
  ).toBeEnabled();
  await menu(page)
    .getByRole('menuitem', { name: 'Paste Settings', exact: true })
    .click();
  if (wait) await saved(page);
}
function settings(port: BoardPort) {
  const {
    kind,
    role,
    speed,
    linkState,
    nativeVlan,
    taggedVlans,
    pvid,
    address,
    externalDestination,
    color,
    notes,
    customFields,
  } = port;
  return {
    kind,
    role,
    speed,
    linkState,
    nativeVlan,
    taggedVlans,
    pvid,
    address,
    externalDestination,
    color,
    notes,
    customFields,
  };
}
function applyExpected(
  document: BoardDocument,
  ids: string[],
  changes: Partial<BoardPort>,
): BoardDocument {
  return {
    ...document,
    ports: document.ports.map((port) =>
      ids.includes(port.id) ? { ...port, ...structuredClone(changes) } : port,
    ),
  };
}

test('full settings copy is detached and pastes atomically across devices without changing identities or cables', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const board = await setup(page),
    initial = (await read(page, board.id)).document;
  await copyFull(page);
  // Editing the source after copying must not change the detached clipboard.
  await inspectPort(page, 'source-0');
  await inspector(page)
    .getByLabel('PVID', { exact: true })
    .fill('source changed after copy');
  await saved(page);
  await closeInspector(page);
  const before = (await read(page, board.id)).document;
  const destinationIds = [...targets, 'source-3'];
  await selectPorts(page, destinationIds);
  await openMenu(page, 'target-1');
  await expect(menu(page)).toContainText(/interface addresses|address/i);
  await expect(menu(page)).toContainText(/external connections|external/i);
  await page.screenshot({
    path: info.outputPath('selected-ports-context-menu.png'),
  });
  await menu(page)
    .getByRole('menuitem', { name: 'Paste Settings', exact: true })
    .click();
  await saved(page);
  const expected = applyExpected(
    before,
    destinationIds,
    settings(initial.ports[0]!),
  );
  expect((await read(page, board.id)).document).toEqual(expected);
  expect(await selectedIds(page)).toEqual(destinationIds.sort());
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(expected);
  await page.reload();
  await saved(page);
  await collapse(page);
  expect((await read(page, board.id)).document).toEqual(expected);
  await page.screenshot({
    path: info.outputPath('pasted-eight-and-twenty-four-port-board.png'),
  });
});

test('inspector labels copy individual fields including empty VLAN lists and raw empty colors while help stays separate', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const board = await setup(page);
  await inspectPort(page, 'source-0');
  await inspector(page)
    .locator('label')
    .filter({ hasText: /^PVID$/ })
    .click();
  await expect(page.getByText('PVID copied', { exact: true })).toBeVisible();
  const help = inspector(page).getByRole('button', {
    name: 'Help for Speed',
    exact: true,
  });
  await help.click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await closeInspector(page);
  let before = (await read(page, board.id)).document;
  await selectPorts(page, targets);
  await paste(page, 'target-1');
  expect((await read(page, board.id)).document).toEqual(
    applyExpected(before, targets, { pvid: '20' }),
  );
  await copyField(page, 'Tagged VLANs', 'source-1');
  before = (await read(page, board.id)).document;
  await selectPorts(page, ['target-0', 'target-2']);
  await paste(page, 'target-0');
  expect((await read(page, board.id)).document).toEqual(
    applyExpected(before, ['target-0', 'target-2'], { taggedVlans: [] }),
  );
  await copyField(page, 'Port color');
  before = (await read(page, board.id)).document;
  await selectPorts(page, ['target-1']);
  await paste(page, 'target-1');
  expect((await read(page, board.id)).document).toEqual(
    applyExpected(before, ['target-1'], { color: '' }),
  );
  await copyField(page, 'PVID', 'source-1');
  before = (await read(page, board.id)).document;
  await selectPorts(page, ['target-0']);
  await paste(page, 'target-0');
  expect((await read(page, board.id)).document).toEqual(
    applyExpected(before, ['target-0'], { pvid: '' }),
  );
  await page.screenshot({ path: info.outputPath('field-only-paste.png') });
});

test('custom field copying retains numeric zero, false and arrays without replacing other custom fields', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const board = await setup(page);
  for (const [key, value] of [
    ['Zero', 0],
    ['Disabled', false],
    ['Tags', []],
    ['Nested', { value: 'source' }],
  ] as const) {
    await inspectPort(page, 'source-0');
    const details = inspector(page)
      .locator('details')
      .filter({
        has: page.locator('summary').filter({ hasText: /^Custom fields$/ }),
      });
    await details.locator('summary').click();
    await details
      .getByRole('button', { name: `Copy custom field ${key}`, exact: true })
      .click();
    await closeInspector(page);
    const before = (await read(page, board.id)).document;
    await selectPorts(page, targets);
    await paste(page, 'target-0');
    const expected = {
      ...before,
      ports: before.ports.map((port) =>
        targets.includes(port.id)
          ? { ...port, customFields: { ...port.customFields, [key]: value } }
          : port,
      ),
    };
    expect((await read(page, board.id)).document).toEqual(expected);
  }
  await page.screenshot({ path: info.outputPath('custom-field-paste.png') });
});

test('port selection, context keyboard actions and application shortcuts preserve normal text editing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const board = await setup(page);
  await copyFull(page);
  if (!mobile()) {
    await socket(page, 'target-0').click();
    await socket(page, 'target-3').click({ modifiers: ['Shift'] });
    expect(await selectedIds(page)).toEqual([
      'target-0',
      'target-1',
      'target-2',
      'target-3',
    ]);
    await socket(page, 'source-4').click({ modifiers: ['Meta'] });
    expect(await selectedIds(page)).toEqual([
      'source-4',
      'target-0',
      'target-1',
      'target-2',
      'target-3',
    ]);
    await socket(page, 'source-4').click({ modifiers: ['Meta'] });
    expect(await selectedIds(page)).toEqual([
      'target-0',
      'target-1',
      'target-2',
      'target-3',
    ]);
    // A Shift range may not silently span different devices.
    await socket(page, 'source-2').click({ modifiers: ['Shift'] });
    expect(await selectedIds(page)).toEqual(['source-2']);
    await closeInspector(page);
    await page.keyboard.press('Escape');
    await socket(page, 'target-4').click({ modifiers: ['Shift'] });
    expect(await selectedIds(page)).toEqual(['target-4']);
    const header = page.locator(
      '[data-board-element-id="source-device"] .board-element-header',
    );
    await header.click({ position: { x: 10, y: 70 } });
    await socket(page, 'target-6').click({ modifiers: ['Shift'] });
    expect(await selectedIds(page)).toEqual(['target-6']);
    await closeInspector(page);
  }
  const beforeGesture = (await read(page, board.id)).document;
  const body = (await page
    .locator('[data-board-element-id="source-device"]')
    .boundingBox())!;
  await page.mouse.move(body.x + body.width / 2, body.y + body.height - 6);
  await page.mouse.down();
  await page.mouse.move(
    body.x + body.width / 2 + 18,
    body.y + body.height + 6,
    { steps: 5 },
  );
  await expect(page.getByTestId('board-canvas')).toHaveClass(/is-moving/);
  await socket(page, 'target-6').dispatchEvent('contextmenu', {
    button: 2,
    clientX: 100,
    clientY: 200,
  });
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(beforeGesture);
  await page.getByTestId('board-canvas').focus();
  await page.keyboard.down('Space');
  await socket(page, 'target-6').dispatchEvent('contextmenu', {
    button: 2,
    clientX: 100,
    clientY: 200,
  });
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.up('Space');
  await inspectPort(page, 'source-0');
  const input = inspector(page).getByLabel('PVID', { exact: true });
  await input.focus();
  // Synthetic keys verify event interception without reading the user's OS clipboard.
  const allowed = await input.evaluate((element) =>
    ['c', 'v'].map((key) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
  );
  expect(allowed).toEqual([true, true]);
  await expect(input).toHaveValue('20');
  const editableAllowed = await page.evaluate(() => {
    const editable = document.createElement('div');
    editable.contentEditable = 'plaintext-only';
    document.querySelector('.board-inspector-body')!.append(editable);
    editable.focus();
    const result = ['c', 'v'].map((key) =>
      editable.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    editable.remove();
    return result;
  });
  expect(editableAllowed).toEqual([true, true]);
  await closeInspector(page);
  const before = (await read(page, board.id)).document;
  if (!mobile()) {
    await socket(page, 'source-0').click();
    await socket(page, 'source-0').focus();
    await page.keyboard.press('Meta+c');
    await expect(
      page.getByText('Port settings copied', { exact: true }),
    ).toBeVisible();
    await closeInspector(page);
    await socket(page, 'target-5').click();
    await socket(page, 'target-5').focus();
    await page.keyboard.press('Control+v');
    await saved(page);
  } else {
    await selectPorts(page, ['target-5']);
    await paste(page, 'target-5');
  }
  expect((await read(page, board.id)).document).toEqual(
    applyExpected(before, ['target-5'], settings(before.ports[0]!)),
  );
  await closeInspector(page);
  if (!mobile()) {
    await socket(page, 'target-6').focus();
    await page.keyboard.press('Shift+F10');
  } else await openMenu(page, 'target-6');
  await expect(menu(page)).toBeVisible();
  const beforeMenuKeys = (await read(page, board.id)).document;
  const copyAction = menu(page).getByRole('menuitem', {
    name: 'Copy Port Settings',
    exact: true,
  });
  await copyAction.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    menu(page).getByRole('menuitem', {
      name: 'Paste Settings',
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(copyAction).toBeFocused();
  const fits = await menu(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return (
      box.left >= 0 &&
      box.top >= 0 &&
      box.right <= innerWidth + 1 &&
      box.bottom <= innerHeight + 1
    );
  });
  expect(fits).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  expect((await read(page, board.id)).document).toEqual(beforeMenuKeys);
});

test('failed paste persistence keeps the full local operation recoverable until retry', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const board = await setup(page);
  await copyField(page, 'PVID');
  await selectPorts(page, targets);
  const before = (await read(page, board.id)).document;
  await page.route(`**/api/v1/boards/${board.id}`, async (route) => {
    if (route.request().method() === 'PATCH')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'TEST_UNAVAILABLE',
            message: 'Synthetic temporary save failure',
          },
        }),
      });
    else await route.continue();
  });
  await paste(page, 'target-1', false);
  await expect(page.locator('.board-save-status')).toHaveText('Not saved');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic temporary save failure',
  );
  expect((await read(page, board.id)).document).toEqual(before);
  for (const id of targets)
    await expect(socket(page, id)).toHaveAttribute('aria-label', /PVID 20/);
  await page.screenshot({
    path: info.outputPath('recoverable-paste-save-error.png'),
  });
  await page.unroute(`**/api/v1/boards/${board.id}`);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await saved(page);
  expect((await read(page, board.id)).document).toEqual(
    applyExpected(before, targets, { pvid: '20' }),
  );
});

test('right-click targeting is predictable and session clipboard clears on logout and expiration', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  // Load both records into the Studio's real index before copying. Direct API
  // fixture creation intentionally does not trigger client mutation events.
  const other = await create(page, fixture(), false);
  const board = await create(page);
  await copyFull(page);
  await selectPorts(page, targets);
  await openMenu(page, 'target-7');
  expect(await selectedIds(page)).toEqual(['target-7']);
  await menu(page)
    .getByRole('menuitem', { name: 'Paste Settings', exact: true })
    .click();
  await saved(page);
  const before = (await read(page, board.id)).document;
  expect(
    settings(before.ports.find((port) => port.id === 'target-7')!),
  ).toEqual(settings(before.ports[0]!));
  expect(
    settings(before.ports.find((port) => port.id === 'target-0')!),
  ).not.toEqual(settings(before.ports[0]!));
  await closeInspector(page);
  await page
    .getByRole('button', { name: 'Open board browser', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Boards', exact: true })
    .getByRole('button', { name: other.name, exact: true })
    .click();
  await saved(page);
  await collapse(page);
  await selectPorts(page, ['target-10']);
  await paste(page, 'target-10');
  expect(
    settings(
      (await read(page, other.id)).document.ports.find(
        (port) => port.id === 'target-10',
      )!,
    ),
  ).toEqual(settings(before.ports[0]!));
  await closeInspector(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event('portfolio:unauthorized')),
  );
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('board-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-board-password-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await saved(page);
  await collapse(page);
  await openMenu(page, 'target-8');
  const emptyPaste = menu(page).getByRole('menuitem', {
    name: 'Paste Settings',
    exact: true,
  });
  if (await emptyPaste.count()) await expect(emptyPaste).toBeDisabled();
  await page.keyboard.press('Escape');
  await copyFull(page);
  await page
    .getByRole('button', { name: 'Open board browser', exact: true })
    .click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  // Reauthenticate in the same mounted app so this verifies logout cleanup,
  // rather than the incidental loss of an in-memory clipboard on page reload.
  await page.getByLabel('Username', { exact: true }).fill('board-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-board-password-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
  cookies.set(test.info().project.name, await page.context().cookies());
  await saved(page);
  await collapse(page);
  await openMenu(page, 'target-9');
  const afterLogout = menu(page).getByRole('menuitem', {
    name: 'Paste Settings',
    exact: true,
  });
  if (await afterLogout.count()) await expect(afterLogout).toBeDisabled();
});
