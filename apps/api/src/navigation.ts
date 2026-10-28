import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readSnapshot } from './resources.js';

export function registerNavigation(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  app.get(
    '/api/v1/navigation',
    {
      preHandler: async (request) => {
        requireAuth(request);
      },
    },
    async () =>
      readSnapshot(db, () => ({
        workspaces: db
          .prepare('SELECT id,name FROM workspaces ORDER BY name,id')
          .all(),
        sites: db
          .prepare(
            'SELECT id,workspace_id AS workspaceId,name FROM sites ORDER BY name,id',
          )
          .all(),
        devices: db
          .prepare(
            'SELECT id,site_id AS siteId,display_name AS displayName,type,order_index AS orderIndex FROM devices ORDER BY order_index,id',
          )
          .all(),
      })),
  );
}
