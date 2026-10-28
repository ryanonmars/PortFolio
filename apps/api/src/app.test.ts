import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
async function fixture(withWeb = false) {
  const directory = mkdtempSync(join(tmpdir(), 'portfolio-api-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web');
  if (withWeb) {
    mkdirSync(webRoot);
    writeFileSync(
      join(webRoot, 'index.html'),
      '<!doctype html><title>PortFolio</title>',
    );
    writeFileSync(join(webRoot, 'app.js'), 'console.log("PortFolio");');
  }
  const app = await createApp({ dataDir: directory, webRoot });
  cleanup.push(() => app.close());
  return app;
}
describe('foundation API', () => {
  it('returns minimal database-backed readiness and security headers', async () => {
    const app = await fixture();
    const response = await app.inject('/healthz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('serves frontend and deep links, keeping API errors as JSON', async () => {
    const app = await fixture(true);
    expect((await app.inject('/')).body).toContain('PortFolio');
    expect((await app.inject('/workspaces/example')).body).toContain(
      'PortFolio',
    );
    for (const url of [
      '/api',
      '/api/v1/missing',
      '/healthz/missing',
      '/missing.js',
    ]) {
      const response = await app.inject({
        url,
        headers: { host: '127.0.0.1:3088' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
    }
    expect((await app.inject('/app.js')).headers['content-type']).toContain(
      'javascript',
    );
    expect(
      (await app.inject({ method: 'POST', url: '/workspaces/example' }))
        .statusCode,
    ).toBe(404);
  });
});
