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
export const DEVICE_HEADER_CHIP_HEIGHT = 32;
export const DEVICE_HEADER_CHIP_GAP = 8;

/** A complete priority prefix only; overflow belongs in the information popover. */
export function fitDeviceHeaderFields(
  measurements: { ideal: number; minimum?: number }[],
  width: number,
  rows = 1,
): DeviceHeaderPlacement[] {
  if (!Number.isFinite(width) || width <= 0 || rows <= 0) return [];
  const result: DeviceHeaderPlacement[] = [];
  let cursor = 0;
  for (let index = 0; index < measurements.length; index++) {
    const natural = measurements[index]!.ideal;
    const x = cursor + (result.length ? DEVICE_HEADER_CHIP_GAP : 0);
    if (!Number.isFinite(natural) || natural <= 0 || x + natural > width) break;
    result.push({ index, x, y: 0, width: natural });
    cursor = x + natural;
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
