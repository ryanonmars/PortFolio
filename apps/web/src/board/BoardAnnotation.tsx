import type { CSSProperties } from 'react';
import type { BoardElement } from '../../../../packages/shared/src/board.js';
import { annotationPresentation } from './annotations.js';
import './annotations.css';

/** Visual content only. Canvas owns hit areas, selection and all gestures. */
export function BoardAnnotation({ element }: { element: BoardElement }) {
  const settings = annotationPresentation(element);
  if (element.type === 'text')
    return (
      <div
        className="board-annotation-text"
        data-annotation-kind="text"
        style={{
          fontSize: settings.fontSize,
          color: settings.textColor,
          backgroundColor: settings.backgroundColor || 'transparent',
          textAlign: settings.align,
        }}
      >
        {settings.text}
      </div>
    );

  const start = {
    x: settings.startX * element.width,
    y: settings.startY * element.height,
  };
  const end = {
    x: settings.endX * element.width,
    y: settings.endY * element.height,
  };
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const ux = distance ? (end.x - start.x) / distance : 0;
  const uy = distance ? (end.y - start.y) / distance : 0;
  const length = Math.min(
    distance * 0.5,
    Math.max(10, Math.min(32, settings.strokeWidth * 3)),
  );
  const halfWidth = Math.min(
    length * 0.6,
    Math.max(5, Math.min(16, settings.strokeWidth * 1.5)),
  );
  const head = [
    `${end.x},${end.y}`,
    `${end.x - ux * length - uy * halfWidth},${end.y - uy * length + ux * halfWidth}`,
    `${end.x - ux * length + uy * halfWidth},${end.y - uy * length - ux * halfWidth}`,
  ].join(' ');
  const labelStyle: CSSProperties = {
    color: settings.textColor,
    ...(element.type === 'arrow'
      ? {
          left: `${((settings.startX + settings.endX) / 2) * 100}%`,
          top: `${((settings.startY + settings.endY) / 2) * 100}%`,
        }
      : {}),
  };
  return (
    <div
      className={`board-annotation-visual board-annotation-${element.type}`}
      data-annotation-kind={element.type}
    >
      <svg
        className="board-annotation-shape"
        width={element.width}
        height={element.height}
        viewBox={`0 0 ${element.width} ${element.height}`}
        aria-hidden="true"
      >
        {element.type === 'arrow' ? (
          <>
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke={settings.strokeColor}
              strokeWidth={settings.strokeWidth}
              strokeLinecap="round"
            />
            {settings.arrowhead && distance > 0 && (
              <polygon points={head} fill={settings.strokeColor} />
            )}
          </>
        ) : (
          <rect
            x={settings.strokeWidth / 2}
            y={settings.strokeWidth / 2}
            width={Math.max(0, element.width - settings.strokeWidth)}
            height={Math.max(0, element.height - settings.strokeWidth)}
            rx={Math.min(
              settings.cornerRadius,
              element.width / 2,
              element.height / 2,
            )}
            fill={settings.fillColor || 'none'}
            fillOpacity={settings.fillOpacity}
            stroke={settings.strokeWidth ? settings.strokeColor : 'none'}
            strokeWidth={settings.strokeWidth}
          />
        )}
      </svg>
      {element.name && (
        <div className="board-annotation-label" style={labelStyle}>
          {element.name}
        </div>
      )}
    </div>
  );
}
