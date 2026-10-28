import { z } from 'zod';
import { deviceRecordSchema, portRecordSchema } from './equipment.js';
import { logicalConnectionRecordSchema } from './logical.js';
import {
  addressInSubnet,
  dhcpScopeRecordSchema,
  rackRecordSchema,
  subnetRecordSchema,
  vlanRecordSchema,
} from './network.js';
import {
  connectionRecordSchema,
  customValueSchema,
  portFieldRecordSchema,
  validCustomValue,
} from './grid.js';

export const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const description = z.string().max(2000);
const asciiLower = (value: string) =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());
const archiveInput = z
  .object({
    schemaVersion: z.literal(1),
    application: z.literal('PortFolio'),
    workspace: z.object({ id, name, description }).strict(),
    site: z
      .object({
        id,
        workspaceId: id,
        name,
        description,
        notes: z.string().max(10000),
        rowVersion: z.number().int().min(1),
      })
      .strict(),
    racks: z.array(rackRecordSchema).max(65536),
    vlans: z.array(vlanRecordSchema).max(4094),
    subnets: z.array(subnetRecordSchema).max(100000),
    dhcpScopes: z.array(dhcpScopeRecordSchema).max(100000),
    devices: z.array(deviceRecordSchema).max(65536),
    ports: z.array(portRecordSchema).max(100000),
    fields: z.array(portFieldRecordSchema).max(10000),
    connections: z.array(connectionRecordSchema).max(50000),
    logicalConnections: z
      .array(logicalConnectionRecordSchema)
      .max(50000)
      .default([]),
    customValues: z
      .array(
        z
          .object({ portId: id, fieldId: id, value: customValueSchema })
          .strict(),
      )
      .max(100000),
  })
  .strict();

export const siteArchiveSchema = archiveInput.superRefine((document, ctx) => {
  const problem = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  if (document.site.workspaceId !== document.workspace.id)
    problem(
      ['site', 'workspaceId'],
      'Site must belong to the exported workspace',
    );
  const ids = new Set([document.site.id, document.workspace.id]);
  if (ids.size !== 2) problem(['site', 'id'], 'Entity IDs must be unique');
  for (const key of [
    'racks',
    'vlans',
    'subnets',
    'dhcpScopes',
    'devices',
    'ports',
    'fields',
    'connections',
    'logicalConnections',
  ] as const) {
    document[key].forEach((record, index) => {
      if (record.siteId !== document.site.id)
        problem(
          [key, index, 'siteId'],
          'Record must belong to the exported site',
        );
      if (ids.has(record.id))
        problem([key, index, 'id'], 'Entity IDs must be unique');
      ids.add(record.id);
    });
  }
  const unique = <T>(
    records: T[],
    key: (record: T) => string,
    path: string,
  ) => {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      const value = key(record);
      if (seen.has(value))
        problem([path, index], 'Duplicate name, number or position');
      seen.add(value);
    });
  };
  unique(document.racks, (record) => asciiLower(record.name), 'racks');
  unique(
    document.devices,
    (record) => asciiLower(record.displayName),
    'devices',
  );
  unique(document.vlans, (record) => String(record.vlanId), 'vlans');
  unique(document.subnets, (record) => record.cidr, 'subnets');
  unique(document.fields, (record) => record.key, 'fields');
  unique(
    document.ports,
    (record) => `${record.deviceId}:${asciiLower(record.name)}`,
    'ports',
  );
  unique(
    document.ports,
    (record) => `${record.deviceId}:${record.orderIndex}`,
    'ports',
  );
  unique(
    document.customValues,
    (record) => `${record.portId}:${record.fieldId}`,
    'customValues',
  );
  const racks = new Set(document.racks.map((record) => record.id));
  const vlans = new Set(document.vlans.map((record) => record.id));
  const devices = new Set(document.devices.map((record) => record.id));
  const ports = new Set(document.ports.map((record) => record.id));
  const subnets = new Map(
    document.subnets.map((record) => [record.id, record]),
  );
  const fields = new Map(document.fields.map((record) => [record.id, record]));
  const reference = (exists: boolean, path: (string | number)[]) => {
    if (!exists) problem(path, 'Reference is outside the exported graph');
  };
  document.devices.forEach((record, index) => {
    if (record.rackId)
      reference(racks.has(record.rackId), ['devices', index, 'rackId']);
  });
  document.subnets.forEach((record, index) => {
    if (record.vlanRef)
      reference(vlans.has(record.vlanRef), ['subnets', index, 'vlanRef']);
  });
  document.dhcpScopes.forEach((record, index) => {
    const subnet = subnets.get(record.subnetId);
    reference(!!subnet, ['dhcpScopes', index, 'subnetId']);
    if (
      subnet &&
      (!addressInSubnet(subnet.cidr, record.startIp, true) ||
        !addressInSubnet(subnet.cidr, record.endIp, true))
    )
      problem(['dhcpScopes', index], 'DHCP range must be inside its subnet');
  });
  const counts = new Map<string, number>();
  document.ports.forEach((record, index) => {
    reference(devices.has(record.deviceId), ['ports', index, 'deviceId']);
    if (record.nativeVlanRef)
      reference(vlans.has(record.nativeVlanRef), [
        'ports',
        index,
        'nativeVlanRef',
      ]);
    record.taggedVlanRefs.forEach((ref) =>
      reference(vlans.has(ref), ['ports', index, 'taggedVlanRefs']),
    );
    const count = (counts.get(record.deviceId) ?? 0) + 1;
    counts.set(record.deviceId, count);
    if (count === 513)
      problem(['ports', index], 'A device may contain at most 512 ports');
  });
  const occupied = new Set<string>();
  document.connections.forEach((record, index) => {
    reference(ports.has(record.endpointAPortId), [
      'connections',
      index,
      'endpointAPortId',
    ]);
    reference(ports.has(record.endpointBPortId), [
      'connections',
      index,
      'endpointBPortId',
    ]);
    if (record.endpointAPortId === record.endpointBPortId)
      problem(['connections', index], 'A port cannot connect to itself');
    for (const endpoint of [record.endpointAPortId, record.endpointBPortId]) {
      if (occupied.has(endpoint))
        problem(
          ['connections', index],
          'A port may have only one physical connection',
        );
      occupied.add(endpoint);
    }
  });
  document.logicalConnections.forEach((record, index) => {
    reference(devices.has(record.endpointADeviceId), [
      'logicalConnections',
      index,
      'endpointADeviceId',
    ]);
    reference(devices.has(record.endpointBDeviceId), [
      'logicalConnections',
      index,
      'endpointBDeviceId',
    ]);
  });
  document.customValues.forEach((record, index) => {
    reference(ports.has(record.portId), ['customValues', index, 'portId']);
    const field = fields.get(record.fieldId);
    reference(!!field, ['customValues', index, 'fieldId']);
    if (field && !validCustomValue(field, record.value))
      problem(
        ['customValues', index, 'value'],
        'Value does not match the custom field type',
      );
  });
});
export type SiteArchive = z.infer<typeof siteArchiveSchema>;
const importInput = z
  .object({
    document: siteArchiveSchema,
    policy: z.enum(['new-site', 'replace']),
    siteName: name.optional(),
  })
  .strict();
const requireName = (
  input: { policy: string; siteName?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (input.policy === 'new-site' && !input.siteName)
    ctx.addIssue({
      code: 'custom',
      path: ['siteName'],
      message: 'Name the new site copy',
    });
};
export const importPreviewSchema = importInput.superRefine(requireName);
export const importCommitSchema = importInput
  .extend({
    previewToken: z.string().min(1).max(4096),
    confirmReplace: z.boolean().default(false),
  })
  .superRefine(requireName);
export type ImportRequest = z.infer<typeof importPreviewSchema>;
export interface ImportSummary {
  racks: number;
  vlans: number;
  subnets: number;
  dhcpScopes: number;
  devices: number;
  ports: number;
  fields: number;
  customValues: number;
  connections: number;
  logicalConnections: number;
}
export interface ImportPreview {
  token: string;
  expiresAt: string;
  policy: 'new-site' | 'replace';
  siteName: string;
  summary: ImportSummary;
  warnings: string[];
}
