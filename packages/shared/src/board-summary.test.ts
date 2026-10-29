import { describe, expect, it } from 'vitest';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  remapBoardDocument,
  type BoardElement,
} from './board.js';
import {
  duplicateElement,
  removeObject,
} from '../../../apps/web/src/board/commands.js';
const device: BoardElement = {
  id: 'device',
  type: 'device',
  name: 'Router',
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  z: 0,
  color: '',
  properties: {},
};
const summary = {
  ...device,
  id: 'summary',
  type: 'summary',
  properties: { linkedDeviceId: 'device' },
};
const fixture = () => ({
  ...emptyBoardDocument(),
  elements: [device, summary],
});
describe('linked Summary document integrity', () => {
  it('accepts linked summaries without copying device records or changing old documents', () => {
    const parsed = boardDocumentSchema.parse(fixture());
    expect(parsed.elements[1]!.properties).toEqual({
      linkedDeviceId: 'device',
    });
    expect(boardDocumentSchema.parse(emptyBoardDocument())).toEqual(
      emptyBoardDocument(),
    );
  });
  it('allows empty and unavailable links but rejects invalid references to present non-devices', () => {
    for (const linkedDeviceId of ['', 'deleted-device'])
      expect(
        boardDocumentSchema.safeParse({
          ...fixture(),
          elements: [device, { ...summary, properties: { linkedDeviceId } }],
        }).success,
      ).toBe(true);
    for (const linkedDeviceId of [42, false, {}, 'summary'])
      expect(
        boardDocumentSchema.safeParse({
          ...fixture(),
          elements: [device, { ...summary, properties: { linkedDeviceId } }],
        }).success,
      ).toBe(false);
  });
  it('remaps internal links on import and clears unresolved links without name-based matching', () => {
    const copy = remapBoardDocument(boardDocumentSchema.parse(fixture()));
    expect(copy.elements[1]!.properties.linkedDeviceId).toBe(
      copy.elements[0]!.id,
    );
    expect(copy.elements[0]!.id).not.toBe(device.id);
    const missing = boardDocumentSchema.parse({
      ...fixture(),
      elements: [{ ...summary, properties: { linkedDeviceId: 'unavailable' } }],
    });
    expect(
      remapBoardDocument(missing).elements[0]!.properties.linkedDeviceId,
    ).toBe('');
  });
  it('duplicates a Summary with its original link and preserves unavailable state after source deletion', () => {
    const doc = boardDocumentSchema.parse(fixture());
    const copy = duplicateElement(doc, 'summary');
    expect(copy.elements.at(-1)!.properties.linkedDeviceId).toBe('device');
    expect(copy.ports).toEqual([]);
    const removed = removeObject(doc, 'element', 'device');
    expect(removed.elements).toEqual([doc.elements[1]]);
    expect(boardDocumentSchema.safeParse(removed).success).toBe(true);
  });
  it('never permits ports to belong to a Summary', () => {
    const parsed = boardDocumentSchema.safeParse({
      ...fixture(),
      ports: [
        {
          id: 'p',
          deviceId: 'summary',
          face: 'front',
          row: 0,
          column: 0,
          name: 'p',
          kind: 'rj45',
          color: '',
          role: '',
          speed: '',
          linkState: '',
          nativeVlan: '',
          taggedVlans: [],
          pvid: '',
          address: '',
          externalDestination: '',
          notes: '',
          customFields: {},
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
