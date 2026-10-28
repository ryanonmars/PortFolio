import { describe, it, expect } from 'vitest';
import { cableColor, cableRoute, socketIsVisible } from './cableGeometry.js';
describe('canonical cable geometry', () => {
  it('anchors both socket edges and routes through a separate gutter', () => {
    expect(
      cableRoute(
        { x: 80, y: 50, escapeY: 30 },
        { x: 300, y: 240, escapeY: 220 },
        8,
      ),
    ).toBe('M 80 50 L 80 30 L 8 30 L 8 220 L 300 220 L 300 240');
  });
  it('does not invent endpoints for clipped or hidden sockets', () => {
    const clip = { left: 20, right: 300, top: 10, bottom: 200 };
    expect(
      socketIsVisible({ left: 30, right: 70, top: 40, bottom: 90 }, clip),
    ).toBe(true);
    expect(
      socketIsVisible({ left: 280, right: 320, top: 40, bottom: 90 }, clip),
    ).toBe(false);
    expect(
      socketIsVisible({ left: 0, right: 0, top: 0, bottom: 0 }, clip),
    ).toBe(false);
  });
  it('uses stable cable identity colors without port or VLAN state', () => {
    expect(cableColor('cable-a')).toBe(cableColor('cable-a'));
    expect(cableColor('cable-a')).not.toBe(cableColor('cable-b'));
  });
});
