import { openDatabase } from '../../../packages/db/src/index.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPortableBackup,
  validatePortableBackup,
} from '../../../packages/db/src/portable-backup.js';
import type { BackupJob } from './backup-jobs.js';

let completed = false;
process.once('disconnect', () => {
  if (!completed) process.kill(process.pid, 'SIGKILL');
});
process.once('message', async (payload) => {
  const job = payload as BackupJob;
  let result;
  let lease: DatabaseSync | undefined;
  try {
    let summary;
    if (job.kind === 'create') {
      const lockPath = join(job.source, '.instance-lock.sqlite');
      if (existsSync(lockPath) || job.instanceOwner) {
        if (!job.instanceOwner || !existsSync(lockPath))
          throw new Error('Server instance owner lease is required');
        if (
          !lstatSync(lockPath).isFile() ||
          lstatSync(lockPath).isSymbolicLink()
        )
          throw new Error('Unsafe server instance lock');
        // Carry the server's shared OS lease while a backup holds its DB open.
        // A crashed parent cannot restart/swap state until this process exits.
        lease = new DatabaseSync(lockPath, { readOnly: true });
        lease.exec('PRAGMA busy_timeout=5000; BEGIN');
        const current = lease
          .prepare('SELECT owner FROM instance_owner WHERE id=1')
          .get() as { owner: string } | undefined;
        if (current?.owner !== job.instanceOwner)
          throw new Error('Server instance owner lease has changed');
      }
      const db = openDatabase({ dataDir: job.source });
      try {
        summary = await createPortableBackup(
          db,
          job.source,
          job.destination,
          job.options,
        );
      } finally {
        db.close();
      }
    } else {
      summary = await validatePortableBackup(
        job.source,
        job.destination,
        job.options,
      );
    }
    result = { summary };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    result = {
      error: error instanceof Error ? error.message : 'Backup operation failed',
      ...(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
        ? { code }
        : {}),
    };
  } finally {
    lease?.close();
  }
  completed = true;
  process.send!(result, () => process.disconnect());
});
