import {
  portRecordSchema,
  validCustomValue,
  type Port,
  type PortField,
  type CustomValue,
  type Vlan,
} from '../../../../packages/shared/src/index.js';

export const coreColumns = [
  'name',
  'kind',
  'speed',
  'mode',
  'nativeVlanRef',
  'pvid',
  'taggedVlanRefs',
  'connectedTo',
  'documentedLinkState',
  'externalDestinationLabel',
  'description',
  'face',
  'orderIndex',
] as const;
export type ColumnPreference = { id: string; visible: boolean };
export const PORT_PAGE_SIZE = 64;
export function portPage<T>(ports: T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(ports.length / PORT_PAGE_SIZE));
  const page = Math.min(
    pageCount - 1,
    Math.max(0, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0),
  );
  const start = page * PORT_PAGE_SIZE;
  return {
    items: ports.slice(start, start + PORT_PAGE_SIZE),
    page,
    pageCount,
    start: ports.length ? start + 1 : 0,
    end: Math.min(start + PORT_PAGE_SIZE, ports.length),
  };
}
export function portTargetPage(ports: Port[], portId: string) {
  const index = ports.findIndex((port) => port.id === portId);
  return index < 0 ? null : Math.floor(index / PORT_PAGE_SIZE);
}
export function columnsFromPreferences(
  raw: string | null,
  fields: PortField[],
): ColumnPreference[] {
  const defaults = [
    ...coreColumns.map((id) => ({
      id: String(id),
      visible: !['face', 'orderIndex'].includes(id),
    })),
    ...fields
      .slice()
      .sort((a, b) => a.columnOrder - b.columnOrder)
      .map((field) => ({
        id: `custom:${field.id}`,
        visible: field.visibleByDefault,
      })),
  ];
  if (!raw || raw.length > 100_000) return defaults;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 1000) return defaults;
    const known = new Map(defaults.map((column) => [column.id, column]));
    const result: ColumnPreference[] = [];
    for (const item of parsed) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        typeof item.visible !== 'boolean' ||
        !known.has(item.id)
      )
        continue;
      result.push({ id: item.id, visible: item.id === 'name' || item.visible });
      known.delete(item.id);
    }
    return [...result, ...known.values()];
  } catch {
    return defaults;
  }
}

export function rowErrors(
  port: Port,
  custom: Record<string, CustomValue>,
  fields: PortField[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const parsed = portRecordSchema.safeParse(port);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      errors[String(issue.path[0] ?? 'name')] = issue.message;
  for (const [fieldId, value] of Object.entries(custom)) {
    const field = fields.find((item) => item.id === fieldId);
    if (!field || !validCustomValue(field, value))
      errors[`custom:${fieldId}`] =
        'Value does not match the field type or choices.';
  }
  return errors;
}

export const pasteHeaders = [
  'Port',
  'Mode',
  'NativeVLAN',
  'PVID',
  'TaggedVLANs',
  'Speed',
  'Description',
];
export function parsePortPaste(
  text: string,
  ports: Port[],
  vlans: Vlan[],
): Port[] {
  if (text.length > 1_000_000)
    throw new Error('Paste is too large. Use at most 512 rows.');
  const lines = text.replaceAll('\r', '').replace(/\n+$/, '').split('\n');
  if (lines.length < 2 || lines.length > 513)
    throw new Error('Provide a header and 1–512 data rows.');
  if (lines[0] !== pasteHeaders.join('\t'))
    throw new Error(`Headers must be exactly: ${pasteHeaders.join(', ')}.`);
  const used = new Set<string>();
  function vlanReference(value: string) {
    if (!/^\d+$/.test(value)) throw new Error(`Invalid VLAN ID: ${value}.`);
    const vlan = vlans.find((item) => item.vlanId === Number(value));
    if (!vlan) throw new Error(`VLAN ${value} does not exist in this site.`);
    return vlan.id;
  }
  return lines.slice(1).map((line, index) => {
    const values = line.split('\t');
    if (values.length !== 7)
      throw new Error(
        `Row ${index + 2} must contain seven tab-separated columns.`,
      );
    const [name, mode, native, pvid, tagged, speed, description] = values as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const port = ports.find((item) => item.name === name);
    if (!port || used.has(port.id))
      throw new Error(`Row ${index + 2}: unknown or repeated port ${name}.`);
    used.add(port.id);
    const candidate = {
      ...port,
      mode: mode as Port['mode'],
      nativeVlanRef: native ? vlanReference(native) : null,
      pvid: pvid === '' ? null : /^\d+$/.test(pvid) ? Number(pvid) : Number.NaN,
      taggedVlanRefs: tagged
        ? tagged.split(',').map((value) => vlanReference(value.trim()))
        : [],
      speed,
      description,
    };
    const parsed = portRecordSchema.safeParse(candidate);
    if (!parsed.success)
      throw new Error(
        `Row ${index + 2}: ${parsed.error.issues[0]?.message ?? 'Invalid port configuration'}`,
      );
    return parsed.data;
  });
}

export function portTSV(ports: Port[], vlans: Vlan[]): string {
  const vlanNumber = (id: string | null) =>
    id ? String(vlans.find((vlan) => vlan.id === id)?.vlanId ?? '') : '';
  const clean = (value: unknown) =>
    String(value ?? '').replace(/[\t\r\n]/g, ' ');
  return [
    pasteHeaders.join('\t'),
    ...ports.map((port) =>
      [
        port.name,
        port.mode,
        vlanNumber(port.nativeVlanRef),
        port.pvid ?? '',
        port.taggedVlanRefs.map(vlanNumber).join(','),
        port.speed,
        port.description,
      ]
        .map(clean)
        .join('\t'),
    ),
  ].join('\n');
}
