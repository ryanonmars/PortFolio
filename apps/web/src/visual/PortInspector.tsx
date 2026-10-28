import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  type Port,
  type Device,
  type PortCustomValues,
  type CustomValue,
} from '../../../../packages/shared/src/index.js';
import { api, ApiError } from '../api.js';
import { CustomInput } from '../grid/CustomFields.js';
import { TaggedVlanPicker } from '../TaggedVlanPicker.js';
import { rowErrors } from '../grid/helpers.js';
import {
  connectorNames,
  effectiveCustomValue,
  modeNames,
  vlanLabel,
  type EquipmentSnapshot,
} from './model.js';
export type PortSaveResult = {
  ports: Port[];
  customValues: PortCustomValues;
  devices: Device[];
};
export function PortInspector({
  port,
  snapshot,
  onClose,
  onInspect,
  onSaved,
  onBusyChange,
  onDirtyChange,
}: {
  port: Port;
  snapshot: EquipmentSnapshot;
  onClose: () => void;
  onInspect: (id: string) => void;
  onSaved: (result: PortSaveResult) => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [baseline, setBaseline] = useState(port);
  const [draft, setDraft] = useState(port);
  const [custom, setCustom] = useState<Record<string, CustomValue>>({});
  const [stored, setStored] = useState(snapshot.customValues);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(baseline) ||
    Object.keys(custom).length > 0;
  const reportDirty = useEffectEvent(onDirtyChange);
  const reportBusy = useEffectEvent(onBusyChange);
  useEffect(() => {
    reportDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    reportBusy(pending);
  }, [pending]);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      reportBusy(false);
      reportDirty(false);
    };
  }, []);
  const errors = {
    ...rowErrors(draft, custom, snapshot.fields),
    ...serverErrors,
  };
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
  function change(changes: Partial<Port>) {
    setDraft((previous) => ({ ...previous, ...changes }));
    setServerErrors({});
    setNotice('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || conflict) return;
    if (Object.keys(rowErrors(draft, custom, snapshot.fields)).length) {
      setError('Review the highlighted fields. Nothing was saved.');
      return;
    }
    setPending(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    try {
      const changes = Object.fromEntries(
        Object.entries(draft).filter(
          ([key]) => !['id', 'siteId', 'deviceId', 'rowVersion'].includes(key),
        ),
      );
      const result = await api<PortSaveResult>(
        `/sites/${port.siteId}/ports/bulk-edit`,
        'POST',
        {
          updates: [
            {
              portId: port.id,
              rowVersion: baseline.rowVersion,
              changes,
              customValues: custom,
            },
          ],
        },
      );
      if (!mounted.current) return;
      const saved = result.ports.find((item) => item.id === port.id);
      if (!saved)
        throw new Error(
          'The saved port was not returned. Reload saved records before retrying.',
        );
      setBaseline(saved);
      setDraft(saved);
      setCustom({});
      setStored((previous) => ({ ...previous, ...result.customValues }));
      onDirtyChange(false);
      onSaved(result);
      setNotice('Port saved.');
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError) {
        if (cause.status === 409) setConflict(true);
        setServerErrors(
          Object.fromEntries(
            Object.entries(cause.fieldErrors ?? {}).map(([key, value]) => [
              key.startsWith('updates.0.customValues.')
                ? `custom:${key.slice('updates.0.customValues.'.length)}`
                : key.replace(/^updates\.0\.changes\./, '').split('.')[0]!,
              value.join(' '),
            ]),
          ),
        );
      }
      setError(
        cause instanceof Error ? cause.message : 'The port could not be saved.',
      );
    } finally {
      if (mounted.current) {
        setPending(false);
        onBusyChange(false);
      }
    }
  }
  async function reload() {
    if (
      pending ||
      (dirty &&
        !window.confirm('Discard your port edits and reload the saved port?'))
    )
      return;
    setPending(true);
    onBusyChange(true);
    setError('');
    try {
      const [result, values] = await Promise.all([
        api<{ port: Port }>(`/sites/${port.siteId}/ports/${port.id}`),
        api<{ customValues: PortCustomValues }>(
          `/sites/${port.siteId}/devices/${port.deviceId}/port-values`,
        ),
      ]);
      if (!mounted.current) return;
      setBaseline(result.port);
      setDraft(result.port);
      setStored(values.customValues);
      setCustom({});
      setConflict(false);
      setServerErrors({});
      onDirtyChange(false);
      onSaved({
        ports: [result.port],
        customValues: values.customValues,
        devices: [],
      });
      setNotice('Saved port reloaded.');
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The saved port could not be loaded.',
        );
    } finally {
      if (mounted.current) {
        setPending(false);
        onBusyChange(false);
      }
    }
  }
  function attrs(key: string) {
    return {
      id: `drawer-${key}`,
      disabled: pending,
      'aria-invalid': Boolean(errors[key]) || undefined,
      'aria-describedby': errors[key] ? `drawer-error-${key}` : undefined,
    };
  }
  function field(key: string, title: string, control: ReactNode) {
    return (
      <div className="port-drawer-field">
        <label htmlFor={`drawer-${key}`}>{title}</label>
        {control}
        {errors[key] && (
          <p className="error-message" role="alert" id={`drawer-error-${key}`}>
            {errors[key]}
          </p>
        )}
      </div>
    );
  }
  return (
    <dialog
      ref={dialog}
      className="visual-inspector"
      aria-label="Port inspector"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <form className="port-drawer-form" onSubmit={(event) => void save(event)}>
        <header className="port-drawer-header">
          <div className="inspector-topline">
            <p>PORT INSPECTOR</p>
            <button
              type="button"
              className="subtle"
              disabled={pending}
              onClick={onClose}
              aria-label="Close port inspector"
            >
              Close
            </button>
          </div>
          <h2>{baseline.name}</h2>
          <p className="inspector-device">{device?.displayName ?? 'Device'}</p>
        </header>
        <div className="port-drawer-body">
          <section className="port-cable-summary" aria-label="Cable endpoints">
            <h3>Cable connection</h3>
            <dl className="inspector-facts">
              <div>
                <dt>This port</dt>
                <dd>
                  {device?.displayName ?? 'Device'} / {port.name}
                </dd>
              </div>
              <div>
                <dt>Connected to</dt>
                <dd>
                  {peer ? (
                    <>
                      <button
                        type="button"
                        className="text-button"
                        disabled={pending}
                        aria-label={`Inspect connected port ${peerDevice?.displayName ?? 'Device'} ${peer.name}`}
                        onClick={() => onInspect(peer.id)}
                      >
                        {peerDevice?.displayName ?? 'Device'} / {peer.name} →
                      </button>
                    </>
                  ) : cable ? (
                    'Unavailable endpoint'
                  ) : (
                    'None'
                  )}
                </dd>
              </div>
            </dl>
          </section>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {conflict && (
            <p role="alert">
              Saved records changed. Your edits are preserved. Reload the saved
              port before saving again.
            </p>
          )}
          {field(
            'name',
            'Port name',
            <input
              {...attrs('name')}
              required
              maxLength={120}
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
            />,
          )}
          {field(
            'kind',
            'Interface type',
            <select
              {...attrs('kind')}
              value={draft.kind}
              onChange={(event) =>
                change({ kind: event.target.value as Port['kind'] })
              }
            >
              {Object.entries(connectorNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>,
          )}
          {field(
            'mode',
            'Mode',
            <select
              {...attrs('mode')}
              value={draft.mode}
              onChange={(event) =>
                change({ mode: event.target.value as Port['mode'] })
              }
            >
              {Object.entries(modeNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>,
          )}
          {field(
            'nativeVlanRef',
            'Native/Untagged VLAN',
            <select
              {...attrs('nativeVlanRef')}
              value={draft.nativeVlanRef ?? ''}
              onChange={(event) =>
                change({ nativeVlanRef: event.target.value || null })
              }
            >
              <option value="">None</option>
              {snapshot.vlans.map((vlan) => (
                <option key={vlan.id} value={vlan.id}>
                  {vlanLabel(vlan.id, snapshot.vlans)}
                </option>
              ))}
            </select>,
          )}
          <div className="port-drawer-field">
            <TaggedVlanPicker
              label="Tagged VLANs"
              vlans={snapshot.vlans}
              value={draft.taggedVlanRefs}
              onChange={(ids: string[]) => change({ taggedVlanRefs: ids })}
              disabled={pending}
              invalid={Boolean(errors.taggedVlanRefs)}
              errorId={
                errors.taggedVlanRefs
                  ? 'drawer-error-taggedVlanRefs'
                  : undefined
              }
            />
            {errors.taggedVlanRefs && (
              <p
                id="drawer-error-taggedVlanRefs"
                role="alert"
                className="error-message"
              >
                {errors.taggedVlanRefs}
              </p>
            )}
          </div>
          {field(
            'orderIndex',
            'Physical order',
            <input
              {...attrs('orderIndex')}
              type="number"
              min={1}
              max={65536}
              step={1}
              required
              value={Number.isNaN(draft.orderIndex) ? '' : draft.orderIndex + 1}
              onChange={(event) =>
                change({
                  orderIndex:
                    event.target.value === ''
                      ? Number.NaN
                      : Number(event.target.value) - 1,
                })
              }
            />,
          )}
          {field(
            'pvid',
            'PVID',
            <input
              {...attrs('pvid')}
              type="number"
              min={1}
              max={4094}
              step={1}
              value={draft.pvid ?? ''}
              onChange={(event) =>
                change({
                  pvid:
                    event.target.value === ''
                      ? null
                      : Number(event.target.value),
                })
              }
            />,
          )}
          {field(
            'speed',
            'Speed',
            <input
              {...attrs('speed')}
              maxLength={64}
              value={draft.speed}
              onChange={(event) => change({ speed: event.target.value })}
            />,
          )}
          {field(
            'documentedLinkState',
            'Documented link state',
            <select
              {...attrs('documentedLinkState')}
              value={draft.documentedLinkState}
              onChange={(event) =>
                change({
                  documentedLinkState: event.target
                    .value as Port['documentedLinkState'],
                })
              }
            >
              <option value="unknown">Unknown</option>
              <option value="up">Documented up</option>
              <option value="down">Documented down</option>
            </select>,
          )}
          {field(
            'face',
            'Face',
            <select
              {...attrs('face')}
              value={draft.face}
              onChange={(event) =>
                change({ face: event.target.value as Port['face'] })
              }
            >
              <option value="front">Front</option>
              <option value="rear">Rear</option>
            </select>,
          )}
          {field(
            'description',
            'Description/Notes',
            <textarea
              {...attrs('description')}
              rows={3}
              maxLength={10000}
              value={draft.description}
              onChange={(event) => change({ description: event.target.value })}
            />,
          )}
          {field(
            'externalDestinationLabel',
            'External destination annotation',
            <input
              {...attrs('externalDestinationLabel')}
              maxLength={500}
              value={draft.externalDestinationLabel}
              onChange={(event) =>
                change({ externalDestinationLabel: event.target.value })
              }
            />,
          )}
          {snapshot.fields.length > 0 && (
            <section className="inspector-custom">
              <h3>Custom fields</h3>
              {snapshot.fields
                .slice()
                .sort(
                  (a, b) =>
                    a.columnOrder - b.columnOrder ||
                    a.title.localeCompare(b.title),
                )
                .map((definition) => (
                  <div className="port-drawer-field" key={definition.id}>
                    <label>{definition.title}</label>
                    <CustomInput
                      field={definition}
                      label={definition.title}
                      value={
                        Object.hasOwn(custom, definition.id)
                          ? custom[definition.id]!
                          : effectiveCustomValue(port.id, definition, stored)
                      }
                      disabled={pending}
                      invalid={Boolean(errors[`custom:${definition.id}`])}
                      errorId={
                        errors[`custom:${definition.id}`]
                          ? `drawer-error-custom-${definition.id}`
                          : undefined
                      }
                      onChange={(value) => {
                        setCustom((previous) => ({
                          ...previous,
                          [definition.id]: value,
                        }));
                        setServerErrors({});
                        setNotice('');
                      }}
                    />
                    {errors[`custom:${definition.id}`] && (
                      <p
                        id={`drawer-error-custom-${definition.id}`}
                        role="alert"
                        className="error-message"
                      >
                        {errors[`custom:${definition.id}`]}
                      </p>
                    )}
                  </div>
                ))}
            </section>
          )}
          <h3>Cable details</h3>
          <dl className="inspector-facts">
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
          </dl>
          <p className="inspector-disclaimer">
            Manually documented configuration. VLAN color does not indicate live
            link status.
          </p>
        </div>
        <footer className="port-drawer-footer">
          <span role="status">{dirty ? 'Unsaved changes' : 'Saved'}</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => void reload()}
          >
            Reload saved port
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!dirty || pending || conflict}
          >
            {pending ? 'Saving…' : 'Save port'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
