import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Device, Port } from '../../../packages/shared/src/index.js';
import { api } from './api.js';
import { Connector } from './visual/Connector.js';
import { CableOverlay } from './visual/CableOverlay.js';
import { PortInspector, type PortSaveResult } from './visual/PortInspector.js';
import { reorderPort, renumberPorts } from './grid/helpers.js';
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
  deviceId?: string;
  onSnapshotChange?: (
    snapshot: EquipmentSnapshot | null,
    error?: string,
  ) => void;
  onConfigure?: (deviceId?: string, portId?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function EquipmentSummary({
  siteId,
  deviceId,
  onSnapshotChange,
  onConfigure,
  onBusyChange,
  onDirtyChange,
}: EquipmentSummaryProps) {
  const cableContainer = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragSource = useRef<{ portId: string; deviceId: string } | null>(null);
  const [keyboardPosition, setKeyboardPosition] = useState<number | null>(null);
  const orderBusy = useRef(false);
  const [renumberDirtyIds, setRenumberDirtyIds] = useState<string[]>([]);
  function updateRenumberDirty(id: string, dirty: boolean) {
    setRenumberDirtyIds((previous) =>
      dirty
        ? previous.includes(id)
          ? previous
          : [...previous, id]
        : previous.filter((item) => item !== id),
    );
  }
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [face, setFace] = useState<'both' | 'front' | 'rear'>('both');
  const [showConnections, setShowConnections] = useState(true);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const drawerDirty = useRef(false);
  const drawerOpen = useRef(false);
  const reportDirty = useEffectEvent((dirty: boolean) =>
    onDirtyChange?.(dirty),
  );
  function updateDrawerDirty(dirty: boolean) {
    drawerDirty.current = dirty;
    onDirtyChange?.(dirty || renumberDirtyIds.length > 0);
  }
  useEffect(() => {
    reportDirty(drawerDirty.current || renumberDirtyIds.length > 0);
  }, [renumberDirtyIds]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reportSnapshot = useEffectEvent(() =>
    onSnapshotChange?.(
      state.status === 'ready' ? state.snapshot : null,
      state.status === 'error' ? state.message : undefined,
    ),
  );
  useEffect(() => {
    reportSnapshot();
  }, [state]);
  const mounted = useRef(false);
  const requestNumber = useRef(0);
  const faceControl = useRef<HTMLSelectElement>(null);
  const reportBusy = useEffectEvent((busy: boolean) => onBusyChange?.(busy));
  useEffect(() => {
    reportBusy(pending || drawerBusy);
  }, [pending, drawerBusy]);
  useEffect(
    () => () => {
      reportBusy(false);
      reportDirty(false);
    },
    [],
  );
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
      dragSource.current = null;
    };
  }, [siteId]);

  function refresh() {
    if (pending || drawerBusy || refreshing || drawerOpen.current) return;
    const request = ++requestNumber.current;
    setRefreshing(true);
    setError('');
    setNotice('');
    void loadEquipment(siteId)
      .then((snapshot) => {
        if (!mounted.current || request !== requestNumber.current) return;
        // A port may have opened while this read was in flight. Keep its baseline.
        if (drawerOpen.current || drawerDirty.current) return;
        setState({ status: 'ready', snapshot });
      })
      .catch((error: unknown) => {
        if (mounted.current && request === requestNumber.current)
          setError(
            error instanceof Error
              ? error.message
              : 'Equipment could not be loaded.',
          );
      })
      .finally(() => {
        if (mounted.current && request === requestNumber.current)
          setRefreshing(false);
      });
  }
  async function move(device: Device, direction: -1 | 1) {
    if (
      pending ||
      drawerBusy ||
      drawerDirty.current ||
      state.status !== 'ready'
    )
      return;
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
  function canLeaveInspector() {
    return (
      !drawerBusy &&
      (!drawerDirty.current || window.confirm('Discard unsaved port changes?'))
    );
  }
  function inspectPort(portId: string) {
    if (selectedId === portId || !canLeaveInspector()) return;
    clearPortDrag();
    updateDrawerDirty(false);
    drawerOpen.current = true;
    setSelectedId(portId);
  }
  function closeInspector() {
    if (!canLeaveInspector()) return;
    updateDrawerDirty(false);
    drawerOpen.current = false;
    const previous = selectedId;
    setSelectedId(null);
    requestAnimationFrame(() => {
      if (!mounted.current || drawerOpen.current) return;
      const button = previous
        ? document.getElementById(`visual-port-${previous}`)
        : null;
      if (button instanceof HTMLButtonElement)
        button.focus({ preventScroll: true });
      else faceControl.current?.focus({ preventScroll: true });
    });
  }

  const snapshot = state.status === 'ready' ? state.snapshot : null;
  const visibleSnapshot =
    snapshot && deviceId
      ? {
          ...snapshot,
          devices: snapshot.devices.filter((device) => device.id === deviceId),
        }
      : snapshot;
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
  function clearPortDrag() {
    dragSource.current = null;
    setDraggingId(null);
    setKeyboardPosition(null);
  }
  function beginPortDrag(port: Port) {
    if (
      pending ||
      refreshing ||
      drawerBusy ||
      drawerOpen.current ||
      renumberDirtyIds.length > 0 ||
      orderBusy.current
    )
      return false;
    dragSource.current = { portId: port.id, deviceId: port.deviceId };
    setDraggingId(port.id);
    return true;
  }
  async function persistPortOrder(portId: string, targetPosition: number) {
    if (
      !snapshot ||
      pending ||
      refreshing ||
      drawerBusy ||
      drawerOpen.current ||
      renumberDirtyIds.length > 0 ||
      orderBusy.current
    )
      return;
    const original = snapshot.ports.find((port) => port.id === portId);
    if (!original) return;
    const devicePorts = snapshot.ports.filter(
      (port) => port.deviceId === original.deviceId,
    );
    const reordered = reorderPort(devicePorts, portId, targetPosition);
    const changed = reordered.filter(
      (port) =>
        port.orderIndex !==
        devicePorts.find((item) => item.id === port.id)?.orderIndex,
    );
    clearPortDrag();
    if (!changed.length) return;
    orderBusy.current = true;
    setPending(true);
    setError('');
    setNotice('');
    onBusyChange?.(true);
    const request = ++requestNumber.current;
    try {
      const result = await api<PortSaveResult>(
        `/sites/${siteId}/ports/bulk-edit`,
        'POST',
        {
          updates: changed.map((port) => ({
            portId: port.id,
            rowVersion: port.rowVersion,
            changes: { orderIndex: port.orderIndex },
          })),
        },
      );
      if (!mounted.current || request !== requestNumber.current) return;
      setState((previous) =>
        previous.status === 'ready'
          ? {
              status: 'ready',
              snapshot: {
                ...previous.snapshot,
                ports: previous.snapshot.ports.map(
                  (port) =>
                    result.ports.find((saved) => saved.id === port.id) ?? port,
                ),
                devices: previous.snapshot.devices.map(
                  (device) =>
                    result.devices.find((saved) => saved.id === device.id) ??
                    device,
                ),
                customValues: {
                  ...previous.snapshot.customValues,
                  ...result.customValues,
                },
              },
            }
          : previous,
      );
      setNotice('Port order saved.');
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(
            `button[data-port-grip="${CSS.escape(portId)}"]`,
          )
          ?.focus({ preventScroll: true }),
      );
    } catch (cause) {
      if (mounted.current && request === requestNumber.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Port order could not be saved. Refresh saved equipment before retrying.',
        );
    } finally {
      orderBusy.current = false;
      if (mounted.current) {
        setPending(false);
        onBusyChange?.(false);
      }
    }
  }
  async function renameDevicePorts(ports: Port[]): Promise<boolean> {
    if (
      !snapshot ||
      pending ||
      refreshing ||
      drawerBusy ||
      drawerOpen.current ||
      orderBusy.current
    )
      return false;
    const deviceId = ports[0]?.deviceId;
    if (
      !deviceId ||
      ports.some((port) => port.deviceId !== deviceId || port.siteId !== siteId)
    )
      return false;
    const changed = ports.filter(
      (port) =>
        port.name !==
        snapshot.ports.find((saved) => saved.id === port.id)?.name,
    );
    if (!changed.length) {
      setNotice('Port names already match the preview.');
      return true;
    }
    orderBusy.current = true;
    setPending(true);
    onBusyChange?.(true);
    setError('');
    setNotice('');
    const request = ++requestNumber.current;
    try {
      const result = await api<PortSaveResult>(
        `/sites/${siteId}/ports/bulk-edit`,
        'POST',
        {
          updates: changed.map((port) => ({
            portId: port.id,
            rowVersion: port.rowVersion,
            changes: { name: port.name },
          })),
        },
      );
      if (!mounted.current || request !== requestNumber.current) return false;
      setState((previous) =>
        previous.status === 'ready'
          ? {
              status: 'ready',
              snapshot: {
                ...previous.snapshot,
                ports: previous.snapshot.ports.map(
                  (port) =>
                    result.ports.find((saved) => saved.id === port.id) ?? port,
                ),
                devices: previous.snapshot.devices.map(
                  (device) =>
                    result.devices.find((saved) => saved.id === device.id) ??
                    device,
                ),
                customValues: {
                  ...previous.snapshot.customValues,
                  ...result.customValues,
                },
              },
            }
          : previous,
      );
      setNotice('Port names saved.');
      return true;
    } catch (cause) {
      if (mounted.current && request === requestNumber.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Port names could not be saved.',
        );
      return false;
    } finally {
      orderBusy.current = false;
      if (mounted.current) {
        setPending(false);
        onBusyChange?.(false);
      }
    }
  }
  function dropPort(target: Port) {
    const source = dragSource.current;
    if (!source || source.deviceId !== target.deviceId || !snapshot) {
      clearPortDrag();
      return;
    }
    const ordered = snapshot.ports
      .filter((port) => port.deviceId === source.deviceId)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id));
    void persistPortOrder(
      source.portId,
      ordered.findIndex((port) => port.id === target.id),
    );
  }
  function portButton(port: Port, device: Device) {
    const cable = snapshot!.connections.find(
      (item) =>
        item.endpointAPortId === port.id || item.endpointBPortId === port.id,
    );
    const peerId = cable
      ? cable.endpointAPortId === port.id
        ? cable.endpointBPortId
        : cable.endpointAPortId
      : null;
    const connectedLabel = peerId ? endpointLabel(peerId) : '';
    return (
      <div
        className="visual-port-slot"
        key={port.id}
        data-port-drop-id={port.id}
        data-dragging={draggingId === port.id}
        onDragOver={(event) => {
          if (dragSource.current?.deviceId === port.deviceId) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          dropPort(port);
        }}
      >
        <button
          type="button"
          className="visual-port-grip"
          data-port-grip={port.id}
          aria-label={`Reorder ${device.displayName} ${port.name}`}
          aria-pressed={draggingId === port.id}
          disabled={
            pending ||
            refreshing ||
            drawerBusy ||
            Boolean(selectedId) ||
            renumberDirtyIds.length > 0
          }
          draggable={
            !pending && !refreshing && !selectedId && !renumberDirtyIds.length
          }
          title="Drag to reorder. Keyboard: Enter to pick up, arrows to choose position, Enter to save, Escape to cancel."
          onDragStart={(event) => {
            if (!beginPortDrag(port)) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', port.id);
          }}
          onDragEnd={clearPortDrag}
          onPointerDown={(event) => {
            if (event.pointerType === 'touch' && beginPortDrag(port)) {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          }}
          onPointerUp={(event) => {
            if (event.pointerType !== 'touch' || !dragSource.current) return;
            event.preventDefault();
            const targetElement = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest<HTMLElement>('[data-port-drop-id]');
            const target = snapshot!.ports.find(
              (item) => item.id === targetElement?.dataset.portDropId,
            );
            if (target) dropPort(target);
            else clearPortDrag();
          }}
          onPointerCancel={(event) => {
            // Native mouse drag dispatches pointercancel when HTML DnD takes
            // ownership. Only cancel the separate touch-pointer gesture here.
            if (event.pointerType === 'touch') clearPortDrag();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              clearPortDrag();
              setNotice('Port reordering cancelled.');
              return;
            }
            const ordered = snapshot!.ports
              .filter((item) => item.deviceId === port.deviceId)
              .sort(
                (a, b) =>
                  a.orderIndex - b.orderIndex || a.id.localeCompare(b.id),
              );
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (draggingId === port.id && keyboardPosition !== null) {
                void persistPortOrder(port.id, keyboardPosition);
              } else if (beginPortDrag(port)) {
                const position = ordered.findIndex(
                  (item) => item.id === port.id,
                );
                setKeyboardPosition(position);
                setNotice(
                  `${port.name} picked up. Position ${position + 1} of ${ordered.length}. Use arrow keys, then Enter to save.`,
                );
              }
              return;
            }
            if (
              draggingId === port.id &&
              keyboardPosition !== null &&
              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                event.key,
              )
            ) {
              event.preventDefault();
              const position = Math.max(
                0,
                Math.min(
                  ordered.length - 1,
                  keyboardPosition +
                    (event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                      ? -1
                      : 1),
                ),
              );
              setKeyboardPosition(position);
              setNotice(
                `${port.name}: position ${position + 1} of ${ordered.length}. Enter saves; Escape cancels.`,
              );
            }
          }}
        >
          ⠿
        </button>
        <button
          id={`visual-port-${port.id}`}
          data-port-id={port.id}
          data-kind={port.kind}
          data-mode={port.mode}
          type="button"
          className="visual-port"
          aria-label={`${device.displayName} ${port.name}, ${portSummary(port, snapshot!.vlans)}${connectedLabel ? ', connected to ' + connectedLabel : ''}`}
          aria-pressed={selectedId === port.id}
          title={`${port.name}: ${portSummary(port, snapshot!.vlans)}`}
          onClick={() => inspectPort(port.id)}
          onFocus={() => setPreviewId(port.id)}
          onMouseEnter={() => setPreviewId(port.id)}
        >
          <Connector
            kind={port.kind}
            color={portColor(port, snapshot!.vlans)}
          />
          <span className="visual-port-label">{port.name}</span>
          <span className="visual-port-mode">{modeNames[port.mode]}</span>
          {port.nativeVlanRef &&
            port.mode !== 'routed' &&
            snapshot!.vlans
              .filter((vlan) => vlan.id === port.nativeVlanRef)
              .map((vlan) => (
                <span
                  key={vlan.id}
                  className="visual-port-vlan"
                  data-vlan-id={vlan.id}
                  data-membership="native"
                  style={{ borderColor: vlanColor(vlan) }}
                  title={
                    'Native/Untagged: VLAN ' + vlan.vlanId + ' · ' + vlan.name
                  }
                >
                  VLAN {vlan.vlanId}
                </span>
              ))}
          {port.taggedVlanRefs.slice(0, 3).map((id) => {
            const vlan = snapshot!.vlans.find((item) => item.id === id);
            return vlan ? (
              <span
                key={id}
                className="visual-port-vlan"
                data-vlan-id={id}
                data-membership="tagged"
                style={{ borderColor: vlanColor(vlan) }}
                title={'Tagged: VLAN ' + vlan.vlanId + ' · ' + vlan.name}
              >
                Tagged {vlan.vlanId}
              </span>
            ) : null;
          })}
          {port.taggedVlanRefs.length > 3 && (
            <span className="visual-port-cable">
              +{port.taggedVlanRefs.length - 3} tagged
            </span>
          )}
          {cable && (
            <span
              className="visual-port-cable visual-port-peer"
              title={`Connected to ${connectedLabel}`}
            >
              ↔ {connectedLabel}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <section
      className={
        'equipment-summary visual-equipment' +
        (deviceId ? ' device-front-panel' : '')
      }
      aria-labelledby="equipment-title"
    >
      <div className="equipment-toolbar">
        <h2 id="equipment-title">{deviceId ? 'Front panel' : 'Equipment'}</h2>
        <button
          type="button"
          className="subtle"
          disabled={
            state.status === 'loading' ||
            pending ||
            refreshing ||
            Boolean(draggingId) ||
            renumberDirtyIds.length > 0
          }
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
      ) : !visibleSnapshot!.devices.length ? (
        <p className="equipment-empty" role={deviceId ? 'alert' : undefined}>
          {deviceId
            ? 'The selected device is unavailable in this site.'
            : 'No equipment configured yet.'}
        </p>
      ) : (
        <>
          <div className="visual-controls">
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
          <div className="visual-layout">
            <div className="visual-stack" ref={cableContainer}>
              {groupedDevices(visibleSnapshot!).map((group) => (
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
                            {!deviceId && (
                              <>
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
                                    pending ||
                                    index === group.devices.length - 1
                                  }
                                  aria-label={`Move ${device.displayName} down`}
                                  onClick={() => void move(device, 1)}
                                >
                                  ↓
                                </button>
                              </>
                            )}
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
                        {ports.length > 0 && (
                          <RenumberPortsTool
                            key={device.id}
                            device={device}
                            ports={ports}
                            disabled={
                              pending ||
                              refreshing ||
                              drawerBusy ||
                              Boolean(selectedId)
                            }
                            onRename={renameDevicePorts}
                            onDirtyChange={(dirty) =>
                              updateRenumberDirty(device.id, dirty)
                            }
                          />
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
                                    style={
                                      facePorts.length > 12
                                        ? {
                                            gridTemplateColumns: `repeat(${Math.ceil(facePorts.length / 2)}, var(--port-tile))`,
                                          }
                                        : undefined
                                    }
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
              {showConnections && (
                <CableOverlay
                  snapshot={snapshot!}
                  container={cableContainer}
                  selectedPortId={selectedId}
                  onInspect={inspectPort}
                />
              )}
            </div>
            {selected && (
              <PortInspector
                key={selected.id}
                port={selected}
                snapshot={snapshot!}
                onClose={closeInspector}
                onInspect={inspectPort}
                onDirtyChange={updateDrawerDirty}
                onBusyChange={setDrawerBusy}
                onSaved={(result) => {
                  // Invalidate any older equipment read before publishing saved records.
                  ++requestNumber.current;
                  setRefreshing(false);
                  setState((previous) =>
                    previous.status === 'ready'
                      ? {
                          status: 'ready',
                          snapshot: {
                            ...previous.snapshot,
                            ports: previous.snapshot.ports.map(
                              (port) =>
                                result.ports.find(
                                  (item) => item.id === port.id,
                                ) ?? port,
                            ),
                            devices: previous.snapshot.devices.map(
                              (device) =>
                                result.devices.find(
                                  (item) => item.id === device.id,
                                ) ?? device,
                            ),
                            customValues: {
                              ...previous.snapshot.customValues,
                              ...result.customValues,
                            },
                          },
                        }
                      : previous,
                  );
                }}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RenumberPortsTool({
  device,
  ports,
  disabled,
  onRename,
  onDirtyChange,
}: {
  device: Device;
  ports: Port[];
  disabled: boolean;
  onRename: (ports: Port[]) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prefix, setPrefix] = useState('Port ');
  const [start, setStart] = useState('1');
  const [preview, setPreview] = useState<Port[] | null>(null);
  const [error, setError] = useState('');
  const dirty = prefix !== 'Port ' || start !== '1' || preview !== null;
  const reportDirty = useEffectEvent(onDirtyChange);
  useEffect(() => {
    reportDirty(dirty);
  }, [dirty]);
  useEffect(() => () => reportDirty(false), []);
  function clear() {
    setPrefix('Port ');
    setStart('1');
    setPreview(null);
    setError('');
    onDirtyChange(false);
  }
  return (
    <details className="visual-renumber-tool">
      <summary>Renumber ports</summary>
      <form
        aria-label={`Renumber ports on ${device.displayName}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          setError('');
          try {
            setPreview(renumberPorts(ports, prefix, Number(start)));
          } catch (cause) {
            setPreview(null);
            setError(
              cause instanceof Error
                ? cause.message
                : 'Choose a valid prefix and start number.',
            );
          }
        }}
      >
        <label>
          Name prefix
          <input
            aria-label={`${device.displayName} port name prefix`}
            value={prefix}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => {
              setPrefix(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label>
          Start number
          <input
            aria-label={`${device.displayName} port start number`}
            type="number"
            min={1}
            max={65535}
            step={1}
            required
            value={start}
            disabled={disabled}
            onChange={(event) => {
              setStart(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button type="submit" disabled={disabled}>
          Preview port names
        </button>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {preview && (
          <section aria-label="Port name preview">
            <p>
              {preview.length} port names in physical order. Saved names change
              only after Rename ports.
            </p>
            <ol>
              {preview.map((port) => (
                <li key={port.id}>
                  {ports.find((saved) => saved.id === port.id)?.name} →{' '}
                  <strong>{port.name}</strong>
                </li>
              ))}
            </ol>
            <button
              type="button"
              disabled={disabled}
              onClick={async () => {
                if (await onRename(preview)) clear();
              }}
            >
              Rename ports
            </button>
          </section>
        )}
        <button type="button" disabled={disabled} onClick={clear}>
          Clear renumbering
        </button>
      </form>
    </details>
  );
}
