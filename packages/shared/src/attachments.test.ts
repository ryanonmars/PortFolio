import { describe, expect, it } from 'vitest';
import {
  attachmentOwnerSchema,
  attachmentPath,
  attachmentUpdateSchema,
} from './attachments.js';

describe('attachment identity and metadata contracts', () => {
  it('keeps every network ownership segment safely encoded, including duplicate names', () => {
    const path = attachmentPath(
      'board /雪',
      { type: 'network', elementId: 'parent /', entryId: 'VLAN /?20' },
      'file /',
      'preview',
    );
    const url = new URL(path, 'http://localhost');
    expect(url.pathname).toBe(
      '/boards/board%20%2F%E9%9B%AA/attachments/file%20%2F/preview',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ownerType: 'network',
      elementId: 'parent /',
      entryId: 'VLAN /?20',
    });
    expect(attachmentPath('b', { type: 'device', elementId: 'device' })).toBe(
      '/boards/b/attachments?ownerType=device&elementId=device',
    );
  });
  it('requires exact owner identity and prevents metadata from changing file identity', () => {
    expect(
      attachmentOwnerSchema.safeParse({ type: 'network', elementId: 'p' })
        .success,
    ).toBe(false);
    expect(
      attachmentOwnerSchema.safeParse({
        type: 'device',
        elementId: 'd',
        entryId: 'e',
      }).success,
    ).toBe(false);
    expect(
      attachmentUpdateSchema.safeParse({
        displayName: 'Photo',
        description: '',
        rowVersion: 1,
        id: 'forged',
      }).success,
    ).toBe(false);
    expect(
      attachmentUpdateSchema.safeParse({
        displayName: ' ',
        description: '',
        rowVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      attachmentUpdateSchema.parse({
        displayName: ' Rear panel ',
        description: '',
        rowVersion: 1,
      }).displayName,
    ).toBe('Rear panel');
  });
});

describe('attachment owner lifecycle comparison', () => {
  it('ignores display/layout edits and ordering but detects device and individual VLAN removal', async () => {
    const { attachmentOwnersChanged } = await import('./attachments.js');
    const { emptyBoardDocument } = await import('./board.js');
    const before = emptyBoardDocument();
    before.elements = [
      {
        id: 'd',
        type: 'device',
        name: 'Duplicate',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        z: 0,
        color: '',
        properties: {},
      },
      {
        id: 'n',
        type: 'network',
        name: 'Networks',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        z: 0,
        color: '',
        properties: {
          entries: [
            { networkEntryId: 'a', vlanName: 'Same' },
            { networkEntryId: 'b', vlanName: 'Same' },
          ],
        },
      },
    ];
    const after = structuredClone(before);
    after.elements.reverse();
    after.elements[0]!.x = 200;
    after.elements[0]!.name = 'Renamed';
    after.elements[0]!.properties.entries = [
      { networkEntryId: 'b', vlanName: 'New' },
      { networkEntryId: 'a', vlanName: 'Changed' },
    ];
    expect(attachmentOwnersChanged(before, after)).toBe(false);
    after.elements[0]!.properties.entries = [{ networkEntryId: 'b' }];
    expect(attachmentOwnersChanged(before, after)).toBe(true);
    after.elements = before.elements.slice(1);
    expect(attachmentOwnersChanged(before, after)).toBe(true);
  });
});
