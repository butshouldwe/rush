import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScopeConflictError,
  assertNoReportCollisions,
  monorepoMarkdown,
  projectFileBase,
  projectMarkdown,
  writeReports,
} from './report.js';
import { findingsFromCheck } from './rollup.js';
import type { FallowCheckSection, Finding, Rollup } from './types.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'unused-file',
    project: '@myco/web',
    path: 'apps/web/src/orphan.js',
    detail: 'file is never imported by any entry point',
    source: 'root-pass',
    ...overrides,
  };
}

function rollupWith(
  projects: Array<{ name: string; folder: string; findings: Finding[] }>,
): Rollup {
  return {
    generator: '@butshouldwe/fallow-rush',
    fallowVersion: '3.3.0',
    generatedAt: '2026-07-18T00:00:00.000Z',
    gitSha: 'a'.repeat(40),
    changedSince: null,
    projectsFilter: null,
    monorepo: {
      totalFindings: projects.reduce((n, p) => n + p.findings.length, 0),
      byType: {},
      dupes: {},
      health: {},
      unsupported: [],
      rushPlumbing: [],
      unattributed: [],
    },
    projects: projects.map((p) => ({
      project: p.name,
      projectFolder: p.folder,
      counts: {},
      findings: p.findings,
    })),
  };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-report-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('projectFileBase', () => {
  it('flattens scoped package names into a single path segment', () => {
    expect(projectFileBase('@myco/web')).toBe('@myco__web');
    expect(projectFileBase('util-lib')).toBe('util-lib');
  });

  it('flattens backslashes the same as forward slashes (Windows-style separators)', () => {
    expect(projectFileBase('@scope/pkg')).toBe('@scope__pkg');
    expect(projectFileBase('a\\b')).toBe('a__b');
  });

  it('rejects a name that would escape the output directory (mirrors sbom-rush scenarioFileBase)', () => {
    expect(() => projectFileBase('..\\..\\evil')).toThrow(/cannot be used as a report file name/);
    expect(() => projectFileBase('..')).toThrow(/cannot be used as a report file name/);
    expect(() => projectFileBase('')).toThrow(/cannot be used as a report file name/);
  });

  // Behavioral parity with @butshouldwe/sbom-rush's scenarioFileBase (run.ts):
  // both sanitizers must reach the same accept/reject decision for the same
  // input, even though the packages deliberately do not import each other
  // (zero-workspace-imports contract). This reimplements scenarioFileBase's
  // logic verbatim rather than importing it, so a future edit to either copy
  // that breaks parity fails this test. Includes '/etc/passwd' as a reminder
  // that the isAbsolute() check in both copies is defense-in-depth only: the
  // preceding replaceAll of '/' and '\\' already strips whatever would make
  // the result "absolute", so that branch is unreachable in both siblings —
  // parity holds (both accept), it just isn't reached via a throw.
  describe('parity with sbom-rush scenarioFileBase', () => {
    function scenarioFileBase(name: string): string {
      const base = name.replaceAll('/', '__').replaceAll('\\', '__');
      if (base.length === 0 || base === '.' || base.includes('..') || path.isAbsolute(base)) {
        throw new Error(`scenario name "${name}" cannot be used as an output file name`);
      }
      return base;
    }
    const cases = [
      '@scope/pkg',
      'a\\b',
      'plain-name',
      '..\\..\\evil',
      '..',
      '',
      '.',
      'foo..bar',
      '/etc/passwd',
    ];
    it.each(cases)('accept/reject decision matches for %j', (name) => {
      const outcome = (fn: (n: string) => string): 'accept' | 'reject' => {
        try {
          fn(name);
          return 'accept';
        } catch {
          return 'reject';
        }
      };
      expect(outcome(projectFileBase)).toBe(outcome(scenarioFileBase));
    });
  });
});

describe('writeReports', () => {
  it('writes report files for scoped package names (the mainstream Rush case)', () => {
    const dir = tmp();
    const rollup = rollupWith([
      { name: '@myco/web', folder: 'apps/web', findings: [finding()] },
      { name: 'util-lib', folder: 'libs/util', findings: [] },
    ]);
    const written = writeReports(rollup, dir);
    for (const file of [
      'monorepo.json',
      'monorepo.md',
      path.join('projects', '@myco__web.json'),
      path.join('projects', '@myco__web.md'),
      path.join('projects', 'util-lib.json'),
      path.join('projects', 'util-lib.md'),
    ]) {
      expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
    }
    expect(written).toHaveLength(6);
    const reread = JSON.parse(
      fs.readFileSync(path.join(dir, 'projects', '@myco__web.json'), 'utf8'),
    ) as {
      project: string;
    };
    expect(reread.project).toBe('@myco/web');
  });

  it('removes stale project files from previous, wider runs', () => {
    const dir = tmp();
    writeReports(
      rollupWith([
        { name: '@myco/web', folder: 'apps/web', findings: [finding()] },
        { name: 'util-lib', folder: 'libs/util', findings: [] },
      ]),
      dir,
    );
    writeReports(rollupWith([{ name: 'util-lib', folder: 'libs/util', findings: [] }]), dir);
    const remaining = fs.readdirSync(path.join(dir, 'projects')).toSorted();
    expect(remaining).toEqual(['util-lib.json', 'util-lib.md']);
  });

  it('rejects exact and case-insensitive report destination collisions', () => {
    expect(() => assertNoReportCollisions(['@a__b/c', '@a/b__c'])).toThrow(/@a__b\/c.*@a\/b__c/);
    expect(() => assertNoReportCollisions(['Web', 'web'])).toThrow(/shared base "Web"/);
  });

  it('detects report destination collisions before any filesystem mutation', () => {
    const reportDir = path.join(tmp(), 'not-created');
    const rollup = rollupWith([
      { name: '@a__b/c', folder: 'a', findings: [] },
      { name: '@a/b__c', folder: 'b', findings: [] },
    ]);
    expect(() => writeReports(rollup, reportDir)).toThrow(/file name collision/);
    expect(fs.existsSync(reportDir)).toBe(false);
  });
});

describe('writeReports: scope-clobber guard (issue #5)', () => {
  it('a scoped run refuses to overwrite a report recorded for a different scope', () => {
    const dir = tmp();
    writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir); // full run, projectsFilter: null
    const scoped = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    scoped.projectsFilter = ['a'];

    let error: unknown;
    try {
      writeReports(scoped, dir);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ScopeConflictError);
    const message = (error as Error).message;
    expect(message).toContain('the full repo');
    expect(message).toContain('project(s) a');
    // the refused write must not have touched the existing (full) report
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'monorepo.json'), 'utf8')).projectsFilter,
    ).toBeNull();
  });

  it('an unscoped (full) run always proceeds, even over a differently-scoped report', () => {
    const dir = tmp();
    const scoped = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    scoped.projectsFilter = ['a'];
    writeReports(scoped, dir);

    const full = rollupWith([
      { name: 'a', folder: 'a', findings: [] },
      { name: 'b', folder: 'b', findings: [] },
    ]);
    expect(() => writeReports(full, dir)).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'projects', 'b.json'))).toBe(true);
  });

  it('a scoped run proceeds over a report recorded for the same scope', () => {
    const dir = tmp();
    const first = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    first.projectsFilter = ['a'];
    writeReports(first, dir);

    const second = rollupWith([{ name: 'a', folder: 'a', findings: [finding()] }]);
    second.projectsFilter = ['a'];
    expect(() => writeReports(second, dir)).not.toThrow();
    const reread = JSON.parse(fs.readFileSync(path.join(dir, 'monorepo.json'), 'utf8')) as {
      monorepo: { totalFindings: number };
    };
    expect(reread.monorepo.totalFindings).toBe(1);
  });

  it('a --changed-since-only run does not trip the guard (projectsFilter is what matters)', () => {
    const dir = tmp();
    writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir); // full run

    const changedSinceOnly = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    changedSinceOnly.changedSince = 'HEAD';
    expect(() => writeReports(changedSinceOnly, dir)).not.toThrow();
  });

  it('an explicit --out/--report destination is exempt from the guard', () => {
    const dir = tmp();
    writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir); // full run
    const scoped = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    scoped.projectsFilter = ['a'];
    expect(() => writeReports(scoped, dir, { explicitOut: true })).not.toThrow();
  });

  it('a corrupt existing monorepo.json fails safe (refuses rather than deletes)', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'monorepo.json'), '{not valid json');
    const scoped = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    scoped.projectsFilter = ['a'];
    expect(() => writeReports(scoped, dir)).toThrow(ScopeConflictError);
  });
});

describe('writeReports: foreign projects/ directory guard', () => {
  it('refuses to delete a projects/ directory that does not look tool-managed', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'not-ours.txt'), 'do not delete me');

    const rollup = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    expect(() => writeReports(rollup, dir)).toThrow(/not a valid regular-file ownership record/);
    expect(fs.existsSync(path.join(dir, 'projects', 'not-ours.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.fallow-rush.lock'))).toBe(false);
  });

  it('proceeds when projects/ is absent or empty, even with no monorepo.json yet', () => {
    const dir = tmp();
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir),
    ).not.toThrow();
  });

  it('proceeds once the directory has a valid fallow-rush ownership record', () => {
    const dir = tmp();
    writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir);
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [finding()] }]), dir),
    ).not.toThrow();
  });

  it('full runs and explicit output do not bypass an invalid ownership record', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'not-ours.txt'), 'do not delete me');
    fs.writeFileSync(path.join(dir, 'monorepo.json'), '{not valid json');

    const full = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    expect(() => writeReports(full, dir)).toThrow(/ownership record/);
    const scoped = rollupWith([{ name: 'a', folder: 'a', findings: [] }]);
    scoped.projectsFilter = ['a'];
    expect(() => writeReports(scoped, dir, { explicitOut: true })).toThrow(/ownership record/);
    expect(fs.readFileSync(path.join(dir, 'projects', 'not-ours.txt'), 'utf8')).toBe(
      'do not delete me',
    );
  });

  it('rejects directory and symlink ownership markers', () => {
    const directoryMarker = tmp();
    fs.mkdirSync(path.join(directoryMarker, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(directoryMarker, 'projects', 'not-ours.txt'), 'keep');
    fs.mkdirSync(path.join(directoryMarker, 'monorepo.json'));
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), directoryMarker),
    ).toThrow(/ownership record/);

    if (process.platform !== 'win32') {
      const symlinkMarker = tmp();
      fs.mkdirSync(path.join(symlinkMarker, 'projects'), { recursive: true });
      fs.writeFileSync(path.join(symlinkMarker, 'projects', 'not-ours.txt'), 'keep');
      const target = path.join(symlinkMarker, 'elsewhere.json');
      fs.writeFileSync(
        target,
        JSON.stringify({
          fallowVersion: '3.6.0',
          monorepo: { totalFindings: 0 },
        }),
      );
      fs.symlinkSync(target, path.join(symlinkMarker, 'monorepo.json'));
      expect(() =>
        writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), symlinkMarker),
      ).toThrow(/ownership record/);
    }
  });

  it("rejects a forged regular ownership marker without this plugin's generator (P1)", () => {
    const forged = tmp();
    fs.mkdirSync(path.join(forged, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(forged, 'projects', 'not-ours.txt'), 'keep');
    fs.writeFileSync(
      path.join(forged, 'monorepo.json'),
      JSON.stringify({
        fallowVersion: '3.6.0',
        monorepo: { totalFindings: 0 },
      }),
    );
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), forged),
    ).toThrow(/ownership record/);
    expect(fs.readFileSync(path.join(forged, 'projects', 'not-ours.txt'), 'utf8')).toBe('keep');
  });

  it("accepts a regular ownership marker carrying this plugin's generator (P1 positive)", () => {
    const valid = tmp();
    fs.mkdirSync(path.join(valid, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(valid, 'projects', 'stale.txt'), 'from a previous run');
    fs.writeFileSync(
      path.join(valid, 'monorepo.json'),
      JSON.stringify({
        generator: '@butshouldwe/fallow-rush',
        fallowVersion: '3.6.0',
        monorepo: { totalFindings: 0 },
      }),
    );
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), valid),
    ).not.toThrow();
  });
});

describe('writeReports: atomicity', () => {
  it('leaves no *.tmp files behind after a successful write', () => {
    const dir = tmp();
    writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [finding()] }]), dir);

    function walk(d: string): string[] {
      return fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(d, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    }
    const files = walk(dir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('refuses a pre-planted symlink at the exclusive temp-file seam', () => {
    if (process.platform === 'win32') return;
    const dir = tmp();
    const outside = path.join(tmp(), 'outside.txt');
    fs.writeFileSync(outside, 'untouched');
    const openSync = fs.openSync.bind(fs);
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const candidate = String(file);
      if (candidate.endsWith('.tmp')) fs.symlinkSync(outside, candidate);
      return openSync(file, flags, mode);
    });
    try {
      expect(() =>
        writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir),
      ).toThrow();
      expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('writeReports: report directory lock', () => {
  it('refuses an active writer lock and names its pid', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, '.fallow-rush.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    expect(() => writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir)).toThrow(
      new RegExp(`another fallow-rush run \\(pid ${process.pid}\\)`),
    );
    expect(fs.existsSync(path.join(dir, '.fallow-rush.lock'))).toBe(true);
  });

  it('takes over one malformed stale lock aged past the grace window and removes its own lock on success', () => {
    const dir = tmp();
    const lockFile = path.join(dir, '.fallow-rush.lock');
    fs.writeFileSync(lockFile, 'not json');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile, old, old);
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir),
    ).not.toThrow();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('refuses a fresh uninitialized lock instead of stealing it (interleaving regression)', () => {
    const dir = tmp();
    const lockFile = path.join(dir, '.fallow-rush.lock');
    fs.writeFileSync(lockFile, ''); // a competitor mid-acquisition, or a foreign empty file
    expect(() => writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir)).toThrow(
      /not yet initialized/,
    );
    expect(fs.existsSync(lockFile)).toBe(true);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile, old, old);
    expect(() =>
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir),
    ).not.toThrow();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('publishes the lock record atomically (never observable without a pid)', () => {
    const dir = tmp();
    const lockFile = path.join(dir, '.fallow-rush.lock');
    const linkSync = fs.linkSync.bind(fs);
    const seen: string[] = [];
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation((existing, next) => {
      linkSync(existing, next);
      seen.push(fs.readFileSync(lockFile, 'utf8'));
    });
    try {
      writeReports(rollupWith([{ name: 'a', folder: 'a', findings: [] }]), dir);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(1);
    const published = seen.at(0);
    if (published === undefined) throw new Error('lock was never observed at publication time');
    const parsed = JSON.parse(published) as { pid: number };
    expect(parsed.pid).toBe(process.pid);
  });
});

describe('markdown tables', () => {
  it('escapes pipes in both path and detail cells', () => {
    const rollup = rollupWith([
      {
        name: 'web',
        folder: 'apps/web',
        findings: [
          finding({
            project: 'web',
            path: 'src/weird|name.js',
            detail: 'a | b',
          }),
        ],
      },
    ]);
    const md = projectMarkdown(rollup, 'web');
    const row = md.split('\n').find((l) => l.includes('weird'));
    expect(row).toBeDefined();
    // A GFM row with 4 columns has exactly 5 unescaped pipes.
    expect(row!.match(/(?<!\\)\|/g)).toHaveLength(5);
    expect(row).toContain('weird\\|name.js');
    expect(row).toContain('a \\| b');
  });

  it('labels a narrowed rollup so partial views are never mistaken for full ones', () => {
    const rollup = rollupWith([{ name: 'util-lib', folder: 'libs/util', findings: [] }]);
    rollup.projectsFilter = ['util-lib'];
    const md = monorepoMarkdown(rollup);
    expect(md).toContain('Narrowed to project(s): `util-lib`');
  });

  it('sanitizes poisoned filenames in table cells and circular-dependency details', () => {
    const poisoned = 'apps/web/src/evil\n|`<script>.ts';
    const check: FallowCheckSection = {
      total_issues: 1,
      summary: { circular_dependencies: 1 },
      unused_files: [],
      unused_exports: [],
      unused_dependencies: [],
      circular_dependencies: [{ files: [poisoned, 'apps/web/src/other.ts'] }],
    };
    const findings = findingsFromCheck(
      check,
      [{ packageName: 'web', projectFolder: 'apps/web' }],
      'root-pass',
    );
    const md = projectMarkdown(rollupWith([{ name: 'web', folder: 'apps/web', findings }]), 'web');
    const row = md.split('\n').find((line) => line.includes('evil'));
    expect(row).toBeDefined();
    expect(row!.match(/(?<!\\)\|/g)).toHaveLength(5);
    expectCircularPath(md);
    const raw = md.replace(
      '``apps/web/src/evil \\|`<script>.ts ⇄ apps/web/src/other.ts``',
      'apps/web/src/evil \\|`<script>.ts ⇄ apps/web/src/other.ts',
    );
    expect(raw).not.toBe(md);
    expect(() => expectCircularPath(raw)).toThrow('unexpected html token');
    expect(md).not.toContain('evil\n');
  });
});

const gfm = { gfm: true };

// Marked stores HTML-escaped text even in codespan tokens. Decode once,
// as an HTML consumer would; never decode the result a second time.
function unescapeToken(text: string): string {
  const named = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
  ]);
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot);/g, (raw: string, body: string) => {
    if (!body.startsWith('#')) return named.get(body) ?? raw;
    const hex = body[1]?.toLowerCase() === 'x';
    return String.fromCodePoint(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function one<T>(items: T[], guard: (item: T) => boolean): T {
  const matched = items.filter(guard);
  expect(matched).toHaveLength(1);
  return matched[0]!;
}

function reportRow(tokens: Token[]): Tokens.TableCell[] {
  const table = one(tokens, (token) => token.type === 'table') as Tokens.Table;
  expect(table.header).toHaveLength(4);
  expect(table.rows).toHaveLength(1);
  const row = table.rows[0]!;
  expect(row).toHaveLength(4);
  return row;
}

function expectInline(tokens: Token[], display: string, kind: 'empty' | 'literal' | 'code'): void {
  if (kind === 'empty') expect(tokens).toEqual([]);
  if (kind === 'code') expect(tokens.map(({ type }) => type)).toEqual(['codespan']);
  const text = tokens
    .map((token) => {
      if (
        token.type === 'text' ||
        token.type === 'escape' ||
        (kind === 'code' && token.type === 'codespan')
      ) {
        return unescapeToken((token as Tokens.Text | Tokens.Escape | Tokens.Codespan).text);
      }
      throw new Error(`unexpected ${token.type} token`);
    })
    .join('');
  expect(text).toBe(display);
}

function expectCircularPath(md: string): void {
  const tokens = marked.lexer(md, gfm);
  marked.walkTokens(tokens, (token) => {
    if (token.type === 'html') throw new Error('unexpected html token');
  });
  expectInline(
    reportRow(tokens)[1]!.tokens,
    'apps/web/src/evil |`<script>.ts ⇄ apps/web/src/other.ts',
    'code',
  );
}

function expectLiteralReport(
  raw: string,
  display: string,
  kind: 'empty' | 'literal' | 'code',
): void {
  const rollup = rollupWith([
    { name: raw, folder: raw, findings: [finding({ path: raw, detail: raw })] },
  ]);
  const report = projectMarkdown(rollup, raw);
  expect(report.split('\n')[7]?.match(/(?<!\\)(?:\\\\)*\|/g)).toHaveLength(5);
  // Definitions make both forms of a reference link active if escaping fails.
  const tokens = marked.lexer(`${report}\n[a]: /a\n[b]: /b\n`, gfm);
  const heading = one(tokens, (token) => token.type === 'heading') as Tokens.Heading;
  expectInline(heading.tokens, display ? `Fallow rollup: ${display}` : 'Fallow rollup:', 'literal');
  const projectList = one(tokens, (token) => token.type === 'list') as Tokens.List;
  expect(projectList.items).toHaveLength(2);
  const folder = projectList.items[0]!.tokens[0] as Tokens.Text;
  const [prefix, ...folderTokens] = folder.tokens ?? [];
  expectInline(prefix ? [prefix] : [], 'Folder: ', 'literal');
  expectInline(folderTokens, display, display ? 'code' : 'empty');
  const row = reportRow(tokens);
  expectInline(row[1]!.tokens, display, kind);
  expectInline(row[2]!.tokens, display, 'literal');

  rollup.monorepo.dupes = { [raw]: 1 };
  const mono = marked.lexer(`${monorepoMarkdown(rollup)}\n[a]: /a\n[b]: /b\n`, gfm);
  const projects = one(mono, (token) => token.type === 'table') as Tokens.Table;
  expect(projects.rows).toHaveLength(1);
  expect(projects.rows[0]).toHaveLength(2);
  expectInline(projects.rows[0]![0]!.tokens, display, 'literal');
  const lists = mono.filter((token): token is Tokens.List => token.type === 'list');
  expect(lists).toHaveLength(2);
  expect(lists[1]!.items).toHaveLength(1);
  const item = lists[1]!.items[0]!;
  expect(item.tokens.map(({ type }) => type)).toEqual(['text']);
  expectInline(
    (one(item.tokens, (token) => token.type === 'text') as Tokens.Text).tokens ?? [],
    `${display}: 1`,
    'literal',
  );
}

describe('repository text does not become GFM syntax or change its displayed value', () => {
  it.each([
    ['image', '![alt](/p.png)'],
    ['inline link', '[label](/path)'],
    ['reference link', '[a][b]'],
    ['shortcut reference', '[a]'],
    ['angle autolink', '<http://example.test>'],
    ['bare http URL', 'http://example.test'],
    ['bare www URL', 'www.example.test'],
    ['bare email', 'a\u0040example.test'],
    ['footnote', '[^note]'],
    ['asterisk emphasis and strong', '*x* **y**'],
    ['underscore emphasis and strong', '_x_ __y__'],
    ['tilde strikethrough', '~x~ ~~y~~'],
    ['HTML tag', '<script>'],
    ['HTML comment', '<!-- x -->'],
    ['named entity', '&lt;'],
    ['numeric entity', '&#60;'],
    ['pipe', 'x|y'],
    ['trailing backslash', 'tail\\'],
    ['one backtick', '`'],
    ['two backticks', '``'],
    ['three backticks', '```'],
    ['same-width backtick run inside longer content', '`a``b```'],
    ['leading space', ' x'],
    ['trailing space', 'x '],
    ['both edge spaces', ' x '],
    ['only spaces', '  '],
    ['only punctuation', '!@#$%^&*()_+-={}[]|:;"\'<>,.?/~`'],
    ['non-ASCII', 'é → 日本語 🚀'],
    ['Unicode whitespace at edges', '\u00A0x\uFEFF'],
    ['tabs', '\tx\t'],
  ])('preserves %s as literal text and one code span', (_label, raw) => {
    expectLiteralReport(raw!, raw!, 'code');
  });

  it.each([
    ['CR', 'a\rb', 'a b', 'code'],
    ['LF', 'a\nb', 'a b', 'code'],
    ['CRLF', 'a\r\nb', 'a b', 'code'],
    ['only line breaks', '\r\n\n\r', '   ', 'code'],
    ['NUL', 'a\0b', 'a\uFFFDb', 'code'],
    ['empty string', '', '', 'empty'],
    ['odd backslash run before a pipe', 'x\\|y', 'x\\|y', 'literal'],
    ['even backslash run before a pipe', 'x\\\\|y', 'x\\\\|y', 'literal'],
    ['backslash and pipe separated by a space', 'x\\ |y', 'x\\ |y', 'code'],
  ] as const)(
    'keeps the display-text and code span contract for %s',
    (_label, raw, display, kind) => {
      expectLiteralReport(raw, display, kind);
    },
  );

  it('keeps generated punctuation literal under a seeded GFM round trip', () => {
    const seed = Number(process.env.MARKDOWN_PROP_SEED ?? 0xf4110);
    const count = Number(process.env.MARKDOWN_PROP_CASES ?? 512);
    console.error(`MARKDOWN_PROP_SEED=${seed} MARKDOWN_PROP_CASES=${count}`);
    expect(Number.isSafeInteger(count) && count >= 128).toBe(true);
    let state = seed >>> 0;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const pairs = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ x'].map((ch) => [ch, ch] as const);
    const alphabet = [...pairs, ['\n', ' '], ['\0', '\uFFFD']] as const;
    const reached = new Set<string>();
    for (let i = 0; i < count; i++) {
      // Build expected text alongside raw input rather than calling the production normalizer.
      const chars = Array.from(
        { length: 1 + ((next() >>> 16) % 30) },
        () => alphabet[(next() >>> 16) % alphabet.length]!,
      );
      const raw = chars.map(([input]) => input).join('');
      const display = chars.map(([, output]) => output).join('');
      for (const [input] of chars) reached.add(input);
      expectLiteralReport(raw, display, raw.includes('\\|') ? 'literal' : 'code');
    }
    expect(reached.size).toBe(alphabet.length);
  });
});
