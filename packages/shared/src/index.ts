import { z } from 'zod';
export const application = {
  name: 'PortFolio',
  tagline: 'Visual Network Documentation',
} as const;
export const healthSchema = z.object({ status: z.literal('ok') });
export type Health = z.infer<typeof healthSchema>;

export const credentialsSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    password: z.string().min(12).max(256),
  })
  .strict();
const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().max(2000);
const rowVersion = z.number().int().min(1);
export const createWorkspaceSchema = z
  .object({ name: nameSchema, description: descriptionSchema.default('') })
  .strict();
export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    rowVersion,
  })
  .strict();
export const createSiteSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.default(''),
    notes: z.string().max(10000).default(''),
  })
  .strict();
export const updateSiteSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    notes: z.string().max(10000).optional(),
    rowVersion,
  })
  .strict();
export const versionSchema = z.object({ rowVersion }).strict();
export interface User {
  id: string;
  username: string;
}
export interface Session {
  user: User | null;
  csrfToken: string;
}
export interface Workspace {
  id: string;
  name: string;
  description: string;
  rowVersion: number;
}
export interface Site {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  notes: string;
  rowVersion: number;
}
export interface DeleteImpact {
  sites: number;
  devices: number;
  ports: number;
  vlans: number;
  racks: number;
  subnets: number;
  dhcpScopes: number;
  fields: number;
  customValues: number;
  connections: number;
  logicalConnections: number;
}
export interface DeletionPreview {
  name: string;
  rowVersion: number;
  impact: DeleteImpact;
}

export * from './network.js';
export * from './equipment.js';
export * from './grid.js';
export * from './transfer.js';
export * from './navigation.js';

export * from './templates.js';
export * from './logical.js';
