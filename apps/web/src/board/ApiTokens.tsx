import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import './api-tokens.css';
interface Token {
  id: string;
  name: string;
  access: 'read' | 'write';
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
const date = (value: number | null) =>
  value === null ? 'Never' : new Date(value).toLocaleString();
export function ApiTokens({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [expiry, setExpiry] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  useEffect(() => {
    let current = true;
    alive.current = true;
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLInputElement>('input')?.focus();
    void api<{ tokens: Token[] }>('/api-tokens')
      .then((result) => {
        if (current && alive.current) setTokens(result.tokens);
      })
      .catch((error) => {
        if (current && alive.current)
          setError(
            error instanceof Error ? error.message : 'Could not load tokens',
          );
      })
      .finally(() => {
        if (current && alive.current) setLoading(false);
      });
    return () => {
      current = false;
      alive.current = false;
      element.close();
    };
  }, []);
  function close() {
    alive.current = false;
    setSecret('');
    onClose();
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSecret('');
    try {
      const result = await api<{ token: Token; plaintextToken: string }>(
        '/api-tokens',
        'POST',
        {
          name,
          access,
          ...(expiry ? { expiresAt: new Date(expiry).getTime() } : {}),
        },
      );
      if (!alive.current) return;
      setSecret(result.plaintextToken);
      setTokens((current) => [result.token, ...current]);
      setName('');
      setExpiry('');
      setAccess('read');
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof Error ? error.message : 'Could not create token',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/api-tokens/${encodeURIComponent(id)}`, 'DELETE', {});
      if (!alive.current) return;
      setTokens((current) =>
        current.map((token) =>
          token.id === id ? { ...token, revokedAt: Date.now() } : token,
        ),
      );
      setConfirm(null);
      setSecret('');
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof Error ? error.message : 'Could not revoke token',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      className="api-tokens-dialog"
      ref={dialog}
      aria-labelledby="api-tokens-title"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
          ),
        ].filter((control) => control.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h2 id="api-tokens-title">API Tokens</h2>
          <p>Connect an assistant to your documentation.</p>
        </div>
        <button type="button" aria-label="Close API Tokens" onClick={close}>
          ×
        </button>
      </header>
      <p>
        Read-only tokens can view boards and preview proposals. Read and write
        tokens can also apply approved proposals and edits.
      </p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={(event) => void create(event)}>
        <label>
          Token name
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="api-tokens-fields">
          <label>
            Access
            <select
              aria-label="Access"
              value={access}
              onChange={(e) => setAccess(e.target.value as 'read' | 'write')}
            >
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </select>
          </label>
          <label>
            Expires at (optional)
            <input
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
        </div>
        <button disabled={busy || loading} type="submit">
          {busy ? 'Working…' : 'Create token'}
        </button>
      </form>
      {secret && (
        <section className="api-tokens-secret">
          <label>
            New API token
            <textarea
              aria-label="New API token"
              readOnly
              rows={3}
              value={secret}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p role="status">
            Save this token now. It is shown only once and disappears when you
            close this panel.
          </p>
        </section>
      )}
      <section aria-label="Your API tokens" aria-busy={loading}>
        <h3>Your tokens</h3>
        {loading ? (
          <p>Loading tokens…</p>
        ) : tokens.length === 0 ? (
          <p>No tokens yet.</p>
        ) : (
          <ul>
            {tokens.map((token) => (
              <li key={token.id}>
                <div className="api-tokens-row">
                  <strong>{token.name}</strong>
                  <span>
                    {token.revokedAt !== null
                      ? 'Revoked'
                      : token.expiresAt !== null && token.expiresAt <= openedAt
                        ? 'Expired'
                        : token.access === 'read'
                          ? 'Read only'
                          : 'Read and write'}
                  </span>
                </div>
                <p>
                  Access:{' '}
                  {token.access === 'read' ? 'Read only' : 'Read and write'}
                  <br />
                  Created: {date(token.createdAt)}
                  <br />
                  Last used: {date(token.lastUsedAt)}
                  <br />
                  Expires: {date(token.expiresAt)}
                  {token.revokedAt !== null && (
                    <>
                      <br />
                      Revoked: {date(token.revokedAt)}
                    </>
                  )}
                </p>
                {token.revokedAt === null &&
                  (confirm === token.id ? (
                    <div className="api-tokens-confirm">
                      <span>
                        Revoke this token? Connected assistants will lose
                        access.
                      </span>
                      <button
                        disabled={busy}
                        onClick={() => void revoke(token.id)}
                      >
                        Confirm revoke
                      </button>
                      <button disabled={busy} onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      disabled={busy}
                      aria-label={`Revoke ${token.name}`}
                      onClick={() => setConfirm(token.id)}
                    >
                      Revoke
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </dialog>
  );
}
