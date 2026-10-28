import { useId, useRef, useState } from 'react';
import {
  navigationUrl,
  type ConfigurePane,
  type NavigationData,
  type NavigationTarget,
} from '../../../packages/shared/src/index.js';
import './sidebar.css';
export interface SidebarProps {
  data: NavigationData | null;
  loading: boolean;
  error: string;
  current: NavigationTarget;
  disabled: boolean;
  onNavigate: (target: NavigationTarget) => Promise<boolean>;
  onCreate: (
    kind: 'workspace' | 'site' | ConfigurePane,
    target: NavigationTarget,
  ) => Promise<boolean>;
  onRefresh: () => void;
}
export function workspaceTree(data: NavigationData) {
  const sitesByWorkspace = new Map<string, NavigationData['sites']>();
  for (const item of data.sites) {
    const list = sitesByWorkspace.get(item.workspaceId) ?? [];
    list.push(item);
    sitesByWorkspace.set(item.workspaceId, list);
  }
  return data.workspaces.map((workspace) => ({
    workspace,
    sites: sitesByWorkspace.get(workspace.id) ?? [],
  }));
}
const categories: { label: string; pane?: ConfigurePane; add?: string }[] = [
  { label: 'Visual Overview' },
  { label: 'Equipment', pane: 'devices', add: 'Add device' },
  { label: 'VLANs', pane: 'vlans', add: 'Add VLAN' },
  { label: 'Networks & Subnets', pane: 'network', add: 'Add subnet' },
  { label: 'Connections', pane: 'connections', add: 'Add connection' },
  { label: 'Racks', pane: 'racks', add: 'Add rack' },
  { label: 'Templates', pane: 'templates', add: 'Create template' },
  { label: 'Import & Export', pane: 'transfer' },
];
export function Sidebar({
  data,
  loading,
  error,
  current,
  disabled,
  onNavigate,
  onCreate,
  onRefresh,
}: SidebarProps) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [failure, setFailure] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const id = useId(),
    menu = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const site = data?.sites.find((s) => s.id === current.siteId),
    workspaceId = site?.workspaceId ?? current.workspaceId ?? '';
  const tree = data ? workspaceTree(data) : [];
  function toggleWorkspace(workspaceId: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }
  function close() {
    setOpen(false);
    if (
      window.matchMedia('(max-width: 640px)').matches &&
      panel.current?.contains(document.activeElement)
    )
      menu.current?.focus();
  }
  async function act(
    target: NavigationTarget,
    kind?: 'workspace' | 'site' | ConfigurePane,
  ) {
    if (disabled) return;
    setFailure('');
    try {
      if (await (kind ? onCreate(kind, target) : onNavigate(target))) close();
    } catch {
      setFailure('Unable to open this destination. Try again.');
    }
  }
  function add(
    label: string,
    kind: 'workspace' | 'site' | ConfigurePane,
    target: NavigationTarget,
    unavailable = false,
  ) {
    return (
      <button
        type="button"
        className="sidebar-add"
        aria-label={label}
        title={label}
        disabled={disabled || unavailable}
        onClick={() => void act(target, kind)}
      >
        <span aria-hidden="true">+</span>
      </button>
    );
  }
  function link(
    label: string,
    target: NavigationTarget,
    selected = false,
    unavailable = false,
    currentKind: 'location' | 'true' = 'location',
    accessibleLabel?: string,
  ) {
    return (
      <a
        href={navigationUrl(target)}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        aria-current={selected ? currentKind : undefined}
        aria-disabled={disabled || unavailable || undefined}
        onClick={(e) => {
          if (
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          )
            return;
          e.preventDefault();
          if (!unavailable) void act(target);
        }}
      >
        {label}
      </a>
    );
  }
  const term = query.trim().toLowerCase();
  const results =
    data && term
      ? [
          ...data.sites
            .filter((s) => s.name.toLowerCase().includes(term))
            .map((s) => ({
              id: s.id,
              label:
                s.name +
                ' · ' +
                data.workspaces.find((w) => w.id === s.workspaceId)?.name,
              target: { siteId: s.id } as NavigationTarget,
            })),
          ...data.devices
            .filter((d) =>
              (
                d.displayName +
                ' ' +
                d.type +
                ' ' +
                data.sites.find((s) => s.id === d.siteId)?.name
              )
                .toLowerCase()
                .includes(term),
            )
            .map((d) => ({
              id: d.id,
              label:
                d.displayName +
                ' · ' +
                data.sites.find((s) => s.id === d.siteId)?.name,
              target: {
                siteId: d.siteId,
                configure: true,
                deviceId: d.id,
              } as NavigationTarget,
            })),
        ].slice(0, 30)
      : [];
  return (
    <div className="portfolio-sidebar">
      <button
        ref={menu}
        type="button"
        className="sidebar-menu-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        Menu <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <div
        ref={panel}
        id={id}
        className="sidebar-panel"
        data-mobile-open={open}
        onKeyDown={(e) => {
          if (
            e.key === 'Escape' &&
            window.matchMedia('(max-width: 640px)').matches
          ) {
            e.preventDefault();
            close();
          }
        }}
      >
        <nav
          aria-label="Workspace navigation"
          className="sidebar-navigation-tree"
        >
          <div className="sidebar-search">
            <label>
              <span>Search navigation</span>
              <input
                type="search"
                maxLength={200}
                placeholder="Find a site or device…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {query && (
              <button
                type="button"
                aria-label="Clear navigation search"
                onClick={() => setQuery('')}
              >
                Clear
              </button>
            )}
          </div>
          <div className="workspace-tree-heading">
            <span>Workspaces</span>
            <div className="sidebar-context-actions">
              <button
                type="button"
                className="sidebar-manage"
                aria-label="Manage workspaces"
                title="Edit or delete workspaces"
                disabled={disabled}
                onClick={() => void act({})}
              >
                Manage
              </button>
              {add('Add workspace', 'workspace', {})}
            </div>
          </div>
          <div
            className="workspace-tree-scroll"
            aria-label="Workspaces and sites"
          >
            {term && (
              <section
                className="sidebar-results"
                aria-label="Navigation search results"
              >
                {results.length ? (
                  results.map((r) => (
                    <div key={r.id}>{link(r.label, r.target)}</div>
                  ))
                ) : (
                  <p>No matching sites or equipment.</p>
                )}
              </section>
            )}
            <ul className="workspace-branches">
              {tree.map(({ workspace, sites }) => {
                const expanded = !collapsed.has(workspace.id);
                const branchId = id + '-workspace-' + workspace.id;
                return (
                  <li key={workspace.id}>
                    <div className="workspace-branch-row">
                      <button
                        type="button"
                        className="workspace-toggle"
                        aria-label={
                          (expanded ? 'Collapse' : 'Expand') +
                          ' workspace ' +
                          workspace.name
                        }
                        aria-expanded={expanded}
                        aria-controls={branchId}
                        onClick={() => toggleWorkspace(workspace.id)}
                      >
                        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                      </button>
                      {link(
                        workspace.name,
                        { workspaceId: workspace.id },
                        workspaceId === workspace.id && !site,
                        false,
                        'true',
                        'Open workspace ' + workspace.name,
                      )}
                      {add('Add site in ' + workspace.name, 'site', {
                        workspaceId: workspace.id,
                      })}
                    </div>
                    {expanded && (
                      <ul id={branchId} className="workspace-sites">
                        {sites.length ? (
                          sites.map((item) => (
                            <li key={item.id}>
                              {link(
                                item.name,
                                { siteId: item.id },
                                site?.id === item.id,
                                false,
                                'true',
                                'Open site ' +
                                  item.name +
                                  ' in ' +
                                  workspace.name,
                              )}
                            </li>
                          ))
                        ) : (
                          <li className="sidebar-empty-branch">
                            No sites configured yet.
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {!loading && data && !tree.length && (
              <p className="sidebar-empty-branch">
                No workspaces configured yet.
              </p>
            )}
          </div>
          <div className="sidebar-status" aria-live="polite">
            {loading && <p role="status">Loading navigation…</p>}
            {(error || failure) && (
              <div role="alert">
                <p>{error || failure}</p>
                <button type="button" onClick={onRefresh}>
                  Retry navigation
                </button>
              </div>
            )}
          </div>
          <div className="site-tools-heading">
            <span title={site?.name}>
              {site ? site.name + ' — Site tools' : 'Site tools'}
            </span>
            {workspaceId && (
              <button
                type="button"
                className="sidebar-manage"
                aria-label="Manage sites"
                title="Edit or delete sites"
                disabled={disabled}
                onClick={() => void act({ workspaceId })}
              >
                Manage
              </button>
            )}
          </div>
          {!site && (
            <p className="sidebar-no-site">Select a site to use its tools.</p>
          )}
          <div className="sidebar-tree-scroll">
            <ul className="sidebar-categories">
              {categories.map((c) => {
                const target: NavigationTarget = {
                  ...(site ? { siteId: site.id } : {}),
                  configure: Boolean(c.pane),
                  ...(c.pane ? { pane: c.pane } : {}),
                };
                const active =
                  Boolean(site) &&
                  !current.settings &&
                  (c.pane
                    ? current.configure &&
                      (current.pane ?? 'devices') === c.pane
                    : !current.configure);
                return (
                  <li key={c.label}>
                    {link(c.label, target, active, !site)}
                    {c.add &&
                      add(
                        c.add,
                        c.pane!,
                        site ? { siteId: site.id } : {},
                        !site,
                      )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="sidebar-global">
            {link(
              'Global Settings',
              {
                settings: true,
                ...(site
                  ? { siteId: site.id }
                  : workspaceId
                    ? { workspaceId }
                    : {}),
              },
              Boolean(current.settings),
            )}
          </div>
        </nav>
      </div>
    </div>
  );
}
