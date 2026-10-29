import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import { PortTooltipContent } from './PortTooltipContent.js';
import { portTooltipPresentation } from './port-tooltip-presentation.js';

function fixture(): BoardDocument {
  const element: BoardElement = {
    id: 'router',
    type: 'device',
    name: 'Router',
    x: -120,
    y: 80,
    width: 600,
    height: 400,
    z: 0,
    color: '',
    properties: {},
  };
  const port: BoardPort = {
    ...makeBoardPort('router', 'sfp_plus', 0, 0, 'Port 2'),
    role: 'LAN',
    speed: '10G',
    linkState: 'up',
    nativeVlan: '101',
    taggedVlans: ['20', 'Voice'],
    pvid: '101',
    address: '192.0.2.1/24',
    externalDestination: 'ISP wall jack',
  };
  return {
    ...emptyBoardDocument(),
    elements: [element, { ...element, id: 'peer', name: 'A2', x: 700 }],
    ports: [port, makeBoardPort('peer', 'rj45', 0, 0, 'Port 1')],
    cables: [
      {
        id: 'cable',
        sourcePortId: port.id,
        targetPortId: '',
        name: 'Authored cable',
        cableType: '',
        sourceConnector: '',
        targetConnector: '',
        color: '',
        length: '',
        notes: '',
      },
    ],
  };
}

function connectedFixture() {
  const document = fixture();
  document.cables[0]!.targetPortId = document.ports[1]!.id;
  return document;
}

describe('live port tooltip presentation', () => {
  it('groups configured values into labeled pills with separate authored and modeled connections', () => {
    const document = connectedFixture();
    const before = structuredClone(document);
    const info = portTooltipPresentation(document, document.ports[0]!);
    expect(info).toMatchObject({
      name: 'Port 2',
      purpose: 'LAN',
      connector: 'SFP+',
      status: { value: 'Up', tone: 'up' },
    });
    expect(info.pills).toEqual([
      { key: 'nativeVlan', label: 'Native VLAN', value: '101' },
      { key: 'taggedVlans', label: 'Tagged VLANs', value: '20, Voice' },
      { key: 'pvid', label: 'PVID', value: '101' },
      { key: 'speed', label: 'Speed', value: '10G' },
      {
        key: 'address',
        label: 'Interface IP / Address',
        value: '192.0.2.1/24',
      },
      {
        key: 'externalDestination',
        label: 'External Connection',
        value: 'ISP wall jack',
      },
      { key: 'connection', label: 'Connected to', value: 'A2 / Port 1' },
    ]);
    expect(document).toEqual(before);
  });

  it('omits absent or whitespace-only information without inventing values', () => {
    const document = connectedFixture();
    const port: BoardPort = {
      ...document.ports[0]!,
      name: '',
      role: ' \n ',
      speed: '',
      linkState: '',
      nativeVlan: '',
      taggedVlans: [],
      pvid: '',
      address: '\t',
      externalDestination: '',
    };
    const info = portTooltipPresentation({ ...document, cables: [] }, port);
    expect(info.name).toBe('');
    expect(info.purpose).toBe('');
    expect(info.status).toBeNull();
    expect(info.pills).toEqual([]);
    const markup = renderToStaticMarkup(
      createElement(PortTooltipContent, {
        document: { ...document, cables: [] },
        port,
      }),
    );
    expect(markup).not.toContain('board-port-tooltip-name');
    expect(markup).not.toContain('Unknown');
    expect(markup).not.toContain('None');
    expect(markup).not.toContain('Not set');
  });

  it('retains VLAN and PVID zero, boolean false, and a documented Down value', () => {
    const document = fixture();
    const port = {
      ...document.ports[0]!,
      nativeVlan: '0',
      pvid: '0',
      linkState: 'Down',
    };
    const info = portTooltipPresentation(document, port);
    expect(info.pills).toContainEqual({
      key: 'nativeVlan',
      label: 'Native VLAN',
      value: '0',
    });
    expect(info.pills).toContainEqual({
      key: 'pvid',
      label: 'PVID',
      value: '0',
    });
    expect(info.status).toEqual({ value: 'Down', tone: 'down' });
    // Defensive presentation compatibility; the persisted schema remains strings.
    const raw = {
      ...port,
      pvid: 0,
      role: false,
      linkState: false,
    } as unknown as BoardPort;
    const defensive = portTooltipPresentation(document, raw);
    expect(defensive.purpose).toBe('false');
    expect(defensive.status).toEqual({ value: 'false', tone: 'other' });
    expect(defensive.pills).toContainEqual({
      key: 'pvid',
      label: 'PVID',
      value: '0',
    });
  });

  it.each([
    ['up', 'Up', 'up'],
    ['Down', 'Down', 'down'],
    ['UNKNOWN', 'Unknown', 'unknown'],
    ['Documented down', 'Down', 'down'],
    ['intermittent / provider notes', 'intermittent / provider notes', 'other'],
  ])(
    'displays authored link state %s without changing storage',
    (raw, value, tone) => {
      const document = fixture();
      const port = { ...document.ports[0]!, linkState: raw };
      expect(portTooltipPresentation(document, port).status).toEqual({
        value,
        tone,
      });
      expect(port.linkState).toBe(raw);
    },
  );

  it.each([
    ['rj45', 'RJ45'],
    ['sfp', 'SFP'],
    ['sfp_plus', 'SFP+'],
    ['qsfp', 'QSFP'],
    ['other', 'Custom'],
  ] as const)('uses the existing %s connector label', (kind, expected) => {
    const document = fixture();
    expect(
      portTooltipPresentation(document, { ...document.ports[0]!, kind })
        .connector,
    ).toBe(expected);
  });

  it('preserves multiple authored tag values and long unbroken values without shortening data', () => {
    const document = fixture();
    const long = 'example'.repeat(600);
    const port = {
      ...document.ports[0]!,
      name: long,
      address: long,
      taggedVlans: ['0', 'Guest, Voice', long],
    };
    const info = portTooltipPresentation(document, port);
    expect(info.name).toBe(long);
    expect(info.pills.find((pill) => pill.key === 'address')!.value).toBe(long);
    expect(info.pills.find((pill) => pill.key === 'taggedVlans')!.value).toBe(
      `0, Guest, Voice, ${long}`,
    );
  });

  it('resolves either side of a modeled cable from live records', () => {
    const document = connectedFixture();
    expect(
      portTooltipPresentation(document, document.ports[1]!).pills,
    ).toContainEqual({
      key: 'connection',
      label: 'Connected to',
      value: 'Router / Port 2',
    });
    document.elements[1]!.name = 'Renamed peer';
    document.ports[1]!.name = 'Custom uplink';
    document.ports[0]!.pvid = '42';
    const info = portTooltipPresentation(document, document.ports[0]!);
    expect(info.pills).toContainEqual({
      key: 'connection',
      label: 'Connected to',
      value: 'Renamed peer / Custom uplink',
    });
    expect(info.pills).toContainEqual({
      key: 'pvid',
      label: 'PVID',
      value: '42',
    });
  });

  it('does not show stale cable destinations or placeholder peer names', () => {
    const document = connectedFixture();
    document.ports[1]!.name = '';
    document.elements[1]!.name = '';
    expect(
      portTooltipPresentation(document, document.ports[0]!).pills.some(
        (pill) => pill.key === 'connection',
      ),
    ).toBe(false);
    document.ports.pop();
    expect(
      portTooltipPresentation(document, document.ports[0]!).pills.some(
        (pill) => pill.key === 'connection',
      ),
    ).toBe(false);
    document.cables = [];
    expect(
      portTooltipPresentation(document, document.ports[0]!).pills.some(
        (pill) => pill.key === 'connection',
      ),
    ).toBe(false);
  });

  it('retains configured colors and derives matching native VLAN accents from existing network records', () => {
    const document = fixture();
    const port = document.ports[0]!;
    expect(
      portTooltipPresentation(document, { ...port, color: '#125abc' }).color,
    ).toBe('#125abc');
    document.elements.push({
      ...document.elements[0]!,
      id: 'network',
      type: 'network',
      properties: { entries: [{ vlanId: '101', color: '#ff5500' }] },
    });
    expect(portTooltipPresentation(document, port).color).toBe('#ff5500');
  });

  it('renders read-only network-style labeled pills and an explicitly documented status', () => {
    const document = connectedFixture();
    document.ports[0]!.name = '<Port & custom>';
    const html = renderToStaticMarkup(
      createElement(PortTooltipContent, { document, port: document.ports[0]! }),
    );
    expect(html).toContain('&lt;Port &amp; custom&gt;');
    expect(html).toContain('board-network-chip-label');
    expect(html).toContain('board-network-chip-value');
    expect(html).toContain('data-field="connection"');
    expect(html).toContain('Documented');
    expect(html).toContain('External Connection');
    expect(html).toContain('Connected to');
    expect(html).not.toMatch(/<(?:input|button|select|textarea)\b/);
    expect(html).not.toContain('contenteditable');
  });
});
