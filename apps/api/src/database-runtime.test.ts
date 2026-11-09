import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDatabaseRuntime } from './database-runtime.js';

it('keeps captured database handles usable after closing and reopening', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-runtime-'));
  const runtime = createDatabaseRuntime(dataDir);
  try {
    const captured = runtime.db;
    runtime.close();
    expect(() => captured.prepare('SELECT 1')).toThrow();
    runtime.open();
    expect(captured.prepare('SELECT 42 AS n').get()).toEqual({ n: 42 });
    expect(runtime.real).not.toBe(captured);
  } finally {
    runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it('releases the operating-system instance lock after an abrupt process exit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-runtime-crash-'));
  try {
    const script = `import { createDatabaseRuntime } from './apps/api/src/database-runtime.ts'; createDatabaseRuntime(${JSON.stringify(dataDir)}); process.exit(17);`;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(17);
    const restarted = createDatabaseRuntime(dataDir);
    restarted.dispose();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it('excludes another server for the entire close/reopen activation window', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-runtime-exclusive-'));
  const first = createDatabaseRuntime(dataDir);
  try {
    expect(() => createDatabaseRuntime(dataDir)).toThrow();
    first.close();
    expect(() => createDatabaseRuntime(dataDir)).toThrow();
    first.dispose();
    const second = createDatabaseRuntime(dataDir);
    second.dispose();
  } finally {
    first.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it('keeps a backup child lease blocking new servers after the parent exits', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-runtime-child-lease-'));
  const parent = createDatabaseRuntime(dataDir);
  const child = new DatabaseSync(join(dataDir, '.instance-lock.sqlite'));
  try {
    child.exec('PRAGMA busy_timeout=0; BEGIN');
    expect(
      child.prepare('SELECT owner FROM instance_owner WHERE id=1').get(),
    ).toBeDefined();
    parent.dispose();
    expect(() => createDatabaseRuntime(dataDir)).toThrow();
    child.close();
    const next = createDatabaseRuntime(dataDir);
    next.dispose();
  } finally {
    parent.dispose();
    try {
      child.close();
    } catch {
      /* already closed */
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
