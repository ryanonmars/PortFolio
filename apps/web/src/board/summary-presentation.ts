import {
  resolveBoardPortColor,
  type BoardDocument,
  type BoardElement,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';
import { networkDisplayValue } from './network-presentation.js';
import { knownLinkStatus } from './port-fields.js';

export interface SummaryChip {
  key: string;
  label: string;
  value: string;
}
export interface SummaryPort {
  id: string;
  name: string;
  connector: string;
  color: string;
  chips: SummaryChip[];
}
export type SummaryPresentation =
  | { state: 'empty' | 'unavailable' }
  | {
      state: 'linked';
      deviceId: string;
      name: string;
      chips: SummaryChip[];
      ports: SummaryPort[];
    };

/** Derive all content from this document; summaries store only a relationship. */
export function summaryPresentation(
  document: BoardDocument,
  element: BoardElement,
): SummaryPresentation {
  const linkedId = element.properties.linkedDeviceId;
  if (typeof linkedId !== 'string' || !linkedId) return { state: 'empty' };
  const device = document.elements.find(
    (item) => item.id === linkedId && item.type === 'device',
  );
  if (!device) return { state: 'unavailable' };
  const chips: SummaryChip[] = [];
  const add = (
    target: SummaryChip[],
    key: string,
    label: string,
    value: JsonValue | undefined,
  ) => {
    const text = networkDisplayValue(value);
    if (text) target.push({ key, label, value: text });
  };
  const custom = (target: SummaryChip[], value: JsonValue | undefined) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, item] of Object.entries(value))
        add(target, `customFields.${key}`, key, item);
  };
  const sourcePorts = document.ports
    .filter((port) => port.deviceId === device.id)
    .sort(
      (a, b) =>
        (a.face === b.face ? 0 : a.face === 'front' ? -1 : 1) ||
        a.row - b.row ||
        a.column - b.column,
    );
  for (const [key, label] of [
    ['deviceType', 'Device Type'],
    ['manufacturer', 'Manufacturer'],
    ['model', 'Model'],
    ['managementAddress', 'Management Address'],
  ] as const)
    add(chips, key, label, device.properties[key]);
  add(chips, 'portCount', 'Port Count', sourcePorts.length);
  add(chips, 'notes', 'Notes', device.properties.notes);
  custom(chips, device.properties.customFields);

  const portsById = new Map(document.ports.map((port) => [port.id, port]));
  const devicesById = new Map(
    document.elements
      .filter((item) => item.type === 'device')
      .map((item) => [item.id, item]),
  );
  const peers = new Map<string, string>();
  for (const cable of document.cables) {
    peers.set(cable.sourcePortId, cable.targetPortId);
    peers.set(cable.targetPortId, cable.sourcePortId);
  }
  const connectors = {
    rj45: 'RJ45',
    sfp: 'SFP',
    sfp_plus: 'SFP+',
    qsfp: 'QSFP',
    other: 'Custom',
  };
  const ports = sourcePorts.map((port): SummaryPort => {
    const fields: SummaryChip[] = [];
    add(fields, 'role', 'Purpose', port.role);
    add(fields, 'speed', 'Speed', port.speed);
    if (port.linkState.trim()) {
      const status = knownLinkStatus(port.linkState);
      add(
        fields,
        'linkState',
        'Documented Link Status',
        status ? status[0]!.toUpperCase() + status.slice(1) : port.linkState,
      );
    }
    add(fields, 'nativeVlan', 'Native VLAN', port.nativeVlan);
    add(
      fields,
      'taggedVlans',
      'Tagged VLANs',
      port.taggedVlans.length ? port.taggedVlans.join(', ') : 'None',
    );
    add(fields, 'pvid', 'PVID', port.pvid);
    add(fields, 'address', 'Interface IP / Address', port.address);
    add(
      fields,
      'externalDestination',
      'External Connection',
      port.externalDestination,
    );
    add(fields, 'color', 'Port Color', port.color);
    add(
      fields,
      'placement',
      'Placement',
      `${port.face === 'front' ? 'Front' : 'Rear'} · Row ${port.row + 1} · Column ${port.column + 1}`,
    );
    const peer = portsById.get(peers.get(port.id) ?? '');
    const peerDevice = peer && devicesById.get(peer.deviceId);
    if (peer && peerDevice)
      add(
        fields,
        'connection',
        'Connection',
        `${peerDevice.name || 'Unnamed device'} / ${peer.name || 'Unnamed port'}`,
      );
    add(fields, 'notes', 'Notes', port.notes);
    custom(fields, port.customFields);
    return {
      id: port.id,
      name: port.name || 'Unnamed port',
      connector: connectors[port.kind],
      color: resolveBoardPortColor(document, port),
      chips: fields,
    };
  });
  return {
    state: 'linked',
    deviceId: device.id,
    name: device.name || 'Unnamed device',
    chips,
    ports,
  };
}
