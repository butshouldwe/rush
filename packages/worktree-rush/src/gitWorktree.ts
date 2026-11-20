import path from 'node:path';
import { UsageError, type ProcessRunner } from './stages.js';

export type CommitResolution =
  | { ok: true; oid: string }
  | { ok: false; detail: string; error?: Error };

/** Resolve a local ref to exactly one full commit OID. `^{commit}` rejects
 * blobs/trees while peeling annotated tags; `--end-of-options` prevents a
 * ref-shaped option from changing the command. Git can warn about an
 * ambiguous short ref while still printing an OID, so stderr is part of the
 * validation result rather than incidental output. */
export function resolveCommitOid(
  repoRoot: string,
  ref: string,
  exec: ProcessRunner,
  subject: string = 'start point',
): CommitResolution {
  if (ref.length === 0) {
    return { ok: false, detail: `${subject} must not be empty` };
  }
  const result = exec(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    repoRoot,
  );
  if (result.error) {
    return { ok: false, detail: result.error.message, error: result.error };
  }
  const oid = result.stdout.trim();
  const isFullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid);
  if (result.status !== 0 || /ambiguous/i.test(result.stderr) || !isFullOid) {
    return {
      ok: false,
      detail: `${subject} "${ref}" does not resolve to one unambiguous commit`,
    };
  }
  return { ok: true, oid };
}

export type AncestryCheck =
  | { ok: true; isAncestor: boolean }
  | { ok: false; detail: string; error?: Error };

/** Check whether one already-resolved commit is an ancestor of another.
 * Exit 1 is Git's ordinary "no" answer; every other nonzero status is an
 * inspection failure and must not authorize removal. */
export function checkAncestor(
  repoRoot: string,
  ancestorOid: string,
  targetOid: string,
  exec: ProcessRunner,
): AncestryCheck {
  const result = exec('git', ['merge-base', '--is-ancestor', ancestorOid, targetOid], repoRoot);
  if (result.error) {
    return { ok: false, detail: result.error.message, error: result.error };
  }
  if (result.status === 0) return { ok: true, isAncestor: true };
  if (result.status === 1) return { ok: true, isAncestor: false };
  return {
    ok: false,
    detail: (result.stderr || result.stdout).trim() || 'git ancestry check failed',
  };
}

/** Resolve an already-validated commit OID to its full tree OID. Exact tree
 * equality is the conservative squash-merge proof: any conflict resolution,
 * extra file, or later mainline change intentionally makes it fail. */
export function resolveTreeOid(
  repoRoot: string,
  commitOid: string,
  exec: ProcessRunner,
): CommitResolution {
  const result = exec(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${commitOid}^{tree}`],
    repoRoot,
  );
  if (result.error) {
    return { ok: false, detail: result.error.message, error: result.error };
  }
  const oid = result.stdout.trim();
  const isFullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid);
  if (result.status !== 0 || !isFullOid) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout).trim() || `could not resolve tree for ${commitOid}`,
    };
  }
  return { ok: true, oid };
}

/**
 * Worktrees live OUTSIDE the repo at
 * `<parent-of-repo>/.worktrees/<repo-name>/<branch>`, independent of the host.
 */
export function worktreePathFor(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const parent = path.dirname(repoRoot);
  return path.join(parent, '.worktrees', repoName, branch);
}

/** Windows-reserved device names are uncreatable/aliased as path segments on
 * win32 (`con`, `nul`, `com1`…); rejected on every platform so a branch made
 * on Linux never produces a worktree a Windows checkout cannot hold. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Branch names become filesystem paths under .worktrees/<repo>/, so anything
 * that would escape that directory is rejected outright. Slashes are allowed
 * (feat/x is idiomatic) — traversal and absolute paths are not.
 */
export function validateBranchName(branch: string): void {
  if (branch.length === 0) throw new UsageError('branch name is empty');
  if (path.isAbsolute(branch)) {
    throw new UsageError(`branch name "${branch}" must not be absolute`);
  }
  const segments = branch.split(/[/\\]/);
  if (
    segments.some(
      (s) =>
        s === '' ||
        s === '.' ||
        s === '..' ||
        s.startsWith('.') ||
        s.endsWith('.') ||
        s.endsWith('.lock') ||
        WINDOWS_RESERVED.test(s) ||
        // oxlint-disable-next-line no-control-regex -- intentional: rejecting control characters is the point of this check (git refnames forbid them).
        /[\x00-\x1f\x7f]/.test(s),
    )
  ) {
    throw new UsageError(
      `branch name "${branch}" contains an empty, traversal, dot-prefixed/suffixed, .lock-suffixed, Windows-reserved, or control-character path segment`,
    );
  }
  // git's own most common refname rejections — plus <>|" (legal in git
  // refnames but unrepresentable as win32 path characters) — checked early
  // for a better error.
  if (/[\s~^:?*[\]@{\\<>|"]|\.\.|\/\/|\.lock$|\/$|^\/|^-/.test(branch) || branch.endsWith('.')) {
    throw new UsageError(`branch name "${branch}" is not a valid git branch name`);
  }
}
