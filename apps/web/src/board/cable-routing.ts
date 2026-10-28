import type {
  BoardCable,
  BoardDocument,
  BoardElement,
  BoardPort,
} from '../../../../packages/shared/src/board.js';
import {
  activeFace,
  portGap,
  portRect,
  type Point,
  type Rect,
} from './geometry.js';

type Side = 'left' | 'right' | 'top' | 'bottom';
export interface RoutedBoardCable {
  path: string;
  hitPath: string;
  source: Point;
  target: Point;
  points: Point[];
}
const same = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
const inside = (p: Point, r: Rect) =>
  p.x > r.x + 0.001 &&
  p.x < r.x + r.width - 0.001 &&
  p.y > r.y + 0.001 &&
  p.y < r.y + r.height - 0.001;
const inflate = (r: Rect, gap: number): Rect => ({
  x: r.x - gap,
  y: r.y - gap,
  width: r.width + 2 * gap,
  height: r.height + 2 * gap,
});
const number = (value: number) => Math.round(value * 1000) / 1000;
const coordinate = (p: Point) => `${number(p.x)} ${number(p.y)}`;

function blocked(a: Point, b: Point, rectangles: Rect[]): boolean {
  if (same(a, b)) return rectangles.some((rect) => inside(a, rect));
  return rectangles.some((r) => {
    if (Math.abs(a.x - b.x) < 0.001)
      return (
        a.x > r.x + 0.001 &&
        a.x < r.x + r.width - 0.001 &&
        Math.max(a.y, b.y) > r.y + 0.001 &&
        Math.min(a.y, b.y) < r.y + r.height - 0.001
      );
    return (
      a.y > r.y + 0.001 &&
      a.y < r.y + r.height - 0.001 &&
      Math.max(a.x, b.x) > r.x + 0.001 &&
      Math.min(a.x, b.x) < r.x + r.width - 0.001
    );
  });
}
function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    if (result.length && same(result.at(-1)!, point)) continue;
    while (result.length > 1) {
      const a = result.at(-2)!,
        b = result.at(-1)!;
      if (
        (a.x === b.x &&
          b.x === point.x &&
          (b.y - a.y) * (point.y - b.y) >= 0) ||
        (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0)
      )
        result.pop();
      else break;
    }
    result.push(point);
  }
  return result;
}
export function roundedCablePath(raw: Point[]): string {
  const points = simplify(raw);
  if (!points.length) return '';
  let path = `M ${coordinate(points[0]!)}`;
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1]!,
      b = points[index]!,
      c = points[index + 1]!;
    const before = Math.hypot(b.x - a.x, b.y - a.y),
      after = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(8, before / 2, after / 2);
    const enter = {
      x: b.x + ((a.x - b.x) * radius) / before,
      y: b.y + ((a.y - b.y) * radius) / before,
    };
    const leave = {
      x: b.x + ((c.x - b.x) * radius) / after,
      y: b.y + ((c.y - b.y) * radius) / after,
    };
    path += ` L ${coordinate(enter)} Q ${coordinate(b)} ${coordinate(leave)}`;
  }
  if (points.length > 1) path += ` L ${coordinate(points.at(-1)!)}`;
  return path;
}
function direction(from: Point, to: Point): Side {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  return Math.abs(dy) > Math.abs(dx) * 0.7
    ? dy >= 0
      ? 'bottom'
      : 'top'
    : dx >= 0
      ? 'right'
      : 'left';
}
function attachment(port: BoardPort, device: BoardElement, side: Side): Point {
  const rect = portRect(device, port),
    scale = 64 / 120;
  return {
    x: rect.x + (side === 'left' ? 13 : side === 'right' ? 107 : 60) * scale,
    y: rect.y + (side === 'top' ? 9 : side === 'bottom' ? 103 : 56) * scale,
  };
}
function escapePort(
  port: BoardPort,
  device: BoardElement,
  side: Side,
  peer: Point,
  margin: number,
  others: Rect[],
): Point[] {
  const rect = portRect(device, port),
    start = attachment(port, device, side);
  const right = peer.x >= device.x + device.width / 2;
  const sideX = (toRight: boolean) =>
    toRight ? device.x + device.width + margin : device.x - margin;
  const railY = rect.y + 0.5;
  let points: Point[];
  if (side === 'bottom') {
    const gutter = rect.x + 64 + portGap(device) / 2;
    points = [
      start,
      { x: start.x, y: rect.y + 57 },
      { x: gutter, y: rect.y + 57 },
      { x: gutter, y: device.y + device.height + margin },
    ];
    if (others.some((item) => inside(points.at(-1)!, inflate(item, 8)))) {
      points = [
        start,
        { x: start.x, y: rect.y + 57 },
        { x: gutter, y: rect.y + 57 },
        { x: gutter, y: device.y + device.height - 4 },
        { x: sideX(right), y: device.y + device.height - 4 },
      ];
    }
  } else {
    const x =
      side === 'left' ? rect.x + 2 : side === 'right' ? rect.x + 62 : start.x;
    const toRight = side === 'left' ? false : side === 'right' ? true : right;
    points = [
      start,
      { x, y: start.y },
      { x, y: railY },
      { x: sideX(toRight), y: railY },
    ];
    if (others.some((item) => inside(points.at(-1)!, inflate(item, 8))))
      points[points.length - 1] = { x: sideX(!toRight), y: railY };
    if ((side === 'left' || side === 'right') && margin > 16) {
      const end = points.at(-1)!;
      points.push({ x: end.x, y: railY - (margin - 16) });
    }
  }
  return simplify(points);
}
function length(points: Point[]) {
  return (
    points
      .slice(1)
      .reduce(
        (total, point, index) =>
          total +
          Math.abs(point.x - points[index]!.x) +
          Math.abs(point.y - points[index]!.y),
        0,
      ) +
    points.length * 10
  );
}
/** Most boards need only a two-bend gutter; a bounded grid handles staggered obstacles. */
function outsideRoute(a: Point, b: Point, obstacles: Rect[]): Point[] | null {
  const relevant = [...obstacles]
    .sort(
      (x, y) =>
        Math.hypot(
          x.x + x.width / 2 - (a.x + b.x) / 2,
          x.y + x.height / 2 - (a.y + b.y) / 2,
        ) -
        Math.hypot(
          y.x + y.width / 2 - (a.x + b.x) / 2,
          y.y + y.height / 2 - (a.y + b.y) / 2,
        ),
    )
    .slice(0, 18);
  const xs = [
    ...new Set([
      a.x,
      b.x,
      ...relevant.flatMap((r) => [r.x, r.x + r.width]),
      Math.min(a.x, b.x, ...obstacles.map((r) => r.x)) - 16,
      Math.max(a.x, b.x, ...obstacles.map((r) => r.x + r.width)) + 16,
    ]),
  ].sort((x, y) => x - y);
  const ys = [
    ...new Set([
      a.y,
      b.y,
      ...relevant.flatMap((r) => [r.y, r.y + r.height]),
      Math.min(a.y, b.y, ...obstacles.map((r) => r.y)) - 16,
      Math.max(a.y, b.y, ...obstacles.map((r) => r.y + r.height)) + 16,
    ]),
  ].sort((x, y) => x - y);
  const candidates: Point[][] = [
    [a, { x: b.x, y: a.y }, b],
    [a, { x: a.x, y: b.y }, b],
    ...xs.map((x) => [a, { x, y: a.y }, { x, y: b.y }, b]),
    ...ys.map((y) => [a, { x: a.x, y }, { x: b.x, y }, b]),
  ];
  const clear = candidates
    .filter((points) =>
      points
        .slice(1)
        .every((point, index) => !blocked(points[index]!, point, obstacles)),
    )
    .map(simplify)
    .sort((x, y) => length(x) - length(y));
  if (clear.length) return clear[0]!;
  if (obstacles.some((rect) => inside(a, rect) || inside(b, rect))) return null;
  const size = xs.length * ys.length;
  const start = ys.indexOf(a.y) * xs.length + xs.indexOf(a.x),
    finish = ys.indexOf(b.y) * xs.length + xs.indexOf(b.x);
  const distance = new Float64Array(size).fill(Infinity),
    previous = new Int32Array(size).fill(-1),
    closed = new Uint8Array(size);
  const point = (index: number): Point => ({
    x: xs[index % xs.length]!,
    y: ys[Math.floor(index / xs.length)]!,
  });
  distance[start] = 0;
  for (let count = 0; count < size; count++) {
    let current = -1,
      score = Infinity;
    for (let index = 0; index < size; index++)
      if (!closed[index] && distance[index]! < Infinity) {
        const p = point(index),
          estimate =
            distance[index]! + Math.abs(p.x - b.x) + Math.abs(p.y - b.y);
        if (estimate < score) {
          score = estimate;
          current = index;
        }
      }
    if (current < 0) break;
    if (current === finish) {
      const route = [];
      for (let index = finish; index >= 0; index = previous[index]!)
        route.push(point(index));
      return simplify(route.reverse());
    }
    closed[current] = 1;
    const x = current % xs.length,
      y = Math.floor(current / xs.length);
    for (const next of [
      x ? current - 1 : -1,
      x < xs.length - 1 ? current + 1 : -1,
      y ? current - xs.length : -1,
      y < ys.length - 1 ? current + xs.length : -1,
    ]) {
      if (
        next < 0 ||
        closed[next] ||
        blocked(point(current), point(next), obstacles)
      )
        continue;
      const p = point(current),
        n = point(next),
        cost = distance[current]! + Math.abs(p.x - n.x) + Math.abs(p.y - n.y);
      if (cost < distance[next]!) {
        distance[next] = cost;
        previous[next] = current;
      }
    }
  }
  return null;
}
/** Hit targets only occupy free board space, never device text or controls. */
export function outsideCableHitPath(
  points: Point[],
  elements: Rect[],
  clearance = 8,
): string {
  let path = '';
  const obstacles = elements.map((element) => inflate(element, clearance));
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!,
      b = points[index]!;
    const values = [0, 1];
    for (const rect of obstacles) {
      if (a.x !== b.x)
        for (const x of [rect.x, rect.x + rect.width]) {
          const t = (x - a.x) / (b.x - a.x);
          if (t > 0 && t < 1) values.push(t);
        }
      if (a.y !== b.y)
        for (const y of [rect.y, rect.y + rect.height]) {
          const t = (y - a.y) / (b.y - a.y);
          if (t > 0 && t < 1) values.push(t);
        }
    }
    values.sort((x, y) => x - y);
    for (let step = 1; step < values.length; step++) {
      const at = (t: number): Point => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
      const low = values[step - 1]!,
        high = values[step]!;
      if (
        high - low > 0.00001 &&
        !obstacles.some((rect) => inside(at((low + high) / 2), rect))
      )
        path += ` M ${coordinate(at(low))} L ${coordinate(at(high))}`;
    }
  }
  return path.trim();
}
export function routeBoardCable(
  document: BoardDocument,
  cable: BoardCable,
): RoutedBoardCable | null {
  const ports = new Map(document.ports.map((port) => [port.id, port]));
  const sourcePort = ports.get(cable.sourcePortId),
    targetPort = ports.get(cable.targetPortId);
  if (!sourcePort || !targetPort) return null;
  const sourceDevice = document.elements.find(
      (element) => element.id === sourcePort.deviceId,
    ),
    targetDevice = document.elements.find(
      (element) => element.id === targetPort.deviceId,
    );
  if (
    !sourceDevice ||
    !targetDevice ||
    activeFace(sourceDevice) !== sourcePort.face ||
    activeFace(targetDevice) !== targetPort.face
  )
    return null;
  const aRect = portRect(sourceDevice, sourcePort),
    bRect = portRect(targetDevice, targetPort);
  const a = { x: aRect.x + 32, y: aRect.y + 30 },
    b = { x: bRect.x + 32, y: bRect.y + 30 };
  const peers = document.cables
    .filter((item) => {
      const first = ports.get(item.sourcePortId)?.deviceId,
        second = ports.get(item.targetPortId)?.deviceId;
      return (
        (first === sourceDevice.id && second === targetDevice.id) ||
        (first === targetDevice.id && second === sourceDevice.id)
      );
    })
    .map((item) => item.id)
    .sort();
  const laneSpacing = Math.min(14, 70 / Math.max(1, peers.length - 1));
  const margin = 16 + Math.max(0, peers.indexOf(cable.id)) * laneSpacing;
  const source = escapePort(
    sourcePort,
    sourceDevice,
    direction(a, b),
    b,
    margin,
    document.elements.filter((element) => element.id !== sourceDevice.id),
  );
  const target = escapePort(
    targetPort,
    targetDevice,
    direction(b, a),
    a,
    margin,
    document.elements.filter((element) => element.id !== targetDevice.id),
  );
  const obstacles = document.elements.map((element) => inflate(element, 8));
  const middle = outsideRoute(source.at(-1)!, target.at(-1)!, obstacles) ?? [
    source.at(-1)!,
    { x: source.at(-1)!.x, y: target.at(-1)!.y },
    target.at(-1)!,
  ];
  const points = simplify([...source, ...middle, ...target.reverse()]);
  return {
    source: points[0]!,
    target: points.at(-1)!,
    points,
    path: roundedCablePath(points),
    hitPath: outsideCableHitPath(points, document.elements),
  };
}
