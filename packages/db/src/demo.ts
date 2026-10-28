import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  createDeviceSchema,
  createPortSchema,
  createSubnetSchema,
  createVlanSchema,
  createWorkspaceSchema,
  createSiteSchema,
  createConnectionSchema,
} from '../../shared/src/index.js';

const vlanNumber = z.number().int().min(1).max(4094);
const fixturePort = z
  .object({
    name: z.string(),
    kind: z.string(),
    speed: z.string().optional(),
    mode: z.string(),
    description: z.string().optional(),
    native_vlan: vlanNumber.optional(),
    pvid: vlanNumber.optional(),
    tagged_vlans: z.array(vlanNumber).default([]),
    external_destination: z.string().optional(),
  })
  .strict();
const endpoint = z
  .object({ device_key: z.string(), port: z.string() })
  .strict();
const fixtureSchema = z
  .object({
    description: z.string().optional(),
    schema_version: z.literal('fixture-blueprint-1'),
    workspace: createWorkspaceSchema,
    site: createSiteSchema,
    vlans: z
      .array(
        z
          .object({
            id: vlanNumber,
            name: z.string(),
            color: z.string().nullable().optional(),
            description: z.string().optional(),
          })
          .strict(),
      )
      .max(4094),
    subnets: z
      .array(
        z
          .object({
            cidr: z.string(),
            vlan_id: vlanNumber.optional(),
            gateway: z.string().nullable().optional(),
          })
          .strict(),
      )
      .max(256),
    devices: z
      .array(
        z
          .object({
            key: z.string().min(1),
            display_name: z.string(),
            type: z.string(),
            manufacturer: z.string().optional(),
            model: z.string().optional(),
            ports: z.array(fixturePort).max(512),
          })
          .strict(),
      )
      .max(64),
    connections: z
      .array(
        z
          .object({
            from: endpoint,
            to: endpoint,
            cable_type: z.string().optional(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

function requireUnique(values: (string | number)[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${label} in fixture`);
}

/** Explicit development/test fixture loader. No credentials or production autoload. */
export function seedDemo(
  db: DatabaseSync,
  input: unknown,
  environment = process.env.NODE_ENV,
) {
  if (environment !== 'development' && environment !== 'test')
    throw new Error('Demo seed is restricted to development/test');
  const fixture = fixtureSchema.parse(input);
  requireUnique(
    fixture.vlans.map((v) => v.id),
    'VLAN ID',
  );
  requireUnique(
    fixture.subnets.map((v) => v.cidr),
    'subnet',
  );
  requireUnique(
    fixture.devices.map((d) => d.key),
    'device key',
  );
  requireUnique(
    fixture.devices.map((d) => d.display_name.trim().toLowerCase()),
    'device name',
  );
  const workspaceId = randomUUID(),
    siteId = randomUUID(),
    now = Date.now();
  const vlans = fixture.vlans.map((v) => ({
    id: randomUUID(),
    ...createVlanSchema.parse({
      vlanId: v.id,
      name: v.name,
      color: v.color,
      description: v.description,
    }),
  }));
  const vlanRef = (number: number | undefined): string | null => {
    if (number === undefined) return null;
    const vlan = vlans.find((v) => v.vlanId === number);
    if (!vlan) throw new Error('Fixture references an undefined VLAN');
    return vlan.id;
  };
  const subnets = fixture.subnets.map((s) => ({
    id: randomUUID(),
    ...createSubnetSchema.parse({
      cidr: s.cidr,
      vlanRef: vlanRef(s.vlan_id),
      gatewayIp: s.gateway,
    }),
  }));
  const devices = fixture.devices.map((d, index) => {
    requireUnique(
      d.ports.map((p) => p.name.trim().toLowerCase()),
      'port name',
    );
    const device = {
      id: randomUUID(),
      ...createDeviceSchema.parse({
        displayName: d.display_name,
        type: d.type,
        manufacturer: d.manufacturer,
        model: d.model,
        orderIndex: index,
      }),
    };
    const ports = d.ports.map((p, orderIndex) => ({
      id: randomUUID(),
      ...createPortSchema.parse({
        name: p.name,
        kind: p.kind,
        speed: p.speed,
        mode: p.mode,
        description: p.description,
        nativeVlanRef: vlanRef(p.native_vlan),
        pvid: p.pvid,
        taggedVlanRefs: p.tagged_vlans.map((v) => vlanRef(v)!),
        externalDestinationLabel: p.external_destination,
        orderIndex,
      }),
    }));
    return { key: d.key, device, ports };
  });
  const occupied = new Set<string>();
  const connections = fixture.connections.map((connection) => {
    const from = devices
      .find((d) => d.key === connection.from.device_key)
      ?.ports.find((p) => p.name === connection.from.port);
    const to = devices
      .find((d) => d.key === connection.to.device_key)
      ?.ports.find((p) => p.name === connection.to.port);
    if (!from || !to || from.id === to.id)
      throw new Error('Invalid fixture connection');
    if (occupied.has(from.id) || occupied.has(to.id))
      throw new Error('Duplicate fixture connection endpoint');
    occupied.add(from.id);
    occupied.add(to.id);
    return createConnectionSchema.parse({
      endpointAPortId: from.id,
      endpointBPortId: to.id,
      endpointARowVersion: 1,
      endpointBRowVersion: 1,
      cableType: connection.cable_type ?? '',
    });
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT id FROM workspaces LIMIT 1').get())
      throw new Error(
        'Demo seed requires an empty workspace inventory; existing data will not be overwritten',
      );
    db.prepare(
      'INSERT INTO workspaces(id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run(
      workspaceId,
      fixture.workspace.name,
      fixture.workspace.description,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO sites(id,workspace_id,name,description,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      siteId,
      workspaceId,
      fixture.site.name,
      fixture.site.description,
      fixture.site.notes,
      now,
      now,
    );
    for (const v of vlans)
      db.prepare(
        'INSERT INTO vlans(id,site_id,vlan_id,name,color_hex,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(v.id, siteId, v.vlanId, v.name, v.color, v.description, now, now);
    for (const s of subnets)
      db.prepare(
        'INSERT INTO subnets(id,site_id,vlan_ref,cidr,name,gateway_ip,dns_servers_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(
        s.id,
        siteId,
        s.vlanRef,
        s.cidr,
        s.name,
        s.gatewayIp,
        JSON.stringify(s.dnsServers),
        s.notes,
        now,
        now,
      );
    for (const { device: d, ports } of devices) {
      db.prepare(
        'INSERT INTO devices(id,site_id,rack_id,type,display_name,hostname,manufacturer,model,serial,management_ip,mac,description,metadata_tags_json,order_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        d.id,
        siteId,
        d.rackId,
        d.type,
        d.displayName,
        d.hostname,
        d.manufacturer,
        d.model,
        d.serial,
        d.managementIp,
        d.mac,
        d.description,
        JSON.stringify(d.tags),
        d.orderIndex!,
        now,
        now,
      );
      for (const p of ports) {
        db.prepare(
          'INSERT INTO ports(id,site_id,device_id,name,order_index,kind,speed,mode,documented_link_state,native_vlan_ref,pvid,description,external_destination_label,face,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          p.id,
          siteId,
          d.id,
          p.name,
          p.orderIndex!,
          p.kind,
          p.speed,
          p.mode,
          p.documentedLinkState,
          p.nativeVlanRef,
          p.pvid,
          p.description,
          p.externalDestinationLabel,
          p.face,
          now,
          now,
        );
        for (const ref of p.taggedVlanRefs)
          db.prepare(
            'INSERT INTO port_tagged_vlans(port_id,site_id,vlan_ref) VALUES (?,?,?)',
          ).run(p.id, siteId, ref);
      }
    }
    for (const cable of connections)
      db.prepare(
        'INSERT INTO connections(id,site_id,endpoint_a_port_id,endpoint_b_port_id,cable_type,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        randomUUID(),
        siteId,
        cable.endpointAPortId,
        cable.endpointBPortId,
        cable.cableType,
        cable.notes,
        now,
        now,
      );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    workspaceId,
    siteId,
    devices: devices.length,
    ports: devices.reduce((sum, d) => sum + d.ports.length, 0),
    vlans: vlans.length,
    subnets: subnets.length,
    connections: connections.length,
  };
}
