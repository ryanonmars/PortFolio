import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, test } from 'node:test';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'portfolio-mcp-package-'));
  temporary.push(root);
  const files = {
    'package.json': JSON.stringify({ version: '0.4.0' }),
    'apps/mcp/examples/small-office.proposal.json':
      '{"name":"Synthetic example"}',
    'dist/apps/mcp/src/server.js':
      "import '@modelcontextprotocol/sdk/server/stdio.js';\nimport './tools.js';\n",
    'dist/apps/mcp/src/tools.js':
      "import '../../../packages/shared/src/board.js';\n",
    'dist/apps/mcp/src/cli.js':
      "import '../../../packages/shared/src/board-json.js';\n",
    'dist/packages/shared/src/board.js':
      "import 'zod';\nexport const board = {};\n",
    'dist/packages/shared/src/board-json.js':
      "export { board } from './board.js';\n",
    'dist/packages/shared/src/unused.js': 'SECRET_UNUSED_MODULE',
    'dist/apps/api/src/server.js': 'SECRET_SERVER_DATA',
    'dist/apps/mcp/src/server.js.map': 'SECRET_SOURCE_MAP',
    '.env': 'SECRET_ENVIRONMENT',
    'data/portfolio.db': 'SECRET_DATABASE',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  await cp(
    join(repository, 'apps/mcp/distribution'),
    join(root, 'apps/mcp/distribution'),
    { recursive: true },
  );
  return root;
}
async function packageFixture(root) {
  const { packageMcp } = await import('./package-mcp.mjs');
  return packageMcp({ root });
}

test('packages only reachable compiled MCP/shared modules with locked dependencies and executable portable entrypoints', async () => {
  const root = await fixture();
  const { archive, checksum } = await packageFixture(root);
  assert.equal(archive, join(root, 'dist/release/portfolio-mcp-v0.4.0.tar.gz'));
  const contents = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(contents, /portfolio-mcp\/package-lock.json/);
  assert.match(contents, /portfolio-mcp\/examples\/small-office.proposal.json/);
  assert.match(
    contents,
    /portfolio-mcp\/dist\/packages\/shared\/src\/board-json.js/,
  );
  assert.doesNotMatch(
    contents,
    /\.env|\.db|\.map|unused|apps\/api|node_modules/,
  );
  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const packageRoot = join(extracted, 'portfolio-mcp');
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    await readFile(join(packageRoot, 'package-lock.json'), 'utf8'),
  );
  assert.equal(manifest.version, '0.4.0');
  assert.deepEqual(manifest.dependencies, {
    '@modelcontextprotocol/sdk': '1.32.2',
    zod: '4.6.7',
  });
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(lock.version, manifest.version);
  for (const [command, relative] of Object.entries(manifest.bin)) {
    assert.ok(['portfolio-mcp', 'portfolio-board-json'].includes(command));
    assert.match(
      await readFile(join(packageRoot, relative), 'utf8'),
      /^#!\/usr\/bin\/env node\n/,
    );
    assert.ok((await stat(join(packageRoot, relative))).mode & 0o111);
  }
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  assert.equal(
    await readFile(checksum, 'utf8'),
    `${hash}  portfolio-mcp-v0.4.0.tar.gz\n`,
  );
});

test('refuses missing compiled entrypoints instead of publishing an incomplete archive', async () => {
  const root = await fixture();
  await rm(join(root, 'dist/apps/mcp/src/server.js'));
  await assert.rejects(packageFixture(root), /ENOENT/);
});

test('refuses compiled imports outside the MCP/shared boundary', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'dist/apps/mcp/src/tools.js'),
    "import '../../api/src/server.js';\n",
  );
  await assert.rejects(packageFixture(root), /outside the MCP\/shared runtime/);
});

test('refuses unlisted external dependencies', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'dist/apps/mcp/src/tools.js'),
    "import 'fastify';\n",
  );
  await assert.rejects(packageFixture(root), /not a standalone dependency/);
});

test('rejects malformed release versions before creating paths', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ version: '../unsafe' }),
  );
  await assert.rejects(packageFixture(root), /release version/);
});

test('refuses a manifest and lockfile with different direct dependencies', async () => {
  const root = await fixture();
  const path = join(root, 'apps/mcp/distribution/package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.dependencies.zod = '4.0.0';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(packageFixture(root), /exact matching lockfile version/);
});

test(
  'clean extracted release installs and authors boards over CLI and SDK stdio without API credentials',
  {
    skip: !process.env.PORTFOLIO_MCP_ARCHIVE,
    timeout: 60000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'portfolio-mcp-consumer-'));
    temporary.push(root);
    execFileSync('tar', [
      '-xzf',
      process.env.PORTFOLIO_MCP_ARCHIVE,
      '-C',
      root,
    ]);
    const packageRoot = join(root, 'portfolio-mcp');
    execFileSync(
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: packageRoot,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: 'utf8',
        timeout: 45000,
      },
    );
    const work = join(root, 'unrelated-working-directory');
    await mkdir(work);
    const environment = { PATH: process.env.PATH, HOME: work };
    const proposal = JSON.parse(
      await readFile(
        join(packageRoot, 'examples/small-office.proposal.json'),
        'utf8',
      ),
    );
    await writeFile(join(work, 'proposal.json'), JSON.stringify(proposal));
    const cli = join(packageRoot, 'bin/portfolio-board-json.js');
    function runCli(args) {
      return JSON.parse(
        execFileSync(process.execPath, [cli, ...args], {
          cwd: work,
          env: environment,
          encoding: 'utf8',
          timeout: 10000,
        }),
      );
    }
    assert.equal(
      runCli(['generate', '--input', 'proposal.json', '--output', 'board.json'])
        .valid,
      true,
    );
    assert.equal(runCli(['validate', '--file', 'board.json']).valid, true);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, 'bin/portfolio-mcp.js')],
      cwd: work,
      env: environment,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const client = new Client({
      name: 'standalone-release-smoke',
      version: '1.0.0',
    });
    try {
      await client.connect(transport);
      const manifest = JSON.parse(
        await readFile(join(packageRoot, 'package.json'), 'utf8'),
      );
      assert.equal(client.getServerVersion().version, manifest.version);
      const names = (await client.listTools()).tools.map(({ name }) => name);
      for (const name of [
        'portfolio_generate_board_json',
        'portfolio_validate_board_json',
        'portfolio_get_import_schema',
        'portfolio_list_boards',
        'portfolio_apply_proposal',
        'portfolio_edit_board',
      ]) {
        assert.ok(names.includes(name));
      }
      const generated = await client.callTool({
        name: 'portfolio_generate_board_json',
        arguments: { proposal },
      });
      assert.equal(generated.structuredContent.valid, true);
      assert.equal(
        generated.structuredContent.summary.devices,
        proposal.devices.length,
      );
      const validated = await client.callTool({
        name: 'portfolio_validate_board_json',
        arguments: { json: generated.structuredContent.archive },
      });
      assert.equal(validated.structuredContent.valid, true);
      const schemas = await client.callTool({
        name: 'portfolio_get_import_schema',
        arguments: {},
      });
      assert.notEqual(schemas.isError, true);
      const disconnected = await client.callTool({
        name: 'portfolio_list_boards',
        arguments: {},
      });
      assert.equal(disconnected.isError, true);
      assert.match(JSON.stringify(disconnected), /PORTFOLIO_API_URL/);
      assert.equal(stderr, '');
    } finally {
      await client.close();
    }
  },
);
