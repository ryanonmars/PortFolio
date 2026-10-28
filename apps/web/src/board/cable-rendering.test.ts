import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import { portRect } from './geometry.js';
import {
  cablePaintBounds,
  cableProtectedRegions,
  nearestCableAtPoint,
} from './cable-rendering.js';
import { routeBoardCable } from './cable-routing.js';
import { boardImageSvg } from './image-export.js';

function fixture() {
  const device: BoardElement = {
    id: 'device',
    type: 'device',
    name: 'Router header',
    x: -400,
    y: -200,
    width: 600,
    height: 240,
    z: 0,
    color: '',
    properties: {},
  };
  const peer = { ...device, id: 'peer', name: 'Switch', x: 50, y: 150, z: 1 };
  const ports = [
    makeBoardPort(device.id, 'rj45', 0, 4, 'Router Port 5'),
    makeBoardPort(peer.id, 'sfp_plus', 0, 0, 'Switch Port 1'),
  ];
  ports.push({
    ...makeBoardPort(device.id, 'rj45', 0, 0, 'Rear'),
    face: 'rear',
  });
  const cable = {
    id: 'cable',
    sourcePortId: ports[0]!.id,
    targetPortId: ports[1]!.id,
    name: 'Physical uplink',
    cableType: '',
    sourceConnector: '',
    targetConnector: '',
    color: '#b8c6d0',
    length: '',
    notes: '',
  };
  return {
    ...emptyBoardDocument(),
    elements: [
      device,
      peer,
      {
        ...device,
        id: 'network',
        type: 'network' as const,
        x: -500,
        y: -500,
        height: 140,
      },
    ],
    ports,
    cables: [cable],
  };
}

describe('cable foreground protection and pointer selection', () => {
  it('protects every visible label, header, control and Network panel without mutating records', () => {
    const document = fixture();
    const before = JSON.stringify(document);
    const regions = cableProtectedRegions(document);
    const label = regions.find(
      (region) =>
        region.kind === 'label' && region.objectId === document.ports[0]!.id,
    )!;
    const rect = portRect(document.elements[0]!, document.ports[0]!);
    expect(label.x).toBeLessThan(rect.x);
    expect(label.y).toBeLessThanOrEqual(rect.y + 60);
    expect(label.x + label.width).toBeGreaterThan(rect.x + 64);
    expect(label.y + label.height).toBeGreaterThan(rect.y + 90);
    expect(label.y).toBeGreaterThan(rect.y + (103 * 64) / 120);
    expect(
      regions.some((region) => region.objectId === document.ports[2]!.id),
    ).toBe(false);
    expect(regions.filter((region) => region.kind === 'header')).toHaveLength(
      2,
    );
    expect(regions.filter((region) => region.kind === 'control')).toHaveLength(
      16,
    );
    expect(
      regions.find((region) => region.kind === 'panel')!.height,
    ).toBeGreaterThan(140);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('keeps masks and export bounds around negative-coordinate routes and wide detours', () => {
    const document = fixture();
    const bounds = cablePaintBounds(document, [
      { x: -900, y: -800 },
      { x: 1200, y: 1300 },
    ]);
    expect(bounds).toEqual({ x: -932, y: -832, width: 2164, height: 2164 });
    for (const region of cableProtectedRegions(document)) {
      expect(region.x).toBeGreaterThan(bounds.x);
      expect(region.y).toBeGreaterThan(bounds.y);
      expect(region.x + region.width).toBeLessThan(bounds.x + bounds.width);
    }
  });

  it('resolves overlapping touch targets to the nearest visible cable while preserving exact ties', () => {
    const routes = [
      {
        cable: { id: 'first' },
        route: {
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
          ],
        },
      },
      {
        cable: { id: 'last-painted' },
        route: {
          points: [
            { x: 0, y: 3 },
            { x: 100, y: 3 },
          ],
        },
      },
    ];
    expect(nearestCableAtPoint(routes, { x: 50, y: 0.1 }, 'last-painted')).toBe(
      'first',
    );
    expect(nearestCableAtPoint(routes, { x: 50, y: 2.8 }, 'first')).toBe(
      'last-painted',
    );
    expect(nearestCableAtPoint(routes, { x: 50, y: 1.5 }, 'last-painted')).toBe(
      'last-painted',
    );
    expect(nearestCableAtPoint([], { x: 0, y: 0 }, 'keyboard')).toBe(
      'keyboard',
    );
  });

  it('exports the same edge-aware path and foreground mask, respecting visibility and stored data', () => {
    const document = fixture();
    const before = JSON.stringify(document);
    const route = routeBoardCable(document, document.cables[0]!)!;
    const svg = boardImageSvg(document);
    expect(svg).toContain(`d="${route.path}"`);
    expect(svg).toContain('mask="url(#portfolio-cable-protection)"');
    expect(svg).toContain('maskUnits="userSpaceOnUse"');
    expect(svg).toContain('board-cable-protected-header');
    expect(svg).toContain('board-cable-protected-label');
    expect(svg).toContain('board-cable-protected-panel');
    expect(boardImageSvg({ ...document, showCables: false })).not.toContain(
      'portfolio-cable-protection',
    );
    expect(JSON.stringify(document)).toBe(before);
  });
});
