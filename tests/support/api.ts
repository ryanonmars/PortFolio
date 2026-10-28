import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HTTPMethods } from 'fastify';
import { createApp } from '../../apps/api/src/app.js';
import { openDatabase } from '../../packages/db/src/index.js';
import type { Site, Workspace } from '../../packages/shared/src/index.js';

export async function apiFixture(enableLegacyEditor = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-m2-'));
  let app = await createApp({
    dataDir,
    webRoot: join(dataDir, 'no-web'),
    enableLegacyEditor,
  });
  const db = openDatabase({ dataDir });
  let cookie = '';
  let csrfToken = '';
  async function request(
    method: HTTPMethods,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:3088',
        origin: 'http://127.0.0.1:3088',
        cookie,
        'x-csrf-token': csrfToken,
        ...headers,
      },
      payload: payload as Record<string, unknown> | undefined,
    });
    const next = response.cookies.find((c) => c.name === 'portfolio_session');
    if (next) cookie = `portfolio_session=${next.value}`;
    if (response.body && response.headers['content-type']?.includes('json')) {
      const body = response.json();
      if (body.csrfToken) csrfToken = body.csrfToken;
    }
    return response;
  }
  await request('GET', '/api/v1/auth/session');
  const setup = await request('POST', '/api/v1/auth/setup', {
    username: 'test_admin',
    password: 'synthetic-M2-password-123',
  });
  if (setup.statusCode !== 201)
    throw new Error('Test administrator setup failed');
  return {
    get app() {
      return app;
    },
    dataDir,
    db,
    request,
    get cookie() {
      return cookie;
    },
    get csrfToken() {
      return csrfToken;
    },
    async createWorkspace(
      name = `Workspace ${randomUUID()}`,
    ): Promise<Workspace> {
      const r = await request('POST', '/api/v1/workspaces', { name });
      if (r.statusCode !== 201) throw new Error(r.body);
      return r.json().workspace;
    },
    async createSite(name = 'Lab', workspaceId?: string): Promise<Site> {
      const parent = workspaceId ?? (await this.createWorkspace()).id;
      const r = await request('POST', `/api/v1/workspaces/${parent}/sites`, {
        name,
      });
      if (r.statusCode !== 201) throw new Error(r.body);
      return r.json().site;
    },
    async restart() {
      await app.close();
      app = await createApp({
        dataDir,
        webRoot: join(dataDir, 'no-web'),
        enableLegacyEditor,
      });
    },
    async close() {
      db.close();
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
