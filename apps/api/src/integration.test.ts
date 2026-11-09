import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture } from '../../../tests/support/api.js';
import { syntheticBoardProposal } from '../../../packages/shared/src/integration.js';

const clients: Awaited<ReturnType<typeof apiFixture>>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
async function fixture(access = 'write') {
  const c = await apiFixture(false, { integrationAllowPrivateHttp: true });
  clients.push(c);
  const token = (
    await c.request('POST', '/api/v1/api-tokens', {
      name: 'Synthetic agent',
      access,
    })
  ).json();
  const headers = {
    host: '127.0.0.1:3088',
    authorization: `Bearer ${token.plaintextToken}`,
  };
  const request = (method: 'GET' | 'POST', path: string, payload?: unknown) =>
    c.app.inject({
      method,
      url: '/api/v1/integration' + path,
      headers,
      payload: payload as Record<string, unknown>,
    });
  return { c, request, headers, token };
}
describe('authenticated integration API and atomic board proposals', () => {
  it('builds dozens of devices and hundreds of ports atomically with one proposal apply', async () => {
    const { request } = await fixture();
    const proposal = {
      name: 'Synthetic large inventory',
      devices: Array.from({ length: 36 }, (_, i) => ({
        id: `d-${i}`,
        name: `Device ${i}`,
        ports: Array.from({ length: 24 }, (_, p) => ({
          id: `p-${i}-${p}`,
          name: `Port ${p + 1}`,
          kind: 'rj45',
        })),
      })),
      connections: Array.from({ length: 35 }, (_, i) => ({
        id: `c-${i}`,
        sourcePortId: `p-${i}-1`,
        targetPortId: `p-${i + 1}-0`,
      })),
    };
    const p = (
      await request('POST', '/proposals/validate', { proposal })
    ).json();
    expect(p).toMatchObject({
      valid: true,
      summary: { devices: 36, ports: 864, cables: 35 },
    });
    const result = await request('POST', `/proposals/${p.proposalId}/apply`, {
      digest: p.digest,
      idempotencyKey: 'large-inventory',
      approved: true,
    });
    expect(result.statusCode, result.body).toBe(201);
    const board = result.json().board;
    const stored = (await request('GET', `/boards/${board.id}`)).json().board;
    expect(stored.document.ports).toHaveLength(864);
    expect(stored.document.cables).toHaveLength(35);
  });
  it('previews without creating, requires approval and digest, applies exactly once across restart and reads canonical objects', async () => {
    const { c, request } = await fixture();
    const preview = await request('POST', '/proposals/validate', {
      proposal: syntheticBoardProposal(),
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const result = preview.json();
    expect(result).toMatchObject({
      valid: true,
      summary: { devices: 9, networks: 3, unresolvedConnections: 1 },
    });
    expect((await request('GET', '/boards')).json().boards).toHaveLength(0);
    const path = `/proposals/${result.proposalId}/apply`;
    expect(
      (
        await request('POST', path, {
          digest: result.digest,
          idempotencyKey: 'test-import',
          approved: false,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', path, {
          digest: '0'.repeat(64),
          idempotencyKey: 'test-import',
          approved: true,
        })
      ).statusCode,
    ).toBe(409);
    const applied = await request('POST', path, {
      digest: result.digest,
      idempotencyKey: 'test-import',
      approved: true,
    });
    expect(applied.statusCode, applied.body).toBe(201);
    const { board } = applied.json();
    await c.restart();
    const replay = await request('POST', path, {
      digest: result.digest,
      idempotencyKey: 'test-import',
      approved: true,
    });
    expect(replay.json()).toMatchObject({
      replayed: true,
      board: { id: board.id },
    });
    expect((await request('GET', '/boards')).json().boards).toHaveLength(1);
    expect(
      (await request('GET', `/boards/${board.id}/devices`)).json().devices,
    ).toHaveLength(9);
    const networks = (
      await request('GET', `/boards/${board.id}/networks`)
    ).json().networks;
    expect(networks).toHaveLength(3);
    const n = networks[0];
    expect(
      (
        await request(
          'GET',
          `/boards/${board.id}/networks/${n.elementId}/${n.entryId}`,
        )
      ).json().network.entryId,
    ).toBe(n.entryId);
    expect(
      (await c.request('GET', `/api/v1/boards/${board.id}/export`)).json()
        .document,
    ).toEqual(board.document);
  });
  it('rejects malformed previews, token mixing, expiry, conflicting retry keys and read-only writes', async () => {
    const { c, request } = await fixture();
    const invalid = await request('POST', '/proposals/validate', {
      proposal: {
        name: 'Invalid',
        devices: [
          { id: 'a', name: 'A', ports: [{ id: 'p', kind: 'unsupported' }] },
        ],
      },
    });
    expect(invalid.json()).toMatchObject({ valid: false });
    expect(invalid.json().proposalId).toBeUndefined();
    const a = (
      await request('POST', '/proposals/validate', { proposal: { name: 'A' } })
    ).json();
    const b = (
      await request('POST', '/proposals/validate', { proposal: { name: 'B' } })
    ).json();
    const other = await fixture('read');
    expect(
      (
        await other.request('POST', '/proposals/validate', {
          proposal: { name: 'Read only preview' },
        })
      ).json().valid,
    ).toBe(true);
    expect(
      (
        await other.request('POST', `/proposals/${a.proposalId}/apply`, {
          digest: a.digest,
          idempotencyKey: 'no',
          approved: true,
        })
      ).statusCode,
    ).toBe(403);
    const secondToken = (
      await c.request('POST', '/api/v1/api-tokens', {
        name: 'Other token',
        access: 'write',
      })
    ).json();
    expect(
      (
        await c.app.inject({
          method: 'POST',
          url: `/api/v1/integration/proposals/${a.proposalId}/apply`,
          headers: {
            host: '127.0.0.1:3088',
            authorization: `Bearer ${secondToken.plaintextToken}`,
          },
          payload: { digest: a.digest, idempotencyKey: 'no', approved: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request('POST', `/proposals/${a.proposalId}/apply`, {
          digest: a.digest,
          idempotencyKey: 'same',
          approved: true,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await request('POST', `/proposals/${b.proposalId}/apply`, {
          digest: b.digest,
          idempotencyKey: 'same',
          approved: true,
        })
      ).statusCode,
    ).toBe(409);
    c.db
      .prepare('UPDATE integration_proposals SET expires_at=0 WHERE id=?')
      .run(b.proposalId);
    expect(
      (
        await request('POST', `/proposals/${b.proposalId}/apply`, {
          digest: b.digest,
          idempotencyKey: 'new',
          approved: true,
        })
      ).statusCode,
    ).toBe(410);
    expect((await request('GET', '/boards')).json().boards).toHaveLength(1);
  });
  it('uses optimistic versions, persists batch changes, scopes nested IDs and rolls back a failed batch', async () => {
    const { c, request } = await fixture();
    const p = (
      await request('POST', '/proposals/validate', {
        proposal: { name: 'Editable' },
      })
    ).json();
    const first = (
      await request('POST', `/proposals/${p.proposalId}/apply`, {
        digest: p.digest,
        idempotencyKey: 'editable',
        approved: true,
      })
    ).json().board;
    const commands = [
      {
        operation: 'create_device',
        device: { id: 'device', name: 'Router', ports: [{ id: 'port' }] },
      },
    ];
    const changed = await request('POST', `/boards/${first.id}/commands`, {
      rowVersion: first.rowVersion,
      commands,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const board = changed.json().board;
    expect(
      (
        await request('POST', `/boards/${first.id}/commands`, {
          rowVersion: first.rowVersion,
          commands,
        })
      ).statusCode,
    ).toBe(409);
    const failed = await request('POST', `/boards/${first.id}/commands`, {
      rowVersion: board.rowVersion,
      commands: [
        {
          operation: 'update_device',
          deviceId: 'device',
          patch: { name: 'Should roll back' },
        },
        {
          operation: 'connect_ports',
          connection: {
            id: 'c',
            sourcePortId: 'port',
            targetPortId: 'foreign',
          },
        },
      ],
    });
    expect(failed.statusCode).toBe(400);
    expect((await request('GET', `/boards/${first.id}`)).json().board).toEqual(
      board,
    );
    expect(
      (await request('GET', `/boards/not-this-board/devices/device`))
        .statusCode,
    ).toBe(404);
    await c.restart();
    expect(
      (await request('GET', `/boards/${first.id}/devices/device`)).json().device
        .name,
    ).toBe('Router');
    expect(
      (await request('GET', `/boards/${first.id}/layout`)).json().elements[0]
        .width,
    ).toBeGreaterThanOrEqual(160);
  });
  it('rolls back a newly inserted board if the proposal receipt fails and detects changed stored content', async () => {
    const { c, request } = await fixture();
    const p = (
      await request('POST', '/proposals/validate', {
        proposal: { name: 'Atomic failure' },
      })
    ).json();
    c.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE ON integration_proposals BEGIN SELECT RAISE(ABORT,'Synthetic receipt failure'); END",
    );
    const failure = await request('POST', `/proposals/${p.proposalId}/apply`, {
      digest: p.digest,
      idempotencyKey: 'atomic',
      approved: true,
    });
    expect(failure.statusCode).toBe(400);
    expect(failure.json().error.code).toBe('INVALID_CONFIGURATION');
    expect((await request('GET', '/boards')).json().boards).toHaveLength(0);
    expect(
      c.db
        .prepare(
          'SELECT applied_board_id FROM integration_proposals WHERE id=?',
        )
        .get(p.proposalId)?.applied_board_id,
    ).toBeNull();
    c.db.exec('DROP TRIGGER reject_receipt');
    c.db
      .prepare('UPDATE integration_proposals SET proposal_json=? WHERE id=?')
      .run('{"name":"Tampered"}', p.proposalId);
    expect(
      (
        await request('POST', `/proposals/${p.proposalId}/apply`, {
          digest: p.digest,
          idempotencyKey: 'atomic',
          approved: true,
        })
      ).statusCode,
    ).toBe(409);
    expect((await request('GET', '/boards')).json().boards).toHaveLength(0);
  });
  it('limits pending previews, rejects complex and excessive inputs and never recreates removed imports', async () => {
    const { c, request } = await fixture();
    let nested: unknown = 'leaf';
    for (let i = 0; i < 40; i++) nested = { child: nested };
    expect(
      (await request('POST', '/proposals/validate', { proposal: nested }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', '/proposals/validate', {
          proposal: {
            name: 'Too big',
            devices: Array.from({ length: 257 }, (_, i) => ({
              id: String(i),
              name: '',
            })),
          },
        })
      ).json().valid,
    ).toBe(false);
    const first = (
      await request('POST', '/proposals/validate', {
        proposal: { name: 'Removed' },
      })
    ).json();
    const apply = {
      digest: first.digest,
      idempotencyKey: 'removed',
      approved: true,
    };
    const board = (
      await request('POST', `/proposals/${first.proposalId}/apply`, apply)
    ).json().board;
    await c.request('DELETE', `/api/v1/boards/${board.id}`, {
      rowVersion: board.rowVersion,
    });
    expect(
      (await request('POST', `/proposals/${first.proposalId}/apply`, apply))
        .statusCode,
    ).toBe(410);
    for (let i = 0; i < 20; i++)
      expect(
        (
          await request('POST', '/proposals/validate', {
            proposal: { name: `Pending${i}` },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await request('POST', '/proposals/validate', {
          proposal: { name: 'Limit' },
        })
      ).statusCode,
    ).toBe(429);
    expect((await request('GET', '/boards')).json().boards).toHaveLength(0);
  });
});
