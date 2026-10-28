import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import {
  builtInDeviceTemplates,
  type Device,
  type DeviceTemplate,
  type Port,
} from '../../../packages/shared/src/index.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture();
  clients.push(client);
  const site = await client.createSite();
  return { client, site, base: `/api/v1/sites/${site.id}` };
}

describe('reusable device templates', () => {
  it('offers six recognizable starters and persists editable, versioned copies without changing starter defaults', async () => {
    const { client } = await fixture();
    const response = await client.request('GET', '/api/v1/device-templates');
    expect(response.statusCode).toBe(200);
    expect(response.json().templates).toEqual(builtInDeviceTemplates);
    const saved = await client.request('POST', '/api/v1/device-templates', {
      name: 'Small mixed switch',
      type: 'switch',
      description: 'Reusable physical arrangement',
      groups: [
        { count: 8 },
        {
          count: 2,
          kind: 'sfp_plus',
          speed: '10G',
          face: 'rear',
          namePrefix: 'Uplink ',
        },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const template: DeviceTemplate = saved.json().template;
    expect(template.groups[0]).toEqual({
      count: 8,
      kind: 'rj45',
      speed: '',
      mode: 'other',
      face: 'front',
      namePrefix: 'Port ',
    });
    const changed = await client.request(
      'PATCH',
      '/api/v1/device-templates/' + template.id,
      { rowVersion: 1, groups: [{ count: 24, kind: 'rj45', face: 'front' }] },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().template.rowVersion).toBe(2);
    expect(
      (
        await client.request(
          'PATCH',
          '/api/v1/device-templates/' + template.id,
          { rowVersion: 1, name: 'Stale edit' },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'DELETE',
          '/api/v1/device-templates/' + template.id,
          { rowVersion: 1 },
        )
      ).statusCode,
    ).toBe(409);
    await client.restart();
    const templates: DeviceTemplate[] = (
      await client.request('GET', '/api/v1/device-templates')
    ).json().templates;
    expect(templates).toContainEqual(changed.json().template);
    expect(templates.slice(0, 6)).toEqual(builtInDeviceTemplates);
    expect(
      (
        await client.request('POST', '/api/v1/device-templates', {
          name: 'SMALL MIXED SWITCH',
          groups: [],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request(
          'DELETE',
          '/api/v1/device-templates/' + template.id,
          { rowVersion: 2 },
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await client.request('GET', '/api/v1/device-templates')).json()
        .templates,
    ).toEqual(builtInDeviceTemplates);
  });

  it('creates a complete, site-scoped device and ordered mixed ports in one transaction without rack or network prerequisites', async () => {
    const { client, site, base } = await fixture();
    const other = await client.createSite('Other', site.workspaceId);
    const groups = [
      {
        count: 8,
        kind: 'rj45',
        speed: '1G',
        mode: 'access',
        face: 'front',
        namePrefix: 'Port ',
      },
      {
        count: 2,
        kind: 'sfp_plus',
        speed: '10G',
        mode: 'routed',
        face: 'rear',
        namePrefix: 'Uplink ',
      },
    ];
    const created = await client.request(
      'POST',
      base + '/devices/from-template',
      {
        device: {
          displayName: 'Mixed device',
          type: 'switch',
          manufacturer: 'Synthetic',
          tags: ['Metadata label'],
        },
        groups,
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    const { device, ports } = created.json() as {
      device: Device;
      ports: Port[];
    };
    expect(device).toMatchObject({
      siteId: site.id,
      displayName: 'Mixed device',
      rackId: null,
      rowVersion: 1,
      tags: ['Metadata label'],
    });
    expect(ports).toHaveLength(10);
    expect(ports.map((port) => port.name)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `Port ${index + 1}`),
      'Uplink 9',
      'Uplink 10',
    ]);
    expect(ports.map((port) => port.orderIndex)).toEqual(
      Array.from({ length: 10 }, (_, index) => index),
    );
    expect(ports[0]).toMatchObject({
      kind: 'rj45',
      speed: '1G',
      mode: 'access',
      face: 'front',
    });
    expect(ports[9]).toMatchObject({
      kind: 'sfp_plus',
      speed: '10G',
      mode: 'routed',
      face: 'rear',
    });
    expect(
      ports.every(
        (port) =>
          port.siteId === site.id &&
          port.deviceId === device.id &&
          port.nativeVlanRef === null &&
          port.pvid === null &&
          port.taggedVlanRefs.length === 0 &&
          port.documentedLinkState === 'unknown' &&
          port.rowVersion === 1,
      ),
    ).toBe(true);
    expect(
      (
        await client.request(
          'GET',
          `/api/v1/sites/${other.id}/devices/${device.id}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request(
          'GET',
          `/api/v1/sites/${other.id}/ports/${ports[0]!.id}`,
        )
      ).statusCode,
    ).toBe(404);
    await client.restart();
    expect(
      (await client.request('GET', base + `/devices/${device.id}/ports`)).json()
        .ports,
    ).toEqual(ports);
    expect((await client.request('GET', base + '/vlans')).json().vlans).toEqual(
      [],
    );
    expect((await client.request('GET', base + '/racks')).json().racks).toEqual(
      [],
    );
  });

  it('supports empty custom layouts and the exact512-port boundary while rejecting malformed or oversized layouts', async () => {
    const { client, base } = await fixture();
    const empty = await client.request(
      'POST',
      base + '/devices/from-template',
      {
        device: { displayName: 'Custom zero ports', type: 'custom' },
        groups: [],
      },
    );
    expect(empty.statusCode, empty.body).toBe(201);
    expect(empty.json().ports).toEqual([]);
    const large = await client.request(
      'POST',
      base + '/devices/from-template',
      {
        device: { displayName: '512 ports' },
        groups: [{ count: 256 }, { count: 256, face: 'rear' }],
      },
    );
    expect(large.statusCode, large.body).toBe(201);
    expect(large.json().ports).toHaveLength(512);
    expect(large.json().ports[511]).toMatchObject({
      name: 'Port 512',
      orderIndex: 511,
      face: 'rear',
    });
    for (const groups of [
      [{ count: 513 }],
      [{ count: 256 }, { count: 257 }],
      [{ count: -1 }],
      [{ count: 1, kind: 'made-up' }],
      [{ count: 1, mode: 'wan' }],
      [{ count: 1, vlanRef: 'foreign' }],
      Array.from({ length: 17 }, () => ({ count: 0 })),
    ]) {
      const rejected = await client.request(
        'POST',
        base + '/devices/from-template',
        { device: { displayName: 'Must not exist' }, groups },
      );
      expect(rejected.statusCode, rejected.body).toBe(400);
    }
    expect(
      (await client.request('GET', base + '/devices')).json().devices,
    ).toHaveLength(2);
  });

  it('rolls back device creation on invalid references, duplicates and late port insertion failure', async () => {
    const { client, site, base } = await fixture();
    const other = await client.createSite('Foreign rack', site.workspaceId);
    const rack = (
      await client.request('POST', `/api/v1/sites/${other.id}/racks`, {
        name: 'Other rack',
      })
    ).json().rack;
    const foreign = await client.request(
      'POST',
      base + '/devices/from-template',
      {
        device: { displayName: 'Wrong site', rackId: rack.id },
        groups: [{ count: 1 }],
      },
    );
    expect(foreign.statusCode, foreign.body).toBe(400);
    client.db.exec(
      "CREATE TRIGGER fail_template_ports BEFORE INSERT ON ports WHEN NEW.order_index=1 BEGIN SELECT RAISE(ABORT,'Synthetic late insertion failure'); END;",
    );
    const failed = await client.request(
      'POST',
      base + '/devices/from-template',
      { device: { displayName: 'Atomic device' }, groups: [{ count: 3 }] },
    );
    expect(failed.statusCode, failed.body).toBe(400);
    expect(
      (await client.request('GET', base + '/devices')).json().devices,
    ).toEqual([]);
    expect(
      client.db.prepare('SELECT id FROM ports WHERE site_id=?').all(site.id),
    ).toEqual([]);
    client.db.exec('DROP TRIGGER fail_template_ports');
    expect(
      (
        await client.request('POST', base + '/devices/from-template', {
          device: { displayName: 'Existing' },
          groups: [{ count: 1 }],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await client.request('POST', base + '/devices/from-template', {
          device: { displayName: 'EXISTING' },
          groups: [{ count: 8 }],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await client.request('GET', base + '/devices')).json().devices,
    ).toHaveLength(1);
    expect(
      client.db.prepare('SELECT id FROM ports WHERE site_id=?').all(site.id),
    ).toHaveLength(1);
  });

  it('protects templates and atomic creation with authentication, CSRF and read-only builtin rules', async () => {
    const { client, base } = await fixture();
    const headers = { host: '127.0.0.1:3088', origin: 'http://127.0.0.1:3088' };
    expect(
      (
        await client.app.inject({
          method: 'GET',
          url: '/api/v1/device-templates',
          headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await client.request(
          'POST',
          '/api/v1/device-templates',
          { name: 'Forged', groups: [] },
          { 'x-csrf-token': 'invalid' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request(
          'POST',
          base + '/devices/from-template',
          { device: { displayName: 'Forged' }, groups: [] },
          { 'x-csrf-token': 'invalid' },
        )
      ).statusCode,
    ).toBe(403);
    for (const method of ['PATCH', 'DELETE'] as const)
      expect(
        (
          await client.request(
            method,
            '/api/v1/device-templates/builtin:switch',
            { rowVersion: 1 },
          )
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await client.request('POST', '/api/v1/device-templates', {
          name: 'No site references',
          groups: [{ count: 1, siteId: 'forbidden' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await client.request('GET', base + '/export')).json(),
    ).not.toHaveProperty('templates');
  });
});
