import { useState } from 'react';
import type {
  BoardElement,
  JsonValue,
} from '../../../../packages/shared/src/board.js';
import { annotationPresentation } from './annotations.js';
import './annotations.css';

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={editing ? draft : String(value)}
        onFocus={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number(text);
          if (text && Number.isFinite(next) && next >= min && next <= max)
            onChange(next);
        }}
        onBlur={() => {
          const parsed = draft.trim() ? Number(draft) : value;
          const next = Number.isFinite(parsed)
            ? Math.max(min, Math.min(max, parsed))
            : value;
          setDraft(String(next));
          setEditing(false);
          if (next !== value) onChange(next);
        }}
      />
    </label>
  );
}

export function AnnotationInspector({
  element,
  onChange,
}: {
  element: BoardElement;
  onChange: (changes: Partial<BoardElement>, key: string) => void;
}) {
  const settings = annotationPresentation(element);
  const property = (key: string, value: JsonValue) =>
    onChange({ properties: { ...element.properties, [key]: value } }, key);
  const colorField = (label: string, key: string, value: string) => (
    <label>
      {label}
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => property(key, event.target.value)}
      />
    </label>
  );
  const numberField = (
    label: string,
    key: string,
    value: number,
    min: number,
    max: number,
    step = 1,
  ) => (
    <NumberField
      key={`${element.id}:${key}`}
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(next) => property(key, next)}
    />
  );
  const opacity = (
    <NumberField
      key={`${element.id}:fillOpacity`}
      label="Fill opacity (%)"
      value={Math.round(settings.fillOpacity * 100)}
      min={0}
      max={100}
      onChange={(next) => property('fillOpacity', next / 100)}
    />
  );
  return (
    <section
      className="board-annotation-properties"
      aria-label="Annotation properties"
    >
      {element.type === 'text' ? (
        <>
          <label>
            Text
            <textarea
              aria-label="Text"
              rows={3}
              maxLength={10000}
              value={settings.text}
              onChange={(event) => property('text', event.target.value)}
            />
          </label>
          <div className="board-inspector-field-pair">
            {numberField('Font size', 'fontSize', settings.fontSize, 10, 120)}
            {colorField('Text color', 'textColor', settings.textColor)}
          </div>
          <label>
            Alignment
            <select
              aria-label="Alignment"
              value={settings.align}
              onChange={(event) => property('align', event.target.value)}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label className="board-annotation-check">
            <input
              type="checkbox"
              aria-label="Show background"
              checked={Boolean(settings.backgroundColor)}
              onChange={(event) =>
                property(
                  'backgroundColor',
                  event.target.checked ? '#24332b' : '',
                )
              }
            />
            Background
          </label>
          {settings.backgroundColor &&
            colorField(
              'Background color',
              'backgroundColor',
              settings.backgroundColor,
            )}
        </>
      ) : (
        <>
          <label>
            Label
            <input
              aria-label="Label"
              maxLength={240}
              value={element.name}
              onChange={(event) =>
                onChange({ name: event.target.value }, 'name')
              }
            />
          </label>
          {element.type === 'arrow' ? (
            <>
              <div className="board-inspector-field-pair">
                {colorField('Line color', 'strokeColor', settings.strokeColor)}
                {numberField(
                  'Line width',
                  'strokeWidth',
                  settings.strokeWidth,
                  1,
                  16,
                )}
              </div>
              <label className="board-annotation-check">
                <input
                  type="checkbox"
                  aria-label="Arrowhead"
                  checked={settings.arrowhead}
                  onChange={(event) =>
                    property('arrowhead', event.target.checked)
                  }
                />
                Arrowhead
              </label>
            </>
          ) : (
            <>
              {element.type === 'rectangle' && (
                <label className="board-annotation-check">
                  <input
                    type="checkbox"
                    aria-label="Show fill"
                    checked={Boolean(settings.fillColor)}
                    onChange={(event) =>
                      property(
                        'fillColor',
                        event.target.checked ? '#4a9b6b' : '',
                      )
                    }
                  />
                  Fill
                </label>
              )}
              {(settings.fillColor || element.type === 'highlight') && (
                <div className="board-inspector-field-pair">
                  {colorField(
                    'Fill color',
                    'fillColor',
                    settings.fillColor || '#4a9b6b',
                  )}
                  {opacity}
                </div>
              )}
              <div className="board-inspector-field-pair">
                {colorField(
                  'Border color',
                  'strokeColor',
                  settings.strokeColor,
                )}
                {numberField(
                  'Border width',
                  'strokeWidth',
                  settings.strokeWidth,
                  0,
                  16,
                )}
              </div>
              {numberField(
                'Corner radius',
                'cornerRadius',
                settings.cornerRadius,
                0,
                80,
              )}
            </>
          )}
          {colorField('Label color', 'textColor', settings.textColor)}
        </>
      )}
    </section>
  );
}
