import { describe, expect, it } from 'vitest';
import { emptyBoardDocument } from '../../../../packages/shared/src/board.js';
import {
  addAnnotation,
  duplicateElement,
  orderElement,
  removeObject,
} from './commands.js';
import { makeAnnotation } from './annotations.js';
import { enclosedElementIds, moveSelection } from './selection.js';

describe('annotation canvas commands', () => {
  it('puts highlights behind other objects while retaining relative geometry', () => {
    const first = makeAnnotation('rectangle', 40, 80);
    const doc = addAnnotation(
      addAnnotation(emptyBoardDocument(), first),
      makeAnnotation('highlight', 0, 0),
    );
    expect(doc.elements[0]!.type).toBe('highlight');
    expect(doc.elements.find((item) => item.id === first.id)).toMatchObject({
      x: 40,
      y: 80,
    });
  });
  it('reorders foreground annotations but keeps highlights in their background plane', () => {
    let doc = emptyBoardDocument();
    for (const kind of ['highlight', 'rectangle', 'text', 'arrow'] as const)
      doc = addAnnotation(doc, makeAnnotation(kind, 0, 0));
    const rect = doc.elements.find((item) => item.type === 'rectangle')!;
    doc = orderElement(doc, rect.id, 'front');
    expect(doc.elements.at(-1)!.id).toBe(rect.id);
    doc = orderElement(doc, rect.id, 'back');
    expect(doc.elements[0]!.type).toBe('highlight');
    expect(doc.elements[1]!.id).toBe(rect.id);
    expect(new Set(doc.elements.map((item) => item.z)).size).toBe(4);
  });
  it('moves, duplicates, removes and marquee-selects annotations without network records', () => {
    const text = makeAnnotation('text', 40, 80);
    const rectangle = makeAnnotation('rectangle', 350, 80);
    const doc = addAnnotation(
      addAnnotation(emptyBoardDocument(), text),
      rectangle,
    );
    const moved = moveSelection(
      doc,
      [text.id, rectangle.id],
      { x: 16, y: 24 },
      true,
    ).document;
    expect(moved.elements.map((item) => [item.x, item.y])).toEqual([
      [56, 104],
      [366, 104],
    ]);
    expect(
      enclosedElementIds(moved.elements, {
        x: 0,
        y: 0,
        width: 1000,
        height: 1000,
      }),
    ).toHaveLength(2);
    const copied = duplicateElement(doc, text.id);
    expect(copied.elements.at(-1)!.properties.text).toBe('Text');
    expect(copied.elements.at(-1)!.name).toBe(text.name);
    expect(removeObject(copied, 'element', text.id).elements).toHaveLength(2);
    expect(doc.ports).toEqual([]);
    expect(doc.cables).toEqual([]);
  });
});
