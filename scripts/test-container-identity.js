import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// All fixtures use temporary Docker volumes; never mount the application's data.
const image = process.argv[2] ?? 'ghcr.io/ryanonmars/portfolio:local';
const previousImage =
  process.argv[3] ??
  'ghcr.io/ryanonmars/portfolio@sha256:b94d28eff78666a1fa3390e76c4fe16c6916176e8abf8e57bc15e8007fd49466';
const prefix = `portfolio-identity-${randomUUID().slice(0, 8)}`;
const containers = new Set();
const volumes = new Set();
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
const mount = (name, target = '/data', readonly = false) =>
  // Do not let Docker copy image ownership onto an empty denied-data fixture.
  `type=volume,source=${name},target=${target},volume-nocopy${readonly ? ',readonly' : ''}`;
const secureRun = (owner) => [
  '--user',
  owner,
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--network',
  'none',
  '--tmpfs',
  '/tmp:rw,nosuid,noexec,mode=1777',
];
function cleanup() {
  for (const name of containers) {
    try {
      docker('rm', '--force', name);
    } catch {
      /* Already removed. */
    }
  }
  for (const name of volumes) {
    try {
      docker('volume', 'rm', name);
    } catch {
      /* Preserve the original failure. */
    }
  }
}
for (const [signal, status] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => {
    cleanup();
    process.exit(status);
  });

function fixture(owner, label, prepare = '') {
  const name = `${prefix}-${label}`;
  docker(
    'volume',
    'create',
    '--label',
    'portfolio.test=container-identity',
    name,
  );
  volumes.add(name);
  const [uid, gid] = owner.split(':').map(Number);
  // Root is used only to provision isolated test fixtures, never to run the app.
  docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0:0',
    '--mount',
    mount(name),
    '--entrypoint',
    'node',
    image,
    '-e',
    `const fs=require('node:fs');fs.chownSync('/data',${uid},${gid});fs.chmodSync('/data',0o700);${prepare}`,
  );
  return name;
}
function start(candidate, owner, volume, label) {
  const name = `${prefix}-${label}`;
  containers.add(name);
  docker(
    'run',
    '--detach',
    '--name',
    name,
    '--init',
    ...secureRun(owner),
    '--mount',
    mount(volume),
    candidate,
  );
  return name;
}
function stop(name) {
  docker('stop', '--time', '10', name);
  docker('rm', name);
  containers.delete(name);
}
async function healthy(name) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = JSON.parse(
      docker('inspect', '--format', '{{json .State}}', name),
    );
    assert(state.Running, `Container exited: ${docker('logs', name)}`);
    try {
      docker(
        'exec',
        name,
        'node',
        '-e',
        "fetch('http://127.0.0.1:3088/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Container did not become healthy');
}
function identity(name, owner, backup = false) {
  const [uid, gid] = owner.split(':').map(Number);
  docker(
    'exec',
    name,
    'node',
    '-e',
    `
    const assert=require('node:assert/strict'),fs=require('node:fs');
    assert.equal(process.getuid(),${uid});assert.equal(process.getgid(),${gid});
    for(const file of ['/app/dist/apps/api/src/server.js','/app/package.json','/app/node_modules/fastify/package.json'])fs.accessSync(file,fs.constants.R_OK);
    const migrations='/app/packages/db/migrations';
    assert(fs.readdirSync(migrations).some(file=>file.endsWith('.sql')));
    for(const file of fs.readdirSync(migrations))fs.accessSync(migrations+'/'+file,fs.constants.R_OK);
    if(${uid}===568)assert(!fs.readFileSync('/etc/passwd','utf8').split(String.fromCharCode(10)).some(line=>line.split(':')[2]==='568'));
    const status=fs.readFileSync('/proc/self/status','utf8');
    assert.match(status,/^CapEff:\\s+0+$/m);assert.match(status,/^NoNewPrivs:\\s+1$/m);
    for(const file of ['/app/.identity-write-test','/etc/.identity-write-test'])assert.throws(()=>fs.writeFileSync(file,'denied'),/EROFS|EACCES/);
    const files=[['/data',0o700],['/data/app.sqlite',0o600]${backup ? ",['/data/backups',0o700],['/data/backups/identity.sqlite',0o600]" : ''}];
    for(const suffix of ['-wal','-shm'])if(fs.existsSync('/data/app.sqlite'+suffix))files.push(['/data/app.sqlite'+suffix,0o600]);
    for(const [file,mode] of files){
      const stat=fs.statSync(file);assert.equal(stat.uid,${uid});assert.equal(stat.gid,${gid});assert.equal(stat.mode&0o777,mode);
    }
  `,
  );
}
const apiProgram = `
  const assert=require('node:assert/strict');
  const mode=process.argv[1],input=JSON.parse(process.argv[2]);
  let cookie='',csrf='';
  async function request(method,path,payload,status=200){
    const headers={origin:'http://127.0.0.1:3088',cookie,'x-csrf-token':csrf};
    if(payload!==undefined)headers['content-type']='application/json';
    const response=await fetch('http://127.0.0.1:3088/api/v1'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)});
    const text=await response.text();assert.equal(response.status,status,text);
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const body=text?JSON.parse(text):null;if(body?.csrfToken)csrf=body.csrfToken;return body;
  }
  (async()=>{
    const htmlResponse=await fetch('http://127.0.0.1:3088/');assert.equal(htmlResponse.status,200);
    const html=await htmlResponse.text(),asset=html.match(/src="([^"]+)"/)[1];
    const assetResponse=await fetch(new URL(asset,'http://127.0.0.1:3088'));assert.equal(assetResponse.status,200);
    assert(assetResponse.headers.get('content-type').includes('javascript'));
    await request('GET','/auth/session');
    const credentials={username:'synthetic-identity-admin',password:'Synthetic-container-identity-password-42'};
    if(mode==='seed')await request('POST','/auth/setup',credentials,201);
    if(mode==='seed')await request('POST','/auth/logout',undefined,204);
    if(mode==='seed')await request('GET','/auth/session');
    await request('POST','/auth/login',credentials);
    if(mode==='seed'){
      const result=await request('POST','/boards',{name:'Synthetic container identity board',document:input},201);
      console.log(JSON.stringify(result.board));return;
    }
    const result=await request('GET','/boards/'+input.id);
    assert.deepEqual(result.board.document,input.document);
    assert((await request('GET','/boards')).boards.some(board=>board.id===input.id));
    if(mode==='write'){
      result.board.document.elements[0].properties.notes='Saved under numeric identity';
      const saved=await request('PATCH','/boards/'+input.id,{rowVersion:result.board.rowVersion,document:result.board.document});
      console.log(JSON.stringify(saved.board));
    }else console.log(JSON.stringify(result.board));
  })().catch(error=>{console.error(error.message);process.exitCode=1});
`;
const api = (name, mode, input) =>
  JSON.parse(
    docker('exec', name, 'node', '-e', apiProgram, mode, JSON.stringify(input)),
  );
const document = {
  schemaVersion: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  showCables: true,
  grid: true,
  elements: [
    {
      id: 'device',
      type: 'device',
      name: 'Synthetic device',
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      z: 0,
      color: '',
      properties: { deviceType: 'Router' },
    },
  ],
  ports: [],
  cables: [],
};

function composeConfiguration() {
  for (const file of ['compose.yaml', 'deployment/compose.yaml'])
    for (const owner of ['1000:1000', '568:568']) {
      const [PUID, PGID] = owner.split(':');
      const env = { ...process.env };
      delete env.PUID;
      delete env.PGID;
      if (owner !== '1000:1000') Object.assign(env, { PUID, PGID });
      const result = execFileSync(
        'docker',
        [
          'compose',
          '--env-file',
          '/dev/null',
          '-f',
          file,
          'config',
          '--format',
          'json',
        ],
        {
          encoding: 'utf8',
          env,
        },
      );
      const service = JSON.parse(result).services.portfolio;
      assert.equal(service.user, owner);
      assert.equal(service.read_only, true);
      assert.deepEqual(service.cap_drop, ['ALL']);
      assert(service.security_opt.includes('no-new-privileges:true'));
    }
}
function failedCommand(args) {
  try {
    docker(...args);
  } catch (error) {
    assert.notEqual(error.status, 0);
    assert.match(
      String(error.stderr),
      /EACCES|permission denied|unable to open|readonly|read-only/i,
    );
    return;
  }
  throw new Error('An unwritable fixture unexpectedly succeeded');
}

try {
  composeConfiguration();
  try {
    docker('image', 'inspect', previousImage);
  } catch {
    docker('pull', previousImage);
  }
  for (const owner of ['1000:1000', '568:568']) {
    const label = owner.replace(':', '-');
    const volume = fixture(owner, `clean-${label}`);
    let name = start(image, owner, volume, `clean-${label}`);
    await healthy(name);
    identity(name, owner);
    let board = api(name, 'seed', document);
    docker('exec', name, 'node', 'dist/scripts/database.js', 'migrate');
    board = api(name, 'write', board);
    docker(
      'exec',
      name,
      'node',
      'dist/scripts/database.js',
      'backup',
      '/data/backups/identity.sqlite',
    );
    identity(name, owner, true);
    stop(name);
    name = start(image, owner, volume, `restarted-${label}`);
    await healthy(name);
    api(name, 'read', board);
    identity(name, owner, true);
    stop(name);

    const restored = fixture(owner, `restore-${label}`);
    docker(
      'run',
      '--rm',
      ...secureRun(owner),
      '--mount',
      mount(volume, '/source', true),
      '--mount',
      mount(restored),
      '--entrypoint',
      'node',
      image,
      'dist/scripts/database.js',
      'restore',
      '/source/backups/identity.sqlite',
    );
    name = start(image, owner, restored, `restored-${label}`);
    await healthy(name);
    api(name, 'read', board);
    identity(name, owner);
    stop(name);

    const upgraded = fixture(owner, `upgrade-${label}`);
    name = start(previousImage, owner, upgraded, `previous-${label}`);
    await healthy(name);
    board = api(name, 'seed', document);
    stop(name);
    name = start(image, owner, upgraded, `upgraded-${label}`);
    await healthy(name);
    api(name, 'read', board);
    identity(name, owner);
    board = api(name, 'write', board);
    stop(name);
    name = start(image, owner, upgraded, `upgrade-restarted-${label}`);
    await healthy(name);
    api(name, 'read', board);
    identity(name, owner);
    stop(name);

    const denied = fixture('0:0', `denied-${label}`);
    failedCommand([
      'run',
      '--rm',
      ...secureRun(owner),
      '--mount',
      mount(denied),
      '--entrypoint',
      'node',
      image,
      'dist/scripts/database.js',
      'migrate',
    ]);
    docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      mount(denied, '/data', true),
      '--entrypoint',
      'node',
      image,
      '-e',
      "const fs=require('node:fs'),a=require('node:assert/strict'),s=fs.statSync('/data');a.equal(s.uid,0);a.equal(s.gid,0);a.equal(s.mode&0o777,0o700);a.deepEqual(fs.readdirSync('/data'),[])",
    );
    const deniedBackup = fixture(
      owner,
      `denied-backup-${label}`,
      "fs.mkdirSync('/data/backups',{mode:0o700});fs.writeFileSync('/data/backups/sentinel','unchanged',{mode:0o600})",
    );
    failedCommand([
      'run',
      '--rm',
      ...secureRun(owner),
      '--mount',
      mount(deniedBackup),
      '--entrypoint',
      'node',
      image,
      'dist/scripts/database.js',
      'backup',
      '/data/backups/identity.sqlite',
    ]);
    docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      mount(deniedBackup, '/data', true),
      '--entrypoint',
      'node',
      image,
      '-e',
      "const fs=require('node:fs'),a=require('node:assert/strict'),s=fs.statSync('/data/backups');a.equal(s.uid,0);a.equal(s.gid,0);a.equal(s.mode&0o777,0o700);a.deepEqual(fs.readdirSync('/data/backups'),['sentinel']);a.equal(fs.readFileSync('/data/backups/sentinel','utf8'),'unchanged')",
    );
    console.log(
      `PASS ${owner}: numeric identity, API, permissions, migration, backup/restore, recreation, v0.1.0 upgrade, denied data and backup ownership`,
    );
  }
  console.log(
    'PASS both Compose files: default/custom identity and security settings',
  );
} finally {
  cleanup();
}
