import { useEffect, useRef } from 'react';
import type { Port } from '../../../../packages/shared/src/index.js';
import {
  connectorNames,
  documentedState,
  displayCustomValue,
  effectiveCustomValue,
  modeNames,
  vlanLabel,
  type EquipmentSnapshot,
} from './model.js';

export function PortInspector({
  port,
  snapshot,
  onClose,
  onInspect,
  onConfigure,
}: {
  port: Port;
  snapshot: EquipmentSnapshot;
  onClose: () => void;
  onInspect: (portId: string) => void;
  onConfigure?: ((deviceId?: string, portId?: string) => void) | undefined;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [port.id]);
  const device = snapshot.devices.find((item) => item.id === port.deviceId);
  const cable = snapshot.connections.find(
    (item) =>
      item.endpointAPortId === port.id || item.endpointBPortId === port.id,
  );
  const peer = cable
    ? snapshot.ports.find(
        (item) =>
          item.id ===
          (cable.endpointAPortId === port.id
            ? cable.endpointBPortId
            : cable.endpointAPortId),
      )
    : undefined;
  const peerDevice = snapshot.devices.find(
    (item) => item.id === peer?.deviceId,
  );
  return (
    <aside
      className="visual-inspector"
      aria-label="Port inspector"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="inspector-topline">
        <p>PORT INSPECTOR</p>
        <button
          type="button"
          className="subtle"
          onClick={onClose}
          aria-label="Close port inspector"
        >
          Close
        </button>
      </div>
      <h2 ref={heading} tabIndex={-1}>
        {port.name}
      </h2>
      <p className="inspector-device">{device?.displayName ?? 'Device'}</p>
      <div className="inspector-mode">{modeNames[port.mode]}</div>
      <dl className="inspector-facts">
        <div>
          <dt>Connector</dt>
          <dd>{connectorNames[port.kind]}</dd>
        </div>
        <div>
          <dt>Face</dt>
          <dd>{port.face === 'front' ? 'Front' : 'Rear'}</dd>
        </div>
        <div>
          <dt>Physical order</dt>
          <dd>{port.orderIndex + 1}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{port.speed || 'Not documented'}</dd>
        </div>
        <div>
          <dt>Link state</dt>
          <dd>{documentedState(port)}</dd>
        </div>
        <div>
          <dt>Native/Untagged VLAN</dt>
          <dd>{vlanLabel(port.nativeVlanRef, snapshot.vlans)}</dd>
        </div>
        <div>
          <dt>PVID</dt>
          <dd>{port.pvid ?? 'Not set'}</dd>
        </div>
        <div>
          <dt>Tagged VLANs</dt>
          <dd>
            {port.taggedVlanRefs.length ? (
              <ul className="inspector-tagged">
                {port.taggedVlanRefs.map((id) => (
                  <li key={id}>{vlanLabel(id, snapshot.vlans)}</li>
                ))}
              </ul>
            ) : (
              'None'
            )}
          </dd>
        </div>
        <div>
          <dt>Documented connection</dt>
          <dd>
            {peer ? (
              <>
                <span>
                  {peerDevice?.displayName ?? 'Device'} / {peer.name}
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onInspect(peer.id)}
                >
                  Inspect connected port
                </button>
              </>
            ) : cable ? (
              'Unavailable endpoint'
            ) : (
              'None'
            )}
          </dd>
        </div>
        {cable && (
          <>
            <div>
              <dt>Cable type</dt>
              <dd>{cable.cableType || 'Not documented'}</dd>
            </div>
            <div>
              <dt>Cable notes</dt>
              <dd className="inspector-notes">{cable.notes || 'None'}</dd>
            </div>
          </>
        )}
        <div>
          <dt>External destination annotation</dt>
          <dd>{port.externalDestinationLabel || 'None'}</dd>
        </div>
        <div>
          <dt>Description/Notes</dt>
          <dd className="inspector-notes">{port.description || 'None'}</dd>
        </div>
      </dl>
      {snapshot.fields.length > 0 && (
        <section className="inspector-custom">
          <h3>Custom fields</h3>
          <dl className="inspector-facts">
            {snapshot.fields
              .slice()
              .sort(
                (a, b) =>
                  a.columnOrder - b.columnOrder ||
                  a.title.localeCompare(b.title),
              )
              .map((field) => (
                <div key={field.id}>
                  <dt>{field.title}</dt>
                  <dd className="inspector-notes">
                    {displayCustomValue(
                      effectiveCustomValue(
                        port.id,
                        field,
                        snapshot.customValues,
                      ),
                    )}
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      )}
      {onConfigure && (
        <button
          type="button"
          className="primary inspector-configure"
          onClick={() => onConfigure(port.deviceId, port.id)}
        >
          Configure this port
        </button>
      )}
      <p className="inspector-disclaimer">
        Manually documented configuration. VLAN color does not indicate live
        link status.
      </p>
    </aside>
  );
}
