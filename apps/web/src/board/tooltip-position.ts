import { clamp, type Rect } from './geometry.js';

/** Screen-space placement: the card never covers its visible connector. */
export function placePortTooltip(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: Rect,
) {
  const gap = 10;
  const margin = 8;
  const left = viewport.x + margin;
  const top = viewport.y + margin;
  const right = viewport.x + viewport.width - margin;
  const bottom = viewport.y + viewport.height - margin;
  const width = Math.min(480, size.width, right - left);
  if (width <= 0 || bottom <= top) return null;
  const above = Math.max(0, anchor.y - gap - top);
  const below = Math.max(0, bottom - (anchor.y + anchor.height + gap));
  const minimum = Math.min(64, size.height);
  const side =
    above >= size.height
      ? 'above'
      : below >= size.height
        ? 'below'
        : above >= below
          ? 'above'
          : 'below';
  const space = side === 'above' ? above : below;
  if (space >= minimum) {
    const height = Math.min(size.height, space);
    return {
      x: clamp(anchor.x + anchor.width / 2 - width / 2, left, right - width),
      y:
        side === 'above'
          ? anchor.y - gap - height
          : anchor.y + anchor.height + gap,
      width,
      maxHeight: height,
      side,
    };
  }
  // Very short windows can have more usable room beside the connector.
  const before = Math.max(0, anchor.x - gap - left);
  const after = Math.max(0, right - (anchor.x + anchor.width + gap));
  const horizontal = after >= before ? 'right' : 'left';
  const horizontalSpace = Math.max(before, after);
  const fittedWidth = Math.min(width, horizontalSpace);
  const height = Math.min(size.height, bottom - top);
  if (fittedWidth < Math.min(160, width) || height < minimum) return null;
  return {
    x:
      horizontal === 'right'
        ? anchor.x + anchor.width + gap
        : anchor.x - gap - fittedWidth,
    y: clamp(anchor.y + anchor.height / 2 - height / 2, top, bottom - height),
    width: fittedWidth,
    maxHeight: height,
    side: horizontal,
  };
}
