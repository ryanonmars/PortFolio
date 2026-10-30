export type LinkStatus = 'unknown' | 'up' | 'down';

/** Display compatibility only; preserve the original authored string in storage. */
export function knownLinkStatus(value: string): LinkStatus | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^documented\s+/, '');
  if (!normalized || normalized === 'unknown') return 'unknown';
  return normalized === 'up' || normalized === 'down' ? normalized : null;
}

export const portHelp = {
  'Port Purpose':
    'What this port is used for.\n\nExamples: WAN, LAN, Uplink, Trunk, Management, Server.',
  Speed:
    'The documented port speed or negotiated link speed.\n\nExamples: 100M, 1G, 2.5G, 10G.\n\nThis is manually documented, not automatically detected.',
  'Link Status':
    'The manually documented physical link state.\n\nUp: An active link has been confirmed.\nDown: No active link is present.\nUnknown: The current state has not been verified.\n\nPortFolio does not monitor live port status.',
  'Native VLAN':
    'The VLAN used for outgoing untagged traffic on this port.\n\nExample: VLAN 1.\n\nOn typical 802.1Q switch ports, this is the untagged VLAN. It may differ from the PVID depending on equipment and configuration.',
  'Tagged VLANs':
    'VLANs whose outgoing traffic carries an 802.1Q tag.\n\nExample: 20, 30.\n\nA trunk/uplink port may carry multiple tagged VLANs.',
  PVID: 'Port VLAN ID.\n\nThe VLAN assigned to incoming untagged traffic.\n\nExample: 1.\n\nPVID is independent of the Native VLAN field.',
  'Interface IP / Address':
    'Optional IP addressing information associated with this interface.\n\nExamples: 192.0.2.10/24, DHCP, or an IPv6 address.\n\nMany Layer 2 switch ports do not have their own IP address.',
  'External Connection':
    'Describes a connection to something not represented by another port on the current board.\n\nExamples: ISP Modem, Wall Jack A12, Building Uplink.\n\nFor equipment already represented on the board, use the visual Cable tool instead.',
} as const;
export type PortHelpLabel = keyof typeof portHelp;
export const purposeSuggestions = [
  'WAN',
  'LAN',
  'Uplink',
  'Trunk',
  'Management',
  'Server',
  'Other',
];
export const speedSuggestions = [
  '100M',
  '1G',
  '2.5G',
  '5G',
  '10G',
  '25G',
  '40G',
  '100G',
];
