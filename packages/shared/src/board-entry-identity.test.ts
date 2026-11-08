import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  normalizeNetworkDocument,
  createNetworkEntry,
  type JsonValue,
} from './board.js';
function document(entries: JsonValue[]) {
  return {
    ...emptyBoardDocument(),
    elements: [
      {
        id: 'network',
        type: 'network' as const,
        name: '',
        x: 0,
        y: 0,
        width: 320,
        height: 220,
        z: 0,
        color: '',
        properties: { entries },
      },
    ],
  };
}
function entries(doc: ReturnType<typeof document>) {
  return doc.elements[0]!.properties.entries as Record<string, JsonValue>[];
}
describe('network entry identity', () => {
  it('never reuses a deleted legacy identity when authoring a new entry', () => {
    const initial = normalizeNetworkDocument(document([{}]));
    const deletedId = (
      initial.elements[0]!.properties.entries as Record<string, JsonValue>[]
    )[0]!.networkEntryId;
    const inserted = createNetworkEntry();
    const next = normalizeNetworkDocument(document([inserted]));
    const nextId = (
      next.elements[0]!.properties.entries as Record<string, JsonValue>[]
    )[0]!.networkEntryId;
    expect(nextId).toBe(inserted.networkEntryId);
    expect(nextId).not.toBe(deletedId);
    expect(createNetworkEntry().networkEntryId).not.toBe(nextId);
  });
  it('assigns deterministic identities without changing the source or authored duplicate values', () => {
    const source = document([
      { vlanId: '1', vlanName: 'Same', extra: false },
      { vlanId: '1', vlanName: 'Same' },
    ]);
    const next = normalizeNetworkDocument(source);
    expect(next).toEqual(normalizeNetworkDocument(source));
    expect(entries(next as ReturnType<typeof document>)[0]).toMatchObject({
      vlanName: 'Same',
      extra: false,
      networkEntryId: expect.any(String),
    });
    expect(source.elements[0]!.properties.entries[0]).not.toHaveProperty(
      'networkEntryId',
    );
    const ids = entries(next as ReturnType<typeof document>).map(
      (e) => e.networkEntryId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(normalizeNetworkDocument(JSON.parse(JSON.stringify(next)))).toEqual(
      next,
    );
  });
  it('keeps identities through rename, reorder, deletion and insertion', () => {
    const normalized = normalizeNetworkDocument(
      document([{ name: 'A' }, { name: 'B' }]),
    );
    const [a, b] = normalized.elements[0]!.properties.entries as Record<
      string,
      JsonValue
    >[];
    const next = normalizeNetworkDocument(
      document([{ ...b, vlanName: 'Renamed' }, {}, a!]),
    );
    const result = entries(next as ReturnType<typeof document>);
    expect(result[0]!.networkEntryId).toBe(b!.networkEntryId);
    expect(result[2]!.networkEntryId).toBe(a!.networkEntryId);
    expect(new Set(result.map((e) => e.networkEntryId)).size).toBe(3);
    expect(
      entries(
        normalizeNetworkDocument(document([b!])) as ReturnType<typeof document>,
      )[0]!.networkEntryId,
    ).toBe(b!.networkEntryId);
  });
  it('repairs invalid and duplicate reserved identities and accepts prototype-like IDs safely', () => {
    const source = document([
      { networkEntryId: '__proto__' },
      { networkEntryId: '__proto__' },
      { networkEntryId: '' },
      { networkEntryId: 1 },
      null,
      [],
    ]);
    const result = entries(
      normalizeNetworkDocument(source) as ReturnType<typeof document>,
    );
    expect(result[0]!.networkEntryId).toBe('__proto__');
    expect(new Set(result.slice(0, 4).map((e) => e.networkEntryId)).size).toBe(
      4,
    );
    expect(result[4]).toBeNull();
    expect(result[5]).toEqual([]);
  });
});
