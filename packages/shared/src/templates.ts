import { z } from 'zod';
import {
  createDeviceSchema,
  deviceTypeSchema,
  portKindSchema,
  portModeSchema,
} from './equipment.js';

export const templatePortGroupSchema = z
  .object({
    count: z.number().int().min(0).max(512),
    kind: portKindSchema.default('rj45'),
    speed: z.string().max(64).default(''),
    mode: portModeSchema.default('other'),
    face: z.enum(['front', 'rear']).default('front'),
    namePrefix: z.string().max(80).default('Port '),
  })
  .strict();
export type TemplatePortGroup = z.infer<typeof templatePortGroupSchema>;
export const templatePortGroupsSchema = z
  .array(templatePortGroupSchema)
  .max(16)
  .refine(
    (groups) => groups.reduce((sum, group) => sum + group.count, 0) <= 512,
    'A device may contain at most 512 ports',
  )
  .superRefine((groups, ctx) => {
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    if (
      total > 512 ||
      groups.some(
        (group) =>
          !Number.isInteger(group.count) ||
          group.count < 0 ||
          group.count > 512,
      )
    )
      return;
    const names = new Set<string>();
    let index = 0;
    for (const [groupIndex, group] of groups.entries())
      for (let offset = 0; offset < group.count; offset++) {
        const name = (group.namePrefix + ++index)
          .trim()
          .replace(/[A-Z]/g, (c) => c.toLowerCase());
        if (names.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: [groupIndex, 'namePrefix'],
            message: 'Port groups produce duplicate port names',
          });
          return;
        }
        names.add(name);
      }
  });
const fields = {
  name: z.string().trim().min(1).max(120),
  type: deviceTypeSchema,
  description: z.string().max(2000),
  groups: templatePortGroupsSchema,
};
export const createTemplateSchema = z
  .object({
    ...fields,
    type: deviceTypeSchema.default('custom'),
    description: fields.description.default(''),
    groups: templatePortGroupsSchema.default([]),
  })
  .strict();
export const updateTemplateSchema = z
  .object(fields)
  .partial()
  .extend({ rowVersion: z.number().int().min(1) })
  .strict();
export const deviceTemplateRecordSchema = z
  .object({
    ...fields,
    id: z.union([
      z.string().uuid(),
      z.enum([
        'builtin:router',
        'builtin:switch',
        'builtin:firewall',
        'builtin:access-point',
        'builtin:server',
        'builtin:custom',
      ]),
    ]),
    rowVersion: z.number().int().min(1),
  })
  .strict();
export type DeviceTemplate = z.infer<typeof deviceTemplateRecordSchema>;
export const createTemplatedDeviceSchema = z
  .object({ device: createDeviceSchema, groups: templatePortGroupsSchema })
  .strict();
export const addTemplatePortsSchema = z
  .object({
    rowVersion: z.number().int().min(1),
    groups: templatePortGroupsSchema,
  })
  .strict()
  .refine(
    (input) => input.groups.some((group) => group.count > 0),
    'Add at least one port',
  );

const group = (
  count: number,
  mode: TemplatePortGroup['mode'] = 'other',
): TemplatePortGroup => ({
  count,
  kind: 'rj45',
  speed: '',
  mode,
  face: 'front',
  namePrefix: 'Port ',
});
export const builtInDeviceTemplates: DeviceTemplate[] = [
  {
    id: 'builtin:router',
    name: 'Router',
    type: 'router',
    description: 'Four configurable physical interfaces.',
    groups: [group(4, 'routed')],
    rowVersion: 1,
  },
  {
    id: 'builtin:switch',
    name: 'Switch',
    type: 'switch',
    description: 'Eight configurable RJ45 ports.',
    groups: [group(8)],
    rowVersion: 1,
  },
  {
    id: 'builtin:firewall',
    name: 'Firewall',
    type: 'firewall',
    description: 'Four routed interfaces for a firewall.',
    groups: [group(4, 'routed')],
    rowVersion: 1,
  },
  {
    id: 'builtin:access-point',
    name: 'Wireless access point',
    type: 'ap',
    description: 'One physical Ethernet interface.',
    groups: [group(1)],
    rowVersion: 1,
  },
  {
    id: 'builtin:server',
    name: 'Server',
    type: 'server',
    description: 'Two configurable network interfaces.',
    groups: [group(2)],
    rowVersion: 1,
  },
  {
    id: 'builtin:custom',
    name: 'Custom device',
    type: 'custom',
    description: 'Start with an empty port layout.',
    groups: [],
    rowVersion: 1,
  },
];
