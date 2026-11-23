// Tests for scripts/release-npm.mjs and the policy of .github/workflows/publish.yml.
// Run: node --test scripts/release-npm.test.mjs
//
// The publish tests put a stub `npm` first on PATH. The stub records every
// call and answers `view` from a state file, so no test reaches a registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = join(here, 'release-npm.mjs');
const workflowPath = join(root, '.github/workflows/publish.yml');
const REPO = 'butshouldwe/rush';
// Publish order matters: dependencies first, then the umbrella package.
const RELEASE_PACKAGES = ['packages/config-rush', 'packages/fallow-rush', 'packages/sbom-rush'];
const fixtureHome = scratch();

function run(args, { env = {}, cwd = root } = {}) {
  // setup-node exports a placeholder token and npmrc. Only explicit fixtures
  // may supply credentials/configuration to the subprocess under test.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$|authToken|^npm_config_/i.test(key),
    ),
  );
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd,
        env: {
          ...inheritedEnv,
          HOME: fixtureHome,
          NPM_CONFIG_USERCONFIG: join(fixtureHome, '.npmrc'),
          NPM_CONFIG_GLOBALCONFIG: join(fixtureHome, 'global.npmrc'),
          GITHUB_STEP_SUMMARY: '',
          GITHUB_ACTIONS: '',
          // Bound every post-publish wait; tests that need other timing set it.
          RELEASE_VERIFY_TIMEOUT_MS: '2000',
          RELEASE_VERIFY_INTERVAL_MS: '10',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'release-npm-'));
}

function makePackage(base, name, overrides = {}) {
  const dir = join(base, name.replace(/[@/]/g, '_'));
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name,
    version: '1.2.3',
    license: 'MIT',
    repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
    publishConfig: { access: 'public' },
    ...overrides,
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.js'), 'export default 1;\n');
  return dir;
}

async function packTwo() {
  const base = scratch();
  const a = makePackage(base, '@butshouldwe/alpha');
  const b = makePackage(base, '@butshouldwe/beta', {
    dependencies: { '@butshouldwe/alpha': '^1.2.3' },
  });
  const out = join(base, 'release');
  const r = await run(['pack', out, '--repository', REPO, a, b]);
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  return { base, out, manifest };
}

// A stub npm. State maps "<name>@<version>" to a view answer:
// { present: {integrity, tarball, attestations} } | "E404" | "E404_EXIT0" | "EBROKEN".
// On publish it marks the spec present, using `onPublish` to decide what the
// registry then reports (honest bytes and provenance unless told otherwise).
// `onPublish[spec].lagReads: n` makes the next n views still answer
// `lagAs` (default "E404"), the way npm's metadata lags a fresh publish.
function stubNpm(base, { version = '11.6.0', state = {}, onPublish = {} } = {}) {
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  const statePath = join(base, 'npm-state.json');
  const logPath = join(base, 'npm-calls.jsonl');
  writeFileSync(statePath, JSON.stringify({ state, onPublish }));
  writeFileSync(logPath, '');
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const db = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
if (args[0] === 'view') {
  let answer = db.state[args[1]];
  const lag = (db.lag || {})[args[1]];
  if (lag && lag.n > 0) {
    lag.n--;
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(db));
    answer = lag.as;
  }
  const hang = (db.hang || {})[args[1]];
  if (hang && hang.n > 0) {
    hang.n--;
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(db));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hang.ms);
  }
  if (answer === 'E404_EXIT0') {
    console.log(JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } }));
    process.exit(0);
  }
  if (answer === undefined || answer === 'E404') {
    console.error('npm error code E404');
    console.log(JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } }));
    process.exit(1);
  }
  if (answer === 'EBROKEN') { console.error('npm error code ECONNRESET'); process.exit(1); }
  console.log(JSON.stringify([answer.present]));
  process.exit(0);
}
if (args[0] === 'publish') {
  if (args.includes('--dry-run')) process.exit(0);
  const file = path.resolve(args[1]);
  const bytes = fs.readFileSync(file);
  const tgz = path.basename(file);
  const m = /^(.*)-(\\d+\\.\\d+\\.\\d+)\\.tgz$/.exec(tgz);
  const spec = Object.keys(db.state).find((k) => k.endsWith('@' + m[2]) && db.state[k] === 'E404' && k.replace(/[@/]/g, (c) => c === '@' ? '' : '-').startsWith(m[1]));
  const how = db.onPublish[spec] || {};
  if (how.fail) { console.error('npm error code E403'); process.exit(1); }
  if (how.lagReads) {
    db.lag = db.lag || {};
    db.lag[spec] = { n: how.lagReads, as: how.lagAs || 'E404' };
  }
  if (how.hangReads) {
    db.hang = db.hang || {};
    db.hang[spec] = { n: how.hangReads, ms: how.hangMs };
  }
  db.state[spec] = { present: {
    integrity: how.integrity || 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
    tarball: (how.tarballBase || db.onPublish.tarballBase) + tgz,
    attestations: how.noProvenance ? undefined : { url: 'x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
  } };
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(db));
  process.exit(0);
}
console.error('stub npm: unexpected call ' + args.join(' '));
process.exit(9);
`;
  const npm = join(bin, 'npm');
  writeFileSync(npm, stub);
  chmodSync(npm, 0o755);
  const calls = () =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).args);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, calls };
}

// Serves files from `dir` the way the registry serves tarballs.
async function tarballServer(dir, corruptFile, { missFirst = 0, delayMs = 0 } = {}) {
  const misses = {};
  const server = createServer(async (req, res) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const name = basename(req.url);
    misses[name] = (misses[name] ?? 0) + 1;
    if (misses[name] <= missFirst) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = readFileSync(join(dir, basename(req.url)));
      res.writeHead(200);
      res.end(basename(req.url) === corruptFile ? Buffer.from('corrupt download') : body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, [127, 0, 0, 1].join('.'), r));
  const registry = `http://${[127, 0, 0, 1].join('.')}:${server.address().port}/`;
  return { registry, close: () => new Promise((r) => server.close(r)) };
}

const publishCalls = (calls) => calls().filter((a) => a[0] === 'publish');
const viewCalls = (calls, spec) => calls().filter((a) => a[0] === 'view' && a[1] === spec);

// ---------------------------------------------------------------- pack

test('pack writes tarballs, a manifest and SHA256SUMS in the given order', async () => {
  const { out, manifest } = await packTwo();
  assert.deepEqual(
    manifest.map((e) => e.name),
    ['@butshouldwe/alpha', '@butshouldwe/beta'],
  );
  for (const e of manifest) {
    const bytes = readFileSync(join(out, e.file));
    assert.equal(e.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(e.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
  }
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  assert.match(sums, new RegExp(`^${manifest[0].sha256}  ${manifest[0].file}$`, 'm'));
});

for (const [label, overrides, reason] of [
  ['a private package', { private: true }, /private/],
  ['a workspace: dependency', { dependencies: { x: 'workspace:*' } }, /workspace:\*/],
  ['a file: peer dependency', { peerDependencies: { x: 'file:../x' } }, /file:/],
  [
    'a pinned publish registry',
    { publishConfig: { access: 'public', registry: 'https://example.test/' } },
    /registry/,
  ],
  ['restricted access', { publishConfig: { access: 'restricted' } }, /access/],
  [
    'a repository other than the one publishing',
    { repository: { type: 'git', url: 'git+https://github.com/someone/else.git' } },
    /repository/,
  ],
  ['a prerelease version', { version: '1.2.3-beta.1' }, /prerelease/],
]) {
  test(`pack refuses ${label}`, async () => {
    const base = scratch();
    const dir = makePackage(base, '@butshouldwe/alpha', overrides);
    const r = await run(['pack', join(base, 'release'), '--repository', REPO, dir]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, reason);
  });
}

test('pack refuses an output directory that already holds files', async () => {
  const base = scratch();
  const dir = makePackage(base, '@butshouldwe/alpha');
  const out = join(base, 'release');
  mkdirSync(out);
  writeFileSync(join(out, 'stale.tgz'), 'old');
  const r = await run(['pack', out, '--repository', REPO, dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not empty/);
});

// ------------------------------------------------------------- publish

test('publish fixtures ignore ambient setup-node credentials but explicit tokens still fail', async () => {
  const { base, out, manifest } = await packTwo();
  const npm = stubNpm(base);
  const prior = process.env.NODE_AUTH_TOKEN;
  try {
    process.env.NODE_AUTH_TOKEN = 'XXXXX-setup-node-placeholder';
    const r = await run(['publish', out, '--dry-run'], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(publishCalls(npm.calls).length, 2);
    const denied = await run(['publish', out, '--dry-run'], {
      env: {
        ...npm.env,
        RELEASE_MANIFEST: JSON.stringify(manifest),
        NODE_AUTH_TOKEN: 'fixture-token',
      },
    });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /stored npm token forbidden \(NODE_AUTH_TOKEN\)/);
    assert.equal(publishCalls(npm.calls).length, 2);
  } finally {
    if (prior === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = prior;
  }
});

test('publish refuses malformed successful registry dist answers before publishing', async () => {
  const { base, out, manifest } = await packTwo();
  for (const present of [
    null,
    false,
    0,
    '',
    true,
    1,
    'unexpected',
    [],
    {},
    { integrity: 'wrong' },
  ]) {
    const npm = stubNpm(base, {
      state: { '@butshouldwe/alpha@1.2.3': { present }, '@butshouldwe/beta@1.2.3': 'E404' },
    });
    const r = await run(['publish', out], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.notEqual(r.code, 0, JSON.stringify(present));
    assert.match(r.stderr, /registry (state unknown|integrity mismatch)/, JSON.stringify(present));
    assert.equal(publishCalls(npm.calls).length, 0, JSON.stringify(present));
  }
});

test('publish stops before later packages when matching metadata downloads corrupt bytes', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out, manifest[0].file);
  try {
    const npm = stubNpm(base, {
      state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: { tarballBase: srv.registry },
    });
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /@butshouldwe\/alpha@1\.2\.3 downloadable tarball integrity mismatch/);
    assert.deepEqual(
      publishCalls(npm.calls).map((a) => basename(a[1])),
      [manifest[0].file],
    );
  } finally {
    await srv.close();
  }
});

test('publish sends each absent package with --provenance, in order, then verifies it', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out);
  try {
    const npm = stubNpm(base, {
      state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: { tarballBase: srv.registry },
    });
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const pubs = publishCalls(npm.calls);
    assert.deepEqual(
      pubs.map((a) => basename(a[1])),
      manifest.map((e) => e.file),
    );
    for (const a of pubs) {
      assert.ok(a.includes('--provenance'), `missing --provenance: ${a.join(' ')}`);
      assert.ok(a.includes('--access') && a[a.indexOf('--access') + 1] === 'public');
      assert.ok(!a.includes('--dry-run'));
    }
    assert.match(r.stdout, /verified @butshouldwe\/beta@1\.2\.3/);
  } finally {
    await srv.close();
  }
});

test('publish refuses every package when one tarball does not match the build digest', async () => {
  const { base, out, manifest } = await packTwo();
  writeFileSync(join(out, manifest[1].file), 'tampered');
  const npm = stubNpm(base, {
    state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
  });
  const r = await run(['publish', out], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /sha256/);
  assert.equal(publishCalls(npm.calls).length, 0);
});

test('publish refuses a tarball whose package.json disagrees with the manifest', async () => {
  const { base, out, manifest } = await packTwo();
  const lying = manifest.map((e, i) => (i === 0 ? { ...e, name: '@butshouldwe/gamma' } : e));
  const npm = stubNpm(base);
  const r = await run(['publish', out], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(lying) },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /package\.json/);
  assert.equal(publishCalls(npm.calls).length, 0);
});

test('publish refuses a manifest file name that leaves the release directory', async () => {
  const { base, out, manifest } = await packTwo();
  copyFileSync(join(out, manifest[0].file), join(base, 'alpha.tgz'));
  const escaping = manifest.map((e, i) => (i === 0 ? { ...e, file: '../alpha.tgz' } : e));
  const npm = stubNpm(base);
  const r = await run(['publish', out], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(escaping) },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /file/);
  assert.equal(npm.calls().length, 0);
});

test('publish refuses to run without the build manifest', async () => {
  const { base, out } = await packTwo();
  const npm = stubNpm(base);
  const r = await run(['publish', out], { env: { ...npm.env, RELEASE_MANIFEST: '' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /RELEASE_MANIFEST/);
  assert.equal(npm.calls().length, 0);
});

for (const name of [
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'npm_config_//registry.npmjs.org/:_authToken',
]) {
  test(`publish refuses a long-lived token in ${name}`, async () => {
    const { base, out, manifest } = await packTwo();
    const npm = stubNpm(base, {
      state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
    });
    const r = await run(['publish', out], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest), [name]: 'npm_canary_value' },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /token/i);
    assert.doesNotMatch(r.stderr + r.stdout, /npm_canary_value/);
    assert.equal(publishCalls(npm.calls).length, 0);
  });
}

test('publish refuses an npm older than trusted publishing needs', async () => {
  const { base, out, manifest } = await packTwo();
  const npm = stubNpm(base, { version: '11.5.0', state: { '@butshouldwe/alpha@1.2.3': 'E404' } });
  const r = await run(['publish', out], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /11\.5\.1/);
  assert.equal(publishCalls(npm.calls).length, 0);
});

test('publish skips a version already on the registry and publishes the rest', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out);
  try {
    const npm = stubNpm(base, {
      state: {
        '@butshouldwe/alpha@1.2.3': {
          present: { integrity: manifest[0].integrity, tarball: srv.registry + manifest[0].file },
        },
        '@butshouldwe/beta@1.2.3': 'E404',
      },
      onPublish: { tarballBase: srv.registry },
    });
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      publishCalls(npm.calls).map((a) => basename(a[1])),
      [manifest[1].file],
    );
    assert.match(r.stdout, /@butshouldwe\/alpha@1\.2\.3 already published \(same bytes\)/);
  } finally {
    await srv.close();
  }
});

test('publish stops when the registry state is unknown, not absent', async () => {
  const { base, out, manifest } = await packTwo();
  const npm = stubNpm(base, { state: { '@butshouldwe/alpha@1.2.3': 'EBROKEN' } });
  const r = await run(['publish', out], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
  });
  assert.notEqual(r.code, 0);
  assert.equal(publishCalls(npm.calls).length, 0);
});

test('publish fails when the registry holds the version without provenance', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out);
  try {
    const npm = stubNpm(base, {
      state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: { tarballBase: srv.registry, '@butshouldwe/alpha@1.2.3': { noProvenance: true } },
    });
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /provenance/);
    // The first failure stops the run: the umbrella package is not published
    // on top of a dependency that failed verification.
    assert.equal(publishCalls(npm.calls).length, 1);
  } finally {
    await srv.close();
  }
});

test('publish fails when the registry serves bytes other than the built tarball', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out);
  try {
    const npm = stubNpm(base, {
      state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: {
        tarballBase: srv.registry,
        '@butshouldwe/alpha@1.2.3': { integrity: manifest[1].integrity },
      },
    });
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /integrity/);
  } finally {
    await srv.close();
  }
});

test('publish fails when the tarball URL is not on the publish registry', async () => {
  const { base, out, manifest } = await packTwo();
  const npm = stubNpm(base, {
    state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
    onPublish: { tarballBase: 'https://example.invalid/' },
  });
  const r = await run(['publish', out], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /tarball URL/);
});

// ------------------------------------------- post-publish propagation
//
// rush#50: on run 45109763473 npm's metadata lagged each fresh publish, the
// immediate readback failed, and every attempt published one package and
// stopped. These pin the bounded wait and what still fails at once.
// Classes (ADR-067 amendment 1): the wait tests and the timing checks are R2,
// the release contract. "fails at once" and "stops with a not-visible error"
// are R1: a final bad answer must not be retried into a pass, and a wait that
// runs out must not exit 0. The R1 mutant is in
// receipts/evidence/publish-verify-retry/controls.sh.

const ALPHA = '@butshouldwe/alpha@1.2.3';

async function lagged(onPublishAlpha, { serverOpts, env = {} } = {}) {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out, undefined, serverOpts);
  if (typeof onPublishAlpha === 'function') onPublishAlpha = onPublishAlpha(manifest, srv.registry);
  try {
    const npm = stubNpm(base, {
      state: { [ALPHA]: 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: { tarballBase: srv.registry, [ALPHA]: onPublishAlpha },
    });
    const started = Date.now();
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest), ...env },
    });
    return { r, npm, manifest, ms: Date.now() - started };
  } finally {
    await srv.close();
  }
}

for (const lagAs of ['E404', 'E404_EXIT0', 'EBROKEN']) {
  test(`publish waits while a fresh version still reads ${lagAs}, then verifies and continues`, async () => {
    const { r, npm } = await lagged({ lagReads: 3, lagAs });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    // one pre-publish read, three lagged reads, one good read
    assert.equal(viewCalls(npm.calls, ALPHA).length, 5);
    assert.equal(publishCalls(npm.calls).length, 2);
    assert.match(r.stdout, /verified @butshouldwe\/alpha@1\.2\.3/);
    assert.match(r.stdout, /verified @butshouldwe\/beta@1\.2\.3/);
    assert.match(r.stdout, /published=2 skipped=0/);
  });
}

for (const [label, partial] of [
  ['no integrity', () => ({})],
  ['no tarball', (m) => ({ integrity: m[0].integrity })],
  ['an unparseable tarball', (m) => ({ integrity: m[0].integrity, tarball: 'not a url' })],
]) {
  // R2 (Lyra F1, F2): a half-written fresh answer is lag, not a mismatch.
  test(`publish waits while fresh metadata has ${label}, then verifies`, async () => {
    const { r, npm } = await lagged((m) => ({ lagReads: 2, lagAs: { present: partial(m) } }));
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(viewCalls(npm.calls, ALPHA).length, 4);
    assert.match(r.stdout, /published=2 skipped=0/);
  });
}

// R1 (Lyra 7239 F1): a tarball URL off the publish registry is final even
// when the same answer still lacks its integrity. It must fail on the first
// read after the publish, and beta must not be published.
for (const [label, url] of [
  ['a foreign tarball URL', () => 'https://example.invalid/alpha-1.2.3.tgz'],
  ['a credential tarball URL', (reg) => reg.replace('://', '://user:pass@') + 'alpha-1.2.3.tgz'],
]) {
  test(`publish fails at once on ${label} in a fresh answer without integrity`, async () => {
    const prov = { url: 'x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } };
    const { r, npm } = await lagged((m, reg) => ({
      lagReads: 1,
      lagAs: { present: { tarball: url(reg), attestations: prov } },
    }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /tarball URL is not on the publish registry/);
    assert.equal(viewCalls(npm.calls, ALPHA).length, 2);
    assert.equal(publishCalls(npm.calls).length, 1);
  });
}

// R2 (Lyra F3, F4): a hung read or a slow download cannot hold the job past
// the bound. Each read gets the time left, at least 1 s.
test('publish stops near the bound when a fresh npm view hangs', async () => {
  const { r, ms } = await lagged(
    { hangReads: 1, hangMs: 20000 },
    { env: { RELEASE_VERIFY_TIMEOUT_MS: '300', RELEASE_VERIFY_INTERVAL_MS: '10' } },
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /published but not verified within 0\.3s/);
  assert.ok(ms < 10000, `took ${ms} ms`);
});

test('publish stops near the bound when a fresh tarball download stalls', async () => {
  const { r, ms } = await lagged(
    {},
    {
      serverOpts: { delayMs: 20000 },
      env: { RELEASE_VERIFY_TIMEOUT_MS: '300', RELEASE_VERIFY_INTERVAL_MS: '10' },
    },
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /published but not verified within 0\.3s/);
  assert.ok(ms < 10000, `took ${ms} ms`);
});

test('publish waits while the fresh tarball is not downloadable yet', async () => {
  const { r } = await lagged({}, { serverOpts: { missFirst: 2 } });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /published=2 skipped=0/);
});

test('publish stops with a not-visible error, not a mismatch, when the wait runs out', async () => {
  const { r, npm } = await lagged(
    { lagReads: 100000 },
    { env: { RELEASE_VERIFY_TIMEOUT_MS: '300', RELEASE_VERIFY_INTERVAL_MS: '10' } },
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /@butshouldwe\/alpha@1\.2\.3 published but not verified within 0\.3s/);
  assert.match(r.stderr, /rerun/);
  assert.doesNotMatch(r.stderr, /integrity mismatch/);
  assert.equal(publishCalls(npm.calls).length, 1);
});

for (const [label, how, reason] of [
  ['other bytes', 'integrity', /registry integrity mismatch/],
  ['no provenance', { noProvenance: true }, /provenance missing/],
  ['a foreign tarball URL', { tarballBase: 'https://example.invalid/' }, /tarball URL/],
]) {
  test(`publish fails at once, without waiting, when the fresh version has ${label}`, async () => {
    const { base, out, manifest } = await packTwo();
    const srv = await tarballServer(out);
    try {
      const alpha = how === 'integrity' ? { integrity: manifest[1].integrity } : how;
      const npm = stubNpm(base, {
        state: { [ALPHA]: 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
        onPublish: { tarballBase: srv.registry, [ALPHA]: alpha },
      });
      const r = await run(['publish', out, '--registry', srv.registry], {
        env: {
          ...npm.env,
          RELEASE_MANIFEST: JSON.stringify(manifest),
          // a retry would show as extra views well inside this window
          RELEASE_VERIFY_TIMEOUT_MS: '3000',
          RELEASE_VERIFY_INTERVAL_MS: '200',
        },
      });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, reason);
      assert.equal(viewCalls(npm.calls, ALPHA).length, 2);
      assert.equal(publishCalls(npm.calls).length, 1);
    } finally {
      await srv.close();
    }
  });
}

test('publish fails at once when a fresh tarball downloads with other bytes', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out, manifest[0].file);
  try {
    const npm = stubNpm(base, {
      state: { [ALPHA]: 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: { tarballBase: srv.registry },
    });
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: {
        ...npm.env,
        RELEASE_MANIFEST: JSON.stringify(manifest),
        RELEASE_VERIFY_TIMEOUT_MS: '3000',
        RELEASE_VERIFY_INTERVAL_MS: '200',
      },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /downloadable tarball integrity mismatch/);
    assert.equal(viewCalls(npm.calls, ALPHA).length, 2);
  } finally {
    await srv.close();
  }
});

test('an exit-0 E404 payload before publishing means absent, so the package is published', async () => {
  const { base, out, manifest } = await packTwo();
  const srv = await tarballServer(out);
  try {
    const npm = stubNpm(base, {
      state: { [ALPHA]: 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
      onPublish: { tarballBase: srv.registry },
    });
    // the first read of alpha answers with the payload and exit 0
    const st = JSON.parse(readFileSync(join(base, 'npm-state.json'), 'utf8'));
    st.lag = { [ALPHA]: { n: 1, as: 'E404_EXIT0' } };
    writeFileSync(join(base, 'npm-state.json'), JSON.stringify(st));
    const r = await run(['publish', out, '--registry', srv.registry], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /published=2 skipped=0/);
  } finally {
    await srv.close();
  }
});

for (const [value, label] of [
  ['abc', 'text'],
  ['-1', 'a negative'],
  ['600001', 'over ten minutes'],
  ['1.5', 'a fraction'],
]) {
  test(`publish refuses ${label} verify timeout before publishing`, async () => {
    const { base, out, manifest } = await packTwo();
    const npm = stubNpm(base, { state: { [ALPHA]: 'E404', '@butshouldwe/beta@1.2.3': 'E404' } });
    const r = await run(['publish', out], {
      env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest), RELEASE_VERIFY_TIMEOUT_MS: value },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /RELEASE_VERIFY_TIMEOUT_MS/);
    assert.equal(publishCalls(npm.calls).length, 0);
  });
}

test('dry run publishes nothing and asks for no provenance', async () => {
  const { base, out, manifest } = await packTwo();
  const npm = stubNpm(base, {
    state: { '@butshouldwe/alpha@1.2.3': 'E404', '@butshouldwe/beta@1.2.3': 'E404' },
  });
  const r = await run(['publish', out, '--dry-run'], {
    env: { ...npm.env, RELEASE_MANIFEST: JSON.stringify(manifest) },
  });
  assert.equal(r.code, 0, r.stderr);
  const pubs = publishCalls(npm.calls);
  assert.equal(pubs.length, 2);
  for (const a of pubs) {
    assert.ok(a.includes('--dry-run'));
    assert.ok(!a.includes('--provenance'));
  }
});

// ------------------------------------------------------ workflow policy
//
// The workflow is plain YAML that this repo owns. These checks read it as
// text, split by job, so a reformat that hides a rule fails here first.

const workflow = readFileSync(workflowPath, 'utf8');
const code = workflow
  .split('\n')
  .map((l) => l.replace(/(^|\s)#.*$/, ''))
  .join('\n');

function jobBlock(name) {
  const lines = code.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `job ${name} not found`);
  let end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('workflow: no stored npm credential of any kind', () => {
  assert.doesNotMatch(code, /secrets\./);
  assert.doesNotMatch(code, /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
  assert.doesNotMatch(
    code,
    /registry-url:/,
    'setup-node registry-url writes a token placeholder .npmrc',
  );
});

test('workflow: only the gated publish job can mint an OIDC token', () => {
  assert.match(code, /^permissions: \{\}$/m);
  assert.equal(code.match(/id-token:\s*write/g)?.length, 1);
  const publish = jobBlock('publish');
  assert.match(publish, /^ {4}environment: npm-release$/m);
  assert.match(publish, /^ {6}id-token: write$/m);
  assert.match(publish, /^ {4}needs: build$/m);
  assert.match(
    publish,
    /^ {4}if: \$\{\{ !inputs\.dry_run && github\.ref == 'refs\/heads\/main' \}\}$/m,
  );
  assert.doesNotMatch(jobBlock('build'), /id-token|environment:/);
});

test('workflow: the token-holding job installs and builds nothing', () => {
  const publish = jobBlock('publish');
  assert.doesNotMatch(publish, /pnpm|npm (ci|install)|install-run-rush|action-setup/);
  assert.match(publish, /node scripts\/release-npm\.mjs publish "\$RUNNER_TEMP\/release"$/m);
  assert.match(publish, /RELEASE_MANIFEST: \$\{\{ needs\.build\.outputs\.manifest \}\}/);
});

test('workflow: manual trigger only, dry run by default', () => {
  assert.match(code, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(
    code,
    /^\s+(push|pull_request|pull_request_target|release|schedule|workflow_run):/m,
  );
  assert.match(code, /dry_run:\n(?: {8}.*\n)*? {8}default: true\n/);
});

test('workflow: no caches and every action pinned to a commit', () => {
  assert.doesNotMatch(code, /actions\/cache|^\s+cache:/m);
  const setups = code.match(/uses: actions\/setup-node@/g) ?? [];
  assert.equal((code.match(/package-manager-cache: false/g) ?? []).length, setups.length);
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned to a commit`);
  for (const m of code.matchAll(/uses: actions\/checkout@[0-9a-f]{40}\n((?: {8}.*\n)*)/g)) {
    assert.match(m[1], /persist-credentials: false/);
  }
});

test('workflow: packs exactly the release packages, in dependency order', () => {
  const m =
    /node scripts\/release-npm\.mjs pack "\$RUNNER_TEMP\/release" --repository "\$GITHUB_REPOSITORY" \\\n((?:\s+\S+ \\\n)*\s+\S+)\n/.exec(
      code,
    );
  assert.ok(m, 'pack invocation not found');
  assert.deepEqual(m[1].split(/\s*\\\n\s*|\s+/).filter(Boolean), RELEASE_PACKAGES);
  assert.doesNotMatch(code, /--registry/);
});

test('workflow: the publish step leaves post-publish wait timing at its defaults', () => {
  assert.doesNotMatch(code, /RELEASE_VERIFY_(TIMEOUT|INTERVAL)_MS/);
});
