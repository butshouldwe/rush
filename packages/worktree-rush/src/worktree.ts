import fs from 'node:fs';
import path from 'node:path';
import {
  copySettingsLocal,
  seedClaudeProjectEntry,
  type CopyResult,
  type SeedResult,
} from './claudeState.js';
import { resolveCommitOid, validateBranchName, worktreePathFor } from './gitWorktree.js';
import { mainRootOf } from './rushRepo.js';
import { isAuthenticatedLinkedWorktree } from './worktreeRegistration.js';
import {
  formatStageReport,
  makeStageRunner,
  runProcess,
  UsageError,
  type ProcessRunner,
  type Stage,
  type StageOutcome,
} from './stages.js';

export type { ProcessRunner, Stage } from './stages.js';

export interface CreateOptions {
  branch: string;
  /** Source checkout to inherit from. Default: the repo the command runs in. */
  from?: string;
  /** Local commit-ish used only when creating a missing branch. Existing
   * branches/worktrees are never moved, reset, or rebased. */
  startPoint?: string;
  install?: boolean;
  warmClaude?: boolean;
  /** Link the source's pnpm store + build cache into the worktree (B0-verified:
   * turns a cold 9.5s build into a 0.7s all-from-cache build on this box). */
  shareStore?: boolean;
  /** Rush project names for a filtered install (`rush install --to <name>`,
   * repeatable). The checkout stays FULL — only dependency materialization
   * narrows. B0-measured: ~2s filtered vs 13–25s full on a 188-project repo. */
  to?: string[];
  /** Override the ~/.claude.json location (tests). */
  claudeJsonPath?: string;
}

export interface CreateResult {
  worktreePath: string;
  branch: string;
  stages: Stage[];
  ok: boolean;
  /** True when the worktree already existed and this run repaired/completed
   * it instead of creating it (converge-by-default semantics). */
  converged: boolean;
  claudeSeed?: SeedResult;
  settingsCopy?: CopyResult;
}

/** Normalize a user-supplied source path: relative spellings, trailing
 * slashes, and symlinked variants must all resolve to the one canonical
 * absolute path — the worktree location derives from it AND it is the exact
 * string key looked up in ~/.claude.json. A raw `--from .` would otherwise
 * create `.worktrees/` INSIDE the repo and seed from a key with no entry. */
export function canonicalSource(raw: string): string {
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Share the source checkout's pnpm store and build cache with the worktree.
 * Both live under common/temp (never tracked), so symlinks are safe and make
 * installs hardlink from a warm store and builds restore from a warm cache.
 *
 * Resilience contract: sharing is an optimization, never a gate. Any failure
 * (Windows symlink privileges, races with a parallel create, exotic
 * filesystems) downgrades to a legible warning and the install simply runs
 * cold. On win32 a directory junction — which needs no privilege — is tried
 * before giving up. An EEXIST from a parallel create is success: someone
 * linked it first. lstat (not exists) classifies the target, so a dangling
 * link is repaired and real pre-existing content is reported truthfully as
 * NOT shared rather than as "already linked". */
function linkSharedState(sourceRoot: string, worktreePath: string): StageOutcome {
  const linked: string[] = [];
  const already: string[] = [];
  const notShared: string[] = [];
  const warnings: string[] = [];
  for (const rel of [
    path.join('common', 'temp', 'pnpm-store'),
    path.join('common', 'temp', 'build-cache'),
  ]) {
    const source = path.join(sourceRoot, rel);
    const target = path.join(worktreePath, rel);
    try {
      fs.mkdirSync(source, { recursive: true });
      const existing = fs.lstatSync(target, { throwIfNoEntry: false });
      if (existing?.isSymbolicLink()) {
        if (fs.existsSync(target)) {
          already.push(rel);
          continue;
        }
        fs.rmSync(target); // dangling link (source moved/removed) — relink
      } else if (existing) {
        notShared.push(rel); // real content (e.g. an earlier cold install) — never clobber
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.symlinkSync(source, target, 'dir');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          already.push(rel); // a parallel create linked it first — same outcome
          continue;
        }
        if (process.platform === 'win32') {
          fs.symlinkSync(source, target, 'junction');
        } else {
          throw err;
        }
      }
      linked.push(rel);
    } catch (err) {
      warnings.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const parts: string[] = [];
  if (linked.length > 0) parts.push(`linked ${linked.join(', ')}`);
  if (
    already.length > 0 &&
    linked.length === 0 &&
    notShared.length === 0 &&
    warnings.length === 0
  ) {
    parts.push('already linked');
  }
  if (notShared.length > 0) {
    parts.push(`pre-existing content, NOT shared: ${notShared.join(', ')}`);
  }
  if (warnings.length > 0) {
    parts.push(`sharing unavailable (${warnings.join('; ')}) — installs will run cold`);
  }
  return { detail: parts.join(' · ') || 'already linked', ok: true };
}

/** Classify an existing path at the worktree location for converge-by-default:
 * a worktree of the SAME branch belonging to the SAME repo converges; anything
 * else is a hard, legible failure. */
function classifyExisting(
  from: string,
  worktreePath: string,
  branch: string,
  exec: ProcessRunner,
): StageOutcome {
  if (!fs.existsSync(path.join(worktreePath, '.git'))) {
    return {
      detail: `${worktreePath} exists but is not a git worktree — remove it or pick another branch`,
      ok: false,
    };
  }
  if (!isAuthenticatedLinkedWorktree(from, worktreePath)) {
    return {
      detail: `${worktreePath} is not a registered linked worktree of ${from} — remove it or pick another branch`,
      ok: false,
    };
  }
  const head = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  const current = head.status === 0 ? head.stdout.trim() : '';
  if (current !== branch) {
    return {
      detail: `${worktreePath} holds branch "${current || 'unknown'}", not "${branch}" — remove it or pick another branch`,
      ok: false,
    };
  }
  return { detail: `${worktreePath} already exists on ${branch} — converging`, ok: true };
}

/** Parallel creates (Fleet) can transiently collide on git's own repo-level
 * locks (packed-refs.lock, config.lock). That contention is retriable by
 * definition — the holder finishes in milliseconds. */
const GIT_RETRY_ATTEMPTS = 3;
const GIT_RETRY_DELAY_MS = 150;

function isLockContention(stderr: string): boolean {
  return /\.lock['"]?[:.]?\s|File exists|another git process/i.test(stderr);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The whole point of this plugin, in order (RUSH-WORKTREE-PRD §3.1, amended
 * by the 2026-07-23 hardening decisions):
 *  1. git worktree add at the canonical path — or CONVERGE: an existing
 *     same-branch worktree is repaired/completed, never refused, so a re-run
 *     after any mid-flight failure is the whole recovery story.
 *  2. agent-state bootstrap (trust, permissions, MCP approvals,
 *     settings.local) — BEFORE dependency work, so agent state never depends
 *     on an install succeeding.
 *  3. dependency materialization (store/cache sharing + rush install,
 *     optionally filtered with --to).
 * Every stage is timed; the report is the product as much as the worktree.
 */
export function createWorktree(
  sourceRoot: string,
  options: CreateOptions,
  exec: ProcessRunner = runProcess,
): CreateResult {
  validateBranchName(options.branch);
  // Resolve the effective source through canonicalSource + mainRootOf so a
  // relative/trailing-slash/symlinked `--from` — or a `--from <a linked
  // worktree>` — cannot derive a wrong path or seed from a key that has no
  // entry. Idempotent on an already-canonical main checkout.
  const from = mainRootOf(canonicalSource(options.from ?? sourceRoot));
  const worktreePath = worktreePathFor(from, options.branch);
  const stages: Stage[] = [];
  const stage = makeStageRunner(stages);

  const result: CreateResult = {
    worktreePath,
    branch: options.branch,
    stages,
    ok: false,
    converged: false,
  };

  // A caller-supplied ref is always validated, even when convergence means it
  // will not be reapplied. This keeps invalid/ambiguous/non-commit inputs on
  // the usage-error path and guarantees validation precedes every mutation.
  let resolvedStartPoint: string | undefined;
  if (options.startPoint !== undefined) {
    const resolution = resolveCommitOid(from, options.startPoint, exec);
    if (!resolution.ok) {
      if (resolution.error) throw resolution.error;
      throw new UsageError(resolution.detail);
    }
    resolvedStartPoint = resolution.oid;
  }

  const pathExists = fs.existsSync(worktreePath);
  const branchExists =
    !pathExists &&
    exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`], from)
      .status === 0;
  let creationOid = resolvedStartPoint;
  if (!pathExists && !branchExists && creationOid === undefined) {
    const head = resolveCommitOid(from, 'HEAD', exec);
    if (!head.ok) {
      stage('git-worktree-add', () => ({
        detail: `${from} has no commits (unborn HEAD) — commit once before creating worktrees`,
        ok: false,
      }));
      return result;
    }
    creationOid = head.oid;
  }

  const created = stage('git-worktree-add', () => {
    if (pathExists) {
      const outcome = classifyExisting(from, worktreePath, options.branch, exec);
      result.converged = outcome.ok;
      if (outcome.ok && options.startPoint !== undefined) {
        outcome.detail += ' · --start-point is creation-only and was not reapplied';
      }
      return outcome;
    }
    // A worktree dir deleted by hand (rm -rf, no `git worktree remove`)
    // stays registered and blocks re-adding — prune is cheap and always safe.
    exec('git', ['worktree', 'prune'], from);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    // If the branch already exists (e.g. a previous worktree of it was
    // removed), check it out instead of -b creating it — converge semantics
    // extend to the branch, not just the directory.
    const addArgs = branchExists
      ? ['worktree', 'add', worktreePath, options.branch]
      : ['worktree', 'add', worktreePath, '-b', options.branch, creationOid!];
    let r = exec('git', addArgs, from);
    for (let attempt = 1; attempt < GIT_RETRY_ATTEMPTS; attempt += 1) {
      if (r.status === 0 || r.error || !isLockContention(r.stderr)) break;
      sleepMs(GIT_RETRY_DELAY_MS * attempt);
      r = exec('git', addArgs, from);
    }
    if (r.error) return { detail: String(r.error.message), ok: false };
    if (r.status !== 0) return { detail: (r.stderr || r.stdout).trim().slice(0, 400), ok: false };
    const detail =
      branchExists && options.startPoint !== undefined
        ? `${worktreePath} · --start-point is creation-only and was not reapplied`
        : !branchExists && options.startPoint !== undefined
          ? `${worktreePath} · --start-point "${options.startPoint}" resolved to ${creationOid}`
          : worktreePath;
    return { detail, ok: true };
  });
  if (!created) return result;

  // Agent-state bootstrap runs BEFORE dependency materialization: it takes
  // milliseconds, and a failed install must never strand a worktree without
  // trust/permissions — a session has to be able to start and diagnose.
  if (options.warmClaude !== false) {
    stage('claude-bootstrap', () => {
      result.settingsCopy = copySettingsLocal(from, worktreePath);
      result.claudeSeed = seedClaudeProjectEntry(from, worktreePath, options.claudeJsonPath);
      const parts = [
        `settings.local: ${result.settingsCopy.action}`,
        `~/.claude.json: ${result.claudeSeed.action}`,
      ];
      if (result.claudeSeed.action === 'skipped') parts.push(`(${result.claudeSeed.detail})`);
      // A skipped seed is not a failure — machines without Claude state are fine.
      return { detail: parts.join(' · '), ok: true };
    });
  }

  // Rush-specific stages only make sense in a Rush workspace. Non-Rush git
  // repos (most of the family) still get worktree + agent-state bootstrap.
  const isRushWorkspace = fs.existsSync(path.join(from, 'rush.json'));
  if (options.install !== false && !isRushWorkspace) {
    stage('rush-install', () => ({
      detail:
        'not a Rush workspace — dependency materialization skipped (worktree + agent-state bootstrap only)',
      ok: true,
    }));
  } else if (options.install !== false) {
    if (options.shareStore !== false) {
      stage('share-store-and-cache', () => linkSharedState(from, worktreePath));
    }
    stage('rush-install', () => {
      const installRunRush = path.join(worktreePath, 'common', 'scripts', 'install-run-rush.js');
      const filters = (options.to ?? []).flatMap((project) => ['--to', project]);
      const args = ['install', '--bypass-policy', ...filters];
      const r = fs.existsSync(installRunRush)
        ? exec('node', [installRunRush, ...args], worktreePath)
        : exec('rush', args, worktreePath);
      if (r.error) return { detail: String(r.error.message), ok: false };
      if (r.status !== 0) {
        const tail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400);
        return { detail: tail, ok: false };
      }
      return {
        detail:
          filters.length > 0
            ? `rush install ok (filtered: ${(options.to ?? []).join(', ')})`
            : 'rush install ok',
        ok: true,
      };
    });
  }

  result.ok = stages.every((s) => s.ok);
  return result;
}

export function formatReport(result: CreateResult): string {
  const verb = result.converged ? 'converged' : 'worktree';
  return formatStageReport(`${verb} ${result.branch} → ${result.worktreePath}`, result);
}
