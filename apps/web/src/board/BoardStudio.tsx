import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  application,
  type User,
} from '../../../../packages/shared/src/index.js';
import {
  boardImportSchema,
  type BoardGroup,
  type BoardRecord,
  type BoardSummary,
} from '../../../../packages/shared/src/board.js';
import { api, sessionRequest } from '../api.js';
import { AuthForm } from '../forms.js';
import { BoardEditor, type BoardEditorHandle } from './BoardEditor.js';
import type { PortClipboard } from './port-clipboard.js';
import './studio.css';

type NameDialog = {
  type: 'new-board' | 'new-group' | 'board' | 'group';
  id?: string;
  name: string;
};
type ImportData = ReturnType<typeof boardImportSchema.parse>;
export function BoardStudio() {
  const [portClipboard, setPortClipboard] = useState<PortClipboard | null>(
    null,
  );
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState(false);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [groups, setGroups] = useState<BoardGroup[]>([]);
  const [active, setActive] = useState<BoardRecord | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [importData, setImportData] = useState<ImportData | null>(null);
  const editor = useRef<BoardEditorHandle>(null);
  const file = useRef<HTMLInputElement>(null);
  const activeRef = useRef<BoardRecord | null>(null);
  const request = useRef(0);
  function updatePortClipboard(value: PortClipboard | null) {
    if (!value || authUser.current) setPortClipboard(value);
  }
  const dragged = useRef<string | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const transition = useRef<number | null>(null);
  const alive = useRef(true);
  const authUser = useRef<User | null>(null);
  function current(token: number) {
    return (
      alive.current && token === request.current && transition.current === token
    );
  }
  function begin(allowAnonymous = false): number | null {
    if (
      !alive.current ||
      transition.current !== null ||
      (!allowAnonymous && !authUser.current)
    )
      return null;
    if (!allowAnonymous && editor.current && !editor.current.canTransition()) {
      setError('Finish the current board interaction first');
      return null;
    }
    const token = ++request.current;
    transition.current = token;
    editor.current?.setLocked(true);
    setBusy(true);
    setError('');
    return token;
  }
  function end(token: number) {
    if (!current(token)) return;
    transition.current = null;
    setBusy(false);
    editor.current?.setLocked(!authUser.current);
  }
  async function index(token: number) {
    const result = await api<{ boards: BoardSummary[]; groups: BoardGroup[] }>(
      '/boards',
    );
    if (!current(token)) return null;
    setBoards(result.boards);
    setGroups(result.groups);
    return result;
  }
  function activate(board: BoardRecord, token: number, push = true) {
    if (!current(token)) return;
    activeRef.current = board;
    setActive(board);
    setEpoch((value) => value + 1);
    setCollapsed(window.innerWidth < 760);
    if (push) window.history.pushState(null, '', `/boards/${board.id}`);
    else window.history.replaceState(null, '', `/boards/${board.id}`);
  }
  async function load(id: string, token: number, push = true) {
    const result = await api<{ board: BoardRecord }>(`/boards/${id}`);
    if (current(token)) activate(result.board, token, push);
  }
  async function run(
    work: (token: number) => Promise<void>,
    message: string,
    rethrow = false,
  ): Promise<boolean> {
    const token = begin();
    if (token === null) {
      if (rethrow)
        throw new Error('Wait for the current board operation to finish');
      return false;
    }
    try {
      await editor.current?.flush();
      if (!current(token)) return false;
      await work(token);
      return current(token);
    } catch (cause) {
      if (current(token)) {
        setError(cause instanceof Error ? cause.message : message);
        if (rethrow) throw cause;
      }
      return false;
    } finally {
      end(token);
    }
  }
  async function open(id: string, push = true) {
    const accepted = await run(
      (token) => load(id, token, push),
      'Unable to open board',
    );
    if (!accepted && !push && alive.current && activeRef.current)
      window.history.replaceState(null, '', `/boards/${activeRef.current.id}`);
  }
  const historyOpen = useEffectEvent((id: string) => {
    void open(id, false);
  });
  const disposeStudio = useEffectEvent(() => {
    alive.current = false;
    ++request.current;
    transition.current = null;
    editor.current?.setLocked(true);
  });
  useEffect(() => {
    alive.current = true;
    const generation = ++request.current;
    let activeEffect = true;
    const valid = () =>
      activeEffect && alive.current && request.current === generation;
    void sessionRequest()
      .then(async (session) => {
        if (!valid()) return;
        authUser.current = session.user;
        setUser(session.user);
        if (!session.user) {
          setPortClipboard(null);
          const result = await api<{ setupRequired: boolean }>(
            '/auth/setup-status',
          );
          if (valid()) setSetup(result.setupRequired);
          return;
        }
        const result = await api<{
          boards: BoardSummary[];
          groups: BoardGroup[];
        }>('/boards');
        if (!valid()) return;
        setBoards(result.boards);
        setGroups(result.groups);
        const route = window.location.pathname.match(
          /^\/(?:boards|sites)\/([^/]+)/,
        )?.[1];
        const target = route ?? result.boards[0]?.id;
        if (target) {
          const loaded = await api<{ board: BoardRecord }>(`/boards/${target}`);
          if (valid()) {
            activeRef.current = loaded.board;
            setActive(loaded.board);
            window.history.replaceState(null, '', `/boards/${target}`);
          }
        }
      })
      .catch((cause) => {
        if (valid())
          setError(
            cause instanceof Error ? cause.message : 'Unable to load PortFolio',
          );
      })
      .finally(() => {
        if (valid()) setLoading(false);
      });
    const unauthorized = () => {
      ++request.current;
      transition.current = null;
      editor.current?.setLocked(true);
      authUser.current = null;
      setPortClipboard(null);
      setUser(null);
      setBusy(false);
      setLoading(false);
      setSetup(false);
      setNameDialog(null);
      setImportData(null);
      setError(
        'Session expired. Sign in to continue. Unsaved changes remain in this window.',
      );
    };
    const history = () => {
      const id = window.location.pathname.match(/^\/boards\/([^/]+)/)?.[1];
      if (id && activeRef.current?.id !== id) historyOpen(id);
    };
    window.addEventListener('portfolio:unauthorized', unauthorized);
    window.addEventListener('popstate', history);
    return () => {
      activeEffect = false;
      disposeStudio();
      window.removeEventListener('portfolio:unauthorized', unauthorized);
      window.removeEventListener('popstate', history);
    };
  }, []);
  async function authenticate(username: string, password: string) {
    const token = begin(true);
    if (token === null)
      throw new Error('Wait for the current request to finish');
    try {
      // Logout and session expiry rotate the cookie; refresh its matching CSRF
      // token before signing in again without reloading the application.
      await sessionRequest();
      if (!current(token)) return;
      const result = await sessionRequest(
        setup ? '/auth/setup' : '/auth/login',
        { username, password },
      );
      if (!current(token)) return;
      authUser.current = result.user;
      setUser(result.user);
      setSetup(false);
      setError('');
      const data = await index(token);
      if (!current(token) || !data) return;
      if (!activeRef.current) {
        const requested = window.location.pathname.match(
          /^\/(?:boards|sites)\/([^/]+)/,
        )?.[1];
        const target =
          data.boards.find((board) => board.id === requested) ?? data.boards[0];
        if (target) await load(target.id, token);
      }
    } finally {
      end(token);
    }
  }
  async function logout() {
    await run(async (token) => {
      await api('/auth/logout', 'POST', {});
      if (!current(token)) return;
      activeRef.current = null;
      setActive(null);
      setBoards([]);
      setGroups([]);
      authUser.current = null;
      setPortClipboard(null);
      setUser(null);
      setNameDialog(null);
      setImportData(null);
      window.history.replaceState(null, '', '/');
    }, 'Unable to sign out');
  }
  async function names(name: string) {
    const item = nameDialog;
    if (!item) return;
    await run(
      async (token) => {
        if (item.type === 'new-board') {
          const result = await api<{ board: BoardRecord }>('/boards', 'POST', {
            name,
          });
          if (!current(token)) return;
          await index(token);
          if (current(token)) activate(result.board, token);
        } else if (item.type === 'new-group') {
          await api('/board-groups', 'POST', { name });
          if (current(token)) await index(token);
        } else if (item.type === 'group') {
          const group = groups.find((group) => group.id === item.id);
          if (!group) throw new Error('This group is unavailable');
          await api(`/board-groups/${group.id}`, 'PATCH', {
            name,
            rowVersion: group.rowVersion,
          });
          if (current(token)) await index(token);
        } else {
          const latest = (
            await api<{ board: BoardRecord }>(`/boards/${item.id}`)
          ).board;
          if (!current(token)) return;
          const result = await api<{ board: BoardRecord }>(
            `/boards/${item.id}`,
            'PATCH',
            { name, rowVersion: latest.rowVersion },
          );
          if (!current(token)) return;
          if (activeRef.current?.id === item.id)
            activate(result.board, token, false);
          await index(token);
        }
        if (current(token)) setNameDialog(null);
      },
      'Unable to save name',
      true,
    );
  }
  async function moveGroup(board: BoardSummary, groupId: string | null) {
    await run(async (token) => {
      const latest = (await api<{ board: BoardRecord }>(`/boards/${board.id}`))
        .board;
      if (!current(token)) return;
      const result = await api<{ board: BoardRecord }>(
        `/boards/${board.id}`,
        'PATCH',
        { groupId, rowVersion: latest.rowVersion },
      );
      if (!current(token)) return;
      if (activeRef.current?.id === board.id)
        activate(result.board, token, false);
      await index(token);
    }, 'Unable to move board');
  }
  async function deleteBoard(board: BoardSummary) {
    if (
      transition.current !== null ||
      !authUser.current ||
      !window.confirm(`Delete board “${board.name}” and everything on it?`)
    )
      return;
    await run(async (token) => {
      const latest = (await api<{ board: BoardRecord }>(`/boards/${board.id}`))
        .board;
      if (!current(token)) return;
      await api(`/boards/${board.id}`, 'DELETE', {
        rowVersion: latest.rowVersion,
      });
      if (!current(token)) return;
      const deletedActive = activeRef.current?.id === board.id;
      if (deletedActive) {
        activeRef.current = null;
        setActive(null);
        window.history.replaceState(null, '', '/');
      }
      const next = await index(token);
      if (current(token) && deletedActive && next?.boards[0])
        await load(next.boards[0].id, token);
    }, 'Unable to delete board');
  }
  async function deleteGroup(group: BoardGroup) {
    if (
      transition.current !== null ||
      !authUser.current ||
      !window.confirm(
        `Delete group “${group.name}”? Its boards will remain available.`,
      )
    )
      return;
    await run(async (token) => {
      await api(`/board-groups/${group.id}`, 'DELETE', {
        rowVersion: group.rowVersion,
      });
      if (!current(token)) return;
      await index(token);
      if (current(token) && activeRef.current)
        await load(activeRef.current.id, token, false);
    }, 'Unable to delete group');
  }
  async function reorder(targetId: string) {
    const source = dragged.current;
    dragged.current = null;
    if (!source || source === targetId) return;
    await run(async (token) => {
      const latest = await api<{
        boards: BoardSummary[];
        groups: BoardGroup[];
      }>('/boards');
      if (!current(token)) return;
      const ordered = [...latest.boards];
      const from = ordered.findIndex((item) => item.id === source),
        to = ordered.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = ordered.splice(from, 1);
      ordered.splice(to, 0, moved!);
      const result = await api<{
        boards: BoardSummary[];
        groups: BoardGroup[];
      }>('/boards/reorder', 'POST', {
        boards: ordered.map(({ id, rowVersion }) => ({ id, rowVersion })),
      });
      if (!current(token)) return;
      setBoards(result.boards);
      setGroups(result.groups);
      if (activeRef.current) await load(activeRef.current.id, token, false);
    }, 'Unable to reorder boards');
  }
  async function duplicate(board: BoardSummary) {
    await run(async (token) => {
      const result = await api<{ board: BoardRecord }>(
        `/boards/${board.id}/duplicate`,
        'POST',
        {},
      );
      if (!current(token)) return;
      await index(token);
      if (current(token)) activate(result.board, token);
    }, 'Unable to duplicate board');
  }
  async function exportJson() {
    const board = activeRef.current;
    if (!board) return;
    await run(async (token) => {
      const archive = await api(`/boards/${board.id}/export`);
      if (!current(token)) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(archive, null, 2)], {
          type: 'application/json',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${board.name.replace(/[^a-z0-9_-]/gi, '-')}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Unable to export board');
  }
  async function importFile(file: File) {
    const generation = request.current;
    try {
      if (file.size > 8 * 1024 * 1024)
        throw new Error('Choose a board file smaller than 8 MiB');
      const value: unknown = JSON.parse(await file.text());
      if (!alive.current || generation !== request.current || !authUser.current)
        return;
      const parsed = boardImportSchema.safeParse(value);
      if (!parsed.success)
        throw new Error('This is not a valid PortFolio board file');
      setImportData(parsed.data);
    } catch (cause) {
      if (alive.current && generation === request.current)
        setError(
          cause instanceof Error ? cause.message : 'Unable to read board file',
        );
    }
  }
  async function importBoard() {
    const data = importData;
    if (!data) return;
    await run(async (token) => {
      const result = await api<{ board: BoardRecord }>(
        '/boards/import',
        'POST',
        data,
      );
      if (!current(token)) return;
      setImportData(null);
      await index(token);
      if (current(token)) activate(result.board, token);
    }, 'Unable to import board');
  }
  function boardRow(board: BoardSummary) {
    return (
      <div
        key={board.id}
        className="board-browser-row"
        draggable={!busy}
        onDragStart={() => {
          dragged.current = board.id;
        }}
        onDragEnd={() => {
          dragged.current = null;
        }}
        onDragOver={(event) => {
          if (dragged.current) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          void reorder(board.id);
        }}
      >
        <button
          className="board-browser-name"
          aria-current={active?.id === board.id ? 'page' : undefined}
          onClick={() => void open(board.id)}
          onDoubleClick={() =>
            setNameDialog({ type: 'board', id: board.id, name: board.name })
          }
        >
          {board.name}
        </button>
        <details
          className="board-browser-actions"
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('button')
            )
              event.currentTarget.removeAttribute('open');
          }}
        >
          <summary aria-label={`Actions for board ${board.name}`}>•••</summary>
          <div>
            <button
              onClick={() =>
                setNameDialog({ type: 'board', id: board.id, name: board.name })
              }
            >
              Rename board
            </button>
            <button onClick={() => void duplicate(board)}>
              Duplicate board
            </button>
            <label>
              Group
              <select
                aria-label={`Group for ${board.name}`}
                value={board.groupId ?? ''}
                onChange={(event) =>
                  void moveGroup(board, event.target.value || null)
                }
              >
                <option value="">No group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="danger" onClick={() => void deleteBoard(board)}>
              Delete board
            </button>
          </div>
        </details>
      </div>
    );
  }
  const visible = boards.filter((board) =>
    board.name.toLowerCase().includes(search.toLowerCase()),
  );
  const auth = (
    <div className="board-auth">
      <div className="board-brand">
        <BrandMark />
        {application.name}
      </div>
      <p>{application.tagline}</p>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">Loading…</p>
      ) : (
        <AuthForm setup={setup} onAuthenticate={authenticate} />
      )}
    </div>
  );
  if ((!user || loading) && !active) return auth;
  return (
    <div className={`board-studio ${collapsed ? 'browser-collapsed' : ''}`}>
      <div
        className="board-studio-layout"
        inert={!user || busy}
        aria-busy={busy}
      >
        <aside className="board-browser" aria-label="Board browser">
          <header>
            <strong className="board-brand">
              <BrandMark />
              PortFolio
            </strong>
            <button
              aria-label="Collapse board browser"
              onClick={() => setCollapsed(true)}
            >
              ‹
            </button>
          </header>
          <input
            type="search"
            aria-label="Find board"
            placeholder="Find board…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="board-browser-heading">
            <span>Boards</span>
            <button
              aria-label="Add board"
              onClick={() => setNameDialog({ type: 'new-board', name: '' })}
            >
              ＋
            </button>
          </div>
          <nav aria-label="Boards">
            {visible.filter((board) => !board.groupId).map(boardRow)}
            {groups.map((group) => (
              <details className="board-group" open key={group.id}>
                <summary>
                  <span>{group.name}</span>
                  <button
                    aria-label={`Rename group ${group.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setNameDialog({
                        type: 'group',
                        id: group.id,
                        name: group.name,
                      });
                    }}
                  >
                    ✎
                  </button>
                  <button
                    aria-label={`Delete group ${group.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      void deleteGroup(group);
                    }}
                  >
                    ×
                  </button>
                </summary>
                <div>
                  {visible
                    .filter((board) => board.groupId === group.id)
                    .map(boardRow)}
                </div>
              </details>
            ))}
          </nav>
          {!boards.length && (
            <p className="board-empty-label">No boards yet.</p>
          )}
          <footer>
            <button
              onClick={() => setNameDialog({ type: 'new-group', name: '' })}
            >
              Add group
            </button>
            <details>
              <summary>Settings</summary>
              <p>
                Backups: <code>pnpm db:backup</code>
              </p>
              <p>
                Restore to a new data directory with{' '}
                <code>pnpm db:restore</code>.
              </p>
            </details>
            <button onClick={() => void logout()}>Sign out</button>
          </footer>
        </aside>
        <main className="board-main">
          <header className="board-appbar">
            <button
              aria-label="Open board browser"
              onClick={() => setCollapsed(!collapsed)}
            >
              ☰
            </button>
            {active && (
              <button
                className="board-title"
                aria-label="Rename current board"
                onDoubleClick={() =>
                  setNameDialog({
                    type: 'board',
                    id: active.id,
                    name: active.name,
                  })
                }
              >
                {active.name}
              </button>
            )}
            <span>{user?.username}</span>
            {collapsed && (
              <button
                aria-label="Add board"
                onClick={() => setNameDialog({ type: 'new-board', name: '' })}
              >
                ＋
              </button>
            )}
          </header>
          {error && user && (
            <div className="board-global-error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {active ? (
            <BoardEditor
              key={`${active.id}:${epoch}`}
              ref={editor}
              board={active}
              disabled={busy || !user}
              clipboard={portClipboard}
              onClipboardChange={updatePortClipboard}
              onImport={() => file.current?.click()}
              onExport={() => void exportJson()}
            />
          ) : (
            <div className="board-empty">
              <p>No board selected.</p>
              <button
                onClick={() => setNameDialog({ type: 'new-board', name: '' })}
              >
                Add board
              </button>
              <button onClick={() => file.current?.click()}>Import JSON</button>
            </div>
          )}
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            aria-label="Import board file"
            hidden
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (picked) void importFile(picked);
              event.target.value = '';
            }}
          />
        </main>
      </div>
      {!user && (
        <div
          className="board-auth-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Sign in"
        >
          {auth}
        </div>
      )}
      {nameDialog && (
        <NameForm
          value={nameDialog}
          onCancel={() => setNameDialog(null)}
          onSave={names}
        />
      )}
      {importData && (
        <ImportPreview
          data={importData}
          disabled={busy}
          onCancel={() => {
            if (!transition.current) setImportData(null);
          }}
          onImport={() => void importBoard()}
        />
      )}
    </div>
  );
}
function NameForm({
  value,
  onCancel,
  onSave,
}: {
  value: NameDialog;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const isBoard = value.type === 'board' || value.type === 'new-board';
  const creating = value.type.startsWith('new');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      await onSave(String(new FormData(event.currentTarget).get('name')));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save');
    } finally {
      setPending(false);
    }
  }
  return (
    <dialog
      className="board-dialog"
      ref={ref}
      aria-label={
        creating
          ? `New ${isBoard ? 'board' : 'group'}`
          : `Rename ${isBoard ? 'board' : 'group'}`
      }
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <h2>
          {creating ? 'New' : 'Rename'} {isBoard ? 'board' : 'group'}
        </h2>
        <label>
          {isBoard ? 'Board name' : 'Group name'}
          <input
            aria-label={isBoard ? 'Board name' : 'Group name'}
            name="name"
            defaultValue={value.name}
            required
            maxLength={240}
            autoFocus
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={pending}>
            {creating ? `Create ${isBoard ? 'board' : 'group'}` : 'Rename'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
function ImportPreview({
  data,
  onCancel,
  onImport,
  disabled,
}: {
  disabled: boolean;
  data: ImportData;
  onCancel: () => void;
  onImport: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="board-dialog"
      aria-label="Import board preview"
      onCancel={(event) => {
        event.preventDefault();
        if (!disabled) onCancel();
      }}
    >
      <h2>{data.name}</h2>
      <p>
        {data.document.elements.length} objects · {data.document.ports.length}{' '}
        ports · {data.document.cables.length} cables
      </p>
      <footer>
        <button disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
        <button disabled={disabled} className="primary" onClick={onImport}>
          Import as new board
        </button>
      </footer>
    </dialog>
  );
}

function BrandMark() {
  return (
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
      <path d="M13 11v4m3-4v4m3-4v4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
