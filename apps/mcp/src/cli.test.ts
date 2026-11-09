import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syntheticBoardProposal } from '../../../packages/shared/src/integration.js';
import { boardImportSchema } from '../../../packages/shared/src/board.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(input: unknown = { name: 'Synthetic small board' }) {
  const directory = await mkdtemp(join(tmpdir(), 'portfolio-board-cli-'));
  directories.push(directory);
  const source = join(directory, 'proposal.json');
  const output = join(directory, 'board.json');
  await writeFile(source, JSON.stringify(input));
  return { directory, source, output };
}
function run(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/mcp/src/cli.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PORTFOLIO_API_URL: '', PORTFOLIO_API_TOKEN: '' },
    },
  );
  expect(result.error).toBeUndefined();
  return result;
}

describe('offline board JSON CLI subprocess', () => {
  it('generates and validates an importable synthetic board without an API or token', async () => {
    const { source, output } = await fixture(syntheticBoardProposal());
    const generated = run('generate', '--input', source, '--output', output);
    expect(generated.status, generated.stderr).toBe(0);
    expect(JSON.parse(generated.stdout)).toMatchObject({
      valid: true,
      summary: {
        devices: 9,
        networks: 3,
        ports: 17,
        cables: 8,
        unresolvedConnections: 1,
      },
      unresolvedConnections: ['Router WAN destination is undocumented.'],
    });
    const text = await readFile(output, 'utf8');
    const archive = JSON.parse(text);
    expect(boardImportSchema.safeParse(archive).success).toBe(true);
    expect(text).toBe(JSON.stringify(archive, null, 2));
    const validated = run('validate', '--file', output);
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      valid: true,
      summary: { devices: 9, ports: 17, cables: 8 },
    });
  });

  it('supports a minimal board proposal and leaves the source unchanged', async () => {
    const { source, output } = await fixture();
    const before = await readFile(source, 'utf8');
    const result = run('generate', '--input', source, '--output', output);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      summary: { devices: 0, ports: 0 },
    });
    expect(await readFile(source, 'utf8')).toBe(before);
  });

  it('rejects invalid graph references without publishing any output', async () => {
    const proposal = syntheticBoardProposal();
    proposal.connections[0]!.targetPortId = 'missing';
    const { directory, source, output } = await fixture(proposal);
    const result = run('generate', '--input', source, '--output', output);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: expect.any(String),
          message: expect.any(String),
        }),
      ]),
    });
    expect(await readdir(directory)).toEqual(['proposal.json']);
  });

  it.each(['generate', 'validate'])(
    'rejects malformed JSON for %s',
    async (command) => {
      const { directory, source, output } = await fixture();
      await writeFile(source, '{"incomplete":');
      const result =
        command === 'generate'
          ? run(command, '--input', source, '--output', output)
          : run(command, '--file', source);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        valid: false,
        errors: expect.any(Array),
      });
      expect(await readdir(directory)).toEqual(['proposal.json']);
    },
  );

  it.each(['generate', 'validate'])(
    'rejects an oversized file for %s before parsing',
    async (command) => {
      const { directory, source, output } = await fixture();
      await writeFile(source, ' '.repeat(8 * 1024 * 1024 + 1));
      const result =
        command === 'generate'
          ? run(command, '--input', source, '--output', output)
          : run(command, '--file', source);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/8 MiB|8388608/);
      expect(await readdir(directory)).toEqual(['proposal.json']);
    },
  );

  it('refuses to overwrite an existing destination', async () => {
    const { directory, source, output } = await fixture();
    await writeFile(output, 'existing private documentation');
    const result = run('generate', '--input', source, '--output', output);
    expect(result.status).toBe(1);
    expect(await readFile(output, 'utf8')).toBe(
      'existing private documentation',
    );
    expect((await readdir(directory)).sort()).toEqual([
      'board.json',
      'proposal.json',
    ]);
  });

  it('refuses an existing output directory and removes its temporary file', async () => {
    const { directory, source, output } = await fixture();
    await mkdir(output);
    const result = run('generate', '--input', source, '--output', output);
    expect(result.status).toBe(1);
    expect((await readdir(directory)).sort()).toEqual([
      'board.json',
      'proposal.json',
    ]);
    expect(await readdir(output)).toEqual([]);
  });

  it('rejects malformed UTF-8 rather than replacing invalid bytes', async () => {
    const { directory, source, output } = await fixture();
    await writeFile(source, Buffer.from([0x7b, 0x22, 0x6e, 0xff, 0x22, 0x7d]));
    const result = run('generate', '--input', source, '--output', output);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UTF-8');
    expect(await readdir(directory)).toEqual(['proposal.json']);
  });

  it('does not publish generated output that exceeds resource limits after expansion', async () => {
    const { directory, source, output } = await fixture({
      name: 'Synthetic expanded metadata',
      devices: [
        {
          id: 'device',
          name: 'Device',
          ports: Array.from({ length: 40 }, (_, index) => ({
            id: `port-${index}`,
            customFields: {
              values: Array.from({ length: 4096 }, () => ({ value: [0] })),
            },
          })),
        },
      ],
    });
    expect((await readFile(source)).length).toBeLessThan(8 * 1024 * 1024);
    const result = run('generate', '--input', source, '--output', output);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false });
    expect(await readdir(directory)).toEqual(['proposal.json']);
  });

  it('refuses to overwrite its source', async () => {
    const { directory, source } = await fixture();
    const before = await readFile(source, 'utf8');
    expect(run('generate', '--input', source, '--output', source).status).toBe(
      1,
    );
    expect(await readFile(source, 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(['proposal.json']);
  });

  it('reports I/O failure without partial files', async () => {
    const { directory, source } = await fixture();
    const result = run(
      'generate',
      '--input',
      source,
      '--output',
      join(directory, 'missing', 'board.json'),
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false });
    expect(await readdir(directory)).toEqual(['proposal.json']);
    expect(
      run('validate', '--file', join(directory, 'absent.json')).status,
    ).toBe(1);
  });

  it('rejects invalid archives', async () => {
    const { source } = await fixture({
      format: 'portfolio-board',
      schemaVersion: 99,
    });
    const result = run('validate', '--file', source);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false });
  });

  it.each([
    [],
    ['other'],
    ['generate'],
    ['validate'],
    ['validate', '--file'],
    ['validate', '--file', 'board.json', '--unknown', 'x'],
    ['validate', '--file', 'a', '--file', 'b'],
  ])('uses exit 2 for invalid arguments %j', (...args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      usage: expect.any(String),
    });
  });
});
