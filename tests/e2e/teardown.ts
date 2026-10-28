import { rm } from 'node:fs/promises';
import type { FullConfig } from '@playwright/test';

export default async function teardown(config: FullConfig) {
  const { e2eDataDir, ownsDataDir } = config.metadata;
  // A caller-supplied directory is never owned or removed by this test run.
  if (ownsDataDir === true && typeof e2eDataDir === 'string')
    await rm(e2eDataDir, { recursive: true, force: true });
}
