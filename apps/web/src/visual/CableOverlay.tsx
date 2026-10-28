import { useEffect, useRef, useState, type RefObject } from 'react';
import type { EquipmentSnapshot } from './model.js';
import {
  cableColor,
  cableRoute,
  socketIsVisible,
  type CablePoint,
} from './cableGeometry.js';
import './cables.css';

type Line = {
  id: string;
  a: string;
  b: string;
  label: string;
  start: CablePoint;
  end: CablePoint;
  path: string;
  hitPath: string;
};
export function CableOverlay({
  snapshot,
  container,
  selectedPortId,
  onInspect,
}: {
  snapshot: EquipmentSnapshot;
  container: RefObject<HTMLDivElement | null>;
  selectedPortId: string | null;
  onInspect: (portId: string) => void;
}) {
  const [geometry, setGeometry] = useState<{
    width: number;
    height: number;
    lines: Line[];
  }>({ width: 0, height: 0, lines: [] });
  const [hoverPort, setHoverPort] = useState<string | null>(null);
  const [activeCable, setActiveCable] = useState<string | null>(null);
  const lastGeometry = useRef('');
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let frame = 0;
    let disposed = false;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(schedule);
    function observe(element: Element) {
      if (!observed.has(element)) {
        observed.add(element);
        resize.observe(element);
      }
    }
    function measure() {
      frame = 0;
      if (disposed) return;
      for (const element of observed) {
        if (element !== root && !root!.contains(element)) {
          resize.unobserve(element);
          observed.delete(element);
        }
      }
      const box = root!.getBoundingClientRect();
      const width = root!.clientWidth;
      const height = root!.clientHeight;
      const ports = new Map(snapshot.ports.map((port) => [port.id, port]));
      const devices = new Map(
        snapshot.devices.map((device) => [device.id, device]),
      );
      const endpointIds = new Set(
        snapshot.connections.flatMap((cable) => [
          cable.endpointAPortId,
          cable.endpointBPortId,
        ]),
      );
      const points = new Map<string, CablePoint>();
      for (const id of endpointIds) {
        const button = root!.querySelector<HTMLElement>(
          `[id="visual-port-${CSS.escape(id)}"]`,
        );
        const socket =
          button?.querySelector<SVGGraphicsElement>('[data-socket]');
        const connector = button?.querySelector<SVGSVGElement>(
          'svg[data-connector]',
        );
        const panel = button?.closest<HTMLElement>('.visual-panel-scroll');
        if (!button || !socket || !connector || !panel) continue;
        observe(button);
        observe(panel);
        const socketBox = socket.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        if (!socketIsVisible(socketBox, panelBox)) continue;
        points.set(id, {
          x:
            (socketBox.left + socketBox.right) / 2 -
            box.left +
            root!.scrollLeft,
          y: socketBox.top - box.top + root!.scrollTop,
          escapeY:
            connector.getBoundingClientRect().top -
            box.top +
            root!.scrollTop -
            8,
        });
      }
      const lines: Line[] = [];
      for (const cable of snapshot.connections) {
        const a = points.get(cable.endpointAPortId);
        const b = points.get(cable.endpointBPortId);
        if (!a || !b) continue;
        const endpoint = (id: string) => {
          const port = ports.get(id);
          return `${devices.get(port?.deviceId ?? '')?.displayName ?? 'Device'} / ${port?.name ?? 'Unavailable port'}`;
        };
        const lane = lines.length % 5;
        const gutter =
          (a.x + b.x) / 2 < width / 2
            ? 6 + lane * 3
            : Math.max(6, width - 6 - lane * 3);
        lines.push({
          id: cable.id,
          a: cable.endpointAPortId,
          b: cable.endpointBPortId,
          label: `Cable: ${endpoint(cable.endpointAPortId)} ↔ ${endpoint(cable.endpointBPortId)}`,
          start: a,
          end: b,
          path: cableRoute(a, b, gutter),
          hitPath: `M ${gutter} ${a.escapeY} L ${gutter} ${b.escapeY}`,
        });
      }
      const next = { width, height, lines };
      const serialized = JSON.stringify(next);
      if (serialized !== lastGeometry.current) {
        lastGeometry.current = serialized;
        setGeometry(next);
      }
    }
    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(measure);
    }
    const mutation = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !(record.target instanceof Element) ||
            !record.target.closest('.cable-overlay'),
        )
      )
        schedule();
    });
    mutation.observe(root, { childList: true, subtree: true });
    observe(root);
    root.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const highlight = (event: Event) => {
      const element =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-port-id]')
          : null;
      setHoverPort(element?.dataset.portId ?? null);
    };
    const leave = () => setHoverPort(null);
    root.addEventListener('pointerover', highlight);
    root.addEventListener('focusin', highlight);
    root.addEventListener('pointerleave', leave);
    root.addEventListener('focusout', leave);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      root.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      root.removeEventListener('pointerover', highlight);
      root.removeEventListener('focusin', highlight);
      root.removeEventListener('pointerleave', leave);
      root.removeEventListener('focusout', leave);
    };
  }, [snapshot, container]);
  const highlightedPort = hoverPort ?? selectedPortId;
  const active = geometry.lines.find((line) => line.id === activeCable);
  const hasIncidentCable = geometry.lines.some(
    (line) => highlightedPort === line.a || highlightedPort === line.b,
  );
  return (
    <div className="cable-overlay" data-visible-cables={geometry.lines.length}>
      <svg
        className="cable-overlay-svg"
        width={geometry.width}
        height={geometry.height}
        aria-label="Documented physical cables"
      >
        {geometry.lines.map((line) => {
          const emphasized =
            activeCable === line.id ||
            highlightedPort === line.a ||
            highlightedPort === line.b;
          const dimmed =
            Boolean(activeCable || hasIncidentCable) && !emphasized;
          return (
            <g
              key={line.id}
              className="cable-overlay-line"
              data-connection-id={line.id}
              data-endpoint-a={line.a}
              data-endpoint-b={line.b}
              data-highlighted={emphasized}
              data-dimmed={dimmed}
              style={{ color: cableColor(line.id) }}
            >
              <title>{line.label}</title>
              <path className="cable-overlay-shadow" d={line.path} />
              <path className="cable-overlay-stroke" d={line.path} />
              <circle
                className="cable-overlay-endpoint"
                cx={line.start.x}
                cy={line.start.y}
                r={3}
              />
              <circle
                className="cable-overlay-endpoint"
                cx={line.end.x}
                cy={line.end.y}
                r={3}
              />
              <path
                className="cable-overlay-hit"
                d={line.hitPath}
                role="button"
                tabIndex={0}
                aria-label={line.label}
                onPointerEnter={() => setActiveCable(line.id)}
                onPointerLeave={() => setActiveCable(null)}
                onFocus={() => setActiveCable(line.id)}
                onBlur={() => setActiveCable(null)}
                onClick={() =>
                  onInspect(selectedPortId === line.b ? line.b : line.a)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onInspect(selectedPortId === line.b ? line.b : line.a);
                  }
                }}
              />
            </g>
          );
        })}
      </svg>
      {active && (
        <p className="cable-overlay-caption" role="status">
          {active.label}
        </p>
      )}
    </div>
  );
}
