import { useEffect, useState, type FormEvent } from 'react';
import {
  createConnectionSchema,
  updateConnectionSchema,
  createLogicalConnectionSchema,
  updateLogicalConnectionSchema,
  type Connection,
  type LogicalConnection,
  type Device,
  type Port,
} from '../../../packages/shared/src/index.js';
import { api, ApiError } from './api.js';
import { Field, SelectField, type FormControls } from './ConfigurePanels.js';
import { WorkflowError } from './DeviceCreation.js';
import './workflow.css';

type Kind = 'physical' | 'logical';
type Editor = { kind: Kind; record: Connection | LogicalConnection | null };
type Snapshot = {
  devices: Device[];
  ports: Port[];
  connections: Connection[];
  logicalConnections: LogicalConnection[];
};
type Draft = {
  aDeviceId: string;
  bDeviceId: string;
  aPortId: string;
  bPortId: string;
  name: string;
  protocol: string;
  cableType: string;
  notes: string;
};
const blank: Draft = {
  aDeviceId: '',
  bDeviceId: '',
  aPortId: '',
  bPortId: '',
  name: '',
  protocol: '',
  cableType: '',
  notes: '',
};
async function load(siteId: string): Promise<Snapshot> {
  const base = '/sites/' + siteId;
  const [devices, connections, logical] = await Promise.all([
    api<{ devices: Device[] }>(base + '/devices'),
    api<{ connections: Connection[] }>(base + '/connections'),
    api<{ logicalConnections: LogicalConnection[] }>(
      base + '/logical-connections',
    ),
  ]);
  const ports = await Promise.all(
    devices.devices.map((device) =>
      api<{ ports: Port[] }>(base + '/devices/' + device.id + '/ports'),
    ),
  );
  return {
    ...devices,
    ...connections,
    ...logical,
    ports: ports.flatMap((result) => result.ports),
  };
}

export function Connections({
  siteId,
  controls,
  initiallyCreating = false,
  onChanged,
  focusId,
  focusKind,
}: {
  siteId: string;
  controls: FormControls;
  initiallyCreating?: boolean;
  onChanged?: () => Promise<void> | void;
  focusId?: string;
  focusKind?: Kind;
}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [editor, setEditor] = useState<Editor | null>(() =>
    initiallyCreating ? { kind: 'physical', record: null } : null,
  );
  const [draft, setDraft] = useState<Draft>(blank);
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const { onDirtyChange } = controls;
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    let active = true;
    void load(siteId)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((failure) => {
        if (active) setError(failure);
      });
    return () => {
      active = false;
    };
  }, [siteId]);
  async function refresh() {
    setData(await load(siteId));
  }
  function update(changes: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
    controls.onDirtyChange(true);
  }
  function open(kind: Kind, record: Editor['record'] = null) {
    if (!controls.canLeave()) return;
    let next = { ...blank };
    if (record && kind === 'physical') {
      const physical = record as Connection;
      next = {
        ...next,
        aPortId: physical.endpointAPortId,
        bPortId: physical.endpointBPortId,
        aDeviceId:
          data?.ports.find((port) => port.id === physical.endpointAPortId)
            ?.deviceId ?? '',
        bDeviceId:
          data?.ports.find((port) => port.id === physical.endpointBPortId)
            ?.deviceId ?? '',
        cableType: physical.cableType,
        notes: physical.notes,
      };
    } else if (record) {
      const logical = record as LogicalConnection;
      next = {
        ...next,
        aDeviceId: logical.endpointADeviceId,
        bDeviceId: logical.endpointBDeviceId,
        name: logical.name,
        protocol: logical.protocol,
        notes: logical.notes,
      };
    }
    setEditor({ kind, record });
    setDraft(next);
    setError(null);
    setNotice('');
    controls.onDirtyChange(false);
  }
  function deviceName(id: string) {
    return (
      data?.devices.find((device) => device.id === id)?.displayName ??
      'Unavailable device'
    );
  }
  function portLabel(id: string) {
    const port = data?.ports.find((item) => item.id === id);
    return port
      ? deviceName(port.deviceId) + ' · ' + port.name
      : 'Unavailable port';
  }
  function occupied(id: string) {
    return (
      data?.connections.some(
        (connection) =>
          connection.endpointAPortId === id ||
          connection.endpointBPortId === id,
      ) ?? false
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setError(null);
    setNotice('');
    setPending(true);
    controls.onBusyChange(true);
    try {
      const path = '/sites/' + siteId;
      if (editor.kind === 'physical') {
        if (editor.record) {
          const payload = updateConnectionSchema.parse({
            cableType: draft.cableType,
            notes: draft.notes,
            rowVersion: editor.record.rowVersion,
          });
          await api(
            path + '/connections/' + editor.record.id,
            'PATCH',
            payload,
          );
        } else {
          // Read versions from the server immediately before creating a cable.
          // Existing cables are never implicitly replaced.
          const [a, b] = await Promise.all([
            api<{ port: Port }>(path + '/ports/' + draft.aPortId),
            api<{ port: Port }>(path + '/ports/' + draft.bPortId),
          ]);
          const payload = createConnectionSchema.parse({
            endpointAPortId: draft.aPortId,
            endpointBPortId: draft.bPortId,
            endpointARowVersion: a.port.rowVersion,
            endpointBRowVersion: b.port.rowVersion,
            cableType: draft.cableType,
            notes: draft.notes,
            replaceConnections: [],
          });
          await api(path + '/connections', 'POST', payload);
        }
      } else {
        const values = createLogicalConnectionSchema.parse({
          endpointADeviceId: draft.aDeviceId,
          endpointBDeviceId: draft.bDeviceId,
          name: draft.name,
          protocol: draft.protocol,
          notes: draft.notes,
        });
        const payload = editor.record
          ? updateLogicalConnectionSchema.parse({
              ...values,
              rowVersion: editor.record.rowVersion,
            })
          : values;
        await api(
          path +
            '/logical-connections' +
            (editor.record ? '/' + editor.record.id : ''),
          editor.record ? 'PATCH' : 'POST',
          payload,
        );
      }
      setEditor(null);
      controls.onDirtyChange(false);
      setNotice('Connection saved.');
      await refresh();
      await onChanged?.();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  async function remove(kind: Kind, record: Connection | LogicalConnection) {
    if (
      !controls.canLeave() ||
      !window.confirm(
        'Delete this documented ' +
          kind +
          ' connection? No equipment configuration will be changed.',
      )
    )
      return;
    setEditor(null);
    controls.onDirtyChange(false);
    setPending(true);
    controls.onBusyChange(true);
    setError(null);
    try {
      await api(
        '/sites/' +
          siteId +
          (kind === 'physical' ? '/connections/' : '/logical-connections/') +
          record.id,
        'DELETE',
        { rowVersion: record.rowVersion },
      );
      await refresh();
      await onChanged?.();
      setNotice('Connection deleted.');
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  function endpoint(letter: 'A' | 'B') {
    if (!editor || !data) return null;
    const first = letter === 'A';
    const deviceId = first ? draft.aDeviceId : draft.bDeviceId;
    const portId = first ? draft.aPortId : draft.bPortId;
    const immutablePhysical =
      editor.kind === 'physical' && Boolean(editor.record);
    return (
      <fieldset className="workflow-form" disabled={immutablePhysical}>
        <legend>Endpoint {letter}</legend>
        <div className="configure-form-fields">
          <SelectField
            label={'Endpoint ' + letter + ' device'}
            required
            autoFocus={first && !editor.record}
            value={deviceId}
            onChange={(event) =>
              update(
                first
                  ? { aDeviceId: event.target.value, aPortId: '' }
                  : { bDeviceId: event.target.value, bPortId: '' },
              )
            }
          >
            <option value="">Select a device</option>
            {data.devices.map((device) => (
              <option value={device.id} key={device.id}>
                {device.displayName}
              </option>
            ))}
          </SelectField>
          {editor.kind === 'physical' && (
            <SelectField
              label={'Endpoint ' + letter + ' port'}
              required
              value={portId}
              disabled={!deviceId}
              onChange={(event) =>
                update(
                  first
                    ? { aPortId: event.target.value }
                    : { bPortId: event.target.value },
                )
              }
            >
              <option value="">Select a port</option>
              {data.ports
                .filter((port) => port.deviceId === deviceId)
                .map((port) => (
                  <option
                    value={port.id}
                    key={port.id}
                    disabled={
                      !immutablePhysical &&
                      (occupied(port.id) ||
                        (first ? draft.bPortId : draft.aPortId) === port.id)
                    }
                  >
                    {port.name}
                    {occupied(port.id) && !immutablePhysical
                      ? ' (connected)'
                      : ''}
                  </option>
                ))}
            </SelectField>
          )}
        </div>
      </fieldset>
    );
  }
  const physical =
    data?.connections.filter(
      (connection) =>
        !focusId || (connection.id === focusId && focusKind !== 'logical'),
    ) ?? [];
  const logical =
    data?.logicalConnections.filter(
      (connection) =>
        !focusId || (connection.id === focusId && focusKind !== 'physical'),
    ) ?? [];
  if (focusId && data && !physical.length && !logical.length)
    return (
      <p role="alert" className="error-message">
        The selected connection is unavailable in this site.
      </p>
    );
  return (
    <section aria-label="Connection management">
      <div className="configure-toolbar">
        <h2>Connections</h2>
        {!focusId && (
          <button
            type="button"
            disabled={pending}
            onClick={() => open('physical')}
          >
            Add connection
          </button>
        )}
      </div>
      <p className="section-description">
        Document physical cables and logical relationships between equipment.
      </p>
      <WorkflowError error={error} />
      {notice && <p role="status">{notice}</p>}
      {Boolean(error) && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!controls.canLeave()) return;
            setEditor(null);
            controls.onDirtyChange(false);
            void refresh()
              .then(() => setError(null))
              .catch(setError);
          }}
        >
          {error instanceof ApiError && error.status === 409
            ? 'Refresh and discard form'
            : 'Refresh connections'}
        </button>
      )}
      {!data ? (
        <p role="status">Loading connections…</p>
      ) : (
        <>
          {editor &&
            (!focusId || !editor.record || editor.record.id === focusId) && (
              <section
                className="workflow-inline-editor"
                aria-label={
                  editor.record ? 'Edit connection' : 'Add connection'
                }
              >
                <h3>
                  {editor.record ? 'Edit ' : 'Add '}
                  {editor.kind} connection
                </h3>
                {!editor.record && (
                  <div
                    className="workflow-kind-controls"
                    aria-label="Connection type"
                  >
                    <button
                      type="button"
                      aria-pressed={editor.kind === 'physical'}
                      disabled={pending}
                      onClick={() => {
                        if (editor.kind !== 'physical') open('physical');
                      }}
                    >
                      Physical cable
                    </button>
                    <button
                      type="button"
                      aria-pressed={editor.kind === 'logical'}
                      disabled={pending}
                      onClick={() => {
                        if (editor.kind !== 'logical') open('logical');
                      }}
                    >
                      Logical relationship
                    </button>
                  </div>
                )}
                {editor.kind === 'physical' && data.ports.length < 2 && (
                  <p className="section-description">
                    Add at least two equipment ports before documenting a
                    physical cable.
                  </p>
                )}
                {editor.kind === 'logical' && data.devices.length < 2 && (
                  <p className="section-description">
                    Add at least two devices before documenting a logical
                    relationship.
                  </p>
                )}
                <form onSubmit={(event) => void submit(event)}>
                  <fieldset className="workflow-form" disabled={pending}>
                    {endpoint('A')}
                    {endpoint('B')}
                    {editor.kind === 'physical' ? (
                      <Field
                        label="Cable type"
                        maxLength={120}
                        value={draft.cableType}
                        onChange={(event) =>
                          update({ cableType: event.target.value })
                        }
                      />
                    ) : (
                      <div className="configure-form-fields">
                        <Field
                          label="Connection name (optional)"
                          maxLength={120}
                          value={draft.name}
                          onChange={(event) =>
                            update({ name: event.target.value })
                          }
                        />
                        <Field
                          label="Protocol (optional)"
                          maxLength={120}
                          value={draft.protocol}
                          placeholder="e.g. VPN, BGP"
                          onChange={(event) =>
                            update({ protocol: event.target.value })
                          }
                        />
                      </div>
                    )}
                    <label className="workflow-notes">
                      Connection notes
                      <textarea
                        maxLength={2000}
                        value={draft.notes}
                        onChange={(event) =>
                          update({ notes: event.target.value })
                        }
                      />
                    </label>
                    <div className="workflow-actions">
                      <button type="submit" className="primary">
                        {pending ? 'Saving…' : 'Save connection'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (controls.canLeave()) {
                            setEditor(null);
                            controls.onDirtyChange(false);
                          }
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </fieldset>
                </form>
              </section>
            )}
          {!focusId && (
            <div
              className="workflow-kind-controls"
              aria-label="Connection list filter"
            >
              {(['all', 'physical', 'logical'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={filter === kind}
                  onClick={() => setFilter(kind)}
                >
                  {kind === 'all'
                    ? 'All connections'
                    : kind === 'physical'
                      ? 'Physical cables'
                      : 'Logical relationships'}
                </button>
              ))}
            </div>
          )}
          {(focusId ? physical.length > 0 : filter !== 'logical') && (
            <section aria-labelledby="physical-connections-heading">
              <h3 id="physical-connections-heading">
                Documented physical cables
              </h3>
              {!physical.length && (
                <p className="section-description">
                  No physical cables documented.
                </p>
              )}
              <ul className="configure-records">
                {physical.map((connection) => (
                  <li key={connection.id}>
                    <div className="workflow-record-details">
                      <strong>
                        {portLabel(connection.endpointAPortId)} ↔{' '}
                        {portLabel(connection.endpointBPortId)}
                      </strong>
                      {connection.cableType && (
                        <small>{connection.cableType}</small>
                      )}
                      {connection.notes && <p>{connection.notes}</p>}
                    </div>
                    <div className="workflow-actions">
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={
                          'Edit cable ' + portLabel(connection.endpointAPortId)
                        }
                        onClick={() => open('physical', connection)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={
                          'Delete cable ' +
                          portLabel(connection.endpointAPortId)
                        }
                        onClick={() => void remove('physical', connection)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(focusId ? logical.length > 0 : filter !== 'physical') && (
            <section aria-labelledby="logical-connections-heading">
              <h3 id="logical-connections-heading">
                Documented logical relationships
              </h3>
              {!logical.length && (
                <p className="section-description">
                  No logical relationships documented.
                </p>
              )}
              <ul className="configure-records">
                {logical.map((connection) => (
                  <li key={connection.id}>
                    <div className="workflow-record-details">
                      <strong>
                        {connection.name ||
                          deviceName(connection.endpointADeviceId) +
                            ' ↔ ' +
                            deviceName(connection.endpointBDeviceId)}
                      </strong>
                      <small>
                        {deviceName(connection.endpointADeviceId)} ↔{' '}
                        {deviceName(connection.endpointBDeviceId)}
                        {connection.protocol ? ' · ' + connection.protocol : ''}
                      </small>
                      {connection.notes && <p>{connection.notes}</p>}
                    </div>
                    <div className="workflow-actions">
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={
                          'Edit logical connection ' +
                          (connection.name || connection.id)
                        }
                        onClick={() => open('logical', connection)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={
                          'Delete logical connection ' +
                          (connection.name || connection.id)
                        }
                        onClick={() => void remove('logical', connection)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
