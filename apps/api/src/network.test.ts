import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
let client: Fixture;
afterEach(async () => {
  if (client) await client.close();
});
async function fixture() {
  client = await apiFixture();
  return client;
}
const base = (siteId: string) => `/api/v1/sites/${siteId}`;

describe('site network definitions', () => {
  it('preserves numeric names and colors, checks VLAN boundaries and namespaces, and versions edits', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const other = await c.createSite('Other');
    const url = `${base(site.id)}/vlans`;
    for (const vlanId of [0, 4095, 1.5, '20'])
      expect((await c.request('POST', url, { vlanId })).statusCode).toBe(400);
    const first = await c.request('POST', url, {
      vlanId: 1,
      name: '101',
      color: '#31A37B',
    });
    expect(first.statusCode).toBe(201);
    const vlan = first.json().vlan;
    expect(vlan).toMatchObject({
      siteId: site.id,
      vlanId: 1,
      name: '101',
      color: '#31A37B',
      rowVersion: 1,
    });
    expect(
      (await c.request('POST', url, { vlanId: 4094, name: '101' })).statusCode,
    ).toBe(201);
    expect((await c.request('POST', url, { vlanId: 20 })).statusCode).toBe(201);
    expect((await c.request('POST', url, { vlanId: 20 })).statusCode).toBe(409);
    expect(
      (await c.request('POST', `${base(other.id)}/vlans`, { vlanId: 20 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await c.request('GET', url))
        .json()
        .vlans.map((v: { vlanId: number }) => v.vlanId),
    ).toEqual([1, 20, 4094]);
    const updated = await c.request('PATCH', `${url}/${vlan.id}`, {
      name: '101',
      color: '#428DEB',
      description: 'Documented',
      rowVersion: 1,
    });
    expect(updated.json().vlan).toMatchObject({
      color: '#428DEB',
      description: 'Documented',
      rowVersion: 2,
    });
    expect(
      (
        await c.request('PATCH', `${url}/${vlan.id}`, {
          vlanId: 2,
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await c.request('DELETE', `${url}/${vlan.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await c.request('GET', `${base(other.id)}/vlans/${vlan.id}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await c.request('PATCH', `${url}/${vlan.id}`, {
          siteId: other.id,
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await c.request('DELETE', `${url}/${vlan.id}`, { rowVersion: 2 }))
        .statusCode,
    ).toBe(204);
    expect((await c.request('GET', `${url}/${vlan.id}`)).statusCode).toBe(404);
  });

  it('protects every network collection and encoded route with session, Origin and CSRF checks', async () => {
    const c = await fixture();
    const site = await c.createSite();
    for (const collection of ['vlans', 'subnets', 'racks']) {
      const url = `${base(site.id)}/${collection}`;
      const unauth = await c.app.inject({
        url,
        headers: { host: '127.0.0.1:3088' },
      });
      expect(unauth.statusCode).toBe(401);
      expect(unauth.json().error.code).toBe('UNAUTHENTICATED');
      expect(
        (await c.request('POST', url, {}, { 'x-csrf-token': '' })).statusCode,
      ).toBe(403);
      expect(
        (
          await c.request(
            'POST',
            url,
            {},
            { origin: 'https://attacker.invalid' },
          )
        ).statusCode,
      ).toBe(403);
      const encoded = url.replace('/api/', '/%61pi/');
      expect(
        (
          await c.request('GET', encoded, undefined, {
            host: 'attacker.invalid',
          })
        ).statusCode,
      ).toBe(403);
      const valid = await c.request('GET', url);
      expect(valid.statusCode).toBe(200);
      expect(valid.headers['cache-control']).toBe('no-store');
    }
    expect(
      (await c.request('GET', '/api/v1/sites/missing/vlans')).statusCode,
    ).toBe(404);
    expect(
      (
        await c.request('POST', `${base(site.id)}/vlans`, {
          vlanId: 20,
          color: 'red',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('supports optional racks with scoped unique names, ordering, edits and guarded versions', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const other = await c.createSite('Other');
    const url = `${base(site.id)}/racks`;
    const first = (await c.request('POST', url, { name: 'Shelf' })).json().rack;
    const second = (await c.request('POST', url, { name: 'Rack B' })).json()
      .rack;
    expect(first.orderIndex).toBe(0);
    expect(second.orderIndex).toBe(1);
    expect((await c.request('POST', url, { name: 'shelf' })).statusCode).toBe(
      409,
    );
    expect(
      (await c.request('POST', `${base(other.id)}/racks`, { name: 'Shelf' }))
        .statusCode,
    ).toBe(201);
    const updated = (
      await c.request('PATCH', `${url}/${first.id}`, {
        name: 'Wall',
        description: 'Optional location',
        orderIndex: 3,
        rowVersion: 1,
      })
    ).json().rack;
    expect(updated).toMatchObject({
      name: 'Wall',
      description: 'Optional location',
      orderIndex: 3,
      rowVersion: 2,
    });
    expect(
      (await c.request('GET', url))
        .json()
        .racks.map((r: { id: string }) => r.id),
    ).toEqual([second.id, first.id]);
    expect(
      (
        await c.request('PATCH', `${url}/${first.id}`, {
          name: 'Lost',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await c.request('GET', `${base(other.id)}/racks/${first.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await c.request('DELETE', `${base(other.id)}/racks/${first.id}`, {
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await c.request('DELETE', `${url}/${first.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await c.request('DELETE', `${url}/${first.id}`, { rowVersion: 2 }))
        .statusCode,
    ).toBe(204);
  });

  it('accepts canonical IPv4 /0, /31 and /32, with optional network details and explicit endpoint policy', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const url = `${base(site.id)}/subnets`;
    for (const input of [
      { cidr: '0.0.0.0/0', gatewayIp: '1.1.1.1', dnsServers: ['8.8.8.8'] },
      { cidr: '10.0.0.0/31', gatewayIp: '10.0.0.0' },
      { cidr: '10.1.1.1/32', gatewayIp: '10.1.1.1' },
      { cidr: '192.0.2.0/24' },
    ]) {
      const response = await c.request('POST', url, input);
      expect(response.statusCode).toBe(201);
      expect(response.json().subnet.cidr).toBe(input.cidr);
    }
    for (const input of [
      { cidr: '10.0.0.7/24' },
      { cidr: '2001:db8::/64' },
      { cidr: '10.0.0.0/33' },
      { cidr: '10.0.0.0/024' },
      { cidr: '10.2.0.0/24', gatewayIp: '10.3.0.1' },
      { cidr: '10.2.0.0/24', gatewayIp: '10.2.0.0' },
      { cidr: '10.2.0.0/24', gatewayIp: '10.2.0.255' },
      { cidr: '10.2.0.0/24', dnsServers: ['not-an-ip'] },
      { cidr: '10.2.0.0/24', dnsServers: ['2001:db8::1'] },
    ]) {
      expect((await c.request('POST', url, input)).statusCode).toBe(400);
    }
    const stored = (await c.request('GET', url)).json().subnets;
    expect(stored).toHaveLength(4);
    expect(
      stored.find((s: { cidr: string }) => s.cidr === '192.0.2.0/24'),
    ).toMatchObject({
      vlanRef: null,
      gatewayIp: null,
      dnsServers: [],
      notes: '',
    });
  });

  it('validates subnet VLAN ownership on create and patch without leaking or changing existing records', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const other = await c.createSite('Other');
    const local = (
      await c.request('POST', `${base(site.id)}/vlans`, { vlanId: 20 })
    ).json().vlan;
    const remote = (
      await c.request('POST', `${base(other.id)}/vlans`, { vlanId: 20 })
    ).json().vlan;
    const url = `${base(site.id)}/subnets`;
    expect(
      (
        await c.request('POST', url, {
          cidr: '10.20.0.0/24',
          vlanRef: remote.id,
        })
      ).statusCode,
    ).toBe(404);
    const subnet = (
      await c.request('POST', url, {
        cidr: '10.20.0.0/24',
        vlanRef: local.id,
        dnsServers: ['8.8.8.8'],
      })
    ).json().subnet;
    expect(
      (await c.request('POST', url, { cidr: '10.20.0.0/24' })).statusCode,
    ).toBe(409);
    expect(
      (
        await c.request('POST', `${base(other.id)}/subnets`, {
          cidr: '10.20.0.0/24',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await c.request('PATCH', `${url}/${subnet.id}`, {
          vlanRef: remote.id,
          notes: 'Lost',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await c.request('GET', `${url}/${subnet.id}`)).json().subnet,
    ).toEqual(subnet);
    const updated = (
      await c.request('PATCH', `${url}/${subnet.id}`, {
        vlanRef: null,
        name: 'Segment',
        notes: 'Stored',
        rowVersion: 1,
      })
    ).json().subnet;
    expect(updated).toMatchObject({
      vlanRef: null,
      name: 'Segment',
      notes: 'Stored',
      rowVersion: 2,
    });
    expect(
      (
        await c.request('PATCH', `${url}/${subnet.id}`, {
          name: 'Lost',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await c.request('DELETE', `${url}/${subnet.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await c.request('GET', `${base(other.id)}/subnets/${subnet.id}`))
        .statusCode,
    ).toBe(404);
    expect(() =>
      c.db
        .prepare('UPDATE subnets SET vlan_ref=? WHERE id=?')
        .run(remote.id, subnet.id),
    ).toThrow();
    expect(
      (await c.request('DELETE', `${url}/${subnet.id}`, { rowVersion: 2 }))
        .statusCode,
    ).toBe(204);
  });

  it('validates DHCP ranges and complete patches, including disabled scopes and parent isolation', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const other = await c.createSite('Other');
    const subnet = (
      await c.request('POST', `${base(site.id)}/subnets`, {
        cidr: '10.40.0.0/24',
      })
    ).json().subnet;
    const second = (
      await c.request('POST', `${base(site.id)}/subnets`, {
        cidr: '10.41.0.0/24',
      })
    ).json().subnet;
    const remote = (
      await c.request('POST', `${base(other.id)}/subnets`, {
        cidr: '10.40.0.0/24',
      })
    ).json().subnet;
    const url = `${base(site.id)}/subnets/${subnet.id}/dhcp-scopes`;
    for (const input of [
      { startIp: '10.40.0.20', endIp: '10.40.0.10' },
      { startIp: '10.40.0.10', endIp: '10.41.0.20' },
      { startIp: '10.40.0.0', endIp: '10.40.0.10' },
      { startIp: '10.40.0.10', endIp: '10.40.0.255' },
      { startIp: '2001:db8::1', endIp: '2001:db8::2' },
    ])
      expect((await c.request('POST', url, input)).statusCode).toBe(400);
    const created = await c.request('POST', url, {
      startIp: '10.40.0.10',
      endIp: '10.40.0.20',
    });
    expect(created.statusCode).toBe(201);
    const scope = created.json().dhcpScope;
    expect(scope).toMatchObject({
      siteId: site.id,
      subnetId: subnet.id,
      enabled: true,
      rowVersion: 1,
    });
    expect(
      (
        await c.request('PATCH', `${url}/${scope.id}`, {
          endIp: '10.40.0.9',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await c.request('PATCH', `${url}/${scope.id}`, {
          startIp: '10.41.0.10',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await c.request('GET', `${url}/${scope.id}`)).json().dhcpScope,
    ).toEqual(scope);
    const updated = (
      await c.request('PATCH', `${url}/${scope.id}`, {
        enabled: false,
        notes: 'Documented only',
        rowVersion: 1,
      })
    ).json().dhcpScope;
    expect(updated).toMatchObject({
      enabled: false,
      notes: 'Documented only',
      rowVersion: 2,
    });
    expect((await c.request('GET', url)).json().dhcpScopes).toEqual([updated]);
    for (const wrong of [
      `${base(site.id)}/subnets/${second.id}/dhcp-scopes/${scope.id}`,
      `${base(other.id)}/subnets/${remote.id}/dhcp-scopes/${scope.id}`,
      `${base(other.id)}/subnets/${subnet.id}/dhcp-scopes/${scope.id}`,
    ]) {
      expect((await c.request('GET', wrong)).statusCode).toBe(404);
      expect(
        (await c.request('PATCH', wrong, { notes: 'Lost', rowVersion: 2 }))
          .statusCode,
      ).toBe(404);
      expect(
        (await c.request('DELETE', wrong, { rowVersion: 2 })).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await c.request('PATCH', `${url}/${scope.id}`, {
          notes: 'Lost',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await c.request('DELETE', `${url}/${scope.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(() =>
      c.db
        .prepare('UPDATE dhcp_scopes SET subnet_id=? WHERE id=?')
        .run(remote.id, scope.id),
    ).toThrow();
    expect(
      (await c.request('DELETE', `${url}/${scope.id}`, { rowVersion: 2 }))
        .statusCode,
    ).toBe(204);
  });

  it('supports DHCP on /31 and /32 with explicit usable endpoint policy', async () => {
    const c = await fixture();
    const site = await c.createSite();
    for (const [cidr, startIp, endIp] of [
      ['10.50.0.0/31', '10.50.0.0', '10.50.0.1'],
      ['10.51.0.7/32', '10.51.0.7', '10.51.0.7'],
    ]) {
      const subnet = (
        await c.request('POST', `${base(site.id)}/subnets`, { cidr })
      ).json().subnet;
      expect(
        (
          await c.request(
            'POST',
            `${base(site.id)}/subnets/${subnet.id}/dhcp-scopes`,
            { startIp, endIp },
          )
        ).statusCode,
      ).toBe(201);
    }
  });

  it('revalidates existing gateway and DHCP scopes atomically when shrinking subnets', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const url = `${base(site.id)}/subnets`;
    const subnet = (
      await c.request('POST', url, {
        cidr: '10.60.0.0/24',
        gatewayIp: '10.60.0.1',
        notes: 'Keep',
      })
    ).json().subnet;
    const scopeUrl = `${url}/${subnet.id}/dhcp-scopes`;
    const scope = (
      await c.request('POST', scopeUrl, {
        startIp: '10.60.0.150',
        endIp: '10.60.0.200',
        enabled: false,
      })
    ).json().dhcpScope;
    expect(
      (
        await c.request('PATCH', `${url}/${subnet.id}`, {
          cidr: '10.60.0.0/25',
          notes: 'Lost',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await c.request('PATCH', `${url}/${subnet.id}`, {
          cidr: '10.61.0.0/24',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await c.request('GET', `${url}/${subnet.id}`)).json().subnet,
    ).toEqual(subnet);
    expect(
      (await c.request('GET', `${scopeUrl}/${scope.id}`)).json().dhcpScope,
    ).toEqual(scope);
    expect(
      (
        await c.request('PATCH', `${scopeUrl}/${scope.id}`, {
          startIp: '10.60.0.10',
          endIp: '10.60.0.20',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    const shrunk = (
      await c.request('PATCH', `${url}/${subnet.id}`, {
        cidr: '10.60.0.0/25',
        rowVersion: 1,
      })
    ).json().subnet;
    expect(shrunk).toMatchObject({
      cidr: '10.60.0.0/25',
      gatewayIp: '10.60.0.1',
      notes: 'Keep',
      rowVersion: 2,
    });
  });

  it('guards referenced VLANs, assigned racks and subnets with DHCP scopes until explicitly detached', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const root = base(site.id);
    const native = (
      await c.request('POST', `${root}/vlans`, { vlanId: 1 })
    ).json().vlan;
    const tagged = (
      await c.request('POST', `${root}/vlans`, { vlanId: 20 })
    ).json().vlan;
    const network = (
      await c.request('POST', `${root}/vlans`, { vlanId: 30 })
    ).json().vlan;
    const rack = (
      await c.request('POST', `${root}/racks`, { name: 'Shelf' })
    ).json().rack;
    const deviceResponse = await c.request('POST', `${root}/devices`, {
      displayName: 'Switch',
      rackId: rack.id,
    });
    expect(deviceResponse.statusCode).toBe(201);
    const device = deviceResponse.json().device;
    const portResponse = await c.request(
      'POST',
      `${root}/devices/${device.id}/ports`,
      {
        name: 'Port 1',
        mode: 'trunk',
        nativeVlanRef: native.id,
        taggedVlanRefs: [tagged.id],
      },
    );
    expect(portResponse.statusCode).toBe(201);
    const port = portResponse.json().port;
    const subnet = (
      await c.request('POST', `${root}/subnets`, {
        cidr: '10.70.0.0/24',
        vlanRef: network.id,
      })
    ).json().subnet;
    const scopes = `${root}/subnets/${subnet.id}/dhcp-scopes`;
    const scope = (
      await c.request('POST', scopes, {
        startIp: '10.70.0.10',
        endIp: '10.70.0.20',
      })
    ).json().dhcpScope;
    for (const vlan of [native, tagged, network]) {
      const response = await c.request('DELETE', `${root}/vlans/${vlan.id}`, {
        rowVersion: 1,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('REFERENCED_RECORD');
    }
    expect(
      (await c.request('DELETE', `${root}/racks/${rack.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await c.request('DELETE', `${root}/subnets/${subnet.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await c.request('DELETE', `${root}/ports/${port.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await c.request('DELETE', `${root}/vlans/${native.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await c.request('DELETE', `${root}/vlans/${tagged.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await c.request('DELETE', `${scopes}/${scope.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await c.request('DELETE', `${root}/subnets/${subnet.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await c.request('DELETE', `${root}/vlans/${network.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
    const currentDevice = (
      await c.request('GET', `${root}/devices/${device.id}`)
    ).json().device;
    expect(
      (
        await c.request('PATCH', `${root}/devices/${device.id}`, {
          rackId: null,
          rowVersion: currentDevice.rowVersion,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await c.request('DELETE', `${root}/racks/${rack.id}`, { rowVersion: 1 }))
        .statusCode,
    ).toBe(204);
  });

  it('persists network details, boolean scopes and reference identities after server restart', async () => {
    const c = await fixture();
    const site = await c.createSite();
    const root = base(site.id);
    const vlan = (
      await c.request('POST', `${root}/vlans`, {
        vlanId: 20,
        name: '20',
        color: '#428DEB',
      })
    ).json().vlan;
    const rack = (
      await c.request('POST', `${root}/racks`, { name: 'Loose equipment' })
    ).json().rack;
    const subnet = (
      await c.request('POST', `${root}/subnets`, {
        cidr: '10.80.0.0/24',
        vlanRef: vlan.id,
        gatewayIp: '10.80.0.1',
        dnsServers: ['8.8.8.8'],
        notes: 'Saved',
      })
    ).json().subnet;
    const scope = (
      await c.request('POST', `${root}/subnets/${subnet.id}/dhcp-scopes`, {
        name: 'Static documentation',
        startIp: '10.80.0.10',
        endIp: '10.80.0.20',
        enabled: false,
      })
    ).json().dhcpScope;
    await c.restart();
    expect(
      (await c.request('GET', `${root}/vlans/${vlan.id}`)).json().vlan,
    ).toEqual(vlan);
    expect(
      (await c.request('GET', `${root}/racks/${rack.id}`)).json().rack,
    ).toEqual(rack);
    expect(
      (await c.request('GET', `${root}/subnets/${subnet.id}`)).json().subnet,
    ).toEqual(subnet);
    expect(
      (
        await c.request(
          'GET',
          `${root}/subnets/${subnet.id}/dhcp-scopes/${scope.id}`,
        )
      ).json().dhcpScope,
    ).toEqual(scope);
  });
});
