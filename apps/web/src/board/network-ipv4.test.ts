import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../../packages/shared/src/board.js';
import { ipv4Pool, ipv4Subnet, networkLayoutTotals } from './network-ipv4.js';

describe('IPv4 documentation calculations', () => {
  it.each([
    [
      '203.0.113.7/0',
      '0.0.0.0',
      '255.255.255.255',
      '0.0.0.1',
      '255.255.255.254',
      4294967294,
    ],
    [
      '192.0.2.99/24',
      '192.0.2.0',
      '192.0.2.255',
      '192.0.2.1',
      '192.0.2.254',
      254,
    ],
    [
      '192.0.2.200/25',
      '192.0.2.128',
      '192.0.2.255',
      '192.0.2.129',
      '192.0.2.254',
      126,
    ],
    ['192.0.2.7/30', '192.0.2.4', '192.0.2.7', '192.0.2.5', '192.0.2.6', 2],
    ['192.0.2.7/31', '192.0.2.6', '192.0.2.7', '192.0.2.6', '192.0.2.7', 2],
    [
      '255.255.255.255/32',
      '255.255.255.255',
      '255.255.255.255',
      '255.255.255.255',
      '255.255.255.255',
      1,
    ],
  ] as const)(
    'calculates %s without signed overflow',
    (cidr, network, broadcast, first, last, usable) => {
      expect(ipv4Subnet(cidr)).toMatchObject({
        network,
        broadcast,
        first,
        last,
        usable,
        canonicalCidr: `${network}/${cidr.split('/')[1]}`,
      });
    },
  );
  it.each([
    '',
    'example/24',
    '2001:db8::/64',
    '192.0.2/24',
    '256.0.0.1/24',
    '192.0.2.1/-1',
    '192.0.2.1/33',
    '192.0.2.1/2.4',
    '192.0.2.1/24/1',
    '192.0.2.01/24',
    '192.0.2.1/024',
  ])('rejects malformed or unsupported CIDR %s', (cidr) => {
    expect(ipv4Subnet(cidr)).toBeNull();
  });
  it('trims CIDR whitespace and reports numeric usable bounds', () => {
    expect(ipv4Subnet(' 192.0.2.5/30 ')).toMatchObject({
      firstAddress: 3221225989,
      lastAddress: 3221225990,
    });
  });
  it('calculates inclusive pool coverage against usable space', () => {
    const subnet = ipv4Subnet('192.0.2.0/24')!;
    expect(ipv4Pool(subnet, '192.0.2.1', '192.0.2.254')).toEqual({
      start: '192.0.2.1',
      end: '192.0.2.254',
      count: 254,
      offsetPercent: 0,
      widthPercent: 100,
    });
    expect(ipv4Pool(subnet, '192.0.2.128', '192.0.2.128')).toMatchObject({
      count: 1,
      offsetPercent: 50,
    });
    expect(
      ipv4Pool(ipv4Subnet('192.0.2.1/32')!, '192.0.2.1', '192.0.2.1'),
    ).toMatchObject({ count: 1, widthPercent: 100 });
    expect(
      ipv4Pool(ipv4Subnet('192.0.2.0/31')!, '192.0.2.0', '192.0.2.1'),
    ).toMatchObject({ count: 2, widthPercent: 100 });
  });
  it.each([
    ['192.0.2.0', '192.0.2.20'],
    ['192.0.2.20', '192.0.2.255'],
    ['192.0.1.250', '192.0.2.20'],
    ['192.0.2.20', '192.0.3.1'],
    ['192.0.2.20', '192.0.2.1'],
    ['', '192.0.2.1'],
    ['example', '192.0.2.1'],
  ])('rejects pool %s–%s outside usable space', (start, end) => {
    expect(ipv4Pool(ipv4Subnet('192.0.2.0/24')!, start, end)).toBeNull();
  });
  it('counts unique authored VLANs and canonical subnets without double-counting addresses', () => {
    expect(
      networkLayoutTotals([
        { vlanId: ' 20 ', subnet: '192.0.2.1/24' },
        { vlanId: 20, subnet: '192.0.2.99/24' },
        { vlanId: 'voice', subnet: '192.0.2.128/25' },
        { vlanId: '', subnet: '192.0.2.0/31' },
        { vlanId: false, subnet: '192.0.2.255/32' },
        { vlanId: {}, subnet: 'invalid' },
        { vlanId: 'voice', cidr: '2001:db8::/64' },
      ]),
    ).toEqual({ vlans: 2, subnets: 4, usable: 256 });
  });
  it('counts disjoint intervals and legacy cidr aliases', () => {
    expect(
      networkLayoutTotals([
        { vlanId: 0, cidr: '192.0.2.0/30' },
        { subnet: '198.51.100.1/32' },
      ]),
    ).toEqual({ vlans: 1, subnets: 2, usable: 3 });
    expect(
      networkLayoutTotals([
        { subnet: '0.0.0.0/0' },
        { subnet: '255.255.255.255/32' },
      ]).usable,
    ).toBe(4294967295);
  });
  it('omits explicitly cleared subnets instead of counting a legacy alias', () => {
    expect(networkLayoutTotals([{ subnet: '', cidr: '192.0.2.0/24' }])).toEqual(
      {
        vlans: 0,
        subnets: 0,
        usable: null,
      },
    );
  });
  it('leaves usable unknown without valid IPv4 and never changes entries', () => {
    const entries: Record<string, JsonValue>[] = [
      { vlanId: ' ', subnet: '2001:db8::/64' },
      { subnet: 'freeform' },
    ];
    const before = JSON.stringify(entries);
    expect(networkLayoutTotals(entries)).toEqual({
      vlans: 0,
      subnets: 0,
      usable: null,
    });
    expect(JSON.stringify(entries)).toBe(before);
  });
});
