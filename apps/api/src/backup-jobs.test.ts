import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../packages/db/src/index.js';
import { createBackupJob, validateBackupJob } from './backup-jobs.js';
import { createDatabaseRuntime } from './database-runtime.js';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'portfolio-backup-worker-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('rejects a stale server owner before opening the live database', async () => {
  const dataDir = fixture();
  const runtime = createDatabaseRuntime(dataDir);
  try {
    await expect(
      createBackupJob(dataDir, join(fixture(), 'stale.zip'), {
        instanceOwner: 'previous-server',
      }),
    ).rejects.toThrow(/lease|owner/i);
    await expect(
      createBackupJob(dataDir, join(fixture(), 'current.zip'), {
        instanceOwner: runtime.owner,
      }),
    ).resolves.toMatchObject({ compatibility: 'compatible' });
  } finally {
    runtime.dispose();
  }
});

it('runs complete creation and validation in bounded background jobs while WAL edits continue', async () => {
  const dataDir = fixture();
  const db = openDatabase({ dataDir });
  try {
    db.prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)').run(
      'worker-test',
      'before',
    );
    const destination = join(fixture(), 'backup.zip');
    const backup = createBackupJob(dataDir, destination);
    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats++;
      db.prepare(
        "UPDATE app_metadata SET value='during' WHERE key='worker-test'",
      ).run();
    }, 10);
    let summary;
    try {
      summary = await backup;
    } finally {
      clearInterval(timer);
    }
    expect(heartbeats).toBeGreaterThan(0);
    expect(summary.compatibility).toBe('compatible');
    expect(readFileSync(destination).subarray(0, 2).toString()).toBe('PK');
    const ready = join(fixture(), 'ready');
    const validated = await validateBackupJob(destination, ready);
    expect(validated.manifest).toEqual(summary.manifest);
    const restored = openDatabase({ dataDir: ready });
    try {
      expect(
        restored
          .prepare("SELECT value FROM app_metadata WHERE key='worker-test'")
          .get(),
      ).toMatchObject({ value: expect.stringMatching(/before|during/) });
    } finally {
      restored.close();
    }
  } finally {
    db.close();
  }
});

it('hard-bounds a job deadline and remains usable for the next operation', async () => {
  const dataDir = fixture();
  const db = openDatabase({ dataDir });
  db.close();
  await expect(
    createBackupJob(dataDir, join(fixture(), 'timeout.zip'), {
      maxDurationMs: 1,
    }),
  ).rejects.toThrow(/time|deadline/i);
  await expect(
    createBackupJob(dataDir, join(fixture(), 'valid.zip')),
  ).resolves.toMatchObject({ compatibility: 'compatible' });
});

it('terminates an interrupted worker before returning control for filesystem cleanup', async () => {
  const dataDir = fixture();
  const db = openDatabase({ dataDir });
  db.close();
  const controller = new AbortController();
  const pending = createBackupJob(dataDir, join(fixture(), 'cancelled.zip'), {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow(/abort|cancel/i);
  await expect(
    validateBackupJob(join(dataDir, 'missing.zip'), join(fixture(), 'ready')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
