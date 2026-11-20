import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UsageError } from './stages.js';

// Deliberately mirrors the sibling plugins' rushRepo helpers rather than
// importing them: the extraction contract for every plugin in this family is
// zero workspace imports (RUSH-PLUGINS-PRD §1). worktree-rush needs only the
// repo root, so this copy is intentionally the minimal subset.

export interface RepoRoot {
  root: string;
  /** True when rush.json sits at the root — gates the install and
   * store/cache-sharing stages; the git + agent-state stages work anywhere. */
  isRushWorkspace: boolean;
}

/**
 * If `root` is itself a linked worktree (its `.git` is a gitdir-pointer FILE,
 * not a directory), remap to the main checkout. Without this, running
 * worktree-create from inside a worktree derives a nested
 * `.worktrees/.../.worktrees/...` path and inherits state from a path that
 * has none (bitten live on this box).
 *
 * Submodules are refused, not mis-derived: a submodule's linked-worktree
 * gitdir lives under `.git/modules/<name>/worktrees/<wt>`, from which the
 * submodule's own working tree is not recoverable by slicing — and its
 * `.worktrees` tree would land INSIDE the superproject's working tree anyway.
 */
export function mainRootOf(root: string): string {
  const dotGit = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return root;
  }
  if (stat.isDirectory()) return root;
  const content = fs.readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/.exec(content);
  if (!match) return root;
  const gitDir = path.resolve(root, match[1]!);
  if (gitDir.includes(`${path.sep}.git${path.sep}modules${path.sep}`)) {
    throw new UsageError(
      `"${root}" is a git submodule — worktrees of submodules are not supported (the .worktrees tree would land inside the superproject's working tree)`,
    );
  }
  // <main>/.git/worktrees/<name> → <main>
  const worktreesIdx = gitDir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
  if (worktreesIdx === -1) return root;
  return gitDir.slice(0, worktreesIdx);
}

/**
 * Locate the repo to worktree. Only git repositories can hold worktrees, so
 * the git toplevel is authoritative; `rush.json` AT that toplevel merely
 * gates the Rush-specific stages. This ordering (git first, rush.json as a
 * property — not the other way around) matters concretely: a NESTED Rush
 * workspace inside a bigger git repo (this repo's own rush-testbed fixture)
 * must never become the "root", or the worktree would be derived from a
 * subdirectory and land inside the outer repo's working tree.
 */
export function findRepoRoot(startDir: string): RepoRoot {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf8',
  });
  if (git.status === 0 && git.stdout.trim()) {
    const main = mainRootOf(git.stdout.trim());
    return { root: main, isRushWorkspace: fs.existsSync(path.join(main, 'rush.json')) };
  }
  throw new UsageError(
    `"${startDir}" is not inside a git repository's working tree — nothing to create a worktree of (worktrees are a git feature; a Rush workspace without git cannot hold them).`,
  );
}
