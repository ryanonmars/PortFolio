import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';

const components = [
  'app.sqlite',
  'app.sqlite-wal',
  'app.sqlite-shm',
  'app.sqlite-journal',
  'attachments',
] as const;
interface Journal {
  version: 1;
  rollback: string;
  original: string[];
  committed: boolean;
}
export class ActivationCommittedUncertainError extends Error {
  readonly code = 'ACTIVATION_COMMITTED_UNCERTAIN';
  constructor(cause: unknown) {
    super(
      'Restored data is installed but durable activation could not be confirmed',
      { cause },
    );
  }
}
function sync(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function regular(path: string) {
  if (lstatSync(path).isSymbolicLink())
    throw new Error('Unsafe application storage path');
}
function publishJournal(directory: string, journal: Journal) {
  const next = join(directory, '.activation.next');
  const fd = openSync(next, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(journal));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, join(directory, '.activation.json'));
  sync(directory);
}
function readJournal(directory: string): Journal {
  const path = join(directory, '.activation.json');
  regular(path);
  if (lstatSync(path).size > 4096)
    throw new Error('Invalid activation journal');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  if (
    value.version !== 1 ||
    !/^\.activation-rollback-[a-f0-9-]{36}$/.test(value.rollback) ||
    typeof value.committed !== 'boolean' ||
    !Array.isArray(value.original) ||
    new Set(value.original).size !== value.original.length ||
    value.original.some(
      (name) => !components.includes(name as (typeof components)[number]),
    )
  )
    throw new Error('Invalid activation journal');
  return value;
}
/** Must run before opening SQLite. Any incomplete activation rolls back conservatively. */
export function recoverInterruptedActivation(dataDir: string): void {
  const directory = resolve(dataDir);
  if (!existsSync(join(directory, '.activation.json'))) {
    rmSync(join(directory, '.activation.next'), { force: true });
    return;
  }
  const journal = readJournal(directory);
  const rollback = join(directory, journal.rollback);
  if (!journal.committed) {
    if (!existsSync(rollback))
      throw new Error('Activation rollback data is unavailable');
    regular(rollback);
    for (const name of components) {
      const old = join(rollback, name),
        live = join(directory, name);
      if (existsSync(old)) {
        regular(old);
        if (existsSync(live)) {
          regular(live);
          rmSync(live, { recursive: true, force: true });
        }
        renameSync(old, live);
        sync(directory);
        sync(rollback);
      } else if (!journal.original.includes(name)) {
        if (existsSync(live)) {
          regular(live);
          rmSync(live, { recursive: true, force: true });
          sync(directory);
        }
      }
    }
  }
  // Clear journal durably before removing rollback: interrupted cleanup is harmless.
  rmSync(join(directory, '.activation.json'));
  rmSync(join(directory, '.activation.next'), { force: true });
  sync(directory);
  rmSync(rollback, { recursive: true, force: true });
  sync(directory);
}

/** Caller must close SQLite and drain every filesystem user before entry. */
export async function activatePreparedApplication(
  dataDir: string,
  readyDirectory: string,
  verify: () => Promise<void>,
  options: {
    beforeRollback?: () => void;
    onCleanupError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const directory = resolve(dataDir),
    ready = resolve(readyDirectory);
  const child = relative(directory, ready);
  if (!child || child.startsWith('..') || resolve(directory, child) !== ready)
    throw new Error('Prepared application must be inside DATA_DIR');
  regular(ready);
  regular(join(ready, 'app.sqlite'));
  if (existsSync(join(directory, '.activation.json')))
    throw new Error('An activation is already pending');
  const rollbackName = '.activation-rollback-' + randomUUID();
  const rollback = join(directory, rollbackName);
  mkdirSync(rollback, { mode: 0o700 });
  const original = components.filter((name) =>
    existsSync(join(directory, name)),
  );
  for (const name of original) regular(join(directory, name));
  const journal: Journal = {
    version: 1,
    rollback: rollbackName,
    original,
    committed: false,
  };
  publishJournal(directory, journal);
  try {
    for (const name of original) {
      renameSync(join(directory, name), join(rollback, name));
      sync(directory);
      sync(rollback);
    }
    for (const name of ['attachments', 'app.sqlite']) {
      if (existsSync(join(ready, name))) {
        regular(join(ready, name));
        renameSync(join(ready, name), join(directory, name));
        sync(ready);
        sync(directory);
      }
    }
    await verify();
    publishJournal(directory, { ...journal, committed: true });
  } catch (error) {
    // Once the committed journal has been renamed, rollback would contradict restart
    // recovery. Preserve both generations and stop serving if its fsync is uncertain.
    if (
      existsSync(join(directory, '.activation.json')) &&
      readJournal(directory).committed
    )
      throw new ActivationCommittedUncertainError(error);
    options.beforeRollback?.();
    recoverInterruptedActivation(directory);
    throw error;
  }
  try {
    recoverInterruptedActivation(directory);
  } catch (error) {
    options.onCleanupError?.(error);
  }
}
