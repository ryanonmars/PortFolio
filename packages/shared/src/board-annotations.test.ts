import { describe, expect, it } from 'vitest';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  remapBoardDocument,
  type BoardElement,
} from './board.js';

const element = (type: BoardElement['type'] = 'text'): BoardElement => ({
  id: 'annotation',
  type,
  name: '',
  x: -20,
  y: 10,
  width: 40,
  height: 24,
  z: 0,
  color: '',
  properties: {},
});
describe('board annotation storage integrity', () => {
  it.each(['text', 'arrow', 'rectangle', 'highlight'] as const)(
    'round trips %s without inventing devices or ports',
    (type) => {
      const doc = {
        ...emptyBoardDocument(),
        elements: [
          {
            ...element(type),
            properties: {
              text: '<script>alert(1)</script> & authored text',
              fillOpacity: 0,
              startX: 1,
              endX: 0,
              custom: 'retained',
            },
          },
        ],
      };
      expect(
        boardDocumentSchema.parse(JSON.parse(JSON.stringify(doc))),
      ).toEqual(doc);
      const copy = remapBoardDocument(doc);
      expect(copy.elements[0]!.id).not.toBe(doc.elements[0]!.id);
      expect(copy.elements[0]!.properties).toEqual(doc.elements[0]!.properties);
      expect(copy.ports).toEqual([]);
    },
  );
  it('retains container minimums and rejects non-device port owners', () => {
    const port = {
      id: 'port',
      deviceId: 'annotation',
      face: 'front',
      row: 0,
      column: 0,
      name: 'Port 1',
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
    };
    expect(
      boardDocumentSchema.safeParse({
        ...emptyBoardDocument(),
        elements: [element()],
        ports: [port],
      }).success,
    ).toBe(false);
    expect(
      boardDocumentSchema.safeParse({
        ...emptyBoardDocument(),
        elements: [element('device')],
      }).success,
    ).toBe(false);
    expect(
      boardDocumentSchema.safeParse({
        ...emptyBoardDocument(),
        elements: [{ ...element(), width: 15 }],
      }).success,
    ).toBe(false);
  });
  it.each([
    { fontSize: 121 },
    { fillOpacity: 2 },
    { startX: -1 },
    { strokeWidth: 17 },
    { textColor: 'url(javascript:alert(1))' },
    { text: 'x'.repeat(10001) },
  ])('rejects invalid annotation style or endpoint data: %j', (properties) => {
    expect(
      boardDocumentSchema.safeParse({
        ...emptyBoardDocument(),
        elements: [{ ...element(), properties }],
      }).success,
    ).toBe(false);
  });
  it('preserves old empty documents exactly', () => {
    expect(boardDocumentSchema.parse(emptyBoardDocument())).toEqual(
      emptyBoardDocument(),
    );
  });
});
