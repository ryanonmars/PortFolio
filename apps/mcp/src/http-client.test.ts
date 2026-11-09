import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import {
  loadConfiguration,
  PortfolioClient,
  isPrivateAddress,
} from './http-client.js';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}
describe('MCP HTTP boundary', () => {
  it('requires explicit private HTTP and rejects unsafe configuration', () => {
    for (const url of [
      'http://127.0.0.1:3088',
      'https://user:pass@example.com',
      'https://example.com?token=x',
      'https://example.com/#fragment',
      'https://example.com?',
      'https://example.com/#',
    ]) {
      expect(() =>
        loadConfiguration({
          PORTFOLIO_API_URL: url,
          PORTFOLIO_API_TOKEN: 'secret',
        }),
      ).toThrow();
    }
    expect(() =>
      loadConfiguration({
        PORTFOLIO_API_URL: 'https://example.com',
        PORTFOLIO_API_TOKEN: 'secret\nheader',
      }),
    ).toThrow();
    expect(
      loadConfiguration({
        PORTFOLIO_API_URL: 'https://example.com/',
        PORTFOLIO_API_TOKEN: 'secret',
      }).baseUrl.href,
    ).toBe('https://example.com/');
  });
  it('recognizes only explicitly private IP ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of [
      '8.8.8.8',
      '169.254.1.1',
      '172.32.0.1',
      '100.128.0.1',
      '::',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8',
    ])
      expect(isPrivateAddress(ip)).toBe(false);
  });
  it('sends a bearer token only to the configured endpoint and refuses redirects', async () => {
    let received = '';
    let count = 0;
    const url = await endpoint((req, res) => {
      received = req.headers.authorization ?? '';
      count++;
      res.writeHead(302, { location: 'https://example.com/secret' });
      res.end();
    });
    const client = new PortfolioClient(
      loadConfiguration({
        PORTFOLIO_API_URL: url,
        PORTFOLIO_API_TOKEN: 'sensitive',
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      }),
    );
    await expect(client.request('GET', '/boards')).rejects.toThrow('redirect');
    expect(received).toBe('Bearer sensitive');
    expect(count).toBe(1);
  });
  it('resolves and pins private DNS names, and rejects public HTTP destinations', async () => {
    const url = await endpoint((_req, res) => {
      res.end('{"ok":true}');
    });
    const client = new PortfolioClient(
      loadConfiguration({
        PORTFOLIO_API_URL: url.replace('127.0.0.1', 'localhost'),
        PORTFOLIO_API_TOKEN: 'synthetic',
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      }),
    );
    await expect(client.request('GET', '/boards')).resolves.toEqual({
      ok: true,
    });
    const publicClient = new PortfolioClient(
      loadConfiguration({
        PORTFOLIO_API_URL: 'http://8.8.8.8',
        PORTFOLIO_API_TOKEN: 'synthetic',
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      }),
    );
    await expect(publicClient.request('GET', '/boards')).rejects.toThrow(
      'private',
    );
  });
  it('bounds responses, times out and redacts upstream failures', async () => {
    const url = await endpoint((req, res) => {
      if (req.url?.endsWith('/slow')) return;
      if (req.url?.endsWith('/large')) {
        res.end('x'.repeat(12_600_000));
        return;
      }
      res.writeHead(500);
      res.end('sensitive token database details');
    });
    const client = new PortfolioClient(
      loadConfiguration({
        PORTFOLIO_API_URL: url,
        PORTFOLIO_API_TOKEN: 'sensitive',
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
        PORTFOLIO_REQUEST_TIMEOUT_MS: '100',
      }),
    );
    await expect(client.request('GET', '/slow')).rejects.toThrow('timed out');
    await expect(client.request('GET', '/large')).rejects.toThrow('too large');
    await expect(client.request('GET', '/error')).rejects.toThrow('HTTP 500');
    await expect(client.request('GET', '/error')).rejects.not.toThrow(
      'sensitive',
    );
  });
  it('returns actionable known API errors without forwarding arbitrary upstream text', async () => {
    const url = await endpoint((_req, res) => {
      res.writeHead(409);
      res.end(
        JSON.stringify({
          error: {
            code: 'CONFLICT',
            message: 'sensitive token /private/database.sqlite',
            fieldErrors: { rowVersion: ['sensitive token'] },
          },
        }),
      );
    });
    const client = new PortfolioClient(
      loadConfiguration({
        PORTFOLIO_API_URL: url,
        PORTFOLIO_API_TOKEN: 'sensitive',
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      }),
    );
    await expect(
      client.request('POST', '/boards/x/commands', {}),
    ).rejects.toThrow('reread');
    await expect(
      client.request('POST', '/boards/x/commands', {}),
    ).rejects.not.toThrow('sensitive');
  });
  it('accepts large normal boards but rejects oversized writes before sending', async () => {
    let requests = 0;
    const url = await endpoint((_req, res) => {
      requests++;
      res.end(JSON.stringify({ notes: 'x'.repeat(2_100_000) }));
    });
    const client = new PortfolioClient(
      loadConfiguration({
        PORTFOLIO_API_URL: url,
        PORTFOLIO_API_TOKEN: 'synthetic',
        PORTFOLIO_ALLOW_PRIVATE_HTTP: 'true',
      }),
    );
    expect(await client.request('GET', '/boards')).toMatchObject({
      notes: expect.any(String),
    });
    await expect(
      client.request('POST', '/proposals/validate', {
        notes: 'x'.repeat(8 * 1024 * 1024),
      }),
    ).rejects.toThrow('body is too large');
    expect(requests).toBe(1);
  });
});
