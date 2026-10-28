import {
  portRecordSchema,
  type Port,
  type Vlan,
  type PortField,
  type PortCustomValues,
  type CustomValue,
} from '../../../../packages/shared/src/index.js';

export function compactCellText(
  port: Port,
  column: string,
  vlans: Vlan[],
  fields: PortField[] = [],
  stored: PortCustomValues = {},
  draft: Record<string, CustomValue> = {},
): string {
  const vlanId = (id: string) =>
    String(vlans.find((vlan) => vlan.id === id)?.vlanId ?? 'Unavailable');
  if (column === 'nativeVlanRef')
    return port.nativeVlanRef ? vlanId(port.nativeVlanRef) : '';
  if (column === 'taggedVlanRefs')
    return port.taggedVlanRefs.map(vlanId).join(', ');
  if (column === 'kind')
    return {
      rj45: 'RJ45',
      sfp: 'SFP',
      sfp_plus: 'SFP+',
      qsfp: 'QSFP',
      other: 'Other',
    }[port.kind];
  if (column === 'mode')
    return port.mode === 'routed'
      ? 'Routed/WAN'
      : port.mode[0]!.toUpperCase() + port.mode.slice(1);
  if (column === 'documentedLinkState')
    return port.documentedLinkState === 'unknown'
      ? 'Unknown'
      : `Documented ${port.documentedLinkState}`;
  if (column.startsWith('custom:')) {
    const id = column.slice(7);
    const value = Object.hasOwn(draft, id)
      ? draft[id]
      : Object.hasOwn(stored[port.id] ?? {}, id)
        ? stored[port.id]![id]
        : fields.find((field) => field.id === id)?.defaultValue;
    return value === null || value === undefined ? '' : String(value);
  }
  return String(port[column as keyof Port] ?? '');
}

/** Validates the entire rectangle before any drafts are staged. */
export function parseCellMatrix(
  text: string,
  ports: Port[],
  startPortId: string,
  columns: string[],
  startColumn: string,
  vlans: Vlan[],
): Port[] {
  if (text.length > 1_000_000)
    throw new Error('Paste is too large. Use at most 512 rows.');
  const lines = text.replaceAll('\r', '').replace(/\n+$/, '').split('\n');
  const rowIndex = ports.findIndex((port) => port.id === startPortId);
  const columnIndex = columns.indexOf(startColumn);
  if (
    rowIndex < 0 ||
    columnIndex < 0 ||
    lines.length > 512 ||
    rowIndex + lines.length > ports.length
  )
    throw new Error(
      'Paste extends beyond the available port rows. Nothing was staged.',
    );
  const width = lines[0]!.split('\t').length;
  const reference = (value: string): string => {
    const vlan = /^\d+$/.test(value)
      ? vlans.find((item) => item.vlanId === Number(value))
      : undefined;
    if (!vlan)
      throw new Error(
        `VLAN ${value} does not exist in this site. Nothing was staged.`,
      );
    return vlan.id;
  };
  return lines.map((line, index) => {
    const values = line.split('\t');
    if (values.length !== width || columnIndex + values.length > columns.length)
      throw new Error(
        'Paste must be a rectangle within the visible columns. Nothing was staged.',
      );
    const candidate = { ...ports[rowIndex + index]! };
    values.forEach((raw, offset) => {
      const column = columns[columnIndex + offset]!;
      const value = raw.trim();
      let parsed: unknown = raw;
      if (column === 'connectedTo' && (!value || value === '—')) return;
      if (column === 'connectedTo' || column.startsWith('custom:'))
        throw new Error(
          'Use the inspector for connections and typed custom fields. Nothing was staged.',
        );
      if (column === 'kind')
        parsed =
          (
            {
              RJ45: 'rj45',
              SFP: 'sfp',
              'SFP+': 'sfp_plus',
              QSFP: 'qsfp',
              Other: 'other',
            } as Record<string, string>
          )[value] ?? value.toLowerCase();
      if (column === 'mode')
        parsed =
          value.toLowerCase() === 'routed/wan' ? 'routed' : value.toLowerCase();
      if (column === 'nativeVlanRef')
        parsed = value && value !== '—' ? reference(value) : null;
      if (column === 'taggedVlanRefs')
        parsed =
          !value || value === '—'
            ? []
            : value.split(',').map((item) => reference(item.trim()));
      if (column === 'documentedLinkState')
        parsed = value.toLowerCase().replace(/^documented /, '');
      if (column === 'pvid') parsed = value ? Number(value) : null;
      if (column === 'orderIndex') parsed = value ? Number(value) : Number.NaN;
      Object.assign(candidate, { [column]: parsed });
    });
    const result = portRecordSchema.safeParse(candidate);
    if (!result.success)
      throw new Error(
        `Row ${index + 1}: ${result.error.issues.map((issue) => issue.message).join(' ')} Nothing was staged.`,
      );
    return result.data;
  });
}
