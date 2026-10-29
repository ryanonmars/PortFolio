import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import './field-help.css';

/** Small, read-only help in the top layer so inspector scrolling cannot clip it. */
export function FieldHelp({
  id,
  label,
  children,
  triggerLabel,
}: {
  id: string;
  label: string;
  triggerLabel?: string;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const opened = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef(0);
  const [open, setOpen] = useState(false);

  const clearLeave = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const close = useCallback(() => {
    clearLeave();
    pinned.current = false;
    if (panel.current?.matches(':popover-open')) panel.current.hidePopover();
    opened.current = false;
    setOpen(false);
  }, [clearLeave]);
  const position = useCallback(() => {
    const button = trigger.current;
    const popup = panel.current;
    if (!button || !popup || !opened.current) return;
    const box = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const body = button
      .closest('.board-inspector-body')
      ?.getBoundingClientRect();
    if (
      box.bottom <= Math.max(top, body?.top ?? top) ||
      box.top >= Math.min(top + height, body?.bottom ?? top + height) ||
      box.right <= left ||
      box.left >= left + width
    ) {
      close();
      return;
    }
    const margin = 8;
    popup.style.width = `${Math.max(1, Math.min(300, width - margin * 2))}px`;
    popup.style.maxHeight = `${Math.max(1, height - margin * 2)}px`;
    const popupBox = popup.getBoundingClientRect();
    const inspectorLeft =
      button.closest('.board-inspector')?.getBoundingClientRect().left ??
      box.left;
    const field =
      button.closest('.board-inspector-field')?.getBoundingClientRect() ?? box;
    let x = Math.min(box.left, left + width - popupBox.width - margin);
    let y: number;
    if (inspectorLeft - left >= popupBox.width + margin * 2) {
      x = inspectorLeft - popupBox.width - margin;
      y = box.top - 8;
    } else if (field.top - popupBox.height - margin >= top + margin) {
      y = field.top - popupBox.height - margin;
    } else {
      y = field.bottom + margin;
    }
    popup.style.left = `${Math.max(left + margin, Math.min(x, left + width - popupBox.width - margin))}px`;
    popup.style.top = `${Math.max(top + margin, Math.min(y, top + height - popupBox.height - margin))}px`;
  }, [close]);
  function show() {
    clearLeave();
    const popup = panel.current;
    if (!popup) return;
    if (!popup.matches(':popover-open')) popup.showPopover();
    opened.current = true;
    setOpen(true);
    position();
  }
  function leave() {
    clearLeave();
    if (!pinned.current && document.activeElement !== trigger.current)
      leaveTimer.current = setTimeout(close, 220);
  }

  useEffect(() => {
    function reposition() {
      if (!opened.current) return;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(position);
    }
    function outside(event: Event) {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !panel.current?.contains(target)
      )
        close();
    }
    function escape(event: KeyboardEvent) {
      if (opened.current && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      clearLeave();
      cancelAnimationFrame(frame.current);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [clearLeave, close, position]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="board-field-help-trigger"
        aria-label={triggerLabel ?? `Help for ${label}`}
        aria-describedby={id}
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') show();
        }}
        onPointerLeave={leave}
        onFocus={show}
        onBlur={() => {
          if (!pinned.current) close();
        }}
        onClick={(event) => {
          // Keep the native invoker relationship for light dismissal, while
          // hover/focus and pinning share this single visibility controller.
          event.preventDefault();
          event.stopPropagation();
          if (pinned.current) close();
          else {
            pinned.current = true;
            show();
          }
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      <div
        ref={panel}
        id={id}
        role="tooltip"
        popover="auto"
        className="board-field-help-popover"
        onToggle={() => {
          const visible = panel.current?.matches(':popover-open') ?? false;
          opened.current = visible;
          if (!visible) pinned.current = false;
          setOpen(visible);
        }}
        onPointerEnter={clearLeave}
        onPointerLeave={leave}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </>
  );
}
