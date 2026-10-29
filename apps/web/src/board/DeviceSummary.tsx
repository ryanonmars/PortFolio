import type {
  BoardDocument,
  BoardElement,
} from '../../../../packages/shared/src/board.js';
import type { CSSProperties } from 'react';
import {
  summaryPresentation,
  type SummaryChip,
} from './summary-presentation.js';
import './device-summary.css';

function Tiles({ chips }: { chips: SummaryChip[] }) {
  return (
    <div className="board-summary-tiles">
      {chips.map((chip) => (
        <div
          key={chip.key}
          className="board-summary-tile"
          data-field={chip.key}
        >
          <span className="board-summary-tile-label">{chip.label}</span>
          <span className="board-summary-tile-value">{chip.value}</span>
        </div>
      ))}
    </div>
  );
}

export function DeviceSummary({
  document,
  element,
}: {
  document: BoardDocument;
  element: BoardElement;
}) {
  const presentation = summaryPresentation(document, element);
  return (
    <div
      className="board-summary-content"
      tabIndex={0}
      role="region"
      aria-label="Device summary information"
    >
      {presentation.state !== 'linked' ? (
        <p className="board-summary-placeholder">
          {presentation.state === 'empty'
            ? 'Select a device in the inspector.'
            : 'Linked device unavailable.'}
        </p>
      ) : (
        <>
          <section className="board-summary-device">
            <h3 className="board-summary-device-name">{presentation.name}</h3>
            <Tiles chips={presentation.chips} />
          </section>
          <section className="board-summary-ports">
            <h4 className="board-summary-section-heading">{`Port Configuration (${presentation.ports.length})`}</h4>
            {presentation.ports.map((port) => (
              <section
                key={port.id}
                className="board-summary-port"
                data-port-id={port.id}
                style={{ '--summary-port-accent': port.color } as CSSProperties}
              >
                <h5 className="board-summary-port-heading">
                  <span
                    className="board-summary-port-accent"
                    aria-hidden="true"
                  />
                  <span>
                    {port.name}{' '}
                    <span className="board-summary-port-connector">
                      — {port.connector}
                    </span>
                  </span>
                </h5>
                <Tiles chips={port.chips} />
              </section>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
