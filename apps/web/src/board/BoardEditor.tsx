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
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import { api } from '../api.js';
import {
  BoardCanvas,
  type BoardSelection,
  type BoardTool,
} from './BoardCanvas.js';
import { BoardInspector } from './BoardInspector.js';
import { MobileSheet } from './MobileSheet.js';
import { VlanSpotlight } from './VlanSpotlight.js';
import { useMobileLayout } from './use-mobile-layout.js';
import { useDismissibleMenus } from './use-dismissible-menus.js';
import { BoardSession } from './session.js';
import { PortContextMenu } from './PortContextMenu.js';
import {
  copyPortSettings,
  copyPortField,
  pastePortSettings,
  portClipboardLabel,
  type PortClipboard,
  type PortSettingKey,
} from './port-clipboard.js';
import type { Point } from './geometry.js';
import { annotationKinds, type AnnotationKind } from './annotations.js';
import { duplicateElement, removeObject } from './commands.js';

export interface BoardEditorHandle {
  flush: () => Promise<void>;
  setLocked: (locked: boolean) => void;
  canTransition: () => boolean;
  dismissOverlays: () => void;
}
export const BoardEditor = forwardRef<
  BoardEditorHandle,
  {
    board: BoardRecord;
    onImport: () => void;
    onExport: () => void;
    disabled?: boolean;
    clipboard: PortClipboard | null;
    onClipboardChange: (clipboard: PortClipboard | null) => void;
  }
>(function BoardEditor(
  { board, onImport, onExport, disabled = false, clipboard, onClipboardChange },
  ref,
) {
  const [, redraw] = useState(0);
  const mobile = useMobileLayout();
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
  const [portMultiSelect, setPortMultiSelect] = useState(false);
  const [inspectPort, setInspectPort] = useState(true);
  const [portMenu, setPortMenu] = useState<{
    portId: string;
    point: Point;
    summary: string;
    touch: boolean;
    previousIds: string[];
  } | null>(null);
  const [clipboardFeedback, setClipboardFeedback] = useState<{
    text: string;
  } | null>(null);
  function selectObject(next: BoardSelection | null, inspect = true) {
    setSelection(next);
    const multipleElements =
      next?.type === 'element' && (next.ids?.length ?? 1) > 1;
    setInspectorOpen(Boolean(next) && inspect && !multipleElements);
    if (next && inspect && mobile) {
      setDock(false);
      setTypes(false);
    }
    setInspectPort(true);
    if (next?.type !== 'port') {
      setPortMultiSelect(false);
      setPortMenu(null);
    }
  }
  function notifyClipboard(text: string) {
    setClipboardFeedback({ text });
  }
  useEffect(() => {
    if (!clipboardFeedback) return;
    const timer = setTimeout(() => setClipboardFeedback(null), 2800);
    return () => clearTimeout(timer);
  }, [clipboardFeedback]);
  useEffect(() => {
    if (!disabled) return;
    const frame = requestAnimationFrame(() => {
      setPortMenu(null);
      setPortMultiSelect(false);
      setClipboardFeedback(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [disabled]);
  const [tool, setTool] = useState<BoardTool>('select');
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [dock, setDock] = useState(false);
  const [types, setTypes] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  const [error, setError] = useState('');
  const exporting = useRef(false);
  const [imageExporting, setImageExporting] = useState(false);
  const [gesture, setGesture] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  useDismissibleMenus(surface);
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
      dismissOverlays: () => {
        setInspectorOpen(false);
        setDock(false);
        setTypes(false);
        setPortMenu(null);
        setClipboardFeedback(null);
      },
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
  function change(next: BoardDocument, label: string): boolean {
    if (blocked()) return false;
    try {
      const result = boardDocumentSchema.safeParse(next);
      if (!result.success)
        throw new Error(
          result.error.issues[0]?.message ?? 'Unable to apply change',
        );
      session.update(result.data, label);
      setError('');
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to apply change',
      );
      return false;
    }
  }
  function closePortMenu(restoreFocus = true) {
    const id = portMenu?.portId;
    setPortMenu(null);
    if (restoreFocus && id && !portMenu?.touch)
      requestAnimationFrame(() =>
        surface.current
          ?.querySelector<HTMLButtonElement>(
            `button[data-port-id="${CSS.escape(id)}"]`,
          )
          ?.focus({ preventScroll: true }),
      );
  }
  function openPortMenu(
    portId: string,
    point: Point,
    summary: string,
    touch: boolean,
  ) {
    if (blocked() || gestureRef.current) return;
    const previousIds =
      selection?.type === 'port' ? (selection.ids ?? [selection.id]) : [];
    const ids = previousIds.includes(portId) ? previousIds : [portId];
    selectObject({ type: 'port', id: portId, ids });
    setInspectPort(false);
    setPortMenu({ portId, point, summary, touch, previousIds });
  }
  function copySettings(portId: string) {
    if (blocked() || gestureRef.current) return;
    try {
      const port = document.ports.find((item) => item.id === portId);
      if (!port) throw new Error('That port is no longer available.');
      onClipboardChange(copyPortSettings(port));
      notifyClipboard('Port settings copied');
      closePortMenu();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to copy port settings',
      );
    }
  }
  function copyField(port: BoardPort, key: PortSettingKey, customKey?: string) {
    if (blocked() || gestureRef.current) return;
    try {
      const payload = copyPortField(port, key, customKey);
      onClipboardChange(payload);
      notifyClipboard(`${portClipboardLabel(payload)} copied`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to copy this field',
      );
    }
  }
  function pasteSettings() {
    if (
      blocked() ||
      gestureRef.current ||
      !clipboard ||
      selection?.type !== 'port'
    )
      return;
    const ids = selection.ids ?? [selection.id];
    try {
      const next = pastePortSettings(document, clipboard, ids);
      if (!change(next, 'Paste port settings')) return;
      const count = new Set(ids).size;
      notifyClipboard(
        clipboard.type === 'port-settings'
          ? `Settings pasted to ${count} ${count === 1 ? 'port' : 'ports'}`
          : `${portClipboardLabel(clipboard)} applied to ${count} ${count === 1 ? 'port' : 'ports'}`,
      );
      closePortMenu();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to paste settings',
      );
    }
  }
  function runHistory(direction: 'undo' | 'redo') {
    session[direction]();
    if (selection?.type === 'port') {
      const ids = (selection.ids ?? [selection.id]).filter((id) =>
        session.document.ports.some((port) => port.id === id),
      );
      selectObject(
        ids.length
          ? {
              type: 'port',
              id: ids.includes(selection.id) ? selection.id : ids[0]!,
              ids,
            }
          : null,
      );
    } else selectObject(null);
  }
  function remove() {
    if (blocked()) return;
    if (!selection) return;
    const ids =
      selection.type === 'element' || selection.type === 'port'
        ? (selection.ids ?? [selection.id])
        : [selection.id];
    const portIds = new Set(
      document.ports
        .filter((port) =>
          selection.type === 'element'
            ? ids.includes(port.deviceId)
            : selection.type === 'port' && ids.includes(port.id),
        )
        .map((port) => port.id),
    );
    const connected = document.cables.some(
      (cable) =>
        portIds.has(cable.sourcePortId) || portIds.has(cable.targetPortId),
    );
    if (
      connected &&
      !window.confirm(
        ids.length > 1
          ? 'Delete the selected objects and their attached cables?'
          : 'Delete this object and its attached cables?',
      )
    )
      return;
    change(
      ids.reduce(
        (current, id) => removeObject(current, selection.type, id),
        document,
      ),
      ids.length > 1 ? 'Delete objects' : 'Delete object',
    );
    selectObject(null);
  }
  function duplicate() {
    if (blocked()) return;
    if (selection?.type !== 'element' || (selection.ids?.length ?? 1) > 1)
      return;
    const next = duplicateElement(document, selection.id);
    change(next, 'Duplicate container');
    selectObject({ type: 'element', id: next.elements.at(-1)!.id });
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (blocked() || gestureRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest('input,textarea,select,[contenteditable]') ||
          target.isContentEditable ||
          target.closest('dialog,.board-summary-content'))
      )
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ['c', 'v'].includes(event.key.toLowerCase())
      ) {
        if (
          selection?.type === 'port' &&
          target instanceof Element &&
          target.closest('.board-canvas') &&
          (tool === 'select' || tool === 'ports')
        ) {
          event.preventDefault();
          if (event.key.toLowerCase() === 'c') copySettings(selection.id);
          else pasteSettings();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        runHistory(event.shiftKey ? 'redo' : 'undo');
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'y'
      ) {
        event.preventDefault();
        runHistory('redo');
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
        selectObject(null);
        setTool('select');
        setDock(false);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
  function add(type: 'device' | 'network' | 'summary', deviceType = 'Other') {
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
      name:
        type === 'summary'
          ? 'Summary'
          : type === 'network'
            ? 'Network'
            : deviceType,
      x: Math.round(x / 8) * 8,
      y: Math.round(y / 8) * 8,
      width: type === 'summary' ? 640 : 320,
      height: type === 'summary' ? 480 : type === 'network' ? 220 : 160,
      z: Math.max(0, ...document.elements.map((item) => item.z)) + 1,
      color: '#24332b',
      properties:
        type === 'device'
          ? {
              deviceType,
              portSpacing: 8,
              face: 'front',
            }
          : type === 'summary'
            ? { linkedDeviceId: '' }
            : { entries: [] },
    };
    const minimum = minimumBoardDeviceSize(element, []);
    element.width = Math.max(element.width, minimum.width);
    change(
      { ...document, elements: [...document.elements, element] },
      'Add container',
    );
    selectObject({ type: 'element', id: element.id });
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
      selectObject(null);
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
  function closeInspector(restoreFocus = false) {
    if (mobile) {
      setInspectorOpen(false);
      if (restoreFocus)
        requestAnimationFrame(() => {
          const target =
            selection?.type === 'port'
              ? surface.current?.querySelector<HTMLButtonElement>(
                  `button[data-port-id="${CSS.escape(selection.id)}"]`,
                )
              : surface.current?.querySelector<HTMLButtonElement>(
                  '.board-touch-actions button[aria-label^="Configure "]',
                );
          (
            target ??
            surface.current?.querySelector<HTMLElement>('.board-canvas')
          )?.focus({ preventScroll: true });
        });
    } else selectObject(null);
  }
  const inspectorContent = selection &&
    !(selection.type === 'element' && (selection.ids?.length ?? 1) > 1) &&
    !(
      selection.type === 'port' &&
      (portMenu ||
        !inspectPort ||
        portMultiSelect ||
        (selection.ids?.length ?? 1) > 1)
    ) && (
      <BoardInspector
        key={`${selection.type}:${selection.id}`}
        document={document}
        selection={selection}
        onChange={change}
        onClose={closeInspector}
        onDelete={remove}
        onDuplicate={duplicate}
        onCopyPortField={copyField}
      />
    );
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
          onClick={() => {
            if (!dock) {
              if (mobile) setInspectorOpen(false);
              setPortMenu(null);
              setTypes(false);
            }
            setDock(!dock);
          }}
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
            runHistory('undo');
          }}
        >
          ↶
        </button>
        <button
          aria-label="Redo"
          disabled={inactive || !session.canRedo || gesture}
          onClick={() => {
            runHistory('redo');
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
          className="board-cables-toggle"
          title={document.showCables ? 'Hide cables' : 'Show cables'}
          aria-label={document.showCables ? 'Hide cables' : 'Show cables'}
          aria-pressed={document.showCables}
          onClick={() =>
            change({ ...document, showCables: !document.showCables }, 'Display')
          }
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M7 3v4m-3 0h6v4a3 3 0 0 1-6 0V7Zm13 14v4m-3-8h6v4a3 3 0 0 1-6 0v-4ZM7 14v2a3 3 0 0 0 3 3h1a3 3 0 0 0 3-3v-2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Cables</span>
        </button>
        <VlanSpotlight
          value={spotlight}
          onChange={setSpotlight}
          disabled={inactive}
        />
        <details className="board-more">
          <summary aria-label="Board menu">•••</summary>
          <div>
            <button onClick={onExport}>Export JSON</button>
            <button onClick={onImport}>Import JSON</button>
            <button
              disabled={imageExporting}
              onClick={() => {
                if (blocked() || exporting.current) return;
                exporting.current = true;
                setImageExporting(true);
                const snapshot = structuredClone(document);
                const name = board.name;
                void import('./image-export.js')
                  .then(({ downloadBoardImage }) =>
                    downloadBoardImage(
                      snapshot,
                      name,
                      () =>
                        alive.current &&
                        !disabledRef.current &&
                        !externalLock.current,
                    ),
                  )
                  .catch((cause) => {
                    if (alive.current)
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Unable to export image',
                      );
                  })
                  .finally(() => {
                    exporting.current = false;
                    if (alive.current) setImageExporting(false);
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
      {(annotationKinds as readonly string[]).includes(tool) && (
        <div className="board-mode-status" role="status">
          Place {tool === 'highlight' ? 'highlight region' : tool}
          <button onClick={() => setTool('select')}>Cancel</button>
        </div>
      )}
      {tool === 'cable' && (
        <div className="board-mode-status" role="status">
          Select two ports{' '}
          <button onClick={() => setTool('select')}>Cancel</button>
        </div>
      )}
      {mobile && dock && (
        <button
          className="board-dock-backdrop"
          aria-label="Dismiss Equipment Dock"
          onClick={() => setDock(false)}
        />
      )}
      {dock && (
        <div
          className="equipment-dock"
          role="dialog"
          aria-label="Equipment Dock"
        >
          <header>
            {types ? (
              <button
                aria-label="Back to equipment types"
                onClick={() => setTypes(false)}
              >
                ‹ Back
              </button>
            ) : (
              'Add'
            )}
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
              <button onClick={() => add('summary')}>Summary</button>
              <div className="board-dock-annotations" aria-label="Annotations">
                <span>Annotations</span>
                {(
                  [
                    ['text', 'T', 'Text'],
                    ['arrow', '↗', 'Arrow'],
                    ['rectangle', '▭', 'Rectangle'],
                    ['highlight', '▧', 'Highlight Region'],
                  ] as [AnnotationKind, string, string][]
                ).map(([kind, icon, label]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      if (blocked()) return;
                      setTool(kind);
                      setInspectorOpen(false);
                      setDock(false);
                      requestAnimationFrame(() =>
                        surface.current
                          ?.querySelector<HTMLElement>('.board-canvas')
                          ?.focus({ preventScroll: true }),
                      );
                    }}
                  >
                    <span aria-hidden="true">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
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
        spotlight={spotlight}
        selection={selection}
        tool={tool}
        disabled={inactive}
        onChange={change}
        onSelect={selectObject}
        portMultiSelect={portMultiSelect}
        portMenuOpen={Boolean(portMenu)}
        onPortContextMenu={openPortMenu}
        onGestureChange={updateGesture}
        fitToken={fitToken}
        onToolComplete={() => setTool('select')}
      />
      {inspectorOpen &&
        (!mobile || !gesture) &&
        (!mobile || !inactive) &&
        (!mobile || !dock) &&
        inspectorContent &&
        (mobile ? (
          <MobileSheet label="Object inspector" onClose={closeInspector}>
            {inspectorContent}
          </MobileSheet>
        ) : (
          inspectorContent
        ))}
      {!inactive &&
        selection?.type === 'port' &&
        (portMultiSelect || (selection.ids?.length ?? 1) > 1) && (
          <div className="board-port-selection-status" role="status">
            {selection.ids?.length ?? 1}{' '}
            {(selection.ids?.length ?? 1) === 1
              ? 'port selected'
              : 'ports selected'}
          </div>
        )}
      {!inactive && clipboardFeedback && (
        <div className="board-clipboard-notice" role="status">
          {clipboardFeedback.text}
        </div>
      )}
      {!inactive &&
        portMenu &&
        (() => {
          const port = document.ports.find(
            (item) => item.id === portMenu.portId,
          );
          if (!port) return null;
          const selectedIds =
            selection?.type === 'port' ? (selection.ids ?? [selection.id]) : [];
          const wasSelected = portMenu.previousIds.includes(port.id);
          const toggleSelection = () => {
            const ids = wasSelected
              ? portMenu.previousIds.filter((id) => id !== port.id)
              : [...new Set([...portMenu.previousIds, port.id])];
            setPortMultiSelect(true);
            selectObject(
              ids.length
                ? {
                    type: 'port',
                    id: ids.includes(port.id) ? port.id : ids.at(-1)!,
                    ids,
                  }
                : null,
            );
            closePortMenu();
          };
          return (
            <PortContextMenu
              point={portMenu.point}
              portId={port.id}
              title={`${document.elements.find((item) => item.id === port.deviceId)?.name ?? 'Device'} / ${port.name}`}
              summary={portMenu.summary}
              overwriteHint={clipboard?.type === 'port-settings'}
              onClose={closePortMenu}
              actions={[
                {
                  label: 'Copy Port Settings',
                  run: () => copySettings(port.id),
                },
                {
                  label: 'Paste Settings',
                  disabled: !clipboard || !selectedIds.length,
                  run: pasteSettings,
                },
                {
                  label: portMultiSelect
                    ? 'Finish Selecting'
                    : 'Select Multiple Ports',
                  run: () => {
                    setPortMultiSelect(!portMultiSelect);
                    closePortMenu();
                  },
                },
                ...(wasSelected || portMenu.previousIds.length
                  ? [
                      {
                        label: wasSelected
                          ? 'Remove from Selection'
                          : 'Add to Selection',
                        run: toggleSelection,
                      },
                    ]
                  : []),
              ]}
            />
          );
        })()}
    </section>
  );
});
