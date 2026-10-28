import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  networkEntrySummary,
  normalizeNetworkDocument,
  normalizeNetworkEntry,
  type BoardElement,
} from './board.js';

const network: BoardElement = {
  id: 'network',
  type: 'network',
  name: 'Home Network',
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  z: 0,
  color: '',
  properties: {},
};

describe('optional Network entry compatibility', () => {
  it.each([
    ['Enabled', true],
    [' ON ', true],
    ['true', true],
    ['yes', true],
    ['1', true],
    ['Disabled', false],
    [' OFF ', false],
    ['false', false],
    ['no', false],
    ['0', false],
  ])(
    'recognizes %s without erasing its authored text',
    (dhcpStatus, enabled) => {
      const original = {
        dhcpStatus,
        dhcpStart: 'arbitrary start',
        dhcpEnd: 'arbitrary end',
      };
      const next = normalizeNetworkEntry(original);
      expect(next).toMatchObject({ ...original, dhcpServer: enabled });
      expect(original).not.toHaveProperty('dhcpServer');
      expect(normalizeNetworkEntry(next)).toEqual(next);
    },
  );

  it('retains ambiguous/unset statuses, duplicate concepts and unknown typed data', () => {
    const entry = {
      name: 'Original entry title',
      vlanName: 'Distinct VLAN',
      addresses: 'host1, IPv6',
      pvid: 'arbitrary PVID',
      dhcpStatus: 'Only sometimes / relay?',
      customFields: { capacity: 0, enabled: false },
      extra: ['anything'],
    };
    const document = {
      ...emptyBoardDocument(),
      elements: [
        {
          ...network,
          properties: {
            entries: [entry, {}],
            displayFields: ['pvid', 'addresses', 'name'],
          },
        },
      ],
    };
    const next = normalizeNetworkDocument(document);
    const entries = next.elements[0]!.properties.entries as Record<
      string,
      unknown
    >[];
    expect(entries[0]).toMatchObject(entry);
    expect(entries[0]).not.toHaveProperty('dhcpServer');
    expect(entries[1]).not.toHaveProperty('dhcpServer');
    expect(next.elements[0]!.properties.displayFields).toEqual([
      'pvid',
      'addresses',
      'name',
    ]);
    expect(normalizeNetworkDocument(next)).toEqual(next);
    expect(document.elements[0]!.properties.entries).toEqual([entry, {}]);
  });

  it('migrates an old name once and permits clearing it without resurrection', () => {
    const next = normalizeNetworkEntry({ name: 'Servers', vlanName: '' });
    expect(next.vlanName).toBe('Servers');
    const cleared = normalizeNetworkEntry({ ...next, vlanName: '' });
    expect(cleared.vlanName).toBe('');
    expect(cleared.name).toBe('Servers');
    expect(networkEntrySummary(network, cleared)).toBe('');
    const oldDisplay = { ...network, properties: { displayFields: ['name'] } };
    expect(
      networkEntrySummary(oldDisplay, { ...next, vlanName: 'Edited VLAN' }),
    ).toBe('Edited VLAN');
    expect(networkEntrySummary(oldDisplay, cleared)).toBe('');
  });

  it('explicit DHCP off wins over old status and hides retained ranges in summaries', () => {
    const entry = normalizeNetworkEntry({
      dhcpStatus: 'Enabled',
      dhcpStart: 'start',
      dhcpEnd: 'end',
    });
    const element = {
      ...network,
      properties: { displayFields: ['dhcpStatus', 'dhcpStart', 'dhcpEnd'] },
    };
    expect(networkEntrySummary(element, entry)).toBe('DHCP On · start · end');
    const off = normalizeNetworkEntry({ ...entry, dhcpServer: false });
    expect(networkEntrySummary(element, off)).toBe('DHCP Off');
    expect(off).toMatchObject({
      dhcpStart: 'start',
      dhcpEnd: 'end',
      dhcpStatus: 'Enabled',
    });
    expect(networkEntrySummary(element, { ...off, dhcpServer: true })).toBe(
      'DHCP On · start · end',
    );
  });
});
