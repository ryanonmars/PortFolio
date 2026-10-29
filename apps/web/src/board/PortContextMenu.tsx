import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Point } from './geometry.js';
import './port-context-menu.css';

export type PortMenuAction = {
  label: string;
  disabled?: boolean;
  run: () => void;
};

export function PortContextMenu({
  point,
  portId,
  title,
  summary,
  actions,
  overwriteHint,
  onClose,
}: {
  point: Point;
  portId: string;
  title: string;
  summary: string;
  actions: PortMenuAction[];
  overwriteHint: boolean;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const [position, setPosition] = useState(point);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!panel) return;
    const fit = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const box = panel.getBoundingClientRect();
      setPosition({
        x: Math.max(left + 8, Math.min(point.x, left + width - box.width - 8)),
        y: Math.max(top + 8, Math.min(point.y, top + height - box.height - 8)),
      });
    };
    fit();
    panel
      .querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.contains(event.target))
        close.current(false);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
    };
  }, [point.x, point.y]);
  return createPortal(
    <div
      ref={menu}
      className="board-port-menu"
      role="menu"
      aria-label="Port actions"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Tab') {
          onClose(false);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose(true);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        const buttons = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
          ),
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }}
    >
      <div className="board-port-menu-heading">{title}</div>
      <div
        className="board-port-menu-summary"
        role="tooltip"
        data-summary-port-id={portId}
      >
        {summary}
      </div>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
      {overwriteHint && (
        <p className="board-port-menu-hint">
          Replaces interface addresses and external connections, including empty
          values. Undo restores previous settings.
        </p>
      )}
    </div>,
    document.body,
  );
}
