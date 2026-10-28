import {
  emptyBoardDocument,
  minimumBoardDeviceSize,
  remapBoardDocument,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
export function makeBoardPort(
  deviceId: string,
  kind: BoardPort['kind'],
  row: number,
  column: number,
  name: string,
  face: BoardPort['face'] = 'front',
): BoardPort {
  return {
    id: crypto.randomUUID(),
    deviceId,
    kind,
    row,
    column,
    face,
    name,
    color: '',
    role: '',
    speed: '',
    linkState: '',
    nativeVlan: '',
    taggedVlans: [],
    pvid: '',
    address: '',
    externalDestination: '',
    notes: '',
    customFields: {},
  };
}
export function addPorts(
  document: BoardDocument,
  deviceId: string,
  kind: BoardPort['kind'],
  count: number,
  face: BoardPort['face'],
): BoardDocument {
  const device = document.elements.find(
    (item) => item.id === deviceId && item.type === 'device',
  );
  if (!device) throw new Error('Select a device');
  const existing = document.ports.filter((port) => port.deviceId === deviceId);
  if (!Number.isInteger(count) || count < 1 || count + existing.length > 512)
    throw new Error('Choose 1–512 total ports per device');
  const raw =
    device.properties[face === 'front' ? 'frontColumns' : 'rearColumns'];
  const columns =
    typeof raw === 'number' && raw >= 1 ? Math.min(64, Math.floor(raw)) : 8;
  const occupied = new Set(
    existing
      .filter((port) => port.face === face)
      .map((port) => `${port.row}:${port.column}`),
  );
  const added: BoardPort[] = [];
  for (let slot = 0; added.length < count && slot < 128 * columns; slot++) {
    const row = Math.floor(slot / columns),
      column = slot % columns;
    if (!occupied.has(`${row}:${column}`))
      added.push(
        makeBoardPort(
          deviceId,
          kind,
          row,
          column,
          `Port ${existing.length + added.length + 1}`,
          face,
        ),
      );
  }
  if (added.length !== count) throw new Error('No available port slots');
  const ports = [...document.ports, ...added];
  const minimum = minimumBoardDeviceSize(device, ports);
  return {
    ...document,
    ports,
    elements: document.elements.map((item) =>
      item.id === deviceId
        ? {
            ...item,
            width: Math.max(item.width, minimum.width),
            height: Math.max(item.height, minimum.height),
          }
        : item,
    ),
  };
}
export function duplicateElement(
  document: BoardDocument,
  id: string,
): BoardDocument {
  const element = document.elements.find((item) => item.id === id);
  if (!element) return document;
  const ports = document.ports.filter((port) => port.deviceId === id);
  const ids = new Set(ports.map((port) => port.id));
  const fragment = remapBoardDocument({
    ...emptyBoardDocument(),
    elements: [element],
    ports,
    cables: document.cables.filter(
      (cable) => ids.has(cable.sourcePortId) && ids.has(cable.targetPortId),
    ),
  });
  const copied: BoardElement = {
    ...fragment.elements[0]!,
    name: `${element.name} copy`,
    x: element.x + 24,
    y: element.y + 24,
    z: Math.max(0, ...document.elements.map((item) => item.z)) + 1,
  };
  return {
    ...document,
    elements: [...document.elements, copied],
    ports: [...document.ports, ...fragment.ports],
    cables: [...document.cables, ...fragment.cables],
  };
}
export function removeObject(
  document: BoardDocument,
  type: 'element' | 'port' | 'cable',
  id: string,
): BoardDocument {
  const removedPorts = new Set(
    document.ports
      .filter((port) =>
        type === 'port'
          ? port.id === id
          : type === 'element' && port.deviceId === id,
      )
      .map((port) => port.id),
  );
  return {
    ...document,
    elements: document.elements.filter(
      (item) => !(type === 'element' && item.id === id),
    ),
    ports: document.ports.filter((port) => !removedPorts.has(port.id)),
    cables: document.cables.filter(
      (cable) =>
        !(type === 'cable' && cable.id === id) &&
        !removedPorts.has(cable.sourcePortId) &&
        !removedPorts.has(cable.targetPortId),
    ),
  };
}
