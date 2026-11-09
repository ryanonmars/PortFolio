import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../../packages/db/src/index.js';
import { recoverInterruptedActivation } from '../../../packages/db/src/activation.js';

/** Route closures retain this handle; native SQLite APIs receive `real` instead. */
export function createDatabaseRuntime(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, '.instance-lock.sqlite');
  if (!existsSync(lockPath)) {
    try {
      closeSync(
        openSync(
          lockPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!lstatSync(lockPath).isFile() || lstatSync(lockPath).isSymbolicLink())
    throw new Error('Unsafe server instance lock');
  chmodSync(lockPath, 0o600);
  const lock = new DatabaseSync(lockPath);
  let disposed = false;
  let connection: DatabaseSync | undefined;
  const owner = randomUUID();
  try {
    lock.exec(
      'PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE',
    );
    lock.exec(
      'CREATE TABLE IF NOT EXISTS instance_owner(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL) STRICT',
    );
    lock
      .prepare('INSERT OR REPLACE INTO instance_owner(id,owner) VALUES(1,?)')
      .run(owner);
    lock.exec('COMMIT; BEGIN');
    // The read lease lets backup children share the OS lock. A contender that won
    // the commit/read gap changes the owner, so this contender must stop.
    const acquired = lock
      .prepare('SELECT owner FROM instance_owner WHERE id=1')
      .get() as { owner: string };
    if (acquired.owner !== owner)
      throw new Error('Another server acquired this data directory');
    recoverInterruptedActivation(dataDir);
    connection = openDatabase({ dataDir });
  } catch (error) {
    lock.close();
    throw error;
  }
  const real = () => {
    if (!connection)
      throw new Error('Database is unavailable during maintenance');
    return connection;
  };
  const db = new Proxy({} as DatabaseSync, {
    get(_target, key) {
      const current = real();
      const value = Reflect.get(current, key, current) as unknown;
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  return {
    owner,
    db,
    get real() {
      return real();
    },
    close() {
      connection?.close();
      connection = undefined;
    },
    open() {
      if (disposed) throw new Error('Database runtime is disposed');
      if (connection) throw new Error('Database is already open');
      connection = openDatabase({ dataDir });
    },
    dispose() {
      if (disposed) return;
      connection?.close();
      connection = undefined;
      lock.close();
      disposed = true;
    },
  };
}
export type DatabaseRuntime = ReturnType<typeof createDatabaseRuntime>;
