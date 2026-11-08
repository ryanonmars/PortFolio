import { z } from 'zod';
import type { BoardDocument } from './board.js';

/** Compare identity only so viewport autosaves never scan attachment metadata. */
export function attachmentOwnersChanged(
  before: BoardDocument,
  after: BoardDocument,
): boolean {
  const keys = (document: BoardDocument) => {
    const result = new Set<string>();
    for (const element of document.elements) {
      if (element.type === 'device')
        result.add(JSON.stringify(['device', element.id]));
      if (
        element.type === 'network' &&
        Array.isArray(element.properties.entries)
      ) {
        for (const entry of element.properties.entries) {
          if (
            entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            typeof entry.networkEntryId === 'string'
          ) {
            result.add(
              JSON.stringify(['network', element.id, entry.networkEntryId]),
            );
          }
        }
      }
    }
    return result;
  };
  const left = keys(before),
    right = keys(after);
  return left.size !== right.size || [...left].some((key) => !right.has(key));
}

export const attachmentRecoveryMs = 30 * 24 * 60 * 60 * 1000;
export const attachmentExtensions = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'yaml',
  'yml',
  'conf',
  'cfg',
  'ini',
  'log',
] as const;

const identity = z.string().min(1).max(100);
export const attachmentOwnerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('device'), elementId: identity }).strict(),
  z
    .object({
      type: z.literal('network'),
      elementId: identity,
      entryId: identity,
    })
    .strict(),
]);
export type AttachmentOwner = z.infer<typeof attachmentOwnerSchema>;
export interface AttachmentRecord {
  id: string;
  originalFilename: string;
  displayName: string;
  description: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  updatedAt: number;
  rowVersion: number;
  available: boolean;
}
export interface AttachmentLimits {
  maxFileBytes: number;
  maxStorageBytes: number;
  maxFilesPerOwner: number;
  allowedExtensions: readonly string[];
}
export interface AttachmentList {
  attachments: AttachmentRecord[];
  limits: AttachmentLimits;
}
export const attachmentUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(240),
    description: z.string().max(4000),
    rowVersion: z.number().int().min(1),
  })
  .strict();

/** Relative to /api/v1; every operation retains exact board/owner identity. */
export function attachmentPath(
  boardId: string,
  owner: AttachmentOwner,
  attachmentId?: string,
  variant?: 'original' | 'thumbnail' | 'preview',
): string {
  let path = `/boards/${encodeURIComponent(boardId)}/attachments`;
  if (attachmentId) path += `/${encodeURIComponent(attachmentId)}`;
  if (variant) path += `/${variant}`;
  const query = new URLSearchParams({
    ownerType: owner.type,
    elementId: owner.elementId,
  });
  if (owner.type === 'network') query.set('entryId', owner.entryId);
  return `${path}?${query}`;
}
