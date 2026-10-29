import { describe, expect, it } from 'vitest';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  maxBoardPortColumn,
  maxBoardPortRow,
  type BoardDocument,
  type BoardElement,
  type BoardRecord,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import { getPortPoint } from './geometry.js';
import { BoardSession } from './session.js';
import {
  addPortBank,
  applyPortLayout,
  generatePortSlots,
  previewPortBank,
  previewPortLayout,
  type PortLayoutPreset,
} from './port-layout.js';

const presets: PortLayoutPreset[] = [
  'single-row',
  'odd-top',
  'odd-bottom',
  'sequential',
];
function device(changes: Partial<BoardElement> = {}): BoardElement {
  return {
    id: 'device',
    type: 'device',
    name: 'Custom equipment',
    x: -100,
    y: 25,
    width: 4000,
    height: 1600,
    z: 0,
    color: '',
    properties: { deviceType: 'Custom', portSpacing: 8 },
    ...changes,
  };
}
function fixture(): BoardDocument {
  return { ...emptyBoardDocument(), elements: [device()] };
}
const pairs = (ports: { row: number; column: number }[]) =>
  ports.map(({ row, column }) => [row, column]);
const positionsOnly = (ports: BoardDocument['ports']) =>
  ports.map(({ row: _row, column: _column, ...port }) => port);

describe('universal physical port slots', () => {
  it('generates each recognizable eight-port arrangement in numbering order', () => {
    expect(pairs(generatePortSlots(8, { preset: 'single-row' }))).toEqual(
      Array.from({ length: 8 }, (_, column) => [0, column]),
    );
    expect(pairs(generatePortSlots(8, { preset: 'odd-top' }))).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
      [0, 3],
      [1, 3],
    ]);
    expect(pairs(generatePortSlots(8, { preset: 'odd-bottom' }))).toEqual([
      [1, 0],
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 2],
      [0, 2],
      [1, 3],
      [0, 3],
    ]);
    expect(pairs(generatePortSlots(8, { preset: 'sequential' }))).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
  });
  it.each([8, 24, 48, 1, 7, 25, 49, 103])(
    'preserves all %i ports with unique valid slots in every pattern',
    (count) => {
      for (const preset of presets) {
        const slots = generatePortSlots(count, { preset });
        expect(slots).toHaveLength(count);
        expect(
          new Set(slots.map(({ row, column }) => `${row}:${column}`)).size,
        ).toBe(count);
        expect(slots.every(({ row, column }) => row >= 0 && column >= 0)).toBe(
          true,
        );
        if (preset !== 'single-row')
          expect(Math.max(...slots.map(({ row }) => row))).toBe(
            count === 1 && preset !== 'odd-bottom' ? 0 : 1,
          );
      }
    },
  );
  it('supports arbitrary row widths, offsets and repeated two-row blocks', () => {
    expect(
      pairs(
        generatePortSlots(7, {
          preset: 'odd-bottom',
          columns: 2,
          row: 3,
          column: 5,
        }),
      ),
    ).toEqual([
      [4, 5],
      [3, 5],
      [4, 6],
      [3, 6],
      [6, 5],
      [5, 5],
      [6, 6],
    ]);
    expect(
      pairs(generatePortSlots(7, { preset: 'sequential', columns: 3 })),
    ).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0],
    ]);
    expect(
      pairs(generatePortSlots(4, { preset: 'single-row', columns: 1 })),
    ).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
  });
  it('uses the starting number for alternating parity, without changing the batch column order', () => {
    expect(pairs(generatePortSlots(5, { preset: 'odd-top' }, 4))).toEqual([
      [1, 0],
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 2],
    ]);
    expect(pairs(generatePortSlots(3, { preset: 'odd-bottom' }, 2))).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
  });
  it('allows boundary slots but rejects counts, parameters and overflow before generation', () => {
    expect(
      generatePortSlots(1, {
        preset: 'single-row',
        row: maxBoardPortRow,
        column: maxBoardPortColumn,
      }),
    ).toEqual([{ row: maxBoardPortRow, column: maxBoardPortColumn }]);
    for (const count of [0, -1, 1.5, NaN, Infinity, 513])
      expect(() =>
        generatePortSlots(count, { preset: 'single-row' }),
      ).toThrow();
    for (const columns of [0, -1, 1.5, NaN, Infinity, 513])
      expect(() =>
        generatePortSlots(8, { preset: 'sequential', columns }),
      ).toThrow();
    for (const row of [-1, 0.5, NaN, maxBoardPortRow + 1])
      expect(() =>
        generatePortSlots(1, { preset: 'single-row', row }),
      ).toThrow();
    for (const column of [-1, 0.5, NaN, maxBoardPortColumn + 1])
      expect(() =>
        generatePortSlots(1, { preset: 'single-row', column }),
      ).toThrow();
    expect(() =>
      generatePortSlots(2, {
        preset: 'single-row',
        column: maxBoardPortColumn,
      }),
    ).toThrow();
    expect(() =>
      generatePortSlots(2, { preset: 'odd-top', row: maxBoardPortRow }),
    ).toThrow();
    expect(() =>
      generatePortSlots(1, { preset: 'unknown' as PortLayoutPreset }),
    ).toThrow();
    for (const startNumber of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() =>
        generatePortSlots(2, { preset: 'odd-top' }, startNumber),
      ).toThrow();
  });
});

describe('strict-fit port banks', () => {
  it.each(['Router', 'Switch', 'Firewall', 'Access Point', 'Server', 'Custom'])(
    'makes presets available to %s devices without a manufacturer database',
    (deviceType) => {
      const document = fixture();
      document.elements[0]!.properties.deviceType = deviceType;
      const result = addPortBank(document, 'device', 'rj45', 24, 'front', {
        preset: 'odd-bottom',
      });
      expect(result.ports).toHaveLength(24);
      expect(result.elements).toBe(document.elements);
      expect(boardDocumentSchema.safeParse(result).success).toBe(true);
    },
  );
  it('creates independently editable mixed ER8411-style banks with gaps and authored numbering', () => {
    const before = fixture();
    const preview = previewPortBank(before, 'device', 'sfp_plus', 2, 'front', {
      preset: 'single-row',
    });
    expect(before.ports).toHaveLength(0);
    expect(preview.map(({ name }) => name)).toEqual(['Port 1', 'Port 2']);
    let result = addPortBank(before, 'device', 'sfp_plus', 2, 'front', {
      preset: 'single-row',
    });
    result = addPortBank(result, 'device', 'sfp', 1, 'front', {
      preset: 'single-row',
      column: 2,
    });
    result = addPortBank(result, 'device', 'rj45', 8, 'front', {
      preset: 'single-row',
      column: 5,
    });
    expect(result.ports.map(({ kind }) => kind)).toEqual([
      'sfp_plus',
      'sfp_plus',
      'sfp',
      ...Array(8).fill('rj45'),
    ]);
    expect(result.ports.map(({ column }) => column)).toEqual([
      0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(result.ports.map(({ name }) => name)).toEqual(
      Array.from({ length: 11 }, (_, i) => `Port ${i + 1}`),
    );
    const custom = addPortBank(
      result,
      'device',
      'qsfp',
      3,
      'rear',
      { preset: 'odd-top', column: 5 },
      4,
      'Uplink ',
    );
    expect(custom.ports.slice(11).map(({ name }) => name)).toEqual([
      'Uplink 4',
      'Uplink 5',
      'Uplink 6',
    ]);
    expect(pairs(custom.ports.slice(11))).toEqual([
      [1, 5],
      [0, 5],
      [1, 6],
    ]);
    expect(custom.elements).toBe(before.elements);
    expect(boardDocumentSchema.safeParse(custom).success).toBe(true);
  });
  it('supports zero-based custom interface names and their actual alternating parity', () => {
    const document = addPortBank(
      fixture(),
      'device',
      'rj45',
      3,
      'front',
      { preset: 'odd-top' },
      0,
      'eth',
    );
    expect(document.ports.map(({ name }) => name)).toEqual([
      'eth0',
      'eth1',
      'eth2',
    ]);
    expect(pairs(document.ports)).toEqual([
      [1, 0],
      [0, 0],
      [1, 1],
    ]);
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
  });
  it('requires available device space and collision-free slots, without mutating or resizing input', () => {
    const document = fixture();
    document.elements[0]!.width = 180;
    document.elements[0]!.height = 240;
    const before = structuredClone(document);
    expect(() =>
      addPortBank(document, 'device', 'rj45', 8, 'front', {
        preset: 'single-row',
      }),
    ).toThrow(/Resize the device or adjust/);
    expect(document).toEqual(before);
    const first = addPortBank(document, 'device', 'rj45', 1, 'front', {
      preset: 'single-row',
    });
    expect(() =>
      previewPortBank(first, 'device', 'sfp', 1, 'front', {
        preset: 'single-row',
      }),
    ).toThrow(/occupied/);
    expect(
      addPortBank(first, 'device', 'sfp', 1, 'rear', { preset: 'single-row' })
        .ports,
    ).toHaveLength(2);
    document.elements[0]!.properties.portSpacing = 40;
    expect(() =>
      addPortBank(document, 'device', 'rj45', 2, 'front', {
        preset: 'single-row',
      }),
    ).toThrow(/Resize/);
  });
  it('enforces board and device limits, valid targets and names without partial additions', () => {
    const document = fixture();
    document.ports = Array.from({ length: 512 }, (_, i) =>
      makeBoardPort('device', 'rj45', Math.floor(i / 24), i % 24, String(i)),
    );
    expect(() =>
      previewPortBank(document, 'device', 'rj45', 1, 'rear', {
        preset: 'single-row',
      }),
    ).toThrow(/512/);
    document.ports = Array.from({ length: 4096 }, (_, i) =>
      makeBoardPort('other', 'rj45', 0, 0, String(i)),
    );
    expect(() =>
      previewPortBank(document, 'device', 'rj45', 1, 'rear', {
        preset: 'single-row',
      }),
    ).toThrow(/4096/);
    expect(() =>
      previewPortBank(fixture(), 'missing', 'rj45', 1, 'front', {
        preset: 'single-row',
      }),
    ).toThrow(/device/i);
    const network = fixture();
    network.elements[0]!.type = 'network';
    expect(() =>
      previewPortLayout(network, 'device', 'front', { preset: 'single-row' }),
    ).toThrow(/device/i);
    expect(() =>
      previewPortBank(
        fixture(),
        'device',
        'rj45',
        1,
        'front',
        { preset: 'single-row' },
        1,
        'x'.repeat(240),
      ),
    ).toThrow(/240/);
    expect(() =>
      previewPortBank(fixture(), 'device', 'invalid' as 'rj45', 1, 'front', {
        preset: 'single-row',
      }),
    ).toThrow();
    expect(() =>
      previewPortBank(fixture(), 'device', 'rj45', 1, 'wrong' as 'front', {
        preset: 'single-row',
      }),
    ).toThrow();
  });
});

describe('applying layouts to existing records', () => {
  function configured() {
    let document = addPortBank(fixture(), 'device', 'rj45', 8, 'front', {
      preset: 'single-row',
    });
    document = addPortBank(document, 'device', 'sfp', 2, 'rear', {
      preset: 'single-row',
    });
    document.ports = document.ports.map((port, index) => ({
      ...port,
      name: ['WAN', 'custom duplicate', 'custom duplicate'][index % 3]!,
      kind: index % 2 ? 'sfp_plus' : 'rj45',
      color: '#00ff88',
      role: 'Freeform purpose',
      speed: 'Authored speed',
      linkState: 'legacy status',
      nativeVlan: 'unnamed',
      taggedVlans: ['Guest', '20'],
      pvid: '0',
      address: 'anything / really',
      externalDestination: 'outside',
      notes: 'Notes',
      customFields: { Boolean: false, Zero: 0, nested: { field: 'value' } },
    }));
    document.cables = [
      {
        id: 'cable',
        sourcePortId: document.ports[0]!.id,
        targetPortId: document.ports[3]!.id,
        name: 'Cable',
        cableType: 'Authored',
        sourceConnector: 'A',
        targetConnector: 'B',
        color: '#112233',
        length: 'long',
        notes: 'Retain',
      },
    ];
    return document;
  }
  it('previews and changes physical slots only on the chosen face, preserving insertion order and mixed types', () => {
    const document = configured(),
      before = structuredClone(document);
    const preview = previewPortLayout(document, 'device', 'front', {
      preset: 'odd-bottom',
      column: 3,
    });
    expect(preview.map(({ id }) => id)).toEqual(
      document.ports.slice(0, 8).map(({ id }) => id),
    );
    expect(positionsOnly(preview)).toEqual(
      positionsOnly(document.ports.slice(0, 8)),
    );
    expect(document).toEqual(before);
    const result = applyPortLayout(document, 'device', 'front', {
      preset: 'odd-bottom',
      column: 3,
    });
    expect(positionsOnly(result.ports)).toEqual(positionsOnly(document.ports));
    expect(result.ports.slice(8)).toEqual(document.ports.slice(8));
    expect(result.elements).toBe(document.elements);
    expect(result.cables).toBe(document.cables);
    expect(getPortPoint(result, result.ports[0]!.id)).not.toEqual(
      getPortPoint(document, document.ports[0]!.id),
    );
    expect(boardDocumentSchema.safeParse(result).success).toBe(true);
    const customized = {
      ...result,
      ports: result.ports.map((port, index) =>
        index === 0
          ? { ...port, row: 3, column: 9, kind: 'qsfp' as const }
          : port,
      ),
    };
    expect(boardDocumentSchema.safeParse(customized).success).toBe(true);
  });
  it('rejects empty or nonfitting layouts and never changes existing data on failure', () => {
    expect(() =>
      previewPortLayout(fixture(), 'device', 'front', { preset: 'single-row' }),
    ).toThrow(/ports/i);
    const document = configured();
    document.elements[0]!.width = 600;
    const before = structuredClone(document);
    expect(() =>
      applyPortLayout(document, 'device', 'front', {
        preset: 'single-row',
        column: 20,
      }),
    ).toThrow(/Resize/);
    expect(document).toEqual(before);
  });
  it('persists one whole layout and restores all configuration with one undo/redo', async () => {
    const document = configured();
    const item: BoardRecord = {
      id: 'board',
      name: 'Board',
      groupId: null,
      order: 0,
      rowVersion: 1,
      document,
    };
    const writes: BoardDocument[] = [];
    const session = new BoardSession(
      item.id,
      item,
      async (_id, saved, rowVersion) => {
        writes.push(saved);
        return { ...item, document: saved, rowVersion: rowVersion + 1 };
      },
      () => {},
      100000,
    );
    const next = applyPortLayout(document, 'device', 'front', {
      preset: 'odd-top',
    });
    session.update(next, 'Apply port layout');
    await session.flush();
    expect(writes).toEqual([next]);
    session.undo();
    expect(session.document).toEqual(document);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(session.document).toEqual(next);
    const reloaded = JSON.parse(JSON.stringify(writes[0])) as BoardDocument;
    expect(reloaded).toEqual(next);
    expect(boardDocumentSchema.safeParse(reloaded).success).toBe(true);
    session.dispose();
  });
});
