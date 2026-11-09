import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

/** Admission precedes authentication because authentication itself touches SQLite. */
export function registerMaintenance(app: FastifyInstance) {
  let maintenance = false;
  let busy = false;
  const active = new Set<FastifyRequest>();
  const states = new WeakMap<
    FastifyRequest,
    {
      started: boolean;
      finished: boolean;
      transportFinished: boolean;
      parsing: boolean;
    }
  >();
  const waiters = new Set<() => void>();
  const done = (request: FastifyRequest) => {
    const state = states.get(request);
    if (!state?.finished || !state.transportFinished) return;
    active.delete(request);
    for (const notify of waiters) notify();
  };
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const state = states.get(request);
      if (state?.transportFinished)
        throw new ApiError(400, 'REQUEST_ABORTED', 'Request was interrupted');
      if (state) state.started = true;
      try {
        return await handler.call(this, request, reply);
      } finally {
        if (state) state.finished = true;
        done(request);
      }
    };
  });
  app.addHook('onRequest', async (request, reply) => {
    if (maintenance) {
      reply.header('Retry-After', '5');
      throw new ApiError(
        503,
        'MAINTENANCE',
        'Application recovery is in progress. Try again shortly',
      );
    }
    active.add(request);
    const state = {
      started: false,
      finished: false,
      transportFinished: false,
      parsing: false,
    };
    states.set(request, state);
    reply.raw.once('close', () => {
      state.transportFinished = true;
      if (!state.started && state.parsing) state.finished = true;
      done(request);
    });
  });
  app.addHook('preParsing', async (request, _reply, payload) => {
    const state = states.get(request);
    if (state) {
      state.parsing = true;
      if (state.transportFinished) {
        state.finished = true;
        done(request);
      }
    }
    return payload;
  });
  app.addHook('onResponse', async (request) => {
    const state = states.get(request);
    if (state) {
      state.transportFinished = true;
      if (!state.started) state.finished = true;
    }
    done(request);
  });
  return {
    acquire() {
      if (busy)
        throw new ApiError(
          409,
          'BACKUP_BUSY',
          'Another backup or restore is in progress',
        );
      busy = true;
      let released = false;
      return () => {
        if (!released) {
          busy = false;
          released = true;
        }
      };
    },
    enter() {
      maintenance = true;
    },
    resume() {
      maintenance = false;
    },
    async drain(except?: FastifyRequest, timeoutMs = 65_000) {
      const empty = () =>
        active.size === 0 ||
        (active.size === 1 && !!except && active.has(except));
      if (empty()) return;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (empty()) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new ApiError(
              409,
              'APPLICATION_BUSY',
              'Wait for active requests to finish and try again',
            ),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    get active() {
      return maintenance;
    },
  };
}
export type Maintenance = ReturnType<typeof registerMaintenance>;
