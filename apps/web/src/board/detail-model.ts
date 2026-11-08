import {
  normalizeNetworkDocument,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';

export type BoardPage =
  | { kind: 'unavailable' }
  | { kind: 'canvas'; focusId?: string }
  | { kind: 'networks' }
  | { kind: 'devices' }
  | { kind: 'network'; containerId: string; entryId: string }
  | { kind: 'device'; deviceId: string };

export interface NetworkItem {
  container: BoardElement;
  entry: Record<string, JsonValue>;
  entryId: string;
  label: string;
  index: number;
}

/** Exact route shapes only; malformed IDs never fall back to another object. */
export function parseBoardLocation(
  pathname: string,
  search = '',
): { boardId: string; page: BoardPage } | null {
  try {
    const parts = pathname.split('/');
    if (parts[0] !== '' || parts[1] !== 'boards') return null;
    const decode = (part: string | undefined) => {
      if (!part) throw new Error('Missing ID');
      const value = decodeURIComponent(part);
      if (!value || value.length > 100) throw new Error('Invalid ID');
      return value;
    };
    const boardId = decode(parts[2]);
    if (parts.length === 4 && parts[3] === 'unavailable')
      return { boardId, page: { kind: 'unavailable' } };
    if (parts.length === 3) {
      // URLSearchParams tolerates malformed escapes; identity routes must not.
      decodeURIComponent(search.replace(/\+/g, ' '));
      const focusId = new URLSearchParams(search).get('focus');
      if (focusId && focusId.length > 100) return null;
      return {
        boardId,
        page: { kind: 'canvas', ...(focusId ? { focusId } : {}) },
      };
    }
    if (parts[3] === 'networks') {
      if (parts.length === 4) return { boardId, page: { kind: 'networks' } };
      if (parts.length === 6)
        return {
          boardId,
          page: {
            kind: 'network',
            containerId: decode(parts[4]),
            entryId: decode(parts[5]),
          },
        };
    }
    if (parts[3] === 'devices') {
      if (parts.length === 4) return { boardId, page: { kind: 'devices' } };
      if (parts.length === 5)
        return {
          boardId,
          page: { kind: 'device', deviceId: decode(parts[4]) },
        };
    }
    return null;
  } catch {
    return null;
  }
}

/** Keep the known board context while refusing malformed object destinations. */
export function resolveBoardLocation(
  pathname: string,
  search = '',
): { boardId: string; page: BoardPage } | null {
  const parsed = parseBoardLocation(pathname, search);
  if (parsed) return parsed;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'boards' || !parts[2]) return null;
  try {
    const boardId = decodeURIComponent(parts[2]);
    if (!boardId || boardId.length > 100) return null;
    return { boardId, page: { kind: 'unavailable' } };
  } catch {
    return null;
  }
}

export function boardPagePath(boardId: string, page: BoardPage): string {
  const base = `/boards/${encodeURIComponent(boardId)}`;
  switch (page.kind) {
    case 'unavailable':
      return `${base}/unavailable`;
    case 'canvas':
      return page.focusId
        ? `${base}?focus=${encodeURIComponent(page.focusId)}`
        : base;
    case 'networks':
      return `${base}/networks`;
    case 'devices':
      return `${base}/devices`;
    case 'network':
      return `${base}/networks/${encodeURIComponent(page.containerId)}/${encodeURIComponent(page.entryId)}`;
    case 'device':
      return `${base}/devices/${encodeURIComponent(page.deviceId)}`;
  }
}

export function networkItems(document: BoardDocument): NetworkItem[] {
  const result: NetworkItem[] = [];
  for (const container of normalizeNetworkDocument(document).elements) {
    if (
      container.type !== 'network' ||
      !Array.isArray(container.properties.entries)
    )
      continue;
    container.properties.entries.forEach((entry, index) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof entry.networkEntryId !== 'string'
      )
        return;
      const name =
        typeof entry.vlanName === 'string' ? entry.vlanName.trim() : '';
      const vlan =
        typeof entry.vlanId === 'string' || typeof entry.vlanId === 'number'
          ? String(entry.vlanId).trim()
          : '';
      const subnet =
        typeof entry.subnet === 'string' ? entry.subnet.trim() : '';
      result.push({
        container,
        entry,
        entryId: entry.networkEntryId,
        label:
          (name && vlan ? `VLAN ${vlan} — ${name}` : name) ||
          (vlan ? `VLAN ${vlan}` : '') ||
          subnet ||
          `Network entry ${index + 1}`,
        index,
      });
    });
  }
  return result;
}

export function deviceItems(document: BoardDocument): BoardElement[] {
  return document.elements.filter((element) => element.type === 'device');
}

export function findNetwork(
  document: BoardDocument,
  containerId: string,
  entryId: string,
): NetworkItem | undefined {
  return networkItems(document).find(
    (item) => item.container.id === containerId && item.entryId === entryId,
  );
}

/** Only real cable endpoints establish peers; authored network values do not. */
export function portPeer(
  document: BoardDocument,
  port: BoardPort,
): { device: BoardElement; port: BoardPort } | null {
  if (
    !document.ports.some(
      (item) => item.id === port.id && item.deviceId === port.deviceId,
    )
  )
    return null;
  const cable = document.cables.find(
    (item) => item.sourcePortId === port.id || item.targetPortId === port.id,
  );
  if (!cable) return null;
  const peerId =
    cable.sourcePortId === port.id ? cable.targetPortId : cable.sourcePortId;
  const peer = document.ports.find((item) => item.id === peerId);
  const device =
    peer && deviceItems(document).find((item) => item.id === peer.deviceId);
  return peer && device ? { device, port: peer } : null;
}
