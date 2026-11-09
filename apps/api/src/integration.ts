import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  validateBoardProposal,
  boardProposalSchema,
} from '../../../packages/shared/src/integration.js';
import {
  applyIntegrationCommands,
  integrationEditSchema,
} from '../../../packages/shared/src/integration-commands.js';
import type { BoardDocument } from '../../../packages/shared/src/board.js';
import { ApiError, validate } from './errors.js';
import type { IntegrationUser } from './api-tokens.js';
import { guardJson, type BoardService } from './boards.js';
import { mutation, staleVersion, transaction } from './resources.js';

const prefix = '/api/v1/integration';
const previewInput = z.object({ proposal: z.unknown() }).strict();
const applyInput = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[\w.-]+$/),
    approved: z.literal(true),
  })
  .strict();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
interface StoredProposal {
  id: string;
  user_id: string;
  token_id: string;
  digest: string;
  proposal_json: string;
  expires_at: number;
  applied_board_id: string | null;
  idempotency_key: string | null;
}

function networks(document: BoardDocument) {
  return document.elements
    .filter((e) => e.type === 'network')
    .flatMap((e) => {
      if (!Array.isArray(e.properties.entries)) return [];
      return e.properties.entries.flatMap((entry) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          typeof entry.networkEntryId !== 'string'
        )
          return [];
        return [
          {
            elementId: e.id,
            entryId: entry.networkEntryId,
            containerName: e.name,
            configuration: entry,
          },
        ];
      });
    });
}
/** Bearer-only, bounded non-destructive surface; normal browser routes remain session-only. */
export function registerIntegration(
  app: FastifyInstance,
  db: DatabaseSync,
  boards: BoardService,
  requireAuth: (request: FastifyRequest) => IntegrationUser,
) {
  const route = {
    bodyLimit: 8 * 1024 * 1024,
    config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    preHandler: async (request: FastifyRequest) => {
      requireAuth(request);
    },
  };
  const params = (r: FastifyRequest) => r.params as Record<string, string>;
  const boardFor = (r: FastifyRequest) => boards.get(params(r).boardId!);
  app.get(prefix + '/boards', route, async () => boards.list());
  app.get(prefix + '/boards/:boardId', route, async (r) => ({
    board: boardFor(r),
  }));
  app.get(prefix + '/boards/:boardId/devices', route, async (r) => ({
    devices: boardFor(r).document.elements.filter((e) => e.type === 'device'),
  }));
  app.get(prefix + '/boards/:boardId/devices/:deviceId', route, async (r) => {
    const { document } = boardFor(r);
    const device = document.elements.find(
      (e) => e.id === params(r).deviceId && e.type === 'device',
    );
    if (!device)
      throw new ApiError(404, 'NOT_FOUND', 'Device not found on this board');
    const ports = document.ports.filter((p) => p.deviceId === device.id);
    const ids = new Set(ports.map((p) => p.id));
    return {
      device,
      ports,
      connections: document.cables.filter(
        (c) => ids.has(c.sourcePortId) || ids.has(c.targetPortId),
      ),
    };
  });
  app.get(prefix + '/boards/:boardId/networks', route, async (r) => ({
    networks: networks(boardFor(r).document),
  }));
  app.get(
    prefix + '/boards/:boardId/networks/:elementId/:entryId',
    route,
    async (r) => {
      const network = networks(boardFor(r).document).find(
        (n) =>
          n.elementId === params(r).elementId &&
          n.entryId === params(r).entryId,
      );
      if (!network)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Network entry not found in this board container',
        );
      return { network };
    },
  );
  app.get(prefix + '/boards/:boardId/connections', route, async (r) => ({
    connections: boardFor(r).document.cables,
  }));
  app.get(prefix + '/boards/:boardId/layout', route, async (r) => {
    const { document } = boardFor(r);
    return {
      elements: document.elements.map(
        ({ id, type, x, y, width, height, z }) => ({
          id,
          type,
          x,
          y,
          width,
          height,
          z,
        }),
      ),
      viewport: document.viewport,
    };
  });
  app.post(prefix + '/proposals/validate', route, async (r) => {
    guardJson(r.body);
    const user = requireAuth(r);
    const { proposal } = validate(previewInput, r.body);
    const preview = validateBoardProposal(proposal);
    if (!preview.valid) return preview;
    const now = Date.now();
    // Expired unapplied content is disposable. Applied retry receipts are retained.
    db.prepare(
      'DELETE FROM integration_proposals WHERE applied_board_id IS NULL AND expires_at<?',
    ).run(now);
    const pending = db
      .prepare(
        'SELECT count(*) AS count FROM integration_proposals WHERE token_id=? AND applied_board_id IS NULL',
      )
      .get(user.tokenId) as { count: number };
    if (pending.count >= 20)
      throw new ApiError(
        429,
        'PROPOSAL_LIMIT',
        'At most 20 pending proposals per token; wait for an existing preview to expire',
      );
    const proposalJson = JSON.stringify({
      proposal: boardProposalSchema.parse(proposal),
      document: preview.document,
    });
    const digest = hash(proposalJson);
    const proposalId = randomUUID();
    const expiresAt = now + 60 * 60 * 1000;
    db.prepare(
      'INSERT INTO integration_proposals(id,user_id,token_id,digest,proposal_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
    ).run(
      proposalId,
      user.id,
      user.tokenId,
      digest,
      proposalJson,
      now,
      expiresAt,
    );
    return {
      ...preview,
      proposalId,
      digest,
      expiresAt,
      approvalRequired: true,
    };
  });
  app.post(prefix + '/proposals/:proposalId/apply', route, async (r, reply) => {
    guardJson(r.body);
    const user = requireAuth(r);
    const input = validate(applyInput, r.body);
    const result = mutation(() =>
      transaction(db, () => {
        const stored = db
          .prepare(
            'SELECT * FROM integration_proposals WHERE id=? AND user_id=? AND token_id=?',
          )
          .get(params(r).proposalId!, user.id, user.tokenId) as
          StoredProposal | undefined;
        if (!stored)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Proposal not found for this token',
          );
        if (
          !timingSafeEqual(
            Buffer.from(stored.digest),
            Buffer.from(input.digest),
          ) ||
          hash(stored.proposal_json) !== stored.digest
        )
          throw new ApiError(
            409,
            'PROPOSAL_CHANGED',
            'The proposal integrity check failed; validate and review a new proposal',
          );
        if (stored.applied_board_id) {
          if (stored.idempotency_key !== input.idempotencyKey)
            throw new ApiError(
              409,
              'ALREADY_APPLIED',
              'This proposal was applied with a different idempotency key',
            );
          const exists = db
            .prepare('SELECT id FROM boards WHERE id=?')
            .get(stored.applied_board_id);
          if (!exists)
            throw new ApiError(
              410,
              'IMPORTED_BOARD_REMOVED',
              'The imported board has since been removed; this retry will not recreate it',
            );
          return { board: boards.get(stored.applied_board_id), replayed: true };
        }
        if (stored.expires_at <= Date.now())
          throw new ApiError(
            410,
            'PROPOSAL_EXPIRED',
            'This preview expired; validate and review it again',
          );
        const previous = db
          .prepare(
            'SELECT id FROM integration_proposals WHERE token_id=? AND idempotency_key=?',
          )
          .get(user.tokenId, input.idempotencyKey);
        if (previous)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key belongs to a different proposal',
          );
        const saved = JSON.parse(stored.proposal_json) as {
          proposal: unknown;
          document: BoardDocument;
        };
        const preview = validateBoardProposal(saved.proposal);
        if (!preview.valid || !preview.document || !preview.name)
          throw new ApiError(
            409,
            'PROPOSAL_INVALID',
            'The saved proposal no longer passes validation',
          );
        if (JSON.stringify(preview.document) !== JSON.stringify(saved.document))
          throw new ApiError(
            409,
            'PREVIEW_CHANGED',
            'The generated layout changed; validate and review a new preview',
          );
        const board = boards.insert(preview.name, null, preview.document);
        db.prepare(
          'UPDATE integration_proposals SET applied_board_id=?,idempotency_key=? WHERE id=?',
        ).run(board.id, input.idempotencyKey, stored.id);
        return { board, replayed: false };
      }),
    );
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.post(prefix + '/boards/:boardId/commands', route, async (r) => {
    guardJson(r.body);
    const input = validate(integrationEditSchema, r.body);
    return mutation(() =>
      transaction(db, () => {
        const current = boardFor(r);
        if (current.rowVersion !== input.rowVersion) staleVersion();
        let document: BoardDocument;
        try {
          document = applyIntegrationCommands(current.document, input.commands);
        } catch (error) {
          throw new ApiError(
            400,
            'INVALID_BOARD_EDIT',
            error instanceof Error
              ? error.message.slice(0, 2000)
              : 'Invalid board edit',
          );
        }
        const name = input.commands
          .filter((c) => c.operation === 'update_board')
          .at(-1)?.name;
        return {
          board: boards.update(current.id, {
            rowVersion: input.rowVersion,
            document,
            ...(name ? { name } : {}),
          }),
        };
      }),
    );
  });
}
