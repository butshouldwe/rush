import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { findRushRepo, pnpmLadderRefusal } from './rushRepo.js';
import { discoverScenarios, readExtractorMetadata, resolveTargetFolder } from './scenarios.js';
import { generateSbom, type CommandRunner } from './generate.js';
import { stampBom } from './stamp.js';
import { validateCycloneDx, ntiaMinimumElements } from './validate.js';
import type { DeployScenario, RushRepo, ScenarioResult } from './types.js';

const require = createRequire(import.meta.url);

// Re-exported so existing importers (index barrel, tests) keep resolving
// `UsageError` from './run.js'; it lives in errors.ts to avoid a run.ts ↔
// scenarios.ts import cycle now that scenarios.ts throws it too.
export { UsageError } from './errors.js';
import { UsageError } from './errors.js';
import { guardDefaultOutputDir } from './defaultOutputDir.js';

export interface RunOptions {
  cwd: string;
  scenarios?: string[];
  targetFolder?: string;
  out?: string;
  failOnInvalid?: boolean;
  /** Injectable command runner threaded through to {@link generateSbom}
   * (defaults to the real spawn there) — lets tests drive the ladder
   * deterministically without spawning pnpm/cdxgen. Not exposed on the CLI. */
  exec?: CommandRunner;
}

export interface RunResult {
  outDir: string;
  gitSha: string;
  results: ScenarioResult[];
  /** 0 ok · 1 generation failure · 3 validation failure with --fail-on-invalid */
  exitCode: 0 | 1 | 3;
}

function gitSha(dir: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function toolVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Filesystem-safe file base for a scenario/deployment name. Scoped project
 * names (`@scope/app`) flatten to one segment; anything that would escape the
 * output directory is rejected outright.
 */
export function scenarioFileBase(name: string): string {
  const base = name.replaceAll('/', '__').replaceAll('\\', '__');
  if (base.length === 0 || base === '.' || base.includes('..') || path.isAbsolute(base)) {
    throw new Error(`scenario name "${name}" cannot be used as an output file name`);
  }
  // Preserve the historical flattening for already-unambiguous names. A
  // literal "__" is the only input shape that can alias that separator
  // encoding, so suffix just those names with their original-key digest.
  return name.includes('__')
    ? `${base}--${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
    : base;
}

/** One SBOM to generate: a scenario × deployment-project pair. A single-name
 * scenario keeps its own name; multi-name scenarios (Rush's
 * `rush deploy --project <name>` model) get one entry per project. */
interface SbomJob {
  /** Key used for the output filename and manifest entry. */
  key: string;
  scenario: DeployScenario;
  projectName: string;
}

function jobsForScenario(scenario: DeployScenario): SbomJob[] {
  const names = scenario.deploymentProjectNames;
  return names.map((projectName) => ({
    key: names.length === 1 ? scenario.name : `${scenario.name}--${projectName}`,
    scenario,
    projectName,
  }));
}

export function runSbom(options: RunOptions): RunResult {
  // Rush runs global commands with cwd = the rush.json folder and records the
  // user's actual location in RUSH_INVOKED_FOLDER — user-relative paths must
  // resolve against the latter.
  const invokedFolder = process.env.RUSH_INVOKED_FOLDER ?? options.cwd;
  let repo: RushRepo;
  try {
    repo = findRushRepo(invokedFolder);
  } catch (err) {
    // Not-in-a-Rush-repo / malformed rush.json is usage/config-shaped (exit
    // 2), not a generation/runtime failure — preserve the original message.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const ladderBlocked = pnpmLadderRefusal(repo);
  const sha = gitSha(repo.rushJsonFolder);
  const explicitOut = options.out !== undefined;
  const selectedDir = path.join(repo.rushJsonFolder, 'common', 'deploy-sbom');
  const outDir =
    options.out !== undefined
      ? path.resolve(repo.rushJsonFolder, options.out)
      : guardDefaultOutputDir(selectedDir);

  const results: ScenarioResult[] = [];
  const pendingSboms = new Map<ScenarioResult, string>();

  const runJob = (
    key: string,
    projectName: string,
    scenario: DeployScenario,
    targetFolder?: string,
  ): void => {
    const result: ScenarioResult = { scenario: key, mainProject: projectName, attempts: [] };
    try {
      const outBase = scenarioFileBase(key);
      const resolvedTarget = targetFolder ?? resolveTargetFolder(repo, scenario, projectName);
      const meta = readExtractorMetadata(resolvedTarget);
      result.mainProject = meta.mainProjectName;

      const outcome = generateSbom(
        repo,
        scenario,
        resolvedTarget,
        meta,
        ladderBlocked,
        options.exec,
      );
      result.attempts = outcome.attempts;
      if (!outcome.bom || outcome.rung === undefined) {
        result.error = `every ladder rung failed or was unavailable for scenario "${key}"`;
      } else {
        const stamped = stampBom(outcome.bom, {
          scenario: key,
          mainProject: meta.mainProjectName,
          gitSha: sha,
          rung: outcome.rung,
          method: outcome.method ?? 'unknown',
          toolVersion: toolVersion(),
        });
        const { valid, errors } = validateCycloneDx(stamped);
        result.valid = valid;
        result.validationErrors = errors;
        result.ntia = ntiaMinimumElements(stamped);
        result.componentCount = stamped.components?.length ?? 0;
        result.bom = stamped;

        const outFile = path.join(outDir, `${outBase}.cdx.json`);
        const serialized = `${JSON.stringify(stamped, null, 2)}\n`;
        result.outFile = outFile;
        pendingSboms.set(result, serialized);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    results.push(result);
  };

  if (options.targetFolder) {
    // Escape hatch: scan any folder rush deploy produced. Scenario identity
    // comes from the deploy metadata (or an explicit single --scenario name).
    if ((options.scenarios?.length ?? 0) > 1) {
      throw new UsageError(
        `--target-folder scans exactly one deploy output; pass at most one --scenario name (got: ${options.scenarios!.join(', ')}).`,
      );
    }
    const targetFolder = path.resolve(invokedFolder, options.targetFolder);
    const scenario: DeployScenario = {
      name: options.scenarios?.[0] ?? path.basename(targetFolder),
      configPath: '(bypassed via --target-folder)',
      deploymentProjectNames: ['(from extractor-metadata.json)'],
      includeDevDependencies: false,
      targetFolder,
    };
    let key = scenario.name;
    let projectName = '(unknown)';
    try {
      const meta = readExtractorMetadata(targetFolder);
      projectName = meta.mainProjectName;
      if (!options.scenarios?.[0]) key = meta.mainProjectName;
      scenario.deploymentProjectNames = [meta.mainProjectName];
    } catch (err) {
      results.push({
        scenario: key,
        mainProject: projectName,
        attempts: [],
        error: err instanceof Error ? err.message : String(err),
      });
      writeManifest(outDir, sha, results, undefined, { explicitOut });
      return { outDir, gitSha: sha, results, exitCode: 1 };
    }
    runJob(key, projectName, scenario, targetFolder);
  } else {
    const scenarios = discoverScenarios(repo, options.scenarios);
    if (scenarios.length === 0) {
      throw new UsageError(
        `No deploy scenarios found in common/config/rush (deploy.json or deploy-*.json). ` +
          `Create one with \`rush init-deploy\`, or pass --target-folder.`,
      );
    }
    for (const scenario of scenarios) {
      for (const job of jobsForScenario(scenario)) {
        runJob(job.key, job.projectName, job.scenario);
      }
    }
  }

  writeManifest(outDir, sha, results, pendingSboms, { explicitOut });

  const generationFailed = results.some((r) => r.error);
  const invalid = results.some((r) => r.valid === false);
  const exitCode: RunResult['exitCode'] = generationFailed
    ? 1
    : invalid && options.failOnInvalid
      ? 3
      : 0;
  return { outDir, gitSha: sha, results, exitCode };
}

/** Atomic write (temp + rename): concurrent runs never interleave torn JSON. */
function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* not created */
    }
    throw err;
  }
}

interface ManifestShape {
  generator: string;
  generatedAt: string;
  gitSha: string;
  scenarios: Record<string, unknown>;
}

function manifestOutputOwners(outDir: string, manifestPath: string): Map<string, string> {
  const owners = new Map<string, string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestShape;
    for (const [scenario, entry] of Object.entries(parsed.scenarios ?? {})) {
      const file = (entry as { file?: string | null }).file;
      if (
        typeof file === 'string' &&
        path.basename(file) === file &&
        fs.existsSync(path.join(outDir, file))
      ) {
        owners.set(file, scenario);
      }
    }
  } catch {
    // Absent or corrupt manifests do not establish ownership of existing files.
  }
  return owners;
}

/**
 * Read the existing manifest (if any), keep only entries whose SBOM file
 * still exists, and overlay this run's results — this run's entries always
 * win for keys they cover. Pure function of the current on-disk state: no
 * writes.
 */
function mergeManifest(
  outDir: string,
  manifestPath: string,
  sha: string,
  results: ScenarioResult[],
): ManifestShape {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestShape;
    for (const [name, entry] of Object.entries(parsed.scenarios ?? {})) {
      const file = (entry as { file?: string | null }).file;
      if (
        typeof file === 'string' &&
        path.basename(file) === file &&
        fs.existsSync(path.join(outDir, file))
      )
        existing[name] = entry;
    }
  } catch {
    existing = {}; // absent or corrupt — start fresh
  }

  for (const result of results) {
    existing[result.scenario] = {
      mainProject: result.mainProject,
      file: result.outFile ? path.basename(result.outFile) : null,
      sha256: result.sha256 ?? null,
      componentCount: result.componentCount ?? null,
      valid: result.valid ?? null,
      ntiaSatisfied: result.ntia?.satisfied ?? null,
      rung: result.attempts.find((a) => a.outcome === 'succeeded')?.rung ?? null,
      error: result.error ?? null,
    };
  }

  return {
    generator: '@butshouldwe/sbom-rush',
    generatedAt: new Date().toISOString(),
    gitSha: sha,
    scenarios: Object.fromEntries(
      Object.entries(existing).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/** Busy-sleep without a running event loop (writeManifest is synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ManifestLockOwner {
  pid: number;
  token: string;
}

/** @internal Exported only so the deterministic lock-interleaving regression
 * can preserve a contender's exact observation across a simulated race. */
export interface ManifestLockObservation {
  identity: string;
  owner: ManifestLockOwner | null;
  detail: string;
}

function parseManifestLockOwner(raw: string): ManifestLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ManifestLockOwner>;
    return Number.isSafeInteger(parsed.pid) &&
      parsed.pid! > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
      ? { pid: parsed.pid!, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

/** Capture both inode identity and owner bytes. A later reclaim is allowed
 * only if this exact observation is still current. */
export function inspectManifestLock(lockPath: string): ManifestLockObservation {
  try {
    const stat = fs.lstatSync(lockPath);
    const raw = stat.isFile() ? fs.readFileSync(lockPath, 'utf8') : '';
    const owner = stat.isFile() ? parseManifestLockOwner(raw) : null;
    return {
      identity: createHash('sha256')
        .update(`${stat.dev}\0${stat.ino}\0${stat.mode}\0${raw}`)
        .digest('hex'),
      owner,
      detail: owner ? `owner pid ${owner.pid}` : 'malformed owner record',
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      identity: code === 'ENOENT' ? 'missing' : `unreadable:${code ?? 'unknown'}`,
      owner: null,
      detail: code === 'ENOENT' ? 'lock disappeared' : `unreadable lock (${code ?? 'unknown'})`,
    };
  }
}

function ownerIsAlive(owner: ManifestLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    // EPERM still proves that the process exists; only ESRCH proves death.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Claim markers store a raw `${pid}-${hex}` token (not JSON); a crashed
 * claimant's marker must be distinguishable from a live one. */
function parseClaimMarkerOwner(raw: string): ManifestLockOwner | null {
  const match = /^(\d+)-([0-9a-f]{8,})$/.exec(raw);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: match[2]! } : null;
}

function removeOwnedMarker(markerPath: string, token: string): void {
  try {
    if (fs.readFileSync(markerPath, 'utf8') === token) fs.unlinkSync(markerPath);
  } catch {
    // Already gone or replaced by another contender: never remove by pathname alone.
  }
}

/** @internal Compare-and-delete reclaim primitive. `observed` may be stale;
 * replacing the lock after that observation makes this a safe no-op. */
export function tryReclaimManifestLock(
  lockPath: string,
  observed: ManifestLockObservation,
): boolean {
  if (
    observed.identity === 'missing' ||
    observed.identity.startsWith('unreadable:') ||
    (observed.owner && ownerIsAlive(observed.owner))
  ) {
    return false;
  }

  const claimToken = `${process.pid}-${randomBytes(12).toString('hex')}`;
  const claimPath = `${lockPath}.reclaim`;

  // Acquire the exclusive claim marker, recovering markers stranded by a
  // crashed claimant — a crash between marker creation and the finally below
  // would otherwise deny reclamation forever (a persistent publication DoS).
  // A marker whose claimant is verifiably dead (or whose record is
  // unrecognizable) is cleared; the lock-state identity comparison further
  // down remains the actual ownership boundary, so a false-clear at worst
  // lets one extra contender reach that boundary and lose there.
  let claimed = false;
  for (let attempt = 0; attempt < 4 && !claimed; attempt += 1) {
    let claimFd: number | undefined;
    try {
      claimFd = fs.openSync(claimPath, 'wx', 0o600);
      fs.writeSync(claimFd, claimToken);
      fs.closeSync(claimFd);
      claimed = true;
      break;
    } catch (err) {
      if (claimFd !== undefined) fs.closeSync(claimFd);
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    let markerRaw: string;
    try {
      markerRaw = fs.readFileSync(claimPath, 'utf8');
    } catch {
      continue; // vanished between open and read — retry immediately
    }
    const markerOwner = parseClaimMarkerOwner(markerRaw);
    if (markerOwner && ownerIsAlive(markerOwner)) return false; // live reclaimer

    const parkedPath = `${claimPath}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(claimPath, parkedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    fs.rmSync(parkedPath, { recursive: true, force: true });
  }
  if (!claimed) return false;

  const reclaimedPath = `${lockPath}.${claimToken}.reclaimed`;
  try {
    // This token+inode comparison is the ownership boundary: another
    // contender may already have replaced the abandoned lock with a live one.
    if (inspectManifestLock(lockPath).identity !== observed.identity) return false;
    try {
      fs.renameSync(lockPath, reclaimedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    fs.rmSync(reclaimedPath, { recursive: true, force: true });
    return true;
  } finally {
    removeOwnedMarker(claimPath, claimToken);
  }
}

/** @internal Release primitive; a predecessor token can never unlink a
 * successor's lock. */
export function tryReleaseManifestLock(lockPath: string, ownerToken: string): boolean {
  const current = inspectManifestLock(lockPath);
  if (current.owner?.token !== ownerToken) return false;

  const releasedPath = `${lockPath}.${ownerToken}.released`;
  try {
    fs.renameSync(lockPath, releasedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  fs.rmSync(releasedPath, { recursive: true, force: true });
  return true;
}

function tryAcquireManifestLock(lockPath: string, owner: ManifestLockOwner): boolean {
  const raw = JSON.stringify(owner);
  const candidatePath = `${lockPath}.${owner.token}.candidate`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidatePath, 'wx', 0o600);
    fs.writeSync(fd, raw);
    fs.closeSync(fd);
    fd = undefined;
    // Publishing a hard link makes the complete owner record visible in one
    // atomic step; contenders never mistake an in-progress acquire for a
    // malformed abandoned lock.
    fs.linkSync(candidatePath, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(candidatePath);
    } catch {
      // Candidate was already removed or was never created.
    }
  }
}

/**
 * Run `fn` while holding an exclusive lock on `manifestPath` (an `O_EXCL`
 * lockfile). The lock carries a unique pid+random owner token. Live owners
 * are never reclaimed based on age; dead or malformed locks are reclaimed
 * only when the observed token+inode still matches. Release is token-bound.
 */
function withManifestLock<T>(manifestPath: string, fn: () => T): T {
  const lockPath = `${manifestPath}.lock`;
  const timeoutMs = 10_000;
  const spinMs = 15;
  const startedAt = Date.now();
  const owner: ManifestLockOwner = {
    pid: process.pid,
    token: `${process.pid}-${randomBytes(12).toString('hex')}`,
  };
  for (;;) {
    if (tryAcquireManifestLock(lockPath, owner)) break;
    const observed = inspectManifestLock(lockPath);
    if (tryReclaimManifestLock(lockPath, observed)) continue;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for manifest lock ${lockPath} (${observed.detail})`,
      );
    }
    sleepSync(spinMs);
  }
  try {
    return fn();
  } finally {
    tryReleaseManifestLock(lockPath, owner.token);
  }
}

/**
 * Merge-write the manifest: entries from this run overlay the existing
 * manifest, and stale entries survive only while their SBOM file still
 * exists — so a scoped run (`--scenario web`) never silently drops the other
 * scenarios' records.
 *
 * Concurrency (finding #17): two `rush sbom` processes racing the same
 * output could otherwise mismatch an SBOM with another run's hash or lose
 * manifest entries through a read-modify-write window. SBOM replacement,
 * hash-after-read, manifest merge, and manifest replacement all run under
 * the same ownership lock (see {@link withManifestLock}).
 */
export function writeManifest(
  outDir: string,
  sha: string,
  results: ScenarioResult[],
  pendingSboms: ReadonlyMap<ScenarioResult, string> = new Map(),
  options: { explicitOut?: boolean } = {},
): void {
  if (!options.explicitOut) outDir = guardDefaultOutputDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  withManifestLock(manifestPath, () => {
    const outputOwners = manifestOutputOwners(outDir, manifestPath);
    for (const [result, serialized] of pendingSboms) {
      if (!result.outFile) continue;
      try {
        let fileName = path.basename(result.outFile);
        const owner = outputOwners.get(fileName);
        if ((owner && owner !== result.scenario) || (!owner && fs.existsSync(result.outFile))) {
          const stem = fileName.endsWith('.cdx.json')
            ? fileName.slice(0, -'.cdx.json'.length)
            : fileName;
          fileName = `${stem}--${createHash('sha256').update(result.scenario).digest('hex')}.cdx.json`;
        }
        const resolvedOwner = outputOwners.get(fileName);
        const resolvedFile = path.join(outDir, fileName);
        if (
          (resolvedOwner && resolvedOwner !== result.scenario) ||
          (!resolvedOwner && fs.existsSync(resolvedFile))
        ) {
          throw new Error(
            `output file ${fileName} is already occupied by ` +
              `${resolvedOwner ? `scenario "${resolvedOwner}"` : 'an unowned artifact'}`,
          );
        }
        result.outFile = resolvedFile;
        writeFileAtomic(result.outFile, serialized);
        // Bind the receipt to the bytes that atomic replacement actually
        // published, not to a buffer that may have lost a same-path race.
        result.sha256 = createHash('sha256').update(fs.readFileSync(result.outFile)).digest('hex');
        outputOwners.set(fileName, result.scenario);
      } catch (err) {
        result.error =
          `cannot publish SBOM for scenario "${result.scenario}": ` +
          (err instanceof Error ? err.message : String(err));
        result.outFile = undefined;
        result.sha256 = undefined;
      }
    }
    const manifest = mergeManifest(outDir, manifestPath, sha, results);
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });
}
