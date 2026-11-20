import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./stages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stages.js')>();
  return {
    ...actual,
    runProcess: vi.fn(() => {
      throw new Error('refused selector reached the process runner');
    }),
  };
});

import { cliMain } from './cliMain.js';
import { runProcess } from './stages.js';

const runner = vi.mocked(runProcess);

function sink(): { stream: Writable; text: () => string } {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString();
        cb();
      },
    }),
    text: () => text,
  };
}

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-to-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'rush.json'), '{}');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], {
    cwd: repo,
  });
  runner.mockReset();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]): { status: number; stderr: string } {
  const out = sink();
  const err = sink();
  const status = cliMain(['create', ...args, '--from', repo], out.stream, err.stream);
  return { status, stderr: err.text() };
}

// Failure prevented (ADR-067 amendment 1, R2): an unchecked `--to` value
// reached `rush install --to <value>`, and on the Windows shell-mode spawn
// path it reached cmd.exe — so a crafted selector could inject commands or
// expand %VAR%. Invalid selectors must exit 2 before any process runs.
const INVALID: Array<[string, string]> = [
  ['empty', ''],
  ['space', 'a b'],
  ['double quote', 'a"b'],
  ['single quote', "a'b"],
  ['ampersand', 'a&b'],
  ['pipe', 'a|b'],
  ['less-than', 'a<b'],
  ['greater-than', 'a>b'],
  ['caret', 'a^b'],
  ['percent', 'a%PATH%'],
  ['bang', 'a!b'],
  ['open paren', 'a(b'],
  ['close paren', 'a)b'],
  ['semicolon', 'a;b'],
  ['comma', 'a,b'],
  ['backtick', 'a`b'],
  ['dollar-paren', 'a$(b)'],
  ['newline', 'a\nb'],
  ['trailing newline', 'ab\n'],
  ['leading dash', '-abc'],
  ['uppercase', 'MyApp'],
  ['forward slash (unscoped)', 'a/b'],
  ['backslash', 'a\\b'],
  ['extra slash in scope', '@s/a/b'],
  ['scope without name', '@s/'],
  ['bare scope', '@s'],
  ['leading dot', '.abc'],
  ['length 215', 'a'.repeat(215)],
];

describe('--to selector validation (ADR-067 amendment 1, R2)', () => {
  it.each(INVALID)('rejects %s with exit 2 before any process runs', (_label, value) => {
    const { status, stderr } = run(['--branch', 'feat/x', '--to', value]);
    expect(status).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(stderr).toContain('--to');
    expect(fs.existsSync(path.join(tmp, '.worktrees'))).toBe(false);
  });

  it('refuses an invalid selector even with --help', () => {
    expect(run(['--to=a&b', '--help']).status).toBe(2);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects a leading dash in the attached value, not only in a separate argument', () => {
    expect(run(['--branch', 'feat/x', '--to=-abc']).status).toBe(2);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects when only the second repeated --to is invalid', () => {
    const { status } = run(['--branch', 'feat/x', '--to', '@my/app', '--to', 'bad name']);
    expect(status).toBe(2);
    expect(runner).not.toHaveBeenCalled();
  });

  it('diagnostic quotes only the invalid value', () => {
    const { stderr } = run(['--branch', 'feat/x', '--to', '@my/app', '--to', 'a b']);
    expect(stderr).toContain('"a b"');
    expect(stderr).not.toContain('@my/app');
  });

  it.each([['@my/app'], ['web'], ['a.b_c-d'], ['@x/web'], ['a'.repeat(214)]])(
    'accepts %s and passes it to the real downstream runner',
    (name) => {
      runner.mockImplementation((bin, args, cwd) =>
        bin === 'git' ? realGit(bin, args, cwd) : { status: 0, stdout: '', stderr: '' },
      );
      const { status } = run([
        '--branch',
        'feat/ok',
        '--to',
        name,
        '--no-share-store',
        '--no-warm-claude',
      ]);
      expect(status).toBe(0);
      const rush = runner.mock.calls.find(([bin]) => bin === 'rush');
      expect(rush?.[1]).toEqual(['install', '--bypass-policy', '--to', name]);
    },
  );

  it('passes repeated selectors in order', () => {
    runner.mockImplementation((bin, args, cwd) =>
      bin === 'git' ? realGit(bin, args, cwd) : { status: 0, stdout: '', stderr: '' },
    );
    const { status } = run([
      '--branch',
      'feat/two',
      '--to',
      '@x/web',
      '--to',
      '@x/api',
      '--no-share-store',
      '--no-warm-claude',
    ]);
    expect(status).toBe(0);
    const rush = runner.mock.calls.find(([bin]) => bin === 'rush');
    expect(rush?.[1]).toEqual(['install', '--bypass-policy', '--to', '@x/web', '--to', '@x/api']);
  });
});

function realGit(bin: string, args: string[], cwd: string) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}
