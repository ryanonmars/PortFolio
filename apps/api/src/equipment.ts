import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createDeviceSchema,
  addTemplatePortsSchema,
  createPortSchema,
  deviceRecordSchema,
  generatePortsSchema,
  portRecordSchema,
  reorderDevicesSchema,
  updateDeviceSchema,
  updatePortSchema,
  versionSchema,
  type Device,
  type Port,
} from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { mutation, siteRoute, staleVersion, transaction } from './resources.js';

const deviceColumns = `id,site_id AS siteId,rack_id AS rackId,type,display_name AS displayName,
 hostname,manufacturer,model,serial,management_ip AS managementIp,mac,description,
 metadata_tags_json AS tagsJson,order_index AS orderIndex,row_version AS rowVersion`;
const portColumns = `id,site_id AS siteId,device_id AS deviceId,name,order_index AS orderIndex,
 kind,speed,mode,documented_link_state AS documentedLinkState,native_vlan_ref AS nativeVlanRef,
 pvid,description,external_destination_label AS externalDestinationLabel,face,row_version AS rowVersion`;
const maximumPorts = 512;

type Params = { siteId: string; deviceId?: string; portId?: string };

export function equipmentStore(db: DatabaseSync) {
  const readDevice = (siteId: string, id: string): Device => {
    const row = db
      .prepare(`SELECT ${deviceColumns} FROM devices WHERE site_id=? AND id=?`)
      .get(siteId, id) as
      (Omit<Device, 'tags'> & { tagsJson: string }) | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Device not found');
    const { tagsJson, ...record } = row;
    return { ...record, tags: JSON.parse(tagsJson) as string[] };
  };
  const readPort = (siteId: string, id: string): Port => {
    const row = db
      .prepare(`SELECT ${portColumns} FROM ports WHERE site_id=? AND id=?`)
      .get(siteId, id) as Omit<Port, 'taggedVlanRefs'> | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Port not found');
    const tags = db
      .prepare(
        'SELECT vlan_ref FROM port_tagged_vlans WHERE site_id=? AND port_id=? ORDER BY vlan_ref',
      )
      .all(siteId, id) as { vlan_ref: string }[];
    return { ...row, taggedVlanRefs: tags.map((tag) => tag.vlan_ref) };
  };
  const requireReference = (
    table: 'racks' | 'vlans',
    siteId: string,
    id: string | null,
  ) => {
    if (
      id &&
      !db
        .prepare(`SELECT id FROM ${table} WHERE site_id=? AND id=?`)
        .get(siteId, id)
    )
      throw new ApiError(
        400,
        'INVALID_REFERENCE',
        'A referenced record is unavailable in this site',
      );
  };
  const validatePortReferences = (
    port: Pick<Port, 'siteId' | 'nativeVlanRef' | 'taggedVlanRefs'>,
  ) => {
    requireReference('vlans', port.siteId, port.nativeVlanRef);
    for (const id of port.taggedVlanRefs)
      requireReference('vlans', port.siteId, id);
  };
  return { readDevice, readPort, requireReference, validatePortReferences };
}

export function registerEquipment(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const route = siteRoute(db, requireAuth);
  const params = (request: FastifyRequest) => request.params as Params;
  const { readDevice, readPort, requireReference, validatePortReferences } =
    equipmentStore(db);
  const nextOrder = (
    table: 'devices' | 'ports',
    siteId: string,
    deviceId?: string,
  ): number => {
    const row = deviceId
      ? db
          .prepare(
            'SELECT coalesce(max(order_index),-1)+1 AS next FROM ports WHERE site_id=? AND device_id=?',
          )
          .get(siteId, deviceId)
      : db
          .prepare(
            `SELECT coalesce(max(order_index),-1)+1 AS next FROM ${table} WHERE site_id=?`,
          )
          .get(siteId);
    return (row as { next: number }).next;
  };
  const requirePortCapacity = (
    siteId: string,
    deviceId: string,
    addition: number,
  ) => {
    const { count } = db
      .prepare(
        'SELECT count(*) AS count FROM ports WHERE site_id=? AND device_id=?',
      )
      .get(siteId, deviceId) as { count: number };
    if (count + addition > maximumPorts)
      throw new ApiError(
        400,
        'PORT_LIMIT',
        'A device may contain at most 512 ports',
      );
  };
  const bumpDevice = (siteId: string, deviceId: string) => {
    db.prepare(
      'UPDATE devices SET row_version=row_version+1,updated_at=? WHERE site_id=? AND id=?',
    ).run(Date.now(), siteId, deviceId);
  };
  const insertPort = (port: Port) => {
    validatePortReferences(port);
    db.prepare(
      `INSERT INTO ports (id,site_id,device_id,name,order_index,kind,speed,mode,documented_link_state,native_vlan_ref,pvid,description,external_destination_label,face,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      port.id,
      port.siteId,
      port.deviceId,
      port.name,
      port.orderIndex,
      port.kind,
      port.speed,
      port.mode,
      port.documentedLinkState,
      port.nativeVlanRef,
      port.pvid,
      port.description,
      port.externalDestinationLabel,
      port.face,
      Date.now(),
      Date.now(),
    );
    for (const vlanRef of port.taggedVlanRefs)
      db.prepare(
        'INSERT INTO port_tagged_vlans (port_id,site_id,vlan_ref) VALUES (?,?,?)',
      ).run(port.id, port.siteId, vlanRef);
  };

  app.get('/api/v1/sites/:siteId/devices', route, async (request) => {
    const { siteId } = params(request);
    const rows = db
      .prepare(
        'SELECT id FROM devices WHERE site_id=? ORDER BY order_index,display_name,id',
      )
      .all(siteId) as { id: string }[];
    return { devices: rows.map((row) => readDevice(siteId, row.id)) };
  });
  app.post('/api/v1/sites/:siteId/devices/reorder', route, async (request) => {
    const { siteId } = params(request);
    const input = validate(reorderDevicesSchema, request.body);
    mutation(() =>
      transaction(db, () => {
        const current = db
          .prepare(
            'SELECT id,row_version AS rowVersion FROM devices WHERE site_id=?',
          )
          .all(siteId) as { id: string; rowVersion: number }[];
        const expected = new Map(
          current.map((device) => [device.id, device.rowVersion]),
        );
        if (
          current.length !== input.devices.length ||
          input.devices.some(
            (device) => expected.get(device.id) !== device.rowVersion,
          )
        )
          staleVersion();
        const update = db.prepare(
          'UPDATE devices SET order_index=?,row_version=row_version+1,updated_at=? WHERE site_id=? AND id=? AND row_version=?',
        );
        input.devices.forEach((device, index) => {
          if (
            !update.run(index, Date.now(), siteId, device.id, device.rowVersion)
              .changes
          )
            staleVersion();
        });
      }),
    );
    return {
      devices: input.devices.map((device) => readDevice(siteId, device.id)),
    };
  });
  app.post('/api/v1/sites/:siteId/devices', route, async (request, reply) => {
    const { siteId } = params(request);
    const input = validate(createDeviceSchema, request.body);
    const device = validate(deviceRecordSchema, {
      ...input,
      id: randomUUID(),
      siteId,
      orderIndex: input.orderIndex ?? nextOrder('devices', siteId),
      rowVersion: 1,
    });
    mutation(() =>
      transaction(db, () => {
        requireReference('racks', siteId, device.rackId);
        db.prepare(
          `INSERT INTO devices (id,site_id,rack_id,type,display_name,hostname,manufacturer,model,serial,management_ip,mac,description,metadata_tags_json,order_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          Date.now(),
          Date.now(),
        );
      }),
    );
    return reply.code(201).send({ device: readDevice(siteId, device.id) });
  });
  app.get('/api/v1/sites/:siteId/devices/:deviceId', route, async (request) => {
    const { siteId, deviceId } = params(request);
    return { device: readDevice(siteId, deviceId!) };
  });
  app.patch(
    '/api/v1/sites/:siteId/devices/:deviceId',
    route,
    async (request) => {
      const { siteId, deviceId } = params(request);
      const current = readDevice(siteId, deviceId!);
      const input = validate(updateDeviceSchema, request.body);
      const candidate = validate(deviceRecordSchema, { ...current, ...input });
      mutation(() =>
        transaction(db, () => {
          if (current.rowVersion !== input.rowVersion) staleVersion();
          requireReference('racks', siteId, candidate.rackId);
          const result = db
            .prepare(
              `UPDATE devices SET rack_id=?,type=?,display_name=?,hostname=?,manufacturer=?,model=?,serial=?,management_ip=?,mac=?,description=?,metadata_tags_json=?,order_index=?,row_version=row_version+1,updated_at=? WHERE site_id=? AND id=? AND row_version=?`,
            )
            .run(
              candidate.rackId,
              candidate.type,
              candidate.displayName,
              candidate.hostname,
              candidate.manufacturer,
              candidate.model,
              candidate.serial,
              candidate.managementIp,
              candidate.mac,
              candidate.description,
              JSON.stringify(candidate.tags),
              candidate.orderIndex,
              Date.now(),
              siteId,
              current.id,
              input.rowVersion,
            );
          if (!result.changes) staleVersion();
        }),
      );
      return { device: readDevice(siteId, current.id) };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/devices/:deviceId',
    route,
    async (request, reply) => {
      const { siteId, deviceId } = params(request);
      const current = readDevice(siteId, deviceId!);
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          if (current.rowVersion !== input.rowVersion) staleVersion();
          if (
            db
              .prepare(
                'SELECT id FROM logical_connections WHERE site_id=? AND (endpoint_a_device_id=? OR endpoint_b_device_id=?) LIMIT 1',
              )
              .get(siteId, current.id, current.id)
          )
            throw new ApiError(
              409,
              'CONNECTED_DEVICE',
              'Disconnect this device’s documented logical connections first',
            );
          if (
            db
              .prepare(
                'SELECT c.id FROM connections c JOIN ports p ON p.id=c.endpoint_a_port_id OR p.id=c.endpoint_b_port_id WHERE p.site_id=? AND p.device_id=? LIMIT 1',
              )
              .get(siteId, current.id)
          )
            throw new ApiError(
              409,
              'CONNECTED_PORT',
              'Disconnect this device’s documented connections first',
            );
          if (
            !db
              .prepare(
                'DELETE FROM devices WHERE site_id=? AND id=? AND row_version=?',
              )
              .run(siteId, current.id, input.rowVersion).changes
          )
            staleVersion();
        }),
      );
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/sites/:siteId/devices/:deviceId/ports',
    route,
    async (request) => {
      const { siteId, deviceId } = params(request);
      readDevice(siteId, deviceId!);
      const rows = db
        .prepare(
          'SELECT id FROM ports WHERE site_id=? AND device_id=? ORDER BY order_index,id',
        )
        .all(siteId, deviceId!) as { id: string }[];
      return { ports: rows.map((row) => readPort(siteId, row.id)) };
    },
  );
  app.post(
    '/api/v1/sites/:siteId/devices/:deviceId/ports',
    route,
    async (request, reply) => {
      const { siteId, deviceId } = params(request);
      readDevice(siteId, deviceId!);
      const input = validate(createPortSchema, request.body);
      const port = validate(portRecordSchema, {
        ...input,
        id: randomUUID(),
        siteId,
        deviceId,
        orderIndex: input.orderIndex ?? nextOrder('ports', siteId, deviceId!),
        rowVersion: 1,
      });
      mutation(() =>
        transaction(db, () => {
          requirePortCapacity(siteId, deviceId!, 1);
          insertPort(port);
          bumpDevice(siteId, deviceId!);
        }),
      );
      return reply.code(201).send({ port: readPort(siteId, port.id) });
    },
  );
  app.post(
    '/api/v1/sites/:siteId/devices/:deviceId/ports/from-template',
    route,
    async (request, reply) => {
      const { siteId, deviceId } = params(request);
      const input = validate(addTemplatePortsSchema, request.body);
      const created: string[] = [];
      mutation(() =>
        transaction(db, () => {
          const current = readDevice(siteId, deviceId!);
          if (current.rowVersion !== input.rowVersion) staleVersion();
          const count = input.groups.reduce(
            (sum, group) => sum + group.count,
            0,
          );
          requirePortCapacity(siteId, current.id, count);
          const startOrder = nextOrder('ports', siteId, current.id);
          for (const group of input.groups)
            for (let offset = 0; offset < group.count; offset++) {
              const orderIndex = startOrder + created.length;
              const configuration = validate(createPortSchema, {
                name: `${group.namePrefix}${orderIndex + 1}`,
                orderIndex,
                kind: group.kind,
                speed: group.speed,
                mode: group.mode,
                face: group.face,
              });
              const port = validate(portRecordSchema, {
                ...configuration,
                id: randomUUID(),
                siteId,
                deviceId: current.id,
                rowVersion: 1,
              });
              insertPort(port);
              created.push(port.id);
            }
          bumpDevice(siteId, current.id);
        }),
      );
      return reply.code(201).send({
        device: readDevice(siteId, deviceId!),
        ports: created.map((id) => readPort(siteId, id)),
      });
    },
  );
  app.post(
    '/api/v1/sites/:siteId/devices/:deviceId/ports/generate',
    route,
    async (request, reply) => {
      const { siteId, deviceId } = params(request);
      const current = readDevice(siteId, deviceId!);
      const input = validate(generatePortsSchema, request.body);
      const created: string[] = [];
      mutation(() =>
        transaction(db, () => {
          if (current.rowVersion !== input.rowVersion) staleVersion();
          requirePortCapacity(siteId, current.id, input.count);
          const orderIndex = nextOrder('ports', siteId, current.id);
          for (let index = 0; index < input.count; index++) {
            const configuration = validate(createPortSchema, {
              name: `${input.namePrefix}${input.startNumber + index}`,
              orderIndex: orderIndex + index,
              kind: input.kind,
              mode: input.mode,
              speed: input.speed,
            });
            const port = validate(portRecordSchema, {
              ...configuration,
              id: randomUUID(),
              siteId,
              deviceId: current.id,
              rowVersion: 1,
            });
            insertPort(port);
            created.push(port.id);
          }
          const result = db
            .prepare(
              'UPDATE devices SET row_version=row_version+1,updated_at=? WHERE site_id=? AND id=? AND row_version=?',
            )
            .run(Date.now(), siteId, current.id, input.rowVersion);
          if (!result.changes) staleVersion();
        }),
      );
      return reply.code(201).send({
        ports: created.map((id) => readPort(siteId, id)),
        device: readDevice(siteId, current.id),
      });
    },
  );
  app.get('/api/v1/sites/:siteId/ports/:portId', route, async (request) => {
    const { siteId, portId } = params(request);
    return { port: readPort(siteId, portId!) };
  });
  app.patch('/api/v1/sites/:siteId/ports/:portId', route, async (request) => {
    const { siteId, portId } = params(request);
    const current = readPort(siteId, portId!);
    const input = validate(updatePortSchema, request.body);
    const candidate = validate(portRecordSchema, { ...current, ...input });
    mutation(() =>
      transaction(db, () => {
        if (current.rowVersion !== input.rowVersion) staleVersion();
        validatePortReferences(candidate);
        writePort(db, candidate);
      }),
    );
    return { port: readPort(siteId, current.id) };
  });
  app.delete(
    '/api/v1/sites/:siteId/ports/:portId',
    route,
    async (request, reply) => {
      const { siteId, portId } = params(request);
      const current = readPort(siteId, portId!);
      const input = validate(versionSchema, request.body);
      mutation(() =>
        transaction(db, () => {
          if (
            db
              .prepare(
                'SELECT id FROM connections WHERE site_id=? AND (endpoint_a_port_id=? OR endpoint_b_port_id=?) LIMIT 1',
              )
              .get(siteId, current.id, current.id)
          )
            throw new ApiError(
              409,
              'CONNECTED_PORT',
              'Disconnect this port’s documented connection first',
            );
          if (
            !db
              .prepare(
                'DELETE FROM ports WHERE site_id=? AND id=? AND row_version=?',
              )
              .run(siteId, current.id, input.rowVersion).changes
          )
            staleVersion();
          bumpDevice(siteId, current.deviceId);
        }),
      );
      return reply.code(204).send();
    },
  );
}

export function writePort(db: DatabaseSync, candidate: Port) {
  // Remove old memberships only after validating the complete replacement.
  // This permits explicit tag/native swaps without transient trigger conflicts.
  db.prepare('DELETE FROM port_tagged_vlans WHERE site_id=? AND port_id=?').run(
    candidate.siteId,
    candidate.id,
  );
  const result = db
    .prepare(
      `UPDATE ports SET name=?,order_index=?,kind=?,speed=?,mode=?,documented_link_state=?,native_vlan_ref=?,pvid=?,description=?,external_destination_label=?,face=?,row_version=row_version+1,updated_at=? WHERE site_id=? AND id=? AND row_version=?`,
    )
    .run(
      candidate.name,
      candidate.orderIndex,
      candidate.kind,
      candidate.speed,
      candidate.mode,
      candidate.documentedLinkState,
      candidate.nativeVlanRef,
      candidate.pvid,
      candidate.description,
      candidate.externalDestinationLabel,
      candidate.face,
      Date.now(),
      candidate.siteId,
      candidate.id,
      candidate.rowVersion,
    );
  if (!result.changes) staleVersion();
  for (const vlanRef of candidate.taggedVlanRefs)
    db.prepare(
      'INSERT INTO port_tagged_vlans (port_id,site_id,vlan_ref) VALUES (?,?,?)',
    ).run(candidate.id, candidate.siteId, vlanRef);
}
