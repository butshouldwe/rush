import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'jsonc-parser';

// Prepared copies of real repositories only. This harness never creates rush.json.
const { values: args } = parseArgs({
  options: {
    resume: { type: 'boolean' },
    'registry-fetch': { type: 'boolean' },
    ...Object.fromEntries(
      [
        'repo',
        'project',
        'node',
        'rush-bin',
        'global',
        'store',
        'tarball',
        'checks-tarball',
        'evidence',
        'baseline-lock',
      ].map((name) => [name, { type: 'string' }]),
    ),
  },
});
for (const key of [
  'repo',
  'project',
  'node',
  'rush-bin',
  'global',
  'store',
  'tarball',
  'checks-tarball',
  'evidence',
])
  assert(args[key], `Missing --${key}`);
const repo = path.resolve(args.repo),
  evidence = path.resolve(args.evidence);
assert(fs.existsSync(path.join(repo, 'rush.json')), 'A real repository must already exist');
assert(!fs.existsSync(path.join(repo, '.git')), 'Use an exported copy, never a Git checkout');
assert(
  fs.existsSync(args['rush-bin']),
  'Use the exact existing Rush engine path, including peer suffixes',
);
for (const key of ['node', 'tarball', 'checks-tarball', 'baseline-lock']) {
  if (args[key])
    assert(
      fs.existsSync(args[key]) && fs.statSync(args[key]).isFile(),
      `Missing input file --${key}: ${args[key]}`,
    );
}
assert(!fs.existsSync(evidence), 'Evidence directory must be fresh');
fs.mkdirSync(evidence, { recursive: true });
const env = {
  HOME: process.env.HOME,
  LANG: 'C.UTF-8',
  PATH: `${path.dirname(args.node)}:/usr/bin:/bin`,
  RUSH_GLOBAL_FOLDER: args.global,
  RUSH_PNPM_STORE_PATH: args.store,
  RUSH_BUILD_CACHE_ENABLED: '0',
  npm_config_store_dir: args.store,
  npm_config_cache_dir: args.store,
  npm_config_offline: 'true',
  npm_config_ignore_scripts: 'true',
  npm_config_userconfig: '/dev/null',
  CI: '1',
};
// Inherit no tokens, Node loaders, or source-workspace routing variables.
const steps = [];
function execute(name, bin, argv, expected = 0, cwd = repo) {
  const out = spawnSync(args.node, [bin, ...argv], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(evidence, `${name}.stdout`), out.stdout ?? '');
  fs.writeFileSync(path.join(evidence, `${name}.stderr`), out.stderr ?? '');
  steps.push({ name, bin, args: argv, exit: out.status, cwd });
  fs.writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(steps, null, 2));
  assert.equal(out.error, undefined, `${name}: ${out.error?.message}`);
  assert.equal(out.status, expected, `${name}: ${out.stdout}\n${out.stderr}`);
  return out;
}
const rush = (name, argv, expected = 0) => execute(name, args['rush-bin'], argv, expected);
const engine = createRequire(args['rush-bin'])('@microsoft/rush-lib');
const native = engine.RushConfiguration.loadFromConfigurationFile(path.join(repo, 'rush.json'));
const selected = native.projectsByName.get(args.project);
assert(selected, 'The exact name must exist in the real Rush registry');
const folder = selected.projectFolder,
  relative = path.relative(repo, folder);
assert(!relative.startsWith('..') && !path.isAbsolute(relative));
assert.equal(
  JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).name,
  args.project,
);
const documentName = fs.existsSync(path.join(folder, 'README.md')) ? 'README.md' : 'package.json';
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
const ai = path.join(repo, 'common/autoinstallers/rush-plugins');
const pkgFile = path.join(ai, 'package.json');
const pkg = fs.existsSync(pkgFile)
  ? JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  : { name: 'rush-plugins', version: '0.0.0', private: true };
pkg.dependencies = {
  ...pkg.dependencies,
  '@butshouldwe/config-rush': `file:${path.resolve(args.tarball)}`,
  '@config-rush-proof/checks': `file:${path.resolve(args['checks-tarball'])}`,
};
json(pkgFile, pkg);
// An explicit independent autoinstaller workspace avoids inheriting a parent workspace.
fs.writeFileSync(path.join(ai, 'pnpm-workspace.yaml'), 'packages: []\n');
const pluginsFile = path.join(repo, 'common/config/rush/rush-plugins.json');
const plugins = fs.existsSync(pluginsFile)
  ? parse(fs.readFileSync(pluginsFile, 'utf8'))
  : { plugins: [] };
const registration = {
  packageName: '@butshouldwe/config-rush',
  pluginName: 'config-rush-plugin',
  autoinstallerName: 'rush-plugins',
};
const existing = (plugins.plugins ?? []).filter((p) => p.pluginName === 'config-rush-plugin');
if (existing.length) {
  assert(args.resume, 'Do not replace an existing registration');
  assert.deepEqual(existing, [registration]);
} else plugins.plugins = [...(plugins.plugins ?? []), registration];
json(pluginsFile, plugins);
if (args['registry-fetch']) env.npm_config_offline = 'false';
rush('autoinstaller', ['update-autoinstaller', '--name', 'rush-plugins']);
env.npm_config_offline = 'true';
if (args['baseline-lock']) {
  // Normal pnpm lock generation is checked separately before workspace activation.
  const review = execute('lock-review', path.resolve(import.meta.dirname, 'review-ai-lock.mjs'), [
    args['baseline-lock'],
    path.join(ai, 'pnpm-lock.yaml'),
    args['rush-bin'],
  ]);
  assert(JSON.parse(review.stdout).existingUnchanged);
}
rush('activation', ['update']);
const registry = path.join(repo, 'common/config/rush-plugins/config-rush-plugin.json');
assert(!fs.existsSync(registry), 'Do not overwrite existing domain registration');
const rule = {
  base: 'project',
  allowedRoots: [{ base: 'project', path: '.' }],
  mustExist: true,
  symlinks: 'within-roots',
};
json(registry, {
  formatVersion: 1,
  packages: { '@config-rush-proof/checks': '1.0.0' },
  validators: {
    'local-check': {
      module: 'package:@config-rush-proof/checks/check.mjs',
      export: 'validate',
      scope: 'project',
      inputs: { document: { ...rule, path: documentName } },
    },
  },
  domains: [
    {
      name: 'u01-proof',
      projectFile: 'config/u01-proof.json',
      required: true,
      versions: {
        '1.0.0': {
          schema: 'common/config/u01-proof/effective.json',
          fragmentSchema: 'common/config/u01-proof/fragment.json',
          resources: ['common/config/u01-proof/fields.json'],
          paths: { '/docs': rule },
          projectOwned: ['/projectKey'],
          validators: ['local-check'],
        },
      },
    },
  ],
});
const fields = {
  $id: 'urn:config-rush:proof:fields',
  type: 'object',
  properties: {
    mode: { enum: ['enabled', 'disabled'] },
    projectKey: { type: 'string' },
    channel: { type: ['string', 'null'] },
    docs: { type: 'string' },
    addons: { type: 'array', items: { type: 'string' } },
  },
};
json(path.join(repo, 'common/config/u01-proof/fields.json'), fields);
json(path.join(repo, 'common/config/u01-proof/fragment.json'), {
  type: 'object',
  allOf: [{ $ref: fields.$id }],
  unevaluatedProperties: false,
});
const effective = JSON.parse(
  '{"type":"object","allOf":[{"$ref":"urn:config-rush:proof:fields"},{"if":{"properties":{"mode":{"const":"enabled"}},"required":["mode"]},"then":{"required":["docs"]}}],"required":["projectKey"],"unevaluatedProperties":false}',
);
json(path.join(repo, 'common/config/u01-proof/effective.json'), effective);
const baseFile = path.join(repo, 'common/config/u01-proof/base.json');
const base = {
  formatVersion: 1,
  domain: 'u01-proof',
  contractVersion: '1.0.0',
  values: { mode: 'enabled', docs: documentName, channel: 'inherited', addons: ['base'] },
};
json(baseFile, base);
const local = path.join(folder, 'config/u01-proof.json');
assert(!fs.existsSync(local));
const document = {
  formatVersion: 1,
  domain: 'u01-proof',
  contractVersion: '1.0.0',
  extends: path.relative(path.dirname(local), baseFile),
  suppress: ['/addons'],
  values: { projectKey: args.project, channel: null },
};
json(local, document);
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checkedInputs = [
  registry,
  local,
  baseFile,
  ...['fields', 'fragment', 'effective'].map((name) =>
    path.join(repo, `common/config/u01-proof/${name}.json`),
  ),
  path.join(folder, documentName),
];
const inputDigests = checkedInputs.map(digest);
const originalBytes = fs.readFileSync(local),
  baseBytes = fs.readFileSync(baseFile),
  readmeBytes = fs.readFileSync(path.join(folder, documentName));
function command(name, operation, expected = 0) {
  const output = path.join(evidence, `${name}.json`),
    argv = [`config-${operation}`, '--result-file', output, '--invocation-id', name];
  if (operation !== 'discover') argv.push('--project', args.project, '--domain', 'u01-proof');
  rush(name, argv, expected);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.invocationId, name);
  assert.equal(result.status, expected ? 'failure' : 'success');
  return { result, output };
}
const discovery = command('discover', 'discover').result;
assert.deepEqual(
  discovery.data.projects.map((p) => p.name).toSorted(),
  native.projects.map((p) => p.packageName).toSorted(),
);
const valid = command('valid', 'get');
assert.equal(valid.result.data.values.channel, null);
assert.equal(valid.result.data.values.projectKey, args.project);
assert(!('addons' in valid.result.data.values));
assert.equal(
  valid.result.data.paths['/docs'].resolved,
  fs.realpathSync(path.join(folder, documentName)),
);
assert(valid.result.data.provenance['/projectKey'].authoredLocally);
assert.equal(valid.result.data.checks[0].status, 'passed');
assert.deepEqual(command('explain', 'explain').result.data.result, valid.result.data);
assert(command('validate', 'validate').result.data.valid);
assert.deepEqual(checkedInputs.map(digest), inputDigests);
assert.deepEqual(fs.readFileSync(local), originalBytes);
assert.deepEqual(fs.readFileSync(baseFile), baseBytes);
assert.deepEqual(fs.readFileSync(path.join(folder, documentName)), readmeBytes);
fs.writeFileSync(
  path.join(ai, 'u01-consumer.mjs'),
  `import fs from 'node:fs';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {createClient,ConfigurationError} from '@butshouldwe/config-rush';
const resolved=import.meta.resolve('@butshouldwe/config-rush');assert(resolved.includes('/node_modules/.pnpm/'));assert.equal(resolved,pathToFileURL(fs.realpathSync(new URL('./node_modules/@butshouldwe/config-rush/dist/index.js',import.meta.url))).href);
const c=createClient({root:process.argv[2]}),q={project:process.argv[3],domain:'u01-proof'};const value=await c.get(q);const expected=JSON.parse(fs.readFileSync(process.argv[4],'utf8')).data;assert.deepEqual(value,expected);
const require=createRequire(resolved);const {Effect}=await import(pathToFileURL(require.resolve('effect')).href);assert.deepEqual(await Effect.runPromise(c.getEffect(q)),value);
await assert.rejects(c.get({project:'not-a-registered-project',domain:'u01-proof'}),e=>e instanceof ConfigurationError&&e.diagnostics[0].code==='UNKNOWN_PROJECT');
console.log(JSON.stringify({resolved,effectAgreement:true,project:value.project}));`,
);
const consumer = execute(
  'consumer',
  path.join(ai, 'u01-consumer.mjs'),
  [repo, args.project, valid.output],
  0,
  evidence,
);
const consumerResult = JSON.parse(consumer.stdout);
assert(consumerResult.effectAgreement);
json(local, { ...document, values: { ...document.values, channel: 'reject' } });
assert.equal(command('semantic-invalid', 'get', 2).result.diagnostics[0].code, 'CHANNEL_REJECTED');
assert(!command('semantic-invalid-validate', 'validate', 2).result.data.valid);
json(local, document);
json(baseFile, { ...base, values: { ...base.values, typo: true } });
const invalid = command('structural-invalid', 'explain', 2).result;
assert.equal(invalid.data.result, null);
assert.equal(invalid.data.checks[0].status, 'skipped');
json(baseFile, base);
const preserved = fs.readFileSync(valid.output);
rush(
  'stale-result',
  [
    'config-get',
    '--project',
    args.project,
    '--domain',
    'u01-proof',
    '--result-file',
    valid.output,
    '--invocation-id',
    'must-not-replace',
  ],
  2,
);
assert.deepEqual(fs.readFileSync(valid.output), preserved);
command('restored', 'get');
assert.deepEqual(checkedInputs.map(digest), inputDigests);
assert.deepEqual(fs.readFileSync(local), originalBytes);
assert.deepEqual(fs.readFileSync(baseFile), baseBytes);
assert.deepEqual(fs.readFileSync(path.join(folder, documentName)), readmeBytes);
const result = {
  pass: true,
  repo,
  project: args.project,
  registeredProjects: native.projects.length,
  tarballSha256: createHash('sha256').update(fs.readFileSync(args.tarball)).digest('hex'),
  compiledConsumer: consumerResult.resolved,
  readOnlyBytesPreserved: true,
  nativeAdoption: false,
  checkedInputs,
  inputDigests,
  harnessSha256: digest(import.meta.filename),
  lockReviewerSha256: digest(path.join(import.meta.dirname, 'review-ai-lock.mjs')),
  steps,
};
json(path.join(evidence, 'RESULT.json'), result);
console.log(JSON.stringify(result, null, 2));
