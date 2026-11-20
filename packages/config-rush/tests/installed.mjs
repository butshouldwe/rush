import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

// This harness invokes installed artifacts in subprocesses. It never imports plugin source.
const { values } = parseArgs({
  options: Object.fromEntries(
    ['root', 'node', 'rush-bin', 'pnpm-cache', 'artifact-map', 'tarball', 'tsc', 'type-roots'].map(
      (name) => [name, { type: 'string' }],
    ),
  ),
});
for (const name of [
  'root',
  'node',
  'rush-bin',
  'pnpm-cache',
  'artifact-map',
  'tarball',
  'tsc',
  'type-roots',
])
  assert(values[name], `Missing --${name}`);
for (const name of [
  'node',
  'rush-bin',
  'pnpm-cache',
  'artifact-map',
  'tarball',
  'tsc',
  'type-roots',
]) {
  assert(fs.existsSync(values[name]), `Missing prerequisite --${name}: ${values[name]}`);
}
const root = path.resolve(values.root),
  repo = path.join(root, 'repo');
assert(!fs.existsSync(root), 'Use a fresh test root; evidence is never overwritten');
fs.mkdirSync(root, { recursive: true });
const version = spawnSync(values.node, ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0);
const global = path.join(root, 'global'),
  cache = path.join(global, `node-${version.stdout.trim()}`, 'pnpm-10.24.0');
fs.mkdirSync(path.dirname(cache), { recursive: true });
fs.cpSync(values['pnpm-cache'], cache, { recursive: true, dereference: false });
const artifacts = JSON.parse(fs.readFileSync(values['artifact-map'], 'utf8'));
for (const ref of Object.values(artifacts))
  assert(ref.startsWith('file:'), 'Offline overrides must name local artifacts');
function put(file, data) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
}
put('rush.json', {
  rushVersion: '5.177.2',
  pnpmVersion: '10.24.0',
  projectFolderMinDepth: 2,
  projectFolderMaxDepth: 2,
  projects: [
    { packageName: '@consumer/app', projectFolder: 'apps/app' },
    { packageName: 'sample-rig', projectFolder: 'rigs/test-rig' },
  ],
});
put('common/config/rush/pnpm-config.json', { useWorkspaces: true });
put('apps/app/package.json', {
  name: '@consumer/app',
  version: '1.0.0',
  devDependencies: { 'sample-rig': 'workspace:*' },
});
put('rigs/test-rig/package.json', { name: 'sample-rig', version: '1.0.0' });
put('apps/app/config/rig.json', { rigPackageName: 'sample-rig' });
put('common/config/rush/rush-plugins.json', {
  plugins: [
    {
      packageName: '@butshouldwe/config-rush',
      pluginName: 'config-rush-plugin',
      autoinstallerName: 'rush-plugins',
    },
  ],
});
put('common/autoinstallers/rush-plugins/package.json', {
  name: 'rush-plugins',
  version: '0.0.0',
  private: true,
  dependencies: { '@butshouldwe/config-rush': `file:${path.resolve(values.tarball)}` },
  pnpm: { overrides: artifacts },
});
fs.writeFileSync(
  path.join(repo, 'common/autoinstallers/rush-plugins/pnpm-workspace.yaml'),
  'packages: []\n',
);
put('common/config/rush-plugins/config-rush-plugin.json', {
  formatVersion: 1,
  domains: [
    {
      name: 'tool',
      projectFile: 'config/tool.json',
      versions: {
        '1.0.0': { schema: 'schemas/effective.json', fragmentSchema: 'schemas/fragment.json' },
      },
    },
  ],
});
put('schemas/effective.json', {
  type: 'object',
  properties: {
    channel: { type: ['string', 'null'] },
    addons: { type: 'array', items: { type: 'string' } },
  },
  required: ['channel'],
  additionalProperties: false,
});
put('schemas/fragment.json', {
  type: 'object',
  properties: {
    channel: { type: ['string', 'null'] },
    addons: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
});
const document = {
  formatVersion: 1,
  domain: 'tool',
  contractVersion: '1.0.0',
  values: { channel: null },
};
put('apps/app/config/tool.json', document);
const rigFile = 'rigs/test-rig/profiles/default/config/tool.json';
put(rigFile, { ...document, values: { channel: 'rig', addons: ['base'] } });
const env = {
  ...process.env,
  PATH: `${path.dirname(values.node)}:/usr/bin:/bin`,
  RUSH_GLOBAL_FOLDER: global,
  npm_config_offline: 'true',
  npm_config_ignore_scripts: 'true',
  npm_config_store_dir: path.join(root, 'store'),
  npm_config_userconfig: '/dev/null',
  CI: '1',
};
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const outcomes = [];
function run(name, bin, args, expected = 0, cwd = repo) {
  const result = spawnSync(values.node, [bin, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(root, `${name}.stdout`), result.stdout ?? '');
  fs.writeFileSync(path.join(root, `${name}.stderr`), result.stderr ?? '');
  outcomes.push({ name, bin, args, cwd, exit: result.status });
  fs.writeFileSync(path.join(root, 'commands.json'), JSON.stringify(outcomes, null, 2));
  assert.equal(result.error, undefined, `${name}: ${result.error?.message}`);
  assert.equal(result.status, expected, `${name}: ${result.stdout}\n${result.stderr}`);
  return result;
}
const rush = (name, args, expected = 0) => run(name, values['rush-bin'], args, expected);
rush('install', ['update-autoinstaller', '--name', 'rush-plugins']);
rush('activate', ['update']);
const configFile = path.join(repo, 'apps/app/config/tool.json');
const before = fs.readFileSync(configFile);
const output = path.join(root, 'get.json');
rush('get', [
  'config-get',
  '--project',
  '@consumer/app',
  '--domain',
  'tool',
  '--result-file',
  output,
  '--invocation-id',
  'installed-get',
]);
const response = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.equal(response.invocationId, 'installed-get');
assert.equal(response.status, 'success');
assert.deepEqual(response.data.values, { channel: null });
assert.match(response.data.provenance['/channel'].source, /tool.json$/);
rush(
  'refuse-existing',
  [
    'config-get',
    '--project',
    '@consumer/app',
    '--domain',
    'tool',
    '--result-file',
    output,
    '--invocation-id',
    'must-not-overwrite',
  ],
  2,
);
assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).invocationId, 'installed-get');
assert.deepEqual(fs.readFileSync(configFile), before);
put('apps/app/config/tool.json', { ...document, values: { channel: 42 } });
const invalid = path.join(root, 'invalid.json');
rush(
  'invalid',
  ['config-validate', '--result-file', invalid, '--invocation-id', 'installed-invalid'],
  2,
);
assert.equal(JSON.parse(fs.readFileSync(invalid, 'utf8')).status, 'failure');
put('apps/app/config/tool.json', document);
const ai = path.join(repo, 'common/autoinstallers/rush-plugins');
fs.writeFileSync(
  path.join(ai, 'compare.mjs'),
  `import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createClient,ConfigurationError} from '@butshouldwe/config-rush';
const expected=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const q={project:'@consumer/app',domain:'tool',optional:process.argv[4]==='true'};
const c=createClient({root:process.argv[2]});
const require=createRequire(import.meta.resolve('@butshouldwe/config-rush'));
const {Effect}=await import(pathToFileURL(require.resolve('effect')).href);
if(expected.status==='success'){
 const plain=await c.get(q);assert.deepEqual(plain,expected.data);
 assert.deepEqual(await Effect.runPromise(c.getEffect(q)),plain);
 const explanation=await c.explain(q);assert(explanation.valid);assert.deepEqual(explanation.result,plain);
}else{
 await assert.rejects(c.get(q),e=>{assert(e instanceof ConfigurationError);assert.deepEqual(e.diagnostics,expected.diagnostics);return true;});
 const failure=await Effect.runPromise(Effect.flip(c.getEffect(q)));assert.deepEqual(failure.diagnostics,expected.diagnostics);
 const explanation=await c.explain(q);assert(!explanation.valid);assert.equal(explanation.result,null);
}
console.log(JSON.stringify({agreement:true}));
`,
);
function compare(name, expectedValues, code, optional = false) {
  const target = path.join(root, `${name}.json`);
  const args = [
    'config-get',
    '--project',
    '@consumer/app',
    '--domain',
    'tool',
    '--result-file',
    target,
    '--invocation-id',
    name,
  ];
  if (optional) args.push('--optional');
  rush(name, args, code ? 2 : 0);
  const result = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (code) assert.equal(result.diagnostics[0].code, code);
  else assert.deepEqual(result.data.values, expectedValues);
  const explainTarget = path.join(root, `${name}-explain.json`);
  const explainArgs = [...args];
  explainArgs[0] = 'config-explain';
  explainArgs[explainArgs.indexOf('--result-file') + 1] = explainTarget;
  explainArgs[explainArgs.indexOf('--invocation-id') + 1] = `${name}-explain`;
  rush(`${name}-explain`, explainArgs, code ? 2 : 0);
  const explained = JSON.parse(fs.readFileSync(explainTarget, 'utf8'));
  assert.equal(explained.data.valid, !code);
  assert.deepEqual(explained.data.result, code ? null : result.data);
  run(`${name}-interfaces`, path.join(ai, 'compare.mjs'), [repo, target, String(optional)]);
}
fs.unlinkSync(configFile);
compare('rig-fallback', { channel: 'rig', addons: ['base'] });
const inherited = {
  ...document,
  extends: '../../../rigs/test-rig/profiles/default/config/tool.json',
  suppress: ['/addons'],
};
put('apps/app/config/tool.json', inherited);
compare('extends-null-suppression', { channel: null });
put(rigFile, { ...document, contractVersion: '2.0.0' });
compare('version-mismatch', null, 'INHERITANCE_VERSION');
fs.unlinkSync(configFile);
fs.unlinkSync(path.join(repo, rigFile));
compare('optional-absence', null, undefined, true);
const registryPath = path.join(repo, 'common/config/rush-plugins/config-rush-plugin.json');
const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
reg.domains[0].required = true;
put('common/config/rush-plugins/config-rush-plugin.json', reg);
compare('required-absence', null, 'REQUIRED_DOMAIN_MISSING', true);
reg.domains[0].required = false;
put('common/config/rush-plugins/config-rush-plugin.json', reg);
put(rigFile, { ...document, values: { channel: 'rig', addons: ['base'] } });
put('apps/app/config/tool.json', document);
for (const operation of ['discover', 'explain', 'validate']) {
  const target = path.join(root, `${operation}.json`);
  const args = [`config-${operation}`, '--result-file', target, '--invocation-id', operation];
  if (operation === 'explain') args.push('--project', '@consumer/app', '--domain', 'tool');
  rush(operation, args);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).status, 'success');
}

fs.writeFileSync(
  path.join(ai, 'consumer.mjs'),
  `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createClient,ConfigurationError} from '@butshouldwe/config-rush';
const resolved=import.meta.resolve('@butshouldwe/config-rush');
assert(resolved.includes('/node_modules/'));assert(resolved.endsWith('/dist/index.js'));
const c=createClient({root:process.argv[2]});
const query={project:'@consumer/app',domain:'tool'};
const plain=await c.get(query);assert.deepEqual(plain.values,{channel:null});
const fs=await import('node:fs');const target=process.argv[2]+'/apps/app/config/tool.json';const before=fs.readFileSync(target);
const candidateRequest={documents:[{...query,contents:JSON.stringify({formatVersion:1,domain:'tool',contractVersion:'1.0.0',values:{channel:'preview'}})}]};
const preview=await c.previewCandidates(candidateRequest);assert.equal(preview.results[0].values.channel,'preview');assert.equal(preview.scope.repositoryWide,false);assert(preview.inputs.some(x=>x.path===target&&x.sha256));assert.deepEqual(fs.readFileSync(target),before);assert.deepEqual((await c.get(query)).values,{channel:null});
const require=createRequire(resolved);const {Effect}=await import(pathToFileURL(require.resolve('effect')).href);
assert.deepEqual(await Effect.runPromise(c.getEffect(query)),plain);
assert.deepEqual(await Effect.runPromise(c.previewCandidatesEffect(candidateRequest)),preview);
const edits={requestVersion:1,edits:[{...query,operation:'set',pointer:'/channel',value:null}]};
const editPlan=await c.previewEdits(edits);assert.deepEqual(await Effect.runPromise(c.previewEditsEffect(edits)),editPlan);
const effectApplied=await Effect.runPromise(c.applyEditsEffect(editPlan));assert.equal(effectApplied.status,'success');assert.equal(effectApplied.journal,null);assert.deepEqual(fs.readFileSync(target),before);
await assert.rejects(c.get({project:'app',domain:'tool'}),e=>e instanceof ConfigurationError && e.diagnostics[0].code==='UNKNOWN_PROJECT');
console.log(JSON.stringify({resolved,plain,effectAgreement:true}));
`,
);
const consumer = run('consumer', path.join(ai, 'consumer.mjs'), [repo]);
fs.writeFileSync(
  path.join(ai, 'consumer.cjs'),
  `const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
(async()=>{const {createClient}=await import(pathToFileURL(require.resolve('@butshouldwe/config-rush')).href);const result=await createClient({root:process.argv[2]}).get({project:'@consumer/app',domain:'tool'});assert.deepEqual(result.values,{channel:null});console.log('CommonJS asynchronous consumer passed');})().catch(e=>{console.error(e);process.exitCode=1;});
`,
);
run('consumer-cjs', path.join(ai, 'consumer.cjs'), [repo]);
fs.writeFileSync(
  path.join(ai, 'consumer.mts'),
  `import {createClient, type ResolvedConfiguration,type CandidatePreview,type EditRequest,type EditPlan,type ApplyResult,type EditStatus,type Observation,type ObservedInput} from '@butshouldwe/config-rush';
const client=createClient({root:'.'});
const value:ResolvedConfiguration=await client.get({project:'@consumer/app',domain:'tool'});
const channel:unknown=value.values?.channel;
void channel;
const preview:CandidatePreview=await client.previewCandidates({documents:[{project:'@consumer/app',domain:'tool',contents:'{}'}]});
void preview.inputFingerprint;
const request:EditRequest={requestVersion:1,edits:[{project:'@consumer/app',domain:'tool',operation:'set',pointer:'/channel',value:null}]};
const editPlan:EditPlan=await client.previewEdits(request);
const applied:ApplyResult=await client.applyEdits(editPlan);void applied.effects.applied;
const status:EditStatus=await client.editStatus('not-executed');
const labels:Record<Observation,string>={candidate:'new',original:'old',other:'changed',unknown:'unknown'};
for(const target of status.targets){const label:string=labels[target.observed];void label;}
declare const observation:ObservedInput;
if(observation.kind==='file'){const hash:string=observation.sha256;const inode:number=observation.inode;void hash;void inode;}
// @ts-expect-error A file observation requires its complete identity/hash.
const badObservation:ObservedInput={path:'/x',canonicalPath:'/x',kind:'file'};void badObservation;
// @ts-expect-error Request versions are exact, not arbitrary integers.
client.previewEdits({requestVersion:2,edits:[]});
// @ts-expect-error Domain identity must be explicit at the typed boundary.
client.get({project:'@consumer/app'});
`,
);
run('consumer-types', values.tsc, [
  '--noEmit',
  '--strict',
  '--skipLibCheck',
  'false',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--target',
  'ES2023',
  '--types',
  'node',
  '--typeRoots',
  values['type-roots'],
  path.join(ai, 'consumer.mts'),
]);
const authorBefore = fs.readFileSync(configFile);
function authorPlan(name, value) {
  const authorOutput = path.join(root, `${name}.json`);
  rush(name, [
    'config-set',
    '--project',
    '@consumer/app',
    '--domain',
    'tool',
    '--pointer',
    '/channel',
    '--value',
    JSON.stringify(value),
    '--result-file',
    authorOutput,
    '--invocation-id',
    name,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(authorOutput, 'utf8')).data.scope.repositoryWide, false);
  return authorOutput;
}
function authorApply(name, plan) {
  const authorOutput = path.join(root, `${name}.json`);
  rush(name, [
    'config-apply',
    '--plan-file',
    plan,
    '--result-file',
    authorOutput,
    '--invocation-id',
    name,
  ]);
  const result = JSON.parse(fs.readFileSync(authorOutput, 'utf8'));
  assert.equal(result.status, 'success');
  assert.equal(result.effects.applied.length, 1);
  return result;
}
const authoredPlan = authorPlan('author-preview', 'authored');
assert.deepEqual(fs.readFileSync(configFile), authorBefore);
const authored = authorApply('author-apply', authoredPlan);
rush('author-validate', ['config-validate', '--project', '@consumer/app', '--domain', 'tool']);
rush('author-explain', ['config-explain', '--project', '@consumer/app', '--domain', 'tool']);
rush('author-status', ['config-status', '--operation-id', authored.data.operationId]);
fs.writeFileSync(
  path.join(ai, 'author-status.mjs'),
  `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {createClient} from '@butshouldwe/config-rush';const require=createRequire(import.meta.resolve('@butshouldwe/config-rush'));const {Effect}=await import(pathToFileURL(require.resolve('effect')).href);const status=await Effect.runPromise(createClient({root:process.argv[2]}).editStatusEffect(process.argv[3]));assert.equal(status.effects.applied.length,1);console.log('Installed Effect status passed');`,
);
run('author-status-effect', path.join(ai, 'author-status.mjs'), [repo, authored.data.operationId]);
put('apps/app/config/tool.json', { ...document, values: { channel: 42 } });
authorApply('repair-apply', authorPlan('repair-preview', 'repaired'));
assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).values.channel, 'repaired');
authorApply('restore-apply', authorPlan('restore-preview', null));
assert.deepEqual(fs.readFileSync(configFile), authorBefore);
// Reject colliding output paths through installed Rush commands, not just the direct binary.
fs.unlinkSync(configFile);
const collisionRequest = path.join(root, 'collision-request.json');
fs.writeFileSync(
  collisionRequest,
  JSON.stringify({
    requestVersion: 1,
    edits: [{ project: '@consumer/app', domain: 'tool', operation: 'create', document }],
  }),
);
rush(
  'reject-preview-destination',
  ['config-preview', '--request-file', collisionRequest, '--result-file', configFile],
  2,
);
assert.equal(fs.existsSync(configFile), false);
const collisionPlan = path.join(root, 'collision-plan.json');
rush('prepare-collision-plan', [
  'config-preview',
  '--request-file',
  collisionRequest,
  '--result-file',
  collisionPlan,
]);
rush(
  'reject-apply-destination',
  ['config-apply', '--plan-file', collisionPlan, '--result-file', configFile],
  2,
);
assert.equal(fs.existsSync(configFile), false);
fs.writeFileSync(configFile, authorBefore);
const restoredStatus = path.join(root, 'restored-status.json');
rush('restored-status', [
  'config-status',
  '--operation-id',
  authored.data.operationId,
  '--result-file',
  restoredStatus,
]);
const restoredEffects = JSON.parse(fs.readFileSync(restoredStatus, 'utf8')).data.effects;
assert.equal(restoredEffects.unknown.length, 1);
assert.equal(restoredEffects.unattempted.length, 0);
fs.writeFileSync(configFile, JSON.stringify(document, null, '\t') + '\n');
const indentPlan = path.join(root, 'indent-plan.json');
rush('indent-preview', [
  'config-set',
  '--project',
  '@consumer/app',
  '--domain',
  'tool',
  '--pointer',
  '/addons',
  '--value',
  '["one"]',
  '--result-file',
  indentPlan,
]);
assert(
  JSON.parse(fs.readFileSync(indentPlan, 'utf8')).data.targets[0].after.includes('\t\t"addons"'),
);
authorApply('indent-apply', indentPlan);
fs.writeFileSync(configFile, authorBefore);
assert.deepEqual(fs.readFileSync(configFile), authorBefore);
const aliasRegistry = structuredClone(reg);
aliasRegistry.domains[0].versions['1.0.0'].paths = {
  '/channel': {
    base: 'project',
    allowedRoots: [{ base: 'project', path: '.' }],
    mustExist: true,
    symlinks: 'within-roots',
  },
};
put('common/config/rush-plugins/config-rush-plugin.json', aliasRegistry);
fs.symlinkSync(path.join(repo, 'apps/app/config'), path.join(repo, 'apps/app/alias'));
authorApply('alias-apply', authorPlan('alias-preview', 'alias/tool.json'));
put('common/config/rush-plugins/config-rush-plugin.json', reg);
fs.unlinkSync(configFile);
const createRequest = path.join(root, 'create-for-status.json'),
  createPlan = path.join(root, 'create-for-status-plan.json');
fs.writeFileSync(
  createRequest,
  JSON.stringify({
    requestVersion: 1,
    edits: [{ project: '@consumer/app', domain: 'tool', operation: 'create', document }],
  }),
);
rush('create-for-status-preview', [
  'config-preview',
  '--request-file',
  createRequest,
  '--result-file',
  createPlan,
]);
const createdForStatus = authorApply('create-for-status-apply', createPlan);
fs.unlinkSync(configFile);
fs.mkdirSync(configFile);
const nonFileStatus = path.join(root, 'non-file-status.json');
rush('non-file-status', [
  'config-status',
  '--operation-id',
  createdForStatus.data.operationId,
  '--result-file',
  nonFileStatus,
]);
assert.equal(JSON.parse(fs.readFileSync(nonFileStatus, 'utf8')).data.targets[0].observed, 'other');
fs.rmdirSync(configFile);
fs.writeFileSync(configFile, authorBefore);
assert.deepEqual(fs.readFileSync(configFile), authorBefore);
const commented = JSON.stringify({ ...document, values: { addons: ['a'], channel: null } }, null, 2)
  .replace('    "addons"', '    // keep before\n    "addons"')
  .replace('    "channel"', '    // keep after\n    "channel"');
fs.writeFileSync(configFile, commented);
const commentPlan = path.join(root, 'comment-delete-plan.json');
rush('comment-delete-preview', [
  'config-unset',
  '--project',
  '@consumer/app',
  '--domain',
  'tool',
  '--pointer',
  '/addons',
  '--result-file',
  commentPlan,
]);
const commentCandidate = JSON.parse(fs.readFileSync(commentPlan, 'utf8')).data.targets[0].after;
assert(commentCandidate.includes('// keep before') && commentCandidate.includes('// keep after'));
authorApply('comment-delete-apply', commentPlan);
fs.writeFileSync(configFile, authorBefore);
put('common/config/rush-plugins/config-rush-plugin.json', {
  ...reg,
  domains: [{ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' }],
});
const removedDomainStatus = path.join(root, 'removed-domain-status.json');
rush('removed-domain-status', [
  'config-status',
  '--operation-id',
  createdForStatus.data.operationId,
  '--result-file',
  removedDomainStatus,
]);
assert.equal(
  JSON.parse(fs.readFileSync(removedDomainStatus, 'utf8')).data.targets[0].observed,
  'unknown',
);
put('common/config/rush-plugins/config-rush-plugin.json', reg);
assert.deepEqual(fs.readFileSync(configFile), authorBefore);
const peerRegistry = structuredClone(reg);
peerRegistry.packages = { ...peerRegistry.packages, 'installed-checks': '1.0.0' };
peerRegistry.validators = {
  peer: {
    module: 'package:installed-checks/check.mjs',
    export: 'validate',
    scope: 'project',
    inputs: {
      peer: {
        path: 'apps/app/config/tool.json',
        base: 'repository',
        allowedRoots: [{ base: 'repository', path: '.' }],
        mustExist: false,
        symlinks: 'within-roots',
      },
    },
  },
};
peerRegistry.domains[0].versions['1.0.0'].validators = ['peer'];
put('common/config/rush-plugins/config-rush-plugin.json', peerRegistry);
put('common/autoinstallers/rush-plugins/node_modules/installed-checks/package.json', {
  name: 'installed-checks',
  version: '1.0.0',
  type: 'module',
});
fs.writeFileSync(
  path.join(ai, 'node_modules/installed-checks/check.mjs'),
  "export function validate(c){return c.project.name==='sample-rig'&&c.inspect('peer').exists?[{code:'PEER_CONSTRAINT',message:'Peer must remain absent'}]:[]}",
);
put('rigs/test-rig/config/tool.json', document);
fs.unlinkSync(configFile);
fs.writeFileSync(
  path.join(ai, 'affected-consumer.mjs'),
  `import assert from 'node:assert/strict';import fs from 'node:fs';import {createClient} from '@butshouldwe/config-rush';const client=createClient({root:${JSON.stringify(repo)}});await assert.rejects(client.previewEdits({requestVersion:1,edits:[{project:'@consumer/app',domain:'tool',operation:'create',document:${JSON.stringify(document)}}]}),error=>error.diagnostics.some(d=>d.code==='PEER_CONSTRAINT'&&d.project==='sample-rig'));assert.equal(fs.existsSync(${JSON.stringify(configFile)}),false);`,
);
run('affected-consumer-installed', path.join(ai, 'affected-consumer.mjs'), []);
put('common/config/rush-plugins/config-rush-plugin.json', reg);
fs.unlinkSync(path.join(repo, 'rigs/test-rig/config/tool.json'));
fs.writeFileSync(configFile, authorBefore);
fs.writeFileSync(
  path.join(ai, 'lock-bytes.mjs'),
  `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createClient} from '@butshouldwe/config-rush';const root=${JSON.stringify(repo)},lock=path.join(root,'common/config/rush/pnpm-lock.yaml'),mirror=path.join(root,'lock-mirror.yaml'),original=fs.readFileSync(lock);fs.writeFileSync(mirror,original);fs.unlinkSync(lock);fs.symlinkSync(mirror,lock);try{const client=createClient({root});const plan=await client.previewEdits({requestVersion:1,edits:[{project:'@consumer/app',domain:'tool',operation:'set',pointer:'/channel',value:'new'}]});fs.appendFileSync(mirror,'\\n# changed\\n');await assert.rejects(client.applyEdits(plan),error=>error.diagnostics.some(d=>d.code==='STALE_PREVIEW'));}finally{fs.unlinkSync(lock);fs.writeFileSync(lock,original);fs.unlinkSync(mirror);}`,
);
run('symlinked-lock-bytes-installed', path.join(ai, 'lock-bytes.mjs'), []);
assert.deepEqual(fs.readFileSync(configFile), authorBefore);
const check = JSON.parse(consumer.stdout);
assert(check.effectAgreement);
const result = {
  pass: true,
  tarballSha256: createHash('sha256').update(fs.readFileSync(values.tarball)).digest('hex'),
  consumer: check.resolved,
  commands: outcomes,
  networkMode: 'offline; all dependency resolutions are explicitly local file artifacts',
  readOnlyBytesPreserved: true,
  authoringRoundTripVerified: true,
  authoringWritesRestored: true,
};
fs.writeFileSync(path.join(root, 'RESULT.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
