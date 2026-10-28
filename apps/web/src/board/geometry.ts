import {
  minimumBoardDeviceSize,
  boardPortLayout,
  boardPortGap,
  type BoardDocument,
  BoardElement,
  BoardPort,
  BoardViewport,
} from '../../../../packages/shared/src/board.js';

export const PORT_WIDTH = boardPortLayout.width;
export const PORT_HEIGHT = boardPortLayout.height;
export const PORT_GAP = 8;
export const DEVICE_PADDING = boardPortLayout.padding;
export const DEVICE_HEADER = boardPortLayout.header;
export const GRID_SIZE = 8;
export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Guide = { axis: 'x' | 'y'; value: number };
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export function activeFace(element: BoardElement): BoardPort['face'] {
  return element.properties.face === 'rear' ? 'rear' : 'front';
}
export const portGap = boardPortGap;
export function portRect(
  element: BoardElement,
  port: Pick<BoardPort, 'row' | 'column'>,
): Rect {
  const gap = portGap(element);
  return {
    x: element.x + DEVICE_PADDING + port.column * (PORT_WIDTH + gap),
    y:
      element.y +
      DEVICE_HEADER +
      DEVICE_PADDING +
      port.row * (PORT_HEIGHT + gap),
    width: PORT_WIDTH,
    height: PORT_HEIGHT,
  };
}
export function minimumDeviceSize(
  element: BoardElement,
  ports: BoardPort[],
): { width: number; height: number } {
  return element.type === 'device'
    ? minimumBoardDeviceSize(element, ports)
    : { width: 160, height: 120 };
}
export function getPortPoint(
  document: BoardDocument,
  portId: string,
): Point | null {
  const port = document.ports.find((port) => port.id === portId);
  if (!port) return null;
  const element = document.elements.find(
    (element) => element.id === port.deviceId,
  );
  if (!element || activeFace(element) !== port.face) return null;
  const rect = portRect(element, port);
  return { x: rect.x + PORT_WIDTH / 2, y: rect.y + (PORT_WIDTH * 50) / 120 };
}
export function fitViewport(
  document: BoardDocument,
  width: number,
  height: number,
): BoardViewport {
  if (!document.elements.length) return { x: 80, y: 80, zoom: 1 };
  const left = Math.min(...document.elements.map((element) => element.x));
  const top = Math.min(...document.elements.map((element) => element.y));
  const right = Math.max(
    ...document.elements.map((element) => element.x + element.width),
  );
  const bottom = Math.max(
    ...document.elements.map((element) => element.y + element.height),
  );
  const zoom = clamp(
    Math.min(
      Math.max(1, width - 96) / (right - left),
      Math.max(1, height - 96) / (bottom - top),
    ),
    0.1,
    1.5,
  );
  return {
    x: clamp(width / 2 - ((left + right) / 2) * zoom, -100000, 100000),
    y: clamp(height / 2 - ((top + bottom) / 2) * zoom, -100000, 100000),
    zoom,
  };
}
export function screenToWorld(point: Point, viewport: BoardViewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}
export function zoomViewport(
  viewport: BoardViewport,
  point: Point,
  nextZoom: number,
): BoardViewport {
  const world = screenToWorld(point, viewport);
  const zoom = clamp(nextZoom, 0.1, 4);
  return {
    zoom,
    x: clamp(point.x - world.x * zoom, -100000, 100000),
    y: clamp(point.y - world.y * zoom, -100000, 100000),
  };
}
export function snapRect(
  rect: Rect,
  others: Rect[],
  zoom: number,
  bypass = false,
): { rect: Rect; guides: Guide[] } {
  if (bypass) return { rect, guides: [] };
  const threshold = 6 / zoom;
  let x = rect.x,
    y = rect.y;
  const guides: Guide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const value = rect[axis];
    let best = Math.round(value / GRID_SIZE) * GRID_SIZE;
    let distance = threshold;
    let guide: number | null = null;
    if (Math.abs(best - value) > threshold) {
      best = value;
      distance = threshold;
    }
    for (const other of others) {
      const anchors = [
        other[axis],
        other[axis] + other[size] / 2,
        other[axis] + other[size],
      ];
      for (const anchor of anchors)
        for (const offset of [0, rect[size] / 2, rect[size]]) {
          const candidate = anchor - offset;
          const delta = Math.abs(candidate - value);
          if (delta <= distance) {
            best = candidate;
            distance = delta;
            guide = anchor;
          }
        }
      for (const candidate of [
        other[axis] + other[size] + 24,
        other[axis] - rect[size] - 24,
      ]) {
        const delta = Math.abs(candidate - value);
        if (delta < distance) {
          best = candidate;
          distance = delta;
          guide = null;
        }
      }
    }
    if (axis === 'x') x = clamp(best, -100000, 100000);
    else y = clamp(best, -100000, 100000);
    if (guide !== null) guides.push({ axis, value: guide });
  }
  return { rect: { ...rect, x, y }, guides };
}
export function resizeRect(
  rect: Rect,
  handle: string,
  delta: Point,
  minimum: { width: number; height: number },
  bypass = false,
): Rect {
  let left = rect.x,
    top = rect.y,
    right = rect.x + rect.width,
    bottom = rect.y + rect.height;
  const snap = (value: number) =>
    bypass ? value : Math.round(value / GRID_SIZE) * GRID_SIZE;
  if (handle.includes('e'))
    right = Math.max(left + minimum.width, snap(right + delta.x));
  if (handle.includes('s'))
    bottom = Math.max(top + minimum.height, snap(bottom + delta.y));
  if (handle.includes('w'))
    left = Math.min(right - minimum.width, snap(left + delta.x));
  if (handle.includes('n'))
    top = Math.min(bottom - minimum.height, snap(top + delta.y));
  return {
    x: clamp(left, -100000, 100000),
    y: clamp(top, -100000, 100000),
    width: clamp(right - left, minimum.width, 20000),
    height: clamp(bottom - top, minimum.height, 20000),
  };
}
export function cableCurve(a: Point, b: Point): string {
  const bend = Math.max(48, Math.abs(b.x - a.x) * 0.45);
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

/** Keep pointer targets in the open board, away from equipment controls. */
export function cableHitPath(a: Point, b: Point, elements: Rect[]): string {
  const bend = Math.max(48, Math.abs(b.x - a.x) * 0.45);
  const blockers = elements.filter(
    (rect) =>
      rect.x <= Math.max(a.x + bend, b.x) &&
      rect.x + rect.width >= Math.min(a.x, b.x - bend) &&
      rect.y <= Math.max(a.y, b.y) &&
      rect.y + rect.height >= Math.min(a.y, b.y),
  );
  let path = '';
  let drawing = false;
  let previous: Point | null = null;
  for (let step = 0; step <= 40; step++) {
    const t = step / 40,
      u = 1 - t;
    const point = {
      x:
        u * u * u * a.x +
        3 * u * u * t * (a.x + bend) +
        3 * u * t * t * (b.x - bend) +
        t * t * t * b.x,
      y:
        u * u * u * a.y +
        3 * u * u * t * a.y +
        3 * u * t * t * b.y +
        t * t * t * b.y,
    };
    const inside = blockers.some(
      (rect) =>
        point.x >= rect.x - 7 &&
        point.x <= rect.x + rect.width + 7 &&
        point.y >= rect.y - 7 &&
        point.y <= rect.y + rect.height + 7,
    );
    if (inside) {
      drawing = false;
      previous = null;
      continue;
    }
    // Both sample endpoints must be clear, so no segment enters a control.
    if (previous) {
      path += `${drawing ? ' L' : ' M'} ${previous.x} ${previous.y} L ${point.x} ${point.y}`;
      drawing = true;
    }
    previous = point;
  }
  return path;
}
