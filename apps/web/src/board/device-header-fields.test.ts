import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import {
  deviceHeaderFields,
  deviceHeaderFieldOrder,
  fitDeviceHeaderFields,
  DEVICE_HEADER_CHIP_HEIGHT,
  DEVICE_HEADER_CHIP_GAP,
} from './device-header-fields.js';
import { makeBoardPort } from './commands.js';
import { cableCurve, getPortPoint, portRect } from './geometry.js';

const device: BoardElement = {
  id: 'device',
  type: 'device',
  name: 'Core router',
  x: 10,
  y: 20,
  width: 800,
  height: 300,
  z: 0,
  color: '',
  properties: {
    manufacturer: 'TP-Link',
    model: 'ER8411',
    managementAddress: 'router.example, 2001:db8::1',
    deviceType: 'Router',
    notes: 'Long notes\nkeep their original lines',
    customFields: { Capacity: 0, Monitored: false },
  },
};

describe('fixed-header display preferences and fitting', () => {
  it('defaults to the three standard fields while respecting explicit none and configured order', () => {
    expect(deviceHeaderFieldOrder(device)).toEqual([
      'manufacturer',
      'model',
      'managementAddress',
    ]);
    expect(deviceHeaderFields(device, 2).map((field) => field.key)).toEqual([
      'manufacturer',
      'model',
      'managementAddress',
    ]);
    expect(
      deviceHeaderFields(
        { ...device, properties: { ...device.properties, headerFields: [] } },
        2,
      ),
    ).toEqual([]);
    const element = {
      ...device,
      properties: {
        ...device.properties,
        headerFields: [
          'notes',
          'manufacturer',
          'notes',
          'futureField',
          'model',
        ],
      },
    };
    expect(deviceHeaderFieldOrder(element)).toEqual([
      'notes',
      'manufacturer',
      'model',
    ]);
    expect(element.properties.headerFields).toEqual([
      'notes',
      'manufacturer',
      'notes',
      'futureField',
      'model',
    ]);
  });

  it('preserves invalid stored preferences and omits empty or duplicate information without rewriting data', () => {
    const element = {
      ...device,
      name: 'Router',
      properties: {
        ...device.properties,
        manufacturer: ' ',
        model: '',
        headerFields: 'legacy-invalid',
      },
    };
    const before = JSON.stringify(element);
    expect(deviceHeaderFields(element, 0)).toHaveLength(1);
    expect(JSON.stringify(element)).toBe(before);
    expect(
      deviceHeaderFields(
        {
          ...element,
          properties: { ...element.properties, headerFields: ['deviceType'] },
        },
        0,
      ),
    ).toEqual([]);
  });

  it('derives real port counts and includes selected typed custom zero/false with full notes', () => {
    const element = {
      ...device,
      properties: {
        ...device.properties,
        headerFields: ['portCount', 'customFields', 'notes'],
        customFields: {
          Capacity: 0,
          Monitored: false,
          Empty: '',
          Absent: null,
          List: [],
        },
      },
    };
    expect(deviceHeaderFields(element, 2)).toEqual([
      { key: 'portCount', label: 'Port Count', value: '2' },
      { key: 'customFields.Capacity', label: 'Capacity', value: '0' },
      { key: 'customFields.Monitored', label: 'Monitored', value: 'false' },
      { key: 'notes', label: 'Notes', value: device.properties.notes },
    ]);
    expect(deviceHeaderFields(element, 0)[0]!.value).toBe('0');
  });

  it('fits complete router information at natural widths without a fixed cap', () => {
    const sizes = [{ ideal: 172 }, { ideal: 126 }, { ideal: 264 }];
    expect(fitDeviceHeaderFields(sizes, 766)).toEqual([
      { index: 0, x: 0, y: 0, width: 172 },
      { index: 1, x: 180, y: 0, width: 126 },
      { index: 2, x: 314, y: 0, width: 264 },
    ]);
    expect(DEVICE_HEADER_CHIP_HEIGHT).toBe(32);
    expect(DEVICE_HEADER_CHIP_GAP).toBe(8);
  });

  it.each([0, 126, 286, 766])(
    'fits a complete priority prefix in one row at logical width %s',
    (width) => {
      const sizes = Array.from({ length: 30 }, (_, index) => ({
        ideal: 100 + index * 10,
        minimum: 1,
      }));
      const before = JSON.stringify(sizes);
      const fitted = fitDeviceHeaderFields(sizes, width);
      expect(fitted.map((item) => item.index)).toEqual(
        Array.from({ length: fitted.length }, (_, index) => index),
      );
      for (const item of fitted) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x + item.width).toBeLessThanOrEqual(width);
        expect(item.y).toBe(0);
        expect(item.width).toBe(sizes[item.index]!.ideal);
      }
      expect(JSON.stringify(sizes)).toBe(before);
    },
  );

  it('shows only complete pills in medium headers and none when the first field cannot fit', () => {
    const sizes = [{ ideal: 172 }, { ideal: 126 }, { ideal: 264 }];
    expect(fitDeviceHeaderFields(sizes, 306)).toHaveLength(2);
    expect(fitDeviceHeaderFields(sizes, 305.9)).toHaveLength(1);
    expect(fitDeviceHeaderFields(sizes, 171)).toEqual([]);
    expect(
      fitDeviceHeaderFields(sizes, 306 - 32 - DEVICE_HEADER_CHIP_GAP),
    ).toEqual([{ index: 0, x: 0, y: 0, width: 172 }]);
  });

  it('never shrinks a long field, starts another row, or skips a higher-priority field', () => {
    expect(
      fitDeviceHeaderFields(
        [
          { ideal: 900, minimum: 1 },
          { ideal: 20, minimum: 1 },
        ],
        766,
        2,
      ),
    ).toEqual([]);
    expect(fitDeviceHeaderFields([{ ideal: 900 }], 1000)).toEqual([
      { index: 0, x: 0, y: 0, width: 900 },
    ]);
    expect(fitDeviceHeaderFields([{ ideal: 100 }], 126, 0)).toEqual([]);
  });

  it('uses exact fractional measurements and restores the same layout after narrowing', () => {
    const sizes = [{ ideal: 100.25 }, { ideal: 50.5 }];
    const wide = fitDeviceHeaderFields(sizes, 158.75);
    expect(wide).toEqual([
      { index: 0, x: 0, y: 0, width: 100.25 },
      { index: 1, x: 108.25, y: 0, width: 50.5 },
    ]);
    expect(fitDeviceHeaderFields(sizes, 158.74)).toHaveLength(1);
    expect(fitDeviceHeaderFields(sizes, 99)).toEqual([]);
    expect(fitDeviceHeaderFields(sizes, 158.75)).toEqual(wide);
  });

  it.each([NaN, Infinity, -1])(
    'rejects unusable placement width %s',
    (width) => {
      expect(fitDeviceHeaderFields([{ ideal: 100 }], width)).toEqual([]);
    },
  );

  it.each([NaN, Infinity, 0, -1])(
    'does not place an invalid natural measurement %s',
    (ideal) => {
      expect(fitDeviceHeaderFields([{ ideal }, { ideal: 20 }], 766)).toEqual(
        [],
      );
    },
  );

  it('keeps canonical dimensions, ports and simple cable geometry unchanged through presentation changes', () => {
    const peer = { ...device, id: 'peer', x: 1100, y: 400 };
    const document = {
      ...emptyBoardDocument(),
      elements: [structuredClone(device), peer],
      ports: [
        makeBoardPort(device.id, 'rj45', 0, 0, 'WAN'),
        makeBoardPort(peer.id, 'sfp_plus', 0, 0, 'Uplink'),
      ],
    };
    const before = JSON.stringify(document);
    const originalPort = portRect(document.elements[0]!, document.ports[0]!);
    const originalCable = cableCurve(
      getPortPoint(document, document.ports[0]!.id)!,
      getPortPoint(document, document.ports[1]!.id)!,
    );
    for (const element of document.elements)
      deviceHeaderFields(
        element,
        document.ports.filter((port) => port.deviceId === element.id).length,
      );
    expect(deviceHeaderFields(document.elements[0]!, 1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Manufacturer', value: 'TP-Link' }),
        expect.objectContaining({
          label: 'Management Address',
          value: 'router.example, 2001:db8::1',
        }),
      ]),
    );
    expect(JSON.stringify(document)).toBe(before);
    const none = {
      ...document,
      elements: document.elements.map((element) => ({
        ...element,
        properties: { ...element.properties, headerFields: [] },
      })),
    };
    expect(deviceHeaderFields(none.elements[0]!, 1)).toEqual([]);
    expect(portRect(none.elements[0]!, none.ports[0]!)).toEqual(originalPort);
    expect(
      cableCurve(
        getPortPoint(none, none.ports[0]!.id)!,
        getPortPoint(none, none.ports[1]!.id)!,
      ),
    ).toBe(originalCable);
  });
});
