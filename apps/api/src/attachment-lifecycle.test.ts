import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import {
  emptyBoardDocument,
  type BoardRecord,
} from '../../../packages/shared/src/board.js';
import {
  attachmentPath,
  type AttachmentOwner,
} from '../../../packages/shared/src/attachments.js';
const clients: Awaited<ReturnType<typeof apiFixture>>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture() {
  const client = await apiFixture(false);
  clients.push(client);
  const document = emptyBoardDocument();
  const base = {
    name: 'Duplicate',
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    z: 0,
    color: '',
  };
  document.elements = [
    { ...base, id: 'device', type: 'device', properties: {} },
    {
      ...base,
      id: 'network',
      type: 'network',
      properties: {
        entries: [
          { networkEntryId: 'first', vlanId: '20', vlanName: 'Duplicate' },
          { networkEntryId: 'second', vlanId: '20', vlanName: 'Duplicate' },
        ],
      },
    },
  ];
  const board = (
    await client.request('POST', '/api/v1/boards', {
      name: 'Attachment lifecycle',
      document,
    })
  ).json().board as BoardRecord;
  return { client, board };
}
const route = (
  boardId: string,
  owner: AttachmentOwner,
  id?: string,
  variant?: 'original',
) => '/api/v1' + attachmentPath(boardId, owner, id, variant);

describe('attachments and canonical board lifecycle', () => {
  it('retains exact VLAN attachments during deletion and restores them on board undo without linking sibling VLANs', async () => {
    const { client, board } = await fixture();
    const owner: AttachmentOwner = {
      type: 'network',
      elementId: 'network',
      entryId: 'first',
    };
    const url = route(board.id, owner);
    const uploaded = await client.request(
      'POST',
      url + '&filename=config.txt',
      Buffer.from('Documented configuration'),
      { 'content-type': 'application/octet-stream' },
    );
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const attachment = uploaded.json().attachment as {
      id: string;
      rowVersion: number;
    };
    const next = structuredClone(board.document);
    next.elements[1]!.properties.entries = [
      { networkEntryId: 'second', vlanId: '20', vlanName: 'Duplicate' },
    ];
    const changed = await client.request(
      'PATCH',
      `/api/v1/boards/${board.id}`,
      { document: next, rowVersion: board.rowVersion },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      client.db
        .prepare('SELECT orphaned_at FROM board_attachments WHERE id=?')
        .get(attachment.id)?.orphaned_at,
    ).toEqual(expect.any(Number));
    expect((await client.request('GET', url)).statusCode).toBe(404);
    expect(
      (
        await client.request(
          'GET',
          route(board.id, { ...owner, entryId: 'second' }),
        )
      ).json().attachments,
    ).toEqual([]);
    const restored = await client.request(
      'PATCH',
      `/api/v1/boards/${board.id}`,
      { document: board.document, rowVersion: changed.json().board.rowVersion },
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await client.request('GET', url)).json().attachments).toMatchObject(
      [{ id: attachment.id, available: true }],
    );
    expect(
      (
        await client.request(
          'GET',
          route(board.id, owner, attachment.id, 'original'),
        )
      ).body,
    ).toBe('Documented configuration');
    const rejected = await client.request(
      'PATCH',
      `/api/v1/boards/${board.id}`,
      { document: next, rowVersion: board.rowVersion },
    );
    expect(rejected.statusCode).toBe(409);
    expect(
      client.db
        .prepare('SELECT orphaned_at FROM board_attachments WHERE id=?')
        .get(attachment.id)?.orphaned_at,
    ).toBeNull();
    const deletion = await client.request(
      'DELETE',
      `/api/v1/boards/${board.id}`,
      { rowVersion: restored.json().board.rowVersion },
    );
    expect(deletion.statusCode, deletion.body).toBe(204);
    expect(
      client.db
        .prepare('SELECT orphaned_at FROM board_attachments WHERE id=?')
        .get(attachment.id)?.orphaned_at,
    ).toEqual(expect.any(Number));
  });
  it('keeps ordinary JSON lightweight and never grants imported or duplicated objects access to source files', async () => {
    const { client, board } = await fixture();
    const owner: AttachmentOwner = { type: 'device', elementId: 'device' };
    const upload = await client.request(
      'POST',
      route(board.id, owner) + '&filename=notes.txt',
      Buffer.from('Private documentation bytes'),
      { 'content-type': 'application/octet-stream' },
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const id = upload.json().attachment.id as string;
    const exported = await client.request(
      'GET',
      `/api/v1/boards/${board.id}/export`,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.json().document).toEqual(board.document);
    expect(exported.body).not.toContain(id);
    expect(exported.body).not.toContain('Private documentation bytes');
    const archive = exported.json();
    archive.document.elements[0].properties.attachments = [
      { id, boardId: board.id, storagePath: '../../outside' },
    ];
    const imported = await client.request(
      'POST',
      '/api/v1/boards/import',
      archive,
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const target = imported.json().board as BoardRecord;
    const importedOwner: AttachmentOwner = {
      type: 'device',
      elementId: target.document.elements[0]!.id,
    };
    expect(
      (await client.request('GET', route(target.id, importedOwner))).json()
        .attachments,
    ).toEqual([]);
    expect(
      (
        await client.request(
          'GET',
          route(target.id, importedOwner, id, 'original'),
        )
      ).statusCode,
    ).toBe(404);
    const duplicate = await client.request(
      'POST',
      `/api/v1/boards/${board.id}/duplicate`,
      {},
    );
    expect(duplicate.statusCode).toBe(201);
    const copy = duplicate.json().board as BoardRecord;
    expect(
      (
        await client.request(
          'GET',
          route(copy.id, {
            type: 'device',
            elementId: copy.document.elements[0]!.id,
          }),
        )
      ).json().attachments,
    ).toEqual([]);
  });
});

it('keeps legacy network identities stable through restart and applies authentication, CSRF and safe download headers', async () => {
  const { client, board } = await fixture();
  const legacy = structuredClone(board.document);
  legacy.elements[1]!.properties.entries = [
    { vlanId: '20', vlanName: 'Legacy without an entry ID' },
  ];
  client.db
    .prepare('UPDATE boards SET document_json=? WHERE id=?')
    .run(JSON.stringify(legacy), board.id);
  const normalized = (
    await client.request('GET', `/api/v1/boards/${board.id}`)
  ).json().board as BoardRecord;
  const entry = (
    normalized.document.elements[1]!.properties.entries as {
      networkEntryId: string;
    }[]
  )[0]!;
  const owner: AttachmentOwner = {
    type: 'network',
    elementId: 'network',
    entryId: entry.networkEntryId,
  };
  const path = route(board.id, owner);
  const bytes = Buffer.from('Optional documentation');
  const denied = await client.request(
    'POST',
    path + '&filename=reference.txt',
    bytes,
    { 'content-type': 'application/octet-stream', 'x-csrf-token': 'wrong' },
  );
  expect(denied.statusCode).toBe(403);
  expect(denied.json().error.code).toBe('INVALID_CSRF');
  expect(
    (await client.request('GET', path, undefined, { cookie: '' })).statusCode,
  ).toBe(401);
  const uploaded = await client.request(
    'POST',
    path + '&filename=reference.txt',
    bytes,
    { 'content-type': 'application/octet-stream' },
  );
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const attachmentId = uploaded.json().attachment.id as string;
  await client.restart();
  expect((await client.request('GET', path)).json().attachments).toMatchObject([
    { id: attachmentId, available: true },
  ]);
  const file = await client.request(
    'GET',
    route(board.id, owner, attachmentId, 'original'),
  );
  expect(file.rawPayload).toEqual(bytes);
  expect(file.headers['content-security-policy']).toBe(
    "sandbox; default-src 'none'",
  );
  expect(file.headers['content-disposition']).toContain('attachment;');
  expect(file.headers['x-content-type-options']).toBe('nosniff');
  expect(file.headers['cache-control']).toBe('private, no-store');
  expect(
    (
      await client.request(
        'GET',
        route(board.id, owner, attachmentId, 'original'),
        undefined,
        { cookie: '' },
      )
    ).statusCode,
  ).toBe(401);
});
