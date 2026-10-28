import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  builtInDeviceTemplates,
  createTemplateSchema,
  updateTemplateSchema,
  deviceTemplateRecordSchema,
  createTemplatedDeviceSchema,
  deviceRecordSchema,
  portRecordSchema,
  versionSchema,
  type DeviceTemplate,
  type Port,
} from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { equipmentStore } from './equipment.js';
import { mutation, siteRoute, staleVersion, transaction } from './resources.js';

export function registerTemplates(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const protectedRoute = {
    preHandler: async (request: FastifyRequest) => {
      requireAuth(request);
    },
  };
  const params = (request: FastifyRequest) =>
    request.params as { templateId: string };
  const read = (id: string): DeviceTemplate => {
    const builtin = builtInDeviceTemplates.find(
      (template) => template.id === id,
    );
    if (builtin) return builtin;
    const record = db
      .prepare(
        'SELECT id,name,type,description,groups_json AS groupsJson,row_version AS rowVersion FROM device_templates WHERE id=?',
      )
      .get(id) as
      (Omit<DeviceTemplate, 'groups'> & { groupsJson: string }) | undefined;
    if (!record)
      throw new ApiError(404, 'NOT_FOUND', 'Device template not found');
    const { groupsJson, ...rest } = record;
    return validate(deviceTemplateRecordSchema, {
      ...rest,
      groups: JSON.parse(groupsJson),
    });
  };
  const requireEditable = (id: string) => {
    if (builtInDeviceTemplates.some((template) => template.id === id))
      throw new ApiError(
        400,
        'READ_ONLY_TEMPLATE',
        'Built-in templates are read-only. Save a reusable copy to customize one',
      );
  };
  app.get('/api/v1/device-templates', protectedRoute, async () => ({
    templates: [
      ...builtInDeviceTemplates,
      ...db
        .prepare('SELECT id FROM device_templates ORDER BY lower(name),id')
        .all()
        .map((row) => read(String(row.id))),
    ],
  }));
  app.post(
    '/api/v1/device-templates',
    protectedRoute,
    async (request, reply) => {
      const input = validate(createTemplateSchema, request.body);
      const id = randomUUID();
      mutation(() =>
        transaction(db, () => {
          db.prepare(
            'INSERT INTO device_templates(id,name,type,description,groups_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          ).run(
            id,
            input.name,
            input.type,
            input.description,
            JSON.stringify(input.groups),
            Date.now(),
            Date.now(),
          );
        }),
      );
      return reply.code(201).send({ template: read(id) });
    },
  );
  app.patch(
    '/api/v1/device-templates/:templateId',
    protectedRoute,
    async (request) => {
      const { templateId } = params(request);
      requireEditable(templateId);
      const input = validate(updateTemplateSchema, request.body);
      const current = read(templateId);
      const candidate = validate(deviceTemplateRecordSchema, {
        ...current,
        ...input,
      });
      mutation(() =>
        transaction(db, () => {
          if (
            !db
              .prepare(
                'UPDATE device_templates SET name=?,type=?,description=?,groups_json=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
              )
              .run(
                candidate.name,
                candidate.type,
                candidate.description,
                JSON.stringify(candidate.groups),
                Date.now(),
                templateId,
                input.rowVersion,
              ).changes
          )
            staleVersion();
        }),
      );
      return { template: read(templateId) };
    },
  );
  app.delete(
    '/api/v1/device-templates/:templateId',
    protectedRoute,
    async (request, reply) => {
      const { templateId } = params(request);
      requireEditable(templateId);
      read(templateId);
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          if (
            !db
              .prepare(
                'DELETE FROM device_templates WHERE id=? AND row_version=?',
              )
              .run(templateId, input.rowVersion).changes
          )
            staleVersion();
        }),
      );
      return reply.code(204).send();
    },
  );

  const store = equipmentStore(db);
  app.post(
    '/api/v1/sites/:siteId/devices/from-template',
    siteRoute(db, requireAuth),
    async (request, reply) => {
      const { siteId } = request.params as { siteId: string };
      const input = validate(createTemplatedDeviceSchema, request.body);
      const result = mutation(() =>
        transaction(db, () => {
          store.requireReference('racks', siteId, input.device.rackId);
          const next = db
            .prepare(
              'SELECT coalesce(max(order_index),-1)+1 AS next FROM devices WHERE site_id=?',
            )
            .get(siteId) as { next: number };
          const device = validate(deviceRecordSchema, {
            ...input.device,
            id: randomUUID(),
            siteId,
            orderIndex: input.device.orderIndex ?? next.next,
            rowVersion: 1,
          });
          const now = Date.now();
          db.prepare(
            'INSERT INTO devices(id,site_id,rack_id,type,display_name,hostname,manufacturer,model,serial,management_ip,mac,description,metadata_tags_json,order_index,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            device.id,
            siteId,
            device.rackId,
            device.type,
            device.displayName,
            device.hostname,
            device.manufacturer,
            device.model,
            device.serial,
            device.managementIp,
            device.mac,
            device.description,
            JSON.stringify(device.tags),
            device.orderIndex,
            now,
            now,
          );
          const ports: Port[] = [];
          for (const group of input.groups) {
            for (let offset = 0; offset < group.count; offset++) {
              const index = ports.length;
              const port = validate(portRecordSchema, {
                id: randomUUID(),
                siteId,
                deviceId: device.id,
                name: `${group.namePrefix}${index + 1}`,
                orderIndex: index,
                kind: group.kind,
                speed: group.speed,
                mode: group.mode,
                face: group.face,
                documentedLinkState: 'unknown',
                nativeVlanRef: null,
                pvid: null,
                taggedVlanRefs: [],
                description: '',
                externalDestinationLabel: '',
                rowVersion: 1,
              });
              db.prepare(
                'INSERT INTO ports(id,site_id,device_id,name,order_index,kind,speed,mode,documented_link_state,native_vlan_ref,pvid,description,external_destination_label,face,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              ).run(
                port.id,
                siteId,
                device.id,
                port.name,
                port.orderIndex,
                port.kind,
                port.speed,
                port.mode,
                port.documentedLinkState,
                null,
                null,
                '',
                '',
                port.face,
                now,
                now,
              );
              ports.push(port);
            }
          }
          return {
            device: store.readDevice(siteId, device.id),
            ports: ports.map((port) => store.readPort(siteId, port.id)),
          };
        }),
      );
      return reply.code(201).send(result);
    },
  );
}
