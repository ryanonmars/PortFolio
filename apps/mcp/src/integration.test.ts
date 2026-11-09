import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { apiFixture } from '../../../tests/support/api.js';
import { syntheticBoardProposal } from '../../../packages/shared/src/integration.js';
import type { BoardRecord } from '../../../packages/shared/src/board.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function fixture() {
  const api = await apiFixture(false, { integrationAllowPrivateHttp: true });
  cleanup.push(() => api.close());
  const url = await api.app.listen({ host: '127.0.0.1', port: 0 });
  async function connect(access: 'read' | 'write') {
    const token = await api.request('POST', '/api/v1/api-tokens', {
      name: `Synthetic ${access} agent`,
      access,
    });
    expect(token.statusCode, token.body).toBe(201);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'apps/mcp/src/server.ts'],
      env: {
        PATH: process.env.PATH!,
        PORTFOLIO_API_URL: url,
        PORTFOLIO_API_TOKEN: token.json().plaintextToken,
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      },
      stderr: 'pipe',
    });
    const client = new Client({
      name: 'portfolio-real-api-test',
      version: '1.0.0',
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    async function call<T = Record<string, unknown>>(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0]!.text) as T;
    }
    return { client, call };
  }
  return { api, url, connect };
}
describe('MCP to authenticated HTTP API end to end', () => {
  it('validates, previews, applies once, reads canonical slices, edits and persists after restart', async () => {
    const { api, url, connect } = await fixture();
    const { client, call } = await connect('write');
    const proposal = syntheticBoardProposal();
    const invalid = structuredClone(proposal);
    invalid.connections[0]!.targetPortId = 'missing-port';
    expect(
      await call('portfolio_validate_proposal', { proposal: invalid }),
    ).toMatchObject({ valid: false });
    const preview = await call<{
      valid: boolean;
      proposalId: string;
      digest: string;
      document: unknown;
      summary: { devices: number; ports: number };
    }>('portfolio_validate_proposal', { proposal });
    expect(preview.valid).toBe(true);
    expect(preview.document).toBeDefined();
    expect(preview.summary.devices).toBe(proposal.devices.length);
    expect(await call('portfolio_list_boards')).toMatchObject({ boards: [] });
    const apply = {
      proposalId: preview.proposalId,
      digest: preview.digest,
      idempotencyKey: 'synthetic-approved-import',
      approved: true,
    };
    const noApproval = await client.callTool({
      name: 'portfolio_apply_proposal',
      arguments: { ...apply, approved: false },
    });
    expect(noApproval.isError).toBe(true);
    const applied = await call<{ board: BoardRecord; replayed: boolean }>(
      'portfolio_apply_proposal',
      apply,
    );
    expect(applied.replayed).toBe(false);
    const boardId = applied.board.id;
    expect(applied.board.document).toEqual(preview.document);
    expect(await call('portfolio_list_boards')).toMatchObject({
      boards: [{ id: boardId }],
    });
    const devices = await call<{ devices: { id: string }[] }>(
      'portfolio_list_devices',
      { boardId },
    );
    expect(devices.devices).toHaveLength(proposal.devices.length);
    expect(
      await call('portfolio_get_device', {
        boardId,
        deviceId: devices.devices[0]!.id,
      }),
    ).toMatchObject({
      device: { id: devices.devices[0]!.id },
      ports: expect.any(Array),
      connections: expect.any(Array),
    });
    const networks = await call<{
      networks: { elementId: string; entryId: string }[];
    }>('portfolio_list_networks', { boardId });
    expect(networks.networks.length).toBeGreaterThan(0);
    expect(
      await call('portfolio_get_network', {
        boardId,
        elementId: networks.networks[0]!.elementId,
        entryId: networks.networks[0]!.entryId,
      }),
    ).toMatchObject({ network: { entryId: networks.networks[0]!.entryId } });
    expect(await call('portfolio_list_connections', { boardId })).toMatchObject(
      { connections: expect.any(Array) },
    );
    expect(await call('portfolio_get_layout', { boardId })).toMatchObject({
      elements: expect.any(Array),
      viewport: expect.any(Object),
    });
    const edited = await call<{ board: BoardRecord }>('portfolio_edit_board', {
      boardId,
      rowVersion: applied.board.rowVersion,
      approved: true,
      commands: [
        { operation: 'update_board', name: 'Reviewed synthetic board' },
        {
          operation: 'update_device',
          deviceId: devices.devices[0]!.id,
          patch: { notes: 'Reviewed documentation' },
        },
      ],
    });
    expect(edited.board.name).toBe('Reviewed synthetic board');
    const stale = await client.callTool({
      name: 'portfolio_edit_board',
      arguments: {
        boardId,
        rowVersion: applied.board.rowVersion,
        approved: true,
        commands: [{ operation: 'update_board', name: 'Stale overwrite' }],
      },
    });
    expect(stale.isError).toBe(true);
    const port = Number(new URL(url).port);
    await api.restart();
    await api.app.listen({ host: '127.0.0.1', port });
    expect(await call('portfolio_get_board', { boardId })).toMatchObject({
      board: edited.board,
    });
    expect(await call('portfolio_apply_proposal', apply)).toMatchObject({
      replayed: true,
      board: { id: boardId },
    });
    expect(await call('portfolio_list_boards')).toMatchObject({
      boards: [{ id: boardId }],
    });
    // Read the persisted document through the same UI-facing board endpoint.
    expect(
      (await api.request('GET', `/api/v1/boards/${boardId}`)).json().board,
    ).toEqual(edited.board);
  });
  it('allows read-token previews but refuses mutation, and enforces nested board identity', async () => {
    const { connect } = await fixture();
    const writer = await connect('write');
    const p = await writer.call<{ proposalId: string; digest: string }>(
      'portfolio_validate_proposal',
      { proposal: syntheticBoardProposal() },
    );
    const { board } = await writer.call<{ board: BoardRecord }>(
      'portfolio_apply_proposal',
      {
        proposalId: p.proposalId,
        digest: p.digest,
        idempotencyKey: 'nested-synthetic',
        approved: true,
      },
    );
    const reader = await connect('read');
    expect(
      await reader.call('portfolio_get_board', { boardId: board.id }),
    ).toMatchObject({ board: { id: board.id } });
    const ownPreview = await reader.call<{
      proposalId: string;
      digest: string;
    }>('portfolio_validate_proposal', {
      proposal: { name: 'Read-only preview' },
    });
    const denied = await reader.client.callTool({
      name: 'portfolio_apply_proposal',
      arguments: {
        proposalId: ownPreview.proposalId,
        digest: ownPreview.digest,
        idempotencyKey: 'read-denied',
        approved: true,
      },
    });
    expect(denied.isError).toBe(true);
    const foreign = await writer.client.callTool({
      name: 'portfolio_get_device',
      arguments: {
        boardId: 'another-board',
        deviceId: board.document.elements.find((e) => e.type === 'device')!.id,
      },
    });
    expect(foreign.isError).toBe(true);
  });
});
