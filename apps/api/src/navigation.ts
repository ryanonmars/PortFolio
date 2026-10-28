import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readSnapshot, siteRoute } from './resources.js';
import {
  builtInDeviceTemplates,
  type NavigationRecord,
  type SiteNavigationData,
} from '../../../packages/shared/src/index.js';

export function registerNavigation(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  app.get(
    '/api/v1/sites/:siteId/navigation',
    siteRoute(db, requireAuth),
    async (request, reply) =>
      readSnapshot(db, () => {
        reply.header('Cache-Control', 'no-store');
        const { siteId } = request.params as { siteId: string };
        const records = (sql: string): NavigationRecord[] =>
          db.prepare(sql).all(siteId) as unknown as NavigationRecord[];
        const physical =
          records(`SELECT c.id,da.display_name || ' / ' || pa.name || ' ⇄ ' || db.display_name || ' / ' || pb.name AS label,'physical' AS kind FROM connections c
      JOIN ports pa ON pa.id=c.endpoint_a_port_id AND pa.site_id=c.site_id JOIN ports pb ON pb.id=c.endpoint_b_port_id AND pb.site_id=c.site_id
      JOIN devices da ON da.id=pa.device_id AND da.site_id=c.site_id JOIN devices db ON db.id=pb.device_id AND db.site_id=c.site_id WHERE c.site_id=? ORDER BY da.display_name,pa.order_index,c.id`);
        const logical = records(
          `SELECT c.id,CASE WHEN c.name!='' THEN c.name ELSE da.display_name || ' ⇄ ' || db.display_name END || CASE WHEN c.protocol!='' THEN ' — ' || c.protocol ELSE '' END AS label,'logical' AS kind FROM logical_connections c JOIN devices da ON da.id=c.endpoint_a_device_id AND da.site_id=c.site_id JOIN devices db ON db.id=c.endpoint_b_device_id AND db.site_id=c.site_id WHERE c.site_id=? ORDER BY c.name,c.id`,
        );
        const data: SiteNavigationData = {
          siteId,
          records: {
            devices: records(
              'SELECT id,display_name AS label FROM devices WHERE site_id=? ORDER BY order_index,display_name,id',
            ),
            vlans: records(
              "SELECT id,'VLAN ' || vlan_id || CASE WHEN name!='' THEN ' — ' || name ELSE '' END AS label FROM vlans WHERE site_id=? ORDER BY vlan_id,id",
            ),
            network: records(
              "SELECT id,cidr || CASE WHEN name!='' THEN ' — ' || name ELSE '' END AS label FROM subnets WHERE site_id=? ORDER BY cidr,id",
            ),
            racks: records(
              'SELECT id,name AS label FROM racks WHERE site_id=? ORDER BY order_index,name,id',
            ),
            templates: [
              ...builtInDeviceTemplates.map(({ id, name }) => ({
                id,
                label: name,
              })),
              ...(db
                .prepare(
                  'SELECT id,name AS label FROM device_templates ORDER BY lower(name),id',
                )
                .all() as unknown as NavigationRecord[]),
            ],
            connections: [...physical, ...logical],
          },
        };
        return data;
      }),
  );
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
