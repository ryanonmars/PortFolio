import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  bulkPortEditSchema,
  createConnectionSchema,
  createPortFieldSchema,
  portFieldRecordSchema,
  portRecordSchema,
  updateConnectionSchema,
  updatePortFieldSchema,
  validCustomValue,
  versionSchema,
  type Connection,
  type CustomValue,
  type PortCustomValues,
  type PortField,
} from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { equipmentStore, writePort } from './equipment.js';
import { mutation, siteRoute, staleVersion, transaction } from './resources.js';

const connectionColumns = `id,site_id AS siteId,endpoint_a_port_id AS endpointAPortId,
 endpoint_b_port_id AS endpointBPortId,cable_type AS cableType,notes,row_version AS rowVersion`;

// Match SQLite's built-in lower(name) indexes, preserving existing Unicode names.
const nameKey = (value: string) =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());

export function registerGrid(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const route = siteRoute(db, requireAuth);
  const params = (request: FastifyRequest) =>
    request.params as {
      siteId: string;
      deviceId?: string;
      fieldId?: string;
      connectionId?: string;
    };
  const { readDevice, readPort, validatePortReferences } = equipmentStore(db);
  const readField = (siteId: string, fieldId: string): PortField => {
    const record = db
      .prepare(
        `SELECT id,site_id AS siteId,key,title,value_type AS valueType,
      choices_json AS choicesJson,default_value_json AS defaultJson,visible_by_default AS visible,
      column_order AS columnOrder,row_version AS rowVersion FROM port_custom_field_defs WHERE site_id=? AND id=?`,
      )
      .get(siteId, fieldId) as
      | (Omit<PortField, 'choices' | 'defaultValue' | 'visibleByDefault'> & {
          choicesJson: string;
          defaultJson: string;
          visible: number;
        })
      | undefined;
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Custom field not found');
    const { choicesJson, defaultJson, visible, ...rest } = record;
    return {
      ...rest,
      choices: JSON.parse(choicesJson) as string[],
      defaultValue: JSON.parse(defaultJson) as CustomValue,
      visibleByDefault: Boolean(visible),
    };
  };
  const readConnection = (siteId: string, id: string): Connection => {
    const record = db
      .prepare(
        `SELECT ${connectionColumns} FROM connections WHERE site_id=? AND id=?`,
      )
      .get(siteId, id) as Connection | undefined;
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Connection not found');
    return record;
  };
  const valuesForPorts = (
    siteId: string,
    portIds: string[],
  ): PortCustomValues => {
    const result: PortCustomValues = {};
    for (const portId of portIds) {
      result[portId] = {};
      const rows = db
        .prepare(
          'SELECT field_def_id,value_json FROM port_custom_values WHERE site_id=? AND port_id=? ORDER BY field_def_id',
        )
        .all(siteId, portId) as { field_def_id: string; value_json: string }[];
      for (const row of rows)
        result[portId]![row.field_def_id] = JSON.parse(
          row.value_json,
        ) as CustomValue;
    }
    return result;
  };
  const bumpPorts = (siteId: string, ids: Set<string>) => {
    for (const id of ids)
      db.prepare(
        'UPDATE ports SET row_version=row_version+1,updated_at=? WHERE site_id=? AND id=?',
      ).run(Date.now(), siteId, id);
  };

  app.get(
    '/api/v1/sites/:siteId/devices/:deviceId/port-values',
    route,
    async (request) => {
      const { siteId, deviceId } = params(request);
      readDevice(siteId, deviceId!);
      const rows = db
        .prepare(
          'SELECT id FROM ports WHERE site_id=? AND device_id=? ORDER BY order_index,id',
        )
        .all(siteId, deviceId!) as { id: string }[];
      return {
        customValues: valuesForPorts(
          siteId,
          rows.map((row) => row.id),
        ),
      };
    },
  );
  app.post('/api/v1/sites/:siteId/ports/bulk-edit', route, async (request) => {
    const { siteId } = params(request);
    const input = validate(bulkPortEditSchema, request.body);
    const ids = input.updates.map((update) => update.portId);
    const affectedDevices = new Set<string>();
    mutation(() =>
      transaction(db, () => {
        const candidates = input.updates.map((update) => {
          const current = readPort(siteId, update.portId);
          if (current.rowVersion !== update.rowVersion) staleVersion();
          const port = validate(portRecordSchema, {
            ...current,
            ...update.changes,
          });
          validatePortReferences(port);
          affectedDevices.add(port.deviceId);
          for (const [fieldId, value] of Object.entries(
            update.customValues ?? {},
          )) {
            const field = readField(siteId, fieldId);
            if (!validCustomValue(field, value))
              throw new ApiError(
                400,
                'INVALID_CUSTOM_VALUE',
                'A custom value does not match its field type',
              );
          }
          return { port, customValues: update.customValues };
        });
        // Validate the final graph before any writes. This permits atomic swaps.
        const replacements = new Map(
          candidates.map(({ port }) => [port.id, port]),
        );
        const staging: { id: string; name: string; order: number }[] = [];
        for (const deviceId of affectedDevices) {
          const original = db
            .prepare(
              'SELECT id,name,order_index AS orderIndex FROM ports WHERE site_id=? AND device_id=?',
            )
            .all(siteId, deviceId) as {
            id: string;
            name: string;
            orderIndex: number;
          }[];
          const names = new Set<string>();
          const orders = new Set<number>();
          for (const row of original) {
            const final = replacements.get(row.id) ?? row;
            const name = nameKey(final.name);
            if (names.has(name) || orders.has(final.orderIndex))
              throw new ApiError(
                409,
                'DUPLICATE_RECORD',
                'Port names and positions must be unique within a device',
              );
            names.add(name);
            orders.add(final.orderIndex);
          }
          const unavailable = new Set([
            ...original.map((port) => port.orderIndex),
            ...orders,
          ]);
          for (const { port } of candidates.filter(
            ({ port }) => port.deviceId === deviceId,
          )) {
            let temporaryOrder = 65535;
            while (unavailable.has(temporaryOrder)) temporaryOrder -= 1;
            if (temporaryOrder < 0)
              throw new ApiError(
                409,
                'PORT_LIMIT',
                'No temporary port position is available',
              );
            unavailable.add(temporaryOrder);
            let temporaryName = `__bulk_${randomUUID()}`;
            while (
              names.has(nameKey(temporaryName)) ||
              original.some(
                (row) => nameKey(row.name) === nameKey(temporaryName),
              )
            )
              temporaryName = `__bulk_${randomUUID()}`;
            names.add(nameKey(temporaryName));
            staging.push({
              id: port.id,
              name: temporaryName,
              order: temporaryOrder,
            });
          }
        }
        for (const port of staging)
          db.prepare(
            'UPDATE ports SET name=?,order_index=? WHERE site_id=? AND id=?',
          ).run(port.name, port.order, siteId, port.id);
        for (const { port, customValues } of candidates) {
          writePort(db, port);
          for (const [fieldId, value] of Object.entries(customValues ?? {}))
            db.prepare(
              `INSERT INTO port_custom_values (port_id,field_def_id,site_id,value_json) VALUES (?,?,?,?)
          ON CONFLICT(port_id,field_def_id) DO UPDATE SET value_json=excluded.value_json`,
            ).run(port.id, fieldId, siteId, JSON.stringify(value));
        }
      }),
    );
    return {
      ports: ids.map((id) => readPort(siteId, id)),
      customValues: valuesForPorts(siteId, ids),
      devices: [...affectedDevices].map((id) => readDevice(siteId, id)),
    };
  });

  app.get('/api/v1/sites/:siteId/port-fields', route, async (request) => {
    const { siteId } = params(request);
    const rows = db
      .prepare(
        'SELECT id FROM port_custom_field_defs WHERE site_id=? ORDER BY column_order,id',
      )
      .all(siteId) as { id: string }[];
    return { fields: rows.map((row) => readField(siteId, row.id)) };
  });
  app.post(
    '/api/v1/sites/:siteId/port-fields',
    route,
    async (request, reply) => {
      const { siteId } = params(request);
      const field = validate(createPortFieldSchema, request.body);
      const id = randomUUID();
      mutation(() =>
        db
          .prepare(
            `INSERT INTO port_custom_field_defs
      (id,site_id,key,title,value_type,choices_json,default_value_json,visible_by_default,column_order,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            siteId,
            field.key,
            field.title,
            field.valueType,
            JSON.stringify(field.choices),
            JSON.stringify(field.defaultValue),
            Number(field.visibleByDefault),
            field.columnOrder,
            Date.now(),
            Date.now(),
          ),
      );
      return reply.code(201).send({ field: readField(siteId, id) });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/port-fields/:fieldId',
    route,
    async (request) => {
      const { siteId, fieldId } = params(request);
      const input = validate(updatePortFieldSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          const current = readField(siteId, fieldId!);
          if (current.rowVersion !== input.rowVersion) staleVersion();
          const candidate = validate(portFieldRecordSchema, {
            ...current,
            ...input,
          });
          const values = db
            .prepare(
              'SELECT value_json FROM port_custom_values WHERE site_id=? AND field_def_id=?',
            )
            .all(siteId, current.id) as { value_json: string }[];
          if (
            values.some(
              (row) =>
                !validCustomValue(
                  candidate,
                  JSON.parse(row.value_json) as CustomValue,
                ),
            )
          )
            throw new ApiError(
              409,
              'FIELD_VALUES_CONFLICT',
              'Existing values do not match the updated field definition',
            );
          db.prepare(
            `UPDATE port_custom_field_defs SET title=?,value_type=?,choices_json=?,default_value_json=?,visible_by_default=?,column_order=?,row_version=row_version+1,updated_at=? WHERE site_id=? AND id=? AND row_version=?`,
          ).run(
            candidate.title,
            candidate.valueType,
            JSON.stringify(candidate.choices),
            JSON.stringify(candidate.defaultValue),
            Number(candidate.visibleByDefault),
            candidate.columnOrder,
            Date.now(),
            siteId,
            current.id,
            input.rowVersion,
          );
        }),
      );
      return { field: readField(siteId, fieldId!) };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/port-fields/:fieldId',
    route,
    async (request, reply) => {
      const { siteId, fieldId } = params(request);
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          const current = readField(siteId, fieldId!);
          if (current.rowVersion !== input.rowVersion) staleVersion();
          const values = db
            .prepare(
              'SELECT port_id FROM port_custom_values WHERE site_id=? AND field_def_id=?',
            )
            .all(siteId, fieldId!) as { port_id: string }[];
          bumpPorts(siteId, new Set(values.map((row) => row.port_id)));
          db.prepare(
            'DELETE FROM port_custom_field_defs WHERE site_id=? AND id=?',
          ).run(siteId, fieldId!);
        }),
      );
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/sites/:siteId/connections', route, async (request) => {
    const { siteId } = params(request);
    return {
      connections: db
        .prepare(
          `SELECT ${connectionColumns} FROM connections WHERE site_id=? ORDER BY id`,
        )
        .all(siteId),
    };
  });
  app.post(
    '/api/v1/sites/:siteId/connections',
    route,
    async (request, reply) => {
      const { siteId } = params(request);
      const input = validate(createConnectionSchema, request.body);
      const id = randomUUID();
      const affected = new Set<string>([
        input.endpointAPortId,
        input.endpointBPortId,
      ]);
      mutation(() =>
        transaction(db, () => {
          const a = readPort(siteId, input.endpointAPortId);
          const b = readPort(siteId, input.endpointBPortId);
          if (
            a.rowVersion !== input.endpointARowVersion ||
            b.rowVersion !== input.endpointBRowVersion
          )
            staleVersion();
          const occupied = db
            .prepare(
              `SELECT ${connectionColumns} FROM connections WHERE site_id=? AND
        (endpoint_a_port_id IN (?,?) OR endpoint_b_port_id IN (?,?))`,
            )
            .all(siteId, a.id, b.id, a.id, b.id) as Connection[];
          if (
            occupied.length !== input.replaceConnections.length ||
            occupied.some(
              (connection) =>
                !input.replaceConnections.some(
                  (confirmed) => confirmed.id === connection.id,
                ),
            )
          )
            throw new ApiError(
              409,
              'CONNECTION_OCCUPIED',
              'Confirm replacement of the current documented connections',
            );
          for (const connection of occupied) {
            const confirmed = input.replaceConnections.find(
              (item) => item.id === connection.id,
            )!;
            if (connection.rowVersion !== confirmed.rowVersion) staleVersion();
            affected.add(connection.endpointAPortId);
            affected.add(connection.endpointBPortId);
          }
          for (const connection of occupied)
            db.prepare('DELETE FROM connections WHERE site_id=? AND id=?').run(
              siteId,
              connection.id,
            );
          db.prepare(
            `INSERT INTO connections (id,site_id,endpoint_a_port_id,endpoint_b_port_id,cable_type,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            siteId,
            a.id,
            b.id,
            input.cableType,
            input.notes,
            Date.now(),
            Date.now(),
          );
          bumpPorts(siteId, affected);
        }),
      );
      return reply.code(201).send({
        connection: readConnection(siteId, id),
        ports: [...affected].map((portId) => readPort(siteId, portId)),
      });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/connections/:connectionId',
    route,
    async (request) => {
      const { siteId, connectionId } = params(request);
      const input = validate(updateConnectionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          const current = readConnection(siteId, connectionId!);
          if (current.rowVersion !== input.rowVersion) staleVersion();
          db.prepare(
            'UPDATE connections SET cable_type=?,notes=?,row_version=row_version+1,updated_at=? WHERE site_id=? AND id=?',
          ).run(
            input.cableType ?? current.cableType,
            input.notes ?? current.notes,
            Date.now(),
            siteId,
            current.id,
          );
        }),
      );
      return { connection: readConnection(siteId, connectionId!) };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/connections/:connectionId',
    route,
    async (request, reply) => {
      const { siteId, connectionId } = params(request);
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          const current = readConnection(siteId, connectionId!);
          if (current.rowVersion !== input.rowVersion) staleVersion();
          db.prepare('DELETE FROM connections WHERE site_id=? AND id=?').run(
            siteId,
            current.id,
          );
          bumpPorts(
            siteId,
            new Set([current.endpointAPortId, current.endpointBPortId]),
          );
        }),
      );
      return reply.code(204).send();
    },
  );
}
