import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.js';

describe('attachment configuration', () => {
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid byte limits before opening data (%s)',
    async (limit) => {
      const root = mkdtempSync(join(tmpdir(), 'portfolio-attachment-config-'));
      try {
        const dataDir = join(root, 'data');
        for (const key of [
          'attachmentMaxFileBytes',
          'attachmentMaxStorageBytes',
        ] as const) {
          await expect(createApp({ dataDir, [key]: limit })).rejects.toThrow(
            'positive safe integer',
          );
          expect(existsSync(dataDir)).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
