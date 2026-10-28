import {
  normalizeNetworkEntry,
  type BoardElement,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';

export interface NetworkChip {
  key: string;
  label: string;
  value: string;
}
export interface NetworkPresentation {
  vlanId: string;
  vlanName: string;
  color: string;
  chips: NetworkChip[];
  notes: string;
}

export function networkDisplayValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim() ? value : '';
  if (typeof value === 'object' && Object.keys(value).length === 0) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Presentation only: never rewrites authored values or visibility settings. */
export function networkPresentation(
  element: BoardElement,
  entry: Record<string, JsonValue>,
): NetworkPresentation | null {
  const fields = new Set(
    Array.isArray(element.properties.displayFields)
      ? element.properties.displayFields.filter(
          (value): value is string => typeof value === 'string',
        )
      : ['vlanId', 'vlanName', 'subnet'],
  );
  const normalized = normalizeNetworkEntry(entry);
  const value = (key: string) =>
    networkDisplayValue(Object.hasOwn(entry, key) ? entry[key] : undefined);
  const chips: NetworkChip[] = [];
  const labels: Record<string, string> = {
    subnet: 'Subnet',
    gateway: 'Gateway',
    dhcpServer: 'DHCP',
    dhcpStatus: 'DHCP',
    dhcpStart: 'DHCP Pool Start',
    dhcpEnd: 'DHCP Pool End',
    dns: 'DNS Servers',
    addresses: 'IP Addresses',
    pvid: 'PVID',
  };
  const add = (key: string, label: string, text: string) => {
    if (text && !chips.some((chip) => chip.key === key))
      chips.push({ key, label, value: text });
  };
  const range =
    fields.has('dhcpStart') &&
    fields.has('dhcpEnd') &&
    value('dhcpStart') &&
    value('dhcpEnd');
  for (const field of fields) {
    if (['vlanId', 'vlanName', 'name', 'notes'].includes(field)) continue;
    if (field === 'dhcpServer' || field === 'dhcpStatus') {
      add(
        'dhcpServer',
        'DHCP',
        typeof normalized.dhcpServer === 'boolean'
          ? normalized.dhcpServer
            ? 'Enabled'
            : 'Disabled'
          : value('dhcpStatus'),
      );
    } else if ((field === 'dhcpStart' || field === 'dhcpEnd') && range) {
      add(
        'dhcpPool',
        'DHCP Pool',
        `${value('dhcpStart')} → ${value('dhcpEnd')}`,
      );
    } else if (field === 'customFields' || field.startsWith('customFields.')) {
      const custom = entry.customFields;
      if (custom && typeof custom === 'object' && !Array.isArray(custom))
        for (const [key, item] of Object.entries(custom))
          if (field === 'customFields' || field === `customFields.${key}`)
            add(`customFields.${key}`, key, networkDisplayValue(item));
    } else {
      const label = Object.hasOwn(labels, field)
        ? labels[field]!
        : field
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, (letter) => letter.toUpperCase());
      add(
        field,
        label,
        field === 'subnet' ? value('subnet') || value('cidr') : value(field),
      );
    }
  }
  const result: NetworkPresentation = {
    vlanId: fields.has('vlanId') ? value('vlanId') : '',
    vlanName:
      fields.has('vlanName') || fields.has('name')
        ? networkDisplayValue(normalized.vlanName)
        : '',
    color: /^#[0-9a-fA-F]{6}$/.test(value('color'))
      ? value('color')
      : '#849389',
    chips,
    notes: fields.has('notes') ? value('notes') : '',
  };
  return result.vlanId || result.vlanName || result.chips.length || result.notes
    ? result
    : null;
}

export function networkPresentationLines(
  presentation: NetworkPresentation,
): string[] {
  return [
    [
      presentation.vlanId ? `VLAN ${presentation.vlanId}` : '',
      presentation.vlanName,
    ]
      .filter(Boolean)
      .join(' — '),
    ...presentation.chips.map((chip) => `${chip.label}: ${chip.value}`),
    presentation.notes,
  ].filter(Boolean);
}
