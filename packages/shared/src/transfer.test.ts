import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDeviceSchema,
  deviceRecordSchema,
  createPortSchema,
  portRecordSchema,
} from './equipment.js';
import {
  importPreviewSchema,
  siteArchiveSchema,
  type SiteArchive,
} from './transfer.js';

function fixture(): SiteArchive {
  const workspaceId = randomUUID();
  const siteId = randomUUID();
  const device = deviceRecordSchema.parse({
    ...createDeviceSchema.parse({ displayName: 'Switch' }),
    id: randomUUID(),
    siteId,
    orderIndex: 0,
    rowVersion: 1,
  });
  const port = portRecordSchema.parse({
    ...createPortSchema.parse({ name: 'Port 1' }),
    id: randomUUID(),
    siteId,
    deviceId: device.id,
    orderIndex: 0,
    rowVersion: 1,
  });
  return {
    schemaVersion: 1,
    application: 'PortFolio',
    workspace: { id: workspaceId, name: 'Example', description: '' },
    site: {
      id: siteId,
      workspaceId,
      name: 'Lab',
      description: '',
      notes: '',
      rowVersion: 1,
    },
    racks: [],
    vlans: [],
    subnets: [],
    dhcpScopes: [],
    devices: [device],
    ports: [port],
    fields: [],
    customValues: [],
    connections: [],
    logicalConnections: [],
  };
}
describe('versioned site archive graph', () => {
  it('accepts a rackless/unassigned graph, requires a copy name and rejects unsupported or extra metadata', () => {
    const document = fixture();
    expect(siteArchiveSchema.safeParse(document).success).toBe(true);
    expect(
      importPreviewSchema.safeParse({ document, policy: 'new-site' }).success,
    ).toBe(false);
    expect(
      importPreviewSchema.parse({
        document,
        policy: 'new-site',
        siteName: '  Copy  ',
      }).siteName,
    ).toBe('Copy');
    expect(
      siteArchiveSchema.safeParse({ ...document, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      siteArchiveSchema.safeParse({ ...document, sessions: [] }).success,
    ).toBe(false);
  });
  it('enforces the512 port boundary and SQLite name uniqueness without rejecting valid Unicode names', () => {
    const document = fixture();
    const port = document.ports[0]!;
    document.ports = Array.from({ length: 512 }, (_, index) => ({
      ...port,
      id: randomUUID(),
      orderIndex: index,
      name: `Port ${index + 1}`,
    }));
    document.ports[0]!.name = 'Ä';
    document.ports[1]!.name = 'ä';
    expect(siteArchiveSchema.safeParse(document).success).toBe(true);
    document.ports.push({
      ...port,
      id: randomUUID(),
      orderIndex: 512,
      name: 'Extra',
    });
    expect(siteArchiveSchema.safeParse(document).success).toBe(false);
    document.ports.pop();
    document.ports[0]!.name = 'UPLINK';
    document.ports[1]!.name = 'uplink';
    expect(siteArchiveSchema.safeParse(document).success).toBe(false);
  });
  it('rejects same-device/foreign references, global ID collisions and occupied cable endpoints', () => {
    const document = fixture();
    const port = document.ports[0]!;
    const bad = structuredClone(document);
    bad.ports[0]!.siteId = randomUUID();
    expect(siteArchiveSchema.safeParse(bad).success).toBe(false);
    bad.ports[0]!.siteId = document.site.id;
    bad.ports[0]!.deviceId = randomUUID();
    expect(siteArchiveSchema.safeParse(bad).success).toBe(false);
    bad.ports[0]!.deviceId = document.devices[0]!.id;
    bad.ports[0]!.id = document.devices[0]!.id;
    expect(siteArchiveSchema.safeParse(bad).success).toBe(false);
    const second = { ...port, id: randomUUID(), orderIndex: 1, name: 'Port 2' };
    const third = { ...port, id: randomUUID(), orderIndex: 2, name: 'Port 3' };
    document.ports.push(second, third);
    const cable = {
      id: randomUUID(),
      siteId: document.site.id,
      rowVersion: 1,
      endpointAPortId: port.id,
      endpointBPortId: second.id,
      cableType: '',
      notes: '',
    };
    document.connections = [cable];
    expect(siteArchiveSchema.safeParse(document).success).toBe(true);
    document.connections.push({
      ...cable,
      id: randomUUID(),
      endpointAPortId: third.id,
    });
    expect(siteArchiveSchema.safeParse(document).success).toBe(false);
  });
});
