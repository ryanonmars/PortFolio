import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 3088);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535');
const app = await createApp({
  dataDir: process.env.DATA_DIR ?? './data',
  integrationAllowPrivateHttp:
    process.env.INTEGRATION_ALLOW_PRIVATE_HTTP === 'true',
  attachmentMaxFileBytes:
    process.env.ATTACHMENT_MAX_BYTES === undefined
      ? undefined
      : Number(process.env.ATTACHMENT_MAX_BYTES),
  attachmentMaxStorageBytes:
    process.env.ATTACHMENT_STORAGE_MAX_BYTES === undefined
      ? undefined
      : Number(process.env.ATTACHMENT_STORAGE_MAX_BYTES),
  logger: true,
  publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
  localOrigin: process.env.LOCAL_ORIGIN || undefined,
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustedHosts: process.env.TRUSTED_HOSTS?.trim()
    ? process.env.TRUSTED_HOSTS.split(',').map((host) => host.trim())
    : undefined,
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
