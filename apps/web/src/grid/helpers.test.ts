import { describe, expect, it } from 'vitest';
import type {
  Port,
  Vlan,
  PortField,
} from '../../../../packages/shared/src/index.js';
import {
  columnsFromPreferences,
  portPage,
  portTargetPage,
  parsePortPaste,
  portTSV,
  rowErrors,
  pasteHeaders,
  reorderPort,
  renumberPorts,
} from './helpers.js';
import { compactCellText, parseCellMatrix } from './compact.js';

const siteId = '10000000-0000-4000-8000-000000000001';
const vlan: Vlan = {
  id: '10000000-0000-4000-8000-000000000002',
  siteId,
  vlanId: 20,
  name: '20',
  color: null,
  description: '',
  rowVersion: 1,
};
const port: Port = {
  id: '10000000-0000-4000-8000-000000000003',
  siteId,
  deviceId: '10000000-0000-4000-8000-000000000004',
  name: 'Port 1',
  kind: 'rj45',
  speed: '1G',
  mode: 'access',
  nativeVlanRef: vlan.id,
  pvid: 20,
  taggedVlanRefs: [],
  description: 'Example',
  externalDestinationLabel: '',
  documentedLinkState: 'unknown',
  face: 'front',
  orderIndex: 0,
  rowVersion: 2,
};
const field: PortField = {
  id: '10000000-0000-4000-8000-000000000005',
  siteId,
  key: 'test',
  title: 'Test',
  valueType: 'number',
  choices: [],
  defaultValue: 0,
  visibleByDefault: true,
  columnOrder: 0,
  rowVersion: 1,
};

describe('grid data helpers', () => {
  it('uses the seven compact default columns and keeps advanced properties available', () => {
    expect(
      columnsFromPreferences(null, [field])
        .filter((column) => column.visible)
        .map((column) => column.id),
    ).toEqual([
      'name',
      'kind',
      'mode',
      'nativeVlanRef',
      'taggedVlanRefs',
      'connectedTo',
      'documentedLinkState',
    ]);
    expect(
      columnsFromPreferences(null, [field]).some(
        (column) => column.id === 'pvid',
      ),
    ).toBe(true);
  });
  it('roundtrips one-based physical order in compact cells and clipboard', () => {
    expect(compactCellText(port, 'orderIndex', [vlan])).toBe(
      String(port.orderIndex + 1),
    );
    expect(
      parseCellMatrix('8', [port], port.id, ['orderIndex'], 'orderIndex', [
        vlan,
      ])[0]!.orderIndex,
    ).toBe(7);
    expect(() =>
      parseCellMatrix('0', [port], port.id, ['orderIndex'], 'orderIndex', [
        vlan,
      ]),
    ).toThrow();
  });
  it('stages rectangular clipboard edits atomically across canonical rows', () => {
    const second = {
      ...port,
      id: '10000000-0000-4000-8000-000000000009',
      name: 'Port 2',
      orderIndex: 1,
    };
    const result = parseCellMatrix(
      'trunk\t20\nrouted\t',
      [port, second],
      port.id,
      ['mode', 'nativeVlanRef'],
      'mode',
      [vlan],
    );
    expect(
      result.map((item) => [item.mode, item.nativeVlanRef, item.rowVersion]),
    ).toEqual([
      ['trunk', vlan.id, 2],
      ['routed', null, 2],
    ]);
    expect(port.mode).toBe('access');
    expect(() =>
      parseCellMatrix(
        'trunk\t20\naccess\t999',
        [port, second],
        port.id,
        ['mode', 'nativeVlanRef'],
        'mode',
        [vlan],
      ),
    ).toThrow('VLAN 999');
  });
  it('rejects malformed, overflowing and invalid clipboard rectangles without mutating input', () => {
    expect(() =>
      parseCellMatrix(
        'trunk\t20\textra',
        [port],
        port.id,
        ['mode', 'nativeVlanRef'],
        'mode',
        [vlan],
      ),
    ).toThrow('rectangle');
    expect(() =>
      parseCellMatrix('trunk\naccess', [port], port.id, ['mode'], 'mode', [
        vlan,
      ]),
    ).toThrow('beyond');
    expect(() =>
      parseCellMatrix('4095\t1G', [port], port.id, ['pvid', 'speed'], 'pvid', [
        vlan,
      ]),
    ).toThrow('Nothing was staged');
    expect(() =>
      parseCellMatrix(
        'other device\tUnknown',
        [port],
        port.id,
        ['connectedTo', 'documentedLinkState'],
        'connectedTo',
        [vlan],
      ),
    ).toThrow('inspector');
    expect(port.pvid).toBe(20);
  });
  it('formats canonical compact values without confusing explicit false, zero or VLAN UUIDs', () => {
    expect(compactCellText(port, 'nativeVlanRef', [vlan])).toBe('20');
    expect(compactCellText({ ...port, mode: 'routed' }, 'mode', [vlan])).toBe(
      'Routed/WAN',
    );
    expect(
      compactCellText(
        port,
        `custom:${field.id}`,
        [vlan],
        [field],
        {},
        { [field.id]: 0 },
      ),
    ).toBe('0');
    expect(
      compactCellText(
        port,
        `custom:${field.id}`,
        [vlan],
        [field],
        {},
        { [field.id]: false },
      ),
    ).toBe('false');
  });
  it('round-trips explicit VLAN IDs and preserves versions without confusing names', () => {
    expect(parsePortPaste(portTSV([port], [vlan]), [port], [vlan])).toEqual([
      port,
    ]);
  });
  it('preserves trailing tab delimiters when the last description is empty', () => {
    const blank = { ...port, description: '', speed: '' };
    expect(
      parsePortPaste(portTSV([blank], [vlan]) + '\n', [blank], [vlan]),
    ).toEqual([blank]);
  });
  it('validates every paste row before returning candidates', () => {
    const another = {
      ...port,
      id: '10000000-0000-4000-8000-000000000006',
      name: 'Port 2',
      orderIndex: 1,
    };
    const text = [
      pasteHeaders.join('\t'),
      'Port 1\ttrunk\t20\t4092\t\t1G\tvalid',
      'Port 2\taccess\t999\t\t\t1G\tinvalid',
    ].join('\n');
    expect(() => parsePortPaste(text, [port, another], [vlan])).toThrow(
      'VLAN 999',
    );
    expect(port.mode).toBe('access');
  });
  it('rejects malformed headers, duplicate targets, impossible modes and overlapping VLAN membership', () => {
    expect(() =>
      parsePortPaste('name\tmode\nPort 1\taccess', [port], [vlan]),
    ).toThrow('Headers');
    const row = 'Port 1\taccess\t20\t20\t20\t1G\t';
    expect(() =>
      parsePortPaste([pasteHeaders.join('\t'), row].join('\n'), [port], [vlan]),
    ).toThrow();
    const valid = 'Port 1\taccess\t20\t20\t\t1G\tNote';
    expect(() =>
      parsePortPaste(
        [pasteHeaders.join('\t'), valid, valid].join('\n'),
        [port],
        [vlan],
      ),
    ).toThrow('repeated port');
  });
  it('rejects a partial row, oversized payloads and out-of-range PVIDs', () => {
    expect(() =>
      parsePortPaste(
        [pasteHeaders.join('\t'), 'Port 1\taccess'].join('\n'),
        [port],
        [vlan],
      ),
    ).toThrow('seven');
    expect(() => parsePortPaste('x'.repeat(1_000_001), [port], [vlan])).toThrow(
      'too large',
    );
    expect(() =>
      parsePortPaste(
        [pasteHeaders.join('\t'), 'Port 1\taccess\t20\t4095\t\t1G\tNote'].join(
          '\n',
        ),
        [port],
        [vlan],
      ),
    ).toThrow();
  });
  it('ignores corrupt and stale column layouts while keeping name visible', () => {
    expect(columnsFromPreferences('{bad', [])[0]).toEqual({
      id: 'name',
      visible: true,
    });
    const preferences = columnsFromPreferences(
      JSON.stringify([
        { id: 'mode', visible: false },
        { id: 'missing', visible: true },
        { id: 'name', visible: false },
        { id: 'mode', visible: true },
      ]),
      [field],
    );
    expect(preferences[0]).toEqual({ id: 'mode', visible: false });
    expect(preferences.find((item) => item.id === 'name')?.visible).toBe(true);
    expect(preferences.filter((item) => item.id === 'mode')).toHaveLength(1);
    expect(preferences.some((item) => item.id === 'missing')).toBe(false);
    expect(preferences.at(-1)?.id).toBe(`custom:${field.id}`);
  });
  it('validates custom values without treating zero or false as unset', () => {
    expect(rowErrors(port, { [field.id]: 0 }, [field])).toEqual({});
    expect(
      rowErrors(port, { [field.id]: false }, [
        { ...field, valueType: 'boolean', defaultValue: false },
      ]),
    ).toEqual({});
    expect(rowErrors(port, { [field.id]: '0' }, [field])).toHaveProperty(
      `custom:${field.id}`,
    );
    expect(rowErrors(port, { [field.id]: null }, [field])).toEqual({});
  });
});

describe('bounded large port grids', () => {
  it('keeps 8, 24 and 48 ports together while bounding 512 ports to 64 rendered rows', () => {
    for (const count of [8, 24, 48]) {
      const rows = Array.from({ length: count }, (_, index) => index);
      expect(portPage(rows, 0).items).toEqual(rows);
      expect(portPage(rows, 0).pageCount).toBe(1);
    }
    const rows = Array.from({ length: 512 }, (_, index) => index + 1);
    const first = portPage(rows, 0);
    const last = portPage(rows, 7);
    expect(first.items).toHaveLength(64);
    expect(first.start).toBe(1);
    expect(first.end).toBe(64);
    expect(last.items).toHaveLength(64);
    expect(last.items[63]).toBe(512);
    expect(last.pageCount).toBe(8);
    expect(rows).toHaveLength(512);
  });
  it('clamps pages after filtering and handles empty or corrupt view preferences', () => {
    expect(portPage([1, 2], 7)).toMatchObject({
      items: [1, 2],
      page: 0,
      pageCount: 1,
      start: 1,
      end: 2,
    });
    expect(portPage([], 9)).toMatchObject({
      items: [],
      page: 0,
      pageCount: 1,
      start: 0,
      end: 0,
    });
    expect(portPage([1], Number.NaN).page).toBe(0);
    expect(portPage([1], -4).page).toBe(0);
  });
  it('locates the canonical off-page port for a deep link without modifying records', () => {
    const rows = Array.from({ length: 512 }, (_, index) => ({
      ...port,
      id: `port-${index + 1}`,
      orderIndex: index,
    }));
    expect(portTargetPage(rows, 'port-1')).toBe(0);
    expect(portTargetPage(rows, 'port-65')).toBe(1);
    expect(portTargetPage(rows, 'port-512')).toBe(7);
    expect(portTargetPage(rows, 'missing')).toBeNull();
  });
});

describe('physical port reordering', () => {
  const ports = [
    { ...port, id: 'a', orderIndex: 0 },
    { ...port, id: 'b', name: 'Port 2', orderIndex: 7, pvid: 30 },
    { ...port, id: 'c', name: 'Port 3', orderIndex: 42, face: 'rear' as const },
  ];
  it('moves stable identities through sparse slots without changing configuration or input', () => {
    const before = structuredClone(ports);
    const result = reorderPort(ports, 'c', 0);
    expect(result.map((port) => [port.id, port.orderIndex])).toEqual([
      ['c', 0],
      ['a', 7],
      ['b', 42],
    ]);
    expect(ports).toEqual(before);
    for (const moved of result)
      expect({
        ...moved,
        orderIndex: before.find((port) => port.id === moved.id)!.orderIndex,
      }).toEqual(before.find((port) => port.id === moved.id));
  });
  it('uses full-device order across page boundaries and can restore the original graph', () => {
    const many = Array.from({ length: 66 }, (_, index) => ({
      ...port,
      id: String(index),
      orderIndex: index * 2,
    }));
    const moved = reorderPort(many, '64', 63);
    expect(moved[63]!.id).toBe('64');
    expect(reorderPort(moved, '64', 64)).toEqual(many);
  });
  it('rejects missing targets and out-of-range positions instead of moving another port', () => {
    expect(() => reorderPort(ports, 'missing', 0)).toThrow('unavailable');
    for (const position of [-1, 3, 1.2])
      expect(() => reorderPort(ports, 'a', position)).toThrow(
        'valid port position',
      );
    expect(reorderPort(ports, 'a', 0)).toEqual(ports);
  });
});

describe('renumbering physical ports', () => {
  it('previews name swaps without changing identity, sparse order or configuration', () => {
    const ports = [
      { ...port, id: 'second', name: 'Port 1', orderIndex: 7 },
      { ...port, id: 'first', name: 'Port 2', orderIndex: 0 },
    ];
    const before = structuredClone(ports);
    const renamed = renumberPorts(ports, 'Port ', 1);
    expect(
      renamed.map((item) => [item.id, item.name, item.orderIndex]),
    ).toEqual([
      ['first', 'Port 1', 0],
      ['second', 'Port 2', 7],
    ]);
    for (const item of renamed) {
      const original = ports.find((candidate) => candidate.id === item.id)!;
      expect(item).toEqual({ ...original, name: item.name });
    }
    expect(ports).toEqual(before);
  });
  it('numbers the whole device across pages instead of using sparse slot numbers', () => {
    const ports = Array.from({ length: 66 }, (_, index) => ({
      ...port,
      id: String(index),
      orderIndex: index * 2,
    }));
    const names = renumberPorts(ports.reverse(), 'Interface ', 100);
    expect(names[0]!.name).toBe('Interface 100');
    expect(names[64]!.name).toBe('Interface 164');
    expect(names[65]!.name).toBe('Interface 165');
    expect(new Set(names.map((item) => item.name)).size).toBe(66);
  });
  it('rejects invalid ranges and any overlong proposed name before staging', () => {
    for (const start of [0, -1, 1.5, Number.NaN, 65536])
      expect(() => renumberPorts([port], 'Port ', start)).toThrow();
    expect(() =>
      renumberPorts([port, { ...port, id: 'other' }], 'Port ', 65535),
    ).toThrow();
    expect(() => renumberPorts([port], 'x'.repeat(120), 1)).toThrow();
    expect(() =>
      renumberPorts([port, { ...port, id: 'other' }], 'x'.repeat(119), 9),
    ).toThrow();
    expect(renumberPorts([port], 'x'.repeat(119), 1)[0]!.name).toHaveLength(
      120,
    );
    expect(renumberPorts([port], '', 1)[0]!.name).toBe('1');
  });
});
