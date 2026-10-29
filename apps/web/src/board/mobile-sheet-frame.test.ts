import { describe, expect, it } from 'vitest';
import { mobileSheetFrame } from './mobile-sheet-frame.js';

describe('mobile inspector usable frame', () => {
  it('keeps the normal half-height sheet below the app header', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 800 }, 56, 448, false, 800),
    ).toEqual({ top: 352, height: 448, constrained: false, emergency: false });
  });
  it('limits normal expansion to the available space below navigation', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 338 }, 56, 338 * 0.94, false, 338),
    ).toEqual({ top: 56, height: 282, constrained: false, emergency: false });
  });
  it('temporarily prioritizes editing over navigation in a constrained viewport', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 140 }, 56, 140, true, 338),
    ).toEqual({ top: 0, height: 140, constrained: true, emergency: false });
  });
  it('retains a readable focus row for the real Safari 14px rotation report', () => {
    expect(mobileSheetFrame({ top: 0, height: 14 }, 56, 14, true, 338)).toEqual(
      { top: 0, height: 56, constrained: true, emergency: true },
    );
  });
  it('never moves the emergency frame to a stale bottom anchor', () => {
    const frame = mobileSheetFrame(
      { top: 330, height: 14 },
      386,
      200,
      true,
      338,
    );
    expect(frame.top).toBe(330);
    expect(frame.height).toBe(56);
  });
  it('uses usable reported height without restricting it to 94 percent', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 80 }, 56, 80, true, 338).height,
    ).toBe(80);
  });
  it('bounds fallback dimensions to the layout height', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 14 }, 56, 14, true, 48).height,
    ).toBe(48);
  });
  it('returns to the normal frame when bounds recover without changing focus', () => {
    const frame = mobileSheetFrame(
      { top: 0, height: 338 },
      56,
      338 * 0.94,
      true,
      338,
    );
    expect(frame).toEqual({
      top: 56,
      height: 282,
      constrained: false,
      emergency: false,
    });
  });
  it('does not invoke the editing fallback when no field is focused', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 14 }, 56, 14, false, 338).emergency,
    ).toBe(false);
  });
  it('uses the focused textarea height before reserving room for navigation', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 174 }, 56, 174, true, 338, 84),
    ).toEqual({ top: 0, height: 174, constrained: true, emergency: false });
  });
  it('keeps an emergency row then recovers the captured textarea dimensions', () => {
    expect(
      mobileSheetFrame({ top: 0, height: 14 }, 56, 14, true, 338, 84).height,
    ).toBe(56);
    expect(
      mobileSheetFrame({ top: 0, height: 384 }, 56, 384 * 0.94, true, 384, 84),
    ).toEqual({ top: 56, height: 328, constrained: false, emergency: false });
  });
  it('bounds oversized authored textarea heights to the layout viewport', () => {
    const frame = mobileSheetFrame(
      { top: 0, height: 384 },
      56,
      384,
      true,
      384,
      5000,
    );
    expect(frame.height).toBeLessThanOrEqual(384);
  });
});
