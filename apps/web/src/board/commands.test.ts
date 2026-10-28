import { describe, expect, it } from 'vitest';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  networkEntrySummary,
  resolveBoardPortColor,
  boardPortCapacity,
  minimumBoardDeviceSize,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { addPorts, duplicateElement, removeObject } from './commands.js';
const device: BoardElement = {
  id: 'switch',
  type: 'device',
  name: 'Switch',
  x: 100,
  y: 200,
  width: 320,
  height: 160,
  z: 0,
  color: '',
  properties: { frontColumns: 8 },
};
function example() {
  return { ...emptyBoardDocument(), elements: [structuredClone(device)] };
}
describe('board object commands', () => {
  it('builds an eleven-port mixed horizontal face ignoring inherited eight-column metadata', () => {
    let document = addPorts(example(), device.id, 'sfp_plus', 2, 'front');
    document = addPorts(document, device.id, 'sfp', 1, 'front');
    document = addPorts(document, device.id, 'rj45', 8, 'front');
    expect(
      document.ports.map((port) => [port.kind, port.row, port.column]),
    ).toEqual([
      ...['sfp_plus', 'sfp_plus', 'sfp', ...Array(8).fill('rj45')].map(
        (kind, column) => [kind, 0, column],
      ),
    ]);
    expect(boardPortCapacity(document.elements[0]!).columns).toBe(11);
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    const before = structuredClone(document);
    document = addPorts(document, device.id, 'rj45', 8, 'front');
    expect(document.ports.slice(0, 11)).toEqual(before.ports);
    expect(document.ports.slice(11).map((port) => port.column)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(document.ports.every((port) => port.row === 0)).toBe(true);
  });

  it.each([
    [24, 12],
    [48, 24],
    [11, 1],
  ])(
    'uses only explicit row layouts for %i ports at %i per row',
    (count, columns) => {
      const doc = addPorts(
        example(),
        device.id,
        'rj45',
        count,
        'front',
        columns,
      );
      expect(doc.ports.map(({ row, column }) => [row, column])).toEqual(
        Array.from({ length: count }, (_, index) => [
          Math.floor(index / columns),
          index % columns,
        ]),
      );
      expect(boardDocumentSchema.safeParse(doc).success).toBe(true);
    },
  );

  it('preserves intentional gaps, opposite-face slots and cables when inserting', () => {
    let doc = addPorts(example(), device.id, 'rj45', 2, 'front');
    doc.ports[1] = {
      ...doc.ports[1]!,
      column: 10,
      name: 'Uplink',
      pvid: 'independent',
      customFields: { value: false },
    };
    doc.elements[0]!.width = minimumBoardDeviceSize(
      doc.elements[0]!,
      doc.ports,
    ).width;
    doc = addPorts(doc, device.id, 'sfp_plus', 1, 'rear');
    doc.cables.push({
      id: 'wire',
      sourcePortId: doc.ports[0]!.id,
      targetPortId: doc.ports[1]!.id,
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    });
    const before = structuredClone(doc);
    const next = addPorts(doc, device.id, 'sfp', 2, 'front');
    expect(next.ports.slice(0, 3)).toEqual(before.ports);
    expect(next.ports.slice(3).map((port) => port.column)).toEqual([11, 12]);
    expect(next.cables).toEqual(before.cables);
    expect(doc).toEqual(before);
  });

  it('uses the full supported physical space instead of an artificial column cap and rejects oversized additions atomically', () => {
    const base = example();
    base.elements[0]!.properties.portSpacing = 0;
    const wide = addPorts(base, device.id, 'rj45', 312, 'front');
    expect(wide.elements[0]!.width).toBe(20000);
    expect(wide.ports.at(-1)!.column).toBe(311);
    expect(boardDocumentSchema.safeParse(wide).success).toBe(true);
    const before = structuredClone(wide);
    expect(() => addPorts(wide, device.id, 'rj45', 1, 'front')).toThrow(
      'supported device size',
    );
    expect(wide).toEqual(before);
    expect(() => addPorts(base, device.id, 'rj45', 24, 'front', 0)).toThrow(
      'Ports per row',
    );
    expect(() => addPorts(base, device.id, 'rj45', 24, 'front', 1.5)).toThrow(
      'Ports per row',
    );
  });

  it('adds front and rear ports without any network definitions and expands only as needed', () => {
    const base = example();
    const front = addPorts(base, device.id, 'rj45', 8, 'front');
    const both = addPorts(front, device.id, 'sfp_plus', 2, 'rear');
    expect(base.ports).toHaveLength(0);
    expect(both.ports).toHaveLength(10);
    expect(both.ports.slice(8).every((port) => port.face === 'rear')).toBe(
      true,
    );
    expect(both.elements[0]!.width).toBeGreaterThan(device.width);
    expect(boardDocumentSchema.safeParse(both).success).toBe(true);
    expect(() => addPorts(both, device.id, 'rj45', 503, 'front')).toThrow(
      '512',
    );
  });
  it('duplicates identities and internal cables without copying links to other containers', () => {
    let document = addPorts(example(), device.id, 'rj45', 3, 'front');
    document.elements.push({ ...device, id: 'router', x: 800 });
    document = addPorts(document, 'router', 'rj45', 1, 'front');
    document.ports[0] = {
      ...document.ports[0]!,
      nativeVlan: 'Unlisted 20',
      pvid: '4092',
      customFields: { power: 0, enabled: false },
    };
    const cable = {
      id: 'inside',
      sourcePortId: document.ports[0]!.id,
      targetPortId: document.ports[1]!.id,
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    };
    document.cables = [
      cable,
      {
        ...cable,
        id: 'outside',
        sourcePortId: document.ports[2]!.id,
        targetPortId: document.ports[3]!.id,
      },
    ];
    const copied = duplicateElement(document, device.id);
    const copy = copied.elements.at(-1)!;
    expect(
      copied.ports.filter((port) => port.deviceId === copy.id),
    ).toHaveLength(3);
    expect(copied.cables).toHaveLength(3);
    expect(
      copied.cables.filter(
        (item) => item.targetPortId === document.ports[3]!.id,
      ),
    ).toHaveLength(1);
    expect(
      copied.ports.find(
        (port) => port.deviceId === copy.id && port.column === 0,
      )!.customFields,
    ).toEqual({ power: 0, enabled: false });
    expect(boardDocumentSchema.safeParse(copied).success).toBe(true);
  });
  it('removes only the selected object and its attached cable graph', () => {
    const document = addPorts(example(), device.id, 'rj45', 3, 'front');
    document.cables.push({
      id: 'cable',
      sourcePortId: document.ports[0]!.id,
      targetPortId: document.ports[1]!.id,
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    });
    const removed = removeObject(document, 'port', document.ports[0]!.id);
    expect(removed.ports.map((port) => port.id)).toEqual(
      document.ports.slice(1).map((port) => port.id),
    );
    expect(removed.cables).toEqual([]);
    expect(document.cables).toHaveLength(1);
  });
  it('allows repeated authored names and unusual networking values while rejecting broken identities or slots', () => {
    const document = addPorts(example(), device.id, 'rj45', 2, 'front');
    document.ports = document.ports.map((port) => ({
      ...port,
      name: 'Uplink',
      role: 'Custom access',
      nativeVlan: '20',
      taggedVlans: ['20', 'unknown'],
      pvid: '4092',
      address: 'host.example, 2001:db8::1',
    }));
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      boardDocumentSchema.safeParse({
        ...document,
        ports: document.ports.map((port) => ({ ...port, row: 0, column: 0 })),
      }).success,
    ).toBe(false);
    expect(
      boardDocumentSchema.safeParse({
        ...document,
        ports: document.ports.map((port) => ({
          ...port,
          deviceId: 'another-board-device',
        })),
      }).success,
    ).toBe(false);
  });
  it('coordinates optional colors and selected summary fields without modifying authored entries', () => {
    const document = addPorts(example(), device.id, 'rj45', 1, 'front');
    const entry = {
      vlanId: '20',
      name: 'Servers',
      subnet: 'example documentation',
      gateway: 'host.example',
      color: '#123456',
    };
    const network: BoardElement = {
      ...device,
      id: 'network',
      type: 'network',
      properties: { entries: [entry] },
    };
    document.elements.push(network);
    document.ports[0]!.nativeVlan = '20';
    expect(resolveBoardPortColor(document, document.ports[0]!)).toBe('#123456');
    expect(
      resolveBoardPortColor(document, {
        ...document.ports[0]!,
        color: '#abcdef',
      }),
    ).toBe('#abcdef');
    expect(
      networkEntrySummary(
        {
          ...network,
          properties: {
            ...network.properties,
            displayFields: ['name', 'gateway'],
          },
        },
        entry,
      ),
    ).toBe('Servers · host.example');
    expect(entry.subnet).toBe('example documentation');
  });
});
