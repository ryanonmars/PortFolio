import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import { getPortPoint, screenToWorld, snapRect } from './geometry.js';
import {
  enclosedElementIds,
  marqueeRect,
  moveSelection,
  selectionBounds,
} from './selection.js';

function element(id: string, values: Partial<BoardElement> = {}): BoardElement {
  return {
    id,
    type: 'device',
    name: 'Same name',
    x: 0,
    y: 0,
    width: 160,
    height: 120,
    z: 0,
    color: '',
    properties: {},
    ...values,
  };
}

describe('board multi-selection geometry', () => {
  it('computes mixed-size bounds including negative coordinates and empty selections', () => {
    expect(selectionBounds([])).toBeNull();
    expect(
      selectionBounds([
        element('device', { x: -160, y: -80, width: 320 }),
        element('network', { type: 'network', x: 80, y: 80, height: 300 }),
        element('summary', { type: 'summary', x: -80, y: 20 }),
      ]),
    ).toEqual({ x: -160, y: -80, width: 400, height: 460 });
  });

  it.each([
    [
      { x: -200, y: -100 },
      { x: 400, y: 300 },
    ],
    [
      { x: 400, y: -100 },
      { x: -200, y: 300 },
    ],
    [
      { x: -200, y: 300 },
      { x: 400, y: -100 },
    ],
    [
      { x: 400, y: 300 },
      { x: -200, y: -100 },
    ],
  ])('normalizes a marquee in any drag direction', (a, b) => {
    expect(marqueeRect(a, b)).toEqual({
      x: -200,
      y: -100,
      width: 600,
      height: 400,
    });
  });

  it('selects only fully enclosed containers, including their exact boundary', () => {
    const elements = [
      element('boundary', { x: -200, y: -100, width: 600, height: 400 }),
      element('overlapping', { x: -100, y: -50 }),
      element('network', { type: 'network', x: 100, y: 0 }),
      element('summary', { type: 'summary', x: 0, y: 140 }),
      element('partial', { x: 300, y: 200 }),
      element('outside', { x: 800 }),
    ];
    expect(
      enclosedElementIds(elements, {
        x: -200,
        y: -100,
        width: 600,
        height: 400,
      }),
    ).toEqual(['boundary', 'overlapping', 'network', 'summary']);
    expect(
      enclosedElementIds(elements, marqueeRect({ x: 0, y: 0 }, { x: 0, y: 0 })),
    ).toEqual([]);
  });

  it.each([0.25, 0.5, 1, 2, 4])(
    'preserves board enclosure under zoom %s and pan',
    (zoom) => {
      const viewport = { x: 427, y: -138, zoom };
      const a = { x: -200, y: -100 },
        b = { x: 400, y: 300 };
      const screen = (point: typeof a) => ({
        x: point.x * zoom + viewport.x,
        y: point.y * zoom + viewport.y,
      });
      const rect = marqueeRect(
        screenToWorld(screen(a), viewport),
        screenToWorld(screen(b), viewport),
      );
      expect(
        enclosedElementIds([element('inside', { x: -160, y: -80 })], rect),
      ).toEqual(['inside']);
      expect(rect).toEqual({ x: -200, y: -100, width: 600, height: 400 });
    },
  );

  it('moves duplicate names by stable IDs and leaves unselected elements and data untouched', () => {
    const first = element('first', {
      x: -20,
      y: -40,
      properties: { note: 'keep' },
    });
    const second = element('second', { x: 200, y: 240, type: 'network' });
    const third = element('third', { x: 500, y: -300, type: 'summary' });
    const document = {
      ...emptyBoardDocument(),
      elements: [first, second, third],
    };
    const before = structuredClone(document);
    const result = moveSelection(
      document,
      ['first', 'second', 'first', 'missing'],
      { x: 13, y: -27 },
      true,
    );
    expect(result.document.elements).toEqual([
      { ...first, x: -7, y: -67 },
      { ...second, x: 213, y: 213 },
      third,
    ]);
    expect(result.document.elements[2]).toBe(third);
    expect(result.document.elements[0]!.properties).toBe(first.properties);
    expect(result.guides).toEqual([]);
    expect(document).toEqual(before);
    expect(
      moveSelection(document, ['missing'], { x: 10, y: 10 }, false).document,
    ).toBe(document);
  });

  it('snaps collective bounds instead of independently changing internal spacing', () => {
    const document = {
      ...emptyBoardDocument(),
      elements: [
        element('first', { x: 3, y: 5 }),
        element('second', { x: 190, y: 219 }),
      ],
    };
    const result = moveSelection(
      document,
      ['first', 'second'],
      { x: 13, y: 10 },
      false,
    );
    expect(result.document.elements.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 16, y: 16 },
      { x: 203, y: 230 },
    ]);
    expect(
      result.document.elements[1]!.x - result.document.elements[0]!.x,
    ).toBe(187);
    expect(
      result.document.elements[1]!.y - result.document.elements[0]!.y,
    ).toBe(214);
  });

  it.each([0.5, 1, 4])(
    'uses existing edge, center and spacing snapping at zoom %s',
    (zoom) => {
      const document = {
        ...emptyBoardDocument(),
        viewport: { x: 0, y: 0, zoom },
        elements: [
          element('first', { x: 0, y: 0 }),
          element('second', { x: 221, y: 170 }),
          element('target', { x: 500, y: 500, width: 381 }),
        ],
      };
      const bounds = selectionBounds(document.elements.slice(0, 2))!;
      const delta = { x: 501, y: 31 };
      const expected = snapRect(
        { ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y },
        [document.elements[2]!],
        zoom,
      );
      const result = moveSelection(document, ['first', 'second'], delta, false);
      expect(result.document.elements[0]!.x).toBe(expected.rect.x);
      expect(result.document.elements[0]!.y).toBe(expected.rect.y);
      expect(result.guides).toEqual(expected.guides);
      expect(
        result.document.elements[1]!.x - result.document.elements[0]!.x,
      ).toBe(221);
      expect(
        result.document.elements[1]!.y - result.document.elements[0]!.y,
      ).toBe(170);
      expect(result.document.elements[2]).toBe(document.elements[2]);
    },
  );

  it.each([false, true])(
    'clamps a shared translation at board limits without distorting spacing (bypass %s)',
    (bypass) => {
      const document = {
        ...emptyBoardDocument(),
        elements: [
          element('first', { x: 99980, y: -99990 }),
          element('second', { x: 99993, y: -99930 }),
        ],
      };
      const result = moveSelection(
        document,
        ['first', 'second'],
        { x: 1000, y: -1000 },
        bypass,
      );
      expect(result.document.elements.map(({ x, y }) => ({ x, y }))).toEqual([
        { x: 99987, y: -100000 },
        { x: 100000, y: -99940 },
      ]);
    },
  );

  it('keeps port slots and stable cable references while endpoints follow either or both devices', () => {
    const document = {
      ...emptyBoardDocument(),
      elements: [
        element('first', { width: 320, height: 240 }),
        element('second', { x: 400, y: 300, width: 320, height: 240 }),
      ],
      ports: [
        makeBoardPort('first', 'rj45', 0, 0, 'Port 1'),
        makeBoardPort('second', 'sfp_plus', 0, 1, 'Port 1'),
      ],
    };
    document.cables.push({
      id: 'cable',
      sourcePortId: document.ports[0]!.id,
      targetPortId: document.ports[1]!.id,
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    });
    for (const ids of [['first'], ['first', 'second']]) {
      const result = moveSelection(
        document,
        ids,
        { x: 31, y: -19 },
        true,
      ).document;
      expect(result.ports).toBe(document.ports);
      expect(result.cables).toBe(document.cables);
      for (const port of document.ports) {
        const before = getPortPoint(document, port.id)!;
        expect(getPortPoint(result, port.id)).toEqual(
          ids.includes(port.deviceId)
            ? { x: before.x + 31, y: before.y - 19 }
            : before,
        );
      }
    }
  });
});
