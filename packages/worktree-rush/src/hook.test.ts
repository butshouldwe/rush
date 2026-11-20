import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLinkedWorktreeOf, selfHeal, sourceRootForWorktree } from './hook.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-hook-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A real source repo + a real hand-rolled worktree (the exact case the hook
 * exists for: someone bypassed `rush worktree-create`). */
function makeRepoWithWorktree(): { source: string; worktree: string } {
  const source = path.join(tmp, 'myrepo');
  fs.mkdirSync(source);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source });
  fs.writeFileSync(path.join(source, 'rush.json'), '{}');
  execFileSync('git', ['add', '-A'], { cwd: source });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: source,
  });
  const worktree = path.join(tmp, '.worktrees', 'myrepo', 'feat', 'z');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', worktree, '-b', 'feat/z'], { cwd: source });
  return { source, worktree };
}

describe('sourceRootForWorktree', () => {
  it('derives the source checkout and worktree root from a cwd inside the worktree', () => {
    const { source, worktree } = makeRepoWithWorktree();
    const deep = path.join(worktree, 'packages');
    fs.mkdirSync(deep, { recursive: true });
    expect(sourceRootForWorktree(deep)).toEqual({ sourceRoot: source, worktreeRoot: worktree });
    expect(sourceRootForWorktree(worktree)).toEqual({ sourceRoot: source, worktreeRoot: worktree });
  });

  it('returns null outside a .worktrees tree', () => {
    expect(sourceRootForWorktree('/workspace/rush')).toBeNull();
    expect(sourceRootForWorktree('/')).toBeNull();
  });

  it('picks the SHALLOWEST .git below .worktrees/<repo>/, not a nested/vendored repo', () => {
    const { source, worktree } = makeRepoWithWorktree();
    // Plant a nested git repo inside the worktree (vendored dependency).
    const vendored = path.join(worktree, 'vendor', 'lib');
    fs.mkdirSync(vendored, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: vendored });
    const deepCwd = path.join(vendored, 'src');
    fs.mkdirSync(deepCwd, { recursive: true });
    // The worktree root must be the worktree itself — NOT vendor/lib, which
    // the old deepest-first walk would have picked and mis-seeded trust for.
    expect(sourceRootForWorktree(deepCwd)).toEqual({
      sourceRoot: source,
      worktreeRoot: worktree,
    });
  });
});

describe('isLinkedWorktreeOf (trust gate)', () => {
  it('accepts a real linked worktree registration', () => {
    const { source, worktree } = makeRepoWithWorktree();
    expect(isLinkedWorktreeOf(source, worktree)).toBe(true);
  });

  it('rejects a planted repository with a .git directory', () => {
    const { source } = makeRepoWithWorktree();
    const fake1 = path.join(tmp, '.worktrees', 'myrepo', 'fake1');
    fs.mkdirSync(fake1, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: fake1 });
    expect(isLinkedWorktreeOf(source, fake1)).toBe(false);
  });

  it('rejects a forged pointer naming a nonexistent administrative directory', () => {
    const { source } = makeRepoWithWorktree();
    const fake2 = path.join(tmp, '.worktrees', 'myrepo', 'fake2');
    fs.mkdirSync(fake2, { recursive: true });
    fs.writeFileSync(
      path.join(fake2, '.git'),
      `gitdir: ${path.join(source, '.git', 'worktrees', 'nonexistent')}\n`,
    );
    expect(isLinkedWorktreeOf(source, fake2)).toBe(false);
  });

  it('rejects a registration whose backlink points elsewhere', () => {
    const { source, worktree } = makeRepoWithWorktree();
    const pointer = fs.readFileSync(path.join(worktree, '.git'), 'utf8').trim();
    const adminDir = path.resolve(worktree, pointer.replace(/^gitdir:\s*/, ''));
    fs.writeFileSync(path.join(adminDir, 'gitdir'), path.join(tmp, 'elsewhere', '.git'));
    expect(isLinkedWorktreeOf(source, worktree)).toBe(false);
  });

  it('rejects a registration whose common directory belongs to another source', () => {
    const { source, worktree } = makeRepoWithWorktree();
    const otherSource = path.join(tmp, 'other-source');
    fs.mkdirSync(otherSource);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: otherSource });
    const pointer = fs.readFileSync(path.join(worktree, '.git'), 'utf8').trim();
    const adminDir = path.resolve(worktree, pointer.replace(/^gitdir:\s*/, ''));
    fs.writeFileSync(path.join(adminDir, 'commondir'), path.join(otherSource, '.git'));

    expect(isLinkedWorktreeOf(source, worktree)).toBe(false);
  });

  it('rejects a directory without a .git entry', () => {
    const { source } = makeRepoWithWorktree();
    const fake3 = path.join(tmp, '.worktrees', 'myrepo', 'fake3');
    fs.mkdirSync(fake3, { recursive: true });
    expect(isLinkedWorktreeOf(source, fake3)).toBe(false);
  });
});

describe('selfHeal', () => {
  it('seeds an unbootstrapped hand-rolled worktree from the source entry', () => {
    const { source, worktree } = makeRepoWithWorktree();
    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: { [source]: { hasTrustDialogAccepted: true, allowedTools: ['Read'] } },
      }),
    );
    const message = selfHeal(worktree, claudeJson);
    expect(message).toContain('self-heal');
    expect(message).toContain('rush worktree-create');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[worktree].hasTrustDialogAccepted).toBe(true);
  });

  it('no-ops when the worktree is already seeded', () => {
    const { source, worktree } = makeRepoWithWorktree();
    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: {
          [source]: { hasTrustDialogAccepted: true },
          [worktree]: { hasTrustDialogAccepted: true },
        },
      }),
    );
    expect(selfHeal(worktree, claudeJson)).toBe('');
  });

  it('no-ops outside a worktree and without a readable claude.json', () => {
    const { worktree } = makeRepoWithWorktree();
    expect(selfHeal('/definitely/not/a/worktree', path.join(tmp, 'claude.json'))).toBe('');
    expect(selfHeal(worktree, path.join(tmp, 'missing.json'))).toBe('');
  });

  it('refuses to seed a planted fake worktree (trust-dialog bypass attempt)', () => {
    const { source } = makeRepoWithWorktree();
    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: { [source]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
      }),
    );
    // Attacker plants a directory shaped like a worktree, with its own repo
    // inside — hoping SessionStart hands it the source repo's trust.
    const planted = path.join(tmp, '.worktrees', 'myrepo', 'evil');
    fs.mkdirSync(planted, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: planted });
    expect(selfHeal(planted, claudeJson)).toBe('');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[planted]).toBeUndefined();
  });

  it('heals once then stays silent when the source entry has allowedTools but no trust flag', () => {
    // The old gate keyed only on hasTrustDialogAccepted and re-ran the full
    // rewrite on EVERY SessionStart for this shape.
    const { source, worktree } = makeRepoWithWorktree();
    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [source]: { allowedTools: ['Read', 'Bash(pnpm:*)'] } } }),
    );
    const first = selfHeal(worktree, claudeJson);
    expect(first).toContain('seeded');
    const afterFirst = fs.readFileSync(claudeJson, 'utf8');
    const second = selfHeal(worktree, claudeJson);
    expect(second).toBe(''); // nothing left to change — no rewrite, no noise
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe(afterFirst);
  });

  it('no-ops when the derived sourceRoot has no .git (hook.ts:42)', () => {
    // A cwd shaped exactly like <parent>/.worktrees/<repo>/<branch...>, whose
    // deepest ancestor within it is itself a git worktree (so
    // sourceRootForWorktree resolves fine) — but "myrepo", the derived
    // sourceRoot path, was never a real source checkout. selfHeal must refuse
    // rather than try to seed from a source that doesn't exist.
    const worktree = path.join(tmp, '.worktrees', 'myrepo', 'feat', 'ghost');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /nonexistent\n');
    expect(fs.existsSync(path.join(tmp, 'myrepo', '.git'))).toBe(false);
    expect(sourceRootForWorktree(worktree)).not.toBeNull();

    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
    expect(selfHeal(worktree, claudeJson)).toBe('');
  });
});
