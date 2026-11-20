#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  copySettingsLocal,
  defaultClaudeJsonPath,
  seedClaudeProjectEntry,
  SEEDED_KEYS,
} from './claudeState.js';
import { isAuthenticatedLinkedWorktree } from './worktreeRegistration.js';

export { isAuthenticatedLinkedWorktree as isLinkedWorktreeOf } from './worktreeRegistration.js';

/**
 * SessionStart safety net (RUSH-WORKTREE-PRD §3.3). The PRIMARY bootstrap is
 * `rush worktree-create` doing this work eagerly at creation time; this hook
 * only self-heals worktrees created by hand with `git worktree add`, which
 * skip the bootstrap entirely. Reactive by nature: the session that triggers
 * it may already have eaten one trust prompt — later sessions won't.
 *
 * Wire-up options (see README "SessionStart hook"): per-repo in tracked
 * .claude/settings.json (guarded so a missing file is a no-op), or — with a
 * globally installed @butshouldwe/worktree-rush — one user-level hook whose
 * command points at the GLOBAL install's absolute path. Never wire a
 * repo-relative path in user-level settings: that would hand any untrusted
 * repo code execution at SessionStart.
 */

/** For `<parent>/.worktrees/<repo>/<branch...>`, the source checkout is
 * `<parent>/<repo>`. Returns null when cwd is not under a .worktrees tree.
 *
 * The worktree root is the SHALLOWEST `.git`-bearing directory below
 * `.worktrees/<repo>/` — branch names may contain slashes, so it is not at a
 * fixed depth; and picking the deepest would mis-identify a nested/vendored
 * repo inside the worktree as the worktree itself. Splitting tolerates mixed
 * separators (Git Bash on Windows hands out forward-slash cwds). */
export function sourceRootForWorktree(
  cwd: string,
): { sourceRoot: string; worktreeRoot: string } | null {
  const parts = path.resolve(cwd).split(/[\\/]/);
  const index = parts.indexOf('.worktrees');
  if (index <= 0 || index + 1 >= parts.length) return null;
  let parent = parts.slice(0, index).join(path.sep) || path.sep;
  if (/^[A-Za-z]:$/.test(parent)) parent += path.sep; // never a drive-RELATIVE path
  const repoName = parts[index + 1]!;
  const sourceRoot = path.join(parent, repoName);
  for (let depth = index + 2; depth <= parts.length; depth += 1) {
    const candidate = parts.slice(0, depth).join(path.sep);
    if (fs.existsSync(path.join(candidate, '.git'))) {
      return { sourceRoot, worktreeRoot: candidate };
    }
  }
  return null;
}

interface ProjectsFile {
  projects?: Record<string, Record<string, unknown>>;
}

/** Heal only when it would change something: compare the seedable keys of the
 * source entry against the target. Keying off a single flag (the old
 * behavior) re-ran the full read-modify-rename of ~/.claude.json on EVERY
 * session start whenever the source lacked that one key. */
function needsSeed(parsed: ProjectsFile, sourceRoot: string, worktreeRoot: string): boolean {
  let source = parsed.projects?.[sourceRoot];
  if (!source) {
    try {
      source = parsed.projects?.[fs.realpathSync(sourceRoot)];
    } catch {
      return false;
    }
  }
  if (!source) return false; // nothing to seed from
  const target = parsed.projects?.[worktreeRoot];
  for (const key of SEEDED_KEYS) {
    if (source[key] === undefined) continue;
    if (target === undefined) return true;
    if (JSON.stringify(target[key]) !== JSON.stringify(source[key])) return true;
  }
  return false;
}

export function selfHeal(cwd: string, claudeJsonPath: string = defaultClaudeJsonPath()): string {
  const located = sourceRootForWorktree(cwd);
  if (!located) return '';
  const { sourceRoot, worktreeRoot } = located;
  if (!fs.existsSync(path.join(sourceRoot, '.git'))) return '';
  if (!isAuthenticatedLinkedWorktree(sourceRoot, worktreeRoot)) return '';

  let parsed: ProjectsFile;
  try {
    parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as ProjectsFile;
  } catch {
    return ''; // no readable claude.json — nothing to heal from
  }

  const parts: string[] = [];
  if (needsSeed(parsed, sourceRoot, worktreeRoot)) {
    try {
      const seed = seedClaudeProjectEntry(sourceRoot, worktreeRoot, claudeJsonPath);
      parts.push(`~/.claude.json ${seed.action}`);
    } catch (err) {
      parts.push(
        `~/.claude.json seed failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  try {
    const copy = copySettingsLocal(sourceRoot, worktreeRoot);
    if (copy.action === 'copied') parts.push(`settings.local ${copy.action}`);
  } catch (err) {
    parts.push(`settings.local copy failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (parts.length === 0) return ''; // nothing needed — stay silent
  return `worktree-rush self-heal: ${parts.join('; ')}. Prefer \`rush worktree-create\` next time — it bootstraps eagerly at creation.`;
}

// Entry point when invoked as a hook (not imported). Exact-URL comparison —
// a loose suffix match would fire the side effect for any importer whose
// argv[1] basename merely ends like ours.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const message = selfHeal(process.cwd());
  if (message) process.stdout.write(`${message}\n`);
}
