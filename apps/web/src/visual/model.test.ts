import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Device,
  Port,
  Vlan,
  PortField,
  Rack,
} from '../../../../packages/shared/src/index.js';
import { Connector, RJ45_SOCKET_PATH } from './Connector.js';
import {
  displayCustomValue,
  effectiveCustomValue,
  groupedDevices,
  neutralPortColor,
  orderedDevices,
  portColor,
  portSummary,
  vlanColor,
  type EquipmentSnapshot,
} from './model.js';

const siteId = '10000000-0000-4000-8000-000000000001';
const device: Device = {
  id: '10000000-0000-4000-8000-000000000002',
  siteId,
  rackId: null,
  type: 'switch',
  displayName: 'Example switch',
  hostname: '',
  manufacturer: '',
  model: '',
  serial: '',
  managementIp: '',
  mac: '',
  description: '',
  tags: [],
  orderIndex: 0,
  rowVersion: 1,
};
const vlan: Vlan = {
  id: '10000000-0000-4000-8000-000000000003',
  siteId,
  vlanId: 20,
  name: '101',
  color: '#428deb',
  description: '',
  rowVersion: 1,
};
const port: Port = {
  id: '10000000-0000-4000-8000-000000000004',
  siteId,
  deviceId: device.id,
  name: 'Port 1',
  kind: 'rj45',
  mode: 'access',
  nativeVlanRef: vlan.id,
  pvid: null,
  taggedVlanRefs: [],
  documentedLinkState: 'unknown',
  speed: '',
  externalDestinationLabel: '',
  description: '',
  face: 'front',
  orderIndex: 0,
  rowVersion: 1,
};
const field: PortField = {
  id: '10000000-0000-4000-8000-000000000005',
  siteId,
  key: 'priority',
  title: 'Priority',
  valueType: 'number',
  choices: [],
  defaultValue: 0,
  visibleByDefault: true,
  columnOrder: 0,
  rowVersion: 1,
};
const rack: Rack = {
  id: '10000000-0000-4000-8000-000000000006',
  siteId,
  name: 'Rack A',
  description: '',
  orderIndex: 0,
  rowVersion: 1,
};
const snapshot: EquipmentSnapshot = {
  devices: [device],
  ports: [port],
  vlans: [vlan],
  racks: [],
  connections: [],
  fields: [],
  customValues: {},
};

describe('equipment visual semantics', () => {
  it('uses the native stored VLAN color independently of tagged memberships or documented link state', () => {
    expect(portColor(port, [vlan])).toBe('#428deb');
    expect(
      portColor(
        {
          ...port,
          mode: 'trunk',
          taggedVlanRefs: ['another-vlan'],
          documentedLinkState: 'down',
        },
        [vlan],
      ),
    ).toBe('#428deb');
    expect(portColor({ ...port, mode: 'disabled' }, [vlan])).toBe('#428deb');
    expect(portColor({ ...port, mode: 'routed' }, [vlan])).toBe(
      neutralPortColor,
    );
    expect(
      portColor({ ...port, nativeVlanRef: null, documentedLinkState: 'up' }, [
        vlan,
      ]),
    ).toBe(neutralPortColor);
  });
  it('gives records without a chosen color stable fallback colors without hardcoding VLAN numbers', () => {
    const fallback = vlanColor({ ...vlan, color: null });
    expect(fallback).toMatch(/^#[0-9a-f]{6}$/i);
    expect(
      vlanColor({ ...vlan, color: null, vlanId: 4094, name: 'Changed' }),
    ).toBe(fallback);
    expect(vlanColor({ ...vlan, color: 'invalid' })).toBe(fallback);
  });
  it('keeps VLAN ID, numeric-looking name, explicit PVID and documented state separate', () => {
    const summary = portSummary(port, [vlan]);
    expect(summary).toContain('VLAN 20 · 101');
    expect(summary).toContain('PVID not set');
    expect(summary).toContain('Unknown');
    expect(
      portSummary(
        { ...port, mode: 'routed', pvid: 4092, documentedLinkState: 'up' },
        [vlan],
      ),
    ).toContain('PVID 4092');
    expect(
      portSummary({ ...port, documentedLinkState: 'up' }, [vlan]),
    ).toContain('Documented up');
  });
  it('preserves explicit null, false and zero custom values while using defaults only for absent entries', () => {
    expect(effectiveCustomValue(port.id, field, {})).toBe(0);
    expect(
      effectiveCustomValue(port.id, field, { [port.id]: { [field.id]: null } }),
    ).toBeNull();
    expect(
      effectiveCustomValue(
        port.id,
        { ...field, valueType: 'boolean', defaultValue: true },
        { [port.id]: { [field.id]: false } },
      ),
    ).toBe(false);
    expect(displayCustomValue(false)).toBe('False');
    expect(displayCustomValue(0)).toBe('0');
    expect(displayCustomValue(null)).toBe('Not set');
  });
  it('does not require racks and keeps every device visible with canonical group order', () => {
    expect(groupedDevices(snapshot)).toEqual([
      { id: 'unracked', name: null, devices: [device] },
    ]);
    const second = { ...device, id: 'second', rackId: rack.id, orderIndex: 3 };
    const first = { ...device, id: 'first', rackId: rack.id, orderIndex: 1 };
    const groups = groupedDevices({
      ...snapshot,
      devices: [device, second, first],
      racks: [rack],
    });
    expect(groups.map((group) => group.name)).toEqual([
      'Rack A',
      'Unracked equipment',
    ]);
    expect(groups[0]!.devices.map((item) => item.id)).toEqual([
      'first',
      'second',
    ]);
    expect(groups[1]!.devices).toEqual([device]);
    const unknownRack = { ...device, rackId: 'no-longer-present' };
    expect(
      groupedDevices({ ...snapshot, devices: [unknownRack] })[0]!.devices,
    ).toEqual([unknownRack]);
    const original = [second, first];
    expect(orderedDevices(original).map((item) => item.id)).toEqual([
      'first',
      'second',
    ]);
    expect(original[0]).toBe(second);
  });
});

describe('approved connector geometry', () => {
  it('renders the shared stepped RJ45 socket, rounded VLAN perimeter and eight gold contacts', () => {
    const markup = renderToStaticMarkup(
      createElement(Connector, { kind: 'rj45', color: '#428deb' }),
    );
    expect(markup).toContain('viewBox="0 0 120 112"');
    expect(markup).toContain(`d="${RJ45_SOCKET_PATH}"`);
    expect(markup).toContain('stroke="#428deb"');
    expect(markup.match(/data-contact="gold"/g)).toHaveLength(8);
    expect(markup).toContain('rx="11"');
  });
  it('uses distinct connector structures for SFP, SFP+, QSFP and other interfaces', () => {
    for (const kind of ['sfp', 'sfp_plus', 'qsfp', 'other'] as const) {
      const markup = renderToStaticMarkup(
        createElement(Connector, { kind, color: neutralPortColor }),
      );
      expect(markup).toContain(`data-socket="${kind}"`);
      expect(markup).not.toContain('data-socket="rj45"');
      expect(markup).not.toContain(RJ45_SOCKET_PATH);
    }
  });
});
