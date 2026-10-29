import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type {
  BoardDocument,
  BoardPort,
} from '../../../../packages/shared/src/board.js';
import { PortTooltipContent } from './PortTooltipContent.js';
import { placePortTooltip } from './tooltip-position.js';

export function PortHoverTooltip({
  id,
  document: board,
  port,
  canvas,
  onEnter,
  onLeave,
  onDismiss,
}: {
  id: string;
  document: BoardDocument;
  port: BoardPort;
  canvas: RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  onDismiss: (restoreFocus?: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useLayoutEffect(() => {
    const element = panel.current;
    const anchor = canvas.current?.querySelector<HTMLButtonElement>(
      `button[data-port-id="${CSS.escape(port.id)}"]`,
    );
    if (!element || !anchor) return;
    let frame = 0;
    const fit = () => {
      const visual = window.visualViewport;
      const viewport = {
        x: visual?.offsetLeft ?? 0,
        y: visual?.offsetTop ?? 0,
        width: visual?.width ?? window.innerWidth,
        height: visual?.height ?? window.innerHeight,
      };
      const trigger = anchor.getBoundingClientRect();
      const surface = canvas.current?.getBoundingClientRect();
      if (!surface) return;
      const x = Math.max(trigger.left, surface.left, viewport.x);
      const y = Math.max(trigger.top, surface.top, viewport.y);
      const right = Math.min(
        trigger.right,
        surface.right,
        viewport.x + viewport.width,
      );
      const bottom = Math.min(
        trigger.bottom,
        surface.bottom,
        viewport.y + viewport.height,
      );
      if (right <= x || bottom <= y) {
        dismiss.current(false);
        return;
      }
      element.style.width = 'max-content';
      element.style.maxWidth = `${Math.max(1, Math.min(340, viewport.width - 16))}px`;
      const box = element.getBoundingClientRect();
      const placement = placePortTooltip(
        { x, y, width: right - x, height: bottom - y },
        { width: box.width, height: element.scrollHeight + 2 },
        viewport,
      );
      if (!placement) {
        dismiss.current(false);
        return;
      }
      element.style.width = `${placement.width}px`;
      element.style.left = `${placement.x}px`;
      element.style.top = `${placement.y}px`;
      element.style.maxHeight = `${placement.maxHeight}px`;
      element.style.visibility = 'visible';
      element.dataset.placement = placement.side;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target))
        dismiss.current(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current(element.contains(globalThis.document.activeElement));
    };
    fit();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(anchor);
    if (canvas.current) observer.observe(canvas.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    globalThis.document.addEventListener('pointerdown', outside, true);
    globalThis.document.addEventListener('keydown', escape, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      globalThis.document.removeEventListener('pointerdown', outside, true);
      globalThis.document.removeEventListener('keydown', escape, true);
    };
  }, [board, port, canvas]);
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      tabIndex={0}
      className="board-port-tooltip"
      data-summary-port-id={port.id}
      style={{ visibility: 'hidden' }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <PortTooltipContent document={board} port={port} />
    </div>,
    globalThis.document.body,
  );
}
