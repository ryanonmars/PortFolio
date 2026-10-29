import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fitDeviceHeaderFields,
  DEVICE_HEADER_CHIP_GAP as GAP,
  type DeviceHeaderField,
  type DeviceHeaderPlacement,
} from './device-header-fields.js';
import { FieldHelp } from './FieldHelp.js';
import './device-header.css';

/** Presentation only: fitting never changes the device or its port geometry. */
export function DeviceHeader({
  name,
  nameText,
  faceControls,
  fields,
}: {
  name: ReactNode;
  nameText: string;
  faceControls: ReactNode;
  fields: DeviceHeaderField[];
}) {
  const content = useRef<HTMLDivElement>(null);
  const nameBox = useRef<HTMLDivElement>(null);
  const faces = useRef<HTMLDivElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const [layout, setLayout] = useState<{
    compact: boolean;
    placements: DeviceHeaderPlacement[];
  }>({ compact: false, placements: [] });
  const fieldKey = JSON.stringify(fields);

  useLayoutEffect(() => {
    const box = content.current;
    const measureBox = measurements.current;
    if (!box || !measureBox) return;
    let active = true;
    function fit() {
      if (!active || !box || !measureBox) return;
      // Logical dimensions deliberately ignore board zoom.
      const width = box.clientWidth;
      const nameElement = nameBox.current?.querySelector<HTMLElement>(
        '.board-element-name,.board-inline-name',
      );
      const text = nameText;
      const context = document.createElement('canvas').getContext('2d');
      let nameWidth = 0;
      if (context && nameElement) {
        const font = getComputedStyle(nameElement);
        context.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        nameWidth = Math.min(
          context.measureText(text).width,
          context.measureText(text.slice(0, 12) + '…').width,
        );
      }
      const compact =
        nameWidth + (faces.current?.offsetWidth ?? 0) + GAP > width;
      const sizes = Array.from(
        measureBox.querySelectorAll<HTMLSpanElement>(
          '.board-device-info-measure-chip',
        ),
        (chip) => ({
          ideal: Math.ceil(parseFloat(getComputedStyle(chip).width)),
        }),
      );
      let placements = compact ? [] : fitDeviceHeaderFields(sizes, width);
      if (placements.length < sizes.length && !compact)
        placements = fitDeviceHeaderFields(
          sizes,
          Math.max(0, width - 24 - GAP),
        );
      const next = { compact, placements };
      setLayout((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    observer.observe(measureBox);
    if (faces.current) observer.observe(faces.current);
    void document.fonts?.ready.then(() => {
      if (active) fit();
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [fieldKey, nameText]);

  const hidden = fields.slice(layout.placements.length);
  return (
    <div
      ref={content}
      className="board-device-header-content"
      data-compact={layout.compact}
      data-overflow={hidden.length > 0}
    >
      <div className="board-device-header-top">
        <div ref={nameBox} className="board-device-header-name">
          {name}
        </div>
        <div ref={faces} className="board-device-header-faces">
          {faceControls}
        </div>
      </div>
      <div
        className="board-device-info"
        role="group"
        aria-label="Device information"
      >
        {layout.placements.map(({ index, x, y, width }) => {
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
      {hidden.length > 0 && (
        <div
          className="board-device-info-overflow"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <FieldHelp
            id={popupId}
            label="device information"
            triggerLabel="Device information"
          >
            <dl className="board-device-information-details">
              {hidden.map((field) => (
                <div key={field.key} data-field={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </FieldHelp>
        </div>
      )}
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
