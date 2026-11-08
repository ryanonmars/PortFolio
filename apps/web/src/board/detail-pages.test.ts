import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { BoardDetailPages } from './BoardDetailPages.js';
import { BoardObjectTree } from './BoardObjectTree.js';
import { networkItems, type BoardPage } from './detail-model.js';
function fixture() {
  const document = emptyBoardDocument();
  const base = { x: 0, y: 0, width: 500, height: 250, z: 0, color: '#24332b' };
  document.elements.push({
    ...base,
    id: 'network',
    name: 'Network container',
    type: 'network',
    properties: {
      displayFields: [],
      entries: [
        {
          vlanId: '20',
          vlanName: 'Test network',
          subnet: '192.0.2.0/25',
          gateway: '192.0.2.1',
          dhcpServer: true,
          networkEntryVersion: 2,
          dhcpStart: '192.0.2.40',
          dhcpEnd: '192.0.2.59',
          dns: '192.0.2.1, 198.51.100.1',
          notes: 'Authored notes',
          customFields: { Reference: 'rack plan' },
        },
      ],
    },
  });
  document.elements.push({
    ...base,
    id: 'device',
    name: 'Test switch',
    type: 'device',
    properties: {
      manufacturer: 'Example',
      model: 'Example switch',
      managementAddress: '192.0.2.2',
      documentation: { serialNumber: 'SYNTHETIC', notes: 'Inspect rear panel' },
      face: 'front',
      portSpacing: 8,
    },
  });
  return document;
}
function render(document = fixture(), page: BoardPage = { kind: 'networks' }) {
  return renderToStaticMarkup(
    createElement(BoardDetailPages, {
      document,
      page,
      boardName: 'Test board',
      onNavigate: () => {},
    }),
  );
}
describe('read-only board detail pages', () => {
  it('leaves empty navigation without empty categories and shows useful empty tables', () => {
    const document = emptyBoardDocument();
    const tree = renderToStaticMarkup(
      createElement(BoardObjectTree, {
        document,
        page: { kind: 'canvas' },
        onNavigate: () => {},
      }),
    );
    expect(tree).not.toContain('object-tree-category');
    expect(render(document)).toContain(
      'No networks are documented on this board.',
    );
    expect(render(document, { kind: 'devices' })).toContain(
      'No devices are documented on this board.',
    );
  });
  it('lists every VLAN separately without following canvas field visibility', () => {
    const document = fixture();
    const container = document.elements[0]!;
    (container.properties.entries as unknown[]).push({
      vlanId: '30',
      vlanName: 'Second network',
      subnet: '198.51.100.0/24',
    });
    const html = render(document);
    expect(html).toContain('Open network VLAN 20 — Test network');
    expect(html).toContain('Open network VLAN 30 — Second network');
    expect(html).toContain('192.0.2.1');
    expect(html).toContain('198.51.100.1');
    expect(html).toContain('aria-label="Search networks"');
    expect(container.properties.displayFields).toEqual([]);
  });
  it('shows reusable proportional IPv4 coverage and populated documentation only', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    const html = render(document, {
      kind: 'network',
      containerId: item.container.id,
      entryId: item.entryId,
    });
    expect(html).toContain('126 usable IPv4 addresses');
    expect(html).toContain('20 addresses');
    expect(html).toContain('15.87% of usable range');
    expect(html).toContain('106 addresses');
    expect(html).toContain('Configured address coverage only');
    expect(html).toContain('Authored notes');
    expect(html).toContain('rack plan');
    expect(html).not.toContain('Network Entry Id');
    expect(html).not.toContain('Network Entry Version');
    expect(html).toContain('View on Board');
  });
  it('renders explicit missing IDs without falling back to another record', () => {
    expect(
      render(fixture(), {
        kind: 'network',
        containerId: 'network',
        entryId: 'missing',
      }),
    ).toContain('Object unavailable');
    expect(
      render(fixture(), { kind: 'device', deviceId: 'missing' }),
    ).toContain('Object unavailable');
  });
  it('shows device documentation without leaking canvas layout preferences', () => {
    const html = render(fixture(), { kind: 'device', deviceId: 'device' });
    expect(html).toContain('SYNTHETIC');
    expect(html).toContain('Inspect rear panel');
    expect(html).toContain('No ports are documented for this device.');
    expect(html).not.toContain('<dt>Face</dt>');
    expect(html).not.toContain('<dt>Port Spacing</dt>');
  });
  it('bounds large inventories and highlights the selected network in navigation', () => {
    const document = fixture();
    for (let i = 0; i < 100; i++)
      document.elements.push({
        ...document.elements[1]!,
        id: `device-${i}`,
        name: `Device ${i}`,
      } as BoardElement);
    const html = render(document, { kind: 'devices' });
    expect(html.match(/aria-label="Open device /g)).toHaveLength(64);
    expect(html).toContain('Show more devices');
    const item = networkItems(document)[0]!;
    const tree = renderToStaticMarkup(
      createElement(BoardObjectTree, {
        document,
        page: {
          kind: 'network',
          containerId: item.container.id,
          entryId: item.entryId,
        },
        onNavigate: () => {},
      }),
    );
    expect(tree).toContain('aria-label="Collapse networks"');
    expect(tree).toContain(
      'title="VLAN 20 — Test network" aria-current="page"',
    );
    expect(tree).toContain('aria-label="Filter board objects"');
  });
  it('keeps disabled, invalid, and unsupported pools unhighlighted while retaining authored values', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    const page: BoardPage = {
      kind: 'network',
      containerId: item.container.id,
      entryId: item.entryId,
    };
    for (const [change, message] of [
      [{ dhcpServer: false }, 'DHCP is disabled'],
      [
        { dhcpStart: '192.0.3.1' },
        'invalid or outside the usable subnet range',
      ],
      [{ dhcpEnd: '' }, 'Document both DHCP endpoints'],
      [{ subnet: '2001:db8::/64' }, 'A valid IPv4 subnet is needed'],
    ] as const) {
      document.elements[0]!.properties.entries = [{ ...item.entry, ...change }];
      const html = render(document, page);
      expect(html).toContain(message);
      expect(html).not.toContain('class="detail-address-pool"');
      expect(html).toContain('192.0.2.1, 198.51.100.1');
    }
  });
  it('uses both addresses for /31 and the single address for /32', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    const page: BoardPage = {
      kind: 'network',
      containerId: item.container.id,
      entryId: item.entryId,
    };
    document.elements[0]!.properties.entries = [
      {
        ...item.entry,
        subnet: '192.0.2.0/31',
        dhcpStart: '192.0.2.0',
        dhcpEnd: '192.0.2.1',
      },
    ];
    expect(render(document, page)).toContain('2 usable IPv4 addresses');
    expect(render(document, page)).toContain('100% of usable range');
    document.elements[0]!.properties.entries = [
      {
        ...item.entry,
        subnet: '192.0.2.1/32',
        dhcpStart: '192.0.2.1',
        dhcpEnd: '192.0.2.1',
      },
    ];
    expect(render(document, page)).toContain('1 usable IPv4 address');
    expect(render(document, page)).toContain('100% of usable range');
  });
  it('displays actual cable peers and authored port values without inventing associations', () => {
    const document = fixture();
    document.elements.push({
      ...document.elements[1]!,
      id: 'peer-device',
      name: 'Peer router',
    });
    const base = {
      face: 'front' as const,
      row: 0,
      column: 0,
      kind: 'rj45' as const,
      color: '',
      role: 'routed/WAN',
      speed: '1 Gbps',
      linkState: 'documented up',
      nativeVlan: '20',
      taggedVlans: ['30', '40'],
      pvid: '20',
      address: '192.0.2.2',
      externalDestination: '',
      notes: 'Manual notes',
      customFields: { Circuit: 'Synthetic' },
    };
    document.ports.push(
      { ...base, id: 'local-port', deviceId: 'device', name: 'Uplink' },
      { ...base, id: 'peer-port', deviceId: 'peer-device', name: 'LAN 1' },
    );
    document.cables.push({
      id: 'cable',
      sourcePortId: 'local-port',
      targetPortId: 'peer-port',
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    });
    const html = render(document, { kind: 'device', deviceId: 'device' });
    expect(html).toContain('Peer router');
    expect(html).toContain('LAN 1');
    expect(html).toContain('routed/WAN');
    expect(html).toContain('Native 20 · Tagged 30, 40 · PVID 20');
    expect(html).toContain('Documented link: documented up');
    expect(html).toContain('Circuit: Synthetic');
    document.cables = [];
    const unconnected = render(document, {
      kind: 'device',
      deviceId: 'device',
    });
    expect(unconnected).not.toContain('Peer router');
    expect(unconnected).not.toContain('LAN 1');
  });
  it('honors explicit empty canonical network fields without resurrecting preserved legacy aliases', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    document.elements[0]!.properties.entries = [
      {
        ...item.entry,
        subnet: '',
        cidr: '198.51.100.0/24',
        dhcpServer: null,
        dhcpStatus: 'Enabled',
      },
    ];
    const html = render(document, {
      kind: 'network',
      containerId: item.container.id,
      entryId: item.entryId,
    });
    expect(html).toContain('Subnet not documented');
    expect(html).toContain('A valid IPv4 subnet is needed');
    expect(html).toContain('<dt>DHCP</dt><dd>Not documented</dd>');
    expect(html).not.toContain('198.51.100.0/24');
    expect(html).not.toContain('class="detail-address-pool"');
  });
  it('includes a deeply selected object beyond the first navigation page without expanding the entire inventory', () => {
    const document = fixture();
    for (let i = 0; i < 100; i++)
      document.elements.push({
        ...document.elements[1]!,
        id: `device-${i}`,
        name: `Device ${i}`,
      });
    const html = renderToStaticMarkup(
      createElement(BoardObjectTree, {
        document,
        page: { kind: 'device', deviceId: 'device-95' },
        onNavigate: () => {},
      }),
    );
    expect(html).toContain('title="Device 95" aria-current="page"');
    expect(html.match(/title="(?:Test switch|Device [0-9]+)"/g)).toHaveLength(
      33,
    );
    expect(html).toContain('Show more devices');
  });
});

describe('detail page attachments', () => {
  const attachmentDocument = fixture();
  const renderAttachments = (page: BoardPage, attachmentsReady = true) =>
    renderToStaticMarkup(
      createElement(BoardDetailPages, {
        document: attachmentDocument,
        boardName: 'Test',
        boardId: 'board-id',
        attachmentsReady,
        page,
        onNavigate: () => {},
      }),
    );
  it('only renders attachments for an existing selected object', () => {
    expect(renderAttachments({ kind: 'device', deviceId: 'device' })).toContain(
      'aria-label="Attachments"',
    );
    const item = networkItems(attachmentDocument)[0]!;
    expect(
      renderAttachments({
        kind: 'network',
        containerId: item.container.id,
        entryId: item.entryId,
      }),
    ).toContain('aria-label="Attachments"');
    for (const page of [
      { kind: 'canvas' },
      { kind: 'devices' },
      { kind: 'networks' },
      { kind: 'device', deviceId: 'missing' },
    ] as BoardPage[])
      expect(renderAttachments(page)).not.toContain('aria-label="Attachments"');
  });
  it('starts with accessible loading and limits uploads to approved file types', () => {
    const html = renderAttachments({ kind: 'device', deviceId: 'device' });
    expect(html).toContain('Loading attachments');
    expect(html).toContain('multiple=""');
    expect(html).toContain('.jpg,.jpeg,.png,.webp,.pdf,.txt');
    expect(html).toContain('cannot be undone with board Undo');
  });
  it('waits for board navigation before preparing device or VLAN attachments', () => {
    const item = networkItems(attachmentDocument)[0]!;
    for (const page of [
      { kind: 'device', deviceId: 'device' },
      {
        kind: 'network',
        containerId: item.container.id,
        entryId: item.entryId,
      },
    ] as BoardPage[]) {
      expect(renderAttachments(page, false)).toContain('Waiting for board');
      expect(renderAttachments(page, true)).toContain('Loading attachments');
      expect(renderAttachments(page, true)).not.toContain('Waiting for board');
    }
  });
});
