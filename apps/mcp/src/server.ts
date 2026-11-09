import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfiguration, PortfolioClient } from './http-client.js';
import { createMcpServer } from './tools.js';

try {
  const server = createMcpServer(new PortfolioClient(loadConfiguration()));
  await server.connect(new StdioServerTransport());
} catch {
  // stdout is reserved for MCP protocol frames; never print URLs or tokens.
  process.stderr.write(
    'PortFolio MCP could not start. Check its environment configuration.\n',
  );
  process.exitCode = 1;
}
