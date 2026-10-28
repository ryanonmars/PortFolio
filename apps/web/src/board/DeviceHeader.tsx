import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  fitDeviceHeaderFields,
  DEVICE_HEADER_CHIP_HEIGHT as CHIP_HEIGHT,
  DEVICE_HEADER_CHIP_GAP as GAP,
  type DeviceHeaderField,
  type DeviceHeaderPlacement,
} from './device-header-fields.js';
import './device-header.css';

/** Fits presentation only. Device geometry and saved records never enter this state. */
export function DeviceHeader({
  name,
  faceControls,
  fields,
}: {
  name: ReactNode;
  faceControls: ReactNode;
  fields: DeviceHeaderField[];
}) {
  const area = useRef<HTMLDivElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const [placements, setPlacements] = useState<DeviceHeaderPlacement[]>([]);
  const fieldKey = JSON.stringify(fields);

  useLayoutEffect(() => {
    const box = area.current;
    const measureBox = measurements.current;
    if (!box || !measureBox) return;
    let active = true;
    function fit() {
      if (!active || !box || !measureBox) return;
      // client/offset dimensions deliberately ignore the board's CSS zoom transform.
      const width = box.clientWidth;
      const rows = Math.min(
        2,
        Math.floor((box.clientHeight + GAP) / (CHIP_HEIGHT + GAP)),
      );
      const chips = measureBox.querySelectorAll<HTMLSpanElement>(
        '.board-device-info-measure-chip',
      );
      const sizes = Array.from(chips, (chip) => ({
        ideal: chip.offsetWidth,
        minimum:
          Math.min(
            chip.querySelector<HTMLSpanElement>('.board-device-info-label')
              ?.offsetWidth ?? 0,
            80,
          ) + 31,
      }));
      const next = fitDeviceHeaderFields(sizes, width, rows);
      setPlacements((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    observer.observe(measureBox);
    void document.fonts?.ready.then(() => {
      if (active) fit();
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [fieldKey]);

  return (
    <div className="board-device-header-content">
      <div className="board-device-header-top">
        <div className="board-device-header-name">{name}</div>
        <div className="board-device-header-faces">{faceControls}</div>
      </div>
      <div
        ref={area}
        className="board-device-info"
        role="group"
        aria-label="Device information"
      >
        {placements.map(({ index, x, y, width }) => {
          const field = fields[index];
          return (
            field && (
              <span
                key={field.key}
                className="board-device-info-chip"
                data-field={field.key}
                title={`${field.label}: ${field.value}`}
                style={{ left: x, top: y, width }}
              >
                <span className="board-device-info-label">{field.label}</span>
                <span className="board-device-info-value">{field.value}</span>
              </span>
            )
          );
        })}
      </div>
      <div
        ref={measurements}
        className="board-device-info-measure"
        aria-hidden="true"
      >
        {fields.map((field) => (
          <span key={field.key} className="board-device-info-measure-chip">
            <span className="board-device-info-label">{field.label}</span>
            <span className="board-device-info-value">{field.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
