import { describe, expect, it } from 'vitest';
import type { BoardElement } from '../../../../packages/shared/src/board.js';
import { routeSummaryArrow, type SummaryArrow } from './summary-routing.js';

const element = (
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 200,
): BoardElement => ({
  id,
  type: id === 'summary' ? 'summary' : 'device',
  x,
  y,
  width,
  height,
  z: 0,
  color: '#ff0000',
  name: id,
  properties: {},
});
function avoids(route: SummaryArrow, elements: BoardElement[]) {
  for (let index = 1; index < route.points.length; index++) {
    const a = route.points[index - 1]!,
      b = route.points[index]!;
    expect(a.x === b.x || a.y === b.y).toBe(true);
    for (const rect of elements) {
      const enters =
        a.x === b.x
          ? a.x > rect.x &&
            a.x < rect.x + rect.width &&
            Math.max(a.y, b.y) > rect.y &&
            Math.min(a.y, b.y) < rect.y + rect.height
          : a.y > rect.y &&
            a.y < rect.y + rect.height &&
            Math.max(a.x, b.x) > rect.x &&
            Math.min(a.x, b.x) < rect.x + rect.width;
      expect(enters).toBe(false);
    }
  }
}
describe('summary link routing', () => {
  it.each([
    [600, 0, { x: 600, y: 100 }],
    [-600, 0, { x: -400, y: 100 }],
    [0, 600, { x: 100, y: 600 }],
    [0, -600, { x: 100, y: -400 }],
  ])('attaches to the nearest target edge at %s,%s', (x, y, tip) => {
    const summary = element('summary', 0, 0),
      target = element('target', x, y);
    const route = routeSummaryArrow(summary, target, [summary, target])!;
    expect(route.points.at(-1)).toEqual(tip);
    expect(route.points).toHaveLength(2);
    expect(route.arrow).toContain(`L ${tip.x} ${tip.y}`);
    avoids(route, [summary, target]);
  });
  it('routes around a blocking container with clearance rather than crossing its text', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 700, 0),
      blocker = element('blocker', 300, -80, 180, 360);
    const elements = [summary, target, blocker];
    const route = routeSummaryArrow(summary, target, elements)!;
    expect(route.points.some((point) => point.y <= -96 || point.y >= 296)).toBe(
      true,
    );
    expect(route.points.at(-1)).toEqual({ x: 700, y: 100 });
    avoids(route, elements);
  });
  it('handles diagonal placement and multiple staggered blockers', () => {
    const summary = element('summary', -500, -350),
      target = element('target', 700, 550);
    const elements = [
      summary,
      target,
      element('one', -100, -400, 200, 700),
      element('two', 250, 100, 200, 650),
      element('three', 550, -500, 200, 700),
    ];
    const route = routeSummaryArrow(summary, target, elements)!;
    expect(route).not.toBeNull();
    avoids(route, elements);
    expect(route).toEqual(
      routeSummaryArrow(summary, target, [...elements].reverse()),
    );
  });
  it('adapts clearance and arrowhead to containers eight pixels apart', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 208, 0);
    const route = routeSummaryArrow(summary, target, [summary, target])!;
    expect(route.points).toEqual([
      { x: 200, y: 100 },
      { x: 208, y: 100 },
    ]);
    avoids(route, [summary, target]);
  });
  it('shifts attachment along the same facing side when a nearby obstacle blocks its center', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 600, 0),
      blocker = element('blocker', 205, 70, 100, 60);
    const route = routeSummaryArrow(summary, target, [
      summary,
      target,
      blocker,
    ])!;
    expect(route).not.toBeNull();
    expect(route.points[0]!.x).toBe(200);
    expect(route.points[0]!.y === 54 || route.points[0]!.y === 146).toBe(true);
    expect(route.points.at(-1)!.x).toBe(600);
    avoids(route, [summary, target, blocker]);
  });
  it('shifts the target anchor without changing the closest target side', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 600, 0),
      blocker = element('blocker', 495, 70, 100, 60);
    const route = routeSummaryArrow(summary, target, [
      summary,
      target,
      blocker,
    ])!;
    expect(route).not.toBeNull();
    expect(route.points.at(-1)!.x).toBe(600);
    expect(
      route.points.at(-1)!.y === 54 || route.points.at(-1)!.y === 146,
    ).toBe(true);
    avoids(route, [summary, target, blocker]);
  });
  it('derives new geometry after moving and resizing without mutating saved elements', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 600, 0);
    const original = JSON.stringify([summary, target]);
    const first = routeSummaryArrow(summary, target, [summary, target]);
    const moved = { ...target, x: -800, y: 100, width: 350 };
    const second = routeSummaryArrow(summary, moved, [summary, moved])!;
    expect(first).not.toEqual(second);
    expect(second.points.at(-1)!.x).toBe(-450);
    expect(JSON.stringify([summary, target])).toBe(original);
    avoids(second, [summary, moved]);
  });
  it('omits overlapping, touching, identical or completely occluded endpoints', () => {
    const summary = element('summary', 0, 0);
    for (const target of [
      summary,
      element('target', 100, 100),
      element('target', 200, 0),
    ])
      expect(routeSummaryArrow(summary, target, [summary, target])).toBeNull();
    const target = element('target', 600, 0),
      cover = element('cover', -40, -40, 280, 280);
    expect(
      routeSummaryArrow(summary, target, [summary, target, cover]),
    ).toBeNull();
  });
  it('uses another source side when its entire facing edge is blocked', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 600, 0),
      blocker = element('blocker', 205, -40, 100, 280);
    const route = routeSummaryArrow(summary, target, [
      summary,
      target,
      blocker,
    ])!;
    expect(route).not.toBeNull();
    expect(
      route.points[0]!.x !== 200 ||
        route.points[0]!.y === 0 ||
        route.points[0]!.y === 200,
    ).toBe(true);
    expect(route.points.at(-1)!.x).toBe(600);
    avoids(route, [summary, target, blocker]);
  });
  it('routes a maximum-size board without allocating a full obstacle grid', () => {
    const summary = element('summary', 0, 0),
      target = element('target', 600, 0);
    const elements = [
      summary,
      target,
      element('blocker', 300, -80, 160, 360),
      ...Array.from({ length: 253 }, (_, index) =>
        element(`far-${index}`, 2000 + index * 201, 2000 + index * 203),
      ),
    ];
    const route = routeSummaryArrow(summary, target, elements)!;
    expect(route).not.toBeNull();
    avoids(route, elements);
  });
});
