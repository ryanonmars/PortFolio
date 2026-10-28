import { z } from 'zod';
import { updatePortSchema } from './equipment.js';

const id = z.string().uuid();
const version = z.number().int().min(1);
export const customValueSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type CustomValue = z.infer<typeof customValueSchema>;
export const customValueTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'select',
  'date',
]);
export const reservedPortFieldKeys = new Set([
  'id',
  'siteid',
  'deviceid',
  'name',
  'orderindex',
  'kind',
  'speed',
  'mode',
  'documentedlinkstate',
  'nativevlanref',
  'pvid',
  'taggedvlanrefs',
  'description',
  'externaldestinationlabel',
  'face',
  'rowversion',
  'connectedto',
  'connection',
  'connections',
  'customvalues',
  'constructor',
  'prototype',
  'proto',
  'nativevlan',
  'taggedvlans',
  'port',
  'vlan',
]);
const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine(
    (key) => !reservedPortFieldKeys.has(key.replaceAll('_', '').toLowerCase()),
    'Core field names are reserved',
  );
const choices = z
  .array(z.string().trim().min(1).max(120))
  .max(50)
  .refine((items) => new Set(items).size === items.length, 'Duplicate choices');
const fieldValues = {
  key: fieldKey,
  title: z.string().trim().min(1).max(120),
  valueType: customValueTypeSchema,
  choices,
  defaultValue: customValueSchema,
  visibleByDefault: z.boolean(),
  columnOrder: z.number().int().min(0).max(65535),
};
export function validCustomValue(
  field: Pick<PortField, 'valueType' | 'choices'>,
  value: CustomValue,
): boolean {
  if (value === null) return true;
  switch (field.valueType) {
    case 'text':
      return typeof value === 'string' && value.length <= 2000;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'select':
      return typeof value === 'string' && field.choices.includes(value);
    case 'date':
      return (
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value + 'T00:00:00Z')) &&
        new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
      );
  }
}
function validateDefinition(
  field: z.infer<typeof fieldInputSchema>,
  ctx: z.RefinementCtx,
) {
  if (field.valueType === 'select' && field.choices.length === 0)
    ctx.addIssue({
      code: 'custom',
      path: ['choices'],
      message: 'Provide at least one choice',
    });
  if (field.valueType !== 'select' && field.choices.length)
    ctx.addIssue({
      code: 'custom',
      path: ['choices'],
      message: 'Choices apply only to select fields',
    });
  if (!validCustomValue(field, field.defaultValue))
    ctx.addIssue({
      code: 'custom',
      path: ['defaultValue'],
      message: 'Default does not match field type',
    });
}
const fieldInputSchema = z.object(fieldValues).strict();
export const createPortFieldSchema = z
  .object({
    ...fieldValues,
    choices: choices.default([]),
    defaultValue: customValueSchema.default(null),
    visibleByDefault: z.boolean().default(true),
    columnOrder: fieldValues.columnOrder.default(100),
  })
  .strict()
  .superRefine(validateDefinition);
export const updatePortFieldSchema = fieldInputSchema
  .omit({ key: true })
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const portFieldRecordSchema = fieldInputSchema
  .extend({ id, siteId: id, rowVersion: version })
  .strict()
  .superRefine(validateDefinition);
export type PortField = z.infer<typeof fieldInputSchema> & {
  id: string;
  siteId: string;
  rowVersion: number;
};
export const bulkPortEditSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            portId: id,
            rowVersion: version,
            changes: updatePortSchema.omit({ rowVersion: true }).strict(),
            customValues: z.record(id, customValueSchema).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(512),
  })
  .strict()
  .refine(
    (body) =>
      new Set(body.updates.map((p) => p.portId)).size === body.updates.length,
    'A port may only appear once',
  );
export type BulkPortEdit = z.infer<typeof bulkPortEditSchema>;
const connectionFields = {
  endpointAPortId: id,
  endpointBPortId: id,
  cableType: z.string().max(120),
  notes: z.string().max(2000),
};
export const createConnectionSchema = z
  .object({
    ...connectionFields,
    cableType: connectionFields.cableType.default(''),
    notes: connectionFields.notes.default(''),
    endpointARowVersion: version,
    endpointBRowVersion: version,
    replaceConnections: z
      .array(z.object({ id, rowVersion: version }).strict())
      .max(2)
      .default([]),
  })
  .strict()
  .refine(
    (body) => body.endpointAPortId !== body.endpointBPortId,
    'A port cannot connect to itself',
  )
  .refine(
    (body) =>
      new Set(body.replaceConnections.map((c) => c.id)).size ===
      body.replaceConnections.length,
    'Duplicate replacement connections',
  );
export const updateConnectionSchema = z
  .object({
    cableType: connectionFields.cableType.optional(),
    notes: connectionFields.notes.optional(),
    rowVersion: version,
  })
  .strict();
export const connectionRecordSchema = z
  .object({ ...connectionFields, id, siteId: id, rowVersion: version })
  .strict();
export type Connection = z.infer<typeof connectionRecordSchema>;
export type PortCustomValues = Record<string, Record<string, CustomValue>>;
