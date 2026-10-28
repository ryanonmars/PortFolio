import type { CSSProperties } from 'react';
import type { BoardElement } from '../../../../packages/shared/src/board.js';
import {
  networkDisplayValue,
  networkPresentation,
} from './network-presentation.js';

export function NetworkSummary({ element }: { element: BoardElement }) {
  const entries = Array.isArray(element.properties.entries)
    ? element.properties.entries
    : [];
  return (
    <div className="board-network-summary">
      {entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return null;
        const presentation = networkPresentation(element, entry);
        if (!presentation) return null;
        return (
          <section
            key={index}
            className="board-network-entry"
            style={{ '--network-accent': presentation.color } as CSSProperties}
          >
            {(presentation.vlanId || presentation.vlanName) && (
              <p className="board-network-entry-heading">
                {presentation.vlanId && (
                  <span className="board-network-vlan-id">
                    VLAN {presentation.vlanId}
                  </span>
                )}
                {presentation.vlanId && presentation.vlanName && (
                  <span
                    className="board-network-heading-separator"
                    aria-hidden="true"
                  >
                    —
                  </span>
                )}
                {presentation.vlanName && (
                  <span className="board-network-vlan-name">
                    {presentation.vlanName}
                  </span>
                )}
              </p>
            )}
            {presentation.chips.length > 0 && (
              <div className="board-network-chips">
                {presentation.chips.map((chip) => (
                  <div
                    key={chip.key}
                    className="board-network-chip"
                    data-field={chip.key}
                  >
                    <span className="board-network-chip-label">
                      {chip.label}
                    </span>
                    <span className="board-network-chip-value">
                      {chip.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {presentation.notes && (
              <p className="board-network-entry-notes">{presentation.notes}</p>
            )}
          </section>
        );
      })}
      {networkDisplayValue(element.properties.notes) && (
        <p className="board-network-notes">
          {networkDisplayValue(element.properties.notes)}
        </p>
      )}
    </div>
  );
}
