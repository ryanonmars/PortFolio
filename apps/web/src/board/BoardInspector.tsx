import { useEffect, useRef, useState, useId, type ReactNode } from 'react';
import {
  minimumBoardDeviceSize,
  boardPortCapacity,
  boardPortLayout,
  networkDisplayFields,
  normalizeNetworkEntry,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';
import type { BoardSelection } from './BoardCanvas.js';
import { addPorts } from './commands.js';
import {
  deviceHeaderFieldDefinitions,
  deviceHeaderFieldOrder,
  type DeviceHeaderFieldKey,
} from './device-header-fields.js';
import { FieldHelp } from './FieldHelp.js';
import {
  knownLinkStatus,
  portHelp,
  purposeSuggestions,
  speedSuggestions,
  type PortHelpLabel,
} from './port-fields.js';

type Props = {
  document: BoardDocument;
  selection: BoardSelection;
  onChange: (doc: BoardDocument, label: string) => void;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
};
const kinds: BoardPort['kind'][] = ['rj45', 'sfp', 'sfp_plus', 'qsfp', 'other'];
const kindNames = ['RJ45', 'SFP', 'SFP+', 'QSFP', 'Custom'];
const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function BoardInspector({
  document,
  selection,
  onChange,
  onClose,
  onDelete,
  onDuplicate,
}: Props) {
  const [error, setError] = useState('');
  const fieldPrefix = useId();
  const [count, setCount] = useState('1');
  const [portsPerRow, setPortsPerRow] = useState('');
  const element = document.elements.find((item) => item.id === selection.id);
  const port = document.ports.find((item) => item.id === selection.id);
  const cable = document.cables.find((item) => item.id === selection.id);
  function changeElement(changes: Partial<BoardElement>, key: string) {
    if (!element) return;
    const next = { ...element, ...changes };
    if (next.type === 'device') {
      const minimum = minimumBoardDeviceSize(next, document.ports);
      if (
        minimum.width > boardPortLayout.maxDeviceSize ||
        minimum.height > boardPortLayout.maxDeviceSize
      ) {
        setError('This spacing exceeds the supported device size.');
        return;
      }
      next.width = Math.max(next.width, minimum.width);
      next.height = Math.max(next.height, minimum.height);
    }
    onChange(
      {
        ...document,
        elements: document.elements.map((item) =>
          item.id === element.id ? next : item,
        ),
      },
      `Property:${element.id}:${key}`,
    );
  }
  function property(key: string, value: JsonValue) {
    if (element)
      changeElement(
        { properties: { ...element.properties, [key]: value } },
        key,
      );
  }
  function changeHeaderFields(headerFields: DeviceHeaderFieldKey[]) {
    if (!element || element.type !== 'device') return;
    onChange(
      {
        ...document,
        elements: document.elements.map((item) =>
          item.id === element.id
            ? { ...item, properties: { ...item.properties, headerFields } }
            : item,
        ),
      },
      `Property:${element.id}:headerFields`,
    );
  }
  function changePort(changes: Partial<BoardPort>, key: string) {
    if (!port) return;
    const next = { ...port, ...changes };
    if (
      document.ports.some(
        (item) =>
          item.id !== port.id &&
          item.deviceId === next.deviceId &&
          item.face === next.face &&
          item.row === next.row &&
          item.column === next.column,
      )
    ) {
      if (changes.face) {
        const owner = document.elements.find(
          (item) => item.id === port.deviceId,
        )!;
        const capacity = boardPortCapacity(owner);
        let slot = 0;
        while (
          slot < capacity.rows * capacity.columns &&
          document.ports.some(
            (item) =>
              item.id !== port.id &&
              item.deviceId === port.deviceId &&
              item.face === next.face &&
              item.row === Math.floor(slot / capacity.columns) &&
              item.column === slot % capacity.columns,
          )
        )
          slot++;
        if (slot >= capacity.rows * capacity.columns) {
          setError('Resize the device to make room on that face.');
          return;
        }
        const columns = capacity.columns;
        next.row = Math.floor(slot / columns);
        next.column = slot % columns;
      } else {
        setError('That slot is occupied.');
        return;
      }
    }
    const ports = document.ports.map((item) =>
      item.id === port.id ? next : item,
    );
    const owner = document.elements.find((item) => item.id === port.deviceId)!;
    const capacity = boardPortCapacity(owner);
    if (next.row >= capacity.rows || next.column >= capacity.columns) {
      setError('Resize the device to make room for that slot.');
      return;
    }
    const minimum = minimumBoardDeviceSize(owner, ports);
    onChange(
      {
        ...document,
        ports,
        elements: document.elements.map((item) =>
          item.id === owner.id
            ? {
                ...item,
                width: Math.max(item.width, minimum.width),
                height: Math.max(item.height, minimum.height),
              }
            : item,
        ),
      },
      `Property:${port.id}:${key}`,
    );
    setError('');
  }
  function input(
    label: string,
    value: string | number,
    update: (value: string) => void,
    type = 'text',
  ) {
    return (
      <label key={label}>
        {label}
        <input
          aria-label={label}
          type={type}
          value={value}
          onChange={(event) => update(event.target.value)}
        />
      </label>
    );
  }
  function helpedField(
    label: PortHelpLabel,
    render: (id: string, helpId: string) => ReactNode,
  ) {
    const id = `${fieldPrefix}-${label.replace(/[^a-z0-9]/gi, '-')}`;
    const helpId = `${id}-help`;
    return (
      <div className="board-inspector-field">
        <div className="board-field-label">
          <label htmlFor={id}>{label}</label>
          <FieldHelp id={helpId} label={label}>
            {portHelp[label]}
          </FieldHelp>
        </div>
        {render(id, helpId)}
      </div>
    );
  }
  function portInput(
    label: PortHelpLabel,
    value: string,
    update: (value: string) => void,
    suggestions?: string[],
  ) {
    return helpedField(label, (id, helpId) => (
      <>
        <input
          id={id}
          aria-label={label}
          aria-describedby={helpId}
          value={value}
          list={suggestions ? `${id}-suggestions` : undefined}
          onChange={(event) => update(event.target.value)}
        />
        {suggestions && (
          <datalist id={`${id}-suggestions`}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        )}
      </>
    ));
  }
  function notes(
    label: string,
    value: string,
    update: (value: string) => void,
  ) {
    return (
      <label>
        {label}
        <textarea
          aria-label={label}
          rows={3}
          value={value}
          onChange={(event) => update(event.target.value)}
        />
      </label>
    );
  }
  function custom(
    fields: Record<string, JsonValue>,
    update: (fields: Record<string, JsonValue>) => void,
  ) {
    return <CustomProperties fields={fields} onChange={update} />;
  }
  const title =
    element?.name ||
    port?.name ||
    cable?.name ||
    (cable ? 'Cable' : 'Properties');
  const entries =
    element?.type === 'network' && Array.isArray(element.properties.entries)
      ? element.properties.entries.map((entry) =>
          normalizeNetworkEntry(record(entry)),
        )
      : [];
  const updateEntries = (next: Record<string, JsonValue>[]) =>
    property('entries', next);
  return (
    <aside className="board-inspector" aria-label="Object inspector">
      <header>
        <div>
          <span>{element?.type ?? (port ? 'Port' : 'Cable')}</span>
          <h2>{title}</h2>
        </div>
        <button aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="board-inspector-body">
        {error && <p role="alert">{error}</p>}
        {element && (
          <>
            {input(
              element.type === 'network' ? 'Network container name' : 'Name',
              element.name,
              (name) => changeElement({ name }, 'name'),
            )}
            {input(
              'Container color',
              element.color || '#24332b',
              (color) => changeElement({ color }, 'color'),
              'color',
            )}
            {element.type === 'summary' && (
              <label>
                Linked Device
                <select
                  aria-label="Linked Device"
                  value={String(element.properties.linkedDeviceId ?? '')}
                  onChange={(event) =>
                    property('linkedDeviceId', event.target.value)
                  }
                >
                  <option value="">None</option>
                  {typeof element.properties.linkedDeviceId === 'string' &&
                    element.properties.linkedDeviceId &&
                    !document.elements.some(
                      (item) =>
                        item.id === element.properties.linkedDeviceId &&
                        item.type === 'device',
                    ) && (
                      <option value={element.properties.linkedDeviceId}>
                        Unavailable device
                      </option>
                    )}
                  {document.elements
                    .filter((item) => item.type === 'device')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name || 'Unnamed device'}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {element.type === 'device' && (
              <>
                {input(
                  'Device type',
                  String(element.properties.deviceType ?? ''),
                  (value) => property('deviceType', value),
                )}
                {['Manufacturer', 'Model', 'Management address'].map(
                  (label) => {
                    const key =
                      label === 'Management address'
                        ? 'managementAddress'
                        : label.toLowerCase();
                    return input(
                      label,
                      String(element.properties[key] ?? ''),
                      (value) => property(key, value),
                    );
                  },
                )}
                <details className="board-device-visible-fields">
                  <summary>Visible Fields</summary>
                  {[
                    ...deviceHeaderFieldOrder(element),
                    ...deviceHeaderFieldDefinitions
                      .map((field) => field.key)
                      .filter(
                        (key) => !deviceHeaderFieldOrder(element).includes(key),
                      ),
                  ].map((key) => {
                    const field = deviceHeaderFieldDefinitions.find(
                      (item) => item.key === key,
                    )!;
                    const order = deviceHeaderFieldOrder(element);
                    const index = order.indexOf(key);
                    const move = (delta: number) => {
                      const next = [...order];
                      const target = index + delta;
                      if (index < 0 || target < 0 || target >= next.length)
                        return;
                      [next[index], next[target]] = [
                        next[target]!,
                        next[index]!,
                      ];
                      changeHeaderFields(next);
                    };
                    return (
                      <div className="board-device-field-choice" key={key}>
                        <label className="board-display-field">
                          <input
                            type="checkbox"
                            aria-label={`Show header ${field.label}`}
                            checked={index >= 0}
                            onChange={(event) =>
                              changeHeaderFields(
                                event.target.checked
                                  ? [...order, key]
                                  : order.filter((item) => item !== key),
                              )
                            }
                          />
                          {field.label}
                        </label>
                        {index >= 0 && (
                          <span className="board-device-field-priority">
                            <button
                              type="button"
                              aria-label={`Move ${field.label} earlier`}
                              title="Earlier"
                              disabled={index === 0}
                              onClick={() => move(-1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label={`Move ${field.label} later`}
                              title="Later"
                              disabled={index === order.length - 1}
                              onClick={() => move(1)}
                            >
                              ↓
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </details>
                <details open>
                  <summary>Ports</summary>
                  <div className="board-port-picker" aria-label="Port picker">
                    {kinds.map((kind, index) => (
                      <button
                        key={kind}
                        draggable
                        title={`Drag ${kindNames[index]} onto a slot, or click to add`}
                        aria-label={`Add ${kindNames[index]} ports`}
                        onDragStart={(event) =>
                          event.dataTransfer.setData(
                            'application/x-portfolio-port-kind',
                            JSON.stringify({ kind, deviceId: element.id }),
                          )
                        }
                        onClick={() => {
                          try {
                            onChange(
                              addPorts(
                                document,
                                element.id,
                                kind,
                                Number(count),
                                element.properties.face === 'rear'
                                  ? 'rear'
                                  : 'front',
                                portsPerRow.trim()
                                  ? Number(portsPerRow)
                                  : undefined,
                              ),
                              'Add ports',
                            );
                            setError('');
                          } catch (cause) {
                            setError(
                              String(
                                cause instanceof Error ? cause.message : cause,
                              ),
                            );
                          }
                        }}
                      >
                        {kindNames[index]}
                      </button>
                    ))}
                  </div>
                  {input('Port quantity', count, setCount, 'number')}
                  {input(
                    'Ports per row',
                    portsPerRow,
                    setPortsPerRow,
                    'number',
                  )}
                </details>
                <details>
                  <summary>Physical layout</summary>
                  {input(
                    'Port spacing',
                    Number(element.properties.portSpacing ?? 8),
                    (value) => {
                      if (Number(value) >= 0 && Number(value) <= 40)
                        property('portSpacing', Number(value));
                    },
                    'number',
                  )}
                </details>
              </>
            )}
            {element.type === 'network' && (
              <>
                <details>
                  <summary>Visible fields</summary>
                  {[...networkDisplayFields, 'customFields'].map((field) => {
                    const shown = Array.isArray(
                      element.properties.displayFields,
                    )
                      ? element.properties.displayFields
                      : ['vlanId', 'vlanName', 'subnet'];
                    return (
                      <label key={field} className="board-display-field">
                        <input
                          type="checkbox"
                          aria-label={`Show ${field}`}
                          checked={
                            shown.includes(field) ||
                            (field === 'dhcpServer' &&
                              shown.includes('dhcpStatus')) ||
                            (field === 'vlanName' && shown.includes('name'))
                          }
                          onChange={(event) =>
                            property(
                              'displayFields',
                              event.target.checked
                                ? [...shown, field]
                                : shown.filter(
                                    (item) =>
                                      item !== field &&
                                      !(
                                        field === 'dhcpServer' &&
                                        item === 'dhcpStatus'
                                      ) &&
                                      !(
                                        field === 'vlanName' && item === 'name'
                                      ),
                                  ),
                            )
                          }
                        />
                        {field === 'vlanId'
                          ? 'VLAN ID'
                          : field === 'vlanName'
                            ? 'VLAN name'
                            : field === 'dhcpServer'
                              ? 'DHCP Server'
                              : field === 'customFields'
                                ? 'Custom fields'
                                : field.charAt(0).toUpperCase() +
                                  field.slice(1)}
                      </label>
                    );
                  })}
                </details>
                {entries.map((entry, index) => {
                  const update = (key: string, value: JsonValue) =>
                    updateEntries(
                      entries.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, [key]: value } : item,
                      ),
                    );
                  const preserved = [
                    ['name', 'Previous entry name'],
                    ['addresses', 'Previous IP addresses'],
                    ['pvid', 'Previous PVID'],
                    ['dhcpStatus', 'Previous DHCP status'],
                  ].filter(
                    ([key]) => entry[key!] !== undefined && entry[key!] !== '',
                  );
                  const reviewDhcp =
                    typeof entry.dhcpServer !== 'boolean' && !!entry.dhcpStatus;
                  return (
                    <details
                      key={index}
                      open={entries.length === 1 || undefined}
                    >
                      <summary>
                        {String(
                          entry.vlanName ||
                            (entry.vlanId
                              ? `VLAN ${entry.vlanId}`
                              : `Entry ${index + 1}`),
                        )}
                      </summary>
                      {input('VLAN ID', String(entry.vlanId ?? ''), (value) =>
                        update('vlanId', value),
                      )}
                      {input(
                        'VLAN name',
                        String(entry.vlanName ?? ''),
                        (value) => update('vlanName', value),
                      )}
                      {input(
                        'VLAN color',
                        typeof entry.color === 'string' &&
                          /^#[0-9a-f]{6}$/i.test(entry.color)
                          ? entry.color
                          : '#549cec',
                        (value) => update('color', value),
                        'color',
                      )}
                      {input(
                        'Subnet/CIDR',
                        String(entry.subnet ?? ''),
                        (value) => update('subnet', value),
                      )}
                      {input('Gateway', String(entry.gateway ?? ''), (value) =>
                        update('gateway', value),
                      )}
                      <label className="board-display-field">
                        <input
                          type="checkbox"
                          aria-label="DHCP Server"
                          checked={entry.dhcpServer === true}
                          onChange={(event) =>
                            update('dhcpServer', event.target.checked)
                          }
                        />
                        DHCP Server
                        <span>
                          {entry.dhcpServer === true
                            ? 'On'
                            : entry.dhcpServer === false
                              ? 'Off'
                              : 'Not set'}
                        </span>
                      </label>
                      {entry.dhcpServer === true && (
                        <>
                          {input(
                            'DHCP pool start',
                            String(entry.dhcpStart ?? ''),
                            (value) => update('dhcpStart', value),
                          )}
                          {input(
                            'DHCP pool end',
                            String(entry.dhcpEnd ?? ''),
                            (value) => update('dhcpEnd', value),
                          )}
                        </>
                      )}
                      {input('DNS servers', String(entry.dns ?? ''), (value) =>
                        update('dns', value),
                      )}
                      {notes('Notes', String(entry.notes ?? ''), (value) =>
                        update('notes', value),
                      )}
                      {custom(record(entry.customFields), (fields) =>
                        update('customFields', fields),
                      )}
                      {preserved.length > 0 && (
                        <details>
                          <summary>
                            {reviewDhcp
                              ? 'Preserved fields · review DHCP'
                              : 'Preserved fields'}
                          </summary>
                          {preserved.map(([key, label]) =>
                            input(label!, String(entry[key!] ?? ''), (value) =>
                              update(key!, value),
                            ),
                          )}
                        </details>
                      )}
                      <button
                        onClick={() =>
                          updateEntries(
                            entries.filter(
                              (_item, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                      >
                        Remove entry
                      </button>
                    </details>
                  );
                })}
                <button onClick={() => updateEntries([...entries, {}])}>
                  Add network entry
                </button>
              </>
            )}
            {element.type === 'network' ? (
              <details>
                <summary>Container details</summary>
                {notes(
                  'Container notes',
                  String(element.properties.notes ?? ''),
                  (value) => property('notes', value),
                )}
                {custom(record(element.properties.customFields), (fields) =>
                  property('customFields', fields),
                )}
              </details>
            ) : element.type === 'device' ? (
              <>
                {notes(
                  'Notes',
                  String(element.properties.notes ?? ''),
                  (value) => property('notes', value),
                )}
                {custom(record(element.properties.customFields), (fields) =>
                  property('customFields', fields),
                )}
              </>
            ) : null}
          </>
        )}
        {port && (
          <>
            {input('Port name', port.name, (name) =>
              changePort({ name }, 'name'),
            )}
            <label>
              Connector type
              <select
                aria-label="Connector type"
                value={port.kind}
                onChange={(event) =>
                  changePort(
                    { kind: event.target.value as BoardPort['kind'] },
                    'kind',
                  )
                }
              >
                {kinds.map((kind, index) => (
                  <option key={kind} value={kind}>
                    {kindNames[index]}
                  </option>
                ))}
              </select>
            </label>
            {portInput(
              'Port Purpose',
              port.role,
              (role) => changePort({ role }, 'role'),
              purposeSuggestions,
            )}
            {portInput(
              'Speed',
              port.speed,
              (speed) => changePort({ speed }, 'speed'),
              speedSuggestions,
            )}
            {helpedField('Link Status', (id, helpId) => (
              <select
                id={id}
                aria-label="Link Status"
                aria-describedby={helpId}
                value={knownLinkStatus(port.linkState) ?? '__saved__'}
                onChange={(event) => {
                  if (['unknown', 'up', 'down'].includes(event.target.value))
                    changePort({ linkState: event.target.value }, 'linkState');
                }}
              >
                <option value="unknown">Unknown</option>
                <option value="up">Up</option>
                <option value="down">Down</option>
                {knownLinkStatus(port.linkState) === null && (
                  <option value="__saved__">Saved: {port.linkState}</option>
                )}
              </select>
            ))}
            {portInput('Native VLAN', port.nativeVlan, (nativeVlan) =>
              changePort({ nativeVlan }, 'nativeVlan'),
            )}
            {helpedField('Tagged VLANs', (id, helpId) => (
              <DraftText
                id={id}
                describedBy={helpId}
                label="Tagged VLANs"
                value={port.taggedVlans.join(', ')}
                onChange={(value) =>
                  changePort(
                    {
                      taggedVlans: value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    },
                    'taggedVlans',
                  )
                }
              />
            ))}
            {portInput('PVID', port.pvid, (pvid) =>
              changePort({ pvid }, 'pvid'),
            )}
            {portInput('Interface IP / Address', port.address, (address) =>
              changePort({ address }, 'address'),
            )}
            {portInput(
              'External Connection',
              port.externalDestination,
              (externalDestination) =>
                changePort({ externalDestination }, 'externalDestination'),
            )}
            {input(
              'Port color',
              port.color || '#788790',
              (color) => changePort({ color }, 'color'),
              'color',
            )}
            {port.color && (
              <button onClick={() => changePort({ color: '' }, 'color')}>
                Use network color
              </button>
            )}
            <details>
              <summary>Placement</summary>
              <label>
                Face
                <select
                  aria-label="Port face"
                  value={port.face}
                  onChange={(event) =>
                    changePort(
                      { face: event.target.value as BoardPort['face'] },
                      'face',
                    )
                  }
                >
                  <option value="front">Front</option>
                  <option value="rear">Rear</option>
                </select>
              </label>
              {input(
                'Port row',
                port.row + 1,
                (value) => {
                  if (
                    Number.isInteger(Number(value)) &&
                    Number(value) >= 1 &&
                    Number(value) <=
                      boardPortCapacity(
                        document.elements.find(
                          (item) => item.id === port.deviceId,
                        )!,
                      ).rows
                  )
                    changePort({ row: Number(value) - 1 }, 'row');
                },
                'number',
              )}
              {input(
                'Port column',
                port.column + 1,
                (value) => {
                  if (
                    Number.isInteger(Number(value)) &&
                    Number(value) >= 1 &&
                    Number(value) <=
                      boardPortCapacity(
                        document.elements.find(
                          (item) => item.id === port.deviceId,
                        )!,
                      ).columns
                  )
                    changePort({ column: Number(value) - 1 }, 'column');
                },
                'number',
              )}
            </details>
            {notes('Port notes', port.notes, (value) =>
              changePort({ notes: value }, 'notes'),
            )}
            {custom(port.customFields, (fields) =>
              changePort({ customFields: fields }, 'customFields'),
            )}
          </>
        )}
        {cable && (
          <>
            {[
              'Name',
              'Cable type',
              'Source connector',
              'Destination connector',
              'Length',
              'Notes',
            ].map((label) => {
              const key = (
                {
                  Name: 'name',
                  'Cable type': 'cableType',
                  'Source connector': 'sourceConnector',
                  'Destination connector': 'targetConnector',
                  Length: 'length',
                  Notes: 'notes',
                } as const
              )[label as 'Name'];
              return input(label, cable[key], (value) =>
                onChange(
                  {
                    ...document,
                    cables: document.cables.map((item) =>
                      item.id === cable.id ? { ...item, [key]: value } : item,
                    ),
                  },
                  `Property:${cable.id}:${key}`,
                ),
              );
            })}
            {input(
              'Cable color',
              cable.color || '#b8c6d0',
              (color) =>
                onChange(
                  {
                    ...document,
                    cables: document.cables.map((item) =>
                      item.id === cable.id ? { ...item, color } : item,
                    ),
                  },
                  `Property:${cable.id}:color`,
                ),
              'color',
            )}
            {(['sourcePortId', 'targetPortId'] as const).map((key) => (
              <label key={key}>
                {key === 'sourcePortId' ? 'Source port' : 'Destination port'}
                <select
                  aria-label={
                    key === 'sourcePortId' ? 'Source port' : 'Destination port'
                  }
                  value={cable[key]}
                  onChange={(event) =>
                    onChange(
                      {
                        ...document,
                        cables: document.cables.map((item) =>
                          item.id === cable.id
                            ? { ...item, [key]: event.target.value }
                            : item,
                        ),
                      },
                      'Cable endpoints',
                    )
                  }
                >
                  {document.ports.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={
                        document.cables.some(
                          (other) =>
                            other.id !== cable.id &&
                            (other.sourcePortId === item.id ||
                              other.targetPortId === item.id),
                        ) ||
                        item.id ===
                          cable[
                            key === 'sourcePortId'
                              ? 'targetPortId'
                              : 'sourcePortId'
                          ]
                      }
                    >
                      {
                        document.elements.find(
                          (owner) => owner.id === item.deviceId,
                        )?.name
                      }{' '}
                      / {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </>
        )}
      </div>
      <footer>
        {element && <button onClick={onDuplicate}>Duplicate</button>}
        <button className="danger" onClick={onDelete}>
          Delete {element?.type ?? (port ? 'port' : 'cable')}
        </button>
      </footer>
    </aside>
  );
}

function CustomProperties({
  fields,
  onChange,
}: {
  fields: Record<string, JsonValue>;
  onChange: (fields: Record<string, JsonValue>) => void;
}) {
  return (
    <details>
      <summary>Custom fields</summary>
      {Object.entries(fields).map(([key, value]) => (
        <div className="board-custom-row" key={key}>
          <input
            aria-label="Custom field name"
            defaultValue={key}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next && (next === key || !Object.hasOwn(fields, next))) {
                onChange(
                  Object.fromEntries(
                    Object.entries(fields).map(([name, item]) => [
                      name === key ? next : name,
                      item,
                    ]),
                  ),
                );
              } else event.target.value = key;
            }}
          />
          <DraftText
            label={`Custom value ${key}`}
            value={typeof value === 'string' ? value : JSON.stringify(value)}
            onChange={(raw) => {
              let next: JsonValue = raw;
              try {
                next = JSON.parse(raw) as JsonValue;
              } catch {
                /* Keep plain text. */
              }
              onChange({ ...fields, [key]: next });
            }}
          />
          <button
            aria-label={`Remove custom field ${key}`}
            onClick={() => {
              const next = { ...fields };
              delete next[key];
              onChange(next);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() => {
          let index = 1;
          while (Object.hasOwn(fields, `Field ${index}`)) index++;
          onChange({ ...fields, [`Field ${index}`]: '' });
        }}
      >
        Add custom field
      </button>
    </details>
  );
}

function DraftText({
  id,
  describedBy,
  label,
  value,
  onChange,
}: {
  id?: string;
  describedBy?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <input
      id={id}
      aria-describedby={describedBy}
      aria-label={label}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(value);
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
    />
  );
}
