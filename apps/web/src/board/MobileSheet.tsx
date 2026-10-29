import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { mobileSheetFrame } from './mobile-sheet-frame.js';
import { useVisualViewport } from './use-mobile-layout.js';
import './mobile-sheet.css';

const editable = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement &&
  target.matches(
    'input:not([type="checkbox"]):not([type="color"]),textarea,select,[contenteditable="true"]',
  );

/** A nonmodal mobile frame around the existing autosaving inspector. */
export function MobileSheet({
  children,
  onClose,
  label,
}: {
  children: ReactNode;
  onClose: (restoreFocus?: boolean) => void;
  label: string;
}) {
  const viewport = useVisualViewport();
  const [expanded, setExpanded] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [focusedFieldHeight, setFocusedFieldHeight] = useState(44);
  const focusedField = useRef<HTMLElement | null>(null);
  const [restingHeight, setRestingHeight] = useState(() => window.innerHeight);
  const [headerBottom, setHeaderBottom] = useState(
    () =>
      globalThis.document
        .querySelector('.board-appbar')
        ?.getBoundingClientRect().bottom ?? 0,
  );
  const sheet = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    pointer: number;
    y: number;
    height: number;
    delta: number;
  } | null>(null);
  const skipClick = useRef(false);
  const closePointer = useRef<number | null>(null);
  const id = useId();
  const keyboard =
    focused && viewport.scale < 1.05 && viewport.height < restingHeight * 0.8;
  const raised = expanded || focused;
  const frame = mobileSheetFrame(
    viewport,
    headerBottom,
    dragHeight ?? viewport.height * (raised ? 0.94 : 0.56),
    focused,
    window.innerHeight,
    focusedFieldHeight,
  );
  const height = frame.height;
  const width = Math.min(720, viewport.width);

  useEffect(() => {
    const header = globalThis.document.querySelector('.board-appbar');
    const update = () =>
      setHeaderBottom(header?.getBoundingClientRect().bottom ?? 0);
    const frame = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    if (header) observer.observe(header);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [viewport]);

  const keepFieldVisible = useCallback(() => {
    const active = globalThis.document.activeElement;
    const body = sheet.current?.querySelector<HTMLElement>(
      '.board-inspector-body',
    );
    if (!editable(active) || !body?.contains(active)) return;
    const field = active.getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    const padding = frame.emergency
      ? 6
      : Math.min(
          12,
          Math.max(
            0,
            (bounds.height - Math.min(field.height, bounds.height)) / 2,
          ),
        );
    if (frame.emergency) {
      body.scrollTop += field.top - bounds.top - padding;
      return;
    }
    if (field.bottom > bounds.bottom - padding)
      body.scrollTop += Math.min(
        field.bottom - bounds.bottom + padding,
        field.top - bounds.top - padding,
      );
    else if (field.top < bounds.top + padding)
      body.scrollTop -= bounds.top + padding - field.top;
  }, [frame.emergency]);
  useEffect(() => {
    const frame = requestAnimationFrame(keepFieldVisible);
    // Mobile browser keyboard animations can finish after the resize event.
    const timer = setTimeout(keepFieldVisible, 180);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [viewport, height, focused, keepFieldVisible]);
  const blurField = useCallback(() => {
    const active = globalThis.document.activeElement;
    if (active instanceof HTMLElement && sheet.current?.contains(active))
      active.blur();
  }, []);
  const close = useCallback(
    (restoreFocus = false) => {
      blurField();
      onClose(restoreFocus);
    },
    [onClose, blurField],
  );
  function collapse() {
    if (focused) blurField();
    setFocused(false);
    setExpanded(false);
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        globalThis.document.querySelector(
          ':popover-open,[role="menu"],dialog[open]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const commitOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !sheet.current?.contains(event.target)
      )
        blurField();
    };
    globalThis.document.addEventListener('keydown', escape, true);
    globalThis.document.addEventListener('pointerdown', commitOutside, true);
    return () => {
      globalThis.document.removeEventListener('keydown', escape, true);
      globalThis.document.removeEventListener(
        'pointerdown',
        commitOutside,
        true,
      );
    };
  }, [close, blurField]);

  function start(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointer: event.pointerId,
      y: event.clientY,
      height,
      delta: 0,
    };
    skipClick.current = false;
  }
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.stopPropagation();
    current.delta = event.clientY - current.y;
    if (Math.abs(current.delta) > 4) skipClick.current = true;
    setDragHeight(Math.max(60, current.height - current.delta));
  }
  function finish(event: ReactPointerEvent<HTMLButtonElement>, cancel = false) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    setDragHeight(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || !skipClick.current) return;
    if (
      (!raised && current.delta > 96) ||
      current.height - current.delta < viewport.height * 0.28
    )
      close();
    else if (current.delta > 48) collapse();
    else if (current.delta < -36) setExpanded(true);
  }

  return createPortal(
    <div
      ref={sheet}
      id={id}
      className="board-studio board-mobile-sheet"
      role="dialog"
      aria-label={label}
      data-expanded={raised}
      data-keyboard={keyboard}
      data-editing={focused}
      data-constrained={frame.constrained}
      data-emergency={frame.emergency}
      style={{
        top: frame.top,
        left: viewport.left + (viewport.width - width) / 2,
        width,
        height,
      }}
      onPointerDownCapture={(event) => {
        const active = globalThis.document.activeElement;
        if (
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest('button[aria-label="Close inspector"]') &&
          editable(active) &&
          sheet.current?.contains(active)
        ) {
          event.preventDefault();
          // WebKit suppresses the compatibility click after preventing focus.
          // Complete this tap on pointerup while the button stays in place.
          closePointer.current = event.pointerId;
        }
      }}
      onPointerUpCapture={(event) => {
        if (closePointer.current !== event.pointerId) return;
        closePointer.current = null;
        if (
          event.target instanceof Element &&
          event.target.closest('button[aria-label="Close inspector"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onPointerCancelCapture={() => {
        closePointer.current = null;
      }}
      onClickCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('button[aria-label="Close inspector"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          close(event.detail === 0);
        }
      }}
      onFocusCapture={(event) => {
        if (editable(event.target)) {
          if (!frame.emergency || focusedField.current !== event.target)
            setFocusedFieldHeight(event.target.getBoundingClientRect().height);
          focusedField.current = event.target;
          if (!focused && viewport.height > restingHeight * 0.8)
            setRestingHeight(viewport.height);
          setFocused(true);
        }
      }}
      onBlurCapture={(event) => {
        // Keep the frame stable while focus moves to an action or help button.
        if (
          !(event.relatedTarget instanceof Node) ||
          !sheet.current?.contains(event.relatedTarget)
        )
          setFocused(false);
      }}
    >
      <button
        className="board-mobile-sheet-handle"
        type="button"
        aria-label={raised ? 'Collapse inspector' : 'Expand inspector'}
        aria-expanded={raised}
        aria-controls={id}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)}
        onLostPointerCapture={(event) => finish(event, true)}
        onClick={() => {
          if (skipClick.current) {
            skipClick.current = false;
            return;
          }
          if (raised) collapse();
          else setExpanded(true);
        }}
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'ArrowUp') setExpanded(true);
          else collapse();
        }}
      >
        <span aria-hidden="true" />
      </button>
      {children}
    </div>,
    globalThis.document.body,
  );
}
