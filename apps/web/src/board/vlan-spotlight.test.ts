import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardDocument,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import {
  discoverVlans,
  normalizeVlan,
  spotlightMembership,
} from './vlan-spotlight.js';

describe('temporary VLAN spotlight', () => {
  it.each([
    [20, '20'],
    [' 20 ', '20'],
    ['00020', '20'],
    [0, '0'],
    ['00', '0'],
    ['+0020', '20'],
    ['-002', '-2'],
    ['  Voice / server  ', 'Voice / server'],
    [20.5, '20.5'],
    [1e21, '1000000000000000000000'],
    ['020.5', '020.5'],
    [null, ''],
    [undefined, ''],
    [false, ''],
    [true, ''],
    [{}, ''],
    [[], ''],
    [NaN, ''],
    [Infinity, ''],
    ['  ', ''],
  ])('normalizes %j as an independent viewing key', (value, expected) => {
    expect(normalizeVlan(value)).toBe(expected);
  });

  it('distinguishes native, tagged and both without considering purpose or PVID', () => {
    expect(
      spotlightMembership({ nativeVlan: '20', taggedVlans: ['30'] }, 20),
    ).toBe('native');
    expect(
      spotlightMembership({ nativeVlan: '30', taggedVlans: [20, '40'] }, '020'),
    ).toBe('tagged');
    expect(
      spotlightMembership({ nativeVlan: 20, taggedVlans: ['20'] }, '20'),
    ).toBe('both');
    expect(
      spotlightMembership(
        { pvid: '20', nativeVlan: '', taggedVlans: [] },
        '20',
      ),
    ).toBeNull();
    expect(
      spotlightMembership(
        { nativeVlan: 'Routed / WAN', taggedVlans: ['voice'] },
        'voice',
      ),
    ).toBe('tagged');
  });

  it('handles zero, arbitrary authored labels, missing fields and unusual combinations', () => {
    expect(spotlightMembership({ nativeVlan: 0 }, '0')).toBe('native');
    expect(spotlightMembership({ taggedVlans: [null, {}, 0] }, 0)).toBe(
      'tagged',
    );
    expect(
      spotlightMembership(
        { nativeVlan: '0', taggedVlans: [0], pvid: '99' },
        '00',
      ),
    ).toBe('both');
    expect(spotlightMembership({}, '20')).toBeNull();
    expect(spotlightMembership({ nativeVlan: '' }, null)).toBeNull();
    expect(spotlightMembership({ taggedVlans: '20' }, 20)).toBe('tagged');
    expect(spotlightMembership({ taggedVlans: ['20,30'] }, '20')).toBeNull();
    expect(spotlightMembership({ nativeVlan: 'Voice' }, 'voice')).toBeNull();
    expect(normalizeVlan('0009007199254740993')).toBe('9007199254740993');
  });

  it('discovers memberships on ports without requiring Network containers', () => {
    const document = emptyBoardDocument();
    document.ports = [
      {
        ...makeBoardPort('router', 'rj45', 0, 0, 'WAN'),
        nativeVlan: '020',
        taggedVlans: ['Voice 10', '3', '0'],
        pvid: '999',
      },
      {
        ...makeBoardPort('custom', 'sfp', 2, 5, 'Rear', 'rear'),
        nativeVlan: '2',
        taggedVlans: ['20', 'Voice 2', '0'],
      },
    ];
    const before = structuredClone(document);
    expect(discoverVlans(document)).toEqual([
      '0',
      '2',
      '3',
      '20',
      'Voice 2',
      'Voice 10',
    ]);
    expect(document).toEqual(before);
  });

  it('adds Network entry IDs including numeric zero, ignoring empty and unrelated properties', () => {
    const document = emptyBoardDocument();
    document.elements = [
      {
        id: 'network',
        type: 'network',
        name: '',
        x: 0,
        y: 0,
        width: 320,
        height: 220,
        z: 0,
        color: '',
        properties: {
          entries: [
            { vlanId: 0 },
            { vlanId: 20 },
            { vlanId: '020' },
            { vlan_id: '30' },
            { vlanId: '' },
            { pvid: '40' },
            null,
            [],
            'ignored',
          ],
        },
      },
      {
        id: 'device',
        type: 'device',
        name: '',
        x: 0,
        y: 0,
        width: 320,
        height: 220,
        z: 0,
        color: '',
        properties: { entries: [{ vlanId: '50' }] },
      },
    ];
    expect(discoverVlans(document)).toEqual(['0', '20', '30']);
  });

  it('updates derived matches immediately after configuration changes without saving view state', () => {
    const document = emptyBoardDocument();
    document.ports = [makeBoardPort('device', 'rj45', 0, 0, 'Port')];
    const changed: BoardDocument = {
      ...document,
      ports: [{ ...document.ports[0]!, nativeVlan: '20', taggedVlans: ['30'] }],
    };
    expect(spotlightMembership(document.ports[0]!, '20')).toBeNull();
    expect(spotlightMembership(changed.ports[0]!, '20')).toBe('native');
    expect(discoverVlans(changed)).toEqual(['20', '30']);
    expect(document.ports[0]!.nativeVlan).toBe('');
    expect(Object.keys(changed)).not.toContain('spotlight');
  });

  it('derives a large mixed-face switch board in memory without mutating it', () => {
    const document = emptyBoardDocument();
    document.ports = Array.from({ length: 8 * 48 }, (_, index) => ({
      ...makeBoardPort(
        `switch-${Math.floor(index / 48)}`,
        'rj45',
        Math.floor((index % 48) / 24),
        index % 24,
        `Port ${index}`,
        index % 2 ? 'rear' : 'front',
      ),
      nativeVlan: index % 2 ? '20' : '30',
      taggedVlans: ['0', '40', index % 3 ? '50' : '20'],
    }));
    const before = JSON.stringify(document);
    const start = performance.now();
    expect(discoverVlans(document)).toEqual(['0', '20', '30', '40', '50']);
    const matches = document.ports.map((port) =>
      spotlightMembership(port, '20'),
    );
    expect(matches.filter(Boolean)).toHaveLength(256);
    expect(matches).toContain('both');
    expect(matches).toContain('native');
    expect(matches).toContain('tagged');
    expect(performance.now() - start).toBeLessThan(1000);
    expect(JSON.stringify(document)).toBe(before);
  });
});
