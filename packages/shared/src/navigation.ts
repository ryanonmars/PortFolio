import type { Device } from './equipment.js';

export const configurePanes = [
  'devices',
  'vlans',
  'network',
  'racks',
  'transfer',
  'connections',
  'templates',
] as const;
export type ConfigurePane = (typeof configurePanes)[number];
export interface NavigationTarget {
  settings?: boolean;
  workspaceId?: string;
  siteId?: string;
  configure?: boolean;
  pane?: ConfigurePane;
  deviceId?: string;
  portId?: string;
}
export interface NavigationWorkspace {
  id: string;
  name: string;
}
export interface NavigationSite {
  id: string;
  workspaceId: string;
  name: string;
}
export type NavigationDevice = Pick<
  Device,
  'id' | 'siteId' | 'displayName' | 'type' | 'orderIndex'
>;
export interface NavigationData {
  workspaces: NavigationWorkspace[];
  sites: NavigationSite[];
  devices: NavigationDevice[];
}

export function navigationUrl(target: NavigationTarget): string {
  if (target.settings) {
    const params = new URLSearchParams();
    if (target.siteId) params.set('siteId', target.siteId);
    else if (target.workspaceId) params.set('workspaceId', target.workspaceId);
    return `/settings${params.size ? '?' + params.toString() : ''}`;
  }
  if (target.siteId) {
    const params = new URLSearchParams();
    if (target.configure) {
      params.set('view', 'configure');
      if (target.pane && target.pane !== 'devices')
        params.set('pane', target.pane);
      if ((!target.pane || target.pane === 'devices') && target.deviceId)
        params.set('deviceId', target.deviceId);
      if ((!target.pane || target.pane === 'devices') && target.portId)
        params.set('portId', target.portId);
    }
    return `/sites/${encodeURIComponent(target.siteId)}${params.size ? '?' + params.toString() : ''}`;
  }
  return target.workspaceId
    ? `/workspaces/${encodeURIComponent(target.workspaceId)}`
    : '/';
}
export function navigationTarget(
  pathname: string,
  search: string,
): NavigationTarget {
  const parts = pathname.split('/');
  const params = new URLSearchParams(search);
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  if (parts[1] === 'settings') {
    const siteId = params.get('siteId');
    const workspaceId = params.get('workspaceId');
    return {
      settings: true,
      ...(siteId ? { siteId } : workspaceId ? { workspaceId } : {}),
    };
  }
  if (parts[1] === 'workspaces' && parts[2])
    return { workspaceId: decode(parts[2]) };
  if (parts[1] !== 'sites' || !parts[2]) return {};
  const target: NavigationTarget = { siteId: decode(parts[2]) };
  if (params.get('view') === 'configure') {
    target.configure = true;
    const value = params.get('pane');
    target.pane = configurePanes.find((pane) => pane === value) ?? 'devices';
    if (target.pane === 'devices') {
      const deviceId = params.get('deviceId');
      const portId = params.get('portId');
      if (deviceId) target.deviceId = deviceId;
      if (portId) target.portId = portId;
    }
  }
  return target;
}
