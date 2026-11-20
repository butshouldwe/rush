import { describe, expect, it } from 'vitest';
import {
  checkAncestor,
  resolveCommitOid,
  resolveTreeOid,
  validateBranchName,
  worktreePathFor,
} from './gitWorktree.js';

describe('resolveCommitOid', () => {
  it('peels the requested ref to one full commit OID with options terminated', () => {
    const oid = '0123456789abcdef0123456789abcdef01234567';
    const calls: string[][] = [];
    const result = resolveCommitOid('/repo', 'origin/main', (_bin, args) => {
      calls.push(args);
      return { status: 0, stdout: `${oid}\n`, stderr: '' };
    });

    expect(result).toEqual({ ok: true, oid });
    expect(calls).toEqual([['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}']]);
  });

  it('rejects an ambiguous result even when git exits successfully with an OID', () => {
    const result = resolveCommitOid('/repo', 'collision', () => ({
      status: 0,
      stdout: '0123456789abcdef0123456789abcdef01234567\n',
      stderr: "warning: refname 'collision' is ambiguous.\n",
    }));

    expect(result.ok).toBe(false);
  });
});

describe('removal proof adapters', () => {
  it('checks ancestry using only full commit OIDs', () => {
    const calls: string[][] = [];
    const result = checkAncestor('/repo', 'a'.repeat(40), 'b'.repeat(40), (_bin, args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    });

    expect(result).toEqual({ ok: true, isAncestor: true });
    expect(calls).toEqual([['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)]]);
  });

  it('distinguishes a safe ancestry miss from a Git runtime failure', () => {
    expect(
      checkAncestor('/repo', 'a'.repeat(40), 'b'.repeat(40), () => ({
        status: 1,
        stdout: '',
        stderr: '',
      })),
    ).toEqual({ ok: true, isAncestor: false });
    expect(
      checkAncestor('/repo', 'a'.repeat(40), 'b'.repeat(40), () => ({
        status: 128,
        stdout: '',
        stderr: 'fatal: broken repository',
      })),
    ).toEqual({ ok: false, detail: 'fatal: broken repository' });
  });

  it('resolves a validated commit OID to one full tree OID', () => {
    const treeOid = 'c'.repeat(40);
    const calls: string[][] = [];
    const result = resolveTreeOid('/repo', 'a'.repeat(40), (_bin, args) => {
      calls.push(args);
      return { status: 0, stdout: `${treeOid}\n`, stderr: '' };
    });

    expect(result).toEqual({ ok: true, oid: treeOid });
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--end-of-options', `${'a'.repeat(40)}^{tree}`],
    ]);
  });
});

describe('worktreePathFor', () => {
  it('derives the family convention path: <parent>/.worktrees/<repo>/<branch>', () => {
    expect(worktreePathFor('/workspace/rush', 'feat/x')).toBe('/workspace/.worktrees/rush/feat/x');
    expect(worktreePathFor('/home/dev/proj', 'main-2')).toBe('/home/dev/.worktrees/proj/main-2');
  });
});

describe('validateBranchName', () => {
  it.each([
    'feat/worktree-rush',
    'fix/security-deps',
    'a',
    'release/1.2.3',
    'feat/x',
    'release-1.2',
  ])('accepts %s', (name) => {
    expect(() => validateBranchName(name)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['/abs', 'absolute'],
    ['../escape', 'traversal'],
    ['a/../b', 'traversal'],
    ['a//b', 'empty segment'],
    ['has space', 'space'],
    ['x..y', 'double dot'],
    ['x.lock', 'lock suffix'],
    ['-flag', 'leading dash'],
    ['x~1', 'tilde'],
    // Finding #14: per-segment .lock / leading-or-trailing-dot / control-char
    // cases the whole-string checks missed.
    ['foo.lock/bar', 'per-segment .lock suffix'],
    ['foo./bar', 'per-segment trailing dot'],
    ['.hidden/bar', 'per-segment leading dot'],
    ['x\x01y', 'ASCII control character'],
  ])('rejects %s (%s)', (name) => {
    expect(() => validateBranchName(name)).toThrow();
  });
});

// mainRootOf lives in rushRepo but its failure mode is worktree-path nesting,
// so the regression test sits with the path derivation tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepoRoot, mainRootOf } from './rushRepo.js';

describe('findRepoRoot from inside a linked worktree', () => {
  it('resolves to the MAIN checkout so paths and state derive correctly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainroot-'));
    try {
      const main = path.join(tmp, 'repo');
      fs.mkdirSync(main);
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
      fs.writeFileSync(path.join(main, 'a.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: main });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], {
        cwd: main,
      });
      const wt = path.join(tmp, '.worktrees', 'repo', 'feat', 'x');
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      execFileSync('git', ['worktree', 'add', wt, '-b', 'feat/x'], { cwd: main });

      expect(mainRootOf(wt)).toBe(main);
      expect(mainRootOf(main)).toBe(main);
      const fromInside = findRepoRoot(path.join(wt));
      expect(fromInside.root).toBe(main);
      // deriving from inside a worktree must NOT nest .worktrees
      expect(worktreePathFor(fromInside.root, 'feat/y')).toBe(
        path.join(tmp, '.worktrees', 'repo', 'feat/y'),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
