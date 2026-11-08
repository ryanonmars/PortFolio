import { describe, expect, it } from 'vitest';
import {
  attachmentAccept,
  attachmentFileUrl,
  attachmentSize,
  validateAttachmentFiles,
} from './attachments-client.js';
const limits = {
  maxFileBytes: 10,
  maxStorageBytes: 100,
  maxFilesPerOwner: 2,
  allowedExtensions: ['png', 'txt'],
};
describe('attachment client', () => {
  it('preserves exact owner on private file URLs', () => {
    expect(
      attachmentFileUrl(
        'a/b',
        { type: 'network', elementId: 'p', entryId: 'sibling' },
        'id',
        'original',
      ),
    ).toContain('entryId=sibling');
    expect(
      attachmentFileUrl(
        'a/b',
        { type: 'device', elementId: 'p' },
        'id',
        'thumbnail',
      ),
    ).toMatch(/^\/api\/v1\/boards\/a%2Fb/);
  });
  it('validates full batch before upload', () => {
    expect(
      validateAttachmentFiles([{ name: 'x.svg', size: 1 }], limits, 0),
    ).toMatch(/supported/);
    expect(
      validateAttachmentFiles([{ name: 'x.PNG', size: 11 }], limits, 0),
    ).toMatch(/large/);
    expect(
      validateAttachmentFiles([{ name: 'x.txt', size: 1 }], limits, 2),
    ).toMatch(/limit/);
    expect(
      validateAttachmentFiles([{ name: 'x.PNG', size: 1 }], limits, 0),
    ).toBe('');
  });
  it('formats bytes and exposes only allowed extensions', () => {
    expect(attachmentSize(1024)).toBe('1 KB');
    expect(attachmentAccept).toContain('.webp');
    expect(attachmentAccept).not.toContain('.svg');
  });
});
