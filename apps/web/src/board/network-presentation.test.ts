import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  emptyBoardDocument,
  type BoardElement,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';
import {
  networkPresentation,
  networkPresentationLines,
} from './network-presentation.js';
import { NetworkSummary } from './NetworkSummary.js';
import { boardImageSvg } from './image-export.js';

const element: BoardElement = {
  id: 'network',
  type: 'network',
  name: 'Home Network',
  x: 0,
  y: 0,
  width: 640,
  height: 500,
  z: 0,
  color: '',
  properties: {},
};
const entry = {
  vlanId: '20',
  vlanName: 'Servers',
  subnet: '192.0.2.0/24',
  gateway: 'router.example',
  dhcpServer: true,
  dhcpStart: '192.0.2.100',
  dhcpEnd: '192.0.2.200',
  dns: 'dns.example',
  color: '#428deb',
  notes: 'Long readable\nnotes',
  customFields: { Count: 0, Active: false },
};
function show(fields: string[], value: Record<string, JsonValue> = entry) {
  return networkPresentation(
    { ...element, properties: { displayFields: fields } },
    value,
  );
}

describe('Network information presentation', () => {
  it('respects independent identity visibility without placeholders or hidden values', () => {
    expect(show(['vlanId'])!).toMatchObject({
      vlanId: '20',
      vlanName: '',
      chips: [],
      notes: '',
    });
    expect(show(['vlanName'])!).toMatchObject({
      vlanId: '',
      vlanName: 'Servers',
    });
    expect(show([])).toBeNull();
    expect(show(['constructor'], {})).toBeNull();
    expect(
      show(['__proto__'], JSON.parse('{"__proto__":"authored"}'))!.chips,
    ).toEqual([{ key: '__proto__', label: '__proto__', value: 'authored' }]);
    expect(show(['gateway'])!).toMatchObject({
      vlanId: '',
      vlanName: '',
      chips: [{ key: 'gateway', label: 'Gateway', value: 'router.example' }],
    });
    expect(
      show(['subnet', 'dns', 'notes'], { subnet: ' ', dns: '', notes: '' }),
    ).toBeNull();
    expect(
      networkPresentation(element, entry)!.chips.map((chip) => chip.key),
    ).toEqual(['subnet']);
  });

  it.each([
    [true, 'Enabled'],
    [false, 'Disabled'],
  ] as const)(
    'labels DHCP %s while keeping explicitly selected ranges independent',
    (enabled, label) => {
      const value = { ...entry, dhcpServer: enabled };
      expect(
        show(['dhcpServer', 'dhcpStart', 'dhcpEnd'], value)!.chips,
      ).toEqual([
        { key: 'dhcpServer', label: 'DHCP', value: label },
        {
          key: 'dhcpPool',
          label: 'DHCP Pool',
          value: '192.0.2.100 → 192.0.2.200',
        },
      ]);
    },
  );

  it('combines only selected, nonempty endpoints and labels single endpoints', () => {
    expect(show(['dhcpStart'])!.chips).toEqual([
      { key: 'dhcpStart', label: 'DHCP Pool Start', value: entry.dhcpStart },
    ]);
    expect(show(['dhcpEnd'])!.chips).toEqual([
      { key: 'dhcpEnd', label: 'DHCP Pool End', value: entry.dhcpEnd },
    ]);
    expect(
      show(['dhcpEnd', 'dhcpStart'], { ...entry, dhcpEnd: '' })!.chips,
    ).toEqual([
      { key: 'dhcpStart', label: 'DHCP Pool Start', value: entry.dhcpStart },
    ]);
    expect(show(['dhcpEnd', 'dhcpStart'])!.chips[0]!.value).toBe(
      '192.0.2.100 → 192.0.2.200',
    );
  });

  it('honors old aliases and annotations without mistaking unset or ambiguous DHCP for disabled', () => {
    expect(show(['dhcpServer'], {})).toBeNull();
    expect(
      show(['name', 'dhcpStatus', 'pvid', 'addresses'], {
        name: 'Old',
        vlanName: 'Edited',
        dhcpStatus: 'Relay?',
        pvid: 'arbitrary',
        addresses: 'host.example',
      })!,
    ).toMatchObject({
      vlanName: 'Edited',
      chips: [
        { key: 'dhcpServer', label: 'DHCP', value: 'Relay?' },
        { key: 'pvid', label: 'PVID', value: 'arbitrary' },
        { key: 'addresses', label: 'IP Addresses', value: 'host.example' },
      ],
    });
    expect(
      show(['name'], { name: 'Old', vlanName: '', networkEntryVersion: 2 }),
    ).toBeNull();
    expect(
      show(['dhcpStatus', 'dhcpServer'], {
        dhcpStatus: 'Enabled',
        dhcpServer: false,
      })!.chips,
    ).toHaveLength(1);
  });

  it('renders enabled typed custom data including false/zero and skips empty fields', () => {
    const value = {
      ...entry,
      customFields: {
        Count: 0,
        Active: false,
        Empty: '',
        Null: null,
        Array: [],
        Object: {},
        Nested: { value: 'freeform' },
      },
    };
    expect(show(['customFields'], value)!.chips).toEqual([
      { key: 'customFields.Count', label: 'Count', value: '0' },
      { key: 'customFields.Active', label: 'Active', value: 'false' },
      {
        key: 'customFields.Nested',
        label: 'Nested',
        value: '{"value":"freeform"}',
      },
    ]);
    expect(show(['customFields.Active'], value)!.chips).toHaveLength(1);
    expect(show(['vlanId'], value)!.chips).toHaveLength(0);
  });

  it('uses labeled chips, prose notes and safe text without changing canonical records', () => {
    const item = {
      ...element,
      properties: {
        displayFields: [
          'vlanId',
          'vlanName',
          'subnet',
          'notes',
          'customFields',
        ],
        entries: [entry, {}, { ...entry, vlanName: '<script>unsafe</script>' }],
      },
    };
    const before = JSON.stringify(item);
    const html = renderToStaticMarkup(
      createElement(NetworkSummary, { element: item }),
    );
    expect(html.match(/class="board-network-entry"/g)).toHaveLength(2);
    expect(html).toContain('board-network-chip-label');
    expect(html).toContain('data-field="subnet"');
    expect(html).toContain('board-network-entry-notes');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(JSON.stringify(item)).toBe(before);
    expect(show(['notes'])!.chips).toEqual([]);
  });

  it('keeps clean SVG export in sync with selected labels, statuses and custom values', () => {
    const item = {
      ...element,
      properties: {
        displayFields: [
          'vlanId',
          'dhcpServer',
          'dhcpStart',
          'dhcpEnd',
          'customFields',
        ],
        entries: [{ ...entry, dhcpServer: false }],
      },
    };
    const doc = { ...emptyBoardDocument(), elements: [item] };
    const before = JSON.stringify(doc);
    const svg = boardImageSvg(doc);
    expect(svg).toContain('DHCP: Disabled');
    expect(svg).toContain('DHCP Pool: 192.0.2.100 → 192.0.2.200');
    expect(svg).toContain('Count: 0');
    expect(svg).toContain('Active: false');
    expect(svg).not.toContain('router.example');
    expect(svg).not.toContain('Servers');
    expect(svg).toContain('clip-path=');
    expect(svg).not.toContain('foreignObject');
    expect(JSON.stringify(doc)).toBe(before);
    expect(networkPresentationLines(show(['gateway'])!)).toEqual([
      'Gateway: router.example',
    ]);
  });
});
