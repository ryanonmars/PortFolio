import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, validate } from './errors.js';
import type { User } from './security.js';

export interface ApiTokenSummary {
  id: string;
  name: string;
  access: 'read' | 'write';
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export interface IntegrationUser extends User {
  tokenId: string;
  access: 'read' | 'write';
}
export const hashApiToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
const tokenColumns =
  'id,name,access,created_at AS createdAt,expires_at AS expiresAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt';
const inputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  access: z.enum(['read', 'write']),
  expiresAt: z
    .number()
    .int()
    .safe()
    .refine((value) => value > Date.now(), 'Expiry must be in the future')
    .nullable()
    .optional(),
});
export function registerApiTokens(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => User,
) {
  // Tokens belong to the issuing account. Boards use the existing shared-admin policy.
  app.get('/api/v1/api-tokens', async (request) => {
    const user = requireAuth(request);
    return {
      tokens: db
        .prepare(
          `SELECT ${tokenColumns} FROM personal_api_tokens WHERE user_id = ? ORDER BY created_at DESC,id`,
        )
        .all(user.id) as unknown as ApiTokenSummary[],
    };
  });
  app.post(
    '/api/v1/api-tokens',
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      const user = requireAuth(request);
      const input = validate(inputSchema, request.body);
      const now = Date.now();
      const count = db
        .prepare(
          'SELECT count(*) AS count FROM personal_api_tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
        )
        .get(user.id, now) as { count: number };
      if (count.count >= 10)
        throw new ApiError(
          409,
          'TOKEN_LIMIT',
          'Revoke an active token before creating another',
        );
      const id = randomUUID();
      const plaintextToken = `pf_${randomBytes(32).toString('hex')}`;
      db.prepare(
        'INSERT INTO personal_api_tokens(id,user_id,name,access,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        user.id,
        input.name,
        input.access,
        hashApiToken(plaintextToken),
        now,
        input.expiresAt ?? null,
      );
      const token = db
        .prepare(`SELECT ${tokenColumns} FROM personal_api_tokens WHERE id = ?`)
        .get(id) as unknown as ApiTokenSummary;
      return reply.code(201).send({ token, plaintextToken });
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/v1/api-tokens/:id',
    async (request, reply) => {
      const user = requireAuth(request);
      const result = db
        .prepare(
          'UPDATE personal_api_tokens SET revoked_at = COALESCE(revoked_at,?) WHERE id = ? AND user_id = ?',
        )
        .run(Date.now(), request.params.id, user.id);
      if (!result.changes)
        throw new ApiError(404, 'NOT_FOUND', 'API token not found');
      return reply.code(204).send();
    },
  );
}
