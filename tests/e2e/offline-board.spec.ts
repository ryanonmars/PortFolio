import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile } from 'node:fs/promises';
import { syntheticBoardProposal } from '../../packages/shared/src/integration.js';
import {
  boardImportSchema,
  type BoardDocument,
  type BoardRecord,
} from '../../packages/shared/src/board.js';

function meaningful(document: BoardDocument) {
  const devices = new Map(document.elements.map((e) => [e.id, e.name]));
  const ports = new Map(
    document.ports.map((p) => [
      p.id,
      `${devices.get(p.deviceId)}:${p.face}:${p.row}:${p.column}:${p.name}`,
    ]),
  );
  return {
    ...document,
    elements: document.elements.map((e) => ({ ...e, id: undefined })),
    ports: document.ports.map((p) => ({
      ...p,
      id: undefined,
      deviceId: devices.get(p.deviceId),
    })),
    cables: document.cables.map((c) => ({
      ...c,
      id: undefined,
      sourcePortId: ports.get(c.sourcePortId),
      targetPortId: ports.get(c.targetPortId),
    })),
  };
}

test('offline MCP JSON imports manually, edits, autosaves and roundtrips through the normal UI', async ({
  page,
}, info) => {
  const client = new Client({
    name: 'portfolio-offline-browser',
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/apps/mcp/src/server.js'],
    env: { PATH: process.env.PATH! },
    stderr: 'pipe',
  });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  }
  try {
    await client.connect(transport);
    const proposal = syntheticBoardProposal();
    proposal.name = `Offline browser ${info.project.name}`;
    const generated = await call('portfolio_generate_board_json', { proposal });
    expect(generated.valid).toBe(true);
    expect(generated.summary).toMatchObject({
      devices: 9,
      networks: 3,
      ports: 17,
      cables: 8,
    });
    const archive = boardImportSchema.parse(generated.archive);
    const file = info.outputPath('offline-board.json');
    await writeFile(file, JSON.stringify(archive, null, 2));
    for (const json of [archive, await readFile(file, 'utf8')]) {
      const validated = await call('portfolio_validate_board_json', { json });
      expect(validated.valid).toBe(true);
      expect(validated.errors).toEqual([]);
    }
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill('token-admin');
    await page
      .getByLabel('Password', { exact: true })
      .fill('Synthetic-token-password-42');
    const setup = await (
      await page.request.get('/api/v1/auth/setup-status')
    ).json();
    await page
      .getByRole('button', {
        name: setup.setupRequired ? 'Create administrator account' : 'Sign in',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('button', { name: 'Open board browser', exact: true }),
    ).toBeVisible();
    async function readBoard(id: string): Promise<BoardRecord> {
      const response = await page.request.get(`/api/v1/boards/${id}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).board;
    }
    async function importFile(path: string) {
      const previous = page.url();
      await page
        .getByLabel('Import board file', { exact: true })
        .setInputFiles(path);
      const preview = page.getByRole('dialog', {
        name: 'Import board preview',
        exact: true,
      });
      await expect(preview).toContainText('17 ports');
      await expect(preview).toContainText('8 cables');
      await preview
        .getByRole('button', { name: 'Import as new board', exact: true })
        .click();
      await expect(page).not.toHaveURL(previous);
      await expect(page).toHaveURL(/\/boards\/[^/?]+$/);
      await expect(page.locator('.board-save-status')).toHaveText('Saved');
      return new URL(page.url()).pathname.split('/').at(-1)!;
    }
    const before = (await (await page.request.get('/api/v1/boards')).json())
      .boards.length;
    await page
      .getByLabel('Import board file', { exact: true })
      .setInputFiles(file);
    const preview = page.getByRole('dialog', {
      name: 'Import board preview',
      exact: true,
    });
    await expect(preview).toContainText(proposal.name);
    expect(
      (await (await page.request.get('/api/v1/boards')).json()).boards,
    ).toHaveLength(before);
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    const id = await importFile(file);
    const imported = await readBoard(id);
    expect(meaningful(imported.document)).toEqual(meaningful(archive.document));
    expect(
      imported.document.elements.filter((e) => e.type === 'device'),
    ).toHaveLength(9);
    const network = imported.document.elements.find(
      (e) => e.type === 'network',
    )!;
    expect(network.properties.entries).toHaveLength(3);
    const oldIds = new Set(
      [
        ...archive.document.elements,
        ...archive.document.ports,
        ...archive.document.cables,
      ].map((item) => item.id),
    );
    expect(
      [
        ...imported.document.elements,
        ...imported.document.ports,
        ...imported.document.cables,
      ].every((item) => !oldIds.has(item.id)),
    ).toBe(true);
    const router = imported.document.elements.find((e) => e.name === 'Router')!;
    await page.goto(`/boards/${id}/devices/${router.id}`);
    const content = page.locator('.board-detail-pages');
    await content
      .getByRole('button', { name: 'Edit device', exact: true })
      .click();
    await content
      .getByLabel('Device name', { exact: true })
      .fill('Reviewed offline router');
    await content
      .getByRole('button', { name: 'Done editing', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readBoard(id)).document.elements.find(
            (e) => e.id === router.id,
          )!.name,
      )
      .toBe('Reviewed offline router');
    await page.goto(`/boards/${id}/networks/${network.id}/vlan-10`);
    await content
      .getByRole('button', { name: 'Edit network', exact: true })
      .click();
    await content
      .getByLabel('Network name', { exact: true })
      .fill('Reviewed management');
    await content
      .getByRole('button', { name: 'Done editing', exact: true })
      .click();
    await expect
      .poll(async () => {
        const entries = (await readBoard(id)).document.elements.find(
          (e) => e.id === network.id,
        )!.properties.entries;
        return JSON.stringify(entries);
      })
      .toContain('Reviewed management');
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    await content
      .getByRole('button', { name: 'View on Board', exact: true })
      .click();
    const menu = page.locator('summary[aria-label="Board menu"]');
    async function download(name: string) {
      if (!(await menu.locator('..').evaluate((e) => e.hasAttribute('open'))))
        await menu.click();
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name, exact: true }).click();
      return (await (await pending).path())!;
    }
    const exportedPath = await download('Export JSON');
    // Export flushes the View on Board focus viewport through normal autosave.
    // Compare with that acknowledged revision, not the preceding detail-page view.
    const edited = await readBoard(id);
    const exported = boardImportSchema.parse(
      JSON.parse(await readFile(exportedPath, 'utf8')),
    );
    expect(meaningful(exported.document)).toEqual(meaningful(edited.document));
    const svg = await readFile(await download('Export image'), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Reviewed offline router');
    const copyId = await importFile(exportedPath);
    expect(copyId).not.toBe(id);
    expect(meaningful((await readBoard(copyId)).document)).toEqual(
      meaningful(edited.document),
    );
    await page.reload();
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    expect(meaningful((await readBoard(copyId)).document)).toEqual(
      meaningful(edited.document),
    );
    await expect(page.locator('[data-board-element-id]')).toHaveCount(12);
    await expect(page.locator('[data-board-port-id]')).toHaveCount(17);
    const beforeFit = (await readBoard(copyId)).document.viewport;
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect
      .poll(async () => (await readBoard(copyId)).document.viewport)
      .not.toEqual(beforeFit);
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    await page.screenshot({
      path: info.outputPath('offline-imported-board.png'),
      fullPage: false,
    });
  } finally {
    await client.close();
  }
});
