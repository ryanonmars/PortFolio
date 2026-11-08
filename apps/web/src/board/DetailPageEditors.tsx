import { useState } from 'react';
import {
  normalizeNetworkEntry,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';
import {
  documentationFields,
  editDeviceField,
  editDocumentationField,
  editNetworkField,
  editPortField,
} from './detail-edit.js';
import type { BoardPage, NetworkItem } from './detail-model.js';
import { networkDisplayValue as value } from './network-presentation.js';

export type DetailChange = (next: BoardDocument, label: string) => boolean;
interface Base {
  document: BoardDocument;
  onChange: DetailChange;
}
function useCommit(onChange: DetailChange) {
  const [error, setError] = useState('');
  return {
    error,
    commit(next: BoardDocument | null, label: string) {
      if (!next) {
        setError('This value exceeds the supported field limits.');
        return;
      }
      const accepted = onChange(next, label);
      setError(
        accepted
          ? ''
          : 'This change could not be saved. Check the board save status.',
      );
    },
  };
}
function TextField({
  label,
  text,
  onChange,
  multiline = false,
  maxLength = 10000,
  ariaLabel,
}: {
  label: string;
  text: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  maxLength?: number;
  ariaLabel?: string;
}) {
  return (
    <label
      className={`detail-edit-field${multiline ? ' detail-edit-wide' : ''}`}
    >
      <span>{label}</span>
      {multiline ? (
        <textarea
          aria-label={ariaLabel ?? label}
          value={text}
          maxLength={maxLength}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          aria-label={ariaLabel ?? label}
          value={text}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
function Status({ error }: { error: string }) {
  return (
    <>
      {error && (
        <p role="alert" className="detail-edit-error">
          {error}
        </p>
      )}
      <p className="detail-footnote">
        Changes save automatically and share the board’s undo history.
      </p>
    </>
  );
}
/** Keep only the comma-delimited typing buffer local, matching the canvas inspector. */
function TaggedVlanField({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  return (
    <label className="detail-edit-field">
      <span>Tagged VLANs</span>
      <input
        aria-label="Tagged VLANs"
        value={typing ?? tags.join(', ')}
        maxLength={10000}
        onBlur={() => setTyping(null)}
        onChange={(event) => {
          const text = event.target.value;
          setTyping(text);
          onChange(
            text
              .split(/[,\n]/)
              .map((item) => item.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}
export function DeviceEditor({
  document,
  device,
  onChange,
}: Base & { device: BoardElement }) {
  const { error, commit } = useCommit(onChange);
  return (
    <section
      className="detail-section detail-edit-panel"
      aria-label="Edit device configuration"
    >
      <h2>Device configuration</h2>
      <div className="detail-edit-grid">
        {[
          ['name', 'Device name'],
          ['manufacturer', 'Manufacturer'],
          ['model', 'Model'],
          ['managementAddress', 'Management IP'],
          ['deviceType', 'Device type'],
          ['notes', 'Device notes'],
        ].map(([key, title]) => (
          <TextField
            key={key}
            label={title!}
            text={key === 'name' ? device.name : value(device.properties[key!])}
            maxLength={key === 'name' ? 240 : 10000}
            multiline={key === 'notes'}
            onChange={(text) =>
              commit(
                editDeviceField(document, device.id, key!, text),
                `Property:${device.id}:${key}`,
              )
            }
          />
        ))}
      </div>
      <Status error={error} />
    </section>
  );
}
export function NetworkEditor({
  document,
  item,
  onChange,
}: Base & { item: NetworkItem }) {
  const { error, commit } = useCommit(onChange);
  const normalized = normalizeNetworkEntry(item.entry);
  const update = (key: string, text: JsonValue) =>
    commit(
      editNetworkField(document, item.container.id, item.entryId, key, text),
      `Property:${item.container.id}:entry:${item.entryId}:${key}`,
    );
  return (
    <section
      className="detail-section detail-edit-panel"
      aria-label="Edit network configuration"
    >
      <h2>Network configuration</h2>
      <div className="detail-edit-grid">
        {[
          ['vlanId', 'VLAN ID'],
          ['vlanName', 'Network name'],
          ['subnet', 'Subnet/CIDR'],
          ['gateway', 'Gateway'],
        ].map(([key, title]) => (
          <TextField
            key={key}
            label={title!}
            text={
              key === 'vlanName'
                ? value(normalized.vlanName)
                : key === 'subnet'
                  ? value(
                      Object.hasOwn(item.entry, 'subnet')
                        ? item.entry.subnet
                        : item.entry.cidr,
                    )
                  : value(item.entry[key!])
            }
            onChange={(text) => update(key!, text)}
          />
        ))}
        <label className="detail-edit-field">
          <span>DHCP state</span>
          <select
            aria-label="DHCP state"
            value={
              typeof normalized.dhcpServer === 'boolean'
                ? normalized.dhcpServer
                  ? 'enabled'
                  : 'disabled'
                : 'unset'
            }
            onChange={(event) =>
              update(
                'dhcpServer',
                event.target.value === 'unset'
                  ? null
                  : event.target.value === 'enabled',
              )
            }
          >
            <option value="unset">Not documented</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="detail-edit-field">
          <span>VLAN color</span>
          <input
            aria-label="VLAN color"
            type="color"
            value={
              /^#[\da-f]{6}$/i.test(value(item.entry.color))
                ? value(item.entry.color)
                : '#849389'
            }
            onChange={(event) => update('color', event.target.value)}
          />
        </label>
        {[
          ['dhcpStart', 'DHCP pool start'],
          ['dhcpEnd', 'DHCP pool end'],
          ['dns', 'DNS servers'],
          ['notes', 'Network notes'],
        ].map(([key, title]) => (
          <TextField
            key={key}
            label={title!}
            text={value(item.entry[key!])}
            multiline={key === 'notes'}
            onChange={(text) => update(key!, text)}
          />
        ))}
      </div>
      <Status error={error} />
    </section>
  );
}
export function DocumentationEditor({
  document,
  page,
  properties,
  entity,
  onChange,
}: Base & {
  page: BoardPage;
  properties: Record<string, JsonValue>;
  entity: 'Network' | 'Device';
}) {
  const { error, commit } = useCommit(onChange);
  const raw = properties.documentation;
  const documentation =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const populated = Object.values(documentation).some((item) => value(item));
  const fields =
    entity === 'Network'
      ? documentationFields.filter(
          ([key]) => key === 'description' || key === 'notes',
        )
      : documentationFields;
  const identity =
    page.kind === 'device'
      ? page.deviceId
      : page.kind === 'network'
        ? `${page.containerId}:entry:${page.entryId}`
        : '';
  return (
    <details className="detail-documentation-editor">
      <summary>
        {populated ? 'Edit documentation' : 'Add documentation'}
      </summary>
      <p className="detail-footnote">
        Optional notes stay with this object and do not add labels to the
        canvas.
      </p>
      <div className="detail-edit-grid">
        {fields.map(([key, title]) => (
          <TextField
            key={key}
            label={title}
            ariaLabel={`${entity} ${title}`}
            text={value(documentation[key])}
            multiline={key === 'description' || key === 'notes'}
            onChange={(text) =>
              commit(
                editDocumentationField(document, page, key, text),
                `Property:${identity}:documentation:${key}`,
              )
            }
          />
        ))}
      </div>
      <Status error={error} />
    </details>
  );
}
export function PortEditor({
  document,
  port,
  onChange,
}: Base & { port: BoardPort }) {
  const { error, commit } = useCommit(onChange);
  const update = (key: string, text: JsonValue) =>
    commit(
      editPortField(document, port.deviceId, port.id, key, text),
      `Property:${port.id}:${key}`,
    );
  return (
    <div
      className="detail-port-editor"
      aria-label={`Port configuration ${port.name}`}
    >
      <div className="detail-edit-grid">
        {[
          ['name', 'Port name'],
          ['role', 'Port purpose'],
          ['speed', 'Speed'],
          ['linkState', 'Documented link status'],
          ['nativeVlan', 'Native VLAN'],
          ['pvid', 'PVID'],
          ['address', 'Interface IP / Address'],
          ['externalDestination', 'External connection'],
          ['notes', 'Port notes'],
        ].map(([key, title]) => (
          <TextField
            key={key}
            label={title!}
            text={value(port[key as keyof BoardPort])}
            maxLength={key === 'name' ? 240 : 10000}
            multiline={key === 'notes'}
            onChange={(text) => update(key!, text)}
          />
        ))}
        <label className="detail-edit-field">
          <span>Port type</span>
          <select
            aria-label="Port type"
            value={port.kind}
            onChange={(event) => update('kind', event.target.value)}
          >
            {[
              ['rj45', 'RJ45'],
              ['sfp', 'SFP'],
              ['sfp_plus', 'SFP+'],
              ['qsfp', 'QSFP'],
              ['other', 'Custom'],
            ].map(([key, title]) => (
              <option value={key} key={key}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <TaggedVlanField
          tags={port.taggedVlans}
          onChange={(tags) => update('taggedVlans', tags)}
        />
      </div>
      <Status error={error} />
    </div>
  );
}
