import type {
  BoardElement,
  JsonValue,
} from '../../../../packages/shared/src/board.js';

export const annotationKinds = [
  'text',
  'arrow',
  'rectangle',
  'highlight',
] as const;
export type AnnotationKind = (typeof annotationKinds)[number];
export type AnnotationElement = BoardElement & { type: AnnotationKind };
export interface AnnotationPoint {
  x: number;
  y: number;
}
export interface AnnotationPresentation {
  text: string;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  align: 'left' | 'center' | 'right';
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  cornerRadius: number;
  arrowhead: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}
const finite = (value: JsonValue | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bounded = (
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => Math.max(minimum, Math.min(maximum, finite(value, fallback)));
const color = (value: JsonValue | undefined, fallback: string) =>
  typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : fallback;
const optionalColor = (value: JsonValue | undefined, fallback = '') =>
  value === '' ? '' : color(value, fallback);

export function isAnnotation(
  element: BoardElement,
): element is AnnotationElement {
  return (annotationKinds as readonly string[]).includes(element.type);
}

/** Read authored settings without modifying them or interpreting text as markup. */
export function annotationPresentation(
  element: BoardElement,
): AnnotationPresentation {
  const props = element.properties;
  const highlight = element.type === 'highlight';
  return {
    text: typeof props.text === 'string' ? props.text : '',
    fontSize: bounded(props.fontSize, 24, 10, 120),
    textColor: color(props.textColor, '#dce8e0'),
    backgroundColor: optionalColor(props.backgroundColor),
    align:
      props.align === 'center' || props.align === 'right'
        ? props.align
        : 'left',
    fillColor: optionalColor(props.fillColor, highlight ? '#4a9b6b' : ''),
    fillOpacity: bounded(props.fillOpacity, highlight ? 0.16 : 0.12, 0, 1),
    strokeColor: color(props.strokeColor, color(element.color, '#a8d0b5')),
    strokeWidth: bounded(
      props.strokeWidth,
      element.type === 'arrow' ? 3 : 1,
      0,
      16,
    ),
    cornerRadius: bounded(props.cornerRadius, 10, 0, 80),
    arrowhead: props.arrowhead !== false,
    startX: bounded(props.startX, 0, 0, 1),
    startY: bounded(props.startY, 0.5, 0, 1),
    endX: bounded(props.endX, 1, 0, 1),
    endY: bounded(props.endY, 0.5, 0, 1),
  };
}

export function makeAnnotation(
  kind: AnnotationKind,
  x: number,
  y: number,
  width?: number,
  height?: number,
): BoardElement {
  const size = {
    text: { width: 240, height: 72 },
    arrow: { width: 240, height: 80 },
    rectangle: { width: 320, height: 200 },
    highlight: { width: 360, height: 240 },
  }[kind];
  const common = { textColor: '#dce8e0', fontSize: 24, align: 'left' };
  return {
    id: crypto.randomUUID(),
    type: kind,
    name: kind === 'text' ? 'Text' : '',
    x: bounded(x, 0, -100000, 100000),
    y: bounded(y, 0, -100000, 100000),
    width: bounded(width, size.width, 16, 20000),
    height: bounded(height, size.height, 16, 20000),
    z: kind === 'highlight' ? 0 : 1,
    color: '#a8d0b5',
    properties:
      kind === 'text'
        ? { ...common, text: 'Text', backgroundColor: '' }
        : kind === 'arrow'
          ? {
              ...common,
              strokeColor: '#a8d0b5',
              strokeWidth: 3,
              arrowhead: true,
              startX: 0,
              startY: 0.5,
              endX: 1,
              endY: 0.5,
            }
          : {
              ...common,
              fillColor: kind === 'highlight' ? '#4a9b6b' : '',
              fillOpacity: kind === 'highlight' ? 0.16 : 0.12,
              strokeColor: '#a8d0b5',
              strokeWidth: kind === 'highlight' ? 1 : 2,
              cornerRadius: 10,
            },
  };
}

export function annotationEndpoints(element: BoardElement): {
  start: AnnotationPoint;
  end: AnnotationPoint;
} {
  const settings = annotationPresentation(element);
  return {
    start: {
      x: element.x + element.width * settings.startX,
      y: element.y + element.height * settings.startY,
    },
    end: {
      x: element.x + element.width * settings.endX,
      y: element.y + element.height * settings.endY,
    },
  };
}

/** Keep nearly horizontal/vertical arrows aligned to their stationary endpoint. */
export function snapArrowEndpoint(
  anchor: AnnotationPoint,
  point: AnnotationPoint,
  zoom: number,
  options: { constrain?: boolean; bypass?: boolean } = {},
): AnnotationPoint {
  if (options.bypass) return point;
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const vertical = Math.abs(dx) <= Math.abs(dy);
  // A small screen-space tolerance also works for short arrows; the angle
  // tolerance keeps long arrows straight without requiring pixel-perfect aim.
  const tolerance = Math.max(
    8 / zoom,
    Math.hypot(dx, dy) * Math.sin(Math.PI / 60),
  );
  if (
    options.constrain ||
    (vertical ? Math.abs(dx) : Math.abs(dy)) <= tolerance
  )
    return vertical ? { x: anchor.x, y: point.y } : { x: point.x, y: anchor.y };
  return point;
}

/** Endpoint coordinates stay device-independent; moving a box moves its arrow. */
export function setArrowEndpoints(
  element: BoardElement,
  start: AnnotationPoint,
  end: AnnotationPoint,
): BoardElement {
  if (element.type !== 'arrow') return element;
  const old = annotationEndpoints(element);
  const a = {
    x: bounded(start.x, old.start.x, -100000, 100000),
    y: bounded(start.y, old.start.y, -100000, 100000),
  };
  const b = {
    x: bounded(end.x, old.end.x, -100000, 100000),
    y: bounded(end.y, old.end.y, -100000, 100000),
  };
  const width = Math.max(16, Math.min(20000, Math.abs(b.x - a.x)));
  const height = Math.max(16, Math.min(20000, Math.abs(b.y - a.y)));
  const x = Math.max(-100000, Math.min(100000, (a.x + b.x - width) / 2));
  const y = Math.max(-100000, Math.min(100000, (a.y + b.y - height) / 2));
  return {
    ...element,
    x,
    y,
    width,
    height,
    properties: {
      ...element.properties,
      startX: Math.max(0, Math.min(1, (a.x - x) / width)),
      startY: Math.max(0, Math.min(1, (a.y - y) / height)),
      endX: Math.max(0, Math.min(1, (b.x - x) / width)),
      endY: Math.max(0, Math.min(1, (b.y - y) / height)),
    },
  };
}
