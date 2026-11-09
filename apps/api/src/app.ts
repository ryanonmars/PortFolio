import { registerTemplates } from './templates.js';
import { registerLogicalConnections } from './logical-connections.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabaseRuntime } from './database-runtime.js';
import { registerMaintenance } from './maintenance.js';
import { registerBackups } from './backup.js';
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
import { registerAttachments } from './attachments.js';
import { registerApiTokens } from './api-tokens.js';
import { registerIntegration } from './integration.js';

export interface AppOptions {
  dataDir: string;
  webRoot?: string;
  logger?: boolean;
  publicOrigin?: string;
  localOrigin?: string;
  allowedOrigins?: readonly string[];
  trustedHosts?: readonly string[];
  attachmentMaxFileBytes?: number;
  backupMaxBytes?: number;
  attachmentMaxStorageBytes?: number;
  integrationAllowPrivateHttp?: boolean;
  /** Test/compatibility harness only; production serves the canonical board editor. */
  enableLegacyEditor?: boolean;
}

export async function createApp(options: AppOptions) {
  for (const key of [
    'attachmentMaxFileBytes',
    'backupMaxBytes',
    'attachmentMaxStorageBytes',
  ] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  const runtime = createDatabaseRuntime(options.dataDir);
  const db = runtime.db;
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie'] }
      : false,
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
  const maintenance = registerMaintenance(app);
  app.addHook('onClose', async () => runtime.dispose());
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (!reply.hasHeader('Content-Security-Policy'))
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
    options.publicOrigin,
    options.localOrigin,
    options.allowedOrigins,
    options.trustedHosts,
    options.integrationAllowPrivateHttp,
  ).catch(async (error: unknown) => {
    await app.close();
    throw error;
  });
  const attachments = await registerAttachments(app, db, security.requireAuth, {
    dataDir: options.dataDir,
    maxFileBytes: options.attachmentMaxFileBytes,
    maxStorageBytes: options.attachmentMaxStorageBytes,
  }).catch(async (error: unknown) => {
    await app.close();
    throw error;
  });
  try {
    registerBackups(
      app,
      runtime,
      security.requireAuth,
      maintenance,
      attachments,
      {
        dataDir: options.dataDir,
        maxBytes: options.backupMaxBytes,
      },
    );
  } catch (error) {
    await app.close();
    throw error;
  }
  const boards = registerBoards(
    app,
    db,
    security.requireAuth,
    attachments.reconcile,
  );
  registerApiTokens(app, db, security.requireAuth);
  registerIntegration(app, db, boards, security.requireIntegrationAuth);
  if (options.enableLegacyEditor === true) {
    registerOrganization(app, db, security.requireAuth);
    registerNavigation(app, db, security.requireAuth);
    registerTemplates(app, db, security.requireAuth);
    registerLogicalConnections(app, db, security.requireAuth);
    registerNetwork(app, db, security.requireAuth);
    registerEquipment(app, db, security.requireAuth);
    registerGrid(app, db, security.requireAuth);
    registerTransfer(
      app,
      db,
      security.requireAuth,
      options.dataDir,
      () => runtime.real,
    );
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
