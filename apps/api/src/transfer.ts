import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { backupDatabase } from '../../../packages/db/src/index.js';
import {
  ARCHIVE_MAX_BYTES,
  importCommitSchema,
  importPreviewSchema,
  siteArchiveSchema,
  type ImportRequest,
  type ImportPreview,
  type ImportSummary,
  type SiteArchive,
} from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { mutation, siteRoute, transaction } from './resources.js';
import {
  applyArchive,
  exportSite,
  readTransferSite,
  readTransferSnapshot,
} from './transfer-store.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const previewLifetime = 15 * 60 * 1000;
function summary(document: SiteArchive): ImportSummary {
  return {
    racks: document.racks.length,
    vlans: document.vlans.length,
    subnets: document.subnets.length,
    dhcpScopes: document.dhcpScopes.length,
    devices: document.devices.length,
    ports: document.ports.length,
    fields: document.fields.length,
    customValues: document.customValues.length,
    connections: document.connections.length,
    logicalConnections: document.logicalConnections.length,
  };
}
function checkSize(document: SiteArchive) {
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > ARCHIVE_MAX_BYTES)
    throw new ApiError(
      413,
      'IMPORT_TOO_LARGE',
      'The archive exceeds the supported size limit',
    );
}

export function registerTransfer(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
  dataDir: string,
) {
  const route = siteRoute(db, requireAuth);
  const importRoute = { ...route, bodyLimit: ARCHIVE_MAX_BYTES + 65536 };
  const secret = randomBytes(32);
  const sign = (payload: string) =>
    createHmac('sha256', secret).update(payload).digest();
  const params = (request: FastifyRequest) =>
    request.params as { siteId: string };
  const targetState = (siteId: string) =>
    readTransferSnapshot(db, () => {
      const document = exportSite(db, siteId);
      const workspace = db
        .prepare('SELECT row_version AS rowVersion FROM workspaces WHERE id=?')
        .get(document.site.workspaceId) as { rowVersion: number };
      return { document, workspaceVersion: workspace.rowVersion };
    });
  const importName = (input: ImportRequest, siteId: string) =>
    input.policy === 'replace'
      ? readTransferSite(db, siteId).name
      : input.siteName!;
  const binding = (input: ImportRequest, siteId: string) =>
    digest({
      document: digest(input.document),
      target: targetState(siteId),
      siteId,
      policy: input.policy,
      siteName: importName(input, siteId),
    });
  const ensureName = (input: ImportRequest, siteId: string) => {
    if (input.policy === 'new-site') {
      const site = readTransferSite(db, siteId);
      if (
        db
          .prepare(
            'SELECT id FROM sites WHERE workspace_id=? AND lower(name)=lower(?)',
          )
          .get(site.workspaceId, input.siteName!)
      )
        throw new ApiError(
          409,
          'DUPLICATE_NAME',
          'That site name is already in use. Choose a different name and preview again',
        );
    }
  };
  const verify = (token: string, input: ImportRequest, siteId: string) => {
    const invalid = () =>
      new ApiError(
        409,
        'INVALID_PREVIEW',
        'The import preview expired or changed. Preview the archive again before importing',
      );
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length) throw invalid();
    const supplied = Buffer.from(signature, 'base64url');
    const expected = sign(payload);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw invalid();
    let parsed: { binding?: unknown; expiresAt?: unknown };
    try {
      parsed = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as typeof parsed;
    } catch {
      throw invalid();
    }
    if (
      !parsed ||
      typeof parsed.binding !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= Date.now() ||
      parsed.binding !== binding(input, siteId)
    )
      throw invalid();
  };

  app.get('/api/v1/sites/:siteId/export', route, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (
      Object.keys(query).some((key) => key !== 'format') ||
      (query.format !== undefined && query.format !== 'json')
    )
      throw new ApiError(
        400,
        'INVALID_FORMAT',
        'Only JSON site export is supported',
      );
    const document = exportSite(db, params(request).siteId);
    checkSize(document);
    reply
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Disposition',
        `attachment; filename="portfolio-site-${document.site.id}.json"`,
      )
      .type('application/json');
    return document;
  });
  app.post(
    '/api/v1/sites/:siteId/import/preview',
    importRoute,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const input = validate(importPreviewSchema, request.body);
      checkSize(input.document);
      const { siteId } = params(request);
      ensureName(input, siteId);
      const expiresAt = Date.now() + previewLifetime;
      const payload = Buffer.from(
        JSON.stringify({ binding: binding(input, siteId), expiresAt }),
      ).toString('base64url');
      const preview: ImportPreview = {
        token: `${payload}.${sign(payload).toString('base64url')}`,
        expiresAt: new Date(expiresAt).toISOString(),
        policy: input.policy,
        siteName: importName(input, siteId),
        summary: summary(input.document),
        warnings:
          input.policy === 'replace'
            ? [
                'All current equipment, ports, VLANs, network records, custom fields, physical cables and logical connections in this site will be replaced. Its name and workspace are retained.',
              ]
            : [
                'A new site will be created in this workspace. Existing sites will not be overwritten.',
              ],
      };
      return { preview };
    },
  );
  app.post(
    '/api/v1/sites/:siteId/import/commit',
    importRoute,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const input = validate(importCommitSchema, request.body);
      checkSize(input.document);
      const { siteId } = params(request);
      if (input.policy === 'replace' && !input.confirmReplace)
        throw new ApiError(
          400,
          'REPLACE_CONFIRMATION_REQUIRED',
          'Confirm replacement of the current site before importing',
        );
      verify(input.previewToken, input, siteId);
      ensureName(input, siteId);
      try {
        await backupDatabase(
          db,
          resolve(
            dataDir,
            'backups',
            `portfolio-before-import-${randomUUID()}.sqlite`,
          ),
        );
      } catch {
        throw new ApiError(
          500,
          'BACKUP_FAILED',
          'A recovery backup could not be created. Nothing was imported',
        );
      }
      const site = mutation(() =>
        transaction(db, () => {
          verify(input.previewToken, input, siteId);
          ensureName(input, siteId);
          const document = validate(siteArchiveSchema, input.document);
          return applyArchive(
            db,
            document,
            readTransferSite(db, siteId),
            input.policy,
            importName(input, siteId),
          );
        }),
      );
      return reply
        .code(input.policy === 'new-site' ? 201 : 200)
        .send({ site, summary: summary(input.document), backupCreated: true });
    },
  );
}
