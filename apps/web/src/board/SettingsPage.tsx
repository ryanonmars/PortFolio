import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ApiTokens } from './ApiTokens.js';
import { BackupRestore } from './BackupRestore.js';
import './settings.css';

export type SettingsSection = 'general' | 'backup' | 'api-tokens' | 'about';
export function resolveSettingsLocation(path: string): SettingsSection | null {
  const match = path.match(
    /^\/settings(?:\/(general|backup|api-tokens|about))?\/?$/,
  );
  return match
    ? ((match[1] as SettingsSection | undefined) ?? 'general')
    : null;
}
export interface SettingsMetadata {
  application: {
    name: string;
    version: string;
    revision?: string;
    databaseSchemaVersion: string;
  };
  account: { username: string };
  deployment: { runtime: string; storage: string };
  backup: { maxUploadBytes: number; recoveryPolicy: string };
  recoveries: {
    id: string;
    createdAt: string;
    bytes: number;
    downloadUrl: string;
  }[];
}
const sections: [SettingsSection, string][] = [
  ['general', 'General'],
  ['backup', 'Backup & Restore'],
  ['api-tokens', 'API Tokens'],
  ['about', 'About'],
];
export function SettingsPage({
  section,
  onNavigate,
  onBusyChange,
}: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [metadata, setMetadata] = useState<SettingsMetadata | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void api<SettingsMetadata>('/settings')
      .then((result) => {
        if (alive) {
          setMetadata(result);
          setError('');
        }
      })
      .catch((cause) => {
        if (alive)
          setError(
            cause instanceof Error ? cause.message : 'Could not load Settings',
          );
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <header className="settings-header">
        <h1 id="settings-title">Settings</h1>
        <p>Manage your account, backups and application access.</p>
      </header>
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map(([key, label]) => (
          <a
            key={key}
            href={`/settings/${key}`}
            aria-current={key === section ? 'page' : undefined}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onNavigate(key);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="settings-content" key={section}>
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button onClick={() => setAttempt((value) => value + 1)}>
              Retry Settings
            </button>
          </div>
        )}
        {!metadata && !error && <p role="status">Loading Settings…</p>}
        {section === 'api-tokens' ? (
          <ApiTokens />
        ) : (
          metadata && (
            <>
              {section === 'general' && (
                <section>
                  <h2>General</h2>
                  <dl className="settings-facts">
                    <div>
                      <dt>Signed in as</dt>
                      <dd>{metadata.account.username}</dd>
                    </div>
                    <div>
                      <dt>Application</dt>
                      <dd>{metadata.application.name}</dd>
                    </div>
                  </dl>
                  <p>Boards and their documentation save automatically.</p>
                </section>
              )}
              {section === 'backup' && (
                <BackupRestore
                  metadata={metadata}
                  onBusyChange={onBusyChange}
                  onRefresh={() => setAttempt((value) => value + 1)}
                />
              )}
              {section === 'about' && (
                <section>
                  <h2>About PortFolio</h2>
                  <p>Visual Network Documentation</p>
                  <dl className="settings-facts">
                    <div>
                      <dt>Version</dt>
                      <dd>{metadata.application.version}</dd>
                    </div>
                    {metadata.application.revision && (
                      <div>
                        <dt>Revision</dt>
                        <dd>{metadata.application.revision}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Database schema</dt>
                      <dd>{metadata.application.databaseSchemaVersion}</dd>
                    </div>
                    <div>
                      <dt>Runtime</dt>
                      <dd>{metadata.deployment.runtime}</dd>
                    </div>
                    <div>
                      <dt>Storage</dt>
                      <dd>{metadata.deployment.storage}</dd>
                    </div>
                  </dl>
                  <div className="settings-links">
                    <a
                      href="https://github.com/ryanonmars/portfolio"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Source code
                    </a>
                    <a
                      href="https://github.com/ryanonmars/portfolio#readme"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Documentation
                    </a>
                  </div>
                </section>
              )}
            </>
          )
        )}
      </div>
    </section>
  );
}
