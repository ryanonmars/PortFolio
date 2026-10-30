import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  annotationEndpoints,
  annotationKinds,
  annotationPresentation,
  isAnnotation,
  makeAnnotation,
  setArrowEndpoints,
  snapArrowEndpoint,
} from './annotations.js';
import { BoardAnnotation } from './BoardAnnotation.js';
import { AnnotationInspector } from './AnnotationInspector.js';

describe('annotation presentation and geometry', () => {
  it.each(annotationKinds)(
    'creates a standalone %s with sensible safe defaults',
    (kind) => {
      const element = makeAnnotation(kind, 24, -40);
      expect(element.type).toBe(kind);
      expect(element.id).toBeTruthy();
      expect(element).toMatchObject({ x: 24, y: -40 });
      expect(isAnnotation(element)).toBe(true);
      expect(element.width).toBeGreaterThanOrEqual(16);
      expect(element.height).toBeGreaterThanOrEqual(16);
      expect(element.properties).not.toHaveProperty('deviceId');
      expect(element.properties).not.toHaveProperty('sourcePortId');
      expect(element.properties).not.toHaveProperty('linkedDeviceId');
    },
  );

  it('places highlights behind ordinary annotation defaults without dimming text', () => {
    const element = makeAnnotation('highlight', 0, 0);
    expect(element.z).toBeLessThan(makeAnnotation('text', 0, 0).z);
    expect(annotationPresentation(element)).toMatchObject({
      fillColor: '#4a9b6b',
      fillOpacity: 0.16,
      textColor: '#dce8e0',
    });
    const markup = renderToStaticMarkup(
      createElement(BoardAnnotation, { element }),
    );
    expect(markup).toContain('fill-opacity="0.16"');
    expect(markup).not.toContain('opacity:0.16');
  });

  it('does not confuse equipment with annotations', () => {
    expect(
      isAnnotation({ ...makeAnnotation('text', 0, 0), type: 'device' }),
    ).toBe(false);
  });

  it('bounds dimensions and positions rather than producing invalid geometry', () => {
    const element = makeAnnotation('rectangle', Infinity, -200000, 0, 50000);
    expect(element).toMatchObject({
      x: 0,
      y: -100000,
      width: 16,
      height: 20000,
    });
  });

  it('normalizes malformed visual properties without changing saved values', () => {
    const element = makeAnnotation('text', 0, 0);
    element.properties = {
      text: '<script>authored text</script>',
      fontSize: 1000,
      textColor: 'url(javascript:alert(1))',
      backgroundColor: '#224466',
      align: 'justify',
      fillOpacity: -5,
      strokeWidth: Infinity,
      startX: -2,
      endY: 9,
    };
    const before = structuredClone(element);
    expect(annotationPresentation(element)).toMatchObject({
      text: '<script>authored text</script>',
      fontSize: 120,
      textColor: '#dce8e0',
      backgroundColor: '#224466',
      align: 'left',
      fillOpacity: 0,
      strokeWidth: 1,
      startX: 0,
      endY: 1,
    });
    expect(element).toEqual(before);
  });

  it('preserves empty colors and zero-valued authored settings', () => {
    const element = makeAnnotation('rectangle', 0, 0);
    element.properties = {
      fillColor: '',
      fillOpacity: 0,
      strokeWidth: 0,
      cornerRadius: 0,
      backgroundColor: '',
    };
    expect(annotationPresentation(element)).toMatchObject({
      fillColor: '',
      fillOpacity: 0,
      strokeWidth: 0,
      cornerRadius: 0,
      backgroundColor: '',
    });
  });

  it('maps normalized endpoints through the current object position and dimensions', () => {
    const arrow = makeAnnotation('arrow', -20, 40, 240, 80);
    expect(annotationEndpoints(arrow)).toEqual({
      start: { x: -20, y: 80 },
      end: { x: 220, y: 80 },
    });
    expect(annotationEndpoints({ ...arrow, x: 100, width: 480 })).toEqual({
      start: { x: 100, y: 80 },
      end: { x: 580, y: 80 },
    });
  });

  it.each([
    [
      { x: 10, y: 20 },
      { x: 200, y: 100 },
    ],
    [
      { x: 200, y: 100 },
      { x: 10, y: 20 },
    ],
    [
      { x: 10, y: 100 },
      { x: 200, y: 20 },
    ],
    [
      { x: 200, y: 20 },
      { x: 10, y: 100 },
    ],
    [
      { x: -20, y: -40 },
      { x: -20, y: 100 },
    ],
    [
      { x: -20, y: -40 },
      { x: 200, y: -40 },
    ],
    [
      { x: 14, y: 14 },
      { x: 14, y: 14 },
    ],
  ])(
    'preserves endpoint directions and arbitrary positions %#',
    (start, end) => {
      const arrow = makeAnnotation('arrow', 0, 0);
      arrow.name = 'Authored label';
      arrow.properties.custom = 'retained';
      const before = structuredClone(arrow);
      const next = setArrowEndpoints(arrow, start, end);
      expect(annotationEndpoints(next)).toEqual({ start, end });
      expect(next.id).toBe(arrow.id);
      expect(next.name).toBe('Authored label');
      expect(next.properties.custom).toBe('retained');
      expect(next.width).toBeGreaterThanOrEqual(16);
      expect(next.height).toBeGreaterThanOrEqual(16);
      expect(arrow).toEqual(before);
    },
  );

  it('clamps endpoint edits to supported bounds and keeps coordinates finite', () => {
    const arrow = makeAnnotation('arrow', 0, 0);
    const next = setArrowEndpoints(
      arrow,
      { x: -200000, y: NaN },
      { x: 200000, y: Infinity },
    );
    expect(next.width).toBeLessThanOrEqual(20000);
    expect(next.height).toBeGreaterThanOrEqual(16);
    expect(next.x).toBeGreaterThanOrEqual(-100000);
    expect(next.x).toBeLessThanOrEqual(100000);
    const points = annotationEndpoints(next);
    for (const point of [points.start, points.end]) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it('does not apply arrow geometry changes to a rectangle', () => {
    const rectangle = makeAnnotation('rectangle', 0, 0);
    expect(
      setArrowEndpoints(rectangle, { x: 10, y: 20 }, { x: 50, y: 60 }),
    ).toBe(rectangle);
  });

  it('renders freeform multiline text as escaped content, never executable HTML', () => {
    const element = makeAnnotation('text', 0, 0);
    element.properties.text = '<img src=x onerror="alert(1)">\nSecond line';
    const markup = renderToStaticMarkup(
      createElement(BoardAnnotation, { element }),
    );
    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('Second line');
  });

  it('uses native SVG line and arrowhead primitives and safely escapes the label', () => {
    const element = makeAnnotation('arrow', 20, 40);
    element.name = '<script>alert(1)</script>';
    const markup = renderToStaticMarkup(
      createElement(BoardAnnotation, { element }),
    );
    expect(markup).toContain('<line');
    expect(markup).toContain('<polygon');
    expect(markup).not.toContain('<marker');
    expect(markup).not.toContain('<script');
    expect(markup).toContain('&lt;script&gt;');
    element.properties.arrowhead = false;
    expect(
      renderToStaticMarkup(createElement(BoardAnnotation, { element })),
    ).not.toContain('<polygon');
  });

  it.each(annotationKinds)(
    'exposes only relevant %s inspector controls',
    (kind) => {
      const element = makeAnnotation(kind, 0, 0);
      const markup = renderToStaticMarkup(
        createElement(AnnotationInspector, { element, onChange: () => {} }),
      );
      expect(markup).not.toContain('Device type');
      expect(markup).not.toContain('VLAN');
      if (kind === 'text') {
        expect(markup).toContain('Font size');
        expect(markup).toContain('Alignment');
        expect(markup).not.toContain('Line width');
      } else if (kind === 'arrow') {
        expect(markup).toContain('Arrowhead');
        expect(markup).toContain('Line width');
        expect(markup).not.toContain('Fill opacity');
      } else {
        expect(markup).toContain('Border width');
        expect(markup).not.toContain('Font size');
      }
    },
  );
});

describe('arrow axis alignment', () => {
  it.each([
    [
      { x: 83.25, y: 91.5 },
      { x: 86, y: 1292 },
      { x: 83.25, y: 1292 },
    ],
    [
      { x: 83.25, y: 91.5 },
      { x: 72, y: -1100 },
      { x: 83.25, y: -1100 },
    ],
    [
      { x: -23.5, y: 12.25 },
      { x: 1800, y: 50 },
      { x: 1800, y: 12.25 },
    ],
    [
      { x: -23.5, y: 12.25 },
      { x: -1800, y: -20 },
      { x: -1800, y: 12.25 },
    ],
  ])(
    'aligns long arrows to the exact off-grid anchor %#',
    (anchor, point, expected) => {
      const before = structuredClone({ anchor, point });
      const snapped = snapArrowEndpoint(anchor, point, 1);
      expect(snapped).toEqual(expected);
      const arrow = setArrowEndpoints(
        makeAnnotation('arrow', 0, 0),
        anchor,
        snapped,
      );
      expect(annotationEndpoints(arrow)).toEqual({
        start: anchor,
        end: expected,
      });
      expect({ anchor, point }).toEqual(before);
    },
  );

  it.each([0.1, 0.35, 1, 2, 4])(
    'keeps the same screen-space tolerance at zoom %s',
    (zoom) => {
      const anchor = { x: 37.25, y: -18.5 };
      expect(
        snapArrowEndpoint(
          anchor,
          { x: anchor.x + 7 / zoom, y: anchor.y + 40 / zoom },
          zoom,
        ),
      ).toEqual({ x: anchor.x, y: anchor.y + 40 / zoom });
      const diagonal = { x: anchor.x + 12 / zoom, y: anchor.y + 40 / zoom };
      expect(snapArrowEndpoint(anchor, diagonal, zoom)).toEqual(diagonal);
    },
  );

  it('locks to the nearest axis with Shift and lets Alt preserve free angles', () => {
    const anchor = { x: 13.5, y: 22.25 };
    expect(
      snapArrowEndpoint(anchor, { x: 100, y: 900 }, 1, { constrain: true }),
    ).toEqual({ x: anchor.x, y: 900 });
    expect(
      snapArrowEndpoint(anchor, { x: -900, y: 100 }, 1, { constrain: true }),
    ).toEqual({ x: -900, y: anchor.y });
    const nearVertical = { x: 15, y: 900 };
    expect(
      snapArrowEndpoint(anchor, nearVertical, 1, { bypass: true }),
    ).toEqual(nearVertical);
    const diagonal = { x: 500, y: 600 };
    expect(snapArrowEndpoint(anchor, diagonal, 1)).toEqual(diagonal);
  });

  it('realigns either moving endpoint without moving the stationary endpoint or changing styling', () => {
    const original = makeAnnotation('arrow', 20, 40);
    original.properties.strokeColor = '#ff6633';
    original.properties.strokeWidth = 7;
    const fixed = { x: 63.5, y: 1024.25 };
    const moved = snapArrowEndpoint(fixed, { x: 68, y: 70 }, 1);
    const arrow = setArrowEndpoints(original, moved, fixed);
    expect(annotationEndpoints(arrow)).toEqual({
      start: { x: fixed.x, y: 70 },
      end: fixed,
    });
    expect(arrow.properties.strokeColor).toBe('#ff6633');
    expect(arrow.properties.strokeWidth).toBe(7);
  });
});
