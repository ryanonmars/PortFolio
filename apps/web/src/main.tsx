import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  application,
  type User,
  type Workspace,
  type Site,
  type DeleteImpact,
  type DeletionPreview,
  type NavigationTarget,
  type NavigationData,
  type SiteNavigationData,
  type ConfigurePane,
  navigationTarget,
  navigationUrl,
} from '../../../packages/shared/src/index.js';
import { api, ApiError, sessionRequest } from './api.js';
import {
  AuthForm,
  EntityForm,
  type Editor,
  type EntityValues,
} from './forms.js';
import { SiteView } from './Configure.js';
import { Sidebar } from './Sidebar.js';
import './styles.css';

type Location = NavigationTarget;
function readLocation(): Location {
  return navigationTarget(window.location.pathname, window.location.search);
}

function Brand() {
  return (
    <>
      <div className="brand">
        <svg
          className="brand-mark"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="3"
            y="3"
            width="26"
            height="26"
            rx="7"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M10 11h12v8h-3v4h-6v-4h-3z"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M13 11v4m3-4v4m3-4v4"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <span>{application.name}</span>
      </div>
      <p className="brand-tagline">{application.tagline}</p>
    </>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [setup, setSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [conflict, setConflict] = useState(false);
  const [configureDirty, setConfigureDirty] = useState(false);
  const [configureBusy, setConfigureBusy] = useState(false);
  const location = useRef<Location>(readLocation());
  const navigationVersion = useRef(0);
  const [activeRoute, setActiveRoute] = useState<Location>(readLocation);
  const [navigationEpoch, setNavigationEpoch] = useState(0);
  const [createPane, setCreatePane] = useState<ConfigurePane>();
  const [navigationData, setNavigationData] = useState<NavigationData | null>(
    null,
  );
  const [navigationLoaded, setNavigationLoaded] = useState(-1);
  const [navigationError, setNavigationError] = useState('');
  const [navigationRefresh, setNavigationRefresh] = useState(0);
  const navigationLoading =
    Boolean(user) && navigationLoaded !== navigationRefresh;
  const sidebarRequest = useRef(0);
  useEffect(() => {
    let active = true;
    const request = ++sidebarRequest.current;
    if (!user) return;
    const refresh = () => setNavigationRefresh((value) => value + 1);
    window.addEventListener('portfolio:changed', refresh);
    void api<NavigationData>('/navigation')
      .then((data) => {
        if (active && request === sidebarRequest.current) {
          setNavigationData(data);
          setNavigationError('');
        }
      })
      .catch((error: unknown) => {
        if (active && request === sidebarRequest.current)
          setNavigationError(
            error instanceof Error
              ? error.message
              : 'Unable to load navigation.',
          );
      })
      .finally(() => {
        if (active && request === sidebarRequest.current)
          setNavigationLoaded(navigationRefresh);
      });
    return () => {
      active = false;
      window.removeEventListener('portfolio:changed', refresh);
    };
  }, [user, navigationRefresh]);

  const [siteRecordState, setSiteRecordState] = useState<{
    siteId: string;
    refresh: number;
    data: SiteNavigationData | null;
    error: string;
  } | null>(null);
  const siteRecordRequest = useRef(0);
  const recordSiteId = activeRoute.siteId;
  const records =
    user && recordSiteId && siteRecordState?.siteId === recordSiteId
      ? siteRecordState.data
      : null;
  const recordsLoading = Boolean(
    user &&
    recordSiteId &&
    (siteRecordState?.siteId !== recordSiteId ||
      siteRecordState?.refresh !== navigationRefresh),
  );
  const recordsError =
    user &&
    recordSiteId &&
    siteRecordState &&
    siteRecordState.siteId === recordSiteId
      ? siteRecordState.error
      : '';
  useEffect(() => {
    const request = ++siteRecordRequest.current;
    let active = true;
    if (!user || !recordSiteId) return;
    void api<SiteNavigationData>(
      '/sites/' + encodeURIComponent(recordSiteId) + '/navigation',
    )
      .then((data) => {
        if (active && request === siteRecordRequest.current)
          setSiteRecordState({
            siteId: recordSiteId,
            refresh: navigationRefresh,
            data,
            error: '',
          });
      })
      .catch((error: unknown) => {
        if (active && request === siteRecordRequest.current)
          setSiteRecordState({
            siteId: recordSiteId,
            refresh: navigationRefresh,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load site records.',
          });
      });
    return () => {
      active = false;
    };
  }, [user, recordSiteId, navigationRefresh]);

  async function load(
    locationToLoad: Location = location.current,
    onLoaded?: () => void,
  ) {
    const version = ++navigationVersion.current;
    const result = await api<{ workspaces: Workspace[] }>('/workspaces');
    let selectedSite: Site | null = null;
    if (locationToLoad.siteId)
      selectedSite = (
        await api<{ site: Site }>(
          `/sites/${encodeURIComponent(locationToLoad.siteId)}`,
        )
      ).site;
    const workspaceId = selectedSite?.workspaceId ?? locationToLoad.workspaceId;
    const selectedWorkspace =
      result.workspaces.find((item) => item.id === workspaceId) ?? null;
    if (workspaceId && !selectedWorkspace)
      throw new ApiError('Workspace not found.', 404);
    const siteResult = selectedWorkspace
      ? await api<{ sites: Site[] }>(
          `/workspaces/${selectedWorkspace.id}/sites`,
        )
      : { sites: [] };
    if (version !== navigationVersion.current) return false;
    onLoaded?.();
    setWorkspaces(result.workspaces);
    setWorkspace(selectedWorkspace);
    setSites(siteResult.sites);
    setSite(selectedSite);
    return true;
  }

  const loadCurrent = useEffectEvent(() => load());
  const loadTarget = useEffectEvent((target: Location, onLoaded: () => void) =>
    load(target, onLoaded),
  );
  const canLeave = useEffectEvent(() => {
    if (busy) return false;
    if (configureBusy) {
      window.alert('Wait for the current save to finish.');
      return false;
    }
    return (
      (!editor && !configureDirty) || window.confirm('Discard unsaved changes?')
    );
  });
  const expireSession = useEffectEvent(() => {
    ++navigationVersion.current;
    setUser(null);
    ++sidebarRequest.current;
    setNavigationData(null);
    ++siteRecordRequest.current;
    setSiteRecordState(null);
    setNavigationLoaded(-1);
    setNavigationError('');
    setWorkspace(null);
    setSite(null);
    setSites([]);
    setWorkspaces([]);
    setEditor(null);
    setConflict(false);
    setNotice('');
    setBusy(false);
    setSetup(false);
    setError(
      configureDirty
        ? 'Your session ended. Unsaved configuration changes were not saved. Sign in again to continue.'
        : 'Your session ended. Sign in again to continue.',
    );
    location.current = {};
    setActiveRoute({});
    window.history.replaceState(null, '', '/');
    void sessionRequest().catch(() =>
      setError('Cannot reach the server. Reload to try again.'),
    );
  });

  useEffect(() => {
    void sessionRequest()
      .then(async (session) => {
        const setupStatus = await api<{ setupRequired: boolean }>(
          '/auth/setup-status',
        );
        setUser(session.user);
        setSetup(setupStatus.setupRequired);
        if (session.user) await loadCurrent();
      })
      .catch((error: unknown) =>
        setError(
          error instanceof Error
            ? error.message
            : 'Cannot reach the PortFolio server.',
        ),
      )
      .finally(() => setLoading(false));
    function onPopState() {
      if (!canLeave()) {
        const current = location.current;
        window.history.pushState(null, '', navigationUrl(current));
        return;
      }
      const next = readLocation();
      setEditor(null);
      setError('');
      setBusy(true);
      const version = navigationVersion.current + 1;
      void loadTarget(next, () => {
        window.history.replaceState(null, '', navigationUrl(next));
        setCreatePane(undefined);
        location.current = next;
        setActiveRoute(next);
        setNavigationEpoch((value) => value + 1);
      })
        .catch((error: unknown) => {
          if (version !== navigationVersion.current) return;
          window.history.replaceState(
            null,
            '',
            navigationUrl(location.current),
          );
          setError(
            error instanceof Error
              ? error.message
              : 'Unable to load this page.',
          );
        })
        .finally(() => {
          if (version === navigationVersion.current) setBusy(false);
        });
    }
    const onUnauthorized = () => expireSession();
    window.addEventListener('popstate', onPopState);
    window.addEventListener('portfolio:unauthorized', onUnauthorized);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('portfolio:unauthorized', onUnauthorized);
    };
  }, []);

  useEffect(() => {
    if (!editor && !configureDirty && !configureBusy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editor, configureDirty, configureBusy]);

  async function navigate(
    next: Location,
    creation?: ConfigurePane,
    force = false,
  ): Promise<boolean> {
    if (busy || configureBusy) return false;
    if (
      !creation &&
      !force &&
      navigationUrl(next) === navigationUrl(location.current)
    )
      return true;
    if (
      (editor || configureDirty) &&
      !window.confirm('Discard unsaved changes?')
    )
      return false;
    setConflict(false);
    setBusy(true);
    setError('');
    setNotice('');
    setEditor(null);
    const version = navigationVersion.current + 1;
    try {
      return await load(next, () => {
        setCreatePane(creation);
        location.current = next;
        window.history.pushState(null, '', navigationUrl(next));
        setActiveRoute(next);
        setNavigationEpoch((value) => value + 1);
        setNavigationRefresh((value) => value + 1);
      });
    } catch (error) {
      if (version !== navigationVersion.current) return false;
      setError(
        error instanceof Error ? error.message : 'Unable to open this page.',
      );
      return false;
    } finally {
      if (version === navigationVersion.current) setBusy(false);
    }
  }

  async function createFromSidebar(
    kind: 'workspace' | 'site' | ConfigurePane,
    target: Location,
  ) {
    if (kind === 'workspace' || kind === 'site') {
      if (!(await navigate(target, undefined, true))) return false;
      edit({ kind });
      return true;
    }
    return navigate({ ...target, configure: true, pane: kind }, kind);
  }

  async function authenticate(username: string, password: string) {
    const session = await sessionRequest(
      setup ? '/auth/setup' : '/auth/login',
      { username, password },
    );
    setUser(session.user);
    setSetup(false);
    setError('');
    await load();
  }

  async function logout() {
    if (configureBusy) return;
    if (
      (editor || configureDirty) &&
      !window.confirm('Discard unsaved changes and sign out?')
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', 'POST', {});
      ++navigationVersion.current;
      setUser(null);
      ++sidebarRequest.current;
      setNavigationData(null);
      ++siteRecordRequest.current;
      setSiteRecordState(null);
      setNavigationLoaded(-1);
      setNavigationError('');
      setWorkspace(null);
      setSite(null);
      setSites([]);
      setWorkspaces([]);
      setEditor(null);
      setNotice('');
      location.current = {};
      setActiveRoute({});
      window.history.replaceState(null, '', '/');
      await sessionRequest();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign out.');
    } finally {
      setBusy(false);
    }
  }

  async function saveEntity(values: EntityValues) {
    if (!editor || busy) return;
    setBusy(true);
    const path =
      editor.kind === 'workspace'
        ? `/workspaces${editor.value ? `/${editor.value.id}` : ''}`
        : editor.value
          ? `/sites/${editor.value.id}`
          : `/workspaces/${workspace!.id}/sites`;
    try {
      const result = await api<{ workspace?: Workspace; site?: Site }>(
        path,
        editor.value ? 'PATCH' : 'POST',
        {
          ...values,
          ...(editor.value ? { rowVersion: editor.value.rowVersion } : {}),
        },
      );
      if (!editor.value) {
        const next: Location =
          editor.kind === 'workspace'
            ? { workspaceId: result.workspace!.id }
            : { siteId: result.site!.id };
        await load(next, () => {
          location.current = next;
          window.history.pushState(null, '', navigationUrl(next));
          setActiveRoute(next);
          setCreatePane(undefined);
          setNavigationEpoch((value) => value + 1);
        });
      } else await load();
      setEditor(null);
      setNotice(
        `${editor.kind === 'workspace' ? 'Workspace' : 'Site'} ${editor.value ? 'updated' : 'created'}.`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && editor.value) {
        await load();
        setConflict(true);
        throw new Error(
          `${error.message} The latest records have been loaded. Your unsaved fields are preserved. Load the latest version before trying again.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntity(
    kind: 'workspace' | 'site',
    value: Workspace | Site,
  ) {
    if (busy || configureBusy || editor || configureDirty) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const path = `/${kind === 'workspace' ? 'workspaces' : 'sites'}/${value.id}`;
      const preview = await api<DeletionPreview>(`${path}/deletion-impact`);
      const labels: [keyof DeleteImpact, string][] = [
        ['sites', 'Sites'],
        ['devices', 'Devices'],
        ['ports', 'Ports'],
        ['vlans', 'VLANs'],
        ['racks', 'Racks'],
        ['subnets', 'Subnets'],
        ['dhcpScopes', 'DHCP scopes'],
        ['fields', 'Custom fields'],
        ['customValues', 'Custom values'],
        ['connections', 'Physical connections'],
        ['logicalConnections', 'Logical connections'],
      ];
      const counts = labels
        .map(([key, label]) => `${label}: ${preview.impact[key]}`)
        .join('\n');
      if (
        !window.confirm(
          `Delete ${kind} “${preview.name}” and everything below it?\n\n${counts}\n\nAll listed records will be permanently removed. This cannot be undone.`,
        )
      )
        return;
      await api(path, 'DELETE', { rowVersion: preview.rowVersion });
      await load();
      setNotice(`${kind === 'workspace' ? 'Workspace' : 'Site'} deleted.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to delete.');
      if (error instanceof ApiError && error.status === 409) await load();
    } finally {
      setBusy(false);
    }
  }

  function edit(value: Editor) {
    setConflict(false);
    setEditor(value);
    setError('');
    setNotice('');
  }
  const deviceFocused = Boolean(
    site && activeRoute.configure && activeRoute.deviceId,
  );
  const heading = site?.name ?? workspace?.name ?? 'Workspaces';
  let content: ReactNode;
  if (loading)
    content = (
      <p className="loading" role="status">
        Opening PortFolio…
      </p>
    );
  else if (!user)
    content = (
      <AuthForm
        key={setup ? 'setup' : 'login'}
        setup={setup}
        onAuthenticate={authenticate}
      />
    );
  else
    content = (
      <>
        {(workspace || site) && (
          <div className="breadcrumbs">
            <button
              className="text-button"
              disabled={busy || configureBusy}
              onClick={() => void navigate({})}
            >
              Workspaces
            </button>
            {workspace && (
              <>
                <span aria-hidden="true">/</span>
                <button
                  className="text-button"
                  disabled={busy || configureBusy}
                  onClick={() => void navigate({ workspaceId: workspace.id })}
                >
                  {workspace.name}
                </button>
              </>
            )}
            {site && (
              <>
                <span aria-hidden="true">/</span>
                <span>{site.name}</span>
              </>
            )}
          </div>
        )}
        {!deviceFocused && (site || workspace || workspaces.length > 0) && (
          <div className="page-heading page-heading-row">
            <div>
              <h1>{heading}</h1>
              {(site?.description || workspace?.description) && (
                <p className="intro">
                  {site?.description || workspace?.description}
                </p>
              )}
            </div>
            {site && (
              <button
                disabled={
                  busy || configureBusy || configureDirty || Boolean(editor)
                }
                title={
                  configureDirty
                    ? 'Save or discard configuration changes first'
                    : undefined
                }
                onClick={() => edit({ kind: 'site', value: site })}
              >
                Edit site
              </button>
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {editor && (
          <EntityForm
            key={`${editor.kind}-${editor.value?.id ?? 'new'}-${editor.value?.rowVersion ?? 0}`}
            editor={editor}
            onSave={saveEntity}
            onCancel={() => {
              if (window.confirm('Discard unsaved changes?')) {
                setEditor(null);
                setConflict(false);
              }
            }}
          />
        )}
        {conflict && editor?.value && (
          <button
            type="button"
            onClick={() => {
              if (
                !window.confirm(
                  'Discard your unsaved fields and load the latest version?',
                )
              )
                return;
              const latest =
                editor.kind === 'workspace'
                  ? workspaces.find((item) => item.id === editor.value?.id)
                  : site?.id === editor.value?.id
                    ? site
                    : sites.find((item) => item.id === editor.value?.id);
              if (latest)
                setEditor(
                  editor.kind === 'workspace'
                    ? { kind: 'workspace', value: latest as Workspace }
                    : { kind: 'site', value: latest as Site },
                );
              else setEditor(null);
              setConflict(false);
            }}
          >
            Load latest version
          </button>
        )}
        {site ? (
          <section aria-label="Site visual equipment layout">
            <div inert={Boolean(editor) || busy}>
              <SiteView
                key={`${site.id}:${navigationEpoch}`}
                siteId={site.id}
                userId={user.id}
                createPane={createPane}
                onDirtyChange={setConfigureDirty}
                onBusyChange={setConfigureBusy}
                onSiteImported={(imported) => {
                  setSites((previous) =>
                    previous.some((item) => item.id === imported.id)
                      ? previous.map((item) =>
                          item.id === imported.id ? imported : item,
                        )
                      : [...previous, imported],
                  );
                  if (imported.id === site.id) setSite(imported);
                }}
                onModeChange={() => {
                  setCreatePane(undefined);
                  location.current = readLocation();
                  setActiveRoute(location.current);
                }}
              />
            </div>
            {site.notes && (
              <section className="site-notes">
                <h2>Site notes</h2>
                <p>{site.notes}</p>
              </section>
            )}
          </section>
        ) : (
          <section aria-label={workspace ? 'Sites' : 'Workspaces'}>
            {(workspace ? sites : workspaces).length ? (
              <ul className="entity-list">
                {(workspace ? sites : workspaces).map((value) => (
                  <li key={value.id}>
                    <button
                      className="entity-link"
                      disabled={busy || configureBusy}
                      onClick={() =>
                        void navigate(
                          workspace
                            ? { siteId: value.id }
                            : { workspaceId: value.id },
                        )
                      }
                    >
                      <span className="entity-icon" aria-hidden="true">
                        {workspace ? '⌁' : '◇'}
                      </span>
                      <span>
                        <strong>{value.name}</strong>
                        {value.description && (
                          <span className="entity-description">
                            {value.description}
                          </span>
                        )}
                      </span>
                      <span className="entity-arrow" aria-hidden="true">
                        →
                      </span>
                    </button>
                    <div className="row-actions">
                      <button
                        className="subtle"
                        disabled={busy || configureBusy || Boolean(editor)}
                        aria-label={`Edit ${workspace ? 'site' : 'workspace'} ${value.name}`}
                        onClick={() =>
                          edit(
                            workspace
                              ? { kind: 'site', value: value as Site }
                              : {
                                  kind: 'workspace',
                                  value: value as Workspace,
                                },
                          )
                        }
                      >
                        Edit
                      </button>
                      <button
                        className="subtle danger"
                        disabled={busy || configureBusy || Boolean(editor)}
                        aria-label={`Delete ${workspace ? 'site' : 'workspace'} ${value.name}`}
                        onClick={() =>
                          void deleteEntity(
                            workspace ? 'site' : 'workspace',
                            value,
                          )
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="list-empty">
                {workspace
                  ? 'No sites configured yet.'
                  : 'No workspaces configured yet.'}
              </p>
            )}
          </section>
        )}
      </>
    );

  if (user && !loading && activeRoute.settings) {
    content = (
      <section aria-label="Global settings">
        <div className="page-heading">
          <h1>Global Settings</h1>
        </div>
        <section className="settings-section">
          <h2>Organization</h2>
          <div className="actions">
            <button disabled={busy} onClick={() => void navigate({})}>
              Manage workspaces
            </button>
            {workspace && (
              <button
                disabled={busy}
                onClick={() => void navigate({ workspaceId: workspace.id })}
              >
                Manage sites in {workspace.name}
              </button>
            )}
          </div>
        </section>
        <section className="settings-section">
          <h2>Application</h2>
          <dl>
            <dt>Application</dt>
            <dd>PortFolio</dd>
            <dt>Signed in as</dt>
            <dd>{user.username}</dd>
            <dt>Version</dt>
            <dd>0.1.0</dd>
            <dt>Storage</dt>
            <dd>Persistent server SQLite</dd>
          </dl>
        </section>
        <section className="settings-section">
          <h2>Backup & recovery</h2>
          <p>
            Database backups include all workspaces, sites and reusable
            templates. Keep backup files private.
          </p>
          <p>Create a consistent backup from the server:</p>
          <code>
            docker compose exec portfolio node dist/scripts/database.js backup
          </code>
          <p>
            Restore into a new empty data directory with the recovery CLI before
            switching the data mount.
          </p>
        </section>
      </section>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Application">
        <Brand />

        {user ? (
          <Sidebar
            data={navigationData}
            records={records}
            recordsLoading={recordsLoading}
            recordsError={recordsError}
            loading={navigationLoading}
            error={navigationError}
            current={{
              ...activeRoute,
              ...(workspace ? { workspaceId: workspace.id } : {}),
            }}
            disabled={busy || configureBusy || loading}
            onNavigate={navigate}
            onCreate={createFromSidebar}
            onRefresh={() => setNavigationRefresh((value) => value + 1)}
          />
        ) : (
          <div className="current-section">
            <span aria-hidden="true">◇</span>
            {setup ? 'Set up PortFolio' : 'Your account'}
          </div>
        )}
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            {user ? (workspace?.name ?? 'Workspaces') : 'Getting started'}
          </span>
          <div className="account-controls">
            {user && (
              <>
                <span>{user.username}</span>
                <button
                  className="subtle"
                  disabled={busy || configureBusy}
                  onClick={() => void logout()}
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              {!user && (
                <button onClick={() => window.location.reload()}>
                  Try again
                </button>
              )}
            </div>
          )}
          {content}
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root missing');
createRoot(root).render(<App />);
