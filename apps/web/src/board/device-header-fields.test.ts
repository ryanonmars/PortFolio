import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import {
  deviceHeaderFields,
  deviceHeaderFieldOrder,
  fitDeviceHeaderFields,
} from './device-header-fields.js';
import { makeBoardPort } from './commands.js';
import { boardImageSvg } from './image-export.js';
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

  it.each([0, 126, 286, 766])(
    'fits a priority prefix into two rows at logical width %s without overflow',
    (width) => {
      const sizes = Array.from({ length: 30 }, (_, index) => ({
        ideal: 400 + index,
        minimum: 100,
      }));
      const before = JSON.stringify(sizes);
      const fitted = fitDeviceHeaderFields(sizes, width);
      expect(fitted.map((item) => item.index)).toEqual(
        Array.from({ length: fitted.length }, (_, index) => index),
      );
      for (const item of fitted) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x + item.width).toBeLessThanOrEqual(width);
        expect(item.y + 16).toBeLessThanOrEqual(35);
        expect(item.width).toBeLessThanOrEqual(200);
      }
      expect(JSON.stringify(sizes)).toBe(before);
    },
  );

  it('hides lower-priority fields rather than squeezing a third row or skipping higher priorities', () => {
    expect(
      fitDeviceHeaderFields(
        [
          { ideal: 900, minimum: 100 },
          { ideal: 900, minimum: 100 },
          { ideal: 20, minimum: 20 },
        ],
        126,
      ),
    ).toEqual([
      { index: 0, x: 0, y: 0, width: 126 },
      { index: 1, x: 0, y: 19, width: 126 },
    ]);
    expect(
      fitDeviceHeaderFields([{ ideal: 100, minimum: 50 }], 126, 0),
    ).toEqual([]);
  });

  it('keeps canonical dimensions, ports and simple cable geometry unchanged through rendering/export', () => {
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
    const svg = boardImageSvg(document);
    expect(svg).toContain('TP-Link');
    expect(svg).toContain('Management Address: router.example, 2001:db8::1');
    expect(svg).toContain('height="16"');
    expect(svg).toContain('header-field-');
    expect(JSON.stringify(document)).toBe(before);
    const none = {
      ...document,
      elements: document.elements.map((element) => ({
        ...element,
        properties: { ...element.properties, headerFields: [] },
      })),
    };
    expect(boardImageSvg(none)).not.toContain('header-field-');
    expect(portRect(none.elements[0]!, none.ports[0]!)).toEqual(originalPort);
    expect(
      cableCurve(
        getPortPoint(none, none.ports[0]!.id)!,
        getPortPoint(none, none.ports[1]!.id)!,
      ),
    ).toBe(originalCable);
  });
});
