import {
  emptyBoardDocument,
  minimumBoardDeviceSize,
  boardPortLayout,
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
    linkState: 'unknown',
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
  portsPerRow?: number,
): BoardDocument {
  const device = document.elements.find(
    (item) => item.id === deviceId && item.type === 'device',
  );
  if (!device) throw new Error('Select a device');
  const existing = document.ports.filter((port) => port.deviceId === deviceId);
  if (!Number.isInteger(count) || count < 1 || count + existing.length > 512)
    throw new Error('Choose 1–512 total ports per device');
  if (
    portsPerRow !== undefined &&
    (!Number.isInteger(portsPerRow) || portsPerRow < 1 || portsPerRow > 512)
  )
    throw new Error('Ports per row must be a whole number from 1 to 512');
  const facePorts = existing.filter((port) => port.face === face);
  // A new horizontal run appends to the first row. Explicit multi-row blocks
  // start below existing rows, preserving intentional gaps and every old slot.
  const columns = portsPerRow ?? count;
  const startRow =
    portsPerRow === undefined || !facePorts.length
      ? 0
      : Math.max(...facePorts.map((port) => port.row)) + 1;
  const startColumn =
    portsPerRow === undefined
      ? Math.max(
          -1,
          ...facePorts
            .filter((port) => port.row === 0)
            .map((port) => port.column),
        ) + 1
      : 0;
  const added = Array.from({ length: count }, (_, index) =>
    makeBoardPort(
      deviceId,
      kind,
      startRow + Math.floor(index / columns),
      startColumn + (index % columns),
      `Port ${existing.length + index + 1}`,
      face,
    ),
  );
  const ports = [...document.ports, ...added];
  const minimum = minimumBoardDeviceSize(device, ports);
  if (
    minimum.width > boardPortLayout.maxDeviceSize ||
    minimum.height > boardPortLayout.maxDeviceSize
  )
    throw new Error(
      'This layout exceeds the supported device size. Choose fewer ports per row or a different placement.',
    );
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
    ...(element.type === 'summary'
      ? { properties: structuredClone(element.properties) }
      : {}),
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
