import {
  boardPortCapacity,
  maxBoardPortColumn,
  maxBoardPortRow,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';

export type PortLayoutPreset =
  'single-row' | 'odd-top' | 'odd-bottom' | 'sequential';
export type PortLayoutOptions = {
  preset: PortLayoutPreset;
  columns?: number;
  row?: number;
  column?: number;
};
type Slot = Pick<BoardPort, 'row' | 'column'>;

function countAndNumber(count: number, startNumber: number) {
  if (!Number.isInteger(count) || count < 1 || count > 512)
    throw new Error('Choose 1–512 ports.');
  if (
    !Number.isSafeInteger(startNumber) ||
    startNumber < 0 ||
    startNumber > Number.MAX_SAFE_INTEGER - (count - 1)
  )
    throw new Error(
      'Starting number must be a non-negative whole number within the supported numbering range.',
    );
}

/** Coordinates only: presets are not retained after their slots are applied. */
export function generatePortSlots(
  count: number,
  options: PortLayoutOptions,
  startNumber = 1,
): Slot[] {
  countAndNumber(count, startNumber);
  if (
    !['single-row', 'odd-top', 'odd-bottom', 'sequential'].includes(
      options.preset,
    )
  )
    throw new Error('Choose a port layout preset.');
  if (
    options.columns !== undefined &&
    (!Number.isInteger(options.columns) ||
      options.columns < 1 ||
      options.columns > 512)
  )
    throw new Error('Ports per row must be a whole number from 1 to 512.');
  const row = options.row ?? 0;
  const column = options.column ?? 0;
  if (
    !Number.isInteger(row) ||
    row < 0 ||
    row > maxBoardPortRow ||
    !Number.isInteger(column) ||
    column < 0 ||
    column > maxBoardPortColumn
  )
    throw new Error(
      'Starting row and column must identify valid device grid slots.',
    );
  const columns = options.columns ?? Math.ceil(count / 2);
  const slots = Array.from({ length: count }, (_, index): Slot => {
    if (options.preset === 'single-row') return { row, column: column + index };
    if (options.preset === 'sequential')
      return {
        row: row + Math.floor(index / columns),
        column: column + (index % columns),
      };
    const odd = (startNumber + index) % 2 === 1;
    const onTop = options.preset === 'odd-top' ? odd : !odd;
    return {
      row: row + Math.floor(index / (columns * 2)) * 2 + (onTop ? 0 : 1),
      column: column + (Math.floor(index / 2) % columns),
    };
  });
  if (
    slots.some(
      (slot) => slot.row > maxBoardPortRow || slot.column > maxBoardPortColumn,
    )
  )
    throw new Error(
      'This layout exceeds the supported device grid. Adjust the row width or starting slot.',
    );
  return slots;
}

function target(
  document: BoardDocument,
  deviceId: string,
  face: BoardPort['face'],
): BoardElement {
  const device = document.elements.find(
    (element) => element.id === deviceId && element.type === 'device',
  );
  if (!device) throw new Error('Select a device on this board.');
  if (face !== 'front' && face !== 'rear')
    throw new Error('Choose the front or rear device face.');
  return device;
}

function validatePlacement(
  device: BoardElement,
  proposed: BoardPort[],
  existing: BoardPort[],
) {
  const capacity = boardPortCapacity(device);
  if (
    proposed.some(
      (port) => port.row >= capacity.rows || port.column >= capacity.columns,
    )
  )
    throw new Error(
      `Resize the device or adjust the layout to fit its ${capacity.columns} columns × ${capacity.rows} rows.`,
    );
  const occupied = new Set(
    existing.map((port) => `${port.face}:${port.row}:${port.column}`),
  );
  for (const port of proposed) {
    const slot = `${port.face}:${port.row}:${port.column}`;
    if (occupied.has(slot))
      throw new Error(
        'That port slot is occupied. Choose a different starting row or column.',
      );
    occupied.add(slot);
  }
}

export function previewPortBank(
  document: BoardDocument,
  deviceId: string,
  kind: BoardPort['kind'],
  count: number,
  face: BoardPort['face'],
  options: PortLayoutOptions,
  startNumber?: number,
  labelPrefix = 'Port ',
): BoardPort[] {
  const device = target(document, deviceId, face);
  const existing = document.ports.filter((port) => port.deviceId === deviceId);
  const firstNumber = startNumber ?? existing.length + 1;
  const slots = generatePortSlots(count, options, firstNumber);
  if (existing.length + count > 512)
    throw new Error('A device supports at most 512 ports.');
  if (document.ports.length + count > 4096)
    throw new Error('A board supports at most 4096 ports.');
  if (!['rj45', 'sfp', 'sfp_plus', 'qsfp', 'other'].includes(kind))
    throw new Error('Choose a connector type.');
  if (
    typeof labelPrefix !== 'string' ||
    `${labelPrefix}${firstNumber + (count - 1)}`.length > 240
  )
    throw new Error('Port names must contain at most 240 characters.');
  const added = slots.map(({ row, column }, index) =>
    makeBoardPort(
      deviceId,
      kind,
      row,
      column,
      `${labelPrefix}${firstNumber + index}`,
      face,
    ),
  );
  validatePlacement(device, added, existing);
  return added;
}

export function addPortBank(
  document: BoardDocument,
  deviceId: string,
  kind: BoardPort['kind'],
  count: number,
  face: BoardPort['face'],
  options: PortLayoutOptions,
  startNumber?: number,
  labelPrefix?: string,
): BoardDocument {
  const added = previewPortBank(
    document,
    deviceId,
    kind,
    count,
    face,
    options,
    startNumber,
    labelPrefix,
  );
  return { ...document, ports: [...document.ports, ...added] };
}

export function previewPortLayout(
  document: BoardDocument,
  deviceId: string,
  face: BoardPort['face'],
  options: PortLayoutOptions,
): BoardPort[] {
  const device = target(document, deviceId, face);
  // Document insertion order is stable; names and previous coordinates do not
  // infer numbering or silently change which record receives each new slot.
  const existing = document.ports.filter(
    (port) => port.deviceId === deviceId && port.face === face,
  );
  if (!existing.length)
    throw new Error('This device face has no ports to arrange.');
  const slots = generatePortSlots(existing.length, options);
  const arranged = existing.map((port, index) => ({
    ...port,
    ...slots[index]!,
  }));
  validatePlacement(device, arranged, []);
  return arranged;
}

export function applyPortLayout(
  document: BoardDocument,
  deviceId: string,
  face: BoardPort['face'],
  options: PortLayoutOptions,
): BoardDocument {
  const arranged = previewPortLayout(document, deviceId, face, options);
  const byId = new Map(arranged.map((port) => [port.id, port]));
  return {
    ...document,
    ports: document.ports.map((port) => byId.get(port.id) ?? port),
  };
}
