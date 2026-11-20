import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, formatReport, type ProcessRunner } from './worktree.js';

/** Real-git passthrough for injected runners that must not throw on the
 * orchestrator's probe calls (`rev-parse --verify --quiet` exits nonzero by
 * design when the ref is absent — that's an answer, not an error). */
function gitPassthrough(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const r = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { status: 0, stdout: r, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown; stderr?: unknown };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

function gitOid(ref: string, cwd: string = repo): string {
  return execFileSync('git', ['rev-parse', '--verify', ref], { cwd, encoding: 'utf8' }).trim();
}

function commitFile(name: string, contents: string, message: string): string {
  fs.writeFileSync(path.join(repo, name), contents);
  execFileSync('git', ['add', name], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message], {
    cwd: repo,
  });
  return gitOid('HEAD');
}

let tmp: string;
let repo: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-create-'));
  repo = path.join(tmp, 'myrepo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'rush.json'), '{"projects": []}');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: repo,
  });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('createWorktree (real git, no install)', () => {
  it('defaults a new branch to the source checkout current HEAD', () => {
    const sourceHead = commitFile('source.txt', 'source head', 'source head');
    const result = createWorktree(repo, {
      branch: 'feat/default-head',
      install: false,
      warmClaude: false,
    });

    expect(result.ok).toBe(true);
    expect(gitOid('refs/heads/feat/default-head')).toBe(sourceHead);
    expect(gitOid('HEAD', repo)).toBe(sourceHead);
  });

  it('creates a missing branch from origin/main while the source stays on an unrelated branch', () => {
    const originMain = gitOid('HEAD');
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', originMain], { cwd: repo });
    execFileSync('git', ['switch', '-qc', 'unrelated'], { cwd: repo });
    const unrelatedHead = commitFile('unrelated.txt', 'unrelated', 'unrelated');

    const result = createWorktree(repo, {
      branch: 'feat/from-origin',
      startPoint: 'origin/main',
      install: false,
      warmClaude: false,
    });

    expect(result.ok).toBe(true);
    expect(gitOid('refs/heads/feat/from-origin')).toBe(originMain);
    expect(gitOid('HEAD', repo)).toBe(unrelatedHead);
    expect(result.stages[0]!.detail).toContain(originMain);
  });

  it('rejects an absent start point before creating a branch or directory', () => {
    const worktreePath = path.join(tmp, '.worktrees', 'myrepo', 'feat/missing-ref');

    expect(() =>
      createWorktree(repo, {
        branch: 'feat/missing-ref',
        startPoint: 'does-not-exist',
        install: false,
        warmClaude: false,
      }),
    ).toThrow(/start point.*does-not-exist/i);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      execFileSync('git', ['branch', '--list', 'feat/missing-ref'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
  });

  it('rejects a non-commit object before creating a branch or directory', () => {
    fs.writeFileSync(path.join(repo, 'blob.txt'), 'not a commit');
    const blob = execFileSync('git', ['hash-object', '-w', 'blob.txt'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const worktreePath = path.join(tmp, '.worktrees', 'myrepo', 'feat/from-blob');

    expect(() =>
      createWorktree(repo, {
        branch: 'feat/from-blob',
        startPoint: blob,
        install: false,
        warmClaude: false,
      }),
    ).toThrow(/does not resolve to one unambiguous commit/i);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      execFileSync('git', ['branch', '--list', 'feat/from-blob'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
  });

  it('does not move an existing branch when a different start point is supplied', () => {
    const existingOid = gitOid('HEAD');
    execFileSync('git', ['branch', 'feat/existing-start', existingOid], { cwd: repo });
    const sourceHead = commitFile('later.txt', 'later', 'later');

    const result = createWorktree(repo, {
      branch: 'feat/existing-start',
      startPoint: sourceHead,
      install: false,
      warmClaude: false,
    });

    expect(result.ok).toBe(true);
    expect(gitOid('refs/heads/feat/existing-start')).toBe(existingOid);
    expect(result.stages[0]!.detail).toContain('creation-only');
    expect(result.stages[0]!.detail).toContain('not reapplied');
  });

  it('validates a supplied start point before converging an existing branch', () => {
    const existingOid = gitOid('HEAD');
    execFileSync('git', ['branch', 'feat/existing-invalid-start', existingOid], { cwd: repo });

    expect(() =>
      createWorktree(repo, {
        branch: 'feat/existing-invalid-start',
        startPoint: 'missing-ref',
        install: false,
        warmClaude: false,
      }),
    ).toThrow(/does not resolve to one unambiguous commit/i);
    expect(gitOid('refs/heads/feat/existing-invalid-start')).toBe(existingOid);
    expect(
      fs.existsSync(path.join(tmp, '.worktrees', 'myrepo', 'feat/existing-invalid-start')),
    ).toBe(false);
  });

  it('converges an existing same-branch worktree without resetting it', () => {
    const first = createWorktree(repo, {
      branch: 'feat/converged-start',
      install: false,
      warmClaude: false,
    });
    expect(first.ok).toBe(true);
    const worktreeHead = gitOid('HEAD', first.worktreePath);
    const laterSourceHead = commitFile('after-worktree.txt', 'later', 'later source head');

    const second = createWorktree(repo, {
      branch: 'feat/converged-start',
      startPoint: laterSourceHead,
      install: false,
      warmClaude: false,
    });

    expect(second.ok).toBe(true);
    expect(second.converged).toBe(true);
    expect(gitOid('HEAD', second.worktreePath)).toBe(worktreeHead);
    expect(second.stages[0]!.detail).toContain('creation-only');
    expect(second.stages[0]!.detail).toContain('not reapplied');
  });

  it('creates the worktree at the convention path with per-stage timings', () => {
    const result = createWorktree(repo, { branch: 'feat/x', install: false, warmClaude: false });
    expect(result.ok).toBe(true);
    expect(result.worktreePath).toBe(path.join(tmp, '.worktrees', 'myrepo', 'feat/x'));
    expect(fs.existsSync(path.join(result.worktreePath, 'rush.json'))).toBe(true);
    expect(result.stages.map((s) => s.name)).toEqual(['git-worktree-add']);
    expect(result.stages[0]!.ms).toBeGreaterThan(0);
    const report = formatReport(result);
    expect(report).toContain('✓ worktree feat/x');
    expect(report).toMatch(/git-worktree-add\s+\d+ms/);
  });

  it('bootstraps claude state against an injected claude.json', () => {
    const claudeJson = path.join(tmp, 'claude.json');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.local.json'),
      '{"permissions":{"allow":["Bash(x)"]}}',
    );
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: { [repo]: { hasTrustDialogAccepted: true, allowedTools: ['Read'] } },
      }),
    );
    const result = createWorktree(repo, {
      branch: 'feat/y',
      install: false,
      claudeJsonPath: claudeJson,
    });
    expect(result.ok).toBe(true);
    expect(result.claudeSeed?.action).toBe('seeded');
    expect(result.settingsCopy?.action).toBe('copied');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[result.worktreePath].hasTrustDialogAccepted).toBe(true);
    expect(fs.existsSync(path.join(result.worktreePath, '.claude', 'settings.local.json'))).toBe(
      true,
    );
  });

  it('converges when the same-branch worktree already exists (re-run is the recovery story)', () => {
    const first = createWorktree(repo, { branch: 'feat/dup', install: false, warmClaude: false });
    expect(first.ok).toBe(true);
    expect(first.converged).toBe(false);
    const second = createWorktree(repo, { branch: 'feat/dup', install: false, warmClaude: false });
    expect(second.ok).toBe(true);
    expect(second.converged).toBe(true);
    expect(second.stages[0]!.detail).toContain('converging');
    expect(formatReport(second)).toContain('✓ converged feat/dup');
  });

  it('a converge re-run completes a bootstrap the first run skipped', () => {
    // First run: no claude bootstrap (simulates a run that died before it).
    const first = createWorktree(repo, { branch: 'feat/heal', install: false, warmClaude: false });
    expect(first.ok).toBe(true);
    // Second run: same branch, bootstrap enabled — must seed into the
    // EXISTING worktree rather than refusing.
    const claudeJson = path.join(tmp, 'heal-claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    const second = createWorktree(repo, {
      branch: 'feat/heal',
      install: false,
      claudeJsonPath: claudeJson,
    });
    expect(second.ok).toBe(true);
    expect(second.converged).toBe(true);
    expect(second.claudeSeed?.action).toBe('seeded');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[second.worktreePath].hasTrustDialogAccepted).toBe(true);
  });

  it('rejects a forged-pointer candidate before copying any agent state', () => {
    const branch = 'feat/forged-registration';
    const registeredElsewhere = path.join(tmp, 'registered-elsewhere');
    execFileSync('git', ['worktree', 'add', registeredElsewhere, '-b', branch], { cwd: repo });

    const worktreePath = path.join(tmp, '.worktrees', 'myrepo', branch);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.copyFileSync(path.join(registeredElsewhere, '.git'), path.join(worktreePath, '.git'));

    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"permissions":{}}');
    const claudeJson = path.join(tmp, 'forged-claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    let gitCalls = 0;
    const exec: ProcessRunner = () => {
      gitCalls += 1;
      return { status: 0, stdout: `${branch}\n`, stderr: '' };
    };

    const result = createWorktree(
      repo,
      { branch, install: false, claudeJsonPath: claudeJson },
      exec,
    );

    expect(result.ok).toBe(false);
    expect(result.stages.map((stage) => stage.name)).toEqual(['git-worktree-add']);
    expect(gitCalls).toBe(0);
    expect(fs.existsSync(path.join(worktreePath, '.claude'))).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[worktreePath]).toBeUndefined();
  });

  it('hard-fails when the path holds a DIFFERENT branch', () => {
    const first = createWorktree(repo, { branch: 'feat/one', install: false, warmClaude: false });
    expect(first.ok).toBe(true);
    // Move the worktree dir to where a different branch's worktree would live.
    const otherPath = path.join(tmp, '.worktrees', 'myrepo', 'feat/two');
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    execFileSync('git', ['worktree', 'move', first.worktreePath, otherPath], { cwd: repo });
    const second = createWorktree(repo, { branch: 'feat/two', install: false, warmClaude: false });
    expect(second.ok).toBe(false);
    expect(second.stages[0]!.detail).toContain('holds branch "feat/one"');
  });

  it('hard-fails when the path exists but is not a git worktree', () => {
    const junk = path.join(tmp, '.worktrees', 'myrepo', 'feat/junk');
    fs.mkdirSync(junk, { recursive: true });
    fs.writeFileSync(path.join(junk, 'stray.txt'), 'not a worktree');
    const result = createWorktree(repo, { branch: 'feat/junk', install: false, warmClaude: false });
    expect(result.ok).toBe(false);
    expect(result.stages[0]!.detail).toContain('not a git worktree');
  });

  it('checks out an existing branch (no -b) when the branch survives a removed worktree', () => {
    const first = createWorktree(repo, {
      branch: 'feat/orphan',
      install: false,
      warmClaude: false,
    });
    expect(first.ok).toBe(true);
    execFileSync('git', ['worktree', 'remove', first.worktreePath], { cwd: repo });
    // branch feat/orphan still exists; a -b add would fail — converge extends
    // to the branch, not just the directory.
    const second = createWorktree(repo, {
      branch: 'feat/orphan',
      install: false,
      warmClaude: false,
    });
    expect(second.ok).toBe(true);
    expect(second.converged).toBe(false); // fresh directory, existing branch
    expect(fs.existsSync(path.join(second.worktreePath, 'rush.json'))).toBe(true);
  });

  it('rejects traversal branch names before touching the filesystem', () => {
    expect(() => createWorktree(repo, { branch: '../evil', install: false })).toThrow(
      /traversal|not a valid/,
    );
  });
});

describe('createWorktree (injected runner for the install stage)', () => {
  it('links store+cache then runs install-run-rush.js when present', () => {
    const calls: Array<{ bin: string; args: string[]; cwd: string }> = [];
    const exec: ProcessRunner = (bin, args, cwd) => {
      calls.push({ bin, args, cwd });
      if (bin === 'git') return gitPassthrough(args, cwd); // real git still runs
      return { status: 0, stdout: '', stderr: '' };
    };
    // pre-seed the source's store/cache dirs and the worktree's install-run-rush
    fs.mkdirSync(path.join(repo, 'common', 'temp', 'pnpm-store'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'common', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'common', 'scripts', 'install-run-rush.js'), '// stub');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'scripts'], {
      cwd: repo,
    });

    const result = createWorktree(repo, { branch: 'feat/install', warmClaude: false }, exec);
    expect(result.ok).toBe(true);
    expect(result.stages.map((s) => s.name)).toEqual([
      'git-worktree-add',
      'share-store-and-cache',
      'rush-install',
    ]);

    // store + cache are symlinked into the worktree, pointing at the source
    for (const rel of ['pnpm-store', 'build-cache']) {
      const link = path.join(result.worktreePath, 'common', 'temp', rel);
      expect(fs.lstatSync(link).isSymbolicLink(), rel).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(repo, 'common', 'temp', rel)));
    }

    const install = calls.find((c) => c.bin === 'node');
    expect(install?.args[0]).toContain('install-run-rush.js');
    expect(install?.args).toContain('install');
    expect(install?.cwd).toBe(result.worktreePath);
  });

  it('an install failure fails the run and surfaces the tail of the output', () => {
    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 1, stdout: 'line1\nline2\nERROR: store server unreachable', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/fail', warmClaude: false, shareStore: false },
      exec,
    );
    expect(result.ok).toBe(false);
    const install = result.stages.find((s) => s.name === 'rush-install');
    expect(install?.ok).toBe(false);
    expect(install?.detail).toContain('store server unreachable');
  });

  it('falls back to `rush install` (not install-run-rush.js) when the worktree has no install-run-rush.js', () => {
    // The install stage prefers common/scripts/install-run-rush.js when the
    // worktree checkout has it; this repo never tracks that file, so the
    // fallback branch (worktree.ts:131, exec('rush', ...)) must run instead.
    const calls: Array<{ bin: string; args: string[]; cwd: string }> = [];
    const exec: ProcessRunner = (bin, args, cwd) => {
      calls.push({ bin, args, cwd });
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/rushfallback', warmClaude: false, shareStore: false },
      exec,
    );
    expect(result.ok).toBe(true);
    const rushCall = calls.find((c) => c.bin === 'rush');
    expect(rushCall).toBeDefined();
    expect(rushCall?.args).toEqual(['install', '--bypass-policy']);
    expect(rushCall?.cwd).toBe(result.worktreePath);
    // and install-run-rush.js (the node fallback) was never invoked
    expect(calls.some((c) => c.bin === 'node')).toBe(false);
  });
});

describe('createWorktree (git-worktree-add failure branches, injected runner)', () => {
  it('a nonzero git exit fails the stage with the stderr tail (not a thrown exception)', () => {
    const exec: ProcessRunner = (bin, args) => {
      // Only the `worktree add` call fails — the orchestrator's probe calls
      // (prune, rev-parse) answer normally, as they would in real life.
      if (bin === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return {
          status: 1,
          stdout: '',
          stderr: "fatal: a branch named 'feat/gitfail' already exists",
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/gitfail', install: false, warmClaude: false },
      exec,
    );
    expect(result.ok).toBe(false);
    const stage = result.stages.find((s) => s.name === 'git-worktree-add');
    expect(stage?.ok).toBe(false);
    expect(stage?.detail).toContain("fatal: a branch named 'feat/gitfail' already exists");
    // the run never reaches later stages
    expect(result.stages).toHaveLength(1);
  });

  it('a spawn error (e.g. ENOENT — git not on PATH) fails the stage with the error message', () => {
    const exec: ProcessRunner = (bin, args) => {
      if (bin === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: null, stdout: '', stderr: '', error: new Error('spawn git ENOENT') };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/gitspawnfail', install: false, warmClaude: false },
      exec,
    );
    expect(result.ok).toBe(false);
    const stage = result.stages.find((s) => s.name === 'git-worktree-add');
    expect(stage?.ok).toBe(false);
    expect(stage?.detail).toBe('spawn git ENOENT');
  });
});

describe('createWorktree (share-store-and-cache "already linked", injected runner)', () => {
  it('reports pre-existing real content truthfully as NOT shared (and does not clobber it)', () => {
    // common/temp/{pnpm-store,build-cache} are normally untracked (created
    // lazily and symlinked). If a fresh worktree checkout already has REAL
    // content at those paths — e.g. carried over via tracked content, as
    // simulated here — share-store-and-cache must not clobber it, and must
    // not lie about sharing: the detail says NOT shared (installs run cold).
    fs.mkdirSync(path.join(repo, 'common', 'temp', 'pnpm-store'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'common', 'temp', 'build-cache'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'common', 'temp', 'pnpm-store', '.gitkeep'), '');
    fs.writeFileSync(path.join(repo, 'common', 'temp', 'build-cache', '.gitkeep'), '');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed shared-state dirs'],
      { cwd: repo },
    );

    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = createWorktree(repo, { branch: 'feat/prelinked', warmClaude: false }, exec);
    expect(result.ok).toBe(true);
    const shareStage = result.stages.find((s) => s.name === 'share-store-and-cache');
    expect(shareStage?.ok).toBe(true);
    expect(shareStage?.detail).toContain('pre-existing content, NOT shared');
    // the tracked content survives untouched
    expect(
      fs.existsSync(path.join(result.worktreePath, 'common', 'temp', 'pnpm-store', '.gitkeep')),
    ).toBe(true);
  });

  it('reports "already linked" on a converge re-run whose links are healthy', () => {
    fs.mkdirSync(path.join(repo, 'common', 'temp', 'pnpm-store'), { recursive: true });
    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const first = createWorktree(repo, { branch: 'feat/relink', warmClaude: false }, exec);
    expect(first.ok).toBe(true);
    const second = createWorktree(repo, { branch: 'feat/relink', warmClaude: false }, exec);
    expect(second.ok).toBe(true);
    expect(second.converged).toBe(true);
    const shareStage = second.stages.find((s) => s.name === 'share-store-and-cache');
    expect(shareStage?.detail).toBe('already linked');
  });

  it('repairs a dangling store link instead of failing on EEXIST', () => {
    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const first = createWorktree(repo, { branch: 'feat/dangle', warmClaude: false }, exec);
    expect(first.ok).toBe(true);
    // Break the link: point it at a path that no longer exists.
    const link = path.join(first.worktreePath, 'common', 'temp', 'pnpm-store');
    fs.rmSync(link);
    fs.symlinkSync(path.join(tmp, 'gone-away'), link, 'dir');
    const second = createWorktree(repo, { branch: 'feat/dangle', warmClaude: false }, exec);
    expect(second.ok).toBe(true);
    const shareStage = second.stages.find((s) => s.name === 'share-store-and-cache');
    expect(shareStage?.detail).toContain('linked');
    expect(fs.realpathSync(link)).toBe(
      fs.realpathSync(path.join(repo, 'common', 'temp', 'pnpm-store')),
    );
  });

  it('downgrades a symlink failure to a warning instead of failing the run', () => {
    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      const result = createWorktree(repo, { branch: 'feat/noshare', warmClaude: false }, exec);
      expect(result.ok).toBe(true); // sharing is an optimization, never a gate
      const shareStage = result.stages.find((s) => s.name === 'share-store-and-cache');
      expect(shareStage?.ok).toBe(true);
      expect(shareStage?.detail).toContain('sharing unavailable');
      expect(shareStage?.detail).toContain('installs will run cold');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createWorktree (hardening semantics, injected runner)', () => {
  it('passes the resolved full OID, never the user ref, to new-branch creation', () => {
    const originMain = gitOid('HEAD');
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', originMain], { cwd: repo });
    const calls: Array<{ bin: string; args: string[] }> = [];
    const exec: ProcessRunner = (bin, args, cwd) => {
      calls.push({ bin, args });
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = createWorktree(
      repo,
      {
        branch: 'feat/full-oid',
        startPoint: 'origin/main',
        install: false,
        warmClaude: false,
      },
      exec,
    );

    expect(result.ok).toBe(true);
    const add = calls.find(
      (call) => call.bin === 'git' && call.args[0] === 'worktree' && call.args[1] === 'add',
    );
    expect(add?.args.at(-1)).toBe(originMain);
    expect(add?.args).not.toContain('origin/main');
  });

  it('runs claude-bootstrap BEFORE install, so a failed install never strands agent state', () => {
    const claudeJson = path.join(tmp, 'order-claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 1, stdout: 'ERR_PNPM_META_FETCH_FAIL registry unreachable', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/order', shareStore: false, claudeJsonPath: claudeJson },
      exec,
    );
    expect(result.ok).toBe(false); // install did fail
    expect(result.stages.map((s) => s.name)).toEqual([
      'git-worktree-add',
      'claude-bootstrap',
      'rush-install',
    ]);
    // ...but the agent state landed anyway: a session can start and diagnose.
    expect(result.claudeSeed?.action).toBe('seeded');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[result.worktreePath].hasTrustDialogAccepted).toBe(true);
  });

  it('forwards --to projects to rush install as repeatable filters', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const exec: ProcessRunner = (bin, args, cwd) => {
      calls.push({ bin, args });
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/filtered', warmClaude: false, shareStore: false, to: ['@x/web', '@x/api'] },
      exec,
    );
    expect(result.ok).toBe(true);
    const install = calls.find((c) => c.bin === 'rush');
    expect(install?.args).toEqual([
      'install',
      '--bypass-policy',
      '--to',
      '@x/web',
      '--to',
      '@x/api',
    ]);
    const stage = result.stages.find((s) => s.name === 'rush-install');
    expect(stage?.detail).toContain('filtered: @x/web, @x/api');
  });

  it('retries git worktree add on transient lock contention', () => {
    let attempts = 0;
    const exec: ProcessRunner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: 128,
            stdout: '',
            stderr: "fatal: Unable to create '/x/.git/packed-refs.lock': File exists.",
          };
        }
      }
      if (bin === 'git') return gitPassthrough(args, cwd);
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = createWorktree(
      repo,
      { branch: 'feat/locked', install: false, warmClaude: false },
      exec,
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2); // first hit contention, retry succeeded
  });

  it('normalizes a relative/trailing-slash --from instead of deriving .worktrees inside the repo', () => {
    const previousCwd = process.cwd();
    process.chdir(repo);
    try {
      const result = createWorktree(repo, {
        branch: 'feat/relfrom',
        from: '.',
        install: false,
        warmClaude: false,
      });
      expect(result.ok).toBe(true);
      expect(result.worktreePath).toBe(
        path.join(fs.realpathSync(tmp), '.worktrees', 'myrepo', 'feat/relfrom'),
      );
      expect(result.worktreePath.startsWith(fs.realpathSync(repo) + path.sep)).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('createWorktree (non-Rush git repo — most of the family)', () => {
  it('creates the worktree and bootstraps state, skipping Rush stages legibly', () => {
    const plain = path.join(tmp, 'plainrepo');
    fs.mkdirSync(plain);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: plain });
    fs.writeFileSync(path.join(plain, 'README.md'), 'no rush here');
    execFileSync('git', ['add', '-A'], { cwd: plain });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: plain,
    });

    const claudeJson = path.join(tmp, 'plain-claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [plain]: { hasTrustDialogAccepted: true } } }),
    );

    const result = createWorktree(plain, { branch: 'feat/plain', claudeJsonPath: claudeJson });
    expect(result.ok).toBe(true);
    const install = result.stages.find((s) => s.name === 'rush-install');
    expect(install?.ok).toBe(true);
    expect(install?.detail).toContain('not a Rush workspace');
    expect(result.stages.some((s) => s.name === 'share-store-and-cache')).toBe(false);
    expect(result.claudeSeed?.action).toBe('seeded');
  });
});

describe('createWorktree --from a linked worktree (P1: mainRootOf remap must apply)', () => {
  it('resolves through the main checkout instead of nesting .worktrees', () => {
    // Build main repo + a linked worktree of it; then create a NEW worktree
    // passing the linked worktree as --from (the CI/cross-repo usage). The
    // output path must derive from the MAIN checkout, not nest under the
    // linked worktree, and state must seed from main.
    const main = path.join(tmp, 'mainrepo');
    fs.mkdirSync(main);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
    fs.writeFileSync(path.join(main, 'rush.json'), '{"projects": []}');
    execFileSync('git', ['add', '-A'], { cwd: main });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: main,
    });
    const linked = path.join(tmp, '.worktrees', 'mainrepo', 'feat-a');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    execFileSync('git', ['worktree', 'add', linked, '-b', 'feat/a'], { cwd: main });

    const claudeJson = path.join(tmp, 'claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [main]: { hasTrustDialogAccepted: true } } }),
    );

    // Simulate the cli path: sourceRoot already resolved to main, but --from is raw linked.
    const result = createWorktree(main, {
      branch: 'feat/b',
      from: linked,
      install: false,
      claudeJsonPath: claudeJson,
    });
    expect(result.ok).toBe(true);
    // NOT nested: must be <tmp>/.worktrees/mainrepo/feat/b, never .../feat-a/.worktrees/...
    expect(result.worktreePath).toBe(path.join(tmp, '.worktrees', 'mainrepo', 'feat/b'));
    expect(result.worktreePath).not.toContain('feat-a');
    // state seeded from main (which has an entry), proving `from` remapped to main
    expect(result.claudeSeed?.action).toBe('seeded');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[result.worktreePath].hasTrustDialogAccepted).toBe(true);
  });
});
