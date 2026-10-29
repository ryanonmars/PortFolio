import { registerTemplates } from './templates.js';
import { registerLogicalConnections } from './logical-connections.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../../../packages/db/src/index.js';
import { healthSchema } from '../../../packages/shared/src/index.js';
import { registerSecurity } from './security.js';
import { registerOrganization } from './organization.js';
import { registerEquipment } from './equipment.js';
import { registerNetwork } from './network.js';
import { registerGrid } from './grid.js';
import { registerTransfer } from './transfer.js';
import { registerNavigation } from './navigation.js';
import { ApiError } from './errors.js';
import { registerBoards } from './boards.js';

export interface AppOptions {
  dataDir: string;
  webRoot?: string;
  logger?: boolean;
  publicOrigin?: string;
  localOrigin?: string;
  allowedOrigins?: readonly string[];
  /** Test/compatibility harness only; production serves the canonical board editor. */
  enableLegacyEditor?: boolean;
}

export async function createApp(options: AppOptions) {
  const db = openDatabase({ dataDir: options.dataDir });
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
      });
    }
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status =
      typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
        ? statusCode
        : 500;
    if (status === 500) request.log.error(error);
    return reply.code(status).send({
      error: {
        code:
          status === 500
            ? 'INTERNAL_ERROR'
            : status === 429
              ? 'RATE_LIMITED'
              : 'BAD_REQUEST',
        message:
          status === 500
            ? 'An unexpected error occurred'
            : status === 429
              ? 'Too many attempts. Try again later'
              : 'Invalid request',
      },
    });
  });
  app.addHook('onClose', async () => db.close());
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });
  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    db.prepare('SELECT 1').get();
    return healthSchema.parse({ status: 'ok' });
  });
  const security = await registerSecurity(
    app,
    db,
    options.publicOrigin ?? 'http://127.0.0.1:3088',
    options.localOrigin,
    options.allowedOrigins,
  ).catch(async (error: unknown) => {
    await app.close();
    throw error;
  });
  registerBoards(app, db, security.requireAuth);
  if (options.enableLegacyEditor === true) {
    registerOrganization(app, db, security.requireAuth);
    registerNavigation(app, db, security.requireAuth);
    registerTemplates(app, db, security.requireAuth);
    registerLogicalConnections(app, db, security.requireAuth);
    registerNetwork(app, db, security.requireAuth);
    registerEquipment(app, db, security.requireAuth);
    registerGrid(app, db, security.requireAuth);
    registerTransfer(app, db, security.requireAuth, options.dataDir);
  }
  const webRoot = resolve(options.webRoot ?? 'dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      !pathname.startsWith('/api') &&
      !pathname.startsWith('/healthz') &&
      !pathname.includes('.') &&
      existsSync(resolve(webRoot, 'index.html'))
    ) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  return app;
}
