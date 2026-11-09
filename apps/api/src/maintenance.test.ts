import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import { expect, it } from 'vitest';
import { registerMaintenance } from './maintenance.js';

it('rejects new requests while draining an already admitted request', async () => {
  const app = Fastify();
  const gate = registerMaintenance(app);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.get('/slow', async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true };
  });
  app.get('/fast', async () => ({ ok: true }));
  const slow = app.inject('/slow');
  await started;
  gate.enter();
  let drained = false;
  const drain = gate.drain(undefined, 1000).then(() => {
    drained = true;
  });
  expect((await app.inject('/fast')).statusCode).toBe(503);
  expect(drained).toBe(false);
  release();
  await slow;
  await drain;
  gate.resume();
  expect((await app.inject('/fast')).statusCode).toBe(200);
  await app.close();
});

it('releases an aborted request body before its handler starts', async () => {
  const app = Fastify();
  const gate = registerMaintenance(app);
  let closed!: () => void;
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  app.addHook('onRequest', async (request) => {
    request.raw.once('close', closed);
  });
  app.post('/body', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  const request = httpRequest({
    host: '127.0.0.1',
    port: address.port,
    path: '/body',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '100' },
  });
  request.on('error', () => {});
  request.write('{');
  await new Promise<void>((resolve) =>
    app.server.once('request', () => resolve()),
  );
  request.destroy();
  await ended;
  gate.enter();
  try {
    await expect(gate.drain(undefined, 100)).resolves.toBeUndefined();
  } finally {
    gate.resume();
    await app.close();
  }
});

it('keeps a disconnected async handler in the drain until its work finishes', async () => {
  const app = Fastify();
  const gate = registerMaintenance(app);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.get('/work', async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  const request = httpRequest({
    host: '127.0.0.1',
    port: address.port,
    path: '/work',
  });
  request.on('error', () => {});
  request.end();
  await started;
  request.destroy();
  gate.enter();
  let drained = false;
  const drain = gate.drain(undefined, 1000).then(() => {
    drained = true;
  });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    release();
    await drain;
  } finally {
    gate.resume();
    release();
    await app.close();
  }
});
