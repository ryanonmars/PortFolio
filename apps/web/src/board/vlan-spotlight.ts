import type { BoardDocument } from '../../../../packages/shared/src/board.js';

export type SpotlightMembership = 'native' | 'tagged' | 'both' | null;

/** Normalize a viewing key without validating or changing authored settings. */
export function normalizeVlan(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(BigInt(value)) : String(value);
  }
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (/^[+-]?\d+$/.test(text)) return String(BigInt(text));
  return text;
}

function taggedValues(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? [value]
      : [];
}

export function spotlightMembership(
  port: { nativeVlan?: unknown; taggedVlans?: unknown; pvid?: unknown },
  vlan: unknown,
): SpotlightMembership {
  const selected = normalizeVlan(vlan);
  if (!selected) return null;
  const native = normalizeVlan(port.nativeVlan) === selected;
  const tagged = taggedValues(port.taggedVlans).some(
    (value) => normalizeVlan(value) === selected,
  );
  return native && tagged
    ? 'both'
    : native
      ? 'native'
      : tagged
        ? 'tagged'
        : null;
}

export function discoverVlans(
  document: Pick<BoardDocument, 'ports' | 'elements'>,
): string[] {
  const values = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeVlan(value);
    if (normalized) values.add(normalized);
  };
  for (const port of document.ports) {
    add(port.nativeVlan);
    for (const value of taggedValues(port.taggedVlans)) add(value);
  }
  for (const element of document.elements) {
    if (element.type !== 'network') continue;
    const entries = element.properties.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries)
      if (entry && typeof entry === 'object' && !Array.isArray(entry))
        add(entry.vlanId ?? entry.vlan_id);
  }
  return [...values].sort((left, right) => {
    const integer = /^-?\d+$/;
    const numericLeft = integer.test(left),
      numericRight = integer.test(right);
    if (numericLeft && numericRight) {
      const a = BigInt(left),
        b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left.localeCompare(right, 'en', { numeric: true });
  });
}
