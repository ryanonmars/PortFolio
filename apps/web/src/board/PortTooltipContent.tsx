import type { CSSProperties } from 'react';
import type {
  BoardDocument,
  BoardPort,
} from '../../../../packages/shared/src/board.js';
import { portTooltipPresentation } from './port-tooltip-presentation.js';
import './port-tooltip.css';

export function PortTooltipContent({
  document,
  port,
}: {
  document: BoardDocument;
  port: BoardPort;
}) {
  const info = portTooltipPresentation(document, port);
  return (
    <div
      className="board-port-tooltip-content"
      style={{ '--port-tooltip-accent': info.color } as CSSProperties}
    >
      <div className="board-port-tooltip-heading">
        {info.name && (
          <div className="board-port-tooltip-name">{info.name}</div>
        )}
        {(info.purpose || info.connector) && (
          <div className="board-port-tooltip-description">
            {info.purpose && <span data-field="role">{info.purpose}</span>}
            {info.connector && <span data-field="kind">{info.connector}</span>}
          </div>
        )}
        {info.status && (
          <div
            className="board-port-tooltip-status"
            data-field="linkState"
            data-state={info.status.tone}
          >
            <span
              className="board-port-tooltip-status-dot"
              aria-hidden="true"
            />
            <span className="board-port-tooltip-status-label">Documented</span>
            <span>{info.status.value}</span>
          </div>
        )}
      </div>
      {info.pills.length > 0 && (
        <div className="board-network-chips board-port-tooltip-pills">
          {info.pills.map((pill) => (
            <div
              key={pill.key}
              className="board-network-chip board-port-tooltip-pill"
              data-field={pill.key}
            >
              <span className="board-network-chip-label">{pill.label}</span>
              <span className="board-network-chip-value">{pill.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
