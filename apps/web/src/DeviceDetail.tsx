import { useState } from 'react';
import type { Device, Vlan } from '../../../packages/shared/src/index.js';
import { EquipmentSummary } from './EquipmentSummary.js';
import {
  connectorNames,
  documentedState,
  modeNames,
  vlanLabel,
  type EquipmentSnapshot,
} from './visual/model.js';
import './workflow.css';

type DetailState =
  | { key: string; snapshot: EquipmentSnapshot; error?: never }
  | { key: string; error: string; snapshot?: never };
export function DeviceDetail({
  siteId,
  device,
  devices,
  vlans,
  onConfigure,
  onEdit,
}: {
  siteId: string;
  device: Device;
  devices: Device[];
  vlans: Vlan[];
  onConfigure: (portId?: string, deviceId?: string) => void;
  onEdit: () => void;
}) {
  const [state, setState] = useState<DetailState | null>(null);
  const [retry, setRetry] = useState(0);
  const key = siteId + ':' + device.id + ':' + device.rowVersion + ':' + retry;
  const ready = state?.key === key ? state : null;
  const snapshot = ready?.snapshot;
  const current = snapshot?.devices.find((item) => item.id === device.id);
  const ports =
    snapshot?.ports
      .filter((port) => port.deviceId === device.id)
      .sort((a, b) => a.orderIndex - b.orderIndex) ?? [];
  if (snapshot && !current)
    return (
      <p role="alert" className="error-message">
        The selected device is unavailable in this site.
      </p>
    );
  function endpoint(portId: string) {
    const port = snapshot?.ports.find((item) => item.id === portId);
    const parent = (snapshot?.devices ?? devices).find(
      (item) => item.id === port?.deviceId,
    );
    return port
      ? (parent?.displayName ?? 'Device') + ' · ' + port.name
      : 'Unavailable endpoint';
  }
  return (
    <section className="device-detail" aria-label="Device details">
      <header className="configure-toolbar">
        <div>
          <h1 className="device-detail-title">
            {current?.displayName ?? device.displayName}
          </h1>
          <p className="section-description">
            {[(current ?? device).manufacturer, (current ?? device).model]
              .filter(Boolean)
              .join(' · ') || (current ?? device).type}
          </p>
        </div>
        <div className="workflow-actions">
          <button type="button" onClick={onEdit}>
            Edit device details
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onConfigure(undefined, device.id)}
          >
            Configure interfaces
          </button>
        </div>
      </header>
      {(current ?? device).managementIp && (
        <p>
          Management IP: <code>{(current ?? device).managementIp}</code>
        </p>
      )}
      <EquipmentSummary
        key={key}
        siteId={siteId}
        deviceId={device.id}
        onSnapshotChange={(snapshot, error) =>
          setState(snapshot ? { key, snapshot } : error ? { key, error } : null)
        }
        onConfigure={(deviceId, portId) => onConfigure(portId, deviceId)}
      />
      <section aria-labelledby="device-interface-summary-heading">
        <h2 id="device-interface-summary-heading">Interfaces & connections</h2>
        {!ready ? (
          <p role="status">Loading interface summaries…</p>
        ) : ready.error ? (
          <div role="alert" className="error-message">
            <p>{ready.error}</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry interface summary
            </button>
          </div>
        ) : ports.length === 0 ? (
          <p>No interfaces configured yet.</p>
        ) : (
          <div
            className="workflow-table-wrap"
            role="region"
            tabIndex={0}
            aria-label="Interface summary table"
          >
            <table
              className="workflow-table interface-summary"
              aria-label="Interfaces and connections"
            >
              <thead>
                <tr>
                  <th scope="col">Port</th>
                  <th scope="col">Interface type</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Native / untagged</th>
                  <th scope="col">Tagged VLANs</th>
                  <th scope="col">Connected to</th>
                  <th scope="col">Documented link state</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((port) => {
                  const cable = snapshot?.connections.find(
                    (item) =>
                      item.endpointAPortId === port.id ||
                      item.endpointBPortId === port.id,
                  );
                  const peer = cable
                    ? endpoint(
                        cable.endpointAPortId === port.id
                          ? cable.endpointBPortId
                          : cable.endpointAPortId,
                      )
                    : null;
                  return (
                    <tr key={port.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => onConfigure(port.id, device.id)}
                          title={'Configure ' + port.name}
                        >
                          {port.name}
                        </button>
                      </th>
                      <td>{connectorNames[port.kind]}</td>
                      <td>{modeNames[port.mode]}</td>
                      <td>
                        {vlanLabel(
                          port.nativeVlanRef,
                          snapshot?.vlans ?? vlans,
                        )}
                      </td>
                      <td>
                        {port.taggedVlanRefs.length
                          ? port.taggedVlanRefs
                              .map((id) =>
                                vlanLabel(id, snapshot?.vlans ?? vlans),
                              )
                              .join(', ')
                          : 'None'}
                      </td>
                      <td>
                        {peer
                          ? 'Documented cable: ' + peer
                          : port.externalDestinationLabel
                            ? 'External label: ' + port.externalDestinationLabel
                            : 'Not connected'}
                      </td>
                      <td>{documentedState(port)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
