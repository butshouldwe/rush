import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteBranchAtomically, removeWorktree, formatRemoveReport } from './remove.js';
import { runProcess, type ProcessRunner } from './stages.js';
import { createWorktree } from './worktree.js';

function gitOid(ref: string = 'HEAD', cwd: string = repo): string {
  return execFileSync('git', ['rev-parse', '--verify', ref], { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd: string, name: string, contents: string, message: string): string {
  fs.writeFileSync(path.join(cwd, name), contents);
  execFileSync('git', ['add', name], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message], {
    cwd,
  });
  return gitOid('HEAD', cwd);
}

function branchExists(branch: string): boolean {
  return (
    execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf8' }).trim() !== ''
  );
}

let tmp: string;
let repo: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-remove-'));
  repo = path.join(tmp, 'myrepo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: repo,
  });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('removeWorktree (real git)', () => {
  it('canonicalizes a relative --from to the create path before removal', () => {
    const branch = 'feat/relative-from';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    const originalCwd = process.cwd();
    let removed;
    try {
      process.chdir(repo);
      removed = removeWorktree(repo, { branch, from: '.' });
    } finally {
      process.chdir(originalCwd);
    }

    expect(removed.worktreePath).toBe(created.worktreePath);
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(branchExists(branch)).toBe(false);
  });

  it('refuses atomic branch deletion when the expected oid is stale', () => {
    const branch = 'feat/stale-delete';
    execFileSync('git', ['branch', branch], { cwd: repo });
    const staleOid = gitOid(branch);
    const movedOid = commitFile(repo, 'moved.txt', 'moved', 'move branch target');
    execFileSync('git', ['update-ref', `refs/heads/${branch}`, movedOid], { cwd: repo });

    const deleted = deleteBranchAtomically(repo, branch, staleOid);

    expect(deleted.ok).toBe(false);
    expect(deleted.detail).toContain('refusing to delete');
    expect(branchExists(branch)).toBe(true);
    expect(gitOid(branch)).toBe(movedOid);
  });

  it('refuses to delete a branch checked out in another linked worktree', () => {
    const branch = 'feat/checked-out-elsewhere';
    const otherWorktree = path.join(tmp, 'other-worktree');
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-q', otherWorktree, branch], { cwd: repo });

    const refused = removeWorktree(repo, { branch });

    expect(refused.ok).toBe(false);
    expect(refused.stages.at(-1)?.name).toBe('branch-delete');
    expect(refused.stages.at(-1)?.detail).toContain('checked out in a worktree');
    expect(branchExists(branch)).toBe(true);
    expect(gitOid('HEAD', otherWorktree)).toBe(gitOid(branch));
  });

  it('removes worktree, deletes the merged branch, prunes state, sweeps empty parents', () => {
    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    const created = createWorktree(repo, {
      branch: 'feat/x',
      install: false,
      claudeJsonPath: claudeJson,
    });
    expect(created.ok).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[created.worktreePath],
    ).toBeDefined();

    commitFile(created.worktreePath, 'feature.txt', 'merged', 'feature work');
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'merge',
        '--no-ff',
        '-qm',
        'merge feature',
        'feat/x',
      ],
      { cwd: repo },
    );
    const targetOid = gitOid();

    const removed = removeWorktree(repo, {
      branch: 'feat/x',
      mergedInto: targetOid,
      claudeJsonPath: claudeJson,
    });
    expect(removed.ok).toBe(true);
    expect(removed.removalProof).toBe('ancestry');
    expect(removed.resolvedTargetOid).toBe(targetOid);
    expect(removed.stages.map((s) => s.name)).toEqual([
      'removal-preflight',
      'git-worktree-remove',
      'branch-delete',
      'state-prune',
    ]);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    // merged branch deleted
    const branches = execFileSync('git', ['branch', '--list', 'feat/x'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(branches.trim()).toBe('');
    // seeded entry pruned
    expect(removed.claudePrune?.action).toBe('pruned');
    expect(
      JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[created.worktreePath],
    ).toBeUndefined();
    // the empty feat/ parent dir was swept; .worktrees/myrepo itself remains
    expect(fs.existsSync(path.join(tmp, '.worktrees', 'myrepo', 'feat'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.worktrees', 'myrepo'))).toBe(true);
    expect(formatRemoveReport(removed)).toContain('✓ removed feat/x');
  });

  it('is converge-flavored: removing an already-absent worktree/branch succeeds', () => {
    const result = removeWorktree(repo, {
      branch: 'feat/never-existed',
      claudeJsonPath: path.join(tmp, 'missing-claude.json'),
    });
    expect(result.ok).toBe(true);
    expect(result.removalProof).toBe('not-needed');
    expect(result.stages[0]!.name).toBe('removal-preflight');
    expect(result.stages[0]!.detail).toContain('not needed');
    for (const s of result.stages.slice(1, 3)) expect(s.detail).toContain('already absent');
    expect(result.stages.at(-1)?.detail).toContain('does not exist');
  });

  it('refuses a dirty worktree without --force, with a hint; --force removes it', () => {
    const created = createWorktree(repo, {
      branch: 'feat/dirty',
      install: false,
      warmClaude: false,
    });
    expect(created.ok).toBe(true);
    fs.writeFileSync(path.join(created.worktreePath, 'untracked.txt'), 'wip');

    const refused = removeWorktree(repo, { branch: 'feat/dirty', mergedInto: 'HEAD' });
    expect(refused.ok).toBe(false);
    const stage = refused.stages.find((s) => s.name === 'removal-preflight');
    expect(stage?.ok).toBe(false);
    expect(stage?.detail).toContain('--force');
    expect(fs.existsSync(created.worktreePath)).toBe(true); // untouched
    expect(branchExists('feat/dirty')).toBe(true);

    const forced = removeWorktree(repo, { branch: 'feat/dirty', force: true });
    expect(forced.ok).toBe(true);
    expect(forced.removalProof).toBe('forced');
    expect(fs.existsSync(created.worktreePath)).toBe(false);
  });

  it('refuses an unmerged branch before mutation; re-run with --force removes it', () => {
    const created = createWorktree(repo, {
      branch: 'feat/ahead',
      install: false,
      warmClaude: false,
    });
    expect(created.ok).toBe(true);
    fs.writeFileSync(path.join(created.worktreePath, 'new.txt'), 'ahead of main');
    execFileSync('git', ['add', '-A'], { cwd: created.worktreePath });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'unmerged work'],
      { cwd: created.worktreePath },
    );

    const refused = removeWorktree(repo, { branch: 'feat/ahead' });
    expect(refused.ok).toBe(false);
    expect(refused.stages).toHaveLength(1);
    expect(refused.stages[0]!.name).toBe('removal-preflight');
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists('feat/ahead')).toBe(true);

    const forced = removeWorktree(repo, { branch: 'feat/ahead', force: true });
    expect(forced.ok).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', 'feat/ahead'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(branches.trim()).toBe('');
  });

  it('refuses a detached worktree with an unproven commit', () => {
    const created = createWorktree(repo, {
      branch: 'feat/detached-unproven',
      install: false,
      warmClaude: false,
    });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });
    const detachedOid = commitFile(
      created.worktreePath,
      'detached.txt',
      'unproven',
      'detached work',
    );

    const refused = removeWorktree(repo, { branch: 'feat/detached-unproven' });

    expect(refused.ok).toBe(false);
    expect(refused.removalProof).toBeUndefined();
    expect(refused.stages).toHaveLength(1);
    expect(refused.stages[0]!.detail).toContain('detached HEAD');
    expect(refused.stages[0]!.detail).toContain('unproven commits');
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists('feat/detached-unproven')).toBe(true);
    expect(() =>
      execFileSync('git', ['cat-file', '-e', `${detachedOid}^{commit}`], { cwd: repo }),
    ).not.toThrow();
  });

  it('refuses an unproven detached worktree when the branch is already absent', () => {
    const branch = 'feat/detached-branch-absent';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });
    const detachedOid = commitFile(
      created.worktreePath,
      'detached.txt',
      'unproven',
      'detached work',
    );
    execFileSync('git', ['update-ref', '-d', `refs/heads/${branch}`], { cwd: repo });

    const refused = removeWorktree(repo, { branch });

    expect(refused.ok).toBe(false);
    expect(refused.removalProof).toBeUndefined();
    expect(refused.stages).toHaveLength(1);
    expect(refused.stages[0]!.detail).toContain('detached HEAD');
    expect(refused.stages[0]!.detail).toContain('unproven commits');
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists(branch)).toBe(false);
    expect(() =>
      execFileSync('git', ['cat-file', '-e', `${detachedOid}^{commit}`], { cwd: repo }),
    ).not.toThrow();
  });

  it('allows --force to remove a detached worktree with an explicit warning', () => {
    const branch = 'feat/detached-forced';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });
    const detachedOid = commitFile(created.worktreePath, 'detached.txt', 'forced', 'detached work');

    const removed = removeWorktree(repo, { branch, force: true });

    expect(removed.ok).toBe(true);
    expect(removed.removalProof).toBe('forced');
    expect(removed.stages[0]!.detail).toContain(
      `warning: forced; detached HEAD ${detachedOid} carries no merge proof`,
    );
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(branchExists(branch)).toBe(false);
  });

  it('removes a detached worktree whose HEAD is contained in the proof target', () => {
    const created = createWorktree(repo, {
      branch: 'feat/detached-contained',
      install: false,
      warmClaude: false,
    });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });

    const removed = removeWorktree(repo, { branch: 'feat/detached-contained' });

    expect(removed.ok).toBe(true);
    expect(removed.removalProof).toBe('ancestry');
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(branchExists('feat/detached-contained')).toBe(false);
  });

  it('refuses a worktree switched to a different branch even with --force', () => {
    const created = createWorktree(repo, {
      branch: 'feat/requested',
      install: false,
      warmClaude: false,
    });
    execFileSync('git', ['switch', '-qc', 'feat/different'], { cwd: created.worktreePath });

    const refused = removeWorktree(repo, { branch: 'feat/requested', force: true });

    expect(refused.ok).toBe(false);
    expect(refused.removalProof).toBeUndefined();
    expect(refused.stages).toHaveLength(1);
    expect(refused.stages[0]!.detail).toContain('different branch');
    expect(refused.stages[0]!.detail).toContain('refusing to remove');
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists('feat/requested')).toBe(true);
    expect(branchExists('feat/different')).toBe(true);
  });

  it('refuses when the worktree HEAD changes after preflight', () => {
    const branch = 'feat/head-race';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    let symbolicRefCalls = 0;
    const detachBeforeRemoval: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git' && cwd === created.worktreePath && args[0] === 'symbolic-ref') {
        symbolicRefCalls += 1;
        if (symbolicRefCalls === 2) {
          execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });
        }
      }
      return runProcess(bin, args, cwd);
    };

    const refused = removeWorktree(repo, { branch }, detachBeforeRemoval);

    expect(refused.ok).toBe(false);
    expect(refused.stages).toHaveLength(2);
    expect(refused.stages[1]!.name).toBe('git-worktree-remove');
    expect(refused.stages[1]!.detail).toContain('moved after preflight');
    expect(refused.stages[1]!.detail).toContain('refusing to remove');
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists(branch)).toBe(true);
  });

  it('restores the ref when a checkout appears between the guard and deletion', () => {
    const branch = 'feat/checkout-race';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    commitFile(created.worktreePath, 'race.txt', 'x', 'race commit');
    execFileSync('git', ['merge', '--no-edit', '-q', branch], { cwd: repo });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });

    const calls: string[] = [];
    let sawDelete = false;
    const racingRunner: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'update-ref' && args[1] === '-d') sawDelete = true;
      if (bin === 'git' && args[0] === 'worktree' && args[1] === 'list' && sawDelete) {
        return {
          status: 0,
          stdout: `worktree ${repo}\nHEAD ${'1'.repeat(40)}\n\nworktree ${created.worktreePath}\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/${branch}\n`,
          stderr: '',
          error: undefined,
        };
      }
      calls.push(`${bin} ${args.join(' ')}`);
      return runProcess(bin, args, cwd);
    };

    const refused = removeWorktree(repo, { branch }, racingRunner);

    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('ref restored');
    expect(branchExists(branch)).toBe(true);
    expect(calls.some((c) => c === `git update-ref refs/heads/${branch} `)).toBe(false);
    expect(
      calls.some(
        (c) => c.startsWith(`git update-ref refs/heads/${branch} `) && !c.includes(' -d '),
      ),
    ).toBe(true);
  });

  it('refuses to restore over a branch recreated by another actor', () => {
    const branch = 'feat/recreate-race';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    commitFile(created.worktreePath, 'race3.txt', 'x', 'race commit 3');
    execFileSync('git', ['merge', '--no-edit', '-q', branch], { cwd: repo });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });
    const replacementOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      .toString()
      .trim();

    let recreated = false;
    const runner: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'update-ref' && args[1] === '-d') {
        const out = runProcess(bin, args, cwd);
        if (!recreated) {
          recreated = true;
          execFileSync('git', ['update-ref', `refs/heads/${branch}`, replacementOid], {
            cwd: repo,
          });
        }
        return out;
      }
      if (bin === 'git' && args[0] === 'worktree' && args[1] === 'list' && recreated) {
        return {
          status: 0,
          stdout: `worktree ${repo}\nHEAD ${'1'.repeat(40)}\n\nworktree ${created.worktreePath}\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/${branch}\n`,
          stderr: '',
          error: undefined,
        };
      }
      return runProcess(bin, args, cwd);
    };

    const refused = removeWorktree(repo, { branch }, runner);

    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('left untouched');
    const now = execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: repo })
      .toString()
      .trim();
    expect(now).toBe(replacementOid);
  });

  it('restores the ref when the post-deletion state cannot be verified', () => {
    const branch = 'feat/unverifiable-race';
    const created = createWorktree(repo, { branch, install: false, warmClaude: false });
    commitFile(created.worktreePath, 'race2.txt', 'x', 'race commit 2');
    execFileSync('git', ['merge', '--no-edit', '-q', branch], { cwd: repo });
    execFileSync('git', ['switch', '--detach', '-q'], { cwd: created.worktreePath });

    let sawDelete = false;
    const failingRunner: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'update-ref' && args[1] === '-d') sawDelete = true;
      if (bin === 'git' && args[0] === 'worktree' && args[1] === 'list' && sawDelete) {
        return { status: 1, stdout: '', stderr: 'inspection failed', error: undefined };
      }
      return runProcess(bin, args, cwd);
    };

    const refused = removeWorktree(repo, { branch }, failingRunner);

    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('could not verify post-deletion state');
    expect(branchExists(branch)).toBe(true);
  });

  it('removes a multi-commit squash-merged branch with a tree-equivalent proof', () => {
    const created = createWorktree(repo, {
      branch: 'feat/squashed',
      install: false,
      warmClaude: false,
    });
    commitFile(created.worktreePath, 'one.txt', 'one', 'feature one');
    commitFile(created.worktreePath, 'two.txt', 'two', 'feature two');

    execFileSync('git', ['merge', '--squash', 'feat/squashed'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'squash feature'],
      { cwd: repo },
    );
    const exactSquashOid = gitOid();
    expect(gitOid('feat/squashed^{tree}')).toBe(gitOid(`${exactSquashOid}^{tree}`));

    const removed = removeWorktree(repo, {
      branch: 'feat/squashed',
      mergedInto: exactSquashOid,
    });

    expect(removed.ok).toBe(true);
    expect(removed.removalProof).toBe('tree-equivalent');
    expect(removed.resolvedTargetOid).toBe(exactSquashOid);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(branchExists('feat/squashed')).toBe(false);
  });

  it('uses an explicit ancestry proof when the source checkout HEAD is stale', () => {
    const created = createWorktree(repo, {
      branch: 'feat/stale-source',
      install: false,
      warmClaude: false,
    });
    commitFile(created.worktreePath, 'feature.txt', 'merged elsewhere', 'feature work');

    execFileSync('git', ['switch', '-qc', 'integration'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'merge',
        '--no-ff',
        '-qm',
        'merge feature',
        'feat/stale-source',
      ],
      { cwd: repo },
    );
    const targetOid = gitOid();
    execFileSync('git', ['switch', '-q', 'main'], { cwd: repo });

    const removed = removeWorktree(repo, {
      branch: 'feat/stale-source',
      mergedInto: targetOid,
    });

    expect(removed.ok).toBe(true);
    expect(removed.removalProof).toBe('ancestry');
    expect(removed.resolvedTargetOid).toBe(targetOid);
    expect(branchExists('feat/stale-source')).toBe(false);
  });

  it('a mismatched target refuses without touching worktree, branch, or seeded state', () => {
    const claudeJson = path.join(tmp, 'mismatch-claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    const created = createWorktree(repo, {
      branch: 'feat/mismatch',
      install: false,
      claudeJsonPath: claudeJson,
    });
    commitFile(created.worktreePath, 'feature.txt', 'unmerged', 'unmerged feature');
    const stateBefore = fs.readFileSync(claudeJson, 'utf8');

    const refused = removeWorktree(repo, {
      branch: 'feat/mismatch',
      mergedInto: 'main',
      claudeJsonPath: claudeJson,
    });

    expect(refused.ok).toBe(false);
    expect(refused.removalProof).toBeUndefined();
    expect(refused.stages).toHaveLength(1);
    expect(refused.stages[0]!.detail).toContain('neither an ancestor nor tree-equivalent');
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists('feat/mismatch')).toBe(true);
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe(stateBefore);
  });

  it('accepts the exact squash commit after an advanced main ref conservatively refuses', () => {
    const created = createWorktree(repo, {
      branch: 'feat/exact-squash',
      install: false,
      warmClaude: false,
    });
    commitFile(created.worktreePath, 'feature.txt', 'feature', 'feature');
    execFileSync('git', ['merge', '--squash', 'feat/exact-squash'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'squash feature'],
      { cwd: repo },
    );
    const exactSquashOid = gitOid();
    commitFile(repo, 'later.txt', 'later mainline work', 'later mainline work');

    const advancedRef = removeWorktree(repo, {
      branch: 'feat/exact-squash',
      mergedInto: 'main',
    });
    expect(advancedRef.ok).toBe(false);
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    expect(branchExists('feat/exact-squash')).toBe(true);

    const exact = removeWorktree(repo, {
      branch: 'feat/exact-squash',
      mergedInto: exactSquashOid,
    });
    expect(exact.ok).toBe(true);
    expect(exact.removalProof).toBe('tree-equivalent');
    expect(exact.resolvedTargetOid).toBe(exactSquashOid);
  });

  it('reports a resolved target with not-needed proof for already-absent state', () => {
    const targetOid = gitOid();
    const result = removeWorktree(repo, {
      branch: 'feat/absent-with-target',
      mergedInto: 'HEAD',
    });

    expect(result.ok).toBe(true);
    expect(result.removalProof).toBe('not-needed');
    expect(result.resolvedTargetOid).toBe(targetOid);
  });

  it('rejects invalid branch names before touching anything', () => {
    expect(() => removeWorktree(repo, { branch: '../evil' })).toThrow(/traversal|not a valid/);
  });
});
