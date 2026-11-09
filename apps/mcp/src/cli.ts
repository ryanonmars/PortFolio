import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  BOARD_JSON_MAX_BYTES,
  generateBoardJson,
  validateBoardJson,
} from '../../../packages/shared/src/board-json.js';

const usage =
  'generate --input proposal.json --output board.json | validate --file board.json';
type Arguments =
  | { command: 'generate'; input: string; output: string }
  | { command: 'validate'; file: string };

function parseArguments(args: string[]): Arguments | undefined {
  const [command, ...options] = args;
  const expected =
    command === 'generate' ? ['--input', '--output'] : ['--file'];
  if (command !== 'generate' && command !== 'validate') return;
  if (options.length !== expected.length * 2) return;
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index]!;
    const value = options[index + 1];
    if (
      !expected.includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith('--')
    )
      return;
    values.set(flag, value);
  }
  return command === 'generate'
    ? {
        command,
        input: values.get('--input')!,
        output: values.get('--output')!,
      }
    : { command, file: values.get('--file')! };
}

async function readBoundedUtf8(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Input must be a regular JSON file.');
    if (stat.size > BOARD_JSON_MAX_BYTES)
      throw new Error('Input exceeds the 8 MiB JSON limit.');
    const buffer = Buffer.alloc(BOARD_JSON_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > BOARD_JSON_MAX_BYTES)
      throw new Error('Input exceeds the 8 MiB JSON limit.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } catch {
      throw new Error('Input must contain valid UTF-8 JSON.');
    }
  } finally {
    await file.close();
  }
}

async function publishExclusive(path: string, text: string): Promise<void> {
  const output = resolve(path);
  const temporary = join(
    dirname(output),
    `.${basename(output)}.${randomUUID()}.tmp`,
  );
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // A hard link publishes the complete file atomically and fails if any target exists.
    await link(temporary, output);
  } finally {
    await unlink(temporary);
  }
}

function report(value: unknown, code: number): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = code;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    report(
      {
        valid: false,
        errors: [{ path: '', message: 'Invalid command or arguments.' }],
        usage,
      },
      2,
    );
    return;
  }
  try {
    if (args.command === 'validate') {
      const feedback = validateBoardJson(await readBoundedUtf8(args.file));
      delete feedback.archive;
      report(feedback, feedback.valid ? 0 : 1);
      return;
    }
    if (resolve(args.input) === resolve(args.output))
      throw new Error('Output must differ from the source file.');
    const input = await readBoundedUtf8(args.input);
    let proposal: unknown;
    try {
      proposal = JSON.parse(input);
    } catch {
      throw new Error('Input is not valid JSON.');
    }
    const { archive, ...feedback } = generateBoardJson(proposal);
    if (!feedback.valid || !archive) {
      report(feedback, 1);
      return;
    }
    const output = JSON.stringify(archive, null, 2);
    if (Buffer.byteLength(output, 'utf8') > BOARD_JSON_MAX_BYTES)
      throw new Error('Generated JSON exceeds the 8 MiB JSON limit.');
    await publishExclusive(args.output, output);
    report({ ...feedback, output: resolve(args.output) }, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'EEXIST'
        ? 'Output already exists; choose a new output path.'
        : code
          ? `File operation failed (${code}). Check the path and permissions.`
          : error instanceof Error
            ? error.message
            : 'Unable to process the JSON file.';
    report({ valid: false, errors: [{ path: '', message }], warnings: [] }, 1);
  }
}

await main();
