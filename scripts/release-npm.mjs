// Release the exact tarballs inspected by the build job, without npm tokens.
// Node 26, npm >=11.5.1. No third-party imports or package lifecycle scripts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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
function json(text) {
  return JSON.parse(text);
}
function npm(params, cwd) {
  return execFileSync('npm', params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
function view(spec) {
  try {
    const dist = one(json(npm(['view', spec, 'dist', '--json', '--registry', registry])));
    if (!dist || typeof dist !== 'object' || Array.isArray(dist)) fail('invalid registry dist');
    return dist;
  } catch (e) {
    let code;
    try {
      code = json(e.stdout).error?.code;
    } catch {
      /* unknown stays unknown */
    }
    if (code === 'E404') return null;
    fail(`registry state unknown for ${spec}`);
  }
}
async function verify(entry, dist, provenance) {
  const spec = `${entry.name}@${entry.version}`;
  if (dist?.integrity !== entry.integrity) fail(`${spec} registry integrity mismatch`);
  const url = new URL(dist.tarball);
  const base = new URL(registry);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.username ||
    url.password
  ) {
    fail(`${spec} tarball URL is not on the publish registry`);
  }
  if (provenance && !dist.attestations?.provenance?.predicateType)
    fail(`${spec} provenance missing`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || sri(Buffer.from(await response.arrayBuffer())) !== entry.integrity) {
    fail(`${spec} downloadable tarball integrity mismatch`);
  }
  console.log(`verified ${spec}`);
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
      await verify(e, view(spec), true);
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
