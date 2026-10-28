import { z } from 'zod';
const id = z.string().uuid();
const version = z.number().int().min(1);
const name = z.string().trim().min(1).max(120);
const text = z.string().max(2000);
const order = z.number().int().min(0).max(65535);
export const deviceTypeSchema = z.enum([
  'router',
  'switch',
  'firewall',
  'ap',
  'server',
  'custom',
  'other',
]);
export const portKindSchema = z.enum([
  'rj45',
  'sfp',
  'sfp_plus',
  'qsfp',
  'other',
]);
export const portModeSchema = z.enum([
  'access',
  'trunk',
  'routed',
  'disabled',
  'other',
]);
export const documentedLinkStateSchema = z.enum(['unknown', 'up', 'down']);
const deviceFields = {
  displayName: name,
  type: deviceTypeSchema,
  rackId: id.nullable(),
  hostname: z.string().trim().max(253),
  manufacturer: z.string().max(120),
  model: z.string().max(120),
  serial: z.string().max(120),
  managementIp: z.union([z.ipv4(), z.ipv6(), z.literal('')]),
  mac: z
    .string()
    .max(32)
    .refine(
      (v) =>
        v === '' ||
        /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(v) ||
        /^([0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/.test(v),
      'Use a MAC address or leave blank',
    ),
  description: text,
  tags: z
    .array(z.string().trim().min(1).max(64))
    .max(32)
    .refine((v) => new Set(v).size === v.length, 'Duplicate tags'),
  orderIndex: order,
};
export const createDeviceSchema = z
  .object({
    ...deviceFields,
    type: deviceTypeSchema.default('other'),
    rackId: deviceFields.rackId.default(null),
    hostname: deviceFields.hostname.default(''),
    manufacturer: deviceFields.manufacturer.default(''),
    model: deviceFields.model.default(''),
    serial: deviceFields.serial.default(''),
    managementIp: deviceFields.managementIp.default(''),
    mac: deviceFields.mac.default(''),
    description: text.default(''),
    tags: deviceFields.tags.default([]),
    orderIndex: order.optional(),
  })
  .strict();
export const updateDeviceSchema = z
  .object(deviceFields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const deviceRecordSchema = z
  .object({ ...deviceFields, id, siteId: id, rowVersion: version })
  .strict();
export type Device = z.infer<typeof deviceRecordSchema>;
export const reorderDevicesSchema = z
  .object({
    devices: z.array(z.object({ id, rowVersion: version }).strict()).max(65536),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.devices.map((device) => device.id)).size ===
      input.devices.length,
    'A device may appear only once',
  );
const portFields = {
  name,
  orderIndex: order,
  kind: portKindSchema,
  speed: z.string().max(64),
  mode: portModeSchema,
  documentedLinkState: documentedLinkStateSchema,
  nativeVlanRef: id.nullable(),
  pvid: z.number().int().min(1).max(4094).nullable(),
  taggedVlanRefs: z.array(id).max(4094),
  description: z.string().max(10000),
  externalDestinationLabel: z.string().max(500),
  face: z.enum(['front', 'rear']),
};
export function validatePortConfiguration(
  value: {
    mode: string;
    nativeVlanRef: string | null;
    taggedVlanRefs: string[];
  },
  ctx: z.RefinementCtx,
) {
  if (new Set(value.taggedVlanRefs).size !== value.taggedVlanRefs.length)
    ctx.addIssue({
      code: 'custom',
      path: ['taggedVlanRefs'],
      message: 'Duplicate VLAN memberships',
    });
  if (value.nativeVlanRef && value.taggedVlanRefs.includes(value.nativeVlanRef))
    ctx.addIssue({
      code: 'custom',
      path: ['taggedVlanRefs'],
      message: 'Native VLAN cannot also be tagged',
    });
  if (value.mode === 'access' && value.taggedVlanRefs.length)
    ctx.addIssue({
      code: 'custom',
      path: ['taggedVlanRefs'],
      message: 'Access ports cannot have tagged VLANs',
    });
}
export const createPortSchema = z
  .object({
    ...portFields,
    orderIndex: order.optional(),
    kind: portKindSchema.default('rj45'),
    speed: portFields.speed.default(''),
    mode: portModeSchema.default('other'),
    documentedLinkState: documentedLinkStateSchema.default('unknown'),
    nativeVlanRef: portFields.nativeVlanRef.default(null),
    pvid: portFields.pvid.default(null),
    taggedVlanRefs: portFields.taggedVlanRefs.default([]),
    description: portFields.description.default(''),
    externalDestinationLabel: portFields.externalDestinationLabel.default(''),
    face: portFields.face.default('front'),
  })
  .strict()
  .superRefine(validatePortConfiguration);
export const updatePortSchema = z
  .object(portFields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const portRecordSchema = z
  .object({ ...portFields, id, siteId: id, deviceId: id, rowVersion: version })
  .strict()
  .superRefine(validatePortConfiguration);
export type Port = z.infer<typeof portRecordSchema>;
export const generatePortsSchema = z
  .object({
    count: z.number().int().min(1).max(256),
    startNumber: z.number().int().min(1).max(65535).default(1),
    namePrefix: z.string().max(80).default('Port '),
    kind: portKindSchema.default('rj45'),
    mode: portModeSchema.default('other'),
    speed: portFields.speed.default(''),
    rowVersion: version,
  })
  .strict()
  .refine(
    (v) => v.startNumber + v.count - 1 <= 65535,
    'Port numbering exceeds limit',
  );
