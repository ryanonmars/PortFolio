import { describe, expect, it } from 'vitest';
import {
  navigationTarget,
  navigationUrl,
  configurePanes,
} from './navigation.js';

describe('direct navigation routes', () => {
  it('round-trips each site section and device/port deep link', () => {
    for (const pane of configurePanes) {
      const target = { siteId: 'site-id', configure: true, pane };
      const url = new URL(navigationUrl(target), 'http://localhost');
      expect(navigationTarget(url.pathname, url.search)).toEqual(target);
    }
    const target = {
      siteId: 'site-id',
      configure: true,
      pane: 'devices' as const,
      deviceId: 'device-id',
      portId: 'port-id',
    };
    const url = new URL(navigationUrl(target), 'http://localhost');
    expect(navigationTarget(url.pathname, url.search)).toEqual(target);
    expect(
      navigationUrl({
        siteId: 'site-id',
        configure: false,
        pane: 'network',
        deviceId: 'stale',
      }),
    ).toBe('/sites/site-id');
  });
  it('preserves settings workspace/site context without stale device state', () => {
    for (const target of [
      { settings: true },
      { settings: true, workspaceId: 'workspace' },
      { settings: true, siteId: 'site' },
    ]) {
      const url = new URL(navigationUrl(target), 'http://localhost');
      expect(navigationTarget(url.pathname, url.search)).toEqual(target);
    }
  });
  it('allowlists sections and prevents stale device selection in other contexts', () => {
    expect(
      navigationTarget(
        '/sites/site-id',
        '?view=configure&pane=unknown&deviceId=dev',
      ),
    ).toEqual({
      siteId: 'site-id',
      configure: true,
      pane: 'devices',
      deviceId: 'dev',
    });
    expect(
      navigationTarget(
        '/sites/site-id',
        '?view=configure&pane=network&deviceId=dev&portId=port',
      ),
    ).toEqual({ siteId: 'site-id', configure: true, pane: 'network' });
    expect(
      navigationTarget('/sites/site-id', '?pane=vlans&deviceId=dev'),
    ).toEqual({ siteId: 'site-id' });
  });
  it('escapes identifiers and tolerates malformed URL encoding without crashing the app', () => {
    expect(navigationUrl({ workspaceId: 'unsafe/path' })).toBe(
      '/workspaces/unsafe%2Fpath',
    );
    expect(navigationTarget('/workspaces/unsafe%2Fpath', '')).toEqual({
      workspaceId: 'unsafe/path',
    });
    expect(navigationTarget('/sites/%bad', '')).toEqual({ siteId: '%bad' });
    expect(navigationUrl({})).toBe('/');
  });
});
