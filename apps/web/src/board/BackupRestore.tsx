import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, uploadAttachment } from '../api.js';
import type { SettingsMetadata } from './SettingsPage.js';

interface RestorePreview {
  id: string;
  createdAt: string;
  applicationVersion: string;
  databaseSchemaVersion: string;
  boardCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  compatibility: 'compatible';
  expiresAt: number;
}
interface BackupDownload {
  id: string;
  filename: string;
  downloadUrl: string;
}
export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
};
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;
export function BackupRestore({
  metadata,
  onBusyChange,
  onRefresh,
}: {
  metadata: SettingsMetadata;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => void;
}) {
  const [phase, setPhase] = useState<
    'idle' | 'creating' | 'uploading' | 'verifying' | 'restoring' | 'cancelling'
  >('idle');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const staged = useRef<string | null>(null);
  const restored = useRef(false);
  const busy = phase !== 'idle';
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      if (staged.current)
        void api(
          `/backups/restore/${encodeURIComponent(staged.current)}`,
          'DELETE',
          {},
        ).catch(() => {});
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preview]);
  useEffect(() => {
    if (!busy) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (restored.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy]);
  async function create() {
    setPhase('creating');
    setError('');
    setStatus('Preparing a complete backup…');
    try {
      const result = await api<{ backup: BackupDownload }>(
        '/backups',
        'POST',
        {},
      );
      if (!alive.current) return;
      setStatus(
        'Backup prepared and download requested. Keep the ZIP file private. If the download did not finish, download a new backup.',
      );
      const anchor = document.createElement('a');
      anchor.href = result.backup.downloadUrl;
      anchor.download = result.backup.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      if (alive.current) {
        setError(message(cause, 'Could not create backup'));
        setStatus('');
      }
    } finally {
      if (alive.current) setPhase('idle');
    }
  }
  async function upload(file: File) {
    setError('');
    setStatus('');
    setConfirmation('');
    if (file.size > metadata.backup.maxUploadBytes) {
      setError(
        `Choose a ZIP file no larger than ${formatBytes(metadata.backup.maxUploadBytes)}.`,
      );
      return;
    }
    if (file.size === 0) {
      setError(
        'The selected backup is empty. Choose a complete PortFolio ZIP backup.',
      );
      return;
    }
    setPhase('uploading');
    setProgress(0);
    setStatus('Uploading backup…');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await uploadAttachment<{ restore: RestorePreview }>(
        '/backups/restore',
        file,
        abort.signal,
        (sent, total) => {
          if (!alive.current) return;
          setProgress(
            total ? Math.min(100, Math.round((sent / total) * 100)) : 0,
          );
          if (sent >= total) {
            setPhase('verifying');
            setStatus(
              'Upload complete. Verifying the database and attachment files…',
            );
          }
        },
      );
      if (!alive.current || abort.signal.aborted) {
        void api(
          `/backups/restore/${encodeURIComponent(result.restore.id)}`,
          'DELETE',
          {},
        ).catch(() => {});
        return;
      }
      staged.current = result.restore.id;
      setPreview(result.restore);
      setNow(Date.now());
      setStatus(
        'Backup verified. Review the contents before replacing current data.',
      );
    } catch (cause) {
      if (alive.current) {
        if (abort.signal.aborted)
          setStatus('Upload cancelled. Current data was not changed.');
        else {
          setError(message(cause, 'Could not verify backup'));
          setStatus('');
        }
      }
    } finally {
      if (alive.current) {
        controller.current = null;
        setPhase('idle');
      }
    }
  }
  function clearPreview() {
    staged.current = null;
    setPreview(null);
    setConfirmation('');
  }
  async function cancelPreview() {
    if (!preview) return;
    setPhase('cancelling');
    setError('');
    try {
      await api(
        `/backups/restore/${encodeURIComponent(preview.id)}`,
        'DELETE',
        {},
      ).catch((cause) => {
        // Expiry already removed the server preview; the local form can close.
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      });
      clearPreview();
      setStatus('Restore cancelled. Current data was not changed.');
    } catch (cause) {
      setError(message(cause, 'Could not cancel restore'));
    } finally {
      if (alive.current) setPhase('idle');
    }
  }
  async function restore(event: FormEvent) {
    event.preventDefault();
    if (!preview || confirmation !== 'RESTORE' || now >= preview.expiresAt)
      return;
    setPhase('restoring');
    setError('');
    setStatus(
      'Restoring backup. PortFolio is temporarily unavailable while data is replaced. Keep this page open.',
    );
    try {
      await api<{
        restored: true;
        reauthenticationRequired: true;
        recoveryId: string;
      }>(`/backups/restore/${encodeURIComponent(preview.id)}/confirm`, 'POST', {
        confirm: 'RESTORE',
      });
      staged.current = null;
      sessionStorage.setItem(
        'portfolio:restore-message',
        'Backup restored. Sign in with an account and password from the backup.',
      );
      restored.current = true;
      window.location.replace('/settings/backup');
    } catch (cause) {
      if (alive.current) {
        clearPreview();
        void api(
          `/backups/restore/${encodeURIComponent(preview.id)}`,
          'DELETE',
          {},
        ).catch(() => {});
        setError(message(cause, 'Could not restore backup'));
        setStatus(
          'Restore was not confirmed. Review the error and current application data before uploading a backup again.',
        );
        setPhase('idle');
        onRefresh();
      }
    }
  }
  return (
    <div className="backup-restore">
      <section>
        <h2>Backup & Restore</h2>
        <p>
          A complete backup includes every board, attachment, account and API
          token record. Backups contain private data and password hashes; store
          them securely.
        </p>
      </section>
      <section>
        <h3>Download Complete Backup</h3>
        <p>Download a portable ZIP of the current application data.</p>
        <button
          disabled={busy || Boolean(preview)}
          onClick={() => void create()}
        >
          {phase === 'creating' ? 'Preparing backup…' : 'Download Backup'}
        </button>
      </section>
      <section>
        <h3>Restore backup</h3>
        <p>
          Choose a complete PortFolio ZIP backup, up to{' '}
          {formatBytes(metadata.backup.maxUploadBytes)}. The file is verified
          before anything is replaced.
        </p>
        {!preview && (
          <label className="settings-file-label">
            Backup ZIP file
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = '';
              }}
            />
          </label>
        )}
        {(phase === 'uploading' || phase === 'verifying') && (
          <div className="settings-upload">
            <label>
              Backup upload
              <progress aria-label="Backup upload" max={100} value={progress} />
            </label>
            <span>{progress}%</span>
            <button onClick={() => controller.current?.abort()}>
              Cancel upload
            </button>
          </div>
        )}
        {preview && (
          <form
            className="settings-restore-preview"
            onSubmit={(event) => void restore(event)}
            aria-label="Verified backup"
          >
            <h4>Verified backup</h4>
            <dl className="settings-facts">
              <div>
                <dt>Created</dt>
                <dd>{new Date(preview.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Application version</dt>
                <dd>{preview.applicationVersion}</dd>
              </div>
              <div>
                <dt>Database schema</dt>
                <dd>{preview.databaseSchemaVersion}</dd>
              </div>
              <div>
                <dt>Boards</dt>
                <dd>{preview.boardCount}</dd>
              </div>
              <div>
                <dt>Attachments</dt>
                <dd>{preview.attachmentCount}</dd>
              </div>
              <div>
                <dt>Attachment size</dt>
                <dd>{formatBytes(preview.attachmentBytes)}</dd>
              </div>
              <div>
                <dt>Compatibility</dt>
                <dd>Compatible</dd>
              </div>
              <div>
                <dt>Confirmation expires</dt>
                <dd>{new Date(preview.expiresAt).toLocaleString()}</dd>
              </div>
            </dl>
            <p className="settings-warning">
              Restoring replaces all current boards, attachments, accounts and
              API tokens. A recovery backup of current data is saved first. You
              will be signed out and must use an account and password from the
              backup.
            </p>
            {now >= preview.expiresAt && (
              <p role="alert">
                This preview expired. Cancel and upload the backup again.
              </p>
            )}
            <label>
              Type RESTORE to replace current data
              <input
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className="settings-actions">
              <button
                type="submit"
                className="settings-danger"
                disabled={
                  busy || confirmation !== 'RESTORE' || now >= preview.expiresAt
                }
              >
                {phase === 'restoring' ? 'Restoring…' : 'Restore backup'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancelPreview()}
              >
                Cancel restore
              </button>
            </div>
          </form>
        )}
      </section>
      <div aria-live="polite" role="status">
        {status}
      </div>
      {error && <p role="alert">{error}</p>}
      <section>
        <h3>Recovery backups</h3>
        <p>{metadata.backup.recoveryPolicy}</p>
        {metadata.recoveries.length ? (
          <ul className="settings-recoveries">
            {metadata.recoveries.map((item) => (
              <li key={item.id}>
                <span>
                  {new Date(item.createdAt).toLocaleString()} ·{' '}
                  {formatBytes(item.bytes)}
                </span>
                <a href={item.downloadUrl} download>
                  Download recovery backup
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>No recovery backups yet.</p>
        )}
      </section>
    </div>
  );
}
