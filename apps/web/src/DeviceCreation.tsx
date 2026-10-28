import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  builtInDeviceTemplates,
  createTemplatedDeviceSchema,
  type Device,
  type DeviceTemplate,
  type Rack,
  type TemplatePortGroup,
} from '../../../packages/shared/src/index.js';
import { api, ApiError } from './api.js';
import { Field, SelectField, type FormControls } from './ConfigurePanels.js';
import './workflow.css';

export function WorkflowError({ error }: { error: unknown }) {
  if (!error) return null;
  const details =
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message)
      : error instanceof ApiError && error.fieldErrors
        ? Object.entries(error.fieldErrors).flatMap(([key, values]) =>
            values.map((value) => key + ': ' + value),
          )
        : [];
  return (
    <div className="error-message" role="alert">
      <p>
        {error instanceof z.ZodError
          ? 'Check the form values.'
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

export function DeviceTypeField({
  value,
  onChange,
}: {
  value: Device['type'];
  onChange: (type: Device['type']) => void;
}) {
  return (
    <SelectField
      label="Device type"
      value={value}
      onChange={(event) => onChange(event.target.value as Device['type'])}
    >
      {(
        [
          'router',
          'switch',
          'firewall',
          'ap',
          'server',
          'custom',
          'other',
        ] as const
      ).map((type) => (
        <option value={type} key={type}>
          {type === 'ap'
            ? 'Wireless access point'
            : type[0]!.toUpperCase() + type.slice(1)}
        </option>
      ))}
    </SelectField>
  );
}

export function PortGroupEditor({
  groups,
  onChange,
  disabled = false,
}: {
  groups: TemplatePortGroup[];
  onChange: (groups: TemplatePortGroup[]) => void;
  disabled?: boolean;
}) {
  function update(index: number, changes: Partial<TemplatePortGroup>) {
    onChange(
      groups.map((group, position) =>
        position === index ? { ...group, ...changes } : group,
      ),
    );
  }
  function move(index: number, offset: number) {
    const next = [...groups];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    onChange(next);
  }
  return (
    <section className="workflow-groups" aria-label="Port layout">
      <div className="configure-toolbar">
        <h3>Port layout</h3>
        <span>{groups.reduce((sum, group) => sum + group.count, 0)} ports</span>
      </div>
      <p className="section-description">
        Groups set connector order and front/rear placement. Port numbering
        continues across groups.
      </p>
      {groups.map((group, index) => (
        <fieldset key={index} disabled={disabled} className="workflow-group">
          <legend>Port group {index + 1}</legend>
          <div className="workflow-group-fields">
            <Field
              label={'Group ' + (index + 1) + ' port count'}
              type="number"
              min={0}
              max={512}
              step={1}
              required
              value={group.count}
              onChange={(event) =>
                update(index, { count: Number(event.target.value) })
              }
            />
            <SelectField
              label={'Group ' + (index + 1) + ' connector'}
              value={group.kind}
              onChange={(event) =>
                update(index, {
                  kind: event.target.value as TemplatePortGroup['kind'],
                })
              }
            >
              {(['rj45', 'sfp', 'sfp_plus', 'qsfp', 'other'] as const).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {kind === 'sfp_plus' ? 'SFP+' : kind.toUpperCase()}
                  </option>
                ),
              )}
            </SelectField>
            <Field
              label={'Group ' + (index + 1) + ' speed'}
              maxLength={64}
              value={group.speed}
              placeholder="e.g. 1G"
              onChange={(event) => update(index, { speed: event.target.value })}
            />
            <SelectField
              label={'Group ' + (index + 1) + ' mode'}
              value={group.mode}
              onChange={(event) =>
                update(index, {
                  mode: event.target.value as TemplatePortGroup['mode'],
                })
              }
            >
              {(
                ['other', 'access', 'trunk', 'routed', 'disabled'] as const
              ).map((mode) => (
                <option key={mode} value={mode}>
                  {mode === 'routed'
                    ? 'Routed / WAN'
                    : mode === 'other'
                      ? 'Unconfigured / other'
                      : mode[0]!.toUpperCase() + mode.slice(1)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={'Group ' + (index + 1) + ' face'}
              value={group.face}
              onChange={(event) =>
                update(index, {
                  face: event.target.value as TemplatePortGroup['face'],
                })
              }
            >
              <option value="front">Front</option>
              <option value="rear">Rear</option>
            </SelectField>
            <Field
              label={'Group ' + (index + 1) + ' name prefix'}
              maxLength={80}
              value={group.namePrefix}
              onChange={(event) =>
                update(index, { namePrefix: event.target.value })
              }
            />
          </div>
          <div className="workflow-actions">
            <button
              type="button"
              aria-label={'Move port group ' + (index + 1) + ' up'}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move up
            </button>
            <button
              type="button"
              aria-label={'Move port group ' + (index + 1) + ' down'}
              disabled={index === groups.length - 1}
              onClick={() => move(index, 1)}
            >
              Move down
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(groups.filter((_, position) => position !== index))
              }
            >
              Remove group {index + 1}
            </button>
          </div>
        </fieldset>
      ))}
      {!groups.length && (
        <p className="section-description">
          No ports. Add a group now or configure ports after creation.
        </p>
      )}
      <button
        type="button"
        disabled={disabled || groups.length >= 16}
        onClick={() =>
          onChange([
            ...groups,
            {
              count: 1,
              kind: 'rj45',
              speed: '',
              mode: 'other',
              face: 'front',
              namePrefix: 'Port ',
            },
          ])
        }
      >
        Add port group
      </button>
    </section>
  );
}

export function DeviceCreation({
  siteId,
  racks,
  controls,
  onDone,
  onCancel,
}: {
  siteId: string;
  racks: Rack[];
  controls: FormControls;
  onDone: (device: Device) => Promise<void>;
  onCancel: () => void;
}) {
  const [templates, setTemplates] = useState<DeviceTemplate[]>(
    builtInDeviceTemplates,
  );
  const [selected, setSelected] = useState<DeviceTemplate | null>(null);
  const [groups, setGroups] = useState<TemplatePortGroup[]>([]);
  const [draft, setDraft] = useState({
    displayName: '',
    type: 'custom' as Device['type'],
    rackId: '',
    hostname: '',
    manufacturer: '',
    model: '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<Device | null>(null);
  const { onDirtyChange } = controls;
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    let active = true;
    void api<{ templates: DeviceTemplate[] }>('/device-templates')
      .then((result) => {
        if (active) setTemplates(result.templates);
      })
      .catch((failure) => {
        if (active) setError(failure);
      });
    return () => {
      active = false;
    };
  }, []);
  function choose(template: DeviceTemplate) {
    setSelected(template);
    setGroups(template.groups.map((group) => ({ ...group })));
    setDraft({
      displayName: '',
      type: template.type,
      rackId: '',
      hostname: '',
      manufacturer: '',
      model: '',
    });
    setError(null);
    controls.onDirtyChange(true);
  }
  function update(changes: Partial<typeof draft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
    controls.onDirtyChange(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let payload;
    try {
      payload = createTemplatedDeviceSchema.parse({
        device: { ...draft, rackId: draft.rackId || null },
        groups,
      });
    } catch (failure) {
      setError(failure);
      return;
    }
    setPending(true);
    controls.onBusyChange(true);
    try {
      const device =
        created ??
        (
          await api<{ device: Device }>(
            '/sites/' + siteId + '/devices/from-template',
            'POST',
            payload,
          )
        ).device;
      setCreated(device);
      controls.onDirtyChange(false);
      await onDone(device);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  return (
    <section className="workflow-device-create" aria-label="Add device">
      <div className="configure-toolbar">
        <h2>
          {selected ? 'Add ' + selected.name.toLowerCase() : 'Add device'}
        </h2>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (controls.canLeave()) onCancel();
          }}
        >
          Cancel
        </button>
      </div>
      <WorkflowError error={error} />
      {!selected ? (
        <>
          <p className="section-description">
            Choose a starting point. Every port layout is editable.
          </p>
          <div className="workflow-template-picker">
            {templates.map((template) => (
              <button
                key={template.id}
                autoFocus={template.id === 'builtin:router'}
                type="button"
                className="workflow-template-choice"
                onClick={() => choose(template)}
              >
                <strong>{template.name}</strong>
                <span>
                  {template.groups.reduce((sum, group) => sum + group.count, 0)}{' '}
                  ports ·{' '}
                  {template.type === 'ap' ? 'Access point' : template.type}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset
            disabled={pending || Boolean(created)}
            className="workflow-form"
          >
            <div className="configure-form-fields">
              <Field
                label="Device name"
                required
                maxLength={120}
                autoFocus
                value={draft.displayName}
                onChange={(event) =>
                  update({ displayName: event.target.value })
                }
              />
              <DeviceTypeField
                value={draft.type}
                onChange={(type) => update({ type })}
              />
              <SelectField
                label="Rack (optional)"
                value={draft.rackId}
                onChange={(event) => update({ rackId: event.target.value })}
              >
                <option value="">No rack</option>
                {racks.map((rack) => (
                  <option key={rack.id} value={rack.id}>
                    {rack.name}
                  </option>
                ))}
              </SelectField>
              <Field
                label="Hostname (optional)"
                maxLength={253}
                value={draft.hostname}
                onChange={(event) => update({ hostname: event.target.value })}
              />
              <Field
                label="Manufacturer"
                maxLength={120}
                value={draft.manufacturer}
                onChange={(event) =>
                  update({ manufacturer: event.target.value })
                }
              />
              <Field
                label="Model"
                maxLength={120}
                value={draft.model}
                onChange={(event) => update({ model: event.target.value })}
              />
            </div>
            <PortGroupEditor
              groups={groups}
              onChange={(value) => {
                setGroups(value);
                controls.onDirtyChange(true);
              }}
              disabled={pending}
            />
            <button
              type="button"
              onClick={() => {
                if (controls.canLeave()) {
                  setSelected(null);
                  controls.onDirtyChange(false);
                }
              }}
            >
              Choose another template
            </button>
          </fieldset>
          <div className="workflow-actions">
            <button type="submit" className="primary" disabled={pending}>
              {pending
                ? 'Creating…'
                : created
                  ? 'Open created device'
                  : 'Create device'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
