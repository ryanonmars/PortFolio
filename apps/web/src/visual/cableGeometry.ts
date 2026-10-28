export type CablePoint = { x: number; y: number; escapeY: number };
export function cableRoute(
  a: CablePoint,
  b: CablePoint,
  gutter: number,
): string {
  const n = (value: number) => Number(value.toFixed(2));
  return `M ${n(a.x)} ${n(a.y)} L ${n(a.x)} ${n(a.escapeY)} L ${n(gutter)} ${n(a.escapeY)} L ${n(gutter)} ${n(b.escapeY)} L ${n(b.x)} ${n(b.escapeY)} L ${n(b.x)} ${n(b.y)}`;
}

// Cable identity colors carry no VLAN, direction, or live-status meaning.
export function cableColor(id: string): string {
  const palette = ['#b2c0cb', '#c7b9ab', '#bcb7d0', '#a8c3c5', '#c5c4ac'];
  let hash = 0;
  for (const character of id)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

export function socketIsVisible(
  socket: { left: number; right: number; top: number; bottom: number },
  clip: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    socket.right > socket.left &&
    socket.bottom > socket.top &&
    socket.left >= clip.left - 1 &&
    socket.right <= clip.right + 1 &&
    socket.top >= clip.top - 1 &&
    socket.bottom <= clip.bottom + 1
  );
}
