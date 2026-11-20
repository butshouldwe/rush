import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const testbedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureRoot = path.join(testbedRoot, 'fixture');
export const tmpDir = path.join(testbedRoot, 'tmp');
export const repoRoot = path.resolve(testbedRoot, '..', '..');
export const rushBin = path.join(testbedRoot, 'node_modules', '.bin', 'rush');

/**
 * The pnpm binary to shell out to. In a Rush repo, pnpm is NOT on PATH — Rush
 * keeps its own copy under common/temp/pnpm-local — so prefer that (matches
 * rush.json's pnpmVersion by construction), and fall back to a PATH `pnpm`
 * for standalone runs. Guards CI and any Rush user who lacks a global pnpm.
 */
export const pnpmBin: string = (() => {
  const local = path.join(repoRoot, 'common', 'temp', 'pnpm-local', 'node_modules', '.bin', 'pnpm');
  return fs.existsSync(local) ? local : 'pnpm';
})();

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): RunResult {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...env },
    timeout: 240_000,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function rush(args: string[], env: Record<string, string> = {}): RunResult {
  return run(rushBin, args, fixtureRoot, env);
}

export function expectOk(result: RunResult, what: string): void {
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${result.status})\n--- stdout ---\n${result.stdout.slice(-4000)}\n--- stderr ---\n${result.stderr.slice(-4000)}`,
    );
  }
}

/** `pnpm pack` a plugin into tmp/, returning the tarball path. */
export function packPlugin(packageDirName: string): string {
  const pkgDir = path.join(repoRoot, 'packages', packageDirName);
  fs.mkdirSync(tmpDir, { recursive: true });
  const result = run(pnpmBin, ['pack', '--out', path.join(tmpDir, '%s-%v.tgz')], pkgDir);
  expectOk(result, `pnpm pack ${packageDirName}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const tarball = path.join(
    tmpDir,
    `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`,
  );
  if (!fs.existsSync(tarball)) throw new Error(`expected tarball missing: ${tarball}`);
  return tarball;
}

/**
 * `rush update-autoinstaller` skips reinstalling when the autoinstaller's
 * package.json hash is unchanged — but our tarballs churn by design (same
 * path+version, fresh bytes each pack), so a skip silently keeps whatever
 * the previous run installed (observed: a stale install missing dist/).
 * Delete the installed state so rush always reinstalls from the tarballs
 * just packed.
 */
export function resetAutoinstaller(): void {
  const autoinstaller = path.join(fixtureRoot, 'common', 'autoinstallers', 'rush-plugins');
  for (const entry of ['node_modules', 'pnpm-lock.yaml', '.rush', 'rush-plugins']) {
    fs.rmSync(path.join(autoinstaller, entry), { recursive: true, force: true });
  }
}

/** The autoinstaller references both plugins' tarballs, so every harness
 * entry point must pack both — and reset the installed autoinstaller state —
 * before touching rush. */
export function packAllPlugins(): void {
  packPlugin('sbom-rush');
  packPlugin('fallow-rush');
  resetAutoinstaller();
}

/**
 * §0 no-mutation rule: integration runs must leave the repo clean.
 * Returns the porcelain lines for the testbed subtree (gitignored files
 * excluded by definition).
 */
export function gitStatusTestbed(): string[] {
  const result = run('git', ['status', '--porcelain', '--', 'packages/rush-testbed'], repoRoot);
  expectOk(result, 'git status');
  return result.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/** Strip volatile fields so SBOMs can be compared against goldens. */
export function normalizeBom(bom: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(bom);
  delete clone.serialNumber;
  const metadata = clone.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    delete metadata.timestamp;
    if (Array.isArray(metadata.properties)) {
      metadata.properties = (metadata.properties as Array<{ name: string; value: string }>).map(
        (p) => (p.name === 'sbom-rush:git-sha' ? { ...p, value: '<sha>' } : p),
      );
    }
  }
  return clone;
}

export function normalizeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(manifest);
  delete clone.generatedAt;
  delete clone.gitSha;
  for (const scenario of Object.values(
    clone.scenarios as Record<string, Record<string, unknown>>,
  )) {
    delete scenario.sha256;
  }
  return clone;
}

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
