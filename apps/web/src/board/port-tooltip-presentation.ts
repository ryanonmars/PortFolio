import {
  resolveBoardPortColor,
  type BoardDocument,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import { networkDisplayValue } from './network-presentation.js';
import { knownLinkStatus } from './port-fields.js';

const connectorLabels: Record<BoardPort['kind'], string> = {
  rj45: 'RJ45',
  sfp: 'SFP',
  sfp_plus: 'SFP+',
  qsfp: 'QSFP',
  other: 'Custom',
};

/** Derive display text from current records without retaining or rewriting it. */
export function portTooltipPresentation(
  document: BoardDocument,
  port: BoardPort,
) {
  const rawStatus = networkDisplayValue(port.linkState);
  const knownStatus = rawStatus ? knownLinkStatus(rawStatus) : null;
  const status = rawStatus
    ? {
        value: knownStatus
          ? knownStatus.charAt(0).toUpperCase() + knownStatus.slice(1)
          : rawStatus,
        tone: knownStatus ?? ('other' as const),
      }
    : null;
  const pills: { key: string; label: string; value: string }[] = [];
  const add = (key: string, label: string, value: string) => {
    if (value) pills.push({ key, label, value });
  };
  add('nativeVlan', 'Native VLAN', networkDisplayValue(port.nativeVlan));
  add(
    'taggedVlans',
    'Tagged VLANs',
    Array.isArray(port.taggedVlans)
      ? port.taggedVlans
          .map((value) => networkDisplayValue(value))
          .filter((value) => value !== '')
          .join(', ')
      : networkDisplayValue(port.taggedVlans),
  );
  add('pvid', 'PVID', networkDisplayValue(port.pvid));
  add('speed', 'Speed', networkDisplayValue(port.speed));
  add('address', 'Interface IP / Address', networkDisplayValue(port.address));
  add(
    'externalDestination',
    'External Connection',
    networkDisplayValue(port.externalDestination),
  );
  const cable = document.cables.find(
    (item) => item.sourcePortId === port.id || item.targetPortId === port.id,
  );
  if (cable) {
    const peer = document.ports.find(
      (item) =>
        item.id ===
        (cable.sourcePortId === port.id
          ? cable.targetPortId
          : cable.sourcePortId),
    );
    if (peer) {
      const device = document.elements.find(
        (item) => item.id === peer.deviceId,
      );
      add(
        'connection',
        'Connected to',
        [networkDisplayValue(device?.name), networkDisplayValue(peer.name)]
          .filter((value) => value !== '')
          .join(' / '),
      );
    }
  }
  return {
    name: networkDisplayValue(port.name),
    purpose: networkDisplayValue(port.role),
    connector: connectorLabels[port.kind] ?? networkDisplayValue(port.kind),
    status,
    pills,
    color: resolveBoardPortColor(document, port),
  };
}
