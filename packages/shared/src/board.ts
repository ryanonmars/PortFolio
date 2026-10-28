import { z } from 'zod';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(50000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json).max(4096),
    z.record(z.string().max(160), json),
  ]),
);
const properties = z.record(z.string().max(160), json);
const id = z.string().min(1).max(100);
const text = z.string().max(10000);
const color = z.union([z.literal(''), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);
const position = z.number().finite().min(-100000).max(100000);
export const boardViewportSchema = z
  .object({
    x: position,
    y: position,
    zoom: z.number().finite().min(0.1).max(4),
  })
  .strict();
export type BoardViewport = z.infer<typeof boardViewportSchema>;
export const boardElementSchema = z
  .object({
    id,
    type: z.enum(['device', 'network']),
    name: z.string().max(240),
    x: position,
    y: position,
    width: z.number().finite().min(160).max(20000),
    height: z.number().finite().min(120).max(20000),
    z: z.number().int().min(0).max(100000),
    color,
    properties,
  })
  .strict();
export type BoardElement = z.infer<typeof boardElementSchema>;
export const boardPortSchema = z
  .object({
    id,
    deviceId: id,
    face: z.enum(['front', 'rear']),
    row: z.number().int().min(0).max(127),
    column: z.number().int().min(0).max(127),
    name: z.string().max(240),
    kind: z.enum(['rj45', 'sfp', 'sfp_plus', 'qsfp', 'other']),
    color,
    role: text,
    speed: text,
    linkState: text,
    nativeVlan: text,
    taggedVlans: z.array(z.string().max(240)).max(512),
    pvid: text,
    address: text,
    externalDestination: text,
    notes: text,
    customFields: properties,
  })
  .strict();
export type BoardPort = z.infer<typeof boardPortSchema>;
export const boardCableSchema = z
  .object({
    id,
    sourcePortId: id,
    targetPortId: id,
    name: text,
    cableType: text,
    sourceConnector: text,
    targetConnector: text,
    color,
    length: text,
    notes: text,
  })
  .strict();
export type BoardCable = z.infer<typeof boardCableSchema>;
export function minimumBoardDeviceSize(
  element: BoardElement,
  ports: BoardPort[],
) {
  const items = ports.filter((port) => port.deviceId === element.id);
  if (!items.length) return { width: 160, height: 120 };
  const raw = element.properties.portSpacing;
  const gap =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(0, Math.min(40, raw))
      : 8;
  const column = Math.max(...items.map((port) => port.column));
  const row = Math.max(...items.map((port) => port.row));
  return {
    width: Math.max(160, 32 + (column + 1) * 64 + column * gap),
    height: Math.max(120, 112 + (row + 1) * 92 + row * gap),
  };
}
export const boardDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    elements: z.array(boardElementSchema).max(256),
    ports: z.array(boardPortSchema).max(4096),
    cables: z.array(boardCableSchema).max(2048),
    viewport: boardViewportSchema,
    showCables: z.boolean(),
    grid: z.boolean(),
    legacy: properties.optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const all = new Set<string>();
    for (const item of [...doc.elements, ...doc.ports, ...doc.cables]) {
      if (all.has(item.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate object ID' });
      all.add(item.id);
    }
    const devices = new Set(
      doc.elements
        .filter((element) => element.type === 'device')
        .map((element) => element.id),
    );
    const slots = new Set<string>();
    const counts = new Map<string, number>();
    for (const port of doc.ports) {
      if (!devices.has(port.deviceId))
        ctx.addIssue({
          code: 'custom',
          message: 'Port must belong to a device on this board',
        });
      const slot = `${port.deviceId}:${port.face}:${port.row}:${port.column}`;
      if (slots.has(slot))
        ctx.addIssue({
          code: 'custom',
          message: 'Ports cannot occupy the same slot',
        });
      slots.add(slot);
      counts.set(port.deviceId, (counts.get(port.deviceId) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > 512))
      ctx.addIssue({
        code: 'custom',
        message: 'A device supports at most 512 ports',
      });
    for (const element of doc.elements.filter(
      (item) => item.type === 'device',
    )) {
      const minimum = minimumBoardDeviceSize(element, doc.ports);
      if (element.width < minimum.width || element.height < minimum.height)
        ctx.addIssue({
          code: 'custom',
          message: 'Device must contain its existing port slots',
        });
    }
    const ports = new Set(doc.ports.map((port) => port.id));
    const occupied = new Set<string>();
    for (const cable of doc.cables) {
      if (
        cable.sourcePortId === cable.targetPortId ||
        !ports.has(cable.sourcePortId) ||
        !ports.has(cable.targetPortId)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Cable endpoints must be different ports on this board',
        });
      for (const endpoint of [cable.sourcePortId, cable.targetPortId]) {
        if (occupied.has(endpoint))
          ctx.addIssue({
            code: 'custom',
            message: 'A port can have one physical cable',
          });
        occupied.add(endpoint);
      }
    }
  });
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
export interface BoardGroup {
  id: string;
  name: string;
  order: number;
  rowVersion: number;
}
export interface BoardSummary {
  id: string;
  name: string;
  groupId: string | null;
  order: number;
  rowVersion: number;
}
export interface BoardRecord extends BoardSummary {
  document: BoardDocument;
}
export const boardImportSchema = z
  .object({
    format: z.literal('portfolio-board'),
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1).max(240),
    document: boardDocumentSchema,
  })
  .strict();
export function emptyBoardDocument(): BoardDocument {
  return {
    schemaVersion: 1,
    elements: [],
    ports: [],
    cables: [],
    viewport: { x: 80, y: 80, zoom: 1 },
    showCables: true,
    grid: true,
  };
}
export function resolveBoardPortColor(
  document: BoardDocument,
  port: BoardPort,
): string {
  if (port.color) return port.color;
  if (port.nativeVlan)
    for (const element of document.elements.filter(
      (item) => item.type === 'network',
    )) {
      const entries = element.properties.entries;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries)
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          if (
            String(entry.vlanId ?? entry.vlan_id ?? '') === port.nativeVlan &&
            typeof entry.color === 'string' &&
            /^#[0-9a-fA-F]{6}$/.test(entry.color)
          )
            return entry.color;
        }
    }
  return '#849389';
}
/** Additive compatibility migration: raw annotations remain available for review/export. */
export function normalizeNetworkEntry(
  entry: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (entry.networkEntryVersion === 2) return { ...entry };
  const next: Record<string, JsonValue> = { ...entry, networkEntryVersion: 2 };
  if (
    (next.vlanName === undefined || next.vlanName === '') &&
    typeof next.name === 'string'
  )
    next.vlanName = next.name;
  if (next.dhcpServer === undefined && typeof next.dhcpStatus === 'string') {
    const status = next.dhcpStatus.trim().toLowerCase();
    if (['enabled', 'on', 'true', 'yes', '1'].includes(status))
      next.dhcpServer = true;
    else if (['disabled', 'off', 'false', 'no', '0'].includes(status))
      next.dhcpServer = false;
  }
  return next;
}

/** Read old documents without writing, changing versions, or dropping unknown data. */
export function normalizeNetworkDocument(
  document: BoardDocument,
): BoardDocument {
  return {
    ...document,
    elements: document.elements.map((element) =>
      element.type === 'network' && Array.isArray(element.properties.entries)
        ? {
            ...element,
            properties: {
              ...element.properties,
              entries: element.properties.entries.map((entry) =>
                entry && typeof entry === 'object' && !Array.isArray(entry)
                  ? normalizeNetworkEntry(entry)
                  : entry,
              ),
            },
          }
        : element,
    ),
  };
}
export const networkDisplayFields = [
  'vlanId',
  'vlanName',
  'subnet',
  'gateway',
  'dhcpServer',
  'dhcpStart',
  'dhcpEnd',
  'dns',
  'notes',
] as const;
export function networkEntrySummary(
  element: BoardElement,
  entry: Record<string, JsonValue>,
): string {
  const fields = Array.isArray(element.properties.displayFields)
    ? element.properties.displayFields.filter(
        (item): item is string => typeof item === 'string',
      )
    : ['vlanId', 'vlanName', 'subnet'];
  const migrated = normalizeNetworkEntry(entry);
  const value = (key: string) =>
    typeof entry[key] === 'string' || typeof entry[key] === 'number'
      ? String(entry[key])
      : '';
  return fields
    .map((field) => {
      if (field === 'dhcpServer' || field === 'dhcpStatus')
        return typeof migrated.dhcpServer === 'boolean'
          ? `DHCP ${migrated.dhcpServer ? 'On' : 'Off'}`
          : value('dhcpStatus');
      if (
        (field === 'dhcpStart' || field === 'dhcpEnd') &&
        migrated.dhcpServer === false
      )
        return '';
      if (field === 'vlanName' || field === 'name')
        return String(migrated.vlanName ?? '');
      if (field === 'vlanId') return value(field) ? `VLAN ${value(field)}` : '';
      if (field === 'subnet') return value('subnet') || value('cidr');
      return value(field);
    })
    .filter(Boolean)
    .join(' · ');
}
export function remapBoardDocument(document: BoardDocument): BoardDocument {
  const ids = new Map(
    [...document.elements, ...document.ports, ...document.cables].map(
      (item) => [item.id, crypto.randomUUID()],
    ),
  );
  return boardDocumentSchema.parse({
    ...document,
    elements: document.elements.map((element) => ({
      ...element,
      id: ids.get(element.id)!,
    })),
    ports: document.ports.map((port) => ({
      ...port,
      id: ids.get(port.id)!,
      deviceId: ids.get(port.deviceId)!,
    })),
    cables: document.cables.map((cable) => ({
      ...cable,
      id: ids.get(cable.id)!,
      sourcePortId: ids.get(cable.sourcePortId)!,
      targetPortId: ids.get(cable.targetPortId)!,
    })),
  });
}
