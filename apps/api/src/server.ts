import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 3088);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535');
const app = await createApp({
  dataDir: process.env.DATA_DIR ?? './data',
  logger: true,
  publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  localOrigin: process.env.LOCAL_ORIGIN,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
try {
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
