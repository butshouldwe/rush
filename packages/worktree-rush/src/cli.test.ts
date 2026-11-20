import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliMain } from './cliMain.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(pkgDir, 'dist', 'cli.mjs');

/** Captures writes into a string instead of a real stream — lets tests drive
 * `cliMain` in-process, no dist build and no child process required. */
function captureWriter(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

function runCliInProcess(
  args: string[],
  cwd?: string,
): { status: number; stdout: string; stderr: string } {
  const stdout = captureWriter();
  const stderr = captureWriter();
  const previousCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const status = cliMain(args, stdout.stream, stderr.stream);
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (cwd) process.chdir(previousCwd);
  }
}

function initRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'rush.json'), '{}');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: repo,
  });
}

describe('cli contract (in-process, no build required)', () => {
  it('--help exits 0 and documents every flag', () => {
    const { status, stdout } = runCliInProcess(['--help']);
    expect(status).toBe(0);
    for (const flag of [
      '--branch',
      '--from',
      '--start-point',
      '--merged-into',
      '--no-install',
      '--no-share-store',
      '--no-warm-claude',
      '--json',
    ]) {
      expect(stdout).toContain(flag);
    }
  });

  it('missing branch exits 2 with usage', () => {
    const { status, stderr } = runCliInProcess(['create']);
    expect(status).toBe(2);
    expect(stderr).toContain('branch name is required');
  });

  it('unknown flags exit 2', () => {
    expect(runCliInProcess(['create', 'x', '--nope']).status).toBe(2);
  });

  it('--start-point takes exactly one non-empty value', () => {
    const missing = runCliInProcess(['create', 'x', '--start-point']);
    expect(missing.status).toBe(2);

    const empty = runCliInProcess(['create', 'x', '--start-point=']);
    expect(empty.status).toBe(2);

    const duplicate = runCliInProcess([
      'create',
      'x',
      '--start-point',
      'HEAD',
      '--start-point',
      'main',
    ]);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain('only once');
  });

  it('--merged-into takes one non-empty value and is remove-only', () => {
    expect(runCliInProcess(['remove', 'x', '--merged-into']).status).toBe(2);
    expect(runCliInProcess(['remove', 'x', '--merged-into=']).status).toBe(2);
    const duplicate = runCliInProcess([
      'remove',
      'x',
      '--merged-into',
      'HEAD',
      '--merged-into',
      'main',
    ]);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain('only once');
    const createOnly = runCliInProcess(['create', 'x', '--merged-into', 'HEAD']);
    expect(createOnly.status).toBe(2);
    expect(createOnly.stderr).toContain('valid only for remove');
  });

  it('--merged-into and --force are mutually exclusive', () => {
    const result = runCliInProcess(['remove', 'x', '--merged-into', 'HEAD', '--force']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('standalone and Rush help describe the same proof-bearing removal contract', () => {
    const { stdout } = runCliInProcess(['--help']);
    const commandLine = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'command-line.json'), 'utf8'),
    ) as {
      parameters: Array<{ longName: string; description: string }>;
    };
    const rushDescription = commandLine.parameters.find(
      (parameter) => parameter.longName === '--merged-into',
    )?.description;

    expect(stdout).toContain('prove ancestry or exact tree equivalence before removal');
    expect(rushDescription).toContain('prove ancestry or exact tree equivalence before removal');
  });

  it('standalone and Rush help describe the same creation-only start-point contract', () => {
    const { stdout } = runCliInProcess(['--help']);
    const commandLine = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'command-line.json'), 'utf8'),
    ) as {
      parameters: Array<{ longName: string; description: string }>;
    };
    const rushDescription = commandLine.parameters.find(
      (parameter) => parameter.longName === '--start-point',
    )?.description;

    expect(stdout).toContain('only when creating a new local branch');
    expect(rushDescription).toContain('only when creating a new local branch');
  });

  it('an invalid start point exits 2 without creating a branch or directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);

      const result = runCliInProcess(
        [
          'create',
          'feat/invalid-start',
          '--start-point',
          'missing-ref',
          '--no-install',
          '--no-warm-claude',
        ],
        repo,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('does not resolve to one unambiguous commit');
      expect(fs.existsSync(path.join(tmp, '.worktrees', 'demo', 'feat/invalid-start'))).toBe(false);
      expect(
        execFileSync('git', ['branch', '--list', 'feat/invalid-start'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim(),
      ).toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('creates a worktree end-to-end (positional form, no install, json report)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);

      const { status, stdout } = runCliInProcess(
        ['create', 'feat/cli', '--no-install', '--no-warm-claude', '--json'],
        repo,
      );
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as {
        ok: boolean;
        worktreePath: string;
        stages: Array<{ name: string }>;
      };
      expect(report.ok).toBe(true);
      expect(report.worktreePath).toBe(path.join(tmp, '.worktrees', 'demo', 'feat/cli'));
      expect(fs.existsSync(path.join(report.worktreePath, 'rush.json'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Finding #12: exit code 1 (a stage failed) was never asserted anywhere in
  // this package's tests. Converge-by-default means a duplicate create is
  // exit 0 now, so the stage-failure scenario is a path that exists but is
  // NOT a worktree — which must map to exit 1 (a stage failure), not exit 2
  // (usage).
  it('a stage failure exits 1, not 2', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);

      const junk = path.join(tmp, '.worktrees', 'demo', 'feat/dup');
      fs.mkdirSync(junk, { recursive: true });
      fs.writeFileSync(path.join(junk, 'stray.txt'), 'not a worktree');

      const result = runCliInProcess(
        ['create', 'feat/dup', '--no-install', '--no-warm-claude'],
        repo,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not a git worktree');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a duplicate create converges and exits 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);
      const first = runCliInProcess(
        ['create', 'feat/again', '--no-install', '--no-warm-claude'],
        repo,
      );
      expect(first.status).toBe(0);
      const second = runCliInProcess(
        ['create', 'feat/again', '--no-install', '--no-warm-claude'],
        repo,
      );
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('converged');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('remove is the symmetric inverse (worktree gone, branch gone, exit 0; re-run still 0)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);
      const created = runCliInProcess(
        ['create', 'feat/gone', '--no-install', '--no-warm-claude'],
        repo,
      );
      expect(created.status).toBe(0);
      const wt = path.join(tmp, '.worktrees', 'demo', 'feat/gone');
      expect(fs.existsSync(wt)).toBe(true);

      const removed = runCliInProcess(['remove', 'feat/gone'], repo);
      expect(removed.status).toBe(0);
      expect(fs.existsSync(wt)).toBe(false);
      const branches = execFileSync('git', ['branch', '--list', 'feat/gone'], {
        cwd: repo,
        encoding: 'utf8',
      });
      expect(branches.trim()).toBe('');

      // converge-flavored: removing what's already gone is success
      const again = runCliInProcess(['remove', 'feat/gone'], repo);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('already absent');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('invalid removal targets exit 2 without mutating worktree or branch', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);
      expect(
        runCliInProcess(['create', 'feat/keep', '--no-install', '--no-warm-claude'], repo).status,
      ).toBe(0);
      const worktreePath = path.join(tmp, '.worktrees', 'demo', 'feat/keep');

      const result = runCliInProcess(
        ['remove', 'feat/keep', '--merged-into', 'missing-target'],
        repo,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('merge target');
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(
        execFileSync('git', ['branch', '--list', 'feat/keep'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim(),
      ).not.toBe('');

      execFileSync('git', ['branch', 'collision'], { cwd: repo });
      execFileSync('git', ['tag', 'collision'], { cwd: repo });
      const ambiguous = runCliInProcess(
        ['remove', 'feat/keep', '--merged-into', 'collision'],
        repo,
      );
      expect(ambiguous.status).toBe(2);

      const blobOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        encoding: 'utf8',
        input: 'not a commit',
      }).trim();
      const nonCommit = runCliInProcess(['remove', 'feat/keep', '--merged-into', blobOid], repo);
      expect(nonCommit.status).toBe(2);

      const forceAndTarget = runCliInProcess(
        ['remove', 'feat/keep', '--merged-into', 'HEAD', '--force'],
        repo,
      );
      expect(forceAndTarget.status).toBe(2);
      expect(forceAndTarget.stderr).toContain('mutually exclusive');
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(
        execFileSync('git', ['branch', '--list', 'feat/keep'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim(),
      ).not.toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('JSON removal reports the proof and resolved target OID', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cli-'));
    try {
      const repo = path.join(tmp, 'demo');
      initRepo(repo);
      expect(
        runCliInProcess(['create', 'feat/proof', '--no-install', '--no-warm-claude'], repo).status,
      ).toBe(0);
      const targetOid = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();

      const result = runCliInProcess(
        ['remove', 'feat/proof', '--merged-into', 'HEAD', '--json'],
        repo,
      );
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        removalProof: string;
        resolvedTargetOid: string;
      };

      expect(result.status).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.removalProof).toBe('ancestry');
      expect(report.resolvedTargetOid).toBe(targetOid);
      expect(result.stdout).not.toContain('README.md');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('help documents the remove verb, --to, and --force', () => {
    const { status, stdout } = runCliInProcess(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('worktree-rush remove');
    expect(stdout).toContain('--to');
    expect(stdout).toContain('--force');
  });

  // One dist smoke per plugin, proving the built bin still works end to end.
  // Skips (rather than fails) when dist/ hasn't been built, so a build-free
  // `vitest run` still passes — see plan 004/005.
  describe.skipIf(!fs.existsSync(cliPath))('dist smoke', () => {
    function runCliDist(
      args: string[],
      cwd: string = pkgDir,
    ): { status: number | null; stdout: string; stderr: string } {
      const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }

    it('--help exits 0 via the built dist/cli.mjs', () => {
      const { status, stdout } = runCliDist(['--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('--no-share-store');
    });
  });
});
