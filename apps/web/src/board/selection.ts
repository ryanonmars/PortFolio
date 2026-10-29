import type {
  BoardDocument,
  BoardElement,
} from '../../../../packages/shared/src/board.js';
import {
  clamp,
  snapRect,
  type Guide,
  type Point,
  type Rect,
} from './geometry.js';

export function selectionBounds(elements: Rect[]): Rect | null {
  if (!elements.length) return null;
  const x = Math.min(...elements.map((element) => element.x));
  const y = Math.min(...elements.map((element) => element.y));
  return {
    x,
    y,
    width:
      Math.max(...elements.map((element) => element.x + element.width)) - x,
    height:
      Math.max(...elements.map((element) => element.y + element.height)) - y,
  };
}

export function marqueeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function enclosedElementIds(
  elements: BoardElement[],
  rect: Rect,
): string[] {
  return elements
    .filter(
      (element) =>
        element.x >= rect.x &&
        element.y >= rect.y &&
        element.x + element.width <= rect.x + rect.width &&
        element.y + element.height <= rect.y + rect.height,
    )
    .map((element) => element.id);
}

/** Snap one collective rectangle, then translate every member identically. */
export function moveSelection(
  document: BoardDocument,
  ids: string[],
  delta: Point,
  bypass: boolean,
): { document: BoardDocument; guides: Guide[] } {
  const selected = new Set(ids);
  const elements = document.elements.filter((element) =>
    selected.has(element.id),
  );
  const bounds = selectionBounds(elements);
  if (!bounds) return { document, guides: [] };
  const snapped = snapRect(
    { ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y },
    document.elements.filter((element) => !selected.has(element.id)),
    document.viewport.zoom,
    bypass,
  );
  const snappedX = snapped.rect.x - bounds.x;
  const snappedY = snapped.rect.y - bounds.y;
  // Clamp the translation rather than individual members to retain spacing.
  const dx = clamp(
    snappedX,
    -100000 - bounds.x,
    100000 - Math.max(...elements.map((element) => element.x)),
  );
  const dy = clamp(
    snappedY,
    -100000 - bounds.y,
    100000 - Math.max(...elements.map((element) => element.y)),
  );
  return {
    document: {
      ...document,
      elements: document.elements.map((element) =>
        selected.has(element.id)
          ? { ...element, x: element.x + dx, y: element.y + dy }
          : element,
      ),
    },
    guides: snapped.guides.filter((guide) =>
      guide.axis === 'x' ? dx === snappedX : dy === snappedY,
    ),
  };
}
