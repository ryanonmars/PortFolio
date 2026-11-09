import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function connect(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'apps/mcp/src/server.ts'],
    env: { PATH: process.env.PATH!, ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({
    name: 'portfolio-offline-test',
    version: '1.0.0',
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
const proposal = {
  name: 'Synthetic offline board',
  devices: [
    {
      id: 'router',
      name: 'Router',
      ports: [{ id: 'wan', name: 'WAN', kind: 'rj45', role: 'routed/WAN' }],
    },
    { id: 'switch', name: 'Switch', ports: [{ id: 'uplink', kind: 'rj45' }] },
  ],
  connections: [{ id: 'cable', sourcePortId: 'wan', targetPortId: 'uplink' }],
  unresolvedConnections: ['WAN destination is undocumented.'],
};
async function generate(client: Client) {
  const result = await client.callTool({
    name: 'portfolio_generate_board_json',
    arguments: { proposal },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    valid: true,
    summary: { devices: 2, ports: 2, cables: 1, unresolvedConnections: 1 },
    archive: {
      format: 'portfolio-board',
      schemaVersion: 1,
      name: proposal.name,
    },
    unresolvedConnections: proposal.unresolvedConnections,
  });
  const text = (result.content as { type: string; text: string }[]).find(
    (item) => item.type === 'text',
  )!.text;
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  return (result.structuredContent as Record<string, unknown>).archive;
}

describe('offline MCP over real stdio', () => {
  it.each([
    {},
    { PORTFOLIO_API_URL: 'https://example.invalid' },
    { PORTFOLIO_API_TOKEN: 'synthetic-private-token' },
    {
      PORTFOLIO_API_URL: 'invalid-synthetic-url',
      PORTFOLIO_API_TOKEN: 'synthetic-private-token',
    },
  ] as Record<string, string>[])(
    'keeps offline generation usable with absent or invalid online configuration %j',
    async (env) => {
      const { client, stderr } = await connect(env);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'portfolio_generate_board_json',
          'portfolio_validate_board_json',
          'portfolio_get_import_schema',
          'portfolio_list_boards',
          'portfolio_apply_proposal',
          'portfolio_edit_board',
        ]),
      );
      for (const name of [
        'portfolio_generate_board_json',
        'portfolio_validate_board_json',
        'portfolio_get_import_schema',
      ]) {
        expect(
          tools.find((tool) => tool.name === name)?.annotations,
        ).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      }
      await generate(client);
      const result = await client.callTool({
        name: 'portfolio_list_boards',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/PORTFOLIO_API_URL/);
      expect(JSON.stringify(result)).toMatch(/PORTFOLIO_API_TOKEN/);
      expect(JSON.stringify(result) + stderr()).not.toMatch(
        /synthetic-private-token|invalid-synthetic-url/,
      );
    },
  );
  it('generates an importable archive and validates object, JSON text and malformed input without HTTP', async () => {
    let requests = 0;
    const api = createServer((_req, res) => {
      requests++;
      res.end('{}');
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    cleanup.push(
      () => new Promise<void>((resolve) => api.close(() => resolve())),
    );
    const address = api.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const { client, stderr } = await connect({
      PORTFOLIO_API_URL: `http://127.0.0.1:${address.port}`,
      PORTFOLIO_API_TOKEN: 'synthetic-token',
      PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      PORTFOLIO_MCP_DIAGNOSTICS: 'true',
    });
    const archive = await generate(client);
    for (const json of [archive, JSON.stringify(archive)]) {
      const result = await client.callTool({
        name: 'portfolio_validate_board_json',
        arguments: { json },
      });
      expect(result.structuredContent).toMatchObject({ valid: true, archive });
    }
    const invalid = await client.callTool({
      name: 'portfolio_validate_board_json',
      arguments: { json: '{broken' },
    });
    expect(invalid.structuredContent).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        { path: expect.any(String), message: expect.any(String) },
      ]),
    });
    expect(invalid.structuredContent).not.toHaveProperty('archive');
    const schemas = await client.callTool({
      name: 'portfolio_get_import_schema',
      arguments: {},
    });
    expect(schemas.isError).not.toBe(true);
    expect(schemas.structuredContent).toBeTypeOf('object');
    expect(JSON.stringify(schemas.structuredContent)).toContain(
      'portfolio-board',
    );
    expect(JSON.stringify(schemas.structuredContent)).toContain('limits');
    const resources = await client.listResources();
    const guide = await client.readResource({
      uri: resources.resources[0]!.uri,
    });
    expect(JSON.stringify(guide)).toMatch(/manual import/i);
    expect(JSON.stringify(guide)).toMatch(/real.*file/i);
    expect(JSON.stringify(guide)).toContain('portfolio_generate_board_json');
    expect(requests).toBe(0);
    expect(stderr()).toBe('');
  });
  it('bounds deep and oversized proposals before recursive metadata parsing and stays usable', async () => {
    const { client } = await connect();
    let nested: unknown = 'source';
    for (let i = 0; i < 1500; i++) nested = { nested };
    for (const invalidProposal of [
      {
        name: 'Deep',
        devices: [{ id: 'd', name: 'D', documentation: { nested } }],
      },
      {
        name: 'Too many values',
        devices: [
          {
            id: 'd',
            name: 'D',
            documentation: { values: Array(100001).fill('x') },
          },
        ],
      },
    ]) {
      const result = await client.callTool({
        name: 'portfolio_generate_board_json',
        arguments: { proposal: invalidProposal },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          {
            path: expect.any(String),
            message: expect.stringMatching(/size|nesting|depth|values/),
          },
        ]),
      });
      expect(JSON.stringify(result)).not.toMatch(/call stack/i);
      expect(result.structuredContent).not.toHaveProperty('archive');
    }
    await generate(client);
  });
  it('works offline even when a configured online endpoint is unavailable', async () => {
    const { client } = await connect({
      PORTFOLIO_API_URL: 'http://127.0.0.1:1',
      PORTFOLIO_API_TOKEN: 'synthetic-token',
      PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      PORTFOLIO_REQUEST_TIMEOUT_MS: '100',
    });
    await generate(client);
  });
});
