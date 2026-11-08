import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { BoardElement } from '../../../../packages/shared/src/board.js';
import { DetailedNetworkSummary } from './DetailedNetworkSummary.js';

const element: BoardElement = {
  id: 'network',
  type: 'network',
  name: 'Network Details',
  x: 0,
  y: 0,
  width: 1100,
  height: 450,
  z: 0,
  color: '',
  properties: {
    displayFields: [
      'vlanId',
      'vlanName',
      'subnet',
      'gateway',
      'dns',
      'dhcpServer',
      'dhcpStart',
      'dhcpEnd',
      'notes',
      'customFields',
    ],
    entries: [
      {
        vlanId: '20',
        vlanName: 'Servers',
        subnet: '192.0.2.0/25',
        gateway: '192.0.2.1',
        dns: '203.0.113.53, 2001:db8::53',
        dhcpServer: true,
        dhcpStart: '192.0.2.32',
        dhcpEnd: '192.0.2.95',
        color: '#3388ee',
        notes: 'Authored context',
        customFields: { Capacity: 0 },
      },
    ],
  },
};
const render = (item = element) =>
  renderToStaticMarkup(
    createElement(DetailedNetworkSummary, { element: item }),
  );
it('renders structured canvas rows with mathematically proportional DHCP coverage', () => {
  const before = JSON.stringify(element);
  const html = render();
  for (const text of [
    'Servers',
    '126 usable IPv4 addresses',
    'Gateway',
    '192.0.2.1',
    '203.0.113.53',
    '2001:db8::53',
    'Configured DHCP pool',
    'Authored context',
    'Capacity',
    '>0<',
  ])
    expect(html).toContain(text);
  expect(html).toContain('board-network-pool');
  expect(html).not.toContain('board-network-chip');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('Back to container');
  expect(JSON.stringify(element)).toBe(before);
});
it('respects visible fields in identity, diagram and summary totals', () => {
  const html = render({
    ...element,
    properties: { ...element.properties, displayFields: ['vlanName'] },
  });
  expect(html).toContain('Servers');
  for (const text of [
    '192.0.2.',
    '203.0.113.53',
    'board-network-pool',
    '126 usable',
    '20</strong>',
  ])
    expect(html).not.toContain(text);
});
it('keeps disabled pools readable without highlighting coverage', () => {
  const html = render({
    ...element,
    properties: {
      ...element.properties,
      entries: [
        {
          ...(element.properties.entries as Record<string, unknown>[])[0],
          dhcpServer: false,
        },
      ],
    },
  });
  expect(html).toContain('Disabled');
  expect(html).toContain('192.0.2.32');
  expect(html).not.toContain('class="board-network-pool"');
});
it('does not reveal hidden DHCP state through the address-space diagram', () => {
  const html = render({
    ...element,
    properties: {
      ...element.properties,
      displayFields: ['vlanName', 'subnet', 'dhcpStart', 'dhcpEnd'],
    },
  });
  expect(html).toContain('DHCP state not shown');
  expect(html).not.toContain('class="board-network-pool"');
  expect(html).not.toContain('Configured DHCP pool');
});
it('supports hidden summary and incomplete/invalid/IPv6 configurations', () => {
  const html = render({
    ...element,
    width: 180,
    properties: {
      ...element.properties,
      showNetworkSummary: false,
      entries: [
        { vlanId: '1', subnet: '2001:db8::/64' },
        { vlanId: '2', subnet: 'unconventional', dhcpServer: true },
      ],
    },
  });
  expect(html).not.toContain('board-network-visual-totals');
  expect(html).toContain('data-density="narrow"');
  expect(html).toContain('2001:db8::/64');
  expect(html).toContain('unconventional');
  expect(html).not.toContain('class="board-network-pool"');
});
