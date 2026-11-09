import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function connect(diagnostics = false) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const api: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url!,
      method: req.method!,
      body: body ? JSON.parse(body) : undefined,
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ boards: [], groups: [], ok: true }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => api.close(() => resolve())),
  );
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'apps/mcp/src/server.ts'],
    env: {
      PATH: process.env.PATH!,
      PORTFOLIO_API_URL: `http://127.0.0.1:${address.port}`,
      PORTFOLIO_API_TOKEN: 'synthetic-token',
      PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      ...(diagnostics ? { PORTFOLIO_MCP_DIAGNOSTICS: 'true' } : {}),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'portfolio-test', version: '1.0.0' });
  let diagnosticOutput = '';
  transport.stderr?.on('data', (chunk) => {
    diagnosticOutput += chunk.toString();
  });
  const protocolErrors: Error[] = [];
  client.onerror = (error) => protocolErrors.push(error);
  cleanup.push(() => client.close());
  await client.connect(transport);
  return {
    client,
    requests,
    diagnosticOutput: () => diagnosticOutput,
    protocolErrors,
  };
}
describe('real stdio MCP transport', () => {
  it('writes opt-in redacted diagnostics to stderr while preserving protocol stdout', async () => {
    const { client, diagnosticOutput, protocolErrors } = await connect(true);
    await client.callTool({
      name: 'portfolio_get_board',
      arguments: { boardId: 'private-board-identifier' },
    });
    await expect.poll(diagnosticOutput).toContain('portfolio-mcp');
    const output = diagnosticOutput();
    expect(output).not.toMatch(
      /synthetic-token|127\.0\.0\.1|private-board-identifier|\/api\//,
    );
    const lines = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        component: 'portfolio-mcp',
        method: 'GET',
        status: 200,
        durationMs: expect.any(Number),
      },
    ]);
    expect(protocolErrors).toEqual([]);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
  it('publishes typed tools and authoring guidance and proxies reads through HTTP', async () => {
    const { client, requests } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'portfolio_list_boards',
        'portfolio_get_board',
        'portfolio_validate_proposal',
        'portfolio_apply_proposal',
        'portfolio_edit_board',
      ]),
    );
    expect(
      tools.tools.find((t) => t.name === 'portfolio_list_boards')?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    const result = await client.callTool({
      name: 'portfolio_list_boards',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(requests).toEqual([
      { url: '/api/v1/integration/boards', method: 'GET', body: undefined },
    ]);
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(1);
    const guide = await client.readResource({
      uri: resources.resources[0]!.uri,
    });
    expect(JSON.stringify(guide)).toContain('untrusted');
    const prompts = await client.listPrompts();
    expect(prompts.prompts).toHaveLength(1);
  });
  it('requires literal explicit approval and never converts validation into permission', async () => {
    const { client, requests } = await connect();
    const result = await client.callTool({
      name: 'portfolio_apply_proposal',
      arguments: {
        proposalId: 'p',
        digest: 'a'.repeat(64),
        idempotencyKey: 'key',
        approved: false,
      },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    const invalid = await client.callTool({
      name: 'portfolio_validate_proposal',
      arguments: { proposal: { name: 'Lab', unknown: true } },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
