import { useState, type FormEvent } from 'react';
import type { Workspace, Site } from '../../../packages/shared/src/index.js';

export type Editor =
  { kind: 'workspace'; value?: Workspace } | { kind: 'site'; value?: Site };
export type EntityValues = {
  name: string;
  description: string;
  notes?: string;
};

export function AuthForm({
  setup,
  onAuthenticate,
}: {
  setup: boolean;
  onAuthenticate: (username: string, password: string) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      await onAuthenticate(
        String(form.get('username')),
        String(form.get('password')),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="auth-panel">
      <p className="eyebrow">{setup ? 'FIRST-TIME SETUP' : 'WELCOME BACK'}</p>
      <h1>{setup ? 'Set up your local account.' : 'Sign in to PortFolio.'}</h1>
      <p className="intro">
        {setup
          ? 'Create the administrator account for this PortFolio server.'
          : 'Access your workspaces and network documentation.'}
      </p>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          maxLength={64}
          aria-describedby="username-help"
        />
        <p className="field-help" id="username-help">
          Letters, numbers, periods, underscores, and hyphens.
        </p>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={setup ? 'new-password' : 'current-password'}
          required
          minLength={setup ? 12 : 1}
          maxLength={256}
          aria-describedby={setup ? 'password-help' : undefined}
        />
        {setup && (
          <p className="field-help" id="password-help">
            Use at least 12 characters.
          </p>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={pending} type="submit">
          {pending
            ? 'Please wait…'
            : setup
              ? 'Create administrator account'
              : 'Sign in'}
          <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="privacy-note">
        Your account and documentation stay on this server.
      </p>
    </section>
  );
}

export function EntityForm({
  editor,
  onSave,
  onCancel,
}: {
  editor: Editor;
  onSave: (values: EntityValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const label = editor.kind === 'workspace' ? 'Workspace' : 'Site';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name')).trim();
    if (!name) {
      setError('Enter a name containing at least one non-space character.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await onSave({
        name,
        description: String(form.get('description')),
        ...(editor.kind === 'site' ? { notes: String(form.get('notes')) } : {}),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to save.');
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="editor" aria-labelledby="editor-title">
      <h2 id="editor-title">
        {editor.value ? 'Edit' : 'New'} {editor.kind}
      </h2>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="entity-name">{label} name</label>
        <input
          id="entity-name"
          name="name"
          required
          maxLength={120}
          defaultValue={editor.value?.name ?? ''}
          autoFocus
        />
        <label htmlFor="entity-description">
          Description <span className="optional">optional</span>
        </label>
        <textarea
          id="entity-description"
          name="description"
          maxLength={2000}
          rows={2}
          defaultValue={editor.value?.description ?? ''}
        />
        {editor.kind === 'site' && (
          <>
            <label htmlFor="entity-notes">
              Notes <span className="optional">optional</span>
            </label>
            <textarea
              id="entity-notes"
              name="notes"
              maxLength={10000}
              rows={3}
              defaultValue={editor.value?.notes ?? ''}
            />
          </>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={pending}>
            {pending
              ? 'Saving…'
              : editor.value
                ? 'Save changes'
                : `Create ${editor.kind}`}
          </button>
          <button
            type="button"
            className="subtle"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
