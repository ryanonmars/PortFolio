import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { z } from 'zod';
import {
  ARCHIVE_MAX_BYTES,
  siteArchiveSchema,
  type SiteArchive,
  type ImportRequest,
  type ImportPreview,
  type ImportSummary,
  type Site,
} from '../../../packages/shared/src/index.js';
import { api, ApiError } from './api.js';
import type { FormControls } from './ConfigurePanels.js';
import './transfer.css';

export function parseImportText(text: string): SiteArchive {
  if (new TextEncoder().encode(text).byteLength > ARCHIVE_MAX_BYTES)
    throw new Error('Choose a JSON document no larger than 8 MiB.');
  if (!text.trim())
    throw new Error(
      'Choose a JSON file or paste a JSON document before previewing.',
    );
  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(
      'The document is not valid JSON. Check the file or pasted text.',
    );
  }
  return siteArchiveSchema.parse(document);
}
export function suggestedImportName(
  document: Pick<SiteArchive, 'site'>,
): string {
  const suffix = ' (imported)';
  let base = '';
  for (const character of document.site.name.trim()) {
    if (base.length + character.length + suffix.length > 120) break;
    base += character;
  }
  return base + suffix;
}
export function downloadFilename(header: string | null): string {
  let candidate = '';
  if (header) {
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (encoded) {
      try {
        candidate = decodeURIComponent(encoded[1]!.trim());
      } catch {
        candidate = '';
      }
    }
    if (!candidate) {
      const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(header);
      candidate = plain?.[1] ?? plain?.[2] ?? '';
    }
  }
  candidate =
    candidate
      .split(/[\\/]/)
      .at(-1)
      ?.split('')
      .filter(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      )
      .join('')
      .trim()
      .slice(0, 180) ?? '';
  if (!candidate || candidate === '.' || candidate === '..')
    return 'PortFolio-site.json';
  return candidate.toLowerCase().endsWith('.json')
    ? candidate
    : `${candidate}.json`;
}

const countLabels: [keyof ImportSummary, string][] = [
  ['racks', 'Racks'],
  ['vlans', 'VLANs'],
  ['subnets', 'Subnets'],
  ['dhcpScopes', 'DHCP scopes'],
  ['devices', 'Devices'],
  ['ports', 'Ports'],
  ['fields', 'Custom fields'],
  ['customValues', 'Custom values'],
  ['connections', 'Physical connections'],
  ['logicalConnections', 'Logical connections'],
];
type CommitResult = {
  site: Site;
  summary: ImportSummary;
  backupCreated: boolean;
};
type Operation = 'reading' | 'export' | 'preview' | 'commit' | null;

export function Transfer({
  siteId,
  siteName,
  controls,
  onImported,
}: {
  siteId: string;
  siteName?: string;
  controls: FormControls;
  onImported?: (site: Site) => void;
}) {
  const [raw, setRaw] = useState('');
  const [filename, setFilename] = useState('');
  const [policy, setPolicy] = useState<ImportRequest['policy']>('new-site');
  const [copyName, setCopyName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [currentName, setCurrentName] = useState(siteName ?? 'Current site');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [expired, setExpired] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [pending, setPending] = useState<Operation>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<CommitResult | null>(null);
  const alive = useRef(false);
  const fileSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const objectURLs = useRef(new Set<string>());
  const jsonId = useId();
  const fileId = useId();
  const dirty =
    raw.length > 0 || filename.length > 0 || nameEdited || policy === 'replace';
  const reportDirty = useEffectEvent((value: boolean) =>
    controls.onDirtyChange(value),
  );
  const reportBusy = useEffectEvent((value: boolean) =>
    controls.onBusyChange(value),
  );
  useEffect(() => {
    reportDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    reportBusy(pending !== null);
  }, [pending]);
  const invalidateFileRead = useEffectEvent(() => {
    ++fileSequence.current;
  });
  useEffect(() => {
    const urls = objectURLs.current;
    alive.current = true;
    return () => {
      alive.current = false;
      invalidateFileRead();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      reportDirty(false);
      reportBusy(false);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!siteName)
      void api<{ site: Site }>(`/sites/${siteId}`)
        .then(({ site }) => {
          if (active) setCurrentName(site.name);
        })
        .catch(() => {
          /* The import preview will provide the authoritative target name. */
        });
    return () => {
      active = false;
    };
  }, [siteId, siteName]);
  useEffect(() => {
    if (!preview) return;
    const expiration = Date.parse(preview.expiresAt);
    const timer = window.setTimeout(
      () => setExpired(true),
      Number.isFinite(expiration) ? Math.max(0, expiration - Date.now()) : 0,
    );
    return () => window.clearTimeout(timer);
  }, [preview]);

  function invalidate() {
    setPreview(null);
    setExpired(false);
    setReplaceConfirmed(false);
    setError(null);
    setNotice('');
    setResult(null);
  }
  function clearInput() {
    ++fileSequence.current;
    setRaw('');
    setFilename('');
    setCopyName('');
    setNameEdited(false);
    setPolicy('new-site');
    setPreview(null);
    setExpired(false);
    setReplaceConfirmed(false);
    if (fileInput.current) fileInput.current.value = '';
  }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    const sequence = ++fileSequence.current;
    invalidate();
    setNameEdited(false);
    setCopyName('');
    if (!file) {
      setRaw('');
      setFilename('');
      return;
    }
    setFilename(file.name);
    setRaw('');
    if (file.size > ARCHIVE_MAX_BYTES) {
      setError(new Error('Choose a JSON file no larger than 8 MiB.'));
      return;
    }
    setPending('reading');
    try {
      const text = await file.text();
      if (!alive.current || sequence !== fileSequence.current) return;
      setRaw(text);
      try {
        setCopyName(suggestedImportName(parseImportText(text)));
      } catch (error) {
        setError(error);
      }
    } catch (error) {
      if (alive.current && sequence === fileSequence.current)
        setError(
          error instanceof Error
            ? error
            : new Error('The file could not be read. Try selecting it again.'),
        );
    } finally {
      if (alive.current && sequence === fileSequence.current) setPending(null);
    }
  }
  function request(): ImportRequest {
    const document = parseImportText(raw);
    if (policy === 'replace') return { document, policy };
    const siteName = (
      nameEdited ? copyName : copyName || suggestedImportName(document)
    ).trim();
    if (!siteName || siteName.length > 120)
      throw new Error(
        'Enter an imported site name between 1 and 120 characters.',
      );
    if (siteName !== copyName) setCopyName(siteName);
    return { document, policy, siteName };
  }
  async function previewImport() {
    if (pending) return;
    setError(null);
    setNotice('');
    setResult(null);
    setPreview(null);
    setReplaceConfirmed(false);
    setExpired(false);
    let body: ImportRequest;
    try {
      body = request();
    } catch (error) {
      setError(error);
      return;
    }
    setPending('preview');
    try {
      const response = await api<{ preview: ImportPreview }>(
        `/sites/${siteId}/import/preview`,
        'POST',
        body,
      );
      if (alive.current) {
        setPreview(response.preview);
        setExpired(
          !Number.isFinite(Date.parse(response.preview.expiresAt)) ||
            Date.parse(response.preview.expiresAt) <= Date.now(),
        );
      }
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      if (alive.current) setPending(null);
    }
  }
  async function commitImport() {
    if (pending || !preview) return;
    if (
      !Number.isFinite(Date.parse(preview.expiresAt)) ||
      Date.parse(preview.expiresAt) <= Date.now()
    ) {
      setPreview(null);
      setExpired(false);
      setError(
        new Error(
          'This preview has expired. Preview import again before applying it.',
        ),
      );
      return;
    }
    if (policy === 'replace' && !replaceConfirmed) {
      setError(
        new Error(
          'Confirm replacement of the current site contents before importing.',
        ),
      );
      return;
    }
    let body: ImportRequest;
    try {
      body = request();
    } catch (error) {
      setPreview(null);
      setError(error);
      return;
    }
    setPending('commit');
    setError(null);
    setNotice('');
    try {
      const response = await api<CommitResult>(
        `/sites/${siteId}/import/commit`,
        'POST',
        {
          ...body,
          previewToken: preview.token,
          confirmReplace: policy === 'replace' && replaceConfirmed,
        },
      );
      if (!alive.current) return;
      clearInput();
      setResult(response);
      setNotice(
        `Imported ${response.site.name}. ${response.backupCreated ? 'A SQLite backup was created before the import.' : 'Import completed.'}`,
      );
      setPending(null);
      controls.onDirtyChange(false);
      controls.onBusyChange(false);
      onImported?.(response.site);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 409) {
        setPreview(null);
        setExpired(false);
        setReplaceConfirmed(false);
        setError(
          new Error(
            `${error.message} Preview import again; your selected document and policy are preserved.`,
            { cause: error },
          ),
        );
      } else setError(error);
    } finally {
      if (alive.current) setPending(null);
    }
  }
  async function exportSite() {
    if (pending) return;
    setPending('export');
    setError(null);
    setNotice('');
    try {
      const response = await fetch(
        `/api/v1/sites/${siteId}/export?format=json`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      if (!response.ok) {
        if (response.status === 401)
          window.dispatchEvent(new Event('portfolio:unauthorized'));
        let text = 'The site export could not be downloaded.';
        try {
          const failure = await response.json();
          text = failure.error?.message ?? text;
        } catch {
          /* Keep a safe fallback for non-JSON errors. */
        }
        throw new Error(text);
      }
      if (!response.headers.get('Content-Type')?.includes('application/json'))
        throw new Error('The server did not return a JSON export. Try again.');
      const blob = await response.blob();
      if (!alive.current) return;
      const url = URL.createObjectURL(blob);
      objectURLs.current.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFilename(
        response.headers.get('Content-Disposition'),
      );
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        objectURLs.current.delete(url);
      }, 1000);
      setNotice(
        'Site JSON download started. It contains saved records from this server.',
      );
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      if (alive.current) setPending(null);
    }
  }

  const errorDetails =
    error instanceof z.ZodError
      ? error.issues
          .slice(0, 20)
          .map(
            (issue) =>
              `${issue.path.join('.') || 'Document'}: ${issue.message}`,
          )
      : error instanceof ApiError && error.fieldErrors
        ? Object.entries(error.fieldErrors)
            .flatMap(([key, values]) =>
              values.map((value) => `${key}: ${value}`),
            )
            .slice(0, 20)
        : [];
  return (
    <section className="transfer-pane" aria-labelledby="transfer-title">
      <div className="transfer-heading">
        <p className="eyebrow">DATA & RECOVERY</p>
        <h2 id="transfer-title">Export, import & recovery</h2>
        <p>
          Download saved site records or restore a PortFolio JSON export with a
          validated preview.
        </p>
      </div>
      <p className="transfer-privacy">
        Exports and SQLite backups contain private network details. Keep them
        out of source control and share them carefully.
      </p>
      {error !== null && (
        <div className="error-message transfer-error" role="alert">
          <p>
            {error instanceof z.ZodError
              ? 'The JSON document does not match a supported PortFolio site export.'
              : error instanceof Error
                ? error.message
                : 'The request could not be completed.'}
          </p>
          {errorDetails.length > 0 && (
            <ul>
              {errorDetails.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {pending && pending !== 'export' && (
        <p className="transfer-progress" role="status">
          {pending === 'reading'
            ? 'Reading JSON file…'
            : pending === 'preview'
              ? 'Validating import preview…'
              : 'Applying the validated import…'}
        </p>
      )}
      <section className="transfer-section" aria-labelledby="export-site-title">
        <div>
          <h3 id="export-site-title">Export current site</h3>
          <p>
            Includes equipment, ports, VLANs, network definitions, custom
            fields, and documented connections.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={pending !== null}
          onClick={() => void exportSite()}
        >
          {pending === 'export' ? 'Downloading…' : 'Download site JSON'}
        </button>
      </section>
      <section
        className="transfer-section transfer-import"
        aria-labelledby="import-site-title"
      >
        <h3 id="import-site-title">Import a site</h3>
        <p>
          Choose a PortFolio JSON file up to 8 MiB, or paste its contents. A
          preview validates the full graph before any records change.
        </p>
        <fieldset disabled={pending !== null} className="transfer-fields">
          <label htmlFor={fileId}>
            Import JSON file
            <input
              id={fileId}
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              onChange={(event) => void chooseFile(event)}
            />
          </label>
          {filename && (
            <p className="transfer-file-name">
              Selected file: {filename}. The document below can be edited.
            </p>
          )}
          <label htmlFor={jsonId}>
            JSON document
            <textarea
              id={jsonId}
              rows={6}
              maxLength={ARCHIVE_MAX_BYTES}
              spellCheck={false}
              value={raw}
              onChange={(event) => {
                invalidate();
                setRaw(event.target.value);
              }}
            />
          </label>
          <div className="transfer-policy-fields">
            <label>
              Import policy
              <select
                value={policy}
                onChange={(event) => {
                  invalidate();
                  setPolicy(event.target.value as ImportRequest['policy']);
                }}
              >
                <option value="new-site">New site copy</option>
                <option value="replace">Replace current site</option>
              </select>
            </label>
            {policy === 'new-site' ? (
              <label>
                Imported site name
                <input
                  value={copyName}
                  maxLength={120}
                  placeholder="Taken from the selected export"
                  onChange={(event) => {
                    invalidate();
                    setNameEdited(true);
                    setCopyName(event.target.value);
                  }}
                />
              </label>
            ) : (
              <p className="transfer-target">
                Replacement target: <strong>{currentName}</strong>
              </p>
            )}
          </div>
          {policy === 'replace' && (
            <p className="transfer-replace-warning">
              Replacement removes the current site's contents and restores the
              imported equipment, networks, fields, connections, description,
              and notes. The current site name is kept.
            </p>
          )}
          <div className="transfer-actions">
            <button
              type="button"
              disabled={!raw.trim() || pending !== null}
              onClick={() => void previewImport()}
            >
              {pending === 'preview' ? 'Validating…' : 'Preview import'}
            </button>
            <button
              type="button"
              className="subtle"
              disabled={pending !== null}
              onClick={() => {
                clearInput();
                setError(null);
                setNotice('');
                setResult(null);
              }}
            >
              Clear import
            </button>
          </div>
        </fieldset>
        {preview && (
          <section className="transfer-preview" aria-label="Import preview">
            <div className="transfer-preview-heading">
              <h3>Import preview</h3>
              <p>
                {preview.policy === 'new-site'
                  ? 'Create a new site'
                  : 'Replace site contents'}
                : <strong>{preview.siteName}</strong>
              </p>
            </div>
            <dl className="transfer-counts">
              {countLabels.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{preview.summary[key]}</dd>
                </div>
              ))}
            </dl>
            {preview.warnings.length > 0 && (
              <ul className="transfer-warnings" aria-label="Import warnings">
                {preview.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
            <p className="transfer-preview-expiry">
              {expired
                ? 'This preview has expired. Preview import again before applying it.'
                : `Preview expires at ${new Date(preview.expiresAt).toLocaleTimeString()}. Changing any import input requires a new preview.`}
            </p>
            <p className="transfer-backup-note">
              A SQLite backup must succeed before PortFolio applies the import.
              The import then commits as one transaction.
            </p>
            {policy === 'replace' && (
              <label className="transfer-confirm">
                <input
                  type="checkbox"
                  checked={replaceConfirmed}
                  disabled={pending !== null || expired}
                  onChange={(event) =>
                    setReplaceConfirmed(event.target.checked)
                  }
                />
                I understand this replaces all contents of the current site
              </label>
            )}
            <button
              type="button"
              className={
                policy === 'replace' ? 'transfer-replace-button' : 'primary'
              }
              disabled={
                pending !== null ||
                expired ||
                (policy === 'replace' && !replaceConfirmed)
              }
              onClick={() => void commitImport()}
            >
              {pending === 'commit'
                ? 'Importing…'
                : policy === 'replace'
                  ? 'Replace current site'
                  : 'Import as new site'}
            </button>
          </section>
        )}
        {result && (
          <section
            className="transfer-result"
            aria-labelledby="transfer-result-title"
          >
            <h3 id="transfer-result-title">Import complete</h3>
            <p>
              {result.site.name} contains {result.summary.devices} devices and{' '}
              {result.summary.ports} ports.
            </p>
            <a href={`/sites/${result.site.id}`}>Open imported site</a>
          </section>
        )}
      </section>
      <section
        className="transfer-section transfer-recovery"
        aria-labelledby="transfer-recovery-title"
      >
        <h3 id="transfer-recovery-title">SQLite recovery</h3>
        <p>
          JSON exports restore individual sites. SQLite backups also preserve
          accounts, sessions, and all workspaces. Keep backup files private.
        </p>
        <p>
          For a consistent local backup, run <code>pnpm db:backup</code> with
          the server's data directory configured. In Docker, use{' '}
          <code>
            docker compose exec portfolio node dist/scripts/database.js backup
          </code>
          .
        </p>
        <p>
          Restore into a new, empty directory with{' '}
          <code>
            DATA_DIR=/new/empty/directory pnpm db:restore
            /path/to/snapshot.sqlite
          </code>
          . Stop the running instance before switching it to the recovered data
          directory. Keep the current data directory until the restored database
          has been verified.
        </p>
      </section>
    </section>
  );
}
