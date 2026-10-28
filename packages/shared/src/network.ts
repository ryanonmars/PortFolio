import { z } from 'zod';

const id = z.string().uuid();
const version = z.number().int().min(1);
const name = z.string().trim().min(1).max(120);
const text = z.string().max(2000);
export function ipv4Number(address: string): number {
  return address
    .split('.')
    .reduce((value, octet) => value * 256 + Number(octet), 0);
}
export function subnetBounds(cidr: string) {
  const [address, prefix] = cidr.split('/');
  const size = 2 ** (32 - Number(prefix));
  const start = ipv4Number(address!);
  return { start, end: start + size - 1, prefix: Number(prefix) };
}
export const ipv4CidrSchema = z
  .string()
  .max(18)
  .refine((cidr) => {
    const parts = cidr.split('/');
    if (
      parts.length !== 2 ||
      !z.ipv4().safeParse(parts[0]).success ||
      !/^(0|[1-9]|[12][0-9]|3[0-2])$/.test(parts[1]!)
    )
      return false;
    const { start, prefix } = subnetBounds(cidr);
    return start % 2 ** (32 - prefix) === 0;
  }, 'Use a canonical IPv4 network CIDR with no host bits');
export function addressInSubnet(
  cidr: string,
  address: string,
  usable = false,
): boolean {
  if (
    !ipv4CidrSchema.safeParse(cidr).success ||
    !z.ipv4().safeParse(address).success
  )
    return false;
  const range = subnetBounds(cidr);
  const value = ipv4Number(address);
  const excludeEndpoints = usable && range.prefix < 31;
  return (
    value >= range.start + Number(excludeEndpoints) &&
    value <= range.end - Number(excludeEndpoints)
  );
}
const vlanFields = {
  vlanId: z.number().int().min(1).max(4094),
  name: z.string().trim().max(120),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  description: text,
};
export const createVlanSchema = z
  .object({
    ...vlanFields,
    name: vlanFields.name.default(''),
    color: vlanFields.color.default(null),
    description: text.default(''),
  })
  .strict();
export const updateVlanSchema = z
  .object(vlanFields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const vlanRecordSchema = z
  .object({ ...vlanFields, id, siteId: id, rowVersion: version })
  .strict();
export type Vlan = z.infer<typeof vlanRecordSchema>;
const rackFields = {
  name,
  description: text,
  orderIndex: z.number().int().min(0).max(65535),
};
export const createRackSchema = z
  .object({
    ...rackFields,
    description: text.default(''),
    orderIndex: rackFields.orderIndex.optional(),
  })
  .strict();
export const updateRackSchema = z
  .object(rackFields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const rackRecordSchema = z
  .object({ ...rackFields, id, siteId: id, rowVersion: version })
  .strict();
export type Rack = z.infer<typeof rackRecordSchema>;
const subnetFields = {
  cidr: ipv4CidrSchema,
  name: z.string().trim().max(120),
  vlanRef: id.nullable(),
  gatewayIp: z.ipv4().nullable(),
  dnsServers: z.array(z.ipv4()).max(8),
  notes: z.string().max(10000),
};
function validateGateway(
  value: { cidr: string; gatewayIp: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.gatewayIp && !addressInSubnet(value.cidr, value.gatewayIp, true))
    ctx.addIssue({
      code: 'custom',
      path: ['gatewayIp'],
      message: 'Gateway must be a usable address in this subnet',
    });
}
export const createSubnetSchema = z
  .object({
    ...subnetFields,
    name: subnetFields.name.default(''),
    vlanRef: subnetFields.vlanRef.default(null),
    gatewayIp: subnetFields.gatewayIp.default(null),
    dnsServers: subnetFields.dnsServers.default([]),
    notes: subnetFields.notes.default(''),
  })
  .strict()
  .superRefine(validateGateway);
export const updateSubnetSchema = z
  .object(subnetFields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const subnetRecordSchema = z
  .object({ ...subnetFields, id, siteId: id, rowVersion: version })
  .strict()
  .superRefine(validateGateway);
export type Subnet = z.infer<typeof subnetRecordSchema>;
const scopeFields = {
  name: z.string().trim().max(120),
  startIp: z.ipv4(),
  endIp: z.ipv4(),
  enabled: z.boolean(),
  notes: z.string().max(10000),
};
function validateScope(
  value: { startIp: string; endIp: string },
  ctx: z.RefinementCtx,
) {
  if (ipv4Number(value.startIp) > ipv4Number(value.endIp))
    ctx.addIssue({
      code: 'custom',
      path: ['endIp'],
      message: 'Range end must follow its start',
    });
}
export const createDhcpScopeSchema = z
  .object({
    ...scopeFields,
    name: scopeFields.name.default(''),
    enabled: z.boolean().default(true),
    notes: scopeFields.notes.default(''),
  })
  .strict()
  .superRefine(validateScope);
export const updateDhcpScopeSchema = z
  .object(scopeFields)
  .partial()
  .extend({ rowVersion: version })
  .strict();
export const dhcpScopeRecordSchema = z
  .object({ ...scopeFields, id, siteId: id, subnetId: id, rowVersion: version })
  .strict()
  .superRefine(validateScope);
export type DhcpScope = z.infer<typeof dhcpScopeRecordSchema>;
