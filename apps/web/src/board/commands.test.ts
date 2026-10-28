import { describe, expect, it } from 'vitest';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  networkEntrySummary,
  resolveBoardPortColor,
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
