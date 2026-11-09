import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  PortableBackupOptions,
  PortableBackupSummary,
} from '../../../packages/db/src/portable-backup.js';

export type BackupJob = {
  kind: 'create' | 'validate';
  source: string;
  destination: string;
  options: Omit<PortableBackupOptions, 'signal'>;
  instanceOwner?: string;
};
interface BackupJobOptions extends PortableBackupOptions {
  instanceOwner?: string;
}
type Result =
  { summary: PortableBackupSummary } | { error: string; code?: string };

/** Run native SQLite checks and hashing off the request event loop.
 * Callers clean their private directory after rejection, which waits for exit.
 */
async function runJob(
  kind: BackupJob['kind'],
  source: string,
  destination: string,
  options: BackupJobOptions,
): Promise<PortableBackupSummary> {
  const { signal, instanceOwner, ...limits } = options;
  signal?.throwIfAborted();
  const duration = limits.maxDurationMs ?? 15 * 60_000;
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > 2_147_483_647
  )
    throw new Error('Invalid backup job deadline');
  const sourceRun = import.meta.url.endsWith('.ts');
  const scratch = mkdtempSync(join(dirname(destination), '.backup-job-'));
  const worker = fork(
    fileURLToPath(
      new URL(
        sourceRun ? './backup-worker.ts' : './backup-worker.js',
        import.meta.url,
      ),
    ),
    [],
    {
      execArgv: [
        ...(sourceRun ? ['--import', 'tsx'] : []),
        '--max-old-space-size=256',
        '--stack-size=4096',
      ],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    },
  );
  return new Promise((resolve, reject) => {
    let result: Result | undefined;
    let failure: Error | undefined;
    const terminate = (error: Error) => {
      failure ??= error;
      worker.kill('SIGKILL');
    };
    const abort = () => terminate(new Error('Backup operation was cancelled'));
    const timer = setTimeout(
      () => terminate(new Error('Backup operation exceeded its time limit')),
      duration,
    );
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: Result) => {
      result = message;
    });
    worker.once('error', (error) => {
      failure ??= error;
    });
    worker.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        failure ??=
          error instanceof Error
            ? error
            : new Error('Could not remove backup scratch files');
      }
      if (failure) reject(failure);
      else if (code !== 0 || !result)
        reject(new Error('Backup worker stopped before completing'));
      else if ('error' in result)
        reject(Object.assign(new Error(result.error), { code: result.code }));
      else resolve(result.summary);
    });
    worker.send(
      {
        kind,
        source,
        destination,
        options: limits,
        instanceOwner,
      } satisfies BackupJob,
      (error) => {
        if (error) terminate(new Error('Backup worker could not start'));
      },
    );
    if (signal?.aborted) abort();
  });
}
export function createBackupJob(
  dataDir: string,
  destination: string,
  options: BackupJobOptions = {},
) {
  return runJob('create', dataDir, destination, options);
}
export function validateBackupJob(
  source: string,
  destination: string,
  options: PortableBackupOptions = {},
) {
  return runJob('validate', source, destination, options);
}
