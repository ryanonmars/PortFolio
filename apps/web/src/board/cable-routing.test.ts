import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardCable,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import { portRect, type Point, type Rect } from './geometry.js';
import {
  outsideCableHitPath,
  roundedCablePath,
  routeBoardCable,
} from './cable-routing.js';

function example(x = 200, y = 450) {
  const source: BoardElement = {
    id: 'source',
    type: 'device',
    name: 'Router',
    x: 100,
    y: 100,
    width: 600,
    height: 240,
    z: 0,
    color: '',
    properties: {},
  };
  const target = { ...source, id: 'target', name: 'Switch', x, y, z: 1 };
  const a = {
    ...makeBoardPort(source.id, 'rj45', 0, 4, 'Port 5'),
    id: 'a',
    pvid: '99',
    nativeVlan: 'unlisted',
    customFields: { power: false },
  };
  const b = {
    ...makeBoardPort(target.id, 'sfp_plus', 0, 0, 'Port 1'),
    id: 'b',
  };
  const cable: BoardCable = {
    id: 'wire',
    sourcePortId: 'a',
    targetPortId: 'b',
    name: 'Uplink',
    cableType: 'Authored',
    sourceConnector: 'Custom',
    targetConnector: '',
    color: '',
    length: '',
    notes: '',
  };
  return {
    ...emptyBoardDocument(),
    elements: [source, target],
    ports: [a, b],
    cables: [cable],
  };
}
const within = (point: Point, rect: Rect) =>
  point.x > rect.x &&
  point.x < rect.x + rect.width &&
  point.y > rect.y &&
  point.y < rect.y + rect.height;
function samples(points: Point[]) {
  return points.slice(1).flatMap((end, index) =>
    Array.from({ length: 21 }, (_, step) => ({
      x: points[index]!.x + ((end.x - points[index]!.x) * step) / 20,
      y: points[index]!.y + ((end.y - points[index]!.y) * step) / 20,
    })),
  );
}

describe('presentation-only physical cable routing', () => {
  it('keeps aligned side-by-side exterior lanes distinct even beyond six cables', () => {
    const doc = example(900, 100);
    doc.ports = Array.from({ length: 8 }, (_, column) => [
      { ...doc.ports[0]!, id: `a-${column}`, column },
      { ...doc.ports[1]!, id: `b-${column}`, column },
    ]).flat();
    const base = doc.cables[0]!;
    doc.cables = Array.from({ length: 8 }, (_, index) => ({
      ...base,
      id: `wire-${index}`,
      sourcePortId: `a-${index}`,
      targetPortId: `b-${index}`,
    }));
    const lanes = doc.cables.map((cable) => {
      const route = routeBoardCable(doc, cable)!;
      const end = route.points.find((point, index) => {
        const previous = route.points[index - 1];
        return (
          previous &&
          previous.y === point.y &&
          Math.min(previous.x, point.x) < 800 &&
          Math.max(previous.x, point.x) > 800
        );
      });
      expect(end).toBeDefined();
      return end!.y;
    });
    expect(new Set(lanes).size).toBe(8);
  });

  it('can exclude non-scaling pointer stroke clearance at low zoom', () => {
    const points = [
      { x: 180, y: -50 },
      { x: 180, y: 150 },
    ];
    const elements = [{ x: 0, y: 0, width: 160, height: 100 }];
    const path = outsideCableHitPath(points, elements, 8 / 0.25);
    expect(path).toBe('M 180 -50 L 180 -32 M 180 132 L 180 150');
  });

  it('attaches stacked ports at lower/upper connector edges and escapes through gutters below headers', () => {
    const doc = example(),
      before = JSON.stringify(doc);
    const route = routeBoardCable(doc, doc.cables[0]!)!;
    const source = portRect(doc.elements[0]!, doc.ports[0]!),
      target = portRect(doc.elements[1]!, doc.ports[1]!);
    expect(route.source).toEqual({
      x: source.x + 32,
      y: source.y + (103 * 64) / 120,
    });
    expect(route.target).toEqual({
      x: target.x + 32,
      y: target.y + (9 * 64) / 120,
    });
    expect(route.path).toContain('Q');
    expect(route.hitPath).toContain('M');
    for (const point of samples(route.points))
      for (const element of doc.elements)
        expect(within(point, { ...element, height: 80 })).toBe(false);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('attaches side-by-side connectors at the facing sides and keeps the external run between containers', () => {
    const doc = example(900, 100);
    const route = routeBoardCable(doc, doc.cables[0]!)!;
    expect(route.source.x).toBeCloseTo(
      portRect(doc.elements[0]!, doc.ports[0]!).x + (107 * 64) / 120,
    );
    expect(route.target.x).toBeCloseTo(
      portRect(doc.elements[1]!, doc.ports[1]!).x + (13 * 64) / 120,
    );
    expect(
      samples(route.points).some((point) => point.x > 700 && point.x < 900),
    ).toBe(true);
    expect(
      route.points.every(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
      ),
    ).toBe(true);
  });

  it('routes diagonally connected equipment around an intervening Network panel', () => {
    const doc = example(1000, 600);
    const panel: BoardElement = {
      ...doc.elements[0]!,
      id: 'network',
      type: 'network',
      x: 750,
      y: 200,
      width: 180,
      height: 500,
    };
    doc.elements.push(panel);
    const route = routeBoardCable(doc, doc.cables[0]!)!;
    for (const point of samples(route.points))
      expect(within(point, panel)).toBe(false);
    expect(route.path).not.toMatch(/NaN|Infinity/);
  });

  it('recomputes attachment and paths after movement, resize and port placement without changing identities', () => {
    const doc = example(),
      original = structuredClone(doc);
    const initial = routeBoardCable(doc, doc.cables[0]!)!;
    doc.elements[1]!.x += 300;
    doc.elements[0]!.height += 200;
    doc.ports[0]!.column = 6;
    const changed = routeBoardCable(doc, doc.cables[0]!)!;
    expect(changed.source).not.toEqual(initial.source);
    expect(changed.target).not.toEqual(initial.target);
    expect(changed.path).not.toBe(initial.path);
    expect(doc.cables).toEqual(original.cables);
    expect(doc.ports[0]!.pvid).toBe('99');
    expect(doc.ports[0]!.customFields).toEqual({ power: false });
    expect(routeBoardCable(doc, doc.cables[0]!)).toEqual(changed);
  });

  it('uses deterministic separated lanes for multiple cables without changing saved cable data', () => {
    const doc = example();
    doc.ports.push(
      { ...doc.ports[0]!, id: 'a2', column: 5 },
      { ...doc.ports[1]!, id: 'b2', column: 1 },
    );
    doc.cables.push({
      ...doc.cables[0]!,
      id: 'wire2',
      sourcePortId: 'a2',
      targetPortId: 'b2',
    });
    const first = routeBoardCable(doc, doc.cables[0]!)!,
      second = routeBoardCable(doc, doc.cables[1]!)!;
    expect(first.path).not.toBe(second.path);
    const reordered = { ...doc, cables: [...doc.cables].reverse() };
    expect(routeBoardCable(reordered, doc.cables[0]!)).toEqual(first);
    expect(routeBoardCable(reordered, doc.cables[1]!)).toEqual(second);
  });

  it('clips pointer hit targets outside inflated bodies, including paths that begin inside a connector', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    const path = outsideCableHitPath(
      [
        { x: 50, y: 50 },
        { x: 50, y: 200 },
        { x: 200, y: 200 },
      ],
      [rect],
    );
    expect(path).toContain('50 108');
    expect(path).not.toContain('50 50');
    expect(
      outsideCableHitPath(
        [
          { x: 20, y: 20 },
          { x: 50, y: 50 },
        ],
        [rect],
      ),
    ).toBe('');
  });

  it('handles negative coordinates, same-device links and overlapping layouts without NaN or mutation', () => {
    const doc = example(100, 100);
    doc.elements.forEach((element) => {
      element.x -= 1000;
      element.y -= 1000;
    });
    const overlap = routeBoardCable(doc, doc.cables[0]!)!;
    expect(overlap.path).not.toMatch(/NaN|Infinity/);
    doc.ports[1]!.deviceId = doc.elements[0]!.id;
    doc.ports[1]!.column = 0;
    const sameDevice = routeBoardCable(doc, doc.cables[0]!)!;
    expect(sameDevice.source).not.toEqual(sameDevice.target);
    expect(sameDevice.path).toContain('M');
  });

  it('hides unavailable faces/endpoints while retaining the stored cable', () => {
    const doc = example();
    doc.ports[0]!.face = 'rear';
    expect(routeBoardCable(doc, doc.cables[0]!)).toBeNull();
    doc.ports[0]!.face = 'front';
    doc.elements[1]!.properties.face = 'rear';
    expect(routeBoardCable(doc, doc.cables[0]!)).toBeNull();
    expect(
      routeBoardCable(doc, { ...doc.cables[0]!, targetPortId: 'missing' }),
    ).toBeNull();
    expect(doc.cables).toHaveLength(1);
    expect(
      roundedCablePath([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]),
    ).toBe('M 0 0');
  });
});
