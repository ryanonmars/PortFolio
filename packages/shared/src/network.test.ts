import { describe, expect, it } from 'vitest';
import {
  addressInSubnet,
  ipv4CidrSchema,
  createSubnetSchema,
  createDhcpScopeSchema,
  createDeviceSchema,
  createPortSchema,
  generatePortsSchema,
} from './index.js';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
describe('network and equipment contracts', () => {
  it('accepts canonical IPv4 boundaries and rejects host bits and unsupported IPv6', () => {
    for (const cidr of [
      '0.0.0.0/0',
      '192.0.2.0/31',
      '192.0.2.1/32',
      '255.255.255.255/32',
    ])
      expect(ipv4CidrSchema.safeParse(cidr).success).toBe(true);
    for (const cidr of [
      '192.0.2.1/24',
      '192.0.2.0/33',
      '192.0.2.0/024',
      '2001:db8::/64',
      '1.2.3.999/24',
    ])
      expect(ipv4CidrSchema.safeParse(cidr).success).toBe(false);
  });
  it('uses usable IPv4 endpoints except for /31 and /32 networks', () => {
    expect(addressInSubnet('192.0.2.0/24', '192.0.2.0', true)).toBe(false);
    expect(addressInSubnet('192.0.2.0/24', '192.0.2.255', true)).toBe(false);
    expect(addressInSubnet('192.0.2.0/31', '192.0.2.0', true)).toBe(true);
    expect(addressInSubnet('192.0.2.1/32', '192.0.2.1', true)).toBe(true);
    expect(
      createSubnetSchema.safeParse({
        cidr: '192.0.2.0/24',
        gatewayIp: '198.51.100.1',
      }).success,
    ).toBe(false);
    expect(
      createDhcpScopeSchema.safeParse({
        startIp: '192.0.2.20',
        endIp: '192.0.2.10',
      }).success,
    ).toBe(false);
  });
  it('creates hardware without inventory prerequisites or inferred network configuration', () => {
    expect(
      createDeviceSchema.parse({ displayName: 'Loose switch' }),
    ).toMatchObject({ rackId: null, managementIp: '', serial: '', mac: '' });
    expect(
      createPortSchema.parse({ name: 'WAN', mode: 'routed' }),
    ).toMatchObject({
      mode: 'routed',
      nativeVlanRef: null,
      pvid: null,
      taggedVlanRefs: [],
      documentedLinkState: 'unknown',
    });
  });
  it('permits explicit tagged WAN encapsulation while rejecting overlap and duplicates', () => {
    expect(
      createPortSchema.parse({
        name: 'WAN',
        mode: 'routed',
        nativeVlanRef: a,
        taggedVlanRefs: [b],
        pvid: 4092,
      }),
    ).toMatchObject({
      mode: 'routed',
      nativeVlanRef: a,
      taggedVlanRefs: [b],
      pvid: 4092,
    });
    expect(
      createPortSchema.safeParse({
        name: 'WAN',
        mode: 'routed',
        nativeVlanRef: a,
        taggedVlanRefs: [a],
      }).success,
    ).toBe(false);
    expect(
      createPortSchema.safeParse({
        name: 'WAN',
        mode: 'routed',
        taggedVlanRefs: [a, a],
      }).success,
    ).toBe(false);
    expect(
      createPortSchema.safeParse({
        name: 'LAN',
        mode: 'access',
        taggedVlanRefs: [a],
      }).success,
    ).toBe(false);
  });
  it('bounds generation and numbering before server writes', () => {
    expect(
      generatePortsSchema.parse({ count: 48, rowVersion: 1 }),
    ).toMatchObject({ startNumber: 1, namePrefix: 'Port ', mode: 'other' });
    for (const count of [0, -1, 257, 1.5])
      expect(
        generatePortsSchema.safeParse({ count, rowVersion: 1 }).success,
      ).toBe(false);
    expect(
      generatePortsSchema.safeParse({
        count: 2,
        startNumber: 65535,
        rowVersion: 1,
      }).success,
    ).toBe(false);
  });
  it('rejects client ownership fields and invalid optional hardware addresses', () => {
    expect(
      createDeviceSchema.safeParse({ displayName: 'A', siteId: a }).success,
    ).toBe(false);
    expect(
      createDeviceSchema.safeParse({
        displayName: 'A',
        managementIp: '192.0.2.999',
      }).success,
    ).toBe(false);
    expect(
      createDeviceSchema.safeParse({
        displayName: 'A',
        managementIp: '2001:db8::1',
      }).success,
    ).toBe(true);
  });
});
