import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfiguration, PortfolioClient } from './http-client.js';
import { createMcpServer } from './tools.js';

let client: PortfolioClient | undefined;
if (process.env.PORTFOLIO_API_URL || process.env.PORTFOLIO_API_TOKEN) {
  try {
    client = new PortfolioClient(loadConfiguration());
  } catch {
    // Optional online configuration must never disable offline authoring.
    // Online calls return a safe, actionable configuration error instead.
  }
}

try {
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
} catch {
  // stdout is reserved for MCP protocol frames; never print URLs or tokens.
  process.stderr.write(
    'PortFolio MCP could not start. Check its environment configuration.\n',
  );
  process.exitCode = 1;
}
