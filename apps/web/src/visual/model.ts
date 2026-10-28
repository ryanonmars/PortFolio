import type {
  Device,
  Port,
  Vlan,
  Rack,
  Connection,
  PortField,
  PortCustomValues,
  CustomValue,
} from '../../../../packages/shared/src/index.js';
import { api } from '../api.js';

export interface EquipmentSnapshot {
  devices: Device[];
  ports: Port[];
  vlans: Vlan[];
  racks: Rack[];
  connections: Connection[];
  fields: PortField[];
  customValues: PortCustomValues;
}
export async function loadEquipment(
  siteId: string,
): Promise<EquipmentSnapshot> {
  const [devices, vlans, racks, cables, fields] = await Promise.all([
    api<{ devices: Device[] }>(`/sites/${siteId}/devices`),
    api<{ vlans: Vlan[] }>(`/sites/${siteId}/vlans`),
    api<{ racks: Rack[] }>(`/sites/${siteId}/racks`),
    api<{ connections: Connection[] }>(`/sites/${siteId}/connections`),
    api<{ fields: PortField[] }>(`/sites/${siteId}/port-fields`),
  ]);
  const equipment = await Promise.all(
    devices.devices.map(async (device) => {
      const [ports, values] = await Promise.all([
        api<{ ports: Port[] }>(`/sites/${siteId}/devices/${device.id}/ports`),
        api<{ customValues: PortCustomValues }>(
          `/sites/${siteId}/devices/${device.id}/port-values`,
        ),
      ]);
      return { ...ports, ...values };
    }),
  );
  return {
    devices: devices.devices,
    vlans: vlans.vlans,
    racks: racks.racks,
    connections: cables.connections,
    fields: fields.fields,
    ports: equipment.flatMap((item) => item.ports),
    customValues: Object.assign(
      {},
      ...equipment.map((item) => item.customValues),
    ) as PortCustomValues,
  };
}
export const connectorNames: Record<Port['kind'], string> = {
  rj45: 'RJ45',
  sfp: 'SFP',
  sfp_plus: 'SFP+',
  qsfp: 'QSFP',
  other: 'Other',
};
export const modeNames: Record<Port['mode'], string> = {
  access: 'Access',
  trunk: 'Trunk',
  routed: 'Routed/WAN',
  disabled: 'Disabled',
  other: 'Other',
};
export const neutralPortColor = '#788790';
export function vlanColor(vlan: Vlan): string {
  if (vlan.color && /^#[0-9a-fA-F]{6}$/.test(vlan.color)) return vlan.color;
  const palette = [
    '#45b893',
    '#549cec',
    '#e3c348',
    '#c490e4',
    '#e79d72',
    '#65b9c9',
    '#d184aa',
  ];
  let hash = 0;
  for (const character of vlan.id)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}
export function portColor(port: Port, vlans: Vlan[]): string {
  if (port.mode === 'routed') return neutralPortColor;
  const vlan = vlans.find((item) => item.id === port.nativeVlanRef);
  return vlan ? vlanColor(vlan) : neutralPortColor;
}
export function vlanLabel(id: string | null, vlans: Vlan[]): string {
  if (!id) return 'None';
  const vlan = vlans.find((item) => item.id === id);
  return vlan
    ? `VLAN ${vlan.vlanId}${vlan.name ? ` · ${vlan.name}` : ''}`
    : 'Unavailable VLAN';
}
export function documentedState(port: Port): string {
  return port.documentedLinkState === 'unknown'
    ? 'Unknown'
    : `Documented ${port.documentedLinkState}`;
}
export function portSummary(port: Port, vlans: Vlan[]): string {
  return `${connectorNames[port.kind]}, ${modeNames[port.mode]}, native ${vlanLabel(port.nativeVlanRef, vlans)}, PVID ${port.pvid ?? 'not set'}, ${documentedState(port)}`;
}
export function effectiveCustomValue(
  portId: string,
  field: PortField,
  values: PortCustomValues,
): CustomValue {
  const stored = values[portId];
  return stored && Object.hasOwn(stored, field.id)
    ? stored[field.id]!
    : field.defaultValue;
}
export function displayCustomValue(value: CustomValue): string {
  return value === null
    ? 'Not set'
    : value === true
      ? 'True'
      : value === false
        ? 'False'
        : value === ''
          ? 'Empty text'
          : String(value);
}
export function orderedDevices(devices: Device[]): Device[] {
  return devices
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id));
}
export function groupedDevices(
  snapshot: EquipmentSnapshot,
): { id: string; name: string | null; devices: Device[] }[] {
  const sorted = orderedDevices(snapshot.devices);
  const racks = snapshot.racks
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id));
  const groups: { id: string; name: string | null; devices: Device[] }[] = racks
    .map((rack) => ({
      id: rack.id,
      name: rack.name,
      devices: sorted.filter((device) => device.rackId === rack.id),
    }))
    .filter((group) => group.devices.length);
  const ungrouped = sorted.filter(
    (device) =>
      !device.rackId || !racks.some((rack) => rack.id === device.rackId),
  );
  if (ungrouped.length)
    groups.push({
      id: 'unracked',
      name: groups.length ? 'Unracked equipment' : null,
      devices: ungrouped,
    });
  return groups;
}
