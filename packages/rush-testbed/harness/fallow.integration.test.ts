import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectOk, fixtureRoot, gitStatusTestbed, readJson, rush, testbedRoot } from './lib.js';
/** Structural slice of fallow-rush's rollup JSON — declared locally because
 * the testbed invokes the plugins and never imports them (PRD §0). */
interface Rollup {
  gitSha: string;
  projects: Array<{
    project: string;
    findings: Array<{ type: string; path: string; detail: string; crossProject?: string[] }>;
  }>;
  monorepo: {
    totalFindings: number;
    rushPlumbing: Array<{ path: string }>;
  };
}

const reportDir = path.join(fixtureRoot, 'common', 'temp', 'fallow-rush');
/** A distinct report dir for the --project-scoped assertions below: writing
 * a scoped run over `reportDir` (which holds a full-repo report by then)
 * would trip the scope-clobber guard (issue #5) - see the explicit --out
 * escape hatch used in the narrowing test. */
const scopedReportDir = path.join(fixtureRoot, 'common', 'temp', 'fallow-rush-scoped');
const goldenDir = path.join(testbedRoot, 'golden');

function normalizeRollup(rollup: Rollup): Record<string, unknown> {
  const clone = structuredClone(rollup) as unknown as Record<string, unknown>;
  delete clone.generatedAt;
  clone.gitSha = '<sha>';
  return clone;
}

beforeAll(() => {
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.rmSync(scopedReportDir, { recursive: true, force: true });
  expectOk(rush(['update-autoinstaller', '--name', 'rush-plugins']), 'rush update-autoinstaller');
  expectOk(rush(['update']), 'rush update');
}, 600_000);

describe('rush fallow (the real custom command, via the autoinstaller)', () => {
  it('runs end-to-end and writes the report tree', () => {
    const result = rush(['fallow']);
    expectOk(result, 'rush fallow');
    expect(fs.existsSync(path.join(reportDir, 'monorepo.json'))).toBe(true);
    expect(fs.existsSync(path.join(reportDir, 'monorepo.md'))).toBe(true);
    for (const project of ['lib-a', 'lib-b', 'lib-c', 'lib-d', 'web-app', 'docs-site']) {
      expect(fs.existsSync(path.join(reportDir, 'projects', `${project}.json`)), project).toBe(
        true,
      );
      expect(fs.existsSync(path.join(reportDir, 'projects', `${project}.md`)), project).toBe(true);
    }
  });

  it('finds the three planted flaws, attributed to the right projects', () => {
    const rollup = readJson<Rollup>(path.join(reportDir, 'monorepo.json'));
    const byProject = new Map(rollup.projects.map((p) => [p.project, p]));

    const libB = byProject.get('lib-b')!;
    expect(
      libB.findings.some((f) => f.type === 'unused-export' && f.detail.includes('deadHelper')),
    ).toBe(true);

    const webApp = byProject.get('web-app')!;
    expect(
      webApp.findings.some((f) => f.type === 'unused-dependency' && f.detail.includes('mri')),
    ).toBe(true);

    for (const name of ['lib-c', 'lib-d']) {
      const cycle = byProject.get(name)!.findings.find((f) => f.type === 'circular-dependency');
      expect(cycle, name).toBeDefined();
      expect(cycle?.crossProject).toEqual(['lib-c', 'lib-d']);
    }
  });

  it('excludes rush plumbing from project rollups but reports it', () => {
    const rollup = readJson<Rollup>(path.join(reportDir, 'monorepo.json'));
    expect(rollup.monorepo.rushPlumbing.length).toBeGreaterThan(0);
    expect(rollup.monorepo.rushPlumbing.every((f) => f.path.startsWith('common/'))).toBe(true);
    const projectFindings = rollup.projects.flatMap((p) => p.findings);
    expect(projectFindings.some((f) => f.path.startsWith('common/'))).toBe(false);
  });

  it('clean projects have empty rollups (lib-a, docs-site)', () => {
    const rollup = readJson<Rollup>(path.join(reportDir, 'monorepo.json'));
    for (const name of ['lib-a', 'docs-site']) {
      expect(rollup.projects.find((p) => p.project === name)?.findings, name).toEqual([]);
    }
  });

  it('a --project-scoped run refuses to clobber the existing full-repo report (issue #5)', () => {
    // reportDir currently holds the full-repo report written by the earlier
    // tests in this file; a scoped run against the same (default) dir must
    // refuse rather than silently drop the other projects' files.
    const clobbered = rush(['fallow', '--project', 'web-app']);
    expect(clobbered.status).toBe(2);
    expect(clobbered.stderr).toContain('project(s) web-app');
    expect(clobbered.stderr).toContain('the full repo');
    // and it must not have touched the existing report
    expect(readJson<Rollup>(path.join(reportDir, 'monorepo.json')).projects.length).toBeGreaterThan(
      1,
    );
  });

  it('--project narrows (via explicit --out), --fail-on-findings gates, unknown project errors', () => {
    const narrowed = rush(['fallow', '--project', 'web-app', '--json', '--out', scopedReportDir]);
    expectOk(narrowed, 'rush fallow --project web-app --json --out <scoped>');
    const rollup = JSON.parse(narrowed.stdout.slice(narrowed.stdout.indexOf('{'))) as Rollup;
    expect(rollup.projects.map((p) => p.project)).toEqual(['web-app']);
    expect(rollup.monorepo.totalFindings).toBeGreaterThan(0);

    const gated = rush(['fallow', '--fail-on-findings']);
    expect(gated.status).toBe(3);

    const unknown = rush(['fallow', '--project', 'nope']);
    expect(unknown.status).not.toBe(0);
  });

  it('--changed-since passes through to fallow and scopes findings down (v1 passthrough)', () => {
    const full = rush(['fallow', '--json']);
    expectOk(full, 'rush fallow --json');
    const fullRollup = JSON.parse(full.stdout.slice(full.stdout.indexOf('{'))) as Rollup;

    // With a clean working tree, nothing changed since HEAD; file-scoped
    // findings must drop out (project-level findings may bypass the filter,
    // per fallow's own documentation — the assertion is ⊆, not =0).
    const scoped = rush(['fallow', '--changed-since', 'HEAD', '--json']);
    expectOk(scoped, 'rush fallow --changed-since HEAD --json');
    const scopedRollup = JSON.parse(scoped.stdout.slice(scoped.stdout.indexOf('{'))) as Rollup;

    expect(scopedRollup.monorepo.totalFindings).toBeLessThanOrEqual(
      fullRollup.monorepo.totalFindings,
    );
    const scopedTypes = new Set(
      scopedRollup.projects.flatMap((p) => p.findings.map((f) => f.type)),
    );
    expect(scopedTypes.has('unused-export')).toBe(false);
  });

  it('matches the committed golden rollup (volatile fields normalized)', () => {
    expectOk(rush(['fallow']), 'rush fallow (golden run)');
    const actual = normalizeRollup(readJson<Rollup>(path.join(reportDir, 'monorepo.json')));
    const goldenFile = path.join(goldenDir, 'fallow-monorepo.json');
    if (process.env.UPDATE_GOLDENS) {
      fs.writeFileSync(goldenFile, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(readJson(goldenFile));
  });

  it('leaves the repo clean (§0 no-mutation rule)', () => {
    expect(gitStatusTestbed()).toEqual([]);
  });
});
