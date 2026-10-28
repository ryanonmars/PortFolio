import { describe, expect, it } from 'vitest';
import { workspaceTree, recordDestination } from './Sidebar.js';
import type { NavigationData } from '../../../packages/shared/src/index.js';
describe('workspace site tree', () => {
  const data: NavigationData = {
    workspaces: [
      { id: 'a', name: 'Home' },
      { id: 'b', name: 'Work' },
      { id: 'empty', name: 'Empty' },
    ],
    sites: [
      { id: 'one', workspaceId: 'a', name: 'Network' },
      { id: 'two', workspaceId: 'b', name: 'Network' },
      { id: 'three', workspaceId: 'b', name: 'Trailer' },
    ],
    devices: [],
  };
  it('shows every workspace and groups each site only under its parent, preserving canonical order', () => {
    expect(
      workspaceTree(data).map((branch) => [
        branch.workspace.id,
        branch.sites.map((site) => site.id),
      ]),
    ).toEqual([
      ['a', ['one']],
      ['b', ['two', 'three']],
      ['empty', []],
    ]);
  });
  it('does not mutate canonical records while grouping duplicate site names', () => {
    const original = structuredClone(data);
    const tree = workspaceTree(data);
    expect(tree[0]!.sites[0]!.id).not.toBe(tree[1]!.sites[0]!.id);
    expect(data).toEqual(original);
  });
  it('handles no workspaces and excludes sites with no returned parent', () => {
    expect(
      workspaceTree({ workspaces: [], sites: data.sites, devices: [] }),
    ).toEqual([]);
  });
});

describe('record destinations', () => {
  it('opens equipment detail while keeping non-device IDs scoped to their category', () => {
    expect(
      recordDestination('site', 'devices', { id: 'device', label: 'Switch' }),
    ).toEqual({
      siteId: 'site',
      configure: true,
      pane: 'devices',
      deviceId: 'device',
      deviceView: 'detail',
    });
    expect(
      recordDestination('site', 'vlans', {
        id: 'vlan',
        label: 'VLAN 20 — Server',
      }),
    ).toEqual({
      siteId: 'site',
      configure: true,
      pane: 'vlans',
      recordId: 'vlan',
    });
  });
  it('distinguishes physical and logical links even if their IDs coincide', () => {
    expect(
      recordDestination('site', 'connections', {
        id: 'link',
        label: 'Cable',
        kind: 'physical',
      }).recordKind,
    ).toBe('physical');
    expect(
      recordDestination('site', 'connections', {
        id: 'link',
        label: 'Tunnel',
        kind: 'logical',
      }).recordKind,
    ).toBe('logical');
  });
});
