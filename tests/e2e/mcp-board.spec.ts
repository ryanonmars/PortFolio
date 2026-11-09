import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { syntheticBoardProposal } from '../../packages/shared/src/integration.js';
import type { BoardRecord } from '../../packages/shared/src/board.js';

test('a board built through the compiled MCP server opens, edits, autosaves and exports in the existing UI', async ({
  page,
}, info) => {
  const origin = info.project.use.baseURL as string;
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
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const token = await page.request.post('/api/v1/api-tokens', {
    headers: { Origin: origin, 'x-csrf-token': session.csrfToken },
    data: { name: 'Synthetic MCP browser verification', access: 'write' },
  });
  expect(token.status()).toBe(201);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/apps/mcp/src/server.js'],
    env: {
      PATH: process.env.PATH!,
      PORTFOLIO_API_URL: origin,
      PORTFOLIO_API_TOKEN: (await token.json()).plaintextToken,
      PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
    },
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'portfolio-browser-smoke',
    version: '1.0.0',
  });
  try {
    await client.connect(transport);
    async function call<T>(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
    }
    const proposal = syntheticBoardProposal();
    proposal.name = `MCP browser ${info.project.name}`;
    const preview = await call<{
      proposalId: string;
      digest: string;
      summary: { devices: number; networks: number; cables: number };
    }>('portfolio_validate_proposal', { proposal });
    expect(preview.summary).toMatchObject({
      devices: 9,
      networks: 3,
      cables: 8,
    });
    const { board } = await call<{ board: BoardRecord }>(
      'portfolio_apply_proposal',
      {
        proposalId: preview.proposalId,
        digest: preview.digest,
        idempotencyKey: `browser-${info.project.name}`,
        approved: true,
      },
    );
    await page.goto(`/boards/${board.id}/devices/router`);
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    const content = page.locator('.board-detail-pages');
    await content
      .getByRole('button', { name: 'Edit device', exact: true })
      .click();
    await content
      .getByLabel('Device name', { exact: true })
      .fill('Reviewed synthetic router');
    await content
      .getByRole('button', { name: 'Done editing', exact: true })
      .click();
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    await expect
      .poll(
        async () =>
          (
            await call<{ board: BoardRecord }>('portfolio_get_board', {
              boardId: board.id,
            })
          ).board.document.elements.find((e) => e.id === 'router')!.name,
      )
      .toBe('Reviewed synthetic router');
    await content
      .getByRole('button', { name: 'View on Board', exact: true })
      .click();
    await expect(page.locator('[data-board-element-id]')).toHaveCount(
      board.document.elements.length,
    );
    const menu = page.locator('summary[aria-label="Board menu"]');
    async function openMenu() {
      if (!(await menu.locator('..').evaluate((e) => e.hasAttribute('open'))))
        await menu.click();
    }
    await openMenu();
    const jsonPending = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export JSON', exact: true })
      .click();
    const json = JSON.parse(
      await readFile((await (await jsonPending).path())!, 'utf8'),
    );
    expect(json.document.ports).toHaveLength(17);
    expect(json.document.cables).toHaveLength(8);
    await openMenu();
    const svgPending = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export image', exact: true })
      .click();
    const svg = await readFile((await (await svgPending).path())!, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Reviewed synthetic router');
    await page.reload();
    await expect(page.locator('.board-save-status')).toHaveText('Saved');
    await expect(
      page.locator('[data-board-element-id="router"]'),
    ).toContainText('Reviewed synthetic router');
  } finally {
    await client.close();
  }
});
