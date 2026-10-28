import type { BoardElement } from '../../../../packages/shared/src/board.js';
import { networkDisplayValue } from './network-presentation.js';

export interface DeviceHeaderField {
  key: string;
  label: string;
  value: string;
}
export type DeviceHeaderPlacement = {
  index: number;
  x: number;
  y: number;
  width: number;
};
export const DEVICE_HEADER_CHIP_HEIGHT = 16;
export const DEVICE_HEADER_CHIP_GAP = 3;

/** A priority prefix only: fitting cannot resize or write to a board object. */
export function fitDeviceHeaderFields(
  measurements: { ideal: number; minimum: number }[],
  width: number,
  rows = 2,
): DeviceHeaderPlacement[] {
  const result: DeviceHeaderPlacement[] = [];
  let row = 0,
    cursor = 0;
  for (
    let index = 0;
    index < measurements.length && width > 0 && rows > 0;
    index++
  ) {
    const item = measurements[index]!;
    const minimum = Math.min(width, Math.max(1, item.minimum));
    const ideal = Math.max(minimum, Math.min(200, item.ideal));
    let x = cursor ? cursor + DEVICE_HEADER_CHIP_GAP : 0;
    if (width - x < minimum) {
      row++;
      x = 0;
    }
    if (row >= Math.min(2, rows)) break;
    const fitted = Math.min(ideal, width - x);
    result.push({
      index,
      x,
      y: row * (DEVICE_HEADER_CHIP_HEIGHT + DEVICE_HEADER_CHIP_GAP),
      width: fitted,
    });
    cursor = x + fitted;
  }
  return result;
}
export const deviceHeaderFieldDefinitions = [
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'model', label: 'Model' },
  { key: 'managementAddress', label: 'Management Address' },
  { key: 'deviceType', label: 'Device Type' },
  { key: 'portCount', label: 'Port Count' },
  { key: 'notes', label: 'Notes' },
  { key: 'customFields', label: 'Custom Fields' },
] as const;
export type DeviceHeaderFieldKey =
  (typeof deviceHeaderFieldDefinitions)[number]['key'];
export const defaultDeviceHeaderFields: DeviceHeaderFieldKey[] = [
  'manufacturer',
  'model',
  'managementAddress',
];

export function deviceHeaderFieldOrder(
  element: BoardElement,
): DeviceHeaderFieldKey[] {
  const raw = element.properties.headerFields;
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string'))
    return [...defaultDeviceHeaderFields];
  return [...new Set(raw)].filter((key): key is DeviceHeaderFieldKey =>
    deviceHeaderFieldDefinitions.some((field) => field.key === key),
  );
}

/** Pure display data: never changes element dimensions, ports, or stored fields. */
export function deviceHeaderFields(
  element: BoardElement,
  portCount: number,
): DeviceHeaderField[] {
  const result: DeviceHeaderField[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, value: string) => {
    if (!value || seen.has(`${label}\u0000${value}`)) return;
    seen.add(`${label}\u0000${value}`);
    result.push({ key, label, value });
  };
  for (const key of deviceHeaderFieldOrder(element)) {
    if (key === 'customFields') {
      const custom = element.properties.customFields;
      if (custom && typeof custom === 'object' && !Array.isArray(custom))
        for (const [name, value] of Object.entries(custom))
          add(`customFields.${name}`, name, networkDisplayValue(value));
    } else {
      const value =
        key === 'portCount'
          ? String(portCount)
          : networkDisplayValue(element.properties[key]);
      if (key === 'deviceType' && value.trim() === element.name.trim())
        continue;
      add(
        key,
        deviceHeaderFieldDefinitions.find((field) => field.key === key)!.label,
        value,
      );
    }
  }
  return result;
}
