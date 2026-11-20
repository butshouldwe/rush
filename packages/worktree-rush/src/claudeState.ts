import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The machine-level, path-keyed state that gates a zero-prompt first session
 * (WORKTREE-INHERITANCE.md class 3). These are the only keys the seed copies:
 * trust, tool permissions, and MCP approvals. Everything else in a project
 * entry (history, caches, counters) is session state that must start fresh.
 */
export const SEEDED_KEYS = [
  'hasTrustDialogAccepted',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasClaudeMdExternalIncludesApproved',
] as const;

export interface SeedResult {
  action: 'seeded' | 'skipped';
  /** Human-readable reason (always set for 'skipped'). */
  detail: string;
  seededKeys: string[];
}

interface ClaudeJson {
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function defaultClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

type ReadResult = { parsed: ClaudeJson; error?: undefined } | { parsed?: undefined; error: string };

function readClaudeJson(claudeJsonPath: string): ReadResult {
  try {
    return { parsed: JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as ClaudeJson };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Atomic write with guaranteed tmp cleanup: a failure between the write and
 * the rename must not leave `~/.claude.json.worktree-rush.<pid>.tmp` litter.
 * The original file mode is preserved — a chmod-600 credentials-bearing
 * ~/.claude.json must not silently broaden to the umask default. */
function writeClaudeJson(claudeJsonPath: string, value: ClaudeJson): void {
  const tmp = `${claudeJsonPath}.worktree-rush.${process.pid}.tmp`;
  let mode: number | undefined;
  try {
    mode = fs.statSync(claudeJsonPath).mode & 0o7777;
  } catch {
    // fresh file — umask default is fine
  }
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(value, null, 2)}\n`,
      mode === undefined ? {} : { mode },
    );
    fs.renameSync(tmp, claudeJsonPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Synchronous sleep without spawning a child. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;

interface LockOwner {
  pid: number;
  token: string;
}

type LockResult<T> = { acquired: true; value: T } | { acquired: false; detail: string };

function readLockOwner(lockDir: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(
      fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'),
    ) as LockOwner;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
      return undefined;
    }
    return owner;
  } catch {
    return undefined;
  }
}

function sameOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return left?.pid === right.pid && left.token === right.token;
}

function ownerIsDead(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Rename first so deleting an abandoned lock can never delete a successor
 * that acquired the canonical path concurrently. */
function removeOwnedLock(lockDir: string, owner: LockOwner, suffix: string): boolean {
  if (!sameOwner(readLockOwner(lockDir), owner)) return false;
  const moved = `${lockDir}.${suffix}.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lockDir, moved);
  } catch {
    return false;
  }
  if (!sameOwner(readLockOwner(moved), owner)) {
    try {
      if (!fs.existsSync(lockDir)) fs.renameSync(moved, lockDir);
    } catch {
      // Ownership changed unexpectedly; preserve the lock rather than delete it.
    }
    return false;
  }
  fs.rmSync(moved, { recursive: true, force: true });
  return true;
}

/**
 * Advisory lock among COOPERATING worktree-rush processes (parallel
 * `worktree-create` runs under Fleet). Staging-based: the lock (directory +
 * owner record together) is built under a unique name and renamed into place
 * — atomic on every platform, and the canonical path is NEVER observable
 * without its owner record (a crash mid-creation leaves only a harmless
 * staging directory, swept opportunistically). `rename(2)` replaces an empty
 * existing directory, so an empty lock left by a crashed legacy initializer
 * is claimed atomically. A recorded owner is reclaimed only when its PID is
 * verifiably dead; age alone never breaks a slow holder's lock. If
 * acquisition exceeds LOCK_WAIT_MS, the state update is skipped so worktree
 * operations remain responsive without writing outside the lock.
 *
 * This does NOT serialize against Claude Code's own writer, which knows
 * nothing of the lock; the re-read-before-write in `seedClaudeProjectEntry`
 * remains the (best-effort) defense there.
 */
/** Best-effort sweep of staging directories whose creator is verifiably
 * dead: a crash between staging creation and rename must never accumulate
 * litter, and staging dirs never block acquisition of the canonical path. */
function sweepStrandedStagingDirs(lockDir: string): void {
  const parent = path.dirname(lockDir);
  const prefix = `${path.basename(lockDir)}.staging.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const match = /^(\d+)-/.exec(entry.slice(prefix.length));
    const pid = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      alive = (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (alive) continue;
    try {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    } catch {
      // Best-effort only; a later call retries.
    }
  }
}

function withClaudeJsonLock<T>(claudeJsonPath: string, fn: () => T): LockResult<T> {
  const lockDir = `${claudeJsonPath}.worktree-rush.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const owner = { pid: process.pid, token: randomUUID() };
  const stagingDir = `${lockDir}.staging.${process.pid}-${owner.token}`;
  sweepStrandedStagingDirs(lockDir);
  while (Date.now() < deadline) {
    try {
      // Build the complete lock (directory + owner record) under a unique
      // staging name, then publish it atomically. rename(2) replaces an
      // EMPTY existing directory: an empty lock left by a crashed legacy
      // initializer is claimed here; an owned (non-empty) lock makes the
      // rename fail (ENOTEMPTY/EEXIST) and falls through to reclamation.
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir);
      fs.writeFileSync(path.join(stagingDir, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      fs.renameSync(stagingDir, lockDir);
    } catch {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Best-effort; the sweep cleans dead staging dirs later.
      }
      const existing = readLockOwner(lockDir);
      if (existing && ownerIsDead(existing)) {
        if (removeOwnedLock(lockDir, existing, 'stale')) continue;
      }
      sleepMs(LOCK_POLL_MS);
      continue;
    }
    try {
      return { acquired: true, value: fn() };
    } finally {
      removeOwnedLock(lockDir, owner, 'release');
    }
  }
  return {
    acquired: false,
    detail: `could not acquire ${lockDir} within ${LOCK_WAIT_MS}ms — state update skipped`,
  };
}

/**
 * Seed the worktree's `~/.claude.json` project entry from the source
 * checkout's entry so the first session never sees a trust dialog or MCP
 * approval prompt. Patches, never replaces: unknown keys in an existing
 * target entry (and everything else in the file) are preserved byte-for-byte
 * semantically; the write is atomic (temp + rename) and serialized against
 * other worktree-rush processes by an advisory lock.
 *
 * Concurrency — two distinct writers, two distinct defenses:
 *  - Other worktree-rush processes (parallel creates under Fleet):
 *    serialized by `withClaudeJsonLock`; cooperating writers never
 *    interleave.
 *  - Claude Code's own writer (the live session starting up): cannot be
 *    locked against — it knows nothing of the lock. We capture the patch
 *    (the `SEEDED_KEYS` values from the source entry — fixed, independent of
 *    the target) from the first read, then re-read the file **immediately**
 *    before the atomic write and apply the patch to that freshest copy, so
 *    any concurrent change that landed before the re-read survives. If the
 *    file becomes unreadable between the two reads, abort (skip) rather than
 *    write back a stale snapshot: never clobber. A sub-millisecond window
 *    remains; narrowing it to the minimum is the strongest guarantee
 *    available.
 */
export function seedClaudeProjectEntry(
  sourceRepoPath: string,
  worktreePath: string,
  claudeJsonPath: string = defaultClaudeJsonPath(),
): SeedResult {
  if (!fs.existsSync(claudeJsonPath)) {
    return {
      action: 'skipped',
      detail: `${claudeJsonPath} does not exist — no Claude state on this machine to seed from`,
      seededKeys: [],
    };
  }

  const initial = readClaudeJson(claudeJsonPath);
  if (initial.error !== undefined) {
    return {
      action: 'skipped',
      detail: `${claudeJsonPath} is not valid JSON (${initial.error}) — refusing to touch it`,
      seededKeys: [],
    };
  }

  // The entry key is whatever spelling Claude recorded as cwd. Probe the
  // reasonable spellings of the same directory (raw, resolved, realpath,
  // trailing-separator-stripped) so a symlinked or slash-suffixed source
  // still finds its entry instead of silently skipping the seed.
  const spellings = new Set<string>([sourceRepoPath, path.resolve(sourceRepoPath)]);
  try {
    spellings.add(fs.realpathSync(sourceRepoPath));
  } catch {
    // nonexistent source path — the raw/resolved candidates still apply
  }
  for (const c of Array.from(spellings)) {
    const stripped = c.replace(/[/\\]+$/, '');
    if (stripped.length > 0) spellings.add(stripped);
  }
  let source: Record<string, unknown> | undefined;
  for (const c of spellings) {
    source = initial.parsed.projects?.[c];
    if (source !== undefined) break;
  }
  if (!source) {
    return {
      action: 'skipped',
      detail: `no project entry for "${sourceRepoPath}" in ${claudeJsonPath} — open a session there once, then re-run (or ignore if this machine doesn't run Claude)`,
      seededKeys: [],
    };
  }

  // Compute the patch once: these values come from the source checkout's
  // entry, not the concurrently-written target, so there is nothing to gain
  // by re-reading them.
  const patch: Record<string, unknown> = {};
  for (const key of SEEDED_KEYS) {
    if (source[key] === undefined) continue;
    patch[key] = structuredClone(source[key]);
  }

  const locked = withClaudeJsonLock(claudeJsonPath, () => {
    // Re-read immediately before writing and apply the patch to the freshest
    // copy — this is the window the re-read closes.
    const fresh = readClaudeJson(claudeJsonPath);
    if (fresh.error !== undefined) {
      return {
        action: 'skipped' as const,
        detail: `${claudeJsonPath} became unreadable before the write (${fresh.error}) — refusing to touch it`,
        seededKeys: [],
      };
    }

    const projects = (fresh.parsed.projects ??= {});
    const target = (projects[worktreePath] ??= {});
    const seededKeys: string[] = [];
    for (const key of SEEDED_KEYS) {
      if (!(key in patch)) continue;
      target[key] = patch[key];
      seededKeys.push(key);
    }

    writeClaudeJson(claudeJsonPath, fresh.parsed);
    return {
      action: 'seeded' as const,
      detail: `seeded ${seededKeys.length} key(s) for ${worktreePath}`,
      seededKeys,
    };
  });
  if (!locked.acquired) return { action: 'skipped', detail: locked.detail, seededKeys: [] };
  return locked.value;
}

export interface PruneResult {
  action: 'pruned' | 'skipped';
  detail: string;
}

/**
 * The inverse of the seed, for `worktree-rush remove`: drop the worktree
 * path's project entry from `~/.claude.json` so deleted worktrees don't
 * accumulate stale entries. Same lock + fresh-read + atomic-write discipline
 * as the seed; refuses to touch an unreadable file.
 */
export function pruneClaudeProjectEntry(
  worktreePath: string,
  claudeJsonPath: string = defaultClaudeJsonPath(),
): PruneResult {
  if (!fs.existsSync(claudeJsonPath)) {
    return { action: 'skipped', detail: `${claudeJsonPath} does not exist — nothing to prune` };
  }
  const locked = withClaudeJsonLock(claudeJsonPath, () => {
    const fresh = readClaudeJson(claudeJsonPath);
    if (fresh.error !== undefined) {
      return {
        action: 'skipped' as const,
        detail: `${claudeJsonPath} is not valid JSON (${fresh.error}) — refusing to touch it`,
      };
    }
    if (!fresh.parsed.projects || !(worktreePath in fresh.parsed.projects)) {
      return { action: 'skipped' as const, detail: `no project entry for ${worktreePath}` };
    }
    delete fresh.parsed.projects[worktreePath];
    writeClaudeJson(claudeJsonPath, fresh.parsed);
    return { action: 'pruned' as const, detail: `pruned project entry for ${worktreePath}` };
  });
  if (!locked.acquired) return { action: 'skipped', detail: locked.detail };
  return locked.value;
}

export interface CopyResult {
  action: 'copied' | 'skipped';
  detail: string;
}

function refuseSettingsCopy(reason: string): never {
  throw new Error(`Refusing to copy .claude/settings.local.json: ${reason}`);
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function ensureSafeDirectory(root: string, segment: string): string {
  const candidate = path.join(root, segment);
  let entry = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) {
    refuseSettingsCopy(`worktree destination component "${segment}" is a symbolic link`);
  }
  if (entry && !entry.isDirectory()) {
    refuseSettingsCopy(`worktree destination component "${segment}" is not a directory`);
  }
  if (!entry) {
    try {
      fs.mkdirSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    entry = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      refuseSettingsCopy(`worktree destination component "${segment}" is a symbolic link`);
    }
    if (!entry?.isDirectory()) {
      refuseSettingsCopy(`worktree destination component "${segment}" is not a directory`);
    }
  }
  const resolved = fs.realpathSync(candidate);
  if (!isContainedBy(root, resolved)) {
    refuseSettingsCopy(`worktree destination component "${segment}" escapes the worktree`);
  }
  return resolved;
}

/**
 * Cleanup guard for a failed `.claude/settings.local.json` copy: revalidate the
 * path WITHOUT following mutable components, and remove only if the entry is
 * still the exact file we created (dev+ino captured from our open descriptor).
 * The removal itself resolves through a PINNED directory descriptor
 * (`/proc/self/fd/<n>` on Linux, `/dev/fd/<n>` on macOS), so even a swap of
 * the `.claude` path between the validation and the unlink cannot redirect it
 * outside the directory we validated. On platforms without a
 * directory-handle-relative unlink the cleanup FAILS CLOSED: the entry is
 * left in place rather than removed through a potentially swapped parent.
 */
export function cleanupFailedSettingsCopy(
  targetDir: string,
  target: string,
  identity: { dev: number; ino: number } | undefined,
): void {
  if (identity === undefined) return;
  let dirFd: number | undefined;
  try {
    // Pin FIRST (O_NOFOLLOW + O_DIRECTORY rejects a symlinked replacement),
    // then validate and unlink the child through the same descriptor.
    const fdRelativeRoot =
      process.platform === 'linux'
        ? '/proc/self/fd'
        : process.platform === 'darwin'
          ? '/dev/fd'
          : undefined;
    if (fdRelativeRoot === undefined) {
      // No directory-handle-relative unlink available: fail closed. Leave the
      // (identity-checked, our own) entry rather than risk removing an
      // external file through a parent path an attacker may have swapped.
      return;
    }
    dirFd = fs.openSync(
      targetDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const child = `${fdRelativeRoot}/${dirFd}/${path.basename(target)}`;
    const fileStats = fs.lstatSync(child);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) return;
    if (fileStats.dev !== identity.dev || fileStats.ino !== identity.ino) return;
    fs.rmSync(child, { force: true });
  } catch {
    // Path no longer resolves to our file: nothing safe to remove.
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * `.claude/settings.local.json` is untracked by design, so a fresh worktree
 * never gets it from git (WORKTREE-INHERITANCE.md class 2). Copy — not
 * symlink — so a worktree can diverge without silently editing every other
 * worktree's permissions.
 */
export function copySettingsLocal(sourceRepoPath: string, worktreePath: string): CopyResult {
  const source = path.join(sourceRepoPath, '.claude', 'settings.local.json');
  if (!fs.existsSync(source)) {
    return { action: 'skipped', detail: 'source has no .claude/settings.local.json' };
  }

  const worktreeRoot = fs.realpathSync(worktreePath);
  if (!fs.statSync(worktreeRoot).isDirectory()) {
    refuseSettingsCopy(`worktree root "${worktreePath}" is not a directory`);
  }
  const targetDir = ensureSafeDirectory(worktreeRoot, '.claude');
  const target = path.join(targetDir, 'settings.local.json');
  if (!isContainedBy(worktreeRoot, target)) {
    refuseSettingsCopy('resolved destination escapes the worktree');
  }

  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    refuseSettingsCopy('destination file is a symbolic link');
  }
  if (existing?.isFile()) {
    return { action: 'skipped', detail: 'worktree already has .claude/settings.local.json' };
  }
  if (existing) {
    refuseSettingsCopy('destination exists and is not a regular file');
  }

  const contents = fs.readFileSync(source);
  const mode = fs.statSync(source).mode & 0o7777;
  let descriptor: number | undefined;
  let createdIdentity: { dev: number; ino: number } | undefined;
  let created = false;
  let complete = false;
  try {
    descriptor = fs.openSync(target, 'wx', mode);
    created = true;
    const openedStats = fs.fstatSync(descriptor);
    createdIdentity = { dev: openedStats.dev, ino: openedStats.ino };
    const resolvedTarget = fs.realpathSync(target);
    if (!isContainedBy(worktreeRoot, resolvedTarget)) {
      refuseSettingsCopy('resolved destination escapes the worktree');
    }
    fs.writeFileSync(descriptor, contents);
    fs.closeSync(descriptor);
    descriptor = undefined;
    complete = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      refuseSettingsCopy('destination appeared during the exclusive copy');
    }
    throw err;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created && !complete) cleanupFailedSettingsCopy(targetDir, target, createdIdentity);
  }
  return { action: 'copied', detail: `copied .claude/settings.local.json from ${sourceRepoPath}` };
}
