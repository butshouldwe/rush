// Release the exact tarballs inspected by the build job, without npm tokens.
// Node 26, npm >=11.5.1. No third-party imports or package lifecycle scripts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [mode, output, ...args] = process.argv.slice(2);
const registryIndex = args.indexOf('--registry');
// A loopback registry is supported for local refusal probes, never in CI.
const registry = registryIndex < 0 ? 'https://registry.npmjs.org/' : args[registryIndex + 1];
const dry = args.includes('--dry-run');
const hash = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const sri = (bytes) => 'sha512-' + hash(bytes, 'sha512', 'base64');
function fail(message) {
  throw new Error(message);
}
// A registry answer that may still change: npm's metadata and tarball CDN
// lag a fresh publish (rush#50). Before publishing it fails closed like any
// error; after publishing it is retried until the bounded wait runs out.
class Pending extends Error {}
function pending(message) {
  throw new Pending(message);
}
// Post-publish wait. Overridable for tests only; the workflow sets neither.
function timing(name, fallback) {
  const text = process.env[name];
  if (text === undefined || text === '') return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 600000) fail(`${name} must be 0..600000 ms`);
  return n;
}
function json(text) {
  return JSON.parse(text);
}
function npm(params, cwd, timeout) {
  return execFileSync('npm', params, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}
function one(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) fail('expected one registry answer');
    return value[0];
  }
  return value;
}
function validate(p, repository) {
  if (!/^@butshouldwe\/[a-z0-9-]+$/.test(p.name)) fail('unexpected package name');
  if (!/^\d+\.\d+\.\d+$/.test(p.version)) fail('invalid or prerelease version');
  if (p.private) fail(`${p.name} is private`);
  if (p.publishConfig?.registry) fail(`${p.name} pins a publish registry`);
  if (p.publishConfig?.access !== 'public') fail(`${p.name} must declare public access`);
  if (p.repository?.url !== `git+https://github.com/${repository}.git`)
    fail(`${p.name} repository mismatch`);
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const version of Object.values(p[kind] ?? {})) {
      if (/^(workspace:|file:|link:)/.test(version))
        fail(`${p.name}: nonregistry dependency ${version}`);
    }
  }
}
// null: the registry says the version is absent. Throws Pending when the
// state is unknown (network error, unparseable or malformed answer).
function view(spec, timeout) {
  let dist;
  try {
    dist = one(json(npm(['view', spec, 'dist', '--json', '--registry', registry], undefined, timeout)));
  } catch (e) {
    let code;
    try {
      code = json(e.stdout).error?.code;
    } catch {
      /* unknown stays unknown */
    }
    if (code === 'E404') return null;
    pending(`registry state unknown for ${spec}`);
  }
  // Some npm versions print the E404 payload and still exit 0.
  if (dist && typeof dist === 'object' && !Array.isArray(dist) && 'error' in dist) {
    if (dist.error?.code === 'E404') return null;
    pending(`registry state unknown for ${spec}`);
  }
  if (!dist || typeof dist !== 'object' || Array.isArray(dist))
    pending(`registry state unknown for ${spec}`);
  return dist;
}
async function verify(entry, dist, provenance, timeout = 30000) {
  const spec = `${entry.name}@${entry.version}`;
  if (dist === null) pending(`${spec} not on the registry yet`);
  // Final answers first. A version's bytes never change once published, so a
  // parseable tarball URL off the publish registry is final, even in an
  // answer still missing its integrity (rush#51 Lyra 7239 F1). So are another
  // integrity and missing provenance.
  let url;
  try {
    url = new URL(dist.tarball);
  } catch {
    /* absent or unparseable: incomplete, checked below */
  }
  const base = new URL(registry);
  if (
    url &&
    (url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.username ||
    url.password)
  ) {
    fail(`${spec} tarball URL is not on the publish registry`);
  }
  // Metadata without a well-formed integrity or tarball is incomplete, not
  // wrong: it may still fill in (rush#51 Lyra 7235 F1, F2).
  if (typeof dist.integrity !== 'string' || !dist.integrity)
    pending(`registry state unknown for ${spec} (no integrity)`);
  if (dist.integrity !== entry.integrity) fail(`${spec} registry integrity mismatch`);
  if (!url) pending(`registry state unknown for ${spec} (no tarball URL)`);
  if (provenance && !dist.attestations?.provenance?.predicateType)
    fail(`${spec} provenance missing`);
  let response, bytes;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    pending(`${spec} tarball download failed`);
  }
  if (!response.ok) pending(`${spec} tarball not downloadable yet (HTTP ${response.status})`);
  if (sri(bytes) !== entry.integrity) fail(`${spec} downloadable tarball integrity mismatch`);
  console.log(`verified ${spec}`);
}
// After a publish: retry Pending answers with backoff until verified or the
// wait runs out. Any other failure stops at once. A rerun is safe either
// way: a version that becomes visible with the same bytes is skipped.
async function settle(entry, { timeout, interval }) {
  const spec = `${entry.name}@${entry.version}`;
  const deadline = Date.now() + timeout;
  let wait = interval;
  for (;;) {
    let reason;
    // Each read gets the time left, at least 1 s, so a hung `npm view` or a
    // slow download cannot hold the job past the bound (Lyra F3, F4).
    const left = () => Math.max(1000, deadline - Date.now());
    try {
      return await verify(entry, view(spec, left()), true, Math.min(30000, left()));
    } catch (e) {
      if (!(e instanceof Pending)) throw e;
      reason = e.message;
    }
    if (Date.now() + wait > deadline) {
      fail(
        `${spec} published but not verified within ${timeout / 1000}s (${reason}); ` +
          'rerun the failed job once npm shows it: same bytes are skipped',
      );
    }
    console.log(`${reason}; retrying in ${wait / 1000}s`);
    await sleep(wait);
    wait = Math.min(wait * 2, 30000);
  }
}

try {
  if (!output || !['pack', 'publish'].includes(mode))
    fail('usage: release-npm.mjs pack|publish <directory>');
  if (process.env.GITHUB_ACTIONS && registry !== 'https://registry.npmjs.org/')
    fail('CI requires public npm');
  const dir = resolve(output);
  if (mode === 'pack') {
    const i = args.indexOf('--repository');
    if (i !== 0 || !args[1] || args.length < 3)
      fail('pack requires --repository <owner/repo> <packages...>');
    if (existsSync(dir) && readdirSync(dir).length) fail('release directory is not empty');
    mkdirSync(dir, { recursive: true });
    const entries = [];
    for (const pkg of args.slice(2)) {
      const p = json(readFileSync(join(pkg, 'package.json'), 'utf8'));
      validate(p, args[1]);
      const result = json(
        npm(['pack', '--json', '--ignore-scripts', '--pack-destination', dir], resolve(pkg)),
      );
      // npm 11 returns an array; npm 12 returns a keyed object.
      const info = Array.isArray(result) ? result[0] : Object.values(result)[0];
      const file = basename(info.filename);
      const bytes = readFileSync(join(dir, file));
      entries.push({
        name: p.name,
        version: p.version,
        file,
        sha256: hash(bytes, 'sha256', 'hex'),
        integrity: sri(bytes),
      });
    }
    const manifest = JSON.stringify(entries);
    writeFileSync(join(dir, 'manifest.json'), manifest + '\n');
    writeFileSync(join(dir, 'SHA256SUMS'), entries.map((e) => `${e.sha256}  ${e.file}\n`).join(''));
    console.log(manifest);
  } else {
    // Do not read the downloaded manifest as authority. It comes from a build
    // output bound to this workflow run, not from inside the artifact.
    if (!process.env.RELEASE_MANIFEST) fail('RELEASE_MANIFEST is required');
    const entries = json(process.env.RELEASE_MANIFEST);
    if (!Array.isArray(entries) || !entries.length) fail('empty release manifest');
    for (const e of entries) {
      if (!/^[a-z0-9.-]+\.tgz$/.test(e.file)) fail('invalid manifest file');
      const bytes = readFileSync(join(dir, e.file));
      if (hash(bytes, 'sha256', 'hex') !== e.sha256) fail(`${e.name}: sha256 mismatch`);
      if (sri(bytes) !== e.integrity) fail(`${e.name}: integrity mismatch`);
      const p = json(
        execFileSync('tar', ['-xOf', join(dir, e.file), 'package/package.json'], {
          encoding: 'utf8',
        }),
      );
      if (p.name !== e.name || p.version !== e.version)
        fail('tarball package.json disagrees with manifest');
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (value && /^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$|authToken/i.test(key))
        fail(`stored npm token forbidden (${key})`);
    }
    const v = npm(['--version']).trim().split('.').map(Number);
    if (!(v[0] > 11 || (v[0] === 11 && (v[1] > 5 || (v[1] === 5 && v[2] >= 1)))))
      fail('npm >=11.5.1 required');
    const wait = {
      timeout: timing('RELEASE_VERIFY_TIMEOUT_MS', 300000),
      interval: timing('RELEASE_VERIFY_INTERVAL_MS', 5000),
    };
    let published = 0,
      skipped = 0;
    for (const e of entries) {
      const spec = `${e.name}@${e.version}`;
      if (dry) {
        console.log(
          npm([
            'publish',
            join(dir, e.file),
            '--dry-run',
            '--ignore-scripts',
            '--access',
            'public',
            '--registry',
            registry,
          ]),
        );
        continue;
      }
      const dist = view(spec);
      if (dist) {
        // First interactive publish has no provenance. A skip proves bytes,
        // not OIDC authorization, and makes that limitation visible.
        await verify(e, dist, false);
        console.log(`${spec} already published (same bytes); skipped, OIDC not exercised`);
        skipped++;
        continue;
      }
      npm([
        'publish',
        join(dir, e.file),
        '--ignore-scripts',
        '--access',
        'public',
        '--registry',
        registry,
        '--provenance',
      ]);
      published++;
      await settle(e, wait);
    }
    const summary = `published=${published} skipped=${skipped} dry_run=${dry}\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
} catch (e) {
  // Child-process failures can carry auth headers. Report the operation,
  // not stdout/stderr from a failed authenticated publish.
  console.error(e.status === undefined ? e.message : 'npm/tar command failed; release stopped');
  process.exitCode = 1;
}
