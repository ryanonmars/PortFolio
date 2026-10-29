import { memo, useMemo } from 'react';
import type { BoardElement } from '../../../../packages/shared/src/board.js';
import { routeSummaryArrow } from './summary-routing.js';

/** Summary relationships are derived from the same geometry as the live board. */
export const SummaryLinks = memo(function SummaryLinks({
  elements,
}: {
  elements: BoardElement[];
}) {
  const links = useMemo(() => {
    const devices = new Map(
      elements
        .filter((element) => element.type === 'device')
        .map((element) => [element.id, element]),
    );
    return elements.flatMap((summary) => {
      if (summary.type !== 'summary') return [];
      const id = summary.properties.linkedDeviceId;
      const target = typeof id === 'string' ? devices.get(id) : undefined;
      if (!target) return [];
      const route = routeSummaryArrow(summary, target, elements);
      return route ? [{ summary, target, route }] : [];
    });
  }, [elements]);
  return (
    <svg className="board-summary-link-layer" aria-hidden="true">
      {links.map(({ summary, target, route }) => (
        <g
          key={summary.id}
          className="board-summary-link"
          data-summary-id={summary.id}
          data-target-id={target.id}
          style={{ color: summary.color || '#b6d7c1' }}
        >
          <path className="board-summary-link-line" d={route.path} />
          <path className="board-summary-link-head" d={route.arrow} />
        </g>
      ))}
    </svg>
  );
});
