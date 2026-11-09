import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  activatePreparedApplication,
  recoverInterruptedActivation,
} from './activation.js';

it('rolls back both application components if replacement startup fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portfolio-activation-'));
  const ready = join(dir, 'ready');
  mkdirSync(ready);
  mkdirSync(join(dir, 'attachments'));
  mkdirSync(join(ready, 'attachments'));
  writeFileSync(join(dir, 'app.sqlite'), 'old');
  writeFileSync(join(dir, 'attachments', 'blob'), 'old blob');
  writeFileSync(join(ready, 'app.sqlite'), 'new');
  writeFileSync(join(ready, 'attachments', 'blob'), 'new blob');
  try {
    await expect(
      activatePreparedApplication(dir, ready, async () => {
        throw new Error('startup failed');
      }),
    ).rejects.toThrow('startup failed');
    expect(readFileSync(join(dir, 'app.sqlite'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'attachments', 'blob'), 'utf8')).toBe(
      'old blob',
    );
    recoverInterruptedActivation(dir);
    expect(existsSync(join(dir, '.activation.json'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([0, 1, 2, 3, 4, 5, 6, 7])(
  'recovers a crash after filesystem transition %i',
  (phase) => {
    const dir = mkdtempSync(join(tmpdir(), 'portfolio-activation-phase-'));
    const names = [
      'app.sqlite',
      'app.sqlite-wal',
      'app.sqlite-shm',
      'app.sqlite-journal',
      'attachments',
    ];
    const rollbackName =
      '.activation-rollback-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const rollback = join(dir, rollbackName);
    mkdirSync(rollback);
    try {
      for (const name of names) {
        if (name === 'attachments') {
          mkdirSync(join(dir, name));
          writeFileSync(join(dir, name, 'blob'), 'old attachment');
        } else writeFileSync(join(dir, name), 'old ' + name);
      }
      writeFileSync(
        join(dir, '.activation.json'),
        JSON.stringify({
          version: 1,
          rollback: rollbackName,
          original: names,
          committed: false,
        }),
      );
      for (const name of names.slice(0, Math.min(phase, 5)))
        renameSync(join(dir, name), join(rollback, name));
      if (phase >= 6) {
        mkdirSync(join(dir, 'attachments'));
        writeFileSync(join(dir, 'attachments', 'blob'), 'new attachment');
      }
      if (phase >= 7) writeFileSync(join(dir, 'app.sqlite'), 'new database');
      recoverInterruptedActivation(dir);
      for (const name of names)
        expect(
          readFileSync(
            join(dir, name, name === 'attachments' ? 'blob' : ''),
            'utf8',
          ),
        ).toBe(name === 'attachments' ? 'old attachment' : 'old ' + name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('keeps the replacement after a committed crash and refuses malformed journals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portfolio-activation-committed-'));
  const rollback = '.activation-rollback-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  mkdirSync(join(dir, rollback));
  writeFileSync(join(dir, rollback, 'app.sqlite'), 'old');
  writeFileSync(join(dir, 'app.sqlite'), 'new');
  writeFileSync(
    join(dir, '.activation.json'),
    JSON.stringify({
      version: 1,
      rollback,
      original: ['app.sqlite'],
      committed: true,
    }),
  );
  try {
    recoverInterruptedActivation(dir);
    expect(readFileSync(join(dir, 'app.sqlite'), 'utf8')).toBe('new');
    writeFileSync(
      join(dir, '.activation.json'),
      JSON.stringify({
        version: 1,
        rollback: '../../outside',
        original: [],
        committed: false,
      }),
    );
    expect(() => recoverInterruptedActivation(dir)).toThrow(
      'Invalid activation journal',
    );
    expect(readFileSync(join(dir, 'app.sqlite'), 'utf8')).toBe('new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preserves committed journal evidence and reports uncertain durability after commit fsync failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portfolio-activation-sync-'));
  const ready = join(dir, 'ready');
  mkdirSync(ready);
  writeFileSync(join(dir, 'app.sqlite'), 'old');
  writeFileSync(join(ready, 'app.sqlite'), 'new');
  const originalSync = fs.fsyncSync;
  let rollbackAttempted = false;
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    const journal = join(dir, '.activation.json');
    if (
      existsSync(journal) &&
      JSON.parse(readFileSync(journal, 'utf8')).committed
    )
      throw new Error('simulated commit fsync failure');
    originalSync(fd);
  });
  syncBuiltinESMExports();
  try {
    await expect(
      activatePreparedApplication(dir, ready, async () => {}, {
        beforeRollback: () => {
          rollbackAttempted = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATION_COMMITTED_UNCERTAIN' });
    expect(rollbackAttempted).toBe(false);
    expect(
      JSON.parse(readFileSync(join(dir, '.activation.json'), 'utf8')).committed,
    ).toBe(true);
    expect(readFileSync(join(dir, 'app.sqlite'), 'utf8')).toBe('new');
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
