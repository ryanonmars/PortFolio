import { describe, it, expect } from 'vitest';
import {
  emptyBoardDocument,
  boardPortCapacity,
  type BoardElement,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import {
  fitViewport,
  cableHitPath,
  getPortPoint,
  minimumDeviceSize,
  portRect,
  resizeRect,
  screenToWorld,
  snapRect,
  zoomViewport,
} from './geometry.js';
const device: BoardElement = {
  id: 'device',
  type: 'device',
  name: 'Switch',
  x: 100,
  y: 200,
  width: 600,
  height: 400,
  z: 0,
  color: '',
  properties: {},
};
const port: BoardPort = {
  id: 'port',
  deviceId: 'device',
  face: 'front',
  row: 0,
  column: 0,
  name: 'WAN',
  kind: 'rj45',
  color: '',
  role: 'Custom',
  speed: '',
  linkState: '',
  nativeVlan: '999',
  taggedVlans: [],
  pvid: '',
  address: '',
  externalDestination: '',
  notes: '',
  customFields: {},
};
describe('board canvas geometry', () => {
  it('reveals exact dimension-derived capacity while keeping every slot and cable endpoint fixed', () => {
    const eleven = { ...device, width: 816, height: 204 };
    expect(boardPortCapacity(eleven)).toEqual({ columns: 11, rows: 1 });
    expect(boardPortCapacity({ ...eleven, width: 815, height: 203 })).toEqual({
      columns: 10,
      rows: 0,
    });
    const enlarged = { ...eleven, width: 1800, height: 600 };
    expect(boardPortCapacity(enlarged)).toEqual({ columns: 24, rows: 4 });
    const p = { ...port, column: 10 };
    expect(portRect(enlarged, p)).toEqual(portRect(eleven, p));
    expect(
      getPortPoint(
        { ...emptyBoardDocument(), elements: [enlarged], ports: [p] },
        p.id,
      ),
    ).toEqual(
      getPortPoint(
        { ...emptyBoardDocument(), elements: [eleven], ports: [p] },
        p.id,
      ),
    );
    const minimum = minimumDeviceSize(enlarged, [
      p,
      { ...p, id: 'rear', face: 'rear', row: 1, column: 23 },
    ]);
    const shrunk = resizeRect(
      enlarged,
      'se',
      { x: -10000, y: -10000 },
      minimum,
      true,
    );
    expect(shrunk).toMatchObject({ width: 1752, height: 304 });
    expect(p.column).toBe(10);
  });
  it('keeps cable pointer targets outside equipment controls while preserving endpoint identity', () => {
    const a = { x: 50, y: 50 },
      b = { x: 400, y: 50 };
    const hit = cableHitPath(a, b, [
      { x: 0, y: 0, width: 160, height: 120 },
      { x: 320, y: 0, width: 160, height: 120 },
    ]);
    expect(hit).toContain('M ');
    const numbers = hit.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    for (let index = 0; index < numbers.length; index += 2) {
      expect(numbers[index]).toBeGreaterThan(167);
      expect(numbers[index]).toBeLessThan(313);
    }
    expect(a).toEqual({ x: 50, y: 50 });
    expect(
      cableHitPath(a, { x: 80, y: 50 }, [
        { x: 0, y: 0, width: 160, height: 120 },
      ]),
    ).toBe('');
  });
  it('keeps zoom centered on the same world coordinate at any scale', () => {
    const viewport = { x: 80, y: -40, zoom: 0.5 };
    const pointer = { x: 300, y: 200 };
    expect(screenToWorld(pointer, zoomViewport(viewport, pointer, 2))).toEqual(
      screenToWorld(pointer, viewport),
    );
  });
  it('fits negative-coordinate side-by-side containers without changing them', () => {
    const doc = {
      ...emptyBoardDocument(),
      elements: [
        { ...device, x: -500 },
        { ...device, id: 'second', x: 300 },
      ],
    };
    const viewport = fitViewport(doc, 1200, 700);
    for (const element of doc.elements) {
      expect(element.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(47);
      expect(
        (element.x + element.width) * viewport.zoom + viewport.x,
      ).toBeLessThanOrEqual(1153);
    }
    expect(doc.elements[0]!.x).toBe(-500);
  });
  it('uses stable device-relative slots and hides cable points on the opposite face', () => {
    const doc = { ...emptyBoardDocument(), elements: [device], ports: [port] };
    expect(portRect(device, port)).toEqual({
      x: 116,
      y: 296,
      width: 64,
      height: 92,
    });
    expect(getPortPoint(doc, port.id)).toEqual({
      x: 148,
      y: 296 + (64 * 50) / 120,
    });
    expect(
      getPortPoint(
        { ...doc, elements: [{ ...device, properties: { face: 'rear' } }] },
        port.id,
      ),
    ).toBeNull();
  });
  it('clamps resizing against all ports on both faces without moving slots', () => {
    const ports = [
      port,
      { ...port, id: 'rear', face: 'rear' as const, column: 7, row: 2 },
    ];
    const minimum = minimumDeviceSize(device, ports);
    expect(minimum).toEqual({ width: 600, height: 404 });
    const rect = resizeRect(
      { ...device, height: 500 },
      'nw',
      { x: 1000, y: 1000 },
      minimum,
      true,
    );
    expect(rect.width).toBe(600);
    expect(rect.height).toBe(404);
    expect(rect.x + rect.width).toBe(700);
    expect(ports[1]!.row).toBe(2);
  });
  it('snaps grid, edges, centers and consistent gaps with a screen-space threshold', () => {
    expect(
      snapRect({ x: 17, y: 15, width: 160, height: 120 }, [], 1).rect,
    ).toMatchObject({ x: 16, y: 16 });
    const other = { x: 100, y: 200, width: 200, height: 160 };
    const aligned = snapRect(
      { x: 103, y: 500, width: 200, height: 120 },
      [other],
      1,
    );
    expect(aligned.rect.x).toBe(100);
    expect(aligned.guides).toContainEqual({ axis: 'x', value: 300 });
    expect(
      snapRect({ x: 325, y: 500, width: 160, height: 120 }, [other], 1).rect.x,
    ).toBe(324);
    const raw = { x: 103, y: 503, width: 160, height: 120 };
    expect(snapRect(raw, [other], 1, true)).toEqual({ rect: raw, guides: [] });
  });
  it('keeps empty devices lightweight and socket placement independent of resizing', () => {
    expect(minimumDeviceSize(device, [])).toEqual({ width: 160, height: 120 });
    expect(portRect({ ...device, width: 900, height: 700 }, port)).toEqual(
      portRect(device, port),
    );
  });
});
