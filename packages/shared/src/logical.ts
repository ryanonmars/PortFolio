import { z } from 'zod';

const id = z.string().uuid();
const version = z.number().int().min(1);
const fields = {
  endpointADeviceId: id,
  endpointBDeviceId: id,
  name: z.string().trim().max(120),
  protocol: z.string().trim().max(120),
  notes: z.string().max(2000),
};
function distinctEndpoints(
  value: { endpointADeviceId: string; endpointBDeviceId: string },
  ctx: z.RefinementCtx,
) {
  if (value.endpointADeviceId === value.endpointBDeviceId)
    ctx.addIssue({
      code: 'custom',
      path: ['endpointBDeviceId'],
      message: 'A logical connection must join two different devices',
    });
}
export const createLogicalConnectionSchema = z
  .object({
    ...fields,
    name: fields.name.default(''),
    protocol: fields.protocol.default(''),
    notes: fields.notes.default(''),
  })
  .strict()
  .superRefine(distinctEndpoints);
export const updateLogicalConnectionSchema = z
  .object(fields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const logicalConnectionRecordSchema = z
  .object({ ...fields, id, siteId: id, rowVersion: version })
  .strict()
  .superRefine(distinctEndpoints);
export type LogicalConnection = z.infer<typeof logicalConnectionRecordSchema>;
