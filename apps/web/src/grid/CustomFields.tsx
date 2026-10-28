import { useState, type FormEvent } from 'react';
import {
  createPortFieldSchema,
  type CustomValue,
  type PortField,
} from '../../../../packages/shared/src/index.js';
import { api } from '../api.js';

export function CustomInput({
  field,
  value,
  label,
  onChange,
  disabled = false,
  invalid = false,
  errorId,
}: {
  field: Pick<PortField, 'valueType' | 'choices'>;
  value: CustomValue;
  label: string;
  onChange: (value: CustomValue) => void;
  disabled?: boolean;
  invalid?: boolean;
  errorId?: string | undefined;
}) {
  if (field.valueType === 'boolean')
    return (
      <select
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        disabled={disabled}
        value={value === null ? '' : String(value)}
        onChange={(event) =>
          onChange(
            event.target.value === '' ? null : event.target.value === 'true',
          )
        }
      >
        <option value="">Unset</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  if (field.valueType === 'select')
    return (
      <select
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        disabled={disabled}
        value={value === null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Unset</option>
        {field.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={errorId}
      disabled={disabled}
      type={
        field.valueType === 'number'
          ? 'number'
          : field.valueType === 'date'
            ? 'date'
            : 'text'
      }
      step={field.valueType === 'number' ? 'any' : undefined}
      maxLength={2000}
      value={
        value === null
          ? ''
          : typeof value === 'number' && Number.isNaN(value)
            ? ''
            : String(value)
      }
      onChange={(event) =>
        onChange(
          event.target.value === ''
            ? null
            : field.valueType === 'number'
              ? Number(event.target.value)
              : event.target.value,
        )
      }
    />
  );
}

export function CustomFields({
  siteId,
  fields,
  disabled,
  onChange,
  onDirtyChange,
  onBusyChange,
}: {
  siteId: string;
  fields: PortField[];
  disabled: boolean;
  onChange: (fields: PortField[]) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState<PortField | 'new' | null>(null);
  const [type, setType] = useState<PortField['valueType']>('text');
  const [choices, setChoices] = useState('');
  const [defaultValue, setDefault] = useState<CustomValue>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  function setBusy(value: boolean) {
    setPending(value);
    onBusyChange(value);
  }
  function open(field: PortField | 'new') {
    setEditing(field);
    setType(field === 'new' ? 'text' : field.valueType);
    setChoices(field === 'new' ? '' : field.choices.join('\n'));
    setDefault(field === 'new' ? null : field.defaultValue);
    setError('');
    onDirtyChange(true);
  }
  function close() {
    setEditing(null);
    setError('');
    onDirtyChange(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = createPortFieldSchema.safeParse({
      key: editing === 'new' ? String(form.get('key')) : editing!.key,
      title: String(form.get('title')),
      valueType: type,
      choices:
        type === 'select'
          ? choices
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean)
          : [],
      defaultValue,
      visibleByDefault: form.get('visible') === 'on',
      columnOrder: editing === 'new' ? 100 : editing!.columnOrder,
    });
    if (!input.success) {
      setError(
        input.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join(' '),
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      const {
        title,
        valueType,
        choices,
        defaultValue,
        visibleByDefault,
        columnOrder,
      } = input.data;
      const changes = {
        title,
        valueType,
        choices,
        defaultValue,
        visibleByDefault,
        columnOrder,
      };
      const result = await api<{ field: PortField }>(
        `/sites/${siteId}/port-fields${editing === 'new' ? '' : `/${editing!.id}`}`,
        editing === 'new' ? 'POST' : 'PATCH',
        editing === 'new'
          ? input.data
          : { ...changes, rowVersion: editing!.rowVersion },
      );
      onChange(
        editing === 'new'
          ? [...fields, result.field]
          : fields.map((field) =>
              field.id === result.field.id ? result.field : field,
            ),
      );
      close();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not save field.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove(field: PortField) {
    if (
      !window.confirm(
        `Delete custom field “${field.title}” and all of its stored port values? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api(`/sites/${siteId}/port-fields/${field.id}`, 'DELETE', {
        rowVersion: field.rowVersion,
      });
      onChange(fields.filter((item) => item.id !== field.id));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not delete field.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="grid-tool">
      <summary>Custom columns</summary>
      <p className="grid-help">
        Typed columns are stored with the site. Core port fields cannot be
        replaced.
      </p>
      {fields.map((field) => (
        <div className="custom-field-row" key={field.id}>
          <span>
            {field.title} <small>({field.valueType})</small>
          </span>
          <button
            type="button"
            disabled={disabled || pending || Boolean(editing)}
            onClick={() => open(field)}
            aria-label={`Edit custom field ${field.title}`}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={disabled || pending || Boolean(editing)}
            onClick={() => void remove(field)}
            aria-label={`Delete custom field ${field.title}`}
          >
            Delete
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || pending || Boolean(editing)}
        onClick={() => open('new')}
      >
        Add custom column
      </button>
      {editing && (
        <form
          className="grid-tool-form"
          key={editing === 'new' ? 'new' : editing.id}
          onSubmit={(event) => void submit(event)}
        >
          <h3>
            {editing === 'new' ? 'New custom column' : `Edit ${editing.title}`}
          </h3>
          {editing === 'new' && (
            <label>
              Field key
              <input
                name="key"
                required
                pattern="[a-z][a-z0-9_]*"
                maxLength={64}
              />
            </label>
          )}
          <label>
            Column title
            <input
              name="title"
              required
              maxLength={120}
              defaultValue={editing === 'new' ? '' : editing.title}
            />
          </label>
          <label>
            Value type
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value as PortField['valueType']);
                setDefault(null);
              }}
            >
              {['text', 'number', 'boolean', 'select', 'date'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {type === 'select' && (
            <label>
              Choices (one per line)
              <textarea
                value={choices}
                onChange={(event) => setChoices(event.target.value)}
                rows={3}
              />
            </label>
          )}
          <label>
            Default value
            <CustomInput
              field={{
                valueType: type,
                choices: choices
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean),
              }}
              value={defaultValue}
              label="Default value"
              onChange={setDefault}
            />
          </label>
          <label className="grid-check">
            <input
              name="visible"
              type="checkbox"
              defaultChecked={editing === 'new' || editing.visibleByDefault}
            />
            Visible by default
          </label>
          <div className="grid-actions">
            <button type="submit" disabled={pending}>
              Save custom column
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (window.confirm('Discard custom column edits?')) close();
              }}
            >
              Cancel custom column
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
