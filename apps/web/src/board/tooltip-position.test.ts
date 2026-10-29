import { describe, expect, it } from 'vitest';
import { placePortTooltip } from './tooltip-position.js';

describe('port tooltip placement in screen coordinates', () => {
  const viewport = { x: 0, y: 0, width: 1000, height: 800 };
  it('prefers above and keeps a gap from the connector', () => {
    expect(
      placePortTooltip(
        { x: 300, y: 400, width: 64, height: 60 },
        { width: 340, height: 220 },
        viewport,
      ),
    ).toEqual({ x: 162, y: 170, width: 340, maxHeight: 220, side: 'above' });
  });
  it('flips below near the top and above near the bottom', () => {
    expect(
      placePortTooltip(
        { x: 300, y: 10, width: 64, height: 60 },
        { width: 340, height: 220 },
        viewport,
      )?.side,
    ).toBe('below');
    expect(
      placePortTooltip(
        { x: 300, y: 730, width: 64, height: 60 },
        { width: 340, height: 220 },
        viewport,
      )?.side,
    ).toBe('above');
  });
  it.each([0, 320, 950])('clamps horizontal placement at x=%i', (x) => {
    const result = placePortTooltip(
      { x, y: 400, width: 64, height: 60 },
      { width: 340, height: 220 },
      viewport,
    )!;
    expect(result.x).toBeGreaterThanOrEqual(8);
    expect(result.x + result.width).toBeLessThanOrEqual(992);
  });
  it('limits long content to available space without covering the port', () => {
    const result = placePortTooltip(
      { x: 300, y: 400, width: 64, height: 60 },
      { width: 340, height: 4000 },
      viewport,
    )!;
    expect(result.maxHeight).toBe(382);
    expect(result.y + result.maxHeight).toBe(390);
  });
  it('supports narrow and offset visual viewports', () => {
    const result = placePortTooltip(
      { x: 150, y: 260, width: 32, height: 30 },
      { width: 340, height: 120 },
      { x: 30, y: 40, width: 220, height: 400 },
    )!;
    expect(result.width).toBe(204);
    expect(result.x).toBeGreaterThanOrEqual(38);
    expect(result.x + result.width).toBeLessThanOrEqual(242);
    expect(result.y).toBeGreaterThanOrEqual(48);
  });
  it('uses the side in short windows when vertical placement is unreadable', () => {
    const result = placePortTooltip(
      { x: 150, y: 25, width: 64, height: 60 },
      { width: 340, height: 300 },
      { ...viewport, height: 110 },
    )!;
    expect(result.side).toBe('right');
    expect(result.x).toBe(224);
    expect(result.maxHeight).toBe(94);
  });
  it('hides rather than cover the connector when no usable space exists', () => {
    expect(
      placePortTooltip(
        { x: 8, y: 8, width: 180, height: 84 },
        { width: 184, height: 300 },
        { x: 0, y: 0, width: 200, height: 100 },
      ),
    ).toBeNull();
  });
});
