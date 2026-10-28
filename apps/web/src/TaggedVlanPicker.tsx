import { useId, useRef, useState } from 'react';
import type { Vlan } from '../../../packages/shared/src/index.js';
import { vlanColor } from './visual/model.js';
import './tagged-vlan.css';

export function TaggedVlanPicker({
  label,
  vlans,
  value,
  onChange,
  disabled = false,
  invalid = false,
  errorId,
}: {
  label: string;
  vlans: Vlan[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  errorId?: string | undefined;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [candidate, setCandidate] = useState('');
  const [open, setOpen] = useState(false);
  const choices = vlans
    .filter((vlan) => !value.includes(vlan.id))
    .sort((a, b) => a.vlanId - b.vlanId);
  return (
    <div className="tagged-vlan-picker">
      <button
        type="button"
        className="tagged-vlan-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        disabled={disabled}
        popoverTarget={id}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const popup = panel.current;
          if (!popup) return;
          const width = Math.min(340, window.innerWidth - 24);
          popup.style.width = `${width}px`;
          popup.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
          popup.style.top = `${Math.max(12, Math.min(box.bottom + 4, window.innerHeight - Math.min(360, window.innerHeight - 24) - 12))}px`;
        }}
      >
        {value.length
          ? value
              .map(
                (key) =>
                  vlans.find((vlan) => vlan.id === key)?.vlanId ??
                  'Unavailable',
              )
              .join(', ')
          : 'None'}
        <span aria-hidden="true"> ▾</span>
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="dialog"
        aria-label={`${label} picker`}
        className="tagged-vlan-popover"
        onToggle={() =>
          setOpen(panel.current?.matches(':popover-open') ?? false)
        }
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <h4>Tagged VLANs</h4>
        <div className="tagged-vlan-selected">
          {value.length ? (
            value.map((key) => {
              const vlan = vlans.find((item) => item.id === key);
              return (
                <div className="tagged-vlan-chip" key={key}>
                  <span
                    style={{ borderColor: vlan ? vlanColor(vlan) : '#788790' }}
                  >
                    {vlan
                      ? `${vlan.vlanId} · ${vlan.name || 'Unnamed'}`
                      : 'Unavailable VLAN'}
                  </span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove VLAN ${vlan?.vlanId ?? key}`}
                    onClick={() =>
                      onChange(value.filter((item) => item !== key))
                    }
                  >
                    ×
                  </button>
                </div>
              );
            })
          ) : (
            <p>No tagged VLANs</p>
          )}
        </div>
        <div className="tagged-vlan-add">
          <select
            aria-label={`${label} to add`}
            disabled={disabled || !choices.length}
            value={
              choices.some((item) => item.id === candidate) ? candidate : ''
            }
            onChange={(event) => setCandidate(event.target.value)}
          >
            <option value="">
              {choices.length ? 'Choose VLAN to add' : 'All VLANs added'}
            </option>
            {choices.map((vlan) => (
              <option value={vlan.id} key={vlan.id}>
                {vlan.vlanId} · {vlan.name || 'Unnamed'}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={
              disabled || !choices.some((item) => item.id === candidate)
            }
            onClick={() => {
              onChange([...value, candidate]);
              setCandidate('');
            }}
          >
            Add VLAN
          </button>
        </div>
        <div className="tagged-vlan-actions">
          <button
            type="button"
            disabled={disabled || !value.length}
            onClick={() => onChange([])}
          >
            Clear all
          </button>
          <button type="button" onClick={() => panel.current?.hidePopover()}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
