import { useMemo, useState } from 'react';
import type {
  BoardDocument,
  BoardElement,
  BoardPort,
} from '../../../../packages/shared/src/board.js';
import { resolveBoardPortColor } from '../../../../packages/shared/src/board.js';
import { Connector } from '../visual/Connector.js';
import { addPorts } from './commands.js';
import { PORT_HEIGHT, PORT_WIDTH, portGap } from './geometry.js';
import {
  addPortBank,
  applyPortLayout,
  generatePortSlots,
  previewPortBank,
  previewPortLayout,
  type PortLayoutOptions,
  type PortLayoutPreset,
} from './port-layout.js';
import './port-layout.css';

const connectors: { kind: BoardPort['kind']; label: string }[] = [
  { kind: 'rj45', label: 'RJ45' },
  { kind: 'sfp', label: 'SFP' },
  { kind: 'sfp_plus', label: 'SFP+' },
  { kind: 'qsfp', label: 'QSFP' },
  { kind: 'other', label: 'Custom' },
];
const presets: { value: PortLayoutPreset; label: string }[] = [
  { value: 'single-row', label: 'Single row' },
  { value: 'odd-top', label: 'Stacked — Odd on top' },
  { value: 'odd-bottom', label: 'Stacked — Odd on bottom' },
  { value: 'sequential', label: 'Sequential rows' },
];
type PreviewPort = Pick<
  BoardPort,
  'id' | 'name' | 'kind' | 'row' | 'column'
> & {
  color: string;
};

function attempt<T>(calculate: () => T): { value: T | null; error: string } {
  try {
    return { value: calculate(), error: '' };
  } catch (cause) {
    return {
      value: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function LayoutPreview({
  ports,
  options,
  gap,
  label,
  miniature = false,
}: {
  ports: PreviewPort[];
  options: PortLayoutOptions;
  gap: number;
  label: string;
  miniature?: boolean;
}) {
  if (!ports.length) return null;
  // Crop empty leading bank offsets, while preserving the pattern's empty
  // slots and the same device-relative proportions at every viewport width.
  const row = options.row ?? 0;
  const column = options.column ?? 0;
  const columns = Math.max(...ports.map((port) => port.column)) - column + 1;
  const rows = Math.max(...ports.map((port) => port.row)) - row + 1;
  const scale = miniature ? 0.18 : 0.5;
  const stepX = (PORT_WIDTH + gap) * scale;
  const stepY = (PORT_HEIGHT + gap) * scale;
  return (
    <div
      className={`port-layout-preview${miniature ? ' port-layout-miniature' : ''}`}
      role="group"
      aria-label={label}
    >
      <div
        className="port-layout-preview-grid"
        style={{ width: columns * stepX, height: rows * stepY }}
      >
        {ports.map((port) => (
          <div
            key={port.id}
            className="port-layout-preview-port"
            data-preview-port-id={port.id}
            data-row={port.row}
            data-column={port.column}
            data-connector-kind={port.kind}
            data-port-name={port.name}
            title={`${port.name} · Row ${port.row + 1}, Column ${port.column + 1}`}
            style={{
              left: (port.column - column) * stepX,
              top: (port.row - row) * stepY,
              width: PORT_WIDTH * scale,
            }}
          >
            <Connector kind={port.kind} color={port.color || '#84958d'} />
            <span>{port.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PortLayoutEditor({
  document,
  element,
  onChange,
  onError,
}: {
  document: BoardDocument;
  element: BoardElement;
  onChange: (document: BoardDocument, label: string) => void;
  onError: (message: string) => void;
}) {
  const [count, setCount] = useState('1');
  const [columns, setColumns] = useState('');
  const [preset, setPreset] = useState<PortLayoutPreset | 'default'>('default');
  const [kind, setKind] = useState<BoardPort['kind']>('rj45');
  const [startingNumber, setStartingNumber] = useState('');
  const [prefix, setPrefix] = useState('Port ');
  const [startRow, setStartRow] = useState('1');
  const [startColumn, setStartColumn] = useState('1');
  const face = element.properties.face === 'rear' ? 'rear' : 'front';
  const devicePorts = document.ports.filter(
    (port) => port.deviceId === element.id,
  );
  const facePorts = devicePorts.filter((port) => port.face === face);
  const number =
    startingNumber === '' ? devicePorts.length + 1 : Number(startingNumber);
  const options: PortLayoutOptions = useMemo(
    () => ({
      preset: preset === 'default' ? 'single-row' : preset,
      columns:
        preset !== 'single-row' && columns.trim() ? Number(columns) : undefined,
      row: Number(startRow) - 1,
      column: Number(startColumn) - 1,
    }),
    [preset, columns, startRow, startColumn],
  );
  const bank = useMemo(
    () =>
      preset === 'default'
        ? null
        : attempt(() =>
            previewPortBank(
              document,
              element.id,
              kind,
              Number(count),
              face,
              options,
              number,
              prefix,
            ),
          ),
    [document, element.id, kind, count, face, options, number, prefix, preset],
  );
  const rawBank = useMemo(
    () =>
      preset === 'default'
        ? null
        : attempt(() =>
            generatePortSlots(Number(count), options, number).map(
              (slot, index) => ({
                ...slot,
                id: `new-${index}`,
                kind,
                color: '',
                name: `${prefix}${number + index}`,
              }),
            ),
          ),
    [preset, count, options, number, kind, prefix],
  );
  const existing = useMemo(
    () =>
      preset === 'default' || !facePorts.length
        ? null
        : attempt(() => previewPortLayout(document, element.id, face, options)),
    [document, element.id, face, options, preset, facePorts.length],
  );
  const rawExisting =
    preset === 'default' || !facePorts.length
      ? null
      : attempt(() =>
          generatePortSlots(facePorts.length, options).map((slot, index) => ({
            ...facePorts[index]!,
            ...slot,
          })),
        );
  const colorExisting = (ports: BoardPort[]) =>
    ports.map((port) => ({
      ...port,
      color: resolveBoardPortColor(document, port),
    }));
  function commit(action: () => BoardDocument, label: string) {
    try {
      onChange(action(), label);
      onError('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function field(
    label: string,
    value: string,
    update: (value: string) => void,
    min?: number,
  ) {
    return (
      <label className="port-layout-field">
        <span>{label}</span>
        <input
          aria-label={label}
          type={min === undefined ? 'text' : 'number'}
          min={min}
          maxLength={min === undefined ? 240 : undefined}
          value={value}
          onChange={(event) => update(event.target.value)}
        />
      </label>
    );
  }
  return (
    <div className="port-layout-editor">
      {preset === 'default' && (
        <div className="board-port-picker" aria-label="Port picker">
          {connectors.map((connector) => (
            <button
              type="button"
              key={connector.kind}
              draggable
              title={`Drag ${connector.label} onto a slot, or click to add`}
              aria-label={`Add ${connector.label} ports`}
              onDragStart={(event) =>
                event.dataTransfer.setData(
                  'application/x-portfolio-port-kind',
                  JSON.stringify({
                    kind: connector.kind,
                    deviceId: element.id,
                  }),
                )
              }
              onClick={() =>
                commit(
                  () =>
                    addPorts(
                      document,
                      element.id,
                      connector.kind,
                      Number(count),
                      face,
                      columns.trim() ? Number(columns) : undefined,
                    ),
                  'Add ports',
                )
              }
            >
              {connector.label}
            </button>
          ))}
        </div>
      )}
      <div className="port-layout-fields">
        {field('Port quantity', count, setCount, 1)}
        {preset !== 'single-row' &&
          field('Ports per row', columns, setColumns, 1)}
      </div>
      <label className="port-layout-field">
        <span>Layout preset</span>
        <select
          aria-label="Layout preset"
          value={preset}
          onChange={(event) => {
            setPreset(event.target.value as PortLayoutPreset | 'default');
            onError('');
          }}
        >
          <option value="default">Default placement</option>
          {presets.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {preset !== 'default' && (
        <>
          <details className="port-layout-comparison">
            <summary>Compare layouts</summary>
            <div className="port-layout-presets">
              {presets.map((item) => {
                const miniatureOptions = { preset: item.value, columns: 4 };
                const ports = generatePortSlots(8, miniatureOptions).map(
                  (slot, index) => ({
                    ...slot,
                    id: `sample-${index}`,
                    kind,
                    name: String(index + 1),
                    color: '',
                  }),
                );
                return (
                  <button
                    type="button"
                    key={item.value}
                    aria-label={`Preview ${item.label}`}
                    aria-pressed={preset === item.value}
                    onClick={() => setPreset(item.value)}
                  >
                    <span>{item.label}</span>
                    <LayoutPreview
                      ports={ports}
                      options={miniatureOptions}
                      gap={8}
                      label={`${item.label} example`}
                      miniature
                    />
                  </button>
                );
              })}
            </div>
          </details>
          <label className="port-layout-field">
            <span>Connector type</span>
            <select
              aria-label="Connector type"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as BoardPort['kind'])
              }
            >
              {connectors.map((connector) => (
                <option key={connector.kind} value={connector.kind}>
                  {connector.label}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>Bank placement</summary>
            <div className="port-layout-fields">
              {field(
                'Starting number',
                startingNumber === ''
                  ? String(devicePorts.length + 1)
                  : startingNumber,
                setStartingNumber,
                0,
              )}
              {field('Label prefix', prefix, setPrefix)}
              {field('Start row', startRow, setStartRow, 1)}
              {field('Start column', startColumn, setStartColumn, 1)}
            </div>
          </details>
          <LayoutPreview
            ports={rawBank?.value ?? []}
            options={options}
            gap={portGap(element)}
            label="New port layout preview"
          />
          {bank?.error && (
            <p className="port-layout-error" role="status">
              {bank.error}
            </p>
          )}
          <button
            type="button"
            className="port-layout-action"
            disabled={!bank?.value}
            onClick={() =>
              commit(
                () =>
                  addPortBank(
                    document,
                    element.id,
                    kind,
                    Number(count),
                    face,
                    options,
                    number,
                    prefix,
                  ),
                'Add port bank',
              )
            }
          >
            Add port bank
          </button>
          {!!facePorts.length && (
            <details>
              <summary>Arrange existing ports</summary>
              <p className="port-layout-note">
                Names stay unchanged; placement follows creation order.
              </p>
              <LayoutPreview
                ports={colorExisting(
                  existing?.value ?? rawExisting?.value ?? [],
                )}
                options={options}
                gap={portGap(element)}
                label="Existing port layout preview"
              />
              {existing?.error && (
                <p className="port-layout-error" role="status">
                  {existing.error}
                </p>
              )}
              <button
                type="button"
                className="port-layout-action"
                disabled={!existing?.value}
                onClick={() =>
                  commit(
                    () => applyPortLayout(document, element.id, face, options),
                    'Apply port layout',
                  )
                }
              >
                Apply layout
              </button>
            </details>
          )}
        </>
      )}
    </div>
  );
}
