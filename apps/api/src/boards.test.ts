import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardRecord,
} from '../../../packages/shared/src/board.js';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
const clients: Fixture[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture(false);
  clients.push(client);
  return client;
}
function sample(): BoardDocument {
  const document = emptyBoardDocument();
  document.elements = ['a', 'b'].map((id, index) => ({
    id,
    type: 'device',
    name: 'Custom device',
    x: index * 400,
    y: 100,
    width: 300,
    height: 220,
    z: index,
    color: '#428deb',
    properties: {
      deviceType: 'Custom appliance',
      managementAddress: 'host.example, 2001:db8::10',
      notes: '<script>inert</script>',
    },
  }));
  document.ports = ['a', 'b'].map((deviceId) => ({
    id: 'port-' + deviceId,
    deviceId,
    face: deviceId === 'a' ? 'front' : 'rear',
    row: 0,
    column: 0,
    name: 'WAN',
    kind: 'rj45',
    color: '#31a37b',
    role: 'Custom uplink',
    speed: 'Documented 1 Gbps',
    linkState: 'documented up',
    nativeVlan: '20 without an inventory',
    taggedVlans: ['30', '4000'],
    pvid: '17',
    address: '192.0.2.5/24',
    externalDestination: 'Off-board annotation',
    notes: 'No relational prerequisites',
    customFields: { enabled: false, capacity: 0 },
  }));
  document.cables = [
    {
      id: 'cable',
      sourcePortId: 'port-a',
      targetPortId: 'port-b',
      name: 'Uplink',
      cableType: 'Cat6',
      sourceConnector: 'RJ45',
      targetConnector: 'RJ45',
      color: '#428deb',
      length: '3m documented',
      notes: 'Preserve stable endpoints',
    },
  ];
  document.viewport = { x: 12, y: -90, zoom: 0.8 };
  document.grid = false;
  return document;
}
async function create(
  client: Fixture,
  name = 'Home',
  document = emptyBoardDocument(),
): Promise<BoardRecord> {
  const response = await client.request('POST', '/api/v1/boards', {
    name,
    document,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().board;
}

describe('board-centric persistence API', () => {
  it('persists unrestricted physical slots and stable cable references across restart and resize', async () => {
    const client = await fixture();
    const document = sample();
    document.elements = document.elements.map((element) => ({
      ...element,
      width: 20000,
      height: 20000,
      properties: { ...element.properties, portSpacing: 0, frontColumns: 8 },
    }));
    document.ports[0] = { ...document.ports[0]!, row: 200, column: 300 };
    const created = await create(client, 'Physical layout', document);
    expect(created.document).toEqual(document);
    await client.restart();
    const stored = (
      await client.request('GET', `/api/v1/boards/${created.id}`)
    ).json().board as BoardRecord;
    expect(stored.document).toEqual(document);
    const changed = structuredClone(stored.document);
    changed.ports[0]!.row = 0;
    changed.ports[0]!.column = 10;
    changed.elements[0]!.width = 900;
    changed.elements[0]!.height = 304;
    const response = await client.request(
      'PATCH',
      `/api/v1/boards/${created.id}`,
      { rowVersion: stored.rowVersion, document: changed },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().board.document.ports).toEqual(changed.ports);
    expect(response.json().board.document.cables).toEqual(document.cables);
    const invalid = structuredClone(changed);
    invalid.elements[0]!.width = 160;
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${created.id}`, {
          rowVersion: response.json().board.rowVersion,
          document: invalid,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await client.request('GET', `/api/v1/boards/${created.id}`)).json().board
        .document,
    ).toEqual(changed);
  });

  it('lazily migrates old Network entries without writes and preserves annotations through save, restart and import', async () => {
    const client = await fixture();
    const original = sample();
    original.elements.push({
      id: 'network',
      type: 'network',
      name: 'Container title',
      x: 0,
      y: 400,
      width: 320,
      height: 220,
      z: 2,
      color: '',
      properties: {
        entries: [
          {
            name: 'Original title',
            vlanName: '',
            pvid: '99',
            addresses: 'authored addresses',
            dhcpStatus: 'Enabled',
            dhcpStart: 'start',
            dhcpEnd: 'end',
            customFields: { enabled: false, count: 0 },
          },
          {
            name: 'Second',
            vlanName: 'Existing VLAN name',
            dhcpStatus: 'relay sometimes',
            mystery: 'preserved',
          },
        ],
      },
    });
    const created = await create(client);
    // Simulate a document already stored by the previous application version.
    const stored = JSON.stringify(original);
    client.db
      .prepare('UPDATE boards SET document_json=? WHERE id=?')
      .run(stored, created.id);
    const get = async () =>
      (await client.request('GET', `/api/v1/boards/${created.id}`)).json()
        .board as BoardRecord;
    const migrated = await get();
    expect(migrated.rowVersion).toBe(created.rowVersion);
    expect(
      client.db
        .prepare('SELECT document_json FROM boards WHERE id=?')
        .get(created.id)?.document_json,
    ).toBe(stored);
    const entries = migrated.document.elements[2]!.properties.entries as Record<
      string,
      unknown
    >[];
    expect(entries[0]).toMatchObject({
      name: 'Original title',
      vlanName: 'Original title',
      pvid: '99',
      addresses: 'authored addresses',
      dhcpStatus: 'Enabled',
      dhcpServer: true,
    });
    expect(entries[1]).toMatchObject({
      vlanName: 'Existing VLAN name',
      dhcpStatus: 'relay sometimes',
      mystery: 'preserved',
    });
    expect(entries[1]).not.toHaveProperty('dhcpServer');
    entries[0]!.dhcpServer = false;
    entries[0]!.vlanName = '';
    const saved = await client.request(
      'PATCH',
      `/api/v1/boards/${created.id}`,
      { rowVersion: migrated.rowVersion, document: migrated.document },
    );
    expect(saved.statusCode, saved.body).toBe(200);
    await client.restart();
    const reloaded = await get();
    expect(reloaded.document).toEqual(migrated.document);
    expect(reloaded.document.ports).toEqual(original.ports);
    expect(reloaded.document.ports[0]!.pvid).toBe('17');
    const archive = (
      await client.request('GET', `/api/v1/boards/${created.id}/export`)
    ).json();
    const imported = await client.request(
      'POST',
      '/api/v1/boards/import',
      archive,
    );
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json().board.document.elements[2].properties).toEqual(
      reloaded.document.elements[2]!.properties,
    );
    expect(client.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('atomically reorders the complete board list and versions only changed positions', async () => {
    const client = await fixture();
    expect(
      (
        await client.request('POST', '/api/v1/boards/reorder', { boards: [] })
      ).json(),
    ).toEqual({ boards: [], groups: [] });
    const a = await create(client, 'A');
    const b = await create(client, 'B');
    const c = await create(client, 'C');
    const response = await client.request('POST', '/api/v1/boards/reorder', {
      boards: [c, b, a].map(({ id, rowVersion }) => ({ id, rowVersion })),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json().boards.map((board: BoardRecord) => board.id),
    ).toEqual([c.id, b.id, a.id]);
    expect(
      response.json().boards.map((board: BoardRecord) => board.order),
    ).toEqual([0, 1, 2]);
    expect(
      response.json().boards.map((board: BoardRecord) => board.rowVersion),
    ).toEqual([2, 1, 2]);
    expect(response.json()).toEqual(
      (await client.request('GET', '/api/v1/boards')).json(),
    );
    expect(
      (
        await client.request('POST', '/api/v1/boards/reorder', {
          boards: response
            .json()
            .boards.map(({ id, rowVersion }: BoardRecord) => ({
              id,
              rowVersion,
            })),
        })
      ).json(),
    ).toEqual(response.json());
    await client.restart();
    expect((await client.request('GET', '/api/v1/boards')).json()).toEqual(
      response.json(),
    );
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${a.id}`, {
          rowVersion: 1,
          name: 'Stale autosave',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('rejects incomplete, duplicate, cancelled, foreign and stale reorder requests without partial writes', async () => {
    const client = await fixture();
    const a = await create(client, 'A');
    const b = await create(client, 'B');
    const before = (await client.request('GET', '/api/v1/boards')).json();
    const key = (board: BoardRecord) => ({
      id: board.id,
      rowVersion: board.rowVersion,
    });
    const cases = [
      { body: undefined, status: 400 },
      { body: { boards: [key(a)] }, status: 409 },
      { body: { boards: [key(a), key(a)] }, status: 400 },
      {
        body: { boards: [key(a), { id: 'foreign', rowVersion: 1 }] },
        status: 409,
      },
      { body: { boards: [key(b), { id: a.id, rowVersion: 2 }] }, status: 409 },
    ];
    for (const { body, status } of cases) {
      const response = await client.request(
        'POST',
        '/api/v1/boards/reorder',
        body,
      );
      expect(response.statusCode, response.body).toBe(status);
      expect((await client.request('GET', '/api/v1/boards')).json()).toEqual(
        before,
      );
    }
    const cancelled = await client.request(
      'POST',
      '/api/v1/boards/reorder',
      { boards: [key(b), key(a)] },
      { 'x-csrf-token': 'cancelled-token' },
    );
    expect(cancelled.statusCode).toBe(403);
    expect((await client.request('GET', '/api/v1/boards')).json()).toEqual(
      before,
    );
    // Prove rollback after a real write, rather than only rejecting during validation.
    client.db.exec(
      `CREATE TRIGGER fail_second_reorder BEFORE UPDATE OF order_index ON boards WHEN NEW.id='${a.id}' BEGIN SELECT RAISE(ABORT,'simulated reorder failure'); END;`,
    );
    expect(
      (
        await client.request('POST', '/api/v1/boards/reorder', {
          boards: [key(b), key(a)],
        })
      ).statusCode,
    ).toBe(400);
    expect((await client.request('GET', '/api/v1/boards')).json()).toEqual(
      before,
    );
    client.db.exec('DROP TRIGGER fail_second_reorder');
  });
  it('creates standalone boards without inventory, keeps identical names and saves flexible annotations', async () => {
    const client = await fixture();
    expect((await client.request('GET', '/api/v1/boards')).json()).toEqual({
      boards: [],
      groups: [],
    });
    const board = await create(client, 'Home', sample());
    expect(board.groupId).toBeNull();
    expect(board.rowVersion).toBe(1);
    expect(board.document).toEqual(sample());
    const another = await create(client, 'Home');
    expect(another.id).not.toBe(board.id);
    const list = await client.request('GET', '/api/v1/boards');
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json().boards).toHaveLength(2);
    expect(list.json().boards[0]).not.toHaveProperty('document');
    const moved = structuredClone(board.document);
    moved.elements[0]!.x = 900;
    moved.ports[0]!.face = 'rear';
    moved.ports[0]!.column = 1;
    const saved = await client.request('PATCH', `/api/v1/boards/${board.id}`, {
      rowVersion: 1,
      document: moved,
      name: 'Home revised',
      order: 9,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().board).toMatchObject({
      name: 'Home revised',
      rowVersion: 2,
      order: 9,
      document: moved,
    });
    await client.restart();
    expect(
      (await client.request('GET', `/api/v1/boards/${board.id}`)).json().board,
    ).toEqual(saved.json().board);
    expect(
      (await client.request('GET', `/api/v1/boards/${another.id}`)).json().board
        .document.elements,
    ).toEqual([]);
  });

  it('organizes optional groups, moves boards out and ungroups safely on group deletion', async () => {
    const client = await fixture();
    const board = await create(client);
    const created = await client.request('POST', '/api/v1/board-groups', {
      name: 'Work',
    });
    expect(created.statusCode).toBe(201);
    const group = created.json().group;
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${board.id}`, {
          rowVersion: 1,
          groupId: group.id,
        })
      ).json().board.groupId,
    ).toBe(group.id);
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${board.id}`, {
          rowVersion: 2,
          groupId: null,
        })
      ).json().board.groupId,
    ).toBeNull();
    await client.request('PATCH', `/api/v1/boards/${board.id}`, {
      rowVersion: 3,
      groupId: group.id,
    });
    const rename = await client.request(
      'PATCH',
      `/api/v1/board-groups/${group.id}`,
      { rowVersion: 1, name: 'Office', order: 2 },
    );
    expect(rename.json().group.rowVersion).toBe(2);
    expect(
      (
        await client.request('DELETE', `/api/v1/board-groups/${group.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('DELETE', `/api/v1/board-groups/${group.id}`, {
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(204);
    const ungrouped = (
      await client.request('GET', `/api/v1/boards/${board.id}`)
    ).json().board;
    expect(ungrouped.groupId).toBeNull();
    expect(ungrouped.rowVersion).toBe(5);
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${board.id}`, {
          rowVersion: 4,
          name: 'Stale',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${board.id}`, {
          rowVersion: 5,
          groupId: 'missing',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects stale autosaves and malformed graphs atomically without affecting another board', async () => {
    const client = await fixture();
    const one = await create(client, 'One', sample());
    const two = await create(client, 'Two');
    const cases = [
      { rowVersion: 0, document: sample() },
      { rowVersion: 2, name: 'Stale' },
      {
        rowVersion: 1,
        document: {
          ...sample(),
          ports: [...sample().ports, sample().ports[0]],
        },
      },
      {
        rowVersion: 1,
        document: {
          ...sample(),
          cables: [
            { ...sample().cables[0], targetPortId: 'foreign-board-port' },
          ],
        },
      },
      {
        rowVersion: 1,
        document: {
          ...sample(),
          cables: [{ ...sample().cables[0], targetPortId: 'port-a' }],
        },
      },
      {
        rowVersion: 1,
        document: {
          ...sample(),
          elements: [{ ...sample().elements[0], x: Number.POSITIVE_INFINITY }],
        },
      },
      { rowVersion: 1, document: { ...sample(), unexpected: true } },
    ];
    for (const payload of cases) {
      const response = await client.request(
        'PATCH',
        `/api/v1/boards/${one.id}`,
        payload,
      );
      expect([400, 409]).toContain(response.statusCode);
      expect(response.json().error.message).toBeTypeOf('string');
      expect(
        (await client.request('GET', `/api/v1/boards/${one.id}`)).json().board,
      ).toEqual(one);
    }
    expect(
      (await client.request('GET', `/api/v1/boards/${two.id}`)).json().board,
    ).toEqual(two);
    expect(
      (await client.request('GET', '/api/v1/boards/missing')).statusCode,
    ).toBe(404);
    expect(
      (
        await client.request('DELETE', `/api/v1/boards/${one.id}`, {
          rowVersion: 2,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await client.request('DELETE', `/api/v1/boards/${one.id}`, {
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(204);
  });

  it('duplicates and imports with fresh stable IDs while preserving layouts, properties and cable references', async () => {
    const client = await fixture();
    const original = await create(client, 'Original', sample());
    const cloneResponse = await client.request(
      'POST',
      `/api/v1/boards/${original.id}/duplicate`,
    );
    expect(cloneResponse.statusCode, cloneResponse.body).toBe(201);
    const cloned: BoardRecord = cloneResponse.json().board;
    expect(cloned.name).toBe('Original copy');
    expect(cloned.id).not.toBe(original.id);
    expect(cloned.document.elements[0]!.id).not.toBe(
      original.document.elements[0]!.id,
    );
    expect(cloned.document.ports[0]!.deviceId).toBe(
      cloned.document.elements[0]!.id,
    );
    expect(cloned.document.cables[0]!.sourcePortId).toBe(
      cloned.document.ports[0]!.id,
    );
    expect(cloned.document.ports[0]!.customFields).toEqual({
      enabled: false,
      capacity: 0,
    });
    const exported = await client.request(
      'GET',
      `/api/v1/boards/${original.id}/export`,
    );
    expect(exported.headers['content-disposition']).toContain(
      'portfolio-board-',
    );
    expect(exported.json()).toEqual({
      format: 'portfolio-board',
      schemaVersion: 1,
      name: 'Original',
      document: sample(),
    });
    const imported = await client.request(
      'POST',
      '/api/v1/boards/import',
      exported.json(),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json().board.document.viewport).toEqual(sample().viewport);
    const before = (await client.request('GET', '/api/v1/boards')).json();
    expect(
      (
        await client.request('POST', '/api/v1/boards/import', {
          ...exported.json<Record<string, unknown>>(),
          schemaVersion: 999,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await client.request('POST', '/api/v1/boards/import', {
          ...exported.json<Record<string, unknown>>(),
          document: { ...sample(), ports: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await client.request('GET', '/api/v1/boards')).json()).toEqual(
      before,
    );
  });

  it('requires authenticated same-origin CSRF-protected access, including encoded routes', async () => {
    const client = await fixture();
    const board = await create(client);
    const unauth = await client.app.inject({
      url: '/api/v1/boards',
      headers: { host: '127.0.0.1:3088' },
    });
    expect(unauth.statusCode).toBe(401);
    expect(
      (
        await client.request(
          'PATCH',
          `/api/v1/boards/${board.id}`,
          { rowVersion: 1, name: 'Forged' },
          { 'x-csrf-token': 'forged' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request(
          'DELETE',
          `/api/v1/boards/${board.id}`,
          { rowVersion: 1 },
          { origin: 'https://attacker.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.request('GET', '/%61pi/v1/boards', undefined, {
          host: 'attacker.invalid',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await client.request('GET', `/api/v1/boards/${board.id}`)).json().board,
    ).toEqual(board);
  });

  it('supports board documents above the legacy 1MiB limit, caps writes at 8MiB and bounds recursive JSON', async () => {
    const client = await fixture();
    const document = sample();
    document.elements[0]!.properties.large = Array.from({ length: 30 }, () =>
      'a'.repeat(48000),
    );
    const board = await create(client, 'Large', document);
    expect(board.document).toEqual(document);
    document.elements[0]!.properties.large = Array.from({ length: 190 }, () =>
      'a'.repeat(48000),
    );
    expect(
      (
        await client.request('PATCH', `/api/v1/boards/${board.id}`, {
          rowVersion: 1,
          document,
        })
      ).statusCode,
    ).toBe(413);
    const nested = sample();
    let cursor: Record<string, unknown> = {};
    nested.elements[0]!.properties.deep = cursor as never;
    for (let index = 0; index < 40; index++) {
      const next = {};
      cursor.next = next;
      cursor = next;
    }
    expect(
      (
        await client.request('POST', '/api/v1/boards', {
          name: 'Too deep',
          document: nested,
        })
      ).statusCode,
    ).toBe(400);
  });
});
