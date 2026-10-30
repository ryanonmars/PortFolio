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
