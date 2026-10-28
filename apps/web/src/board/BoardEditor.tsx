import {
  forwardRef,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  boardDocumentSchema,
  minimumBoardDeviceSize,
  type BoardDocument,
  type BoardElement,
  type BoardRecord,
} from '../../../../packages/shared/src/board.js';
import { api } from '../api.js';
import { BoardCanvas, type BoardSelection } from './BoardCanvas.js';
import { BoardInspector } from './BoardInspector.js';
import { BoardSession } from './session.js';
import { duplicateElement, removeObject } from './commands.js';

export interface BoardEditorHandle {
  flush: () => Promise<void>;
  setLocked: (locked: boolean) => void;
  canTransition: () => boolean;
}
export const BoardEditor = forwardRef<
  BoardEditorHandle,
  {
    board: BoardRecord;
    onImport: () => void;
    onExport: () => void;
    disabled?: boolean;
  }
>(function BoardEditor({ board, onImport, onExport, disabled = false }, ref) {
  const [, redraw] = useState(0);
  const externalLock = useRef(false);
  const [locked, setLockedState] = useState(false);
  const reloadToken = useRef<number | null>(null);
  const reloadSequence = useRef(0);
  const [reloading, setReloading] = useState(false);
  const alive = useRef(true);
  const gestureRef = useRef(false);
  const disabledRef = useRef(disabled);
  const pausedForReload = useRef(false);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  function blocked() {
    return disabled || externalLock.current || reloadToken.current !== null;
  }
  function updateGesture(value: boolean) {
    gestureRef.current = value;
    setGesture(value);
  }

  const [session] = useState(
    () =>
      new BoardSession(
        board.id,
        board,
        async (id, document, rowVersion) =>
          (
            await api<{ board: BoardRecord }>(`/boards/${id}`, 'PATCH', {
              document,
              rowVersion,
            })
          ).board,
        () => redraw((value) => value + 1),
      ),
  );
  const [selection, setSelection] = useState<BoardSelection | null>(null);
  const [tool, setTool] = useState<'select' | 'pan' | 'cable' | 'ports'>(
    'select',
  );
  const [dock, setDock] = useState(false);
  const [types, setTypes] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  const [error, setError] = useState('');
  const [gesture, setGesture] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const document = session.document;
  useImperativeHandle(
    ref,
    () => ({
      flush: () =>
        gestureRef.current || reloadToken.current !== null
          ? Promise.reject(
              new Error('Finish the current board interaction first'),
            )
          : session.flush(),
      setLocked: (value) => {
        externalLock.current = value;
        setLockedState(value);
      },
      canTransition: () => !gestureRef.current && reloadToken.current === null,
    }),
    [session],
  );
  const disposeEditor = useEffectEvent(() => {
    alive.current = false;
    ++reloadSequence.current;
    reloadToken.current = null;
    session.dispose();
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      disposeEditor();
    };
  }, [session]);
  useEffect(() => {
    if (!disabled && !locked && !reloading && pausedForReload.current) {
      pausedForReload.current = false;
      session.resume();
    }
  }, [disabled, locked, reloading, session]);
  useEffect(() => {
    if (!session.dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  });
  function change(next: BoardDocument, label: string) {
    if (blocked()) return;
    try {
      const result = boardDocumentSchema.safeParse(next);
      if (!result.success)
        throw new Error(
          result.error.issues[0]?.message ?? 'Unable to apply change',
        );
      session.update(result.data, label);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to apply change',
      );
    }
  }
  function remove() {
    if (blocked()) return;
    if (!selection) return;
    const portIds = new Set(
      document.ports
        .filter((port) =>
          selection.type === 'element'
            ? port.deviceId === selection.id
            : selection.type === 'port' && port.id === selection.id,
        )
        .map((port) => port.id),
    );
    const connected = document.cables.some(
      (cable) =>
        portIds.has(cable.sourcePortId) || portIds.has(cable.targetPortId),
    );
    if (
      connected &&
      !window.confirm('Delete this object and its attached cables?')
    )
      return;
    change(
      removeObject(document, selection.type, selection.id),
      'Delete object',
    );
    setSelection(null);
  }
  function duplicate() {
    if (blocked()) return;
    if (selection?.type !== 'element') return;
    const next = duplicateElement(document, selection.id);
    change(next, 'Duplicate container');
    setSelection({ type: 'element', id: next.elements.at(-1)!.id });
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (blocked() || gestureRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest('input,textarea,select,[contenteditable=true]') ||
          target.closest('dialog'))
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) session.redo();
        else session.undo();
        setSelection(null);
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'y'
      ) {
        event.preventDefault();
        session.redo();
        setSelection(null);
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'd'
      ) {
        event.preventDefault();
        duplicate();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove();
      } else if (event.key === 'Escape') {
        setSelection(null);
        setTool('select');
        setDock(false);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
  function add(type: 'device' | 'network', deviceType = 'Other') {
    if (blocked()) return;
    const rect = surface.current?.getBoundingClientRect();
    const x =
      ((rect?.width ?? 800) / 2 - document.viewport.x) /
        document.viewport.zoom -
      140;
    const y =
      ((rect?.height ?? 600) / 2 - document.viewport.y) /
        document.viewport.zoom -
      100;
    const element: BoardElement = {
      id: crypto.randomUUID(),
      type,
      name: type === 'network' ? 'Network' : deviceType,
      x: Math.round(x / 8) * 8,
      y: Math.round(y / 8) * 8,
      width: type === 'network' ? 320 : 320,
      height: type === 'network' ? 220 : 160,
      z: Math.max(0, ...document.elements.map((item) => item.z)) + 1,
      color: '#24332b',
      properties:
        type === 'device'
          ? {
              deviceType,
              portSpacing: 8,
              face: 'front',
            }
          : { entries: [] },
    };
    const minimum = minimumBoardDeviceSize(element, []);
    element.width = Math.max(element.width, minimum.width);
    change(
      { ...document, elements: [...document.elements, element] },
      'Add container',
    );
    setSelection({ type: 'element', id: element.id });
    setDock(false);
    setTypes(false);
    setTool('select');
  }
  async function reload() {
    if (blocked() || session.saving || gestureRef.current) return;
    const token = ++reloadSequence.current;
    reloadToken.current = token;
    setReloading(true);
    if (!session.pause()) {
      reloadToken.current = null;
      setReloading(false);
      return;
    }
    pausedForReload.current = true;
    try {
      if (
        session.dirty &&
        !window.confirm('Discard unsaved changes and load the saved board?')
      )
        return;
      const result = await api<{ board: BoardRecord }>(`/boards/${board.id}`);
      if (
        !alive.current ||
        reloadToken.current !== token ||
        disabledRef.current ||
        externalLock.current
      )
        return;
      session.replace(result.board);
      setSelection(null);
      setError('');
    } catch (cause) {
      if (alive.current && reloadToken.current === token)
        setError(cause instanceof Error ? cause.message : 'Unable to reload');
    } finally {
      if (alive.current && reloadToken.current === token) {
        reloadToken.current = null;
        setReloading(false);
        if (!disabledRef.current && !externalLock.current) {
          pausedForReload.current = false;
          session.resume();
        }
      }
    }
  }
  const inactive = disabled || locked || reloading;
  return (
    <section
      className="board-editor"
      aria-label="Board editor"
      ref={surface}
      inert={inactive}
      aria-busy={reloading}
      onClickCapture={(event) => {
        if (blocked()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="board-toolbar" role="toolbar" aria-label="Board tools">
        <button
          className="primary"
          aria-label="Add object"
          aria-expanded={dock}
          onClick={() => setDock(!dock)}
        >
          ＋ Add
        </button>
        <button
          aria-label="Select objects"
          aria-pressed={tool === 'select'}
          onClick={() => setTool('select')}
        >
          ↖
        </button>
        <button
          aria-label="Pan board"
          aria-pressed={tool === 'pan'}
          onClick={() => setTool('pan')}
        >
          ✥
        </button>
        <button
          aria-label="Edit port layout"
          aria-pressed={tool === 'ports'}
          onClick={() => setTool(tool === 'ports' ? 'select' : 'ports')}
        >
          ⠿
        </button>
        <span className="board-tool-divider" />
        <button
          aria-label="Undo"
          disabled={inactive || !session.canUndo || gesture}
          onClick={() => {
            session.undo();
            setSelection(null);
          }}
        >
          ↶
        </button>
        <button
          aria-label="Redo"
          disabled={inactive || !session.canRedo || gesture}
          onClick={() => {
            session.redo();
            setSelection(null);
          }}
        >
          ↷
        </button>
        <button onClick={() => setFitToken((value) => value + 1)}>Fit</button>
        <button
          aria-label="Zoom out"
          onClick={() =>
            change(
              {
                ...document,
                viewport: {
                  ...document.viewport,
                  zoom: Math.max(0.1, document.viewport.zoom / 1.2),
                },
              },
              'Viewport',
            )
          }
        >
          −
        </button>
        <span className="board-zoom">
          {Math.round(document.viewport.zoom * 100)}%
        </span>
        <button
          aria-label="Zoom in"
          onClick={() =>
            change(
              {
                ...document,
                viewport: {
                  ...document.viewport,
                  zoom: Math.min(4, document.viewport.zoom * 1.2),
                },
              },
              'Viewport',
            )
          }
        >
          ＋
        </button>
        <button
          aria-label={document.showCables ? 'Hide cables' : 'Show cables'}
          aria-pressed={document.showCables}
          onClick={() =>
            change({ ...document, showCables: !document.showCables }, 'Display')
          }
        >
          Cables
        </button>
        <details className="board-more">
          <summary aria-label="Board menu">•••</summary>
          <div>
            <button onClick={onExport}>Export JSON</button>
            <button onClick={onImport}>Import JSON</button>
            <button
              onClick={() => {
                if (blocked()) return;
                const snapshot = structuredClone(document);
                void import('./image-export.js')
                  .then(({ downloadBoardImage }) => {
                    if (!disabledRef.current && !externalLock.current)
                      downloadBoardImage(snapshot, board.name);
                  })
                  .catch((cause) => {
                    if (alive.current)
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Unable to export image',
                      );
                  });
              }}
            >
              Export image
            </button>
            <button
              onClick={() =>
                change({ ...document, grid: !document.grid }, 'Display')
              }
            >
              {document.grid ? 'Hide grid' : 'Show grid'}
            </button>
          </div>
        </details>
        <span className="board-save-status" role="status">
          {session.state === 'saving'
            ? 'Saving…'
            : session.state === 'unsaved'
              ? 'Unsaved'
              : session.state === 'error'
                ? 'Not saved'
                : 'Saved'}
        </span>
      </div>
      {(error || session.error) && (
        <div className="board-error" role="alert">
          {error || session.error}
          {session.error && (
            <>
              <button
                disabled={inactive}
                onClick={() => {
                  if (!blocked()) void session.retry().catch(() => {});
                }}
              >
                Retry
              </button>
              <button
                disabled={inactive || session.saving}
                onClick={() => void reload()}
              >
                Load saved board
              </button>
              <button
                disabled={inactive}
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob(
                      [
                        JSON.stringify(
                          {
                            format: 'portfolio-board',
                            schemaVersion: 1,
                            name: board.name + ' recovered draft',
                            document,
                          },
                          null,
                          2,
                        ),
                      ],
                      { type: 'application/json' },
                    ),
                  );
                  const anchor = window.document.createElement('a');
                  anchor.href = url;
                  anchor.download = 'portfolio-unsaved-draft.json';
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Download draft
              </button>
            </>
          )}
        </div>
      )}
      {Array.isArray(document.legacy?.migrationWarnings) &&
        document.legacy.migrationWarnings.length > 0 && (
          <details className="board-migration-notes">
            <summary>Migration notes</summary>
            <ul>
              {document.legacy.migrationWarnings.map((warning, index) => (
                <li key={index}>{String(warning)}</li>
              ))}
            </ul>
          </details>
        )}
      {tool === 'cable' && (
        <div className="board-mode-status" role="status">
          Select two ports{' '}
          <button onClick={() => setTool('select')}>Cancel</button>
        </div>
      )}
      {dock && (
        <div
          className="equipment-dock"
          role="dialog"
          aria-label="Equipment Dock"
        >
          <header>
            Add
            <button
              aria-label="Close Equipment Dock"
              onClick={() => setDock(false)}
            >
              ×
            </button>
          </header>
          {!types ? (
            <>
              <button onClick={() => setTypes(true)}>Device</button>
              <button onClick={() => add('network')}>Network</button>
              <button
                onClick={() => {
                  setTool('cable');
                  setDock(false);
                }}
              >
                Cable
              </button>
            </>
          ) : (
            <>
              {[
                'Router',
                'Switch',
                'Firewall',
                'Wireless Access Point',
                'Server',
                'Other / Custom',
              ].map((type) => (
                <button
                  key={type}
                  onClick={() =>
                    add('device', type === 'Other / Custom' ? 'Custom' : type)
                  }
                >
                  {type}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <BoardCanvas
        document={document}
        selection={selection}
        tool={tool}
        disabled={inactive}
        onChange={change}
        onSelect={setSelection}
        onGestureChange={updateGesture}
        fitToken={fitToken}
      />
      {selection && (
        <BoardInspector
          key={`${selection.type}:${selection.id}`}
          document={document}
          selection={selection}
          onChange={change}
          onClose={() => setSelection(null)}
          onDelete={remove}
          onDuplicate={duplicate}
        />
      )}
    </section>
  );
});
