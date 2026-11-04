import { expect, test } from '@playwright/test';
import type { BoardRecord } from '../../packages/shared/src/board.js';

test('HTTP LAN creation, connections and duplication persist after reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  expect(
    await page.evaluate(() => ({
      secure: isSecureContext,
      uuid: typeof crypto.randomUUID,
      random: typeof crypto.getRandomValues,
    })),
  ).toEqual({ secure: false, uuid: 'undefined', random: 'function' });
  await page.getByLabel('Username', { exact: true }).fill('http-lan-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-LAN-password-42');
  await page
    .getByRole('button', { name: 'Create administrator account', exact: true })
    .click();
  await page
    .getByRole('complementary', { name: 'Board browser', exact: true })
    .getByRole('button', { name: 'Add board', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New board', exact: true });
  await dialog
    .getByLabel('Board name', { exact: true })
    .fill('HTTP LAN regression');
  await dialog
    .getByRole('button', { name: 'Create board', exact: true })
    .click();
  await expect(page).toHaveURL(/\/boards\/[^/]+$/);
  const boardId = new URL(page.url()).pathname.split('/').at(-1)!;
  const inspector = page.getByRole('complementary', {
    name: 'Object inspector',
    exact: true,
  });
  const close = async () => {
    if (await inspector.count())
      await inspector
        .getByRole('button', { name: 'Close inspector', exact: true })
        .click();
  };
  const add = async (kind: string) => {
    await close();
    await page.getByRole('button', { name: 'Add object', exact: true }).click();
    const dock = page.getByRole('dialog', {
      name: 'Equipment Dock',
      exact: true,
    });
    if (kind === 'Switch')
      await dock.getByRole('button', { name: 'Device', exact: true }).click();
    await dock.getByRole('button', { name: kind, exact: true }).click();
  };
  const saved = async () => {
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
  };
  const read = () =>
    page.evaluate(async (id) => {
      const response = await fetch('/api/v1/boards/' + id);
      if (!response.ok)
        throw new Error('Board read failed: ' + response.status);
      return (await response.json()).board as BoardRecord;
    }, boardId);
  await add('Switch');
  await expect(page.locator('[data-board-element-id]')).toHaveCount(1);
  await inspector.getByLabel('Port quantity', { exact: true }).fill('2');
  await inspector
    .getByRole('button', { name: 'Add RJ45 ports', exact: true })
    .click();
  await expect(page.locator('button[data-port-id]')).toHaveCount(2);
  await saved();
  const ports = (await read()).document.ports;
  await add('Cable');
  for (const port of ports)
    await page.locator(`button[data-port-id="${port.id}"]`).click();
  await expect(page.locator('[data-board-cable-id]')).toHaveCount(1);
  await saved();
  await close();
  await page
    .getByRole('button', { name: 'Select objects', exact: true })
    .click();
  await page.locator('.board-element-header').click();
  await inspector
    .getByRole('button', { name: 'Duplicate', exact: true })
    .click();
  await expect(page.locator('[data-board-element-id]')).toHaveCount(2);
  for (const [kind, offset] of [
    ['Text', 150],
    ['Rectangle', 300],
  ] as const) {
    await add(kind);
    const canvas = (await page.getByTestId('board-canvas').boundingBox())!;
    await page.mouse.click(canvas.x + 80, canvas.y + offset);
    await expect(inspector).toBeVisible();
    await saved();
  }
  const document = (await read()).document;
  expect(document.elements.map((item) => item.type)).toEqual([
    'device',
    'device',
    'text',
    'rectangle',
  ]);
  expect(document.ports).toHaveLength(4);
  expect(document.cables).toHaveLength(2);
  for (const cable of document.cables)
    for (const endpoint of [cable.sourcePortId, cable.targetPortId])
      expect(document.ports.some((port) => port.id === endpoint)).toBe(true);
  const ids = [...document.elements, ...document.ports, ...document.cables].map(
    (item) => item.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  await page.reload();
  await expect(page.locator('[data-board-element-id]')).toHaveCount(4);
  expect((await read()).document).toEqual(document);
  expect(errors).toEqual([]);
});
