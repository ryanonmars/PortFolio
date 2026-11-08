import {
  attachmentExtensions,
  attachmentPath,
  type AttachmentLimits,
  type AttachmentOwner,
} from '../../../../packages/shared/src/attachments.js';
export const attachmentAccept = attachmentExtensions
  .map((extension) => `.${extension}`)
  .join(',');
export const attachmentFileUrl = (
  boardId: string,
  owner: AttachmentOwner,
  id: string,
  variant: 'original' | 'thumbnail' | 'preview',
) => `/api/v1${attachmentPath(boardId, owner, id, variant)}`;
export function attachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  const unit = bytes < 1024 * 1024 ? 'KB' : 'MB';
  return `${Number((bytes / (unit === 'KB' ? 1024 : 1024 * 1024)).toFixed(1))} ${unit}`;
}
export function validateAttachmentFiles(
  files: readonly { name: string; size: number }[],
  limits: AttachmentLimits,
  existing: number,
) {
  if (existing + files.length > limits.maxFilesPerOwner)
    return `Attachment limit is ${limits.maxFilesPerOwner} files per object.`;
  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !limits.allowedExtensions.includes(extension))
      return `${file.name}: choose a supported image or document.`;
    if (!file.size) return `${file.name}: empty files cannot be uploaded.`;
    if (file.size > limits.maxFileBytes)
      return `${file.name}: file is too large (maximum ${attachmentSize(limits.maxFileBytes)}).`;
  }
  return '';
}
