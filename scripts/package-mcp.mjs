import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runtimeDirectories = ['dist/apps/mcp/src/', 'dist/packages/shared/src/'];
const entrypoints = {
  'portfolio-mcp': 'server',
  'portfolio-board-json': 'cli',
};

/** Build a dependency-locked archive from the already compiled MCP entrypoints. */
export async function packageMcp({ root = repository } = {}) {
  root = resolve(root);
  const { version } = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
    throw new Error('Invalid release version.');
  }
  const template = join(root, 'apps/mcp/distribution');
  const manifest = JSON.parse(
    await readFile(join(template, 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    await readFile(join(template, 'package-lock.json'), 'utf8'),
  );
  for (const [name, dependencyVersion] of Object.entries(
    manifest.dependencies,
  )) {
    if (
      !/^\d+\.\d+\.\d+$/.test(dependencyVersion) ||
      lock.packages[''].dependencies[name] !== dependencyVersion ||
      lock.packages[`node_modules/${name}`]?.version !== dependencyVersion
    ) {
      throw new Error(
        `Standalone dependency ${name} must have an exact matching lockfile version.`,
      );
    }
  }
  const modules = new Map();
  async function visit(path) {
    const local = relative(root, path).split(sep).join('/');
    if (
      !runtimeDirectories.some((directory) => local.startsWith(directory)) ||
      !local.endsWith('.js')
    ) {
      throw new Error(
        `Compiled import ${local} is outside the MCP/shared runtime.`,
      );
    }
    if (modules.has(local)) return;
    const source = await readFile(path, 'utf8');
    modules.set(local, source);
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true)
      .importedFiles) {
      if (specifier.startsWith('.')) {
        await visit(resolve(dirname(path), specifier));
      } else if (!specifier.startsWith('node:')) {
        const dependency = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!Object.hasOwn(manifest.dependencies, dependency)) {
          throw new Error(`${specifier} is not a standalone dependency.`);
        }
      }
    }
  }
  for (const module of Object.values(entrypoints)) {
    await visit(join(root, `dist/apps/mcp/src/${module}.js`));
  }
  const temporary = await mkdtemp(join(tmpdir(), 'portfolio-mcp-release-'));
  try {
    const stage = join(temporary, 'portfolio-mcp');
    await mkdir(join(stage, 'bin'), { recursive: true });
    manifest.version = version;
    lock.version = version;
    lock.packages[''].version = version;
    for (const [name, value] of [
      ['package.json', manifest],
      ['package-lock.json', lock],
    ]) {
      await writeFile(join(stage, name), `${JSON.stringify(value, null, 2)}\n`);
    }
    for (const [command, module] of Object.entries(entrypoints)) {
      const bin = join(stage, `bin/${command}.js`);
      await writeFile(
        bin,
        `#!/usr/bin/env node\nimport '../dist/apps/mcp/src/${module}.js';\n`,
      );
      await chmod(bin, 0o755);
    }
    for (const [path, source] of modules) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await writeFile(
        join(stage, path),
        source.replace(/^\/\/# sourceMappingURL=.*$/gm, ''),
      );
    }
    try {
      await copyFile(join(template, 'README.md'), join(stage, 'README.md'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await mkdir(join(stage, 'examples'), { recursive: true });
      await copyFile(
        join(root, 'apps/mcp/examples/small-office.proposal.json'),
        join(stage, 'examples/small-office.proposal.json'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const output = join(root, 'dist/release');
    await mkdir(output, { recursive: true });
    const archive = join(output, `portfolio-mcp-v${version}.tar.gz`);
    // COPYFILE_DISABLE prevents macOS metadata/resource forks from entering releases.
    execFileSync('tar', ['-czf', archive, '-C', temporary, 'portfolio-mcp'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: 'pipe',
    });
    const hash = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    const checksum = `${archive}.sha256`;
    await writeFile(checksum, `${hash}  ${basename(archive)}\n`);
    return { archive, checksum };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await packageMcp();
  process.stdout.write(`${result.archive}\n${result.checksum}\n`);
}
