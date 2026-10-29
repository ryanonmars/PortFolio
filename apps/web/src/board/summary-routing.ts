import type { BoardElement } from '../../../../packages/shared/src/board.js';
import type { Point, Rect } from './geometry.js';

const clearance = 16;
const epsilon = 0.001;
type Anchor = { point: Point; stub: Point };
export type SummaryArrow = { points: Point[]; path: string; arrow: string };
const middle = (rect: Rect): Point => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
const inflate = (rect: Rect, spacing: number): Rect => ({
  x: rect.x - spacing,
  y: rect.y - spacing,
  width: rect.width + spacing * 2,
  height: rect.height + spacing * 2,
});
function anchor(
  rect: Rect,
  toward: Point,
  spacing: number,
  obstacles: Rect[],
  fallbackSides = false,
): Anchor | null {
  const x = Math.max(rect.x + 12, Math.min(rect.x + rect.width - 12, toward.x));
  const y = Math.max(
    rect.y + 12,
    Math.min(rect.y + rect.height - 12, toward.y),
  );
  const candidates = [
    { point: { x: rect.x, y }, dx: -1, dy: 0 },
    { point: { x: rect.x + rect.width, y }, dx: 1, dy: 0 },
    { point: { x, y: rect.y }, dx: 0, dy: -1 },
    { point: { x, y: rect.y + rect.height }, dx: 0, dy: 1 },
  ];
  const distance = (point: Point) =>
    (point.x - toward.x) ** 2 + (point.y - toward.y) ** 2;
  candidates.sort((a, b) => distance(a.point) - distance(b.point));
  for (const { point, dx, dy } of fallbackSides
    ? candidates
    : candidates.slice(0, 1)) {
    const coordinates = dx
      ? [
          point.y,
          ...obstacles.flatMap((rect) => [rect.y, rect.y + rect.height]),
        ]
      : [
          point.x,
          ...obstacles.flatMap((rect) => [rect.x, rect.x + rect.width]),
        ];
    const result =
      [...new Set(coordinates)]
        .map((value) => {
          const attachment = dx
            ? {
                x: point.x,
                y: Math.max(
                  rect.y + 12,
                  Math.min(rect.y + rect.height - 12, value),
                ),
              }
            : {
                x: Math.max(
                  rect.x + 12,
                  Math.min(rect.x + rect.width - 12, value),
                ),
                y: point.y,
              };
          return {
            point: attachment,
            stub: {
              x: attachment.x + dx * spacing,
              y: attachment.y + dy * spacing,
            },
          };
        })
        .sort((a, b) => distance(a.point) - distance(b.point))
        .find(({ point, stub }) => clearSegment(point, stub, obstacles)) ??
      null;
    if (result) return result;
  }
  return null;
}
function clearSegment(a: Point, b: Point, obstacles: Rect[]): boolean {
  if (a.x === b.x) {
    const low = Math.min(a.y, b.y),
      high = Math.max(a.y, b.y);
    return !obstacles.some(
      (rect) =>
        a.x > rect.x + epsilon &&
        a.x < rect.x + rect.width - epsilon &&
        high > rect.y + epsilon &&
        low < rect.y + rect.height - epsilon,
    );
  }
  if (a.y === b.y) {
    const low = Math.min(a.x, b.x),
      high = Math.max(a.x, b.x);
    return !obstacles.some(
      (rect) =>
        a.y > rect.y + epsilon &&
        a.y < rect.y + rect.height - epsilon &&
        high > rect.x + epsilon &&
        low < rect.x + rect.width - epsilon,
    );
  }
  return false;
}
function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result.at(-1),
      before = result.at(-2);
    if (previous?.x === point.x && previous.y === point.y) continue;
    if (
      before &&
      previous &&
      ((before.x === previous.x && previous.x === point.x) ||
        (before.y === previous.y && previous.y === point.y))
    )
      result.pop();
    result.push(point);
  }
  return result;
}

type Step = { index: number; cost: number; score: number; sequence: number };
/** Small stable priority queue, keeping the routing search independent of board size. */
class Queue {
  private values: Step[] = [];
  private less(a: Step, b: Step) {
    return (
      a.score < b.score || (a.score === b.score && a.sequence < b.sequence)
    );
  }
  push(step: Step) {
    this.values.push(step);
    let index = this.values.length - 1;
    while (index) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.less(step, this.values[parent]!)) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = step;
  }
  pop(): Step | undefined {
    const first = this.values[0],
      last = this.values.pop();
    if (!this.values.length || !last) return first;
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.values.length &&
        this.less(this.values[child + 1]!, this.values[child]!)
      )
        child++;
      if (!this.less(this.values[child]!, last)) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function detour(start: Point, end: Point, obstacles: Rect[]): Point[] | null {
  // Fast path: ordinary unobstructed layouts do not create a search graph.
  for (const turn of [
    { x: end.x, y: start.y },
    { x: start.x, y: end.y },
  ])
    if (
      clearSegment(start, turn, obstacles) &&
      clearSegment(turn, end, obstacles)
    )
      return [start, turn, end];
  // Search only visited intersections of obstacle-edge coordinates. No viewport
  // raster, all-pairs edges or full Cartesian grid is allocated.
  const xs = [
    ...new Set([
      start.x,
      end.x,
      ...obstacles.flatMap((rect) => [rect.x, rect.x + rect.width]),
    ]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([
      start.y,
      end.y,
      ...obstacles.flatMap((rect) => [rect.y, rect.y + rect.height]),
    ]),
  ].sort((a, b) => a - b);
  const point = (index: number): Point => ({
    x: xs[index % xs.length]!,
    y: ys[Math.floor(index / xs.length)]!,
  });
  const index = (p: Point) => ys.indexOf(p.y) * xs.length + xs.indexOf(p.x);
  const first = index(start),
    last = index(end);
  const distance = (a: Point, b: Point) =>
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const queue = new Queue();
  const costs = new Map<number, number>([[first, 0]]);
  const previous = new Map<number, number>();
  let sequence = 0;
  queue.push({
    index: first,
    cost: 0,
    score: distance(start, end),
    sequence: sequence++,
  });
  for (let step = queue.pop(); step; step = queue.pop()) {
    if (step.cost !== costs.get(step.index)) continue;
    if (step.index === last) {
      const route = [end];
      let current = last;
      while (current !== first) {
        current = previous.get(current)!;
        route.push(point(current));
      }
      return route.reverse();
    }
    const from = point(step.index),
      column = step.index % xs.length,
      row = Math.floor(step.index / xs.length);
    const neighbors = [
      column > 0 ? step.index - 1 : -1,
      column + 1 < xs.length ? step.index + 1 : -1,
      row > 0 ? step.index - xs.length : -1,
      row + 1 < ys.length ? step.index + xs.length : -1,
    ];
    for (const next of neighbors) {
      if (next < 0) continue;
      const to = point(next),
        cost = step.cost + distance(from, to);
      if (
        cost >= (costs.get(next) ?? Infinity) ||
        !clearSegment(from, to, obstacles)
      )
        continue;
      costs.set(next, cost);
      previous.set(next, step.index);
      queue.push({
        index: next,
        cost,
        score: cost + distance(to, end),
        sequence: sequence++,
      });
    }
  }
  return null;
}

/** Derived world-space geometry; never writes positions or changes cable routing. */
export function routeSummaryArrow(
  summary: BoardElement,
  target: BoardElement,
  elements: readonly BoardElement[],
): SummaryArrow | null {
  if (summary.id === target.id || overlaps(summary, target)) return null;
  const others = elements.filter(
    (element) => element.id !== summary.id && element.id !== target.id,
  );
  const gapX = Math.max(
    0,
    summary.x - target.x - target.width,
    target.x - summary.x - summary.width,
  );
  const gapY = Math.max(
    0,
    summary.y - target.y - target.height,
    target.y - summary.y - summary.height,
  );
  const spacing = Math.min(clearance, Math.hypot(gapX, gapY) / 3);
  if (spacing < epsilon) return null;
  const padded = (rect: Rect) => inflate(rect, spacing);
  const source = anchor(
    summary,
    middle(target),
    spacing,
    [target, ...others].map(padded),
    true,
  );
  const destination = anchor(
    target,
    middle(summary),
    spacing,
    [summary, ...others].map(padded),
  );
  if (!source || !destination) return null;
  const route = detour(
    source.stub,
    destination.stub,
    [summary, target, ...others].map(padded),
  );
  if (!route) return null;
  const points = simplify([source.point, ...route, destination.point]);
  const tip = points.at(-1)!,
    before = points.at(-2)!;
  const dx = Math.sign(tip.x - before.x),
    dy = Math.sign(tip.y - before.y);
  const head = Math.min(
    10,
    (Math.abs(tip.x - before.x) + Math.abs(tip.y - before.y)) * 0.7,
  );
  return {
    points,
    path: points
      .map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`)
      .join(' '),
    arrow: `M ${tip.x - dx * head - (dy * head) / 2} ${tip.y - dy * head + (dx * head) / 2} L ${tip.x} ${tip.y} L ${tip.x - dx * head + (dy * head) / 2} ${tip.y - dy * head - (dx * head) / 2}`,
  };
}
