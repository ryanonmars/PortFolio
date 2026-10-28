import type { BoardDocument } from '../../../../packages/shared/src/board.js';
import {
  activeFace,
  DEVICE_HEADER,
  portRect,
  type Point,
  type Rect,
} from './geometry.js';

export type CableProtectedRegion = Rect & {
  kind: 'header' | 'label' | 'panel' | 'control';
  objectId: string;
};

/** Foreground readability layer, shared by the canvas and clean SVG export. */
export function cableProtectedRegions(
  document: BoardDocument,
): CableProtectedRegion[] {
  const regions: CableProtectedRegion[] = [];
  for (const element of document.elements) {
    if (element.type === 'network') {
      regions.push({
        x: element.x - 8,
        y: element.y - 8,
        width: element.width + 16,
        height: element.height + 16,
        kind: 'panel',
        objectId: element.id,
      });
      continue;
    }
    regions.push({
      x: element.x - 4,
      y: element.y - 4,
      width: element.width + 8,
      height: DEVICE_HEADER + 8,
      kind: 'header',
      objectId: element.id,
    });
    for (const port of document.ports.filter(
      (port) =>
        port.deviceId === element.id && port.face === activeFace(element),
    )) {
      const rect = portRect(element, port);
      regions.push({
        x: rect.x - 2,
        y: rect.y + 58,
        width: rect.width + 4,
        height: 38,
        kind: 'label',
        objectId: port.id,
      });
    }
    for (const [x, y] of [
      [element.x, element.y],
      [element.x + element.width / 2, element.y],
      [element.x + element.width, element.y],
      [element.x, element.y + element.height / 2],
      [element.x + element.width, element.y + element.height / 2],
      [element.x, element.y + element.height],
      [element.x + element.width / 2, element.y + element.height],
      [element.x + element.width, element.y + element.height],
    ])
      regions.push({
        x: x! - 8,
        y: y! - 8,
        width: 16,
        height: 16,
        kind: 'control',
        objectId: element.id,
      });
  }
  return regions;
}

export function cablePaintBounds(
  document: BoardDocument,
  points: Point[],
): Rect {
  let left = 0,
    top = 0,
    right = 100,
    bottom = 100;
  for (const item of document.elements) {
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + item.width);
    bottom = Math.max(bottom, item.y + item.height);
  }
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return {
    x: left - 32,
    y: top - 32,
    width: right - left + 64,
    height: bottom - top + 64,
  };
}

/** Wide touch targets may overlap at low zoom: resolve against the nearest line. */
export function nearestCableAtPoint(
  routes: { cable: { id: string }; route: { points: Point[] } | null }[],
  point: Point,
  fallback: string,
): string {
  function distance(points: Point[]) {
    let best = Infinity;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1]!,
        b = points[index]!;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const t = length
        ? Math.max(
            0,
            Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length),
          )
        : 0;
      best = Math.min(
        best,
        (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2,
      );
    }
    return best;
  }
  let selected = fallback;
  let best = distance(
    routes.find((item) => item.cable.id === fallback)?.route?.points ?? [],
  );
  for (const { cable, route } of routes)
    if (route) {
      const next = distance(route.points);
      if (next < best - 0.001) {
        best = next;
        selected = cable.id;
      }
    }
  return selected;
}
