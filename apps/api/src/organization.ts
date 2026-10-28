import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createSiteSchema,
  createWorkspaceSchema,
  updateSiteSchema,
  updateWorkspaceSchema,
  versionSchema,
  type Site,
  type Workspace,
  type DeleteImpact,
  type DeletionPreview,
} from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import {
  clearSiteContents,
  mutation,
  readSnapshot,
  transaction,
} from './resources.js';

const workspaceColumns = 'id, name, description, row_version AS rowVersion';
const siteColumns =
  'id, workspace_id AS workspaceId, name, description, notes, row_version AS rowVersion';

export function registerOrganization(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const workspace = (id: string): Workspace => {
    const record = db
      .prepare(`SELECT ${workspaceColumns} FROM workspaces WHERE id = ?`)
      .get(id) as Workspace | undefined;
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found');
    return record;
  };
  const site = (id: string): Site => {
    const record = db
      .prepare(`SELECT ${siteColumns} FROM sites WHERE id = ?`)
      .get(id) as Site | undefined;
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Site not found');
    return record;
  };
  const unique = (action: () => void) => {
    try {
      action();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'errcode' in error &&
        error.errcode === 2067
      ) {
        throw new ApiError(
          409,
          'DUPLICATE_NAME',
          'That name is already in use',
        );
      }
      throw error;
    }
  };
  const params = (request: FastifyRequest) =>
    request.params as Record<string, string>;
  const stale = () =>
    new ApiError(
      409,
      'STALE_VERSION',
      'This record changed. Reload before saving',
    );
  const protectedRoute = {
    preHandler: async (request: FastifyRequest) => {
      requireAuth(request);
    },
  };
  const deletionImpact = (
    kind: 'site' | 'workspace',
    id: string,
  ): DeletionPreview =>
    readSnapshot(db, () => {
      const current = kind === 'site' ? site(id) : workspace(id);
      const scope =
        kind === 'site'
          ? '= ?'
          : 'IN (SELECT id FROM sites WHERE workspace_id=?)';
      const count = (table: string) =>
        (
          db
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE site_id ${scope}`,
            )
            .get(id) as { count: number }
        ).count;
      const impact: DeleteImpact = {
        sites:
          kind === 'site'
            ? 1
            : (
                db
                  .prepare(
                    'SELECT count(*) AS count FROM sites WHERE workspace_id=?',
                  )
                  .get(id) as { count: number }
              ).count,
        devices: count('devices'),
        ports: count('ports'),
        vlans: count('vlans'),
        racks: count('racks'),
        subnets: count('subnets'),
        dhcpScopes: count('dhcp_scopes'),
        fields: count('port_custom_field_defs'),
        customValues: count('port_custom_values'),
        connections: count('connections'),
        logicalConnections: count('logical_connections'),
      };
      return { name: current.name, rowVersion: current.rowVersion, impact };
    });
  app.get(
    '/api/v1/workspaces/:workspaceId/deletion-impact',
    protectedRoute,
    async (request) =>
      deletionImpact('workspace', params(request).workspaceId!),
  );
  app.get(
    '/api/v1/sites/:siteId/deletion-impact',
    protectedRoute,
    async (request) => deletionImpact('site', params(request).siteId!),
  );

  app.get('/api/v1/workspaces', protectedRoute, async () => ({
    workspaces: db
      .prepare(`SELECT ${workspaceColumns} FROM workspaces ORDER BY name, id`)
      .all(),
  }));
  app.post('/api/v1/workspaces', protectedRoute, async (request, reply) => {
    const input = validate(createWorkspaceSchema, request.body);
    const id = randomUUID();
    unique(() => {
      db.prepare(
        'INSERT INTO workspaces (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)',
      ).run(id, input.name, input.description, Date.now(), Date.now());
    });
    return reply.code(201).send({ workspace: workspace(id) });
  });
  app.get(
    '/api/v1/workspaces/:workspaceId',
    protectedRoute,
    async (request) => ({ workspace: workspace(params(request).workspaceId!) }),
  );
  app.patch(
    '/api/v1/workspaces/:workspaceId',
    protectedRoute,
    async (request) => {
      const current = workspace(params(request).workspaceId!);
      const input = validate(updateWorkspaceSchema, request.body);
      unique(() => {
        const result = db
          .prepare(
            'UPDATE workspaces SET name=?,description=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
          )
          .run(
            input.name ?? current.name,
            input.description ?? current.description,
            Date.now(),
            current.id,
            input.rowVersion,
          );
        if (!result.changes) throw stale();
      });
      return { workspace: workspace(current.id) };
    },
  );
  app.delete(
    '/api/v1/workspaces/:workspaceId',
    protectedRoute,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          const current = workspace(params(request).workspaceId!);
          if (current.rowVersion !== input.rowVersion) throw stale();
          const children = db
            .prepare('SELECT id FROM sites WHERE workspace_id=?')
            .all(current.id) as { id: string }[];
          for (const child of children) clearSiteContents(db, child.id);
          db.prepare('DELETE FROM sites WHERE workspace_id=?').run(current.id);
          if (
            !db
              .prepare('DELETE FROM workspaces WHERE id=? AND row_version=?')
              .run(current.id, input.rowVersion).changes
          )
            throw stale();
        }),
      );
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/workspaces/:workspaceId/sites',
    protectedRoute,
    async (request) => {
      const current = workspace(params(request).workspaceId!);
      return {
        sites: db
          .prepare(
            `SELECT ${siteColumns} FROM sites WHERE workspace_id=? ORDER BY name,id`,
          )
          .all(current.id),
      };
    },
  );
  app.post(
    '/api/v1/workspaces/:workspaceId/sites',
    protectedRoute,
    async (request, reply) => {
      const current = workspace(params(request).workspaceId!);
      const input = validate(createSiteSchema, request.body);
      const id = randomUUID();
      unique(() => {
        db.prepare(
          'INSERT INTO sites (id,workspace_id,name,description,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        ).run(
          id,
          current.id,
          input.name,
          input.description,
          input.notes,
          Date.now(),
          Date.now(),
        );
      });
      return reply.code(201).send({ site: site(id) });
    },
  );
  app.get('/api/v1/sites/:siteId', protectedRoute, async (request) => ({
    site: site(params(request).siteId!),
  }));
  app.patch('/api/v1/sites/:siteId', protectedRoute, async (request) => {
    const current = site(params(request).siteId!);
    const input = validate(updateSiteSchema, request.body);
    unique(() => {
      const result = db
        .prepare(
          'UPDATE sites SET name=?,description=?,notes=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
        )
        .run(
          input.name ?? current.name,
          input.description ?? current.description,
          input.notes ?? current.notes,
          Date.now(),
          current.id,
          input.rowVersion,
        );
      if (!result.changes) throw stale();
    });
    return { site: site(current.id) };
  });
  app.delete(
    '/api/v1/sites/:siteId',
    protectedRoute,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          const current = site(params(request).siteId!);
          if (current.rowVersion !== input.rowVersion) throw stale();
          clearSiteContents(db, current.id);
          if (
            !db
              .prepare('DELETE FROM sites WHERE id=? AND row_version=?')
              .run(current.id, input.rowVersion).changes
          )
            throw stale();
        }),
      );
      return reply.code(204).send();
    },
  );
}
