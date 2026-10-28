import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createLogicalConnectionSchema,
  logicalConnectionRecordSchema,
  updateLogicalConnectionSchema,
  type LogicalConnection,
} from '../../../packages/shared/src/logical.js';
import { versionSchema } from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { mutation, siteRoute, staleVersion, transaction } from './resources.js';

const columns =
  'id,site_id AS siteId,endpoint_a_device_id AS endpointADeviceId,endpoint_b_device_id AS endpointBDeviceId,name,protocol,notes,row_version AS rowVersion';

export function registerLogicalConnections(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const route = siteRoute(db, requireAuth);
  const params = (request: FastifyRequest) =>
    request.params as { siteId: string; connectionId: string };
  const read = (siteId: string, id: string): LogicalConnection => {
    const row = db
      .prepare(
        `SELECT ${columns} FROM logical_connections WHERE site_id=? AND id=?`,
      )
      .get(siteId, id) as LogicalConnection | undefined;
    if (!row)
      throw new ApiError(404, 'NOT_FOUND', 'Logical connection not found');
    return row;
  };
  const endpoints = (
    connection: Pick<
      LogicalConnection,
      'siteId' | 'endpointADeviceId' | 'endpointBDeviceId'
    >,
  ) => {
    for (const id of [
      connection.endpointADeviceId,
      connection.endpointBDeviceId,
    ]) {
      if (
        !db
          .prepare('SELECT id FROM devices WHERE site_id=? AND id=?')
          .get(connection.siteId, id)
      )
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Endpoint device not found in this site',
        );
    }
  };
  app.get(
    '/api/v1/sites/:siteId/logical-connections',
    route,
    async (request) => ({
      logicalConnections: db
        .prepare(
          `SELECT ${columns} FROM logical_connections WHERE site_id=? ORDER BY id`,
        )
        .all(params(request).siteId),
    }),
  );
  app.post(
    '/api/v1/sites/:siteId/logical-connections',
    route,
    async (request, reply) => {
      const input = validate(createLogicalConnectionSchema, request.body);
      const logicalConnection = mutation(() =>
        transaction(db, () => {
          const candidate = validate(logicalConnectionRecordSchema, {
            ...input,
            id: randomUUID(),
            siteId: params(request).siteId,
            rowVersion: 1,
          });
          endpoints(candidate);
          db.prepare(
            'INSERT INTO logical_connections (id,site_id,endpoint_a_device_id,endpoint_b_device_id,name,protocol,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          ).run(
            candidate.id,
            candidate.siteId,
            candidate.endpointADeviceId,
            candidate.endpointBDeviceId,
            candidate.name,
            candidate.protocol,
            candidate.notes,
            Date.now(),
            Date.now(),
          );
          return read(candidate.siteId, candidate.id);
        }),
      );
      return reply.code(201).send({ logicalConnection });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/logical-connections/:connectionId',
    route,
    async (request) => {
      const input = validate(updateLogicalConnectionSchema, request.body);
      const { siteId, connectionId } = params(request);
      return {
        logicalConnection: mutation(() =>
          transaction(db, () => {
            const current = read(siteId, connectionId);
            if (current.rowVersion !== input.rowVersion) staleVersion();
            const candidate = validate(logicalConnectionRecordSchema, {
              ...current,
              ...input,
            });
            endpoints(candidate);
            if (
              !db
                .prepare(
                  'UPDATE logical_connections SET endpoint_a_device_id=?,endpoint_b_device_id=?,name=?,protocol=?,notes=?,row_version=row_version+1,updated_at=? WHERE site_id=? AND id=? AND row_version=?',
                )
                .run(
                  candidate.endpointADeviceId,
                  candidate.endpointBDeviceId,
                  candidate.name,
                  candidate.protocol,
                  candidate.notes,
                  Date.now(),
                  siteId,
                  connectionId,
                  input.rowVersion,
                ).changes
            )
              staleVersion();
            return read(siteId, connectionId);
          }),
        ),
      };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/logical-connections/:connectionId',
    route,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      const { siteId, connectionId } = params(request);
      mutation(() =>
        transaction(db, () => {
          const current = read(siteId, connectionId);
          if (current.rowVersion !== input.rowVersion) staleVersion();
          if (
            !db
              .prepare(
                'DELETE FROM logical_connections WHERE site_id=? AND id=? AND row_version=?',
              )
              .run(siteId, connectionId, input.rowVersion).changes
          )
            staleVersion();
        }),
      );
      return reply.code(204).send();
    },
  );
}
