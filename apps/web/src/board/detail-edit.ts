import {
  boardPortSchema,
  normalizeNetworkDocument,
  type BoardDocument,
  type BoardElement,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';
import { findNetwork, type BoardPage } from './detail-model.js';

export const documentationFields = [
  ['description', 'Description'],
  ['serialNumber', 'Serial number'],
  ['location', 'Physical location'],
  ['assetTag', 'Asset tag'],
  ['firmwareVersion', 'Firmware version'],
  ['purchaseDate', 'Purchase date'],
  ['warrantyExpiration', 'Warranty expiration'],
  ['notes', 'General notes'],
] as const;
const deviceFields = new Set([
  'name',
  'manufacturer',
  'model',
  'managementAddress',
  'deviceType',
  'notes',
]);
const networkFields = new Set([
  'vlanId',
  'vlanName',
  'subnet',
  'gateway',
  'dhcpServer',
  'dhcpStart',
  'dhcpEnd',
  'dns',
  'notes',
  'color',
]);
const portFields = new Set([
  'name',
  'kind',
  'role',
  'speed',
  'linkState',
  'nativeVlan',
  'taggedVlans',
  'pvid',
  'address',
  'externalDestination',
  'notes',
]);
const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function documentationRecord(
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  if (
    value !== undefined &&
    (!value || typeof value !== 'object' || Array.isArray(value))
  )
    return { legacyValue: value };
  return record(value);
}
function replace(document: BoardDocument, element: BoardElement) {
  return {
    ...document,
    elements: document.elements.map((item) =>
      item.id === element.id ? element : item,
    ),
  };
}

/** These helpers only patch authored fields; identity, layout, relationships and unknown metadata remain intact. */
export function editDeviceField(
  document: BoardDocument,
  deviceId: string,
  field: string,
  value: string,
): BoardDocument | null {
  const device = document.elements.find(
    (item) => item.id === deviceId && item.type === 'device',
  );
  if (
    !device ||
    !deviceFields.has(field) ||
    typeof value !== 'string' ||
    value.length > (field === 'name' ? 240 : 10000)
  )
    return null;
  return replace(
    document,
    field === 'name'
      ? { ...device, name: value }
      : { ...device, properties: { ...device.properties, [field]: value } },
  );
}
function patchNetwork(
  document: BoardDocument,
  containerId: string,
  entryId: string,
  patch: Record<string, JsonValue>,
): BoardDocument | null {
  const normalized = normalizeNetworkDocument(document);
  const item = findNetwork(normalized, containerId, entryId);
  if (!item || !Array.isArray(item.container.properties.entries)) return null;
  const entries = item.container.properties.entries.map((entry, index) =>
    index === item.index ? { ...item.entry, ...patch } : entry,
  );
  return replace(normalized, {
    ...item.container,
    properties: { ...item.container.properties, entries },
  });
}
export function editNetworkField(
  document: BoardDocument,
  containerId: string,
  entryId: string,
  field: string,
  value: JsonValue,
): BoardDocument | null {
  if (!networkFields.has(field)) return null;
  if (field === 'dhcpServer') {
    if (typeof value !== 'boolean' && value !== null) return null;
  } else if (
    typeof value !== 'string' ||
    value.length > 10000 ||
    (field === 'color' && value !== '' && !/^#[\da-f]{6}$/i.test(value))
  )
    return null;
  return patchNetwork(document, containerId, entryId, { [field]: value });
}
export function editDocumentationField(
  document: BoardDocument,
  page: BoardPage,
  field: string,
  value: string,
): BoardDocument | null {
  if (
    !documentationFields.some(([key]) => key === field) ||
    typeof value !== 'string' ||
    value.length > 10000
  )
    return null;
  if (page.kind === 'device') {
    const device = document.elements.find(
      (item) => item.id === page.deviceId && item.type === 'device',
    );
    if (!device) return null;
    return replace(document, {
      ...device,
      properties: {
        ...device.properties,
        documentation: {
          ...documentationRecord(device.properties.documentation),
          [field]: value,
        },
      },
    });
  }
  if (page.kind === 'network') {
    const item = findNetwork(document, page.containerId, page.entryId);
    if (!item) return null;
    return patchNetwork(document, page.containerId, page.entryId, {
      documentation: {
        ...documentationRecord(item.entry.documentation),
        [field]: value,
      },
    });
  }
  return null;
}
export function editPortField(
  document: BoardDocument,
  deviceId: string,
  portId: string,
  field: string,
  value: JsonValue,
): BoardDocument | null {
  if (
    !portFields.has(field) ||
    !document.elements.some(
      (item) => item.type === 'device' && item.id === deviceId,
    )
  )
    return null;
  const port = document.ports.find(
    (item) => item.id === portId && item.deviceId === deviceId,
  );
  if (!port) return null;
  const parsed = boardPortSchema.safeParse({ ...port, [field]: value });
  if (!parsed.success) return null;
  return {
    ...document,
    ports: document.ports.map((item) =>
      item.id === portId ? parsed.data : item,
    ),
  };
}
