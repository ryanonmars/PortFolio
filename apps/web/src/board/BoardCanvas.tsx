import {
  memo,
  useMemo,
  useId,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import {
  resolveBoardPortColor,
  boardPortCapacity,
  maxBoardPortColumn,
  maxBoardPortRow,
  type BoardDocument,
  BoardElement,
  BoardPort,
  BoardViewport,
} from '../../../../packages/shared/src/board.js';
import { PortHoverTooltip } from './PortHoverTooltip.js';
import { DeviceSummary } from './DeviceSummary.js';
import { NetworkSummary } from './NetworkSummary.js';
import { DeviceHeader } from './DeviceHeader.js';
import { deviceHeaderFields } from './device-header-fields.js';
import { makeBoardPort } from './commands.js';
import { Connector } from '../visual/Connector.js';
import {
  activeFace,
  cableCurve,
  cableHitPath,
  clamp,
  DEVICE_HEADER,
  DEVICE_PADDING,
  fitViewport,
  getPortPoint,
  minimumDeviceSize,
  PORT_HEIGHT,
  PORT_WIDTH,
  portGap,
  portRect,
  resizeRect,
  screenToWorld,
  snapRect,
  zoomViewport,
  type Guide,
  type Point,
} from './geometry.js';
import { enclosedElementIds, marqueeRect, moveSelection } from './selection.js';
import type { Rect } from './geometry.js';
import { portSelectionRange } from './port-clipboard.js';
import './canvas.css';
export { fitViewport, getPortPoint, minimumDeviceSize } from './geometry.js';
export type BoardSelection = {
  type: 'element' | 'port' | 'cable';
  id: string;
  ids?: string[];
};
export interface BoardCanvasProps {
  document: BoardDocument;
  selection: BoardSelection | null;
  tool: 'select' | 'pan' | 'cable' | 'ports';
  disabled: boolean;
  onChange: (document: BoardDocument, label: string) => void;
  onSelect: (selection: BoardSelection | null, inspect?: boolean) => void;
  onGestureChange?: (active: boolean) => void;
  fitToken?: number;
  portMultiSelect?: boolean;
  portMenuOpen?: boolean;
  onPortContextMenu?: (
    portId: string,
    point: Point,
    summary: string,
    touch: boolean,
  ) => void;
}
type Gesture = {
  type: 'pan' | 'move' | 'resize' | 'port' | 'marquee';
  ids?: string[];
  selection?: BoardSelection | null;
  additive?: boolean;
  modified?: boolean;
  renameOnClick?: Rename;
  pointer: number;
  start: Point;
  base: BoardDocument;
  id?: string;
  handle?: string;
  moved: boolean;
};
type Rename = { type: 'element' | 'port'; id: string; value: string };
const MemoConnector = memo(Connector);
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function portSummary(port: BoardPort) {
  return [
    port.name,
    port.role,
    {
      rj45: 'RJ45',
      sfp: 'SFP',
      sfp_plus: 'SFP+',
      qsfp: 'QSFP',
      other: 'Custom',
    }[port.kind],
    port.speed,
    port.linkState ? `Documented ${port.linkState}` : '',
    port.pvid ? `PVID ${port.pvid}` : '',
    port.address,
    port.nativeVlan ? `Native VLAN ${port.nativeVlan}` : '',
    port.taggedVlans.length ? `Tagged ${port.taggedVlans.join(', ')}` : '',
    port.externalDestination,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function BoardCanvas(props: BoardCanvasProps) {
  const {
    document,
    selection,
    tool,
    disabled,
    onChange,
    onSelect,
    onGestureChange,
    fitToken,
    portMultiSelect = false,
    portMenuOpen = false,
    onPortContextMenu,
  } = props;
  const root = useRef<HTMLDivElement>(null);
  const portAnchor = useRef<string | null>(null);
  const latest = useRef(props);
  const gesture = useRef<Gesture | null>(null);
  const summaryScroll = useRef<{
    pointer: number;
    y: number;
    top: number;
    element: HTMLElement;
  } | null>(null);
  const previewRef = useRef<BoardDocument | null>(null);
  const [preview, setPreview] = useState<BoardDocument | null>(null);
  const [moving, setMoving] = useState(false);
  const [touchControls, setTouchControls] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const selectedIds =
    selection?.type === 'element' ? (selection.ids ?? [selection.id]) : [];
  function selectIds(ids: string[], inspect = true) {
    onSelect(
      ids.length ? { type: 'element', id: ids[0]!, ids } : null,
      inspect,
    );
  }
  function chooseElement(
    id: string,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
    preserve = false,
    inspect = true,
  ) {
    if (event.metaKey || event.ctrlKey) {
      const ids = selectedIds.includes(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id];
      selectIds(ids, inspect);
      return ids;
    }
    const ids =
      event.shiftKey || (preserve && selectedIds.includes(id))
        ? [...new Set([...selectedIds, id])]
        : [id];
    selectIds(ids, inspect);
    return ids;
  }
  const [guides, setGuides] = useState<Guide[]>([]);
  const [notice, setNotice] = useState('');
  const [rename, setRename] = useState<Rename | null>(null);
  const [sourcePort, setSourcePort] = useState<string | null>(null);
  const [hoverPort, setHoverPort] = useState<string | null>(null);
  const [touchSummary, setTouchSummary] = useState<string | null>(null);
  const summaryId = useId();
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryInside = useRef(false);
  const dismissedSummary = useRef<string | null>(null);
  function cancelSummaryDismiss() {
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    summaryTimer.current = null;
  }
  function dismissSummary(restoreFocus = false) {
    cancelSummaryDismiss();
    summaryInside.current = false;
    dismissedSummary.current = restoreFocus
      ? (hoverPort ?? touchSummary)
      : null;
    setHoverPort(null);
    setTouchSummary(null);
    if (restoreFocus && dismissedSummary.current)
      root.current
        ?.querySelector<HTMLButtonElement>(
          `button[data-port-id="${CSS.escape(dismissedSummary.current)}"]`,
        )
        ?.focus({ preventScroll: true });
  }
  function scheduleSummaryDismiss(id: string) {
    cancelSummaryDismiss();
    summaryTimer.current = setTimeout(() => {
      const panel = globalThis.document.getElementById(summaryId);
      const trigger = root.current?.querySelector<HTMLButtonElement>(
        `button[data-port-id="${CSS.escape(id)}"]`,
      );
      if (
        summaryInside.current ||
        panel?.contains(globalThis.document.activeElement) ||
        trigger?.matches(':focus-visible')
      )
        return;
      setHoverPort((current) => (current === id ? null : current));
      setTouchSummary((current) => (current === id ? null : current));
    }, 180);
  }
  useEffect(
    () => () => {
      if (summaryTimer.current) clearTimeout(summaryTimer.current);
    },
    [],
  );
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = useRef<{ pointer: number; portId: string; start: Point } | null>(
    null,
  );
  const suppressHoldClick = useRef<string | null>(null);
  const lastPointerType = useRef('keyboard');
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{
    distance: number;
    viewport: BoardViewport;
    center: Point;
  } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelViewport = useRef<BoardViewport | null>(null);
  const lastFit = useRef(fitToken);
  const suppressClickUntil = useRef(0);
  function cancelSummaryScroll() {
    const active = summaryScroll.current;
    summaryScroll.current = null;
    if (active?.element.hasPointerCapture(active.pointer))
      active.element.releasePointerCapture(active.pointer);
  }
  function cancelHold() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    hold.current = null;
  }
  function startHold(
    event: ReactPointerEvent<HTMLButtonElement>,
    port: BoardPort,
  ) {
    if (event.pointerType !== 'touch' || tool !== 'select' || disabled) return;
    cancelHold();
    hold.current = {
      pointer: event.pointerId,
      portId: port.id,
      start: { x: event.clientX, y: event.clientY },
    };
    holdTimer.current = setTimeout(() => {
      const candidate = hold.current;
      if (
        !candidate ||
        latest.current.disabled ||
        latest.current.tool !== 'select' ||
        pointers.current.size !== 1 ||
        gesture.current ||
        pinch.current
      )
        return;
      suppressHoldClick.current = candidate.portId;
      portAnchor.current = candidate.portId;
      if (latest.current.onPortContextMenu) {
        latest.current.onPortContextMenu(
          candidate.portId,
          candidate.start,
          summaryFor(port),
          true,
        );
        setTouchSummary(null);
      } else setTouchSummary(candidate.portId);
      setHoverPort(null);
      holdTimer.current = null;
    }, 450);
  }
  useEffect(() => {
    const keyboard = () => {
      lastPointerType.current = 'keyboard';
    };
    window.addEventListener('keydown', keyboard, true);
    return () => {
      window.removeEventListener('keydown', keyboard, true);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      hold.current = null;
    };
  }, []);
  useEffect(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    hold.current = null;
    suppressHoldClick.current = null;
    const frame = requestAnimationFrame(() => {
      setTouchSummary(null);
      setHoverPort(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [tool, disabled]);
  useEffect(() => {
    latest.current = props;
  }, [props]);
  function showPreview(next: BoardDocument | null) {
    if (!next) setMoving(false);
    previewRef.current = next;
    setPreview(next);
  }
  function local(event: { clientX: number; clientY: number }): Point {
    const box = root.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }
  function finishViewport() {
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = null;
    const next = wheelViewport.current;
    wheelViewport.current = null;
    if (next) {
      latest.current.onChange(
        { ...latest.current.document, viewport: next },
        'Viewport',
      );
      previewRef.current = null;
      setPreview(null);
      setMoving(false);
      latest.current.onGestureChange?.(false);
    }
  }
  function cancelGesture() {
    cancelHold();
    cancelSummaryScroll();
    setTouchSummary(null);
    if (gesture.current?.type === 'marquee')
      onSelect(gesture.current.selection ?? null);
    const captures = new Set(pointers.current.keys());
    if (gesture.current) captures.add(gesture.current.pointer);
    gesture.current = null;
    pinch.current = null;
    for (const pointer of captures)
      if (root.current?.hasPointerCapture(pointer))
        root.current.releasePointerCapture(pointer);
    setMarquee(null);
    pointers.current.clear();
    showPreview(null);
    setGuides([]);
    onGestureChange?.(false);
  }
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      const current = latest.current;
      if (current.disabled || gesture.current || pinch.current) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input,textarea,select,[contenteditable="true"],[popover],.board-summary-content',
        )
      )
        return;
      event.preventDefault();
      setHoverPort(null);
      setTouchSummary(null);
      const box = element!.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const old = wheelViewport.current ?? current.document.viewport;
      const next =
        event.ctrlKey || event.metaKey
          ? zoomViewport(old, point, old.zoom * Math.exp(-event.deltaY * 0.008))
          : {
              ...old,
              x: clamp(old.x - event.deltaX, -100000, 100000),
              y: clamp(old.y - event.deltaY, -100000, 100000),
            };
      wheelViewport.current = next;
      previewRef.current = { ...current.document, viewport: next };
      setPreview(previewRef.current);
      current.onGestureChange?.(true);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        const viewport = wheelViewport.current;
        wheelViewport.current = null;
        wheelTimer.current = null;
        if (viewport)
          latest.current.onChange(
            { ...latest.current.document, viewport },
            'Viewport',
          );
        previewRef.current = null;
        setPreview(null);
        setMoving(false);
        latest.current.onGestureChange?.(false);
      }, 180);
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      latest.current.onGestureChange?.(false);
    };
  }, []);
  useEffect(() => {
    if (fitToken === undefined || fitToken === lastFit.current) return;
    lastFit.current = fitToken;
    const element = root.current;
    if (!element) return;
    onChange(
      {
        ...document,
        viewport: fitViewport(
          document,
          element.clientWidth,
          element.clientHeight,
        ),
      },
      'Viewport',
    );
  }, [fitToken, document, onChange]);
  useEffect(() => {
    const active = gesture.current;
    if (active || pinch.current || summaryScroll.current) {
      cancelSummaryScroll();
      if (active?.type === 'marquee')
        latest.current.onSelect(active.selection ?? null);
      gesture.current = null;
      for (const pointer of new Set([
        ...pointers.current.keys(),
        ...(active ? [active.pointer] : []),
      ]))
        if (root.current?.hasPointerCapture(pointer))
          root.current.releasePointerCapture(pointer);
      pinch.current = null;
      pointers.current.clear();
      previewRef.current = null;
      latest.current.onGestureChange?.(false);
    }
    const reset = requestAnimationFrame(() => {
      setPreview(null);
      setMoving(false);
      setMarquee(null);
      setGuides([]);
    });
    if (tool === 'cable') return () => cancelAnimationFrame(reset);
    const frame = requestAnimationFrame(() => {
      setSourcePort(null);
      setNotice('');
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(reset);
    };
  }, [tool]);
  useEffect(() => {
    if (!disabled) return;
    const frame = requestAnimationFrame(() => {
      const active = gesture.current;
      cancelSummaryScroll();
      if (active?.type === 'marquee')
        latest.current.onSelect(active.selection ?? null);
      gesture.current = null;
      pinch.current = null;
      for (const pointer of new Set([
        ...pointers.current.keys(),
        ...(active ? [active.pointer] : []),
      ]))
        if (root.current?.hasPointerCapture(pointer))
          root.current.releasePointerCapture(pointer);
      pointers.current.clear();
      previewRef.current = null;
      setPreview(null);
      setMoving(false);
      setMarquee(null);
      setGuides([]);
      latest.current.onGestureChange?.(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [disabled]);
  useEffect(() => {
    if (rename) latest.current.onGestureChange?.(true);
    else if (!gesture.current && !pinch.current && !wheelViewport.current)
      latest.current.onGestureChange?.(false);
  }, [rename]);
  const visible = preview ?? document;
  const viewport = visible.viewport;
  const touchElement =
    touchControls && selection?.type === 'element'
      ? visible.elements.find((element) => element.id === selection.id)
      : undefined;
  const lookups = useMemo(() => {
    const ports = new Map(visible.ports.map((port) => [port.id, port]));
    const elements = new Map(
      visible.elements.map((element) => [element.id, element]),
    );
    const peers = new Map<string, string>();
    for (const cable of visible.cables) {
      peers.set(cable.sourcePortId, cable.targetPortId);
      peers.set(cable.targetPortId, cable.sourcePortId);
    }
    return { ports, elements, peers };
  }, [visible.ports, visible.elements, visible.cables]);
  function summaryFor(port: BoardPort) {
    const peer = lookups.ports.get(lookups.peers.get(port.id) ?? '');
    return (
      portSummary(port) +
      (peer
        ? ` · Connected: ${lookups.elements.get(peer.deviceId)?.name ?? 'Device'} / ${peer.name}`
        : '')
    );
  }

  const summaryPort =
    !disabled && !preview && !rename && !portMenuOpen && tool === 'select'
      ? visible.ports.find((port) => port.id === (touchSummary ?? hoverPort))
      : undefined;
  useEffect(() => {
    summaryInside.current = false;
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    summaryTimer.current = null;
  }, [summaryPort?.id]);
  function begin(
    event: ReactPointerEvent<HTMLElement>,
    type: Gesture['type'],
    id?: string,
    handle?: string,
    renameOnClick?: Rename,
  ) {
    if (disabled || (event.button !== 0 && event.button !== 1)) return;
    if (
      event.target instanceof Element &&
      event.target.closest('input,textarea,select,.board-summary-content')
    )
      return;
    const base = wheelViewport.current
      ? { ...latest.current.document, viewport: wheelViewport.current }
      : latest.current.document;
    finishViewport();
    event.preventDefault();
    event.stopPropagation();
    root.current?.focus({ preventScroll: true });
    root.current?.setPointerCapture(event.pointerId);
    let ids: string[] | undefined;
    if (type === 'move') {
      // A title click edits directly. Opening the mobile inspector here can
      // cover the title before a second click or its editor receives focus.
      const directTitle =
        renameOnClick && !event.shiftKey && !event.metaKey && !event.ctrlKey;
      ids = directTitle
        ? selectedIds.includes(id!)
          ? selectedIds
          : [id!]
        : chooseElement(
            id!,
            event,
            true,
            event.pointerType !== 'touch' &&
              !event.currentTarget.closest('.board-touch-actions'),
          );
      suppressClickUntil.current = event.timeStamp + 500;
    }
    gesture.current = {
      type,
      ids,
      selection,
      additive: event.shiftKey,
      modified: event.shiftKey || event.metaKey || event.ctrlKey,
      renameOnClick,
      pointer: event.pointerId,
      start: local(event),
      base,
      id,
      handle,
      moved: false,
    };
    if (type === 'resize')
      onSelect({ type: 'element', id: id! }, event.pointerType !== 'touch');
    if (type === 'port')
      onSelect({ type: 'port', id: id! }, event.pointerType !== 'touch');
    onGestureChange?.(true);
  }
  function capturePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.target instanceof Element &&
      event.target.closest('.board-port-tooltip')
    )
      return;
    suppressClickUntil.current = 0;
    lastPointerType.current = event.pointerType;
    if (!(
      event.target instanceof Element &&
      event.target.closest('.board-touch-actions')
    ))
      setTouchControls(event.pointerType === 'touch');
    cancelHold();
    suppressHoldClick.current = null;
    setTouchSummary(null);
    dismissSummary();
    if (
      event.pointerType === 'touch' &&
      pointers.current.size === 0 &&
      !disabled &&
      tool === 'select'
    ) {
      const target = event.target instanceof Element ? event.target : null;
      const container = target?.closest<HTMLElement>('[data-board-element-id]');
      // Reading a container is selection only on touch. Ports and authored
      // controls keep their own tap/long-press gestures.
      if (
        container &&
        !target?.closest(
          'button,input,textarea,select,[contenteditable="true"],[popover],.board-port,.board-resize-handle',
        )
      )
        chooseElement(container.dataset.boardElementId!, event, true, false);
    }
    if (
      disabled ||
      (event.target instanceof Element &&
        event.target.closest('input,textarea,select'))
    )
      return;
    const point = local(event);
    // This map represents simultaneous fingers only. Mouse context menus can
    // retarget pointerup outside the canvas and must never count as a finger.
    if (event.pointerType === 'touch')
      pointers.current.set(event.pointerId, point);
    if (event.pointerType === 'touch' && pointers.current.size === 2) {
      event.preventDefault();
      // Summary reading owns one-finger scrolling; a second finger yields
      // both pointers to canvas navigation instead of retaining its capture.
      summaryScroll.current = null;
      for (const pointer of pointers.current.keys())
        root.current?.setPointerCapture(pointer);
      const [a, b] = [...pointers.current.values()];
      gesture.current = null;
      suppressClickUntil.current = event.timeStamp + 500;
      setMoving(false);
      // A second finger promotes the gesture to navigation. Discard any
      // uncommitted container move while preserving the current viewport.
      showPreview({ ...document, viewport: visible.viewport });
      pinch.current = {
        distance: Math.hypot(b!.x - a!.x, b!.y - a!.y),
        viewport: visible.viewport,
        center: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
      };
      onGestureChange?.(true);
      event.stopPropagation();
      return;
    }
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      disabled ||
      (event.target instanceof Element &&
        event.target.closest('input,textarea,select,.board-summary-content'))
    )
      return;
    const background =
      event.target === event.currentTarget ||
      (event.target instanceof Element &&
        Boolean(event.target.closest('[data-board-background]')));
    if (
      tool === 'pan' ||
      root.current?.classList.contains('space-pan') ||
      event.button === 1
    ) {
      begin(event, 'pan');
      return;
    }
    if (background && event.button === 0) {
      if (event.pointerType === 'touch') {
        onSelect(null);
        begin(event, 'pan');
      } else if (tool === 'select') begin(event, 'marquee');
      else onSelect(null);
    }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const candidate = hold.current;
    if (
      candidate &&
      candidate.pointer === event.pointerId &&
      Math.hypot(
        event.clientX - candidate.start.x,
        event.clientY - candidate.start.y,
      ) > 8
    ) {
      suppressHoldClick.current = candidate.portId;
      cancelHold();
      setTouchSummary(null);
    }
    const point = local(event);
    if (pointers.current.has(event.pointerId))
      pointers.current.set(event.pointerId, point);
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(b!.x - a!.x, b!.y - a!.y);
      const center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      const zoomed = zoomViewport(
        pinch.current.viewport,
        pinch.current.center,
        (pinch.current.viewport.zoom * distance) /
          Math.max(1, pinch.current.distance),
      );
      showPreview({
        ...document,
        viewport: {
          ...zoomed,
          x: clamp(
            zoomed.x + center.x - pinch.current.center.x,
            -100000,
            100000,
          ),
          y: clamp(
            zoomed.y + center.y - pinch.current.center.y,
            -100000,
            100000,
          ),
        },
      });
      return;
    }
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    const dx = (point.x - active.start.x) / active.base.viewport.zoom,
      dy = (point.y - active.start.y) / active.base.viewport.zoom;
    if (
      Math.hypot(point.x - active.start.x, point.y - active.start.y) < 4 &&
      !active.moved
    )
      return;
    active.moved = true;
    suppressClickUntil.current = event.timeStamp + 500;
    if (active.type === 'marquee') {
      const rect = marqueeRect(
        screenToWorld(active.start, active.base.viewport),
        screenToWorld(point, active.base.viewport),
      );
      setMarquee(rect);
      const previous =
        active.additive && active.selection?.type === 'element'
          ? (active.selection.ids ?? [active.selection.id])
          : [];
      selectIds([
        ...new Set([
          ...previous,
          ...enclosedElementIds(active.base.elements, rect),
        ]),
      ]);
      return;
    }
    if (active.type === 'move') {
      if (active.renameOnClick && !active.modified && !previewRef.current)
        selectIds(active.ids ?? []);
      setMoving(true);
      const result = moveSelection(
        active.base,
        active.ids ?? [],
        { x: dx, y: dy },
        event.altKey,
      );
      showPreview(result.document);
      setGuides(result.guides);
      return;
    }
    if (active.type === 'pan') {
      showPreview({
        ...active.base,
        viewport: {
          ...active.base.viewport,
          x: clamp(
            active.base.viewport.x + point.x - active.start.x,
            -100000,
            100000,
          ),
          y: clamp(
            active.base.viewport.y + point.y - active.start.y,
            -100000,
            100000,
          ),
        },
      });
      return;
    }
    if (active.type === 'resize') {
      const element = active.base.elements.find(
        (item) => item.id === active.id,
      );
      if (!element) return;
      let next: BoardElement;
      {
        const minimum = minimumDeviceSize(element, active.base.ports),
          handle = active.handle!;
        const rect = resizeRect(
          element,
          handle,
          { x: dx, y: dy },
          minimum,
          true,
        );
        const edge = {
          x: handle.includes('w') ? rect.x : rect.x + rect.width,
          y: handle.includes('n') ? rect.y : rect.y + rect.height,
          width: 0,
          height: 0,
        };
        const snap = snapRect(
          edge,
          active.base.elements.filter((item) => item.id !== element.id),
          active.base.viewport.zoom,
          event.altKey,
        );
        let left = rect.x,
          top = rect.y,
          right = rect.x + rect.width,
          bottom = rect.y + rect.height;
        if (handle.includes('w'))
          left = Math.min(right - minimum.width, snap.rect.x);
        if (handle.includes('e'))
          right = Math.max(left + minimum.width, snap.rect.x);
        if (handle.includes('n'))
          top = Math.min(bottom - minimum.height, snap.rect.y);
        if (handle.includes('s'))
          bottom = Math.max(top + minimum.height, snap.rect.y);
        next = {
          ...element,
          x: left,
          y: top,
          width: Math.min(20000, right - left),
          height: Math.min(20000, bottom - top),
        };
        setGuides(
          snap.guides.filter((guide) =>
            guide.axis === 'x'
              ? handle.includes('e') || handle.includes('w')
              : handle.includes('n') || handle.includes('s'),
          ),
        );
      }
      showPreview({
        ...active.base,
        elements: active.base.elements.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
      return;
    }
    const port = active.base.ports.find((item) => item.id === active.id);
    const element = active.base.elements.find(
      (item) => item.id === port?.deviceId,
    );
    if (!port || !element) return;
    const gap = portGap(element);
    const column = clamp(
      Math.round(port.column + dx / (PORT_WIDTH + gap)),
      0,
      maxBoardPortColumn,
    );
    const row = clamp(
      Math.round(port.row + dy / (PORT_HEIGHT + gap)),
      0,
      maxBoardPortRow,
    );
    const occupied = active.base.ports.some(
      (item) =>
        item.id !== port.id &&
        item.deviceId === port.deviceId &&
        item.face === port.face &&
        item.row === row &&
        item.column === column,
    );
    const rect = portRect(element, { row, column });
    const fits =
      rect.x + rect.width <= element.x + element.width - DEVICE_PADDING &&
      rect.y + rect.height <= element.y + element.height - DEVICE_PADDING;
    if (occupied || !fits) {
      setNotice(
        occupied
          ? 'That port slot is occupied.'
          : 'Resize the device to make room for that slot.',
      );
      showPreview(active.base);
      return;
    }
    setNotice('');
    showPreview({
      ...active.base,
      ports: active.base.ports.map((item) =>
        item.id === port.id ? { ...item, row, column } : item,
      ),
    });
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    cancelHold();
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      suppressClickUntil.current = event.timeStamp + 500;
      const next = previewRef.current;
      pinch.current = null;
      pointers.current.clear();
      showPreview(null);
      if (next) onChange({ ...document, viewport: next.viewport }, 'Viewport');
      onGestureChange?.(false);
      return;
    }
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    gesture.current = null;
    if (active.type === 'move') {
      suppressClickUntil.current = event.timeStamp + 500;
      if (
        !active.moved &&
        !active.modified &&
        active.renameOnClick &&
        active.ids?.length === 1
      ) {
        const element = latest.current.document.elements.find(
          (item) => item.id === active.renameOnClick!.id,
        );
        if (element)
          setRename({ type: 'element', id: element.id, value: element.name });
      }
    }
    setMarquee(null);
    setGuides([]);
    if (active.type === 'marquee') {
      if (!active.moved) onSelect(null);
      onGestureChange?.(false);
      return;
    }
    const next = previewRef.current;
    showPreview(null);
    onGestureChange?.(false);
    if (!next || !active.moved) return;
    if (active.type === 'pan') {
      onChange({ ...document, viewport: next.viewport }, 'Viewport');
      return;
    }
    if (active.type === 'port') {
      const changed = next.ports.find((item) => item.id === active.id);
      if (!changed) return;
      const old = active.base.ports.find((item) => item.id === active.id);
      if (old?.row === changed.row && old.column === changed.column) return;
      onChange(
        {
          ...document,
          ports: document.ports.map((item) =>
            item.id === changed.id
              ? { ...item, row: changed.row, column: changed.column }
              : item,
          ),
        },
        'Move port',
      );
      return;
    }
    if (active.type === 'move') {
      const ids = new Set(active.ids);
      const positions = new Map(
        next.elements
          .filter((item) => ids.has(item.id))
          .map((item) => [item.id, item]),
      );
      onChange(
        {
          ...document,
          elements: document.elements.map((item) => {
            const position = positions.get(item.id);
            return position ? { ...item, x: position.x, y: position.y } : item;
          }),
        },
        ids.size > 1 ? 'Move objects' : 'Move object',
      );
      return;
    }
    const changed = next.elements.find((item) => item.id === active.id);
    if (!changed) return;
    onChange(
      {
        ...document,
        elements: document.elements.map((item) =>
          item.id === changed.id
            ? {
                ...item,
                x: changed.x,
                y: changed.y,
                width: changed.width,
                height: changed.height,
              }
            : item,
        ),
      },
      active.type === 'resize' ? 'Resize object' : 'Move object',
    );
  }
  function selectPort(
    port: BoardPort,
    modifiers = { shiftKey: false, metaKey: false, ctrlKey: false },
  ) {
    if (disabled) return;
    if (tool !== 'cable') {
      const current =
        selection?.type === 'port' ? (selection.ids ?? [selection.id]) : [];
      const toggle = modifiers.metaKey || modifiers.ctrlKey || portMultiSelect;
      let ids: string[];
      if (
        modifiers.shiftKey &&
        portAnchor.current &&
        current.includes(portAnchor.current)
      ) {
        const range = portSelectionRange(document, portAnchor.current, port.id);
        ids = range.length
          ? toggle
            ? [...new Set([...current, ...range])]
            : range
          : [port.id];
        if (!range.length) portAnchor.current = port.id;
      } else if (toggle) {
        ids = current.includes(port.id)
          ? current.filter((id) => id !== port.id)
          : [...current, port.id];
        portAnchor.current = ids.includes(port.id)
          ? port.id
          : (ids.at(-1) ?? null);
      } else {
        ids = [port.id];
        portAnchor.current = port.id;
      }
      onSelect(
        ids.length
          ? {
              type: 'port',
              id: ids.includes(port.id) ? port.id : ids.at(-1)!,
              ids,
            }
          : null,
      );
      return;
    }
    if (!sourcePort) {
      setSourcePort(port.id);
      setNotice('Choose the other cable endpoint.');
      return;
    }
    if (sourcePort === port.id) {
      setSourcePort(null);
      setNotice('Cable cancelled.');
      return;
    }
    if (
      document.cables.some((cable) =>
        [cable.sourcePortId, cable.targetPortId].some(
          (id) => id === sourcePort || id === port.id,
        ),
      )
    ) {
      setNotice(
        'A selected port already has a cable. Select that cable to remove it first.',
      );
      return;
    }
    const cable = {
      id: crypto.randomUUID(),
      sourcePortId: sourcePort,
      targetPortId: port.id,
      name: '',
      cableType: '',
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: '',
    };
    onChange({ ...document, cables: [...document.cables, cable] }, 'Add cable');
    onSelect({ type: 'cable', id: cable.id });
    setSourcePort(null);
    setNotice('Cable added.');
  }
  function commitName() {
    if (!rename) return;
    const current = rename;
    setRename(null);
    if (current.type === 'element')
      onChange(
        {
          ...document,
          elements: document.elements.map((item) =>
            item.id === current.id ? { ...item, name: current.value } : item,
          ),
        },
        'Rename object',
      );
    else
      onChange(
        {
          ...document,
          ports: document.ports.map((item) =>
            item.id === current.id ? { ...item, name: current.value } : item,
          ),
        },
        'Rename port',
      );
  }
  function dropConnector(
    event: ReactDragEvent<HTMLElement>,
    element: BoardElement,
  ) {
    if (disabled || element.type !== 'device' || gesture.current) return;
    const raw = event.dataTransfer.getData('application/x-portfolio-port-kind');
    if (!raw) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const payload = JSON.parse(raw) as {
        kind: BoardPort['kind'];
        deviceId?: string;
      };
      if (!['rj45', 'sfp', 'sfp_plus', 'qsfp', 'other'].includes(payload.kind))
        throw new Error('Choose a connector type.');
      if (
        document.ports.filter((port) => port.deviceId === element.id).length >=
        512
      )
        throw new Error('This device already has 512 ports.');
      const point = screenToWorld(local(event), viewport);
      const gap = portGap(element);
      const face = activeFace(element);
      const column = clamp(
        Math.round(
          (point.x - element.x - DEVICE_PADDING - PORT_WIDTH / 2) /
            (PORT_WIDTH + gap),
        ),
        0,
        maxBoardPortColumn,
      );
      const row = clamp(
        Math.round(
          (point.y -
            element.y -
            DEVICE_HEADER -
            DEVICE_PADDING -
            PORT_HEIGHT / 2) /
            (PORT_HEIGHT + gap),
        ),
        0,
        maxBoardPortRow,
      );
      const capacity = boardPortCapacity(element);
      if (row >= capacity.rows || column >= capacity.columns)
        throw new Error('Resize the device to make room for that slot.');
      if (
        document.ports.some(
          (port) =>
            port.deviceId === element.id &&
            port.face === face &&
            port.row === row &&
            port.column === column,
        )
      )
        throw new Error('That port slot is occupied.');
      const port = makeBoardPort(
        element.id,
        payload.kind,
        row,
        column,
        `Port ${document.ports.filter((port) => port.deviceId === element.id).length + 1}`,
        face,
      );
      const ports = [...document.ports, port];
      const minimum = minimumDeviceSize(element, ports);
      onChange(
        {
          ...document,
          ports,
          elements: document.elements.map((item) =>
            item.id === element.id
              ? {
                  ...item,
                  width: Math.max(item.width, minimum.width),
                  height: Math.max(item.height, minimum.height),
                }
              : item,
          ),
        },
        'Add port',
      );
      onSelect({ type: 'port', id: port.id });
      setNotice('');
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'The port could not be placed.',
      );
    }
  }
  function inlineName(type: Rename['type'], id: string, name: string) {
    if (rename?.type === type && rename.id === id)
      return (
        <input
          autoFocus
          aria-label={type === 'element' ? 'Object name' : 'Port name'}
          className="board-inline-name"
          maxLength={240}
          value={rename.value}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) =>
            setRename({ ...rename, value: event.target.value })
          }
          onBlur={commitName}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commitName();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setRename(null);
            }
          }}
        />
      );
    return (
      <span
        className={
          type === 'element' ? 'board-element-name' : 'board-port-name'
        }
        title={name}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`Rename ${type === 'element' ? 'object' : 'port'} ${name}`}
        onPointerDown={(event) => {
          if (type === 'element') {
            if (
              event.pointerType === 'touch' &&
              tool !== 'pan' &&
              !root.current?.classList.contains('space-pan')
            ) {
              event.stopPropagation();
              return;
            }
            if (
              tool === 'pan' ||
              root.current?.classList.contains('space-pan') ||
              event.button === 1
            )
              begin(event, 'pan');
            else if (tool === 'select' || tool === 'ports')
              begin(event, 'move', id, undefined, { type, id, value: name });
            else event.stopPropagation();
            return;
          }
          // Port names remain editing controls, separate from device movement.
          if (tool !== 'pan' && !root.current?.classList.contains('space-pan'))
            event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === 'F2') && !disabled) {
            event.preventDefault();
            event.stopPropagation();
            setRename({ type, id, value: name });
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (type === 'element' && lastPointerType.current === 'touch') {
            if (!disabled && tool === 'select')
              chooseElement(id, event, true, false);
            return;
          }
          // Mouse and keyboard retain direct name editing.
          if (!disabled && tool !== 'pan') {
            finishViewport();
            setRename({ type, id, value: name });
          }
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (type === 'element' && lastPointerType.current === 'touch') return;
          if (!disabled) {
            finishViewport();
            setRename({ type, id, value: name });
          }
        }}
      >
        {name || (type === 'element' ? 'Untitled' : 'Port')}
      </span>
    );
  }
  return (
    <div
      ref={root}
      className={`board-canvas tool-${tool}${moving ? ' is-moving' : ''}`}
      data-testid="board-canvas"
      tabIndex={0}
      role="region"
      aria-label="Board canvas"
      onClickCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('.board-port-tooltip')
        )
          return;
        // Drag suppression applies to the generated pointer click, never to
        // keyboard activation of a button immediately after a gesture.
        if (
          event.detail !== 0 &&
          event.timeStamp < suppressClickUntil.current
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPointerDownCapture={capturePointer}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={(event) => {
        if (gesture.current?.pointer === event.pointerId) cancelGesture();
      }}
      onKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          (event.target.closest('input,textarea,select') ||
            (event.key !== 'Escape' &&
              event.target.closest('.board-summary-content')))
        )
          return;
        if (event.key === 'Escape') {
          event.preventDefault();
          if (gesture.current || pinch.current || sourcePort)
            event.stopPropagation();
          else onSelect(null);
          cancelGesture();
          setSourcePort(null);
          setHoverPort(null);
          setRename(null);
          setNotice('');
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          dismissSummary();
          if (!gesture.current) {
            root.current?.classList.add('space-pan');
          }
        }
        if (
          tool === 'pan' &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
            event.key,
          ) &&
          !disabled
        ) {
          event.preventDefault();
          const amount = event.shiftKey ? 120 : 40;
          onChange(
            {
              ...document,
              viewport: {
                ...document.viewport,
                x: clamp(
                  document.viewport.x +
                    (event.key === 'ArrowLeft'
                      ? amount
                      : event.key === 'ArrowRight'
                        ? -amount
                        : 0),
                  -100000,
                  100000,
                ),
                y: clamp(
                  document.viewport.y +
                    (event.key === 'ArrowUp'
                      ? amount
                      : event.key === 'ArrowDown'
                        ? -amount
                        : 0),
                  -100000,
                  100000,
                ),
              },
            },
            'Viewport',
          );
          return;
        }
        if (
          selection?.type === 'element' &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
            event.key,
          ) &&
          !disabled
        ) {
          event.preventDefault();
          const amount = event.altKey ? 1 : event.shiftKey ? 40 : 8;
          const delta = {
            x:
              event.key === 'ArrowLeft'
                ? -amount
                : event.key === 'ArrowRight'
                  ? amount
                  : 0,
            y:
              event.key === 'ArrowUp'
                ? -amount
                : event.key === 'ArrowDown'
                  ? amount
                  : 0,
          };
          onChange(
            moveSelection(document, selectedIds, delta, true).document,
            selectedIds.length > 1 ? 'Move objects' : 'Move object',
          );
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ') root.current?.classList.remove('space-pan');
      }}
    >
      <div
        data-board-background="true"
        className="board-canvas-background"
        style={
          document.grid
            ? {
                backgroundSize: `${32 * viewport.zoom}px ${32 * viewport.zoom}px`,
                backgroundPosition: `${viewport.x}px ${viewport.y}px`,
              }
            : undefined
        }
        data-grid={document.grid}
      />
      <div
        className="board-world"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        {visible.elements
          .slice()
          .sort((a, b) => a.z - b.z)
          .map((element) => {
            const selected = selectedIds.includes(element.id);
            const face = activeFace(element);
            const devicePorts = visible.ports.filter(
              (port) => port.deviceId === element.id,
            );
            const ports = devicePorts.filter((port) => port.face === face);
            return (
              <section
                key={element.id}
                className={`board-element board-${element.type}`}
                data-board-element-id={element.id}
                onDragOver={(event) => {
                  if (
                    !disabled &&
                    element.type === 'device' &&
                    event.dataTransfer.types.includes(
                      'application/x-portfolio-port-kind',
                    )
                  ) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={(event) => dropConnector(event, element)}
                data-selected={selected}
                aria-label={element.name || 'Untitled object'}
                style={{
                  left: element.x,
                  top: element.y,
                  width: element.width,
                  height: element.height,
                  zIndex: element.z,
                  borderColor: element.color || undefined,
                }}
                onPointerDown={(event) => {
                  const target =
                    event.target instanceof Element ? event.target : null;
                  if (
                    target?.closest(
                      'button,input,textarea,select,[contenteditable="true"],[popover],.board-port,.board-resize-handle,.board-summary-content,.board-network-summary',
                    )
                  )
                    return;
                  if (
                    tool === 'pan' ||
                    root.current?.classList.contains('space-pan') ||
                    event.button === 1
                  )
                    begin(event, 'pan');
                  else if (tool === 'select' && event.pointerType !== 'touch')
                    begin(event, 'move', element.id);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!disabled && tool === 'select')
                    chooseElement(
                      element.id,
                      event,
                      true,
                      lastPointerType.current !== 'touch',
                    );
                }}
              >
                <header
                  className={`board-element-header${element.type === 'device' ? ' board-device-header' : ''}`}
                  onPointerDown={(event) => {
                    if (
                      tool === 'pan' ||
                      root.current?.classList.contains('space-pan') ||
                      event.button === 1
                    )
                      begin(event, 'pan');
                    else if (tool !== 'cable' && event.pointerType !== 'touch')
                      begin(event, 'move', element.id);
                  }}
                >
                  {element.type === 'device' ? (
                    <DeviceHeader
                      nameText={element.name}
                      name={inlineName('element', element.id, element.name)}
                      faceControls={
                        <div
                          className="board-face-switch"
                          aria-label={`${element.name} face`}
                        >
                          {(['front', 'rear'] as const).map((side) => (
                            <button
                              type="button"
                              key={side}
                              disabled={disabled}
                              aria-pressed={face === side}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                onChange(
                                  {
                                    ...document,
                                    elements: document.elements.map((item) =>
                                      item.id === element.id
                                        ? {
                                            ...item,
                                            properties: {
                                              ...item.properties,
                                              face: side,
                                            },
                                          }
                                        : item,
                                    ),
                                  },
                                  'Change face',
                                );
                              }}
                            >
                              {side === 'front' ? 'Front' : 'Rear'}
                            </button>
                          ))}
                        </div>
                      }
                      fields={deviceHeaderFields(element, devicePorts.length)}
                    />
                  ) : (
                    inlineName('element', element.id, element.name)
                  )}
                </header>
                {element.type === 'device' ? (
                  <div className="board-device-ports">
                    {tool === 'ports' && (
                      <div
                        className="board-slot-grid"
                        style={{
                          left: DEVICE_PADDING,
                          top: DEVICE_HEADER + DEVICE_PADDING,
                          right: DEVICE_PADDING,
                          bottom: DEVICE_PADDING,
                          backgroundSize: `${PORT_WIDTH + portGap(element)}px ${PORT_HEIGHT + portGap(element)}px`,
                        }}
                      />
                    )}
                    {ports.map((port) => {
                      const rect = portRect(element, port);
                      const selectedPort =
                        selection?.type === 'port' &&
                        (selection.ids ?? [selection.id]).includes(port.id);
                      return (
                        <div
                          className="board-port"
                          key={port.id}
                          data-board-port-id={port.id}
                          data-selected={selectedPort}
                          data-cable-source={sourcePort === port.id}
                          style={{
                            left: rect.x - element.x,
                            top: rect.y - element.y,
                            width: PORT_WIDTH,
                            height: PORT_HEIGHT,
                          }}
                        >
                          {tool === 'ports' && (
                            <button
                              type="button"
                              className="board-port-grip"
                              onClick={(event) => event.stopPropagation()}
                              aria-label={`Move ${port.name}`}
                              disabled={disabled}
                              onPointerDown={(event) =>
                                begin(event, 'port', port.id)
                              }
                              onKeyDown={(event) => {
                                if (
                                  ![
                                    'ArrowLeft',
                                    'ArrowRight',
                                    'ArrowUp',
                                    'ArrowDown',
                                  ].includes(event.key) ||
                                  disabled
                                )
                                  return;
                                event.preventDefault();
                                event.stopPropagation();
                                const row = clamp(
                                  port.row +
                                    (event.key === 'ArrowUp'
                                      ? -1
                                      : event.key === 'ArrowDown'
                                        ? 1
                                        : 0),
                                  0,
                                  maxBoardPortRow,
                                );
                                const column = clamp(
                                  port.column +
                                    (event.key === 'ArrowLeft'
                                      ? -1
                                      : event.key === 'ArrowRight'
                                        ? 1
                                        : 0),
                                  0,
                                  maxBoardPortColumn,
                                );
                                const next = portRect(element, { row, column });
                                if (
                                  visible.ports.some(
                                    (item) =>
                                      item.id !== port.id &&
                                      item.deviceId === port.deviceId &&
                                      item.face === port.face &&
                                      item.row === row &&
                                      item.column === column,
                                  ) ||
                                  next.x + PORT_WIDTH >
                                    element.x +
                                      element.width -
                                      DEVICE_PADDING ||
                                  next.y + PORT_HEIGHT >
                                    element.y + element.height - DEVICE_PADDING
                                ) {
                                  setNotice('That slot is unavailable.');
                                  return;
                                }
                                onChange(
                                  {
                                    ...document,
                                    ports: document.ports.map((item) =>
                                      item.id === port.id
                                        ? { ...item, row, column }
                                        : item,
                                    ),
                                  },
                                  'Move port',
                                );
                              }}
                            >
                              ⠿
                            </button>
                          )}
                          <button
                            type="button"
                            className="board-port-socket"
                            data-port-id={port.id}
                            aria-label={`${element.name} ${summaryFor(port)}`}
                            disabled={disabled}
                            aria-pressed={selectedPort}
                            aria-describedby={
                              summaryPort?.id === port.id
                                ? summaryId
                                : undefined
                            }
                            onPointerDown={(event) => {
                              startHold(event, port);
                              if (
                                tool === 'pan' ||
                                event.button === 1 ||
                                root.current?.classList.contains('space-pan')
                              )
                                begin(event, 'pan');
                              else event.stopPropagation();
                            }}
                            onContextMenu={(event) => {
                              if (
                                disabled ||
                                gesture.current ||
                                pinch.current ||
                                rename ||
                                wheelViewport.current ||
                                root.current?.classList.contains('space-pan') ||
                                (tool !== 'select' && tool !== 'ports') ||
                                !onPortContextMenu
                              )
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              cancelHold();
                              setHoverPort(null);
                              setTouchSummary(null);
                              portAnchor.current = port.id;
                              onPortContextMenu(
                                port.id,
                                { x: event.clientX, y: event.clientY },
                                summaryFor(port),
                                lastPointerType.current === 'touch',
                              );
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (suppressHoldClick.current === port.id) {
                                suppressHoldClick.current = null;
                                event.preventDefault();
                                return;
                              }
                              setTouchSummary(null);
                              selectPort(port, event);
                            }}
                            onKeyDown={(event) => {
                              if (
                                summaryPort?.id === port.id &&
                                ['PageDown', 'PageUp'].includes(event.key)
                              ) {
                                const panel =
                                  globalThis.document.getElementById(summaryId);
                                if (
                                  panel &&
                                  panel.scrollHeight > panel.clientHeight
                                ) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  panel.scrollBy(
                                    0,
                                    panel.clientHeight *
                                      (event.key === 'PageDown' ? 0.8 : -0.8),
                                  );
                                  return;
                                }
                              }
                              if (
                                (event.key === 'ContextMenu' ||
                                  (event.shiftKey && event.key === 'F10')) &&
                                !disabled &&
                                !gesture.current &&
                                !pinch.current &&
                                !rename &&
                                !wheelViewport.current &&
                                !root.current?.classList.contains(
                                  'space-pan',
                                ) &&
                                onPortContextMenu &&
                                (tool === 'select' || tool === 'ports')
                              ) {
                                event.preventDefault();
                                event.stopPropagation();
                                const box =
                                  event.currentTarget.getBoundingClientRect();
                                portAnchor.current = port.id;
                                setHoverPort(null);
                                setTouchSummary(null);
                                onPortContextMenu(
                                  port.id,
                                  { x: box.left, y: box.bottom },
                                  summaryFor(port),
                                  false,
                                );
                                return;
                              }
                              if (event.key === 'F2' && !disabled) {
                                event.preventDefault();
                                event.stopPropagation();
                                setRename({
                                  type: 'port',
                                  id: port.id,
                                  value: port.name,
                                });
                                return;
                              }
                              if (
                                ![
                                  'ArrowLeft',
                                  'ArrowRight',
                                  'ArrowUp',
                                  'ArrowDown',
                                ].includes(event.key)
                              )
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              const horizontal =
                                  event.key === 'ArrowLeft' ||
                                  event.key === 'ArrowRight',
                                sign =
                                  event.key === 'ArrowLeft' ||
                                  event.key === 'ArrowUp'
                                    ? -1
                                    : 1;
                              const current = horizontal
                                  ? port.column
                                  : port.row,
                                other = horizontal ? port.row : port.column;
                              const target = ports
                                .filter(
                                  (item) =>
                                    sign *
                                      ((horizontal ? item.column : item.row) -
                                        current) >
                                    0,
                                )
                                .sort((a, b) => {
                                  const score = (item: BoardPort) =>
                                    Math.abs(
                                      (horizontal ? item.row : item.column) -
                                        other,
                                    ) *
                                      (Math.max(
                                        maxBoardPortColumn,
                                        maxBoardPortRow,
                                      ) +
                                        1) +
                                    Math.abs(
                                      (horizontal ? item.column : item.row) -
                                        current,
                                    );
                                  return score(a) - score(b);
                                })[0];
                              if (target)
                                root.current
                                  ?.querySelector<HTMLButtonElement>(
                                    `button[data-port-id="${CSS.escape(target.id)}"]`,
                                  )
                                  ?.focus();
                            }}
                            onPointerEnter={(event) => {
                              if (event.pointerType !== 'touch') {
                                cancelSummaryDismiss();
                                dismissedSummary.current = null;
                                setHoverPort(port.id);
                              }
                            }}
                            onPointerLeave={() =>
                              scheduleSummaryDismiss(port.id)
                            }
                            onFocus={(event) => {
                              if (
                                lastPointerType.current !== 'touch' &&
                                event.currentTarget.matches(':focus-visible') &&
                                dismissedSummary.current !== port.id
                              ) {
                                cancelSummaryDismiss();
                                setHoverPort(port.id);
                              }
                            }}
                            onBlur={() => {
                              if (dismissedSummary.current === port.id)
                                dismissedSummary.current = null;
                              scheduleSummaryDismiss(port.id);
                            }}
                          >
                            <MemoConnector
                              kind={port.kind}
                              color={resolveBoardPortColor(visible, port)}
                            />
                          </button>
                          {inlineName('port', port.id, port.name)}
                          {port.role && (
                            <span className="board-port-role" title={port.role}>
                              {port.role}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : element.type === 'summary' ? (
                  <div
                    className="board-summary-body"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      const content =
                        event.target instanceof Element
                          ? event.target.closest<HTMLElement>(
                              '.board-summary-content',
                            )
                          : null;
                      if (content && event.pointerType === 'touch') {
                        summaryScroll.current = {
                          pointer: event.pointerId,
                          y: event.clientY,
                          top: content.scrollTop,
                          element: content,
                        };
                        content.setPointerCapture(event.pointerId);
                      }
                    }}
                    onPointerMove={(event) => {
                      const scroll = summaryScroll.current;
                      if (!scroll || scroll.pointer !== event.pointerId) return;
                      if (pointers.current.has(event.pointerId))
                        pointers.current.set(event.pointerId, local(event));
                      event.stopPropagation();
                      scroll.element.scrollTop =
                        scroll.top + (scroll.y - event.clientY) / viewport.zoom;
                    }}
                    onPointerUp={(event) => {
                      if (summaryScroll.current?.pointer === event.pointerId)
                        summaryScroll.current = null;
                      // Let the canvas retire this finger from its touch map.
                    }}
                    onPointerCancel={() => {
                      summaryScroll.current = null;
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') event.stopPropagation();
                    }}
                    onKeyUp={(event) => {
                      if (event.key !== 'Escape') event.stopPropagation();
                    }}
                  >
                    <DeviceSummary document={visible} element={element} />
                  </div>
                ) : (
                  <NetworkSummary element={element} />
                )}
                {selected &&
                  selectedIds.length === 1 &&
                  !disabled &&
                  tool === 'select' &&
                  handles.map((handle) => (
                    <button
                      type="button"
                      key={handle}
                      className={`board-resize-handle handle-${handle}`}
                      aria-label={`Resize ${element.name} ${handle}`}
                      onPointerDown={(event) =>
                        begin(event, 'resize', element.id, handle)
                      }
                      onKeyDown={(event) => {
                        if (
                          ![
                            'ArrowLeft',
                            'ArrowRight',
                            'ArrowUp',
                            'ArrowDown',
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        const amount = event.shiftKey ? 40 : 8;
                        const next = resizeRect(
                          element,
                          handle,
                          {
                            x:
                              event.key === 'ArrowLeft'
                                ? -amount
                                : event.key === 'ArrowRight'
                                  ? amount
                                  : 0,
                            y:
                              event.key === 'ArrowUp'
                                ? -amount
                                : event.key === 'ArrowDown'
                                  ? amount
                                  : 0,
                          },
                          minimumDeviceSize(element, visible.ports),
                          event.altKey,
                        );
                        onChange(
                          {
                            ...document,
                            elements: document.elements.map((item) =>
                              item.id === element.id
                                ? { ...item, ...next }
                                : item,
                            ),
                          },
                          'Resize object',
                        );
                      }}
                    />
                  ))}
              </section>
            );
          })}
        {visible.showCables && (
          <svg className="board-cable-layer" aria-label="Board cables">
            {visible.cables.map((cable) => {
              const a = getPortPoint(visible, cable.sourcePortId),
                b = getPortPoint(visible, cable.targetPortId);
              if (!a || !b) return null;
              const source = visible.ports.find(
                  (port) => port.id === cable.sourcePortId,
                ),
                target = visible.ports.find(
                  (port) => port.id === cable.targetPortId,
                );
              const highlight =
                (selection?.type === 'cable' && selection.id === cable.id) ||
                [cable.sourcePortId, cable.targetPortId].includes(
                  hoverPort ?? (selection?.type === 'port' ? selection.id : ''),
                );
              const hitPath = cableHitPath(a, b, visible.elements);
              const label =
                cable.name ||
                `Cable: ${source?.name ?? 'Port'} ↔ ${target?.name ?? 'Port'}`;
              return (
                <g
                  key={cable.id}
                  data-board-cable-id={cable.id}
                  data-highlighted={highlight}
                  style={{ color: cable.color || '#aebec8' }}
                >
                  <title>{label}</title>
                  <path className="board-cable-shadow" d={cableCurve(a, b)} />
                  <path className="board-cable-line" d={cableCurve(a, b)} />
                  <path
                    className="board-cable-hit"
                    d={hitPath || cableCurve(a, b)}
                    style={{
                      pointerEvents:
                        hitPath && tool === 'select' ? 'stroke' : 'none',
                    }}
                    role="button"
                    tabIndex={disabled ? -1 : 0}
                    aria-label={label}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!disabled) onSelect({ type: 'cable', id: cable.id });
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.key === 'Enter' || event.key === ' ') &&
                        !disabled
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect({ type: 'cable', id: cable.id });
                      }
                    }}
                  />
                </g>
              );
            })}
          </svg>
        )}
        {marquee && (
          <div
            className="board-marquee"
            aria-hidden="true"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        )}
        <svg className="board-guide-layer" aria-hidden="true">
          {guides.map((guide, index) =>
            guide.axis === 'x' ? (
              <line
                key={index}
                x1={guide.value}
                x2={guide.value}
                y1={-100000}
                y2={100000}
              />
            ) : (
              <line
                key={index}
                y1={guide.value}
                y2={guide.value}
                x1={-100000}
                x2={100000}
              />
            ),
          )}
        </svg>
      </div>
      {touchElement && !disabled && tool === 'select' && !rename && (
        <div
          className="board-touch-actions"
          role="group"
          aria-label="Selected container actions"
          style={{
            left: `clamp(8px, ${viewport.x + touchElement.x * viewport.zoom}px, calc(100% - 108px))`,
            top: `clamp(8px, ${viewport.y + (touchElement.y + touchElement.height) * viewport.zoom + 8}px, calc(100% - 56px))`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="board-touch-move"
            aria-label={
              selectedIds.length > 1
                ? 'Move selected objects'
                : `Move ${touchElement.name}`
            }
            title="Drag to move"
            onPointerDown={(event) => begin(event, 'move', touchElement.id)}
            onClick={(event) => event.stopPropagation()}
          >
            <span aria-hidden="true">⠿</span>
          </button>
          {selectedIds.length === 1 && (
            <button
              type="button"
              aria-label={`Configure ${touchElement.name}`}
              title="Configure"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect({ type: 'element', id: touchElement.id }, true);
              }}
            >
              <span aria-hidden="true">⚙</span>
            </button>
          )}
        </div>
      )}
      {summaryPort && (
        <PortHoverTooltip
          id={summaryId}
          document={visible}
          port={summaryPort}
          canvas={root}
          onEnter={() => {
            cancelSummaryDismiss();
            summaryInside.current = true;
          }}
          onLeave={() => {
            summaryInside.current = false;
            scheduleSummaryDismiss(summaryPort.id);
          }}
          onDismiss={dismissSummary}
        />
      )}
      {notice && (
        <p className="board-canvas-notice" role="status">
          {notice}
        </p>
      )}
      <span className="board-canvas-sr" aria-live="polite">
        {sourcePort ? 'Choose a second port to connect. Escape cancels.' : ''}
      </span>
    </div>
  );
}
