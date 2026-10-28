import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Device, Port } from '../../../packages/shared/src/index.js';
import { api } from './api.js';
import { Connector } from './visual/Connector.js';
import { PortInspector } from './visual/PortInspector.js';
import {
  connectorNames,
  groupedDevices,
  loadEquipment,
  modeNames,
  orderedDevices,
  portColor,
  portSummary,
  vlanColor,
  type EquipmentSnapshot,
} from './visual/model.js';
import './visual/visual.css';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: EquipmentSnapshot };
export interface EquipmentSummaryProps {
  siteId: string;
  onConfigure?: (deviceId?: string, portId?: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

export function EquipmentSummary({
  siteId,
  onConfigure,
  onBusyChange,
}: EquipmentSummaryProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [density, setDensity] = useState('comfortable');
  const [face, setFace] = useState<'both' | 'front' | 'rear'>('both');
  const [showConnections, setShowConnections] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const requestNumber = useRef(0);
  const faceControl = useRef<HTMLSelectElement>(null);
  const reportBusy = useEffectEvent((busy: boolean) => onBusyChange?.(busy));
  useEffect(() => {
    reportBusy(pending);
  }, [pending]);
  useEffect(() => () => reportBusy(false), []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const request = ++requestNumber.current;
    void loadEquipment(siteId)
      .then((snapshot) => {
        if (active && request === requestNumber.current)
          setState({ status: 'ready', snapshot });
      })
      .catch((error: unknown) => {
        if (active && request === requestNumber.current)
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Equipment could not be loaded.',
          });
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [siteId]);

  function refresh() {
    if (pending) return;
    const request = ++requestNumber.current;
    setState({ status: 'loading' });
    setError('');
    setNotice('');
    void loadEquipment(siteId)
      .then((snapshot) => {
        if (!mounted.current || request !== requestNumber.current) return;
        setState({ status: 'ready', snapshot });
        if (
          selectedId &&
          !snapshot.ports.some((port) => port.id === selectedId)
        ) {
          setSelectedId(null);
          setNotice('The previously selected port is no longer present.');
        }
      })
      .catch((error: unknown) => {
        if (mounted.current && request === requestNumber.current)
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Equipment could not be loaded.',
          });
      });
  }
  async function move(device: Device, direction: -1 | 1) {
    if (pending || state.status !== 'ready') return;
    const group = groupedDevices(state.snapshot).find((item) =>
      item.devices.some((item) => item.id === device.id),
    );
    const index =
      group?.devices.findIndex((item) => item.id === device.id) ?? -1;
    const neighbor = group?.devices[index + direction];
    if (!neighbor) return;
    const ordered = orderedDevices(state.snapshot.devices);
    const from = ordered.findIndex((item) => item.id === device.id);
    const to = ordered.findIndex((item) => item.id === neighbor.id);
    [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ devices: Device[] }>(
        `/sites/${siteId}/devices/reorder`,
        'POST',
        { devices: ordered.map(({ id, rowVersion }) => ({ id, rowVersion })) },
      );
      if (!mounted.current) return;
      setState((previous) =>
        previous.status === 'ready'
          ? {
              status: 'ready',
              snapshot: { ...previous.snapshot, devices: result.devices },
            }
          : previous,
      );
      setNotice(
        `Equipment order saved. ${device.displayName} moved ${direction === -1 ? 'up' : 'down'}.`,
      );
    } catch (error) {
      if (mounted.current)
        setError(
          `${error instanceof Error ? error.message : 'Order could not be saved.'} Refresh equipment to load the current order before trying again.`,
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  function closeInspector() {
    const previous = selectedId;
    setSelectedId(null);
    const button = previous
      ? document.getElementById(`visual-port-${previous}`)
      : null;
    if (button instanceof HTMLButtonElement) button.focus();
    else faceControl.current?.focus();
  }

  const snapshot = state.status === 'ready' ? state.snapshot : null;
  const selected = snapshot?.ports.find((port) => port.id === selectedId);
  const preview = snapshot?.ports.find(
    (port) => port.id === (previewId ?? selectedId),
  );
  const endpointLabel = (portId: string) => {
    const port = snapshot?.ports.find((item) => item.id === portId);
    const device = snapshot?.devices.find((item) => item.id === port?.deviceId);
    return port
      ? `${device?.displayName ?? 'Device'} / ${port.name}`
      : 'Unavailable endpoint';
  };
  function portButton(port: Port, device: Device) {
    const cable = snapshot!.connections.find(
      (item) =>
        item.endpointAPortId === port.id || item.endpointBPortId === port.id,
    );
    return (
      <button
        key={port.id}
        id={`visual-port-${port.id}`}
        data-port-id={port.id}
        data-kind={port.kind}
        data-mode={port.mode}
        type="button"
        className="visual-port"
        aria-label={`${device.displayName} ${port.name}, ${portSummary(port, snapshot!.vlans)}`}
        aria-pressed={selectedId === port.id}
        title={`${port.name}: ${portSummary(port, snapshot!.vlans)}`}
        onClick={() => setSelectedId(port.id)}
        onFocus={() => setPreviewId(port.id)}
        onMouseEnter={() => setPreviewId(port.id)}
      >
        <Connector kind={port.kind} color={portColor(port, snapshot!.vlans)} />
        <span className="visual-port-label">{port.name}</span>
        <span className="visual-port-mode">{modeNames[port.mode]}</span>
        {port.taggedVlanRefs.length > 0 && (
          <span className="visual-port-cable">
            {port.taggedVlanRefs.length} tagged
          </span>
        )}
        {cable && <span className="visual-port-cable">Cabled</span>}
      </button>
    );
  }

  return (
    <section
      className={`equipment-summary visual-equipment density-${density}`}
      aria-labelledby="equipment-title"
    >
      <div className="equipment-toolbar">
        <h2 id="equipment-title">Equipment</h2>
        <button
          type="button"
          className="subtle"
          disabled={state.status === 'loading' || pending}
          onClick={refresh}
        >
          Refresh equipment
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {state.status === 'loading' ? (
        <p className="section-description" role="status">
          Loading documented equipment…
        </p>
      ) : state.status === 'error' ? (
        <p className="error-message" role="alert">
          {state.message} Use Refresh equipment to try again.
        </p>
      ) : !snapshot!.devices.length ? (
        <p className="equipment-empty">No equipment configured yet.</p>
      ) : (
        <>
          <div className="visual-controls">
            <label>
              Port size
              <select
                value={density}
                onChange={(event) => setDensity(event.target.value)}
              >
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label>
              Panel face
              <select
                ref={faceControl}
                value={face}
                onChange={(event) => setFace(event.target.value as typeof face)}
              >
                <option value="both">Both</option>
                <option value="front">Front</option>
                <option value="rear">Rear</option>
              </select>
            </label>
            <label className="visual-check">
              <input
                type="checkbox"
                checked={showConnections}
                onChange={(event) => setShowConnections(event.target.checked)}
              />
              Show documented connections
            </label>
          </div>
          <p className="visual-color-help">
            Borders show native/untagged VLANs. Routed/WAN ports use a neutral
            border. Link state is manually documented.
          </p>
          {snapshot!.vlans.length > 0 && (
            <ul className="visual-vlan-legend" aria-label="VLAN legend">
              {snapshot!.vlans
                .slice()
                .sort((a, b) => a.vlanId - b.vlanId)
                .map((vlan) => (
                  <li key={vlan.id}>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                    >
                      <rect
                        x="1"
                        y="1"
                        width="10"
                        height="10"
                        rx="3"
                        fill={vlanColor(vlan)}
                      />
                    </svg>
                    <span>
                      VLAN {vlan.vlanId}
                      {vlan.name ? ` · ${vlan.name}` : ''}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <p className="visual-focus-summary" aria-live="off">
            {preview
              ? `${snapshot!.devices.find((device) => device.id === preview.deviceId)?.displayName ?? 'Device'} / ${preview.name}: ${portSummary(preview, snapshot!.vlans)}`
              : 'Hover or focus a port for a summary. Select it to inspect its documented configuration.'}
          </p>
          <div className={`visual-layout${selected ? ' has-inspector' : ''}`}>
            <div className="visual-stack">
              {groupedDevices(snapshot!).map((group) => (
                <section
                  className="visual-rack-group"
                  key={group.id}
                  aria-label={group.name ?? 'Site equipment'}
                >
                  {group.name && (
                    <h3 className="visual-rack-label">{group.name}</h3>
                  )}
                  {group.devices.map((device, index) => {
                    const ports = snapshot!.ports
                      .filter((port) => port.deviceId === device.id)
                      .sort(
                        (a, b) =>
                          a.orderIndex - b.orderIndex ||
                          a.id.localeCompare(b.id),
                      );
                    const kinds = Object.entries(connectorNames)
                      .map(([kind, label]) => ({
                        label,
                        count: ports.filter((port) => port.kind === kind)
                          .length,
                      }))
                      .filter((item) => item.count);
                    const routed = ports.filter(
                      (port) => port.mode === 'routed',
                    ).length;
                    const cables = snapshot!.connections.filter((cable) =>
                      ports.some(
                        (port) =>
                          port.id === cable.endpointAPortId ||
                          port.id === cable.endpointBPortId,
                      ),
                    );
                    return (
                      <article
                        className="visual-device"
                        key={device.id}
                        data-device-id={device.id}
                        data-port-count={ports.length}
                        aria-label={device.displayName}
                      >
                        <header className="visual-device-header">
                          <div>
                            <h3>{device.displayName}</h3>
                            {(device.manufacturer || device.model) && (
                              <p className="visual-device-model">
                                {[device.manufacturer, device.model]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </p>
                            )}
                            <p className="visual-device-type">
                              {device.type === 'ap'
                                ? 'Access point'
                                : device.type}
                            </p>
                          </div>
                          <div className="visual-device-actions">
                            <button
                              type="button"
                              className="subtle"
                              disabled={pending || index === 0}
                              aria-label={`Move ${device.displayName} up`}
                              onClick={() => void move(device, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="subtle"
                              disabled={
                                pending || index === group.devices.length - 1
                              }
                              aria-label={`Move ${device.displayName} down`}
                              onClick={() => void move(device, 1)}
                            >
                              ↓
                            </button>
                            {onConfigure && (
                              <button
                                type="button"
                                className="subtle"
                                disabled={pending}
                                onClick={() => onConfigure(device.id)}
                                aria-label={`Configure ${device.displayName}`}
                              >
                                Configure
                              </button>
                            )}
                          </div>
                        </header>
                        <div className="visual-device-facts">
                          <span>
                            {ports.length} documented{' '}
                            {ports.length === 1 ? 'port' : 'ports'}
                          </span>
                          {kinds.length > 0 && (
                            <span>
                              {kinds
                                .map(({ label, count }) => `${count} ${label}`)
                                .join(' · ')}
                            </span>
                          )}
                          {routed > 0 && (
                            <span>
                              {routed} routed/WAN{' '}
                              {routed === 1 ? 'interface' : 'interfaces'}
                            </span>
                          )}
                        </div>
                        {device.tags.length > 0 && (
                          <p className="visual-device-tags">
                            Device tags: {device.tags.join(' · ')}
                          </p>
                        )}
                        {device.description && (
                          <p className="visual-device-description">
                            {device.description}
                          </p>
                        )}
                        {(['front', 'rear'] as const)
                          .filter((side) => face === 'both' || face === side)
                          .map((side) => {
                            const facePorts = ports.filter(
                              (port) => port.face === side,
                            );
                            if (!facePorts.length) return null;
                            return (
                              <section
                                className="visual-face"
                                key={side}
                                aria-label={`${device.displayName} ${side} panel`}
                              >
                                <h4>
                                  {side === 'front' ? 'Front' : 'Rear'}{' '}
                                  <span>{facePorts.length} ports</span>
                                </h4>
                                <div
                                  className="visual-panel-scroll"
                                  tabIndex={0}
                                  aria-label={`${device.displayName} ${side} ports; scroll horizontally`}
                                >
                                  <div
                                    className="visual-ports"
                                    data-dense={facePorts.length > 12}
                                  >
                                    {facePorts.map((port) =>
                                      portButton(port, device),
                                    )}
                                  </div>
                                </div>
                              </section>
                            );
                          })}
                        {ports.length === 0 && (
                          <p className="visual-empty-ports">
                            No physical ports documented. Choose Configure to
                            add ports.
                          </p>
                        )}
                        {ports.length > 0 &&
                          !ports.some(
                            (port) => face === 'both' || port.face === face,
                          ) && (
                            <p className="visual-empty-ports">
                              No ports documented on the {face} face.
                            </p>
                          )}
                        {showConnections && cables.length > 0 && (
                          <ul
                            className="visual-cable-list"
                            aria-label={`${device.displayName} documented connections`}
                          >
                            {cables.map((cable) => (
                              <li key={cable.id}>
                                <span>Documented cable</span>{' '}
                                {endpointLabel(cable.endpointAPortId)} ⇄{' '}
                                {endpointLabel(cable.endpointBPortId)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
                </section>
              ))}
            </div>
            {selected && (
              <PortInspector
                port={selected}
                snapshot={snapshot!}
                onClose={closeInspector}
                onInspect={setSelectedId}
                onConfigure={onConfigure}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
