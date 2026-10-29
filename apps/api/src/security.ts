import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { credentialsSchema } from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { createOriginPolicy } from './origin-policy.js';

const cookieName = 'portfolio_session';
const authenticatedAge = 7 * 24 * 60 * 60;
const anonymousAge = 60 * 60;
const scryptOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
let activePasswordOperations = 0;

function derive(password: string, salt: string): Promise<Buffer> {
  if (activePasswordOperations >= 2) {
    return Promise.reject(
      new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later'),
    );
  }
  activePasswordOperations += 1;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, scryptOptions, (error, key) => {
      activePasswordOperations -= 1;
      if (error) reject(error);
      else resolve(key);
    });
  });
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32).toString('hex');
  return `scrypt$131072$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
async function verifyPassword(
  password: string,
  encoded?: string,
): Promise<boolean> {
  const parts = encoded?.split('$');
  const salt =
    parts?.[4] ??
    '0000000000000000000000000000000000000000000000000000000000000000';
  const key = await derive(password, salt);
  const expected = Buffer.from(parts?.[5] ?? '00'.repeat(64), 'hex');
  return (
    expected.length === key.length &&
    timingSafeEqual(expected, key) &&
    Boolean(encoded)
  );
}
function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
interface Session {
  token_hash: string;
  user_id: string | null;
  csrf_token: string;
  expires_at: number;
  username: string | null;
  disabled: number | null;
}
export interface User {
  id: string;
  username: string;
}

export async function registerSecurity(
  app: FastifyInstance,
  db: DatabaseSync,
  publicOrigin?: string,
  localOrigin?: string,
  allowedOrigins: readonly string[] = [],
  trustedHosts?: readonly string[],
) {
  const policy = createOriginPolicy({
    publicOrigin,
    localOrigin,
    allowedOrigins,
    trustedHosts,
  });
  const requestOriginFor = (request: FastifyRequest) =>
    policy.originFor(
      request.headers.host,
      'encrypted' in request.raw.socket &&
        request.raw.socket.encrypted === true,
    );
  const secureCookie = (request: FastifyRequest) =>
    requestOriginFor(request)?.startsWith('https:') === true;
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 5,
    timeWindow: 15 * 60 * 1000,
  });
  const readSession = (request: FastifyRequest): Session | undefined => {
    const token = request.cookies[cookieName];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const session = db
      .prepare(
        `SELECT s.*, u.username, u.disabled FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(digest(token)) as Session | undefined;
    if (!session) return undefined;
    if (session.expires_at <= Date.now() || session.disabled === 1) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
        session.token_hash,
      );
      return undefined;
    }
    return session;
  };
  const requireAuth = (request: FastifyRequest): User => {
    const session = readSession(request);
    if (!session?.user_id || !session.username)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    return { id: session.user_id, username: session.username };
  };
  const rotate = (
    request: FastifyRequest,
    reply: FastifyReply,
    user: User | null,
  ) => {
    const previous = readSession(request);
    if (previous)
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
        previous.token_hash,
      );
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const maxAge = user ? authenticatedAge : anonymousAge;
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare(
      'INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)',
    ).run(
      digest(token),
      user?.id ?? null,
      csrfToken,
      Date.now() + maxAge * 1000,
      Date.now(),
    );
    reply.setCookie(cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie(request),
      maxAge,
    });
    return { user, csrfToken };
  };

  app.addHook('onRequest', async (request, reply) => {
    // Fastify can route absolute-form targets. Reject proxy-form requests before
    // dispatch so raw URL spelling cannot bypass the same-origin write guard.
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      throw new ApiError(
        400,
        'INVALID_REQUEST_TARGET',
        'Use a relative request target',
      );
    }
    const routePath = request.routeOptions.url ?? request.url;
    if (
      !routePath.startsWith('/api/v1/') &&
      !request.url.startsWith('/api/v1/')
    )
      return;
    reply.header('Cache-Control', 'no-store');
    const expectedOrigin = requestOriginFor(request);
    if (!expectedOrigin)
      throw new ApiError(
        403,
        'INVALID_ORIGIN',
        'Request origin is not allowed',
      );
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== expectedOrigin) {
      throw new ApiError(
        403,
        'INVALID_ORIGIN',
        'Request origin is not allowed',
      );
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (!requestOrigin) {
      throw new ApiError(
        403,
        'INVALID_ORIGIN',
        'Request origin is not allowed',
      );
    }
    const session = readSession(request);
    const token = request.headers['x-csrf-token'];
    if (
      !session ||
      typeof token !== 'string' ||
      !sameToken(token, session.csrf_token)
    ) {
      throw new ApiError(403, 'INVALID_CSRF', 'Refresh the page and try again');
    }
  });
  app.get('/api/v1/auth/setup-status', async () => ({
    setupRequired: !db.prepare('SELECT id FROM users LIMIT 1').get(),
  }));
  app.get(
    '/api/v1/auth/session',
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      const session = readSession(request);
      if (!session) return rotate(request, reply, null);
      return {
        user: session.user_id
          ? { id: session.user_id, username: session.username! }
          : null,
        csrfToken: session.csrf_token,
      };
    },
  );
  app.post(
    '/api/v1/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: 15 * 60 * 1000 } } },
    async (request, reply) => {
      if (db.prepare('SELECT id FROM users LIMIT 1').get())
        throw new ApiError(
          409,
          'SETUP_COMPLETE',
          'An administrator already exists',
        );
      const input = validate(credentialsSchema, request.body);
      const passwordHash = await hashPassword(input.password);
      const user = { id: randomUUID(), username: input.username };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('SELECT id FROM users LIMIT 1').get())
          throw new ApiError(
            409,
            'SETUP_COMPLETE',
            'An administrator already exists',
          );
        db.prepare(
          'INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)',
        ).run(user.id, user.username, passwordHash, Date.now(), Date.now());
        const session = rotate(request, reply, user);
        db.exec('COMMIT');
        return reply.code(201).send(session);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  );
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: 15 * 60 * 1000 } } },
    async (request, reply) => {
      const input = validate(credentialsSchema, request.body);
      const user = db
        .prepare(
          'SELECT id,username,password_hash,disabled FROM users WHERE username = ? COLLATE NOCASE',
        )
        .get(input.username) as
        | {
            id: string;
            username: string;
            password_hash: string;
            disabled: number;
          }
        | undefined;
      const valid = await verifyPassword(input.password, user?.password_hash);
      if (!valid || !user || user.disabled)
        throw new ApiError(
          401,
          'INVALID_CREDENTIALS',
          'Username or password is incorrect',
        );
      return rotate(request, reply, { id: user.id, username: user.username });
    },
  );
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = readSession(request);
    if (session)
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
        session.token_hash,
      );
    reply.clearCookie(cookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie(request),
    });
    return reply.code(204).send();
  });
  return { requireAuth };
}
