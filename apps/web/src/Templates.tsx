import { useEffect, useState, type FormEvent } from 'react';
import {
  createTemplateSchema,
  updateTemplateSchema,
  type Device,
  type DeviceTemplate,
  type TemplatePortGroup,
} from '../../../packages/shared/src/index.js';
import { api } from './api.js';
import { Field, type FormControls } from './ConfigurePanels.js';
import {
  DeviceTypeField,
  PortGroupEditor,
  WorkflowError,
} from './DeviceCreation.js';
import './workflow.css';

type TemplateDraft = {
  name: string;
  type: Device['type'];
  description: string;
  groups: TemplatePortGroup[];
};
const blank: TemplateDraft = {
  name: '',
  type: 'custom',
  description: '',
  groups: [],
};
export function Templates({
  controls,
  initiallyCreating = false,
  onChanged,
}: {
  siteId: string;
  controls: FormControls;
  initiallyCreating?: boolean;
  onChanged?: () => Promise<void> | void;
}) {
  const [templates, setTemplates] = useState<DeviceTemplate[] | null>(null);
  const [editing, setEditing] = useState<DeviceTemplate | null | undefined>(
    () => (initiallyCreating ? null : undefined),
  );
  const [draft, setDraft] = useState<TemplateDraft>(blank);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
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
  async function reload() {
    const result = await api<{ templates: DeviceTemplate[] }>(
      '/device-templates',
    );
    setTemplates(result.templates);
  }
  function open(record: DeviceTemplate | null, copy = false) {
    if (!controls.canLeave()) return;
    setEditing(copy ? null : record);
    setDraft(
      record
        ? {
            name: record.name + (copy ? ' copy' : ''),
            type: record.type,
            description: record.description,
            groups: record.groups.map((group) => ({ ...group })),
          }
        : { ...blank, groups: [] },
    );
    setError(null);
    setNotice('');
    controls.onDirtyChange(false);
  }
  function update(changes: Partial<TemplateDraft>) {
    setDraft((previous) => ({ ...previous, ...changes }));
    controls.onDirtyChange(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let payload;
    try {
      payload = editing
        ? updateTemplateSchema.parse({
            ...draft,
            rowVersion: editing.rowVersion,
          })
        : createTemplateSchema.parse(draft);
    } catch (failure) {
      setError(failure);
      return;
    }
    setPending(true);
    controls.onBusyChange(true);
    try {
      await api(
        '/device-templates' + (editing ? '/' + editing.id : ''),
        editing ? 'PATCH' : 'POST',
        payload,
      );
      controls.onDirtyChange(false);
      setEditing(undefined);
      setNotice('Template saved.');
      await reload();
      await onChanged?.();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  async function remove(record: DeviceTemplate) {
    if (
      !controls.canLeave() ||
      !window.confirm(
        'Delete template “' +
          record.name +
          '”? Existing devices are unaffected.',
      )
    )
      return;
    setPending(true);
    controls.onBusyChange(true);
    setError(null);
    try {
      await api('/device-templates/' + record.id, 'DELETE', {
        rowVersion: record.rowVersion,
      });
      setEditing(undefined);
      setDraft(blank);
      controls.onDirtyChange(false);
      setNotice('Template deleted.');
      await reload();
      await onChanged?.();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      controls.onBusyChange(false);
    }
  }
  const builtin =
    templates?.filter((template) => template.id.startsWith('builtin:')) ?? [];
  const saved =
    templates?.filter((template) => !template.id.startsWith('builtin:')) ?? [];
  return (
    <section aria-label="Device templates">
      <div className="configure-toolbar">
        <h2>Templates</h2>
        <button type="button" disabled={pending} onClick={() => open(null)}>
          Create template
        </button>
      </div>
      <p className="section-description">
        Reusable device and port layouts are available across your workspaces
        and sites.
      </p>
      <WorkflowError error={error} />
      {notice && <p role="status">{notice}</p>}
      {editing !== undefined && (
        <section
          className="workflow-inline-editor"
          aria-label={editing ? 'Edit template' : 'Create template'}
        >
          <h3>{editing ? 'Edit template' : 'Create template'}</h3>
          <form onSubmit={(event) => void save(event)}>
            <fieldset disabled={pending} className="workflow-form">
              <div className="configure-form-fields">
                <Field
                  label="Template name"
                  required
                  maxLength={120}
                  autoFocus
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
                <DeviceTypeField
                  value={draft.type}
                  onChange={(type) => update({ type })}
                />
              </div>
              <label className="workflow-notes">
                Template description
                <textarea
                  maxLength={2000}
                  value={draft.description}
                  onChange={(event) =>
                    update({ description: event.target.value })
                  }
                />
              </label>
              <PortGroupEditor
                groups={draft.groups}
                onChange={(groups) => update({ groups })}
                disabled={pending}
              />
              <div className="workflow-actions">
                <button type="submit" className="primary">
                  {pending ? 'Saving…' : 'Save template'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (controls.canLeave()) {
                      setEditing(undefined);
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
      {templates === null ? (
        <p role="status">Loading templates…</p>
      ) : (
        <>
          <h3>Built-in templates</h3>
          <ul className="configure-records">
            {builtin.map((template) => (
              <li key={template.id}>
                <div className="workflow-record-details">
                  <strong>{template.name}</strong>
                  <small>
                    {template.groups.reduce(
                      (sum, group) => sum + group.count,
                      0,
                    )}{' '}
                    ports
                  </small>
                </div>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={'Customize ' + template.name + ' template'}
                  onClick={() => open(template, true)}
                >
                  Customize a copy
                </button>
              </li>
            ))}
          </ul>
          <h3>Saved templates</h3>
          {!saved.length && (
            <p className="section-description">
              No saved templates yet. Create one or customize a built-in
              template.
            </p>
          )}
          <ul className="configure-records">
            {saved.map((template) => (
              <li key={template.id}>
                <div className="workflow-record-details">
                  <strong>{template.name}</strong>
                  <small>
                    {template.type} ·{' '}
                    {template.groups.reduce(
                      (sum, group) => sum + group.count,
                      0,
                    )}{' '}
                    ports
                  </small>
                  {template.description && <p>{template.description}</p>}
                </div>
                <div className="workflow-actions">
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={'Edit template ' + template.name}
                    onClick={() => open(template)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={'Copy template ' + template.name}
                    onClick={() => open(template, true)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={'Delete template ' + template.name}
                    onClick={() => void remove(template)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {Boolean(error) && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void reload()
              .then(() => setError(null))
              .catch(setError);
          }}
        >
          Refresh templates
        </button>
      )}
    </section>
  );
}
