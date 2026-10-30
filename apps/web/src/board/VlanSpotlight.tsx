import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { BoardDocument } from '../../../../packages/shared/src/board.js';
import { discoverVlans, normalizeVlan } from './vlan-spotlight.js';
import './vlan-spotlight.css';

interface Props {
  document: BoardDocument;
  value: string | null;
  onChange: (vlan: string | null) => void;
  disabled?: boolean;
}
interface Position {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function VlanSpotlight({
  document: board,
  value,
  onChange,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [position, setPosition] = useState<Position | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const vlans = useMemo(
    () => discoverVlans({ ports: board.ports, elements: board.elements }),
    [board.ports, board.elements],
  );
  const active = value !== null && normalizeVlan(value) !== '';
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const measure = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0,
      width = viewport?.width ?? window.innerWidth,
      height = viewport?.height ?? window.innerHeight;
    const panelWidth = Math.min(304, Math.max(0, width - 16));
    const below = top + height - rect.bottom - 16;
    const panelTop = below >= 160 ? rect.bottom + 8 : top + 8;
    setPosition({
      left: Math.max(
        left + 8,
        Math.min(rect.left, left + width - panelWidth - 8),
      ),
      top: panelTop,
      width: panelWidth,
      maxHeight: Math.max(0, Math.min(420, top + height - panelTop - 8)),
    });
  }, []);
  useEffect(() => {
    if (!open || disabled) return;
    const frame = requestAnimationFrame(() => firstChoice.current?.focus());
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [open, disabled, close, measure]);
  useEffect(() => {
    if (!disabled) return;
    const frame = requestAnimationFrame(() => setOpen(false));
    return () => cancelAnimationFrame(frame);
  }, [disabled]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = panel.current;
      const field = container?.querySelector('input');
      if (!container || !field || document.activeElement !== field) return;
      const bounds = container.getBoundingClientRect();
      const input = field.getBoundingClientRect();
      if (input.bottom > bounds.bottom - 8)
        container.scrollTop += input.bottom - bounds.bottom + 8;
      else if (input.top < bounds.top + 8)
        container.scrollTop -= bounds.top - input.top + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [position]);
  function choose(vlan: string | null) {
    onChange(vlan === null ? null : normalizeVlan(vlan) || null);
    close(true);
  }
  return (
    <div className="vlan-spotlight">
      <button
        ref={trigger}
        type="button"
        className="vlan-spotlight-trigger"
        aria-label="VLAN Spotlight"
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        aria-controls={open && !disabled ? panelId : undefined}
        aria-pressed={active}
        title="VLAN Spotlight"
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setDraft(value ?? '');
            measure();
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path
            d="m10 2 8 4-8 4-8-4 8-4Zm-8 8 8 4 8-4M2 14l8 4 8-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {active && (
        <div className="vlan-spotlight-status">
          <span className="vlan-spotlight-active" role="status">
            <span title={`VLAN ${value}`}>VLAN {value}</span>
            <button
              type="button"
              aria-label="Clear Spotlight"
              title="Clear Spotlight"
              disabled={disabled}
              onClick={() => choose(null)}
            >
              ×
            </button>
          </span>
          <span className="vlan-spotlight-legend" aria-label="Spotlight legend">
            <span>
              <i className="spotlight-key-native" />
              Native/Untagged
            </span>
            <span>
              <i className="spotlight-key-tagged" />
              Tagged
            </span>
            <span>
              <i className="spotlight-key-both" />
              Both
            </span>
          </span>
        </div>
      )}
      {open &&
        !disabled &&
        position &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            className="vlan-spotlight-panel"
            role="dialog"
            aria-label="VLAN Spotlight"
            style={position}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>VLAN Spotlight</h2>
              <button
                type="button"
                aria-label="Close VLAN Spotlight"
                onClick={() => close(true)}
              >
                ×
              </button>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                choose(draft);
              }}
            >
              <label htmlFor={`${panelId}-value`}>VLAN ID</label>
              <div>
                <input
                  id={`${panelId}-value`}
                  type="text"
                  autoComplete="off"
                  maxLength={10000}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit">Apply</button>
              </div>
            </form>
            <div className="vlan-spotlight-choices">
              <button
                ref={firstChoice}
                type="button"
                aria-pressed={!active}
                onClick={() => choose(null)}
              >
                All VLANs
              </button>
              {vlans.map((vlan) => (
                <button
                  key={vlan}
                  type="button"
                  title={`VLAN ${vlan}`}
                  aria-pressed={active && normalizeVlan(value) === vlan}
                  onClick={() => choose(vlan)}
                >
                  VLAN {vlan}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
