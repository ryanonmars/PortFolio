import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { z } from 'zod';
import {
  createDeviceSchema,
  updateDeviceSchema,
  createVlanSchema,
  updateVlanSchema,
  createRackSchema,
  updateRackSchema,
  createSubnetSchema,
  updateSubnetSchema,
  createDhcpScopeSchema,
  updateDhcpScopeSchema,
  type Device,
  type Vlan,
  type Rack,
  type Subnet,
  type DhcpScope,
  type Port,
} from '../../../packages/shared/src/index.js';
import { api, ApiError } from './api.js';
import './workflow.css';

export type FormControls = {
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  canLeave: () => boolean;
};
export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <label className="configure-field" htmlFor={id}>
      <span>{label}</span>
      <input {...props} id={id} />
    </label>
  );
}
export function SelectField({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return (
    <label className="configure-field" htmlFor={id}>
      <span>{label}</span>
      <select {...props} id={id}>
        {children}
      </select>
    </label>
  );
}
type Draft = Record<string, string | boolean>;
type SetValue = (key: string, value: string | boolean) => void;
type RenderFields = (draft: Draft, set: SetValue) => ReactNode;
const text = (draft: Draft, key: string) => String(draft[key] ?? '');
const list = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const details =
    error instanceof z.ZodError
      ? error.issues.map(
          (issue) => `${issue.path.join('.') || 'Form'}: ${issue.message}`,
        )
      : error instanceof ApiError && error.fieldErrors
        ? Object.entries(error.fieldErrors).flatMap(([key, values]) =>
            values.map((value) => `${key}: ${value}`),
          )
        : [];
  return (
    <div className="error-message" role="alert">
      <p>
        {error instanceof z.ZodError
          ? 'Check these form values.'
          : error instanceof Error
            ? error.message
            : 'The request could not be completed.'}
      </p>
      {details.length > 0 && (
        <ul>
          {details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({
  title,
  initial,
  fields,
  build,
  schema,
  save,
  cancel,
  reload,
  controls,
  submitLabel,
}: {
  title: string;
  initial: Draft;
  fields: RenderFields;
  build: (draft: Draft) => unknown;
  schema: z.ZodType;
  save: (payload: unknown) => Promise<void>;
  cancel: () => void;
  reload: () => Promise<void>;
  controls: FormControls;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const { onDirtyChange } = controls;
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const set: SetValue = (key, value) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    controls.onDirtyChange(true);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    controls.onDirtyChange(true);
    let payload: unknown;
    try {
      payload = schema.parse(build(draft));
    } catch (failure) {
      setError(failure);
      return;
    }
    setPending(true);
    controls.onBusyChange(true);
    try {
      await save(payload);
      controls.onDirtyChange(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  async function reloadDraft() {
    if (!controls.canLeave()) return;
    setPending(true);
    controls.onBusyChange(true);
    try {
      await reload();
      cancel();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  return (
    <section className="configure-editor">
      <h3>{title}</h3>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending} className="configure-form-fields">
          {fields(draft, set)}
          <ErrorNotice error={error} />
          <div className="configure-toolbar">
            <button className="primary" type="submit">
              {pending ? 'Saving…' : submitLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                if (controls.canLeave()) cancel();
              }}
            >
              Cancel
            </button>
            {error instanceof ApiError && error.status === 409 && (
              <button type="button" onClick={() => void reloadDraft()}>
                Reload and discard form
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}
function TextArea({
  label,
  value,
  onChange,
  maxLength = 10000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <label className="configure-field" htmlFor={id}>
      <span>{label}</span>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        rows={3}
      />
    </label>
  );
}
function input(
  draft: Draft,
  set: SetValue,
  key: string,
  label: string,
  options: InputHTMLAttributes<HTMLInputElement> = {},
) {
  return (
    <Field
      label={label}
      name={key}
      {...options}
      value={text(draft, key)}
      onChange={(event) => set(key, event.target.value)}
    />
  );
}

export function DeviceEditor({
  siteId,
  device,
  racks,
  onDone,
  onCancel,
  controls,
}: {
  siteId: string;
  device: Device | null;
  racks: Rack[];
  onDone: (device: Device) => Promise<void>;
  onCancel: () => void;
  controls: FormControls;
}) {
  const initial: Draft = {
    displayName: device?.displayName ?? '',
    type: device?.type ?? 'switch',
    rackId: device?.rackId ?? '',
    hostname: device?.hostname ?? '',
    manufacturer: device?.manufacturer ?? '',
    model: device?.model ?? '',
    serial: device?.serial ?? '',
    managementIp: device?.managementIp ?? '',
    mac: device?.mac ?? '',
    description: device?.description ?? '',
    tags: device?.tags.join(', ') ?? '',
    orderIndex: device ? String(device.orderIndex) : '',
  };
  const fields: RenderFields = (draft, set) => (
    <>
      {input(draft, set, 'displayName', 'Device name', {
        required: true,
        maxLength: 120,
        autoFocus: true,
      })}
      <SelectField
        label="Device type"
        name="type"
        value={text(draft, 'type')}
        onChange={(event) => set('type', event.target.value)}
      >
        {[
          'router',
          'switch',
          'firewall',
          'ap',
          'server',
          'custom',
          'other',
        ].map((type) => (
          <option key={type} value={type}>
            {type === 'ap'
              ? 'Access point'
              : type[0]!.toUpperCase() + type.slice(1)}
          </option>
        ))}
      </SelectField>
      {input(draft, set, 'manufacturer', 'Manufacturer', { maxLength: 120 })}
      {input(draft, set, 'model', 'Model', { maxLength: 120 })}
      <SelectField
        label="Rack (optional)"
        name="rackId"
        value={text(draft, 'rackId')}
        onChange={(event) => set('rackId', event.target.value)}
      >
        <option value="">No rack</option>
        {racks.map((rack) => (
          <option key={rack.id} value={rack.id}>
            {rack.name}
          </option>
        ))}
      </SelectField>
      {input(draft, set, 'hostname', 'Hostname (optional)', { maxLength: 253 })}
      {input(draft, set, 'serial', 'Serial (optional)', { maxLength: 120 })}
      {input(draft, set, 'managementIp', 'Management IP (optional)')}
      {input(draft, set, 'mac', 'MAC address (optional)', { maxLength: 32 })}
      {input(draft, set, 'tags', 'Metadata tags (comma separated)')}
      {input(draft, set, 'orderIndex', 'Equipment order (optional)', {
        type: 'number',
        min: 0,
        max: 65535,
        step: 1,
      })}
      <TextArea
        label="Description"
        value={text(draft, 'description')}
        maxLength={2000}
        onChange={(value) => set('description', value)}
      />
    </>
  );
  return (
    <Editor
      title={device ? 'Edit device' : 'Add device'}
      initial={initial}
      fields={fields}
      schema={device ? updateDeviceSchema : createDeviceSchema}
      submitLabel={device ? 'Save device' : 'Create device'}
      controls={controls}
      cancel={onCancel}
      reload={async () => {
        if (device) await api(`/sites/${siteId}/devices/${device.id}`);
      }}
      build={(draft) => ({
        ...draft,
        tags: list(text(draft, 'tags')),
        rackId: text(draft, 'rackId') || null,
        ...(text(draft, 'orderIndex')
          ? { orderIndex: Number(draft.orderIndex) }
          : { orderIndex: undefined }),
        ...(device ? { rowVersion: device.rowVersion } : {}),
      })}
      save={async (payload) => {
        const response = await api<{ device: Device }>(
          `/sites/${siteId}/devices${device ? '/' + device.id : ''}`,
          device ? 'PATCH' : 'POST',
          payload,
        );
        await onDone(response.device);
      }}
    />
  );
}

type RecordBase = { id: string; rowVersion: number };
const noDevices: Device[] = [];
const noSubnets: Subnet[] = [];
function ResourcePanel<T extends RecordBase>({
  title,
  addLabel,
  singular,
  records,
  path,
  initial,
  fields,
  build,
  createSchema,
  updateSchema,
  label,
  controls,
  onChanged,
  actions,
  active = true,
  activate,
  initiallyCreating = false,
  columns,
  focusId,
  details,
}: {
  title: string;
  addLabel?: string;
  singular: string;
  records: T[];
  path: string;
  initial: (record: T | null) => Draft;
  fields: RenderFields;
  build: (draft: Draft) => unknown;
  createSchema: z.ZodType;
  updateSchema: z.ZodType;
  label: (record: T) => ReactNode;
  controls: FormControls;
  onChanged: () => Promise<void>;
  actions?: (record: T) => ReactNode;
  active?: boolean;
  activate?: () => void;
  initiallyCreating?: boolean;
  columns?: { key: string; title: string; render: (record: T) => ReactNode }[];
  focusId?: string;
  details?: (record: T) => ReactNode;
}) {
  const [editing, setEditing] = useState<T | null | undefined>(() =>
    initiallyCreating ? null : undefined,
  );
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  function open(record: T | null) {
    if (!controls.canLeave()) return;
    activate?.();
    setGeneration((value) => value + 1);
    setEditing(record);
    setError(null);
  }
  async function remove(record: T) {
    if (
      !controls.canLeave() ||
      !window.confirm(
        `Delete this ${singular}? Referenced records may prevent deletion. This cannot be undone.`,
      )
    )
      return;
    activate?.();
    setEditing(undefined);
    setPending(true);
    controls.onBusyChange(true);
    setError(null);
    try {
      await api(`${path}/${record.id}`, 'DELETE', {
        rowVersion: record.rowVersion,
      });
      setEditing(undefined);
      await onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  function recordActions(record: T) {
    return (
      <div className="configure-toolbar">
        {actions?.(record)}
        <button type="button" disabled={pending} onClick={() => open(record)}>
          Edit {singular}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void remove(record)}
        >
          Delete {singular}
        </button>
      </div>
    );
  }
  const visibleRecords = focusId
    ? records.filter((record) => record.id === focusId)
    : records;
  if (focusId && !visibleRecords.length)
    return (
      <p role="alert" className="error-message">
        The selected {singular} is unavailable in this site.
      </p>
    );
  return (
    <section>
      <div className="configure-toolbar">
        <h3>{title}</h3>
        {addLabel && (
          <button type="button" disabled={pending} onClick={() => open(null)}>
            {addLabel}
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      {focusId && visibleRecords[0] && details?.(visibleRecords[0])}
      {error instanceof ApiError && error.status === 409 && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (controls.canLeave()) void onChanged().catch(setError);
          }}
        >
          Reload records
        </button>
      )}
      {columns ? (
        <div
          className="workflow-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={title + ' table'}
        >
          <table className="workflow-table" aria-label={title}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} scope="col">
                    {column.title}
                  </th>
                ))}
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((record) => (
                <tr key={record.id}>
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(record)}</td>
                  ))}
                  <td>{recordActions(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="configure-records">
          {visibleRecords.map((record) => (
            <li key={record.id}>
              <span>{label(record)}</span>
              {recordActions(record)}
            </li>
          ))}
        </ul>
      )}
      {visibleRecords.length === 0 && (
        <p>No {title.toLowerCase()} configured yet.</p>
      )}
      {active &&
        editing !== undefined &&
        (!focusId || editing === null || editing.id === focusId) && (
          <Editor
            key={`${editing?.id ?? 'new'}:${generation}`}
            title={`${editing ? 'Edit' : 'Add'} ${singular}`}
            initial={initial(editing)}
            fields={fields}
            build={(draft) => ({
              ...(build(draft) as object),
              ...(editing ? { rowVersion: editing.rowVersion } : {}),
            })}
            schema={editing ? updateSchema : createSchema}
            controls={controls}
            submitLabel={`${editing ? 'Save' : 'Create'} ${singular}`}
            cancel={() => setEditing(undefined)}
            reload={onChanged}
            save={async (payload) => {
              await api(
                `${path}${editing ? '/' + editing.id : ''}`,
                editing ? 'PATCH' : 'POST',
                payload,
              );
              await onChanged();
              setEditing(undefined);
            }}
          />
        )}
    </section>
  );
}

export function VlanSettings({
  siteId,
  vlans,
  controls,
  onChanged,
  initiallyCreating = false,
  devices = noDevices,
  subnets = noSubnets,
  focusId,
}: {
  siteId: string;
  vlans: Vlan[];
  controls: FormControls;
  onChanged: () => Promise<void>;
  initiallyCreating?: boolean;
  devices?: Device[];
  subnets?: Subnet[];
  focusId?: string;
}) {
  const [membership, setMembership] = useState<{
    key: string;
    ports: Port[];
    error: string | null;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const membershipKey =
    siteId +
    JSON.stringify([
      devices.map((device) => [device.id, device.rowVersion]),
      vlans.map((vlan) => [vlan.id, vlan.rowVersion]),
      retry,
    ]);
  useEffect(() => {
    let active = true;
    void Promise.all(
      devices.map((device) =>
        api<{ ports: Port[] }>(
          '/sites/' + siteId + '/devices/' + device.id + '/ports',
        ),
      ),
    )
      .then((results) => {
        if (active)
          setMembership({
            key: membershipKey,
            ports: results.flatMap((result) => result.ports),
            error: null,
          });
      })
      .catch((error: unknown) => {
        if (active)
          setMembership({
            key: membershipKey,
            ports: [],
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load port memberships.',
          });
      });
    return () => {
      active = false;
    };
  }, [siteId, devices, membershipKey]);
  const loadingMemberships = membership?.key !== membershipKey;
  const membershipError = loadingMemberships ? null : membership?.error;
  function members(vlan: Vlan, kind: 'native' | 'tagged') {
    if (loadingMemberships) return <span className="muted">Loading…</span>;
    if (membershipError) return <span className="muted">Unavailable</span>;
    const matching =
      membership?.ports.filter((port) =>
        kind === 'native'
          ? port.nativeVlanRef === vlan.id
          : port.taggedVlanRefs.includes(vlan.id),
      ) ?? [];
    if (!matching.length) return <span>0 ports</span>;
    return (
      <details className="workflow-memberships">
        <summary>
          {matching.length} {matching.length === 1 ? 'port' : 'ports'}
        </summary>
        <ul>
          {matching.map((port) => (
            <li key={port.id}>
              {devices.find((device) => device.id === port.deviceId)
                ?.displayName ?? 'Device'}{' '}
              · {port.name}
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <>
      {loadingMemberships && <p role="status">Loading VLAN memberships…</p>}
      {membershipError && (
        <div role="alert" className="error-message">
          <p>{membershipError}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry memberships
          </button>
        </div>
      )}
      <ResourcePanel
        title="VLANs"
        initiallyCreating={initiallyCreating}
        singular="VLAN"
        records={vlans}
        focusId={focusId}
        details={(vlan) => (
          <section className="record-detail" aria-label="VLAN details">
            <h2>
              VLAN {vlan.vlanId}
              {vlan.name ? ' — ' + vlan.name : ''}
            </h2>
            <dl className="record-facts">
              <div>
                <dt>ID</dt>
                <dd>{vlan.vlanId}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{vlan.name || 'Unnamed'}</dd>
              </div>
              <div>
                <dt>Color</dt>
                <dd>{vlan.color || 'Automatic'}</dd>
              </div>
            </dl>
            {vlan.description && (
              <p className="record-description">{vlan.description}</p>
            )}
            <h3>Related subnets</h3>
            {subnets.some((subnet) => subnet.vlanRef === vlan.id) ? (
              <ul>
                {subnets
                  .filter((subnet) => subnet.vlanRef === vlan.id)
                  .map((subnet) => (
                    <li key={subnet.id}>
                      {subnet.cidr}
                      {subnet.name ? ' · ' + subnet.name : ''}
                      {subnet.gatewayIp ? ' · Gateway ' + subnet.gatewayIp : ''}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No related subnets.</p>
            )}
            <h3>Port memberships</h3>
          </section>
        )}
        path={`/sites/${siteId}/vlans`}
        controls={controls}
        onChanged={onChanged}
        columns={[
          { key: 'id', title: 'VLAN ID', render: (vlan) => vlan.vlanId },
          { key: 'name', title: 'Name', render: (vlan) => vlan.name || '—' },
          {
            key: 'color',
            title: 'Color',
            render: (vlan) => (
              <span className="workflow-vlan-color">
                {vlan.color && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    aria-hidden="true"
                  >
                    <rect width="14" height="14" rx="3" fill={vlan.color} />
                  </svg>
                )}
                <code>{vlan.color ?? 'Automatic'}</code>
              </span>
            ),
          },
          {
            key: 'native',
            title: 'Native / untagged',
            render: (vlan) => members(vlan, 'native'),
          },
          {
            key: 'tagged',
            title: 'Tagged',
            render: (vlan) => members(vlan, 'tagged'),
          },
        ]}
        createSchema={createVlanSchema}
        updateSchema={updateVlanSchema}
        label={(vlan) =>
          `VLAN ${vlan.vlanId}${vlan.name ? ' · ' + vlan.name : ''}`
        }
        initial={(vlan) => ({
          vlanId: vlan ? String(vlan.vlanId) : '',
          name: vlan?.name ?? '',
          color: vlan?.color ?? '#428deb',
          useColor: Boolean(vlan?.color),
          description: vlan?.description ?? '',
        })}
        build={(draft) => ({
          vlanId: Number(draft.vlanId),
          name: text(draft, 'name'),
          color: draft.useColor ? text(draft, 'color') : null,
          description: text(draft, 'description'),
        })}
        fields={(draft, set) => (
          <>
            {input(draft, set, 'vlanId', 'VLAN ID', {
              required: true,
              type: 'number',
              min: 1,
              max: 4094,
              step: 1,
              autoFocus: true,
            })}
            {input(draft, set, 'name', 'VLAN name (optional)', {
              maxLength: 120,
            })}
            <Field
              label="Use a VLAN color"
              name="useColor"
              type="checkbox"
              checked={Boolean(draft.useColor)}
              onChange={(event) => set('useColor', event.target.checked)}
            />
            {draft.useColor &&
              input(draft, set, 'color', 'VLAN color', { type: 'color' })}
            <TextArea
              label="Description"
              value={text(draft, 'description')}
              maxLength={2000}
              onChange={(value) => set('description', value)}
            />
          </>
        )}
      />
    </>
  );
}

export function RackSettings({
  siteId,
  racks,
  controls,
  onChanged,
  initiallyCreating = false,
  devices = noDevices,
  focusId,
}: {
  siteId: string;
  racks: Rack[];
  controls: FormControls;
  onChanged: () => Promise<void>;
  initiallyCreating?: boolean;
  devices?: Device[];
  focusId?: string;
}) {
  return (
    <ResourcePanel
      title="Racks"
      initiallyCreating={initiallyCreating}
      singular="rack"
      records={racks}
      focusId={focusId}
      details={(rack) => (
        <section className="record-detail" aria-label="Rack details">
          <h2>{rack.name}</h2>
          {rack.description && (
            <p className="record-description">{rack.description}</p>
          )}
          <p>Equipment order: {rack.orderIndex}</p>
          <h3>Contained equipment</h3>
          {devices.some((device) => device.rackId === rack.id) ? (
            <ul>
              {devices
                .filter((device) => device.rackId === rack.id)
                .sort((a, b) => a.orderIndex - b.orderIndex)
                .map((device) => (
                  <li key={device.id}>
                    {device.displayName}
                    {device.model ? ' · ' + device.model : ''}
                  </li>
                ))}
            </ul>
          ) : (
            <p>No equipment assigned to this rack.</p>
          )}
        </section>
      )}
      path={`/sites/${siteId}/racks`}
      controls={controls}
      onChanged={onChanged}
      createSchema={createRackSchema}
      updateSchema={updateRackSchema}
      label={(rack) => rack.name}
      initial={(rack) => ({
        name: rack?.name ?? '',
        description: rack?.description ?? '',
        orderIndex: rack ? String(rack.orderIndex) : '',
      })}
      build={(draft) => ({
        name: text(draft, 'name'),
        description: text(draft, 'description'),
        ...(text(draft, 'orderIndex')
          ? { orderIndex: Number(draft.orderIndex) }
          : {}),
      })}
      fields={(draft, set) => (
        <>
          {input(draft, set, 'name', 'Rack name', {
            required: true,
            maxLength: 120,
            autoFocus: true,
          })}
          {input(draft, set, 'orderIndex', 'Rack order (optional)', {
            type: 'number',
            min: 0,
            max: 65535,
            step: 1,
          })}
          <TextArea
            label="Description"
            value={text(draft, 'description')}
            maxLength={2000}
            onChange={(value) => set('description', value)}
          />
        </>
      )}
    />
  );
}

export function NetworkSettings({
  siteId,
  subnets,
  vlans,
  controls,
  onChanged,
  initiallyCreating = false,
  focusId,
}: {
  siteId: string;
  subnets: Subnet[];
  vlans: Vlan[];
  controls: FormControls;
  onChanged: () => Promise<void>;
  initiallyCreating?: boolean;
  focusId?: string;
}) {
  const [selected, setSelected] = useState<Subnet | null>(
    () => subnets.find((subnet) => subnet.id === focusId) ?? null,
  );
  const [scopes, setScopes] = useState<DhcpScope[]>([]);
  const [owner, setOwner] = useState<'subnet' | 'scope'>(
    focusId ? 'scope' : 'subnet',
  );
  const [scopeGeneration, setScopeGeneration] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [loadedFocus, setLoadedFocus] = useState('');
  useEffect(() => {
    if (!focusId) return;
    const focused = subnets.find((subnet) => subnet.id === focusId);
    if (!focused) return;
    let active = true;
    void api<{ dhcpScopes: DhcpScope[] }>(
      '/sites/' + siteId + '/subnets/' + focusId + '/dhcp-scopes',
    )
      .then((result) => {
        if (active) {
          setSelected(focused);
          setScopes(result.dhcpScopes);
          setLoadedFocus(focusId);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(failure);
          setLoadedFocus(focusId);
        }
      });
    return () => {
      active = false;
    };
  }, [siteId, focusId, subnets]);
  async function loadScopes(subnet: Subnet) {
    if (!controls.canLeave()) return;
    // Finish the approved discard before awaiting a read, so an old form cannot
    // accept additional edits while its replacement is loading.
    setOwner('scope');
    setScopeGeneration((value) => value + 1);
    setLoading(true);
    controls.onBusyChange(true);
    setError(null);
    try {
      const response = await api<{ dhcpScopes: DhcpScope[] }>(
        `/sites/${siteId}/subnets/${subnet.id}/dhcp-scopes`,
      );
      setScopes(response.dhcpScopes);
      setSelected(subnet);
      setOwner('scope');
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
      controls.onBusyChange(false);
    }
  }
  async function refreshScopes() {
    if (!selected) return;
    const response = await api<{ dhcpScopes: DhcpScope[] }>(
      `/sites/${siteId}/subnets/${selected.id}/dhcp-scopes`,
    );
    setScopes(response.dhcpScopes);
    await onChanged();
  }
  return (
    <>
      <ResourcePanel
        title="Subnets"
        initiallyCreating={initiallyCreating}
        singular="subnet"
        records={subnets}
        focusId={focusId}
        details={(subnet) => (
          <section className="record-detail" aria-label="Subnet details">
            <h2>
              {subnet.cidr}
              {subnet.name ? ' — ' + subnet.name : ''}
            </h2>
            <dl className="record-facts">
              <div>
                <dt>Gateway</dt>
                <dd>{subnet.gatewayIp || 'Not set'}</dd>
              </div>
              <div>
                <dt>DNS servers</dt>
                <dd>
                  {subnet.dnsServers.length
                    ? subnet.dnsServers.join(', ')
                    : 'Not set'}
                </dd>
              </div>
              <div>
                <dt>VLAN</dt>
                <dd>
                  {subnet.vlanRef
                    ? (() => {
                        const vlan = vlans.find(
                          (item) => item.id === subnet.vlanRef,
                        );
                        return vlan
                          ? 'VLAN ' +
                              vlan.vlanId +
                              (vlan.name ? ' · ' + vlan.name : '')
                          : 'Unavailable VLAN';
                      })()
                    : 'None'}
                </dd>
              </div>
            </dl>
            {subnet.notes && (
              <p className="record-description">{subnet.notes}</p>
            )}
          </section>
        )}
        path={`/sites/${siteId}/subnets`}
        controls={controls}
        onChanged={onChanged}
        active={owner === 'subnet'}
        activate={() => setOwner('subnet')}
        createSchema={createSubnetSchema}
        updateSchema={updateSubnetSchema}
        label={(subnet) =>
          `${subnet.cidr}${subnet.name ? ' · ' + subnet.name : ''}`
        }
        actions={(subnet) => (
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadScopes(subnet)}
          >
            DHCP scopes
          </button>
        )}
        initial={(subnet) => ({
          cidr: subnet?.cidr ?? '',
          name: subnet?.name ?? '',
          vlanRef: subnet?.vlanRef ?? '',
          gatewayIp: subnet?.gatewayIp ?? '',
          dnsServers: subnet?.dnsServers.join(', ') ?? '',
          notes: subnet?.notes ?? '',
        })}
        build={(draft) => ({
          cidr: text(draft, 'cidr').trim(),
          name: text(draft, 'name'),
          vlanRef: text(draft, 'vlanRef') || null,
          gatewayIp: text(draft, 'gatewayIp').trim() || null,
          dnsServers: list(text(draft, 'dnsServers')),
          notes: text(draft, 'notes'),
        })}
        fields={(draft, set) => (
          <>
            {input(draft, set, 'cidr', 'IPv4 network CIDR', {
              required: true,
              placeholder: '192.0.2.0/24',
              autoFocus: true,
            })}
            {input(draft, set, 'name', 'Subnet name (optional)', {
              maxLength: 120,
            })}
            <SelectField
              label="VLAN (optional)"
              name="vlanRef"
              value={text(draft, 'vlanRef')}
              onChange={(event) => set('vlanRef', event.target.value)}
            >
              <option value="">No VLAN</option>
              {vlans.map((vlan) => (
                <option key={vlan.id} value={vlan.id}>
                  {vlan.vlanId} {vlan.name}
                </option>
              ))}
            </SelectField>
            {input(draft, set, 'gatewayIp', 'Gateway IP (optional)')}
            {input(
              draft,
              set,
              'dnsServers',
              'DNS servers (comma separated, optional)',
            )}
            <TextArea
              label="Subnet notes"
              value={text(draft, 'notes')}
              onChange={(value) => set('notes', value)}
            />
          </>
        )}
      />
      <ErrorNotice error={error} />
      {(loading ||
        (focusId &&
          loadedFocus !== focusId &&
          subnets.some((subnet) => subnet.id === focusId))) && (
        <p role="status">Loading DHCP scopes…</p>
      )}
      {selected &&
        !error &&
        (!focusId || (selected.id === focusId && loadedFocus === focusId)) &&
        subnets.some((subnet) => subnet.id === selected.id) && (
          <section>
            <h3>
              DHCP ·{' '}
              {subnets.find((subnet) => subnet.id === selected.id)?.cidr ??
                selected.cidr}
            </h3>
            <ResourcePanel
              key={`${selected.id}:${scopeGeneration}`}
              title="DHCP scopes"
              addLabel="Add DHCP scope"
              singular="DHCP scope"
              records={scopes}
              path={`/sites/${siteId}/subnets/${selected.id}/dhcp-scopes`}
              controls={controls}
              onChanged={refreshScopes}
              active={owner === 'scope'}
              activate={() => setOwner('scope')}
              createSchema={createDhcpScopeSchema}
              updateSchema={updateDhcpScopeSchema}
              label={(scope) =>
                `${scope.name ? scope.name + ' · ' : ''}${scope.startIp} – ${scope.endIp} · ${scope.enabled ? 'Enabled' : 'Disabled'}`
              }
              initial={(scope) => ({
                name: scope?.name ?? '',
                startIp: scope?.startIp ?? '',
                endIp: scope?.endIp ?? '',
                enabled: scope?.enabled ?? true,
                notes: scope?.notes ?? '',
              })}
              build={(draft) => ({
                name: text(draft, 'name'),
                startIp: text(draft, 'startIp').trim(),
                endIp: text(draft, 'endIp').trim(),
                enabled: Boolean(draft.enabled),
                notes: text(draft, 'notes'),
              })}
              fields={(draft, set) => (
                <>
                  {input(draft, set, 'name', 'Scope name (optional)', {
                    maxLength: 120,
                  })}
                  {input(draft, set, 'startIp', 'Start IP', { required: true })}
                  {input(draft, set, 'endIp', 'End IP', { required: true })}
                  <Field
                    label="Scope enabled"
                    name="enabled"
                    type="checkbox"
                    checked={Boolean(draft.enabled)}
                    onChange={(event) => set('enabled', event.target.checked)}
                  />
                  <TextArea
                    label="Scope notes"
                    value={text(draft, 'notes')}
                    onChange={(value) => set('notes', value)}
                  />
                </>
              )}
            />
          </section>
        )}
    </>
  );
}
