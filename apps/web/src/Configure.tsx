import { DeviceCreation } from './DeviceCreation.js';
import { Templates } from './Templates.js';
import { Connections } from './Connections.js';
import { useEffect, useRef, useState } from 'react';
import type {
  Device,
  Vlan,
  Rack,
  Subnet,
  PortField,
  Site,
  ConfigurePane,
} from '../../../packages/shared/src/index.js';
import { api } from './api.js';
import { EquipmentSummary } from './EquipmentSummary.js';
import { PortGrid } from './PortGrid.js';
import { CustomFields } from './grid/CustomFields.js';
import { Transfer } from './Transfer.js';
import {
  DeviceEditor,
  VlanSettings,
  RackSettings,
  NetworkSettings,
  type FormControls,
} from './ConfigurePanels.js';
import './configure.css';

type Data = {
  devices: Device[];
  vlans: Vlan[];
  racks: Rack[];
  subnets: Subnet[];
  fields: PortField[];
};
async function load(siteId: string): Promise<Data> {
  const [devices, vlans, racks, subnets, fields] = await Promise.all([
    api<{ devices: Device[] }>(`/sites/${siteId}/devices`),
    api<{ vlans: Vlan[] }>(`/sites/${siteId}/vlans`),
    api<{ racks: Rack[] }>(`/sites/${siteId}/racks`),
    api<{ subnets: Subnet[] }>(`/sites/${siteId}/subnets`),
    api<{ fields: PortField[] }>(`/sites/${siteId}/port-fields`),
  ]);
  return { ...devices, ...vlans, ...racks, ...subnets, ...fields };
}
export function SiteView({
  siteId,
  userId,
  createPane,
  onDirtyChange,
  onBusyChange,
  onModeChange,
  onSiteImported,
}: {
  siteId: string;
  userId: string;
  createPane?: ConfigurePane;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onModeChange: (configure: boolean) => void;
  onSiteImported?: (site: Site) => void;
}) {
  const [configure, setConfigure] = useState(
    () =>
      Boolean(createPane) ||
      new URLSearchParams(window.location.search).get('view') === 'configure',
  );
  const [initialCreatePane, setInitialCreatePane] = useState(createPane);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(0);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(
    () => () => {
      onDirtyChange(false);
      onBusyChange(false);
    },
    [onDirtyChange, onBusyChange],
  );
  function canLeave() {
    if (busy) return false;
    if (dirty && !window.confirm('Discard unsaved configuration changes?'))
      return false;
    return true;
  }
  function switchView(next: boolean, deviceId?: string, portId?: string) {
    if (next === configure || !canLeave()) return;
    setInitialCreatePane(undefined);
    setConfigure(next);
    setReset((value) => value + 1);
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set('view', 'configure');
      if (deviceId) url.searchParams.set('deviceId', deviceId);
      if (portId) url.searchParams.set('portId', portId);
    } else {
      for (const key of ['view', 'pane', 'deviceId', 'portId'])
        url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url.pathname + url.search);
    onModeChange(next);
  }
  const controls: FormControls = {
    onDirtyChange: setDirty,
    onBusyChange: setBusy,
    canLeave,
  };
  return (
    <section aria-label="Site workspace">
      {configure ? (
        <Configure
          key={reset}
          siteId={siteId}
          userId={userId}
          createPane={initialCreatePane}
          controls={controls}
          busy={busy}
          onSiteImported={onSiteImported}
          onLocationChange={() => onModeChange(true)}
        />
      ) : (
        <EquipmentSummary
          key={siteId}
          siteId={siteId}
          onConfigure={(deviceId, portId) => switchView(true, deviceId, portId)}
          onBusyChange={setBusy}
        />
      )}
    </section>
  );
}
function Configure({
  siteId,
  userId,
  createPane,
  controls,
  busy,
  onSiteImported,
  onLocationChange,
}: {
  siteId: string;
  userId: string;
  createPane?: ConfigurePane;
  controls: FormControls;
  busy: boolean;
  onSiteImported?: ((site: Site) => void) | undefined;
  onLocationChange: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [pane] = useState<ConfigurePane>(() => {
    if (createPane) return createPane;
    const value = new URLSearchParams(window.location.search).get('pane');
    return value === 'vlans' ||
      value === 'network' ||
      value === 'racks' ||
      value === 'transfer' ||
      value === 'connections' ||
      value === 'templates'
      ? value
      : 'devices';
  });
  const [creationPane, setCreationPane] = useState(createPane);
  const [epoch, setEpoch] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const active = useRef(false);
  const requestNumber = useRef(0);
  const latestControls = useRef(controls);
  useEffect(() => {
    latestControls.current = controls;
  }, [controls]);
  useEffect(() => {
    active.current = true;
    const request = ++requestNumber.current;
    void load(siteId)
      .then((value) => {
        if (active.current && request === requestNumber.current) setData(value);
      })
      .catch((error: unknown) => {
        if (active.current && request === requestNumber.current)
          setError(
            error instanceof Error
              ? error.message
              : 'Unable to load site configuration.',
          );
      });
    return () => {
      active.current = false;
    };
  }, [siteId]);
  async function refresh() {
    const request = ++requestNumber.current;
    try {
      const next = await load(siteId);
      if (!active.current || request !== requestNumber.current) return;
      setData(next);
      setError('');
    } finally {
      if (active.current && request === requestNumber.current)
        setRefreshing(false);
    }
  }
  async function reload() {
    if (busy || refreshing) return;
    const request = ++requestNumber.current;
    setRefreshing(true);
    try {
      const next = await load(siteId);
      if (!active.current || request !== requestNumber.current) return;
      // A read may finish after the user starts editing. Confirm against the latest
      // form state before replacing records or remounting the current pane.
      if (!latestControls.current.canLeave()) return;
      setData(next);
      setError('');
      setCreationPane(undefined);
      setEpoch((value) => value + 1);
    } catch (error) {
      if (active.current && request === requestNumber.current)
        setError(
          error instanceof Error ? error.message : 'Unable to refresh records.',
        );
    } finally {
      if (active.current && request === requestNumber.current)
        setRefreshing(false);
    }
  }
  return (
    <section className="site-configure" aria-label="Site configuration">
      <div className="configure-toolbar">
        <h2>
          {
            {
              devices: 'Equipment',
              vlans: 'VLANs',
              network: 'Networks & Subnets',
              racks: 'Racks',
              transfer: 'Import & Export',
              connections: 'Connections',
              templates: 'Templates',
            }[pane]
          }
        </h2>
        <button
          type="button"
          disabled={busy || refreshing}
          onClick={() => void reload()}
        >
          Refresh saved records
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p role="status">Loading site configuration…</p>
      ) : (
        <div key={`${pane}-${epoch}`}>
          {pane === 'devices' && (
            <Devices
              siteId={siteId}
              userId={userId}
              data={data}
              setData={setData}
              onChanged={refresh}
              controls={controls}
              busy={busy}
              initiallyCreating={creationPane === 'devices'}
              onLocationChange={onLocationChange}
            />
          )}
          {pane === 'connections' && (
            <Connections
              siteId={siteId}
              controls={controls}
              initiallyCreating={creationPane === 'connections'}
            />
          )}
          {pane === 'templates' && (
            <Templates
              siteId={siteId}
              controls={controls}
              initiallyCreating={creationPane === 'templates'}
            />
          )}
          {pane === 'transfer' && (
            <Transfer
              siteId={siteId}
              controls={controls}
              onImported={(site) => {
                onSiteImported?.(site);
                void refresh().catch((error: unknown) =>
                  setError(
                    error instanceof Error
                      ? error.message
                      : 'Refresh saved records to load the imported configuration.',
                  ),
                );
              }}
            />
          )}
          {pane === 'vlans' && (
            <VlanSettings
              siteId={siteId}
              vlans={data.vlans}
              devices={data.devices}
              initiallyCreating={creationPane === 'vlans'}
              controls={controls}
              onChanged={refresh}
            />
          )}
          {pane === 'network' && (
            <NetworkSettings
              siteId={siteId}
              subnets={data.subnets}
              initiallyCreating={creationPane === 'network'}
              vlans={data.vlans}
              controls={controls}
              onChanged={refresh}
            />
          )}
          {pane === 'racks' && (
            <RackSettings
              siteId={siteId}
              racks={data.racks}
              initiallyCreating={creationPane === 'racks'}
              controls={controls}
              onChanged={refresh}
            />
          )}
        </div>
      )}
    </section>
  );
}
function Devices({
  siteId,
  userId,
  data,
  setData,
  onChanged,
  controls,
  busy,
  initiallyCreating = false,
  onLocationChange,
}: {
  siteId: string;
  userId: string;
  data: Data;
  setData: React.Dispatch<React.SetStateAction<Data | null>>;
  onChanged: () => Promise<void>;
  controls: FormControls;
  busy: boolean;
  initiallyCreating?: boolean;
  onLocationChange: () => void;
}) {
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(window.location.search).get('deviceId') ?? '',
  );
  const [focusPortId, setFocusPortId] = useState(
    () =>
      new URLSearchParams(window.location.search).get('portId') ?? undefined,
  );
  const [editor, setEditor] = useState<Device | 'new' | null>(
    initiallyCreating ? 'new' : null,
  );
  const [error, setError] = useState('');
  const selected = data.devices.find((device) => device.id === selectedId);
  function selectDevice(id: string) {
    setSelectedId(id);
    setFocusPortId(undefined);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('deviceId', id);
    else url.searchParams.delete('deviceId');
    url.searchParams.delete('portId');
    window.history.replaceState(null, '', url.pathname + url.search);
    onLocationChange();
  }
  async function remove() {
    if (
      !selected ||
      !controls.canLeave() ||
      !window.confirm(
        `Delete device “${selected.displayName}” and all its ports? Disconnect any documented cables first. This cannot be undone.`,
      )
    )
      return;
    controls.onBusyChange(true);
    try {
      await api(`/sites/${siteId}/devices/${selected.id}`, 'DELETE', {
        rowVersion: selected.rowVersion,
      });
      await onChanged();
      selectDevice('');
      setEditor(null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Device could not be deleted.',
      );
    } finally {
      controls.onBusyChange(false);
    }
  }
  return (
    <section aria-label="Device configuration">
      <div className="configure-toolbar device-toolbar">
        <label className="configure-field">
          <span>Device</span>
          <select
            value={selected?.id ?? ''}
            disabled={busy || !data.devices.length}
            onChange={(event) => {
              if (controls.canLeave()) {
                selectDevice(event.target.value);
                setEditor(null);
              }
            }}
          >
            {!data.devices.length && <option value="">No devices yet</option>}
            {data.devices.length > 0 && !selected && (
              <option value="">Choose a device</option>
            )}
            {data.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          {selected && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (controls.canLeave()) setEditor(selected);
                }}
              >
                Edit device
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete device
              </button>
            </>
          )}
        </div>
      </div>
      {selectedId &&
        !data.devices.some((device) => device.id === selectedId) && (
          <p role="alert" className="error-message">
            The requested device is unavailable in this site. Choose a device to
            continue.
          </p>
        )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {editor === 'new' ? (
        <DeviceCreation
          siteId={siteId}
          racks={data.racks}
          controls={controls}
          onCancel={() => {
            setEditor(null);
            void onChanged().catch((error) =>
              setError(
                error instanceof Error ? error.message : 'Refresh failed.',
              ),
            );
          }}
          onDone={async (device) => {
            await onChanged();
            selectDevice(device.id);
            setEditor(null);
          }}
        />
      ) : editor ? (
        <DeviceEditor
          key={editor.id}
          siteId={siteId}
          device={editor}
          racks={data.racks}
          controls={controls}
          onCancel={() => {
            setEditor(null);
            void onChanged().catch((error) =>
              setError(
                error instanceof Error ? error.message : 'Refresh failed.',
              ),
            );
          }}
          onDone={async (device) => {
            await onChanged();
            selectDevice(device.id);
            setEditor(null);
          }}
        />
      ) : selected ? (
        <PortGrid
          key={selected.id}
          siteId={siteId}
          userId={userId}
          focusPortId={selected?.id === selectedId ? focusPortId : undefined}
          device={selected}
          devices={data.devices}
          vlans={data.vlans}
          onVlansChange={(vlans) =>
            setData((previous) => previous && { ...previous, vlans })
          }
          onDeviceChange={(device) =>
            setData(
              (previous) =>
                previous && {
                  ...previous,
                  devices: previous.devices.map((item) =>
                    item.id === device.id ? device : item,
                  ),
                },
            )
          }
          onDirtyChange={controls.onDirtyChange}
          onBusyChange={controls.onBusyChange}
        />
      ) : data.devices.length > 0 ? (
        <div className="workflow-table-scroll">
          <table className="workflow-table">
            <thead>
              <tr>
                <th>Equipment</th>
                <th>Type</th>
                <th>Model</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.devices.map((device) => (
                <tr key={device.id}>
                  <td>{device.displayName}</td>
                  <td>{device.type}</td>
                  <td>
                    {[device.manufacturer, device.model]
                      .filter(Boolean)
                      .join(' ') || '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (controls.canLeave()) selectDevice(device.id);
                      }}
                    >
                      Configure {device.displayName}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <p className="section-description">No equipment configured yet.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (controls.canLeave()) setEditor('new');
            }}
          >
            Add equipment
          </button>
          <div className="port-grid">
            <CustomFields
              siteId={siteId}
              fields={data.fields}
              disabled={busy}
              onDirtyChange={controls.onDirtyChange}
              onBusyChange={controls.onBusyChange}
              onChange={(fields) =>
                setData((previous) => previous && { ...previous, fields })
              }
            />
          </div>
        </>
      )}
    </section>
  );
}
