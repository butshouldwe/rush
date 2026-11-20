import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan, type ProcessRunner } from './scan.js';
import { fallowBin } from './fallowBin.js';
import type { RushRepo } from './types.js';

const projects = [
  { packageName: 'lib-c', projectFolder: 'projects/lib-c' },
  { packageName: 'lib-d', projectFolder: 'projects/lib-d' },
  { packageName: 'web-app', projectFolder: 'projects/web-app' },
];

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-scan-'));
  tmpDirs.push(dir);
  return dir;
}

function repoFixture(): RushRepo {
  const rushJsonFolder = tmp();
  for (const project of projects) {
    fs.mkdirSync(path.join(rushJsonFolder, project.projectFolder), { recursive: true });
  }
  return { rushJsonFolder, projects };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Fake fallow: root pass reports a cross-package cycle + one unused export;
 * per-project passes report one unused dependency for web-app only. */
const fakeExec: ProcessRunner = (bin, args, cwd) => {
  if (bin === 'git') return { status: 0, stdout: 'c'.repeat(40), stderr: '' };
  // fallow's own bin is a Node-shebang launcher script; on Windows a direct
  // shell:false spawn of it fails (shebangs are POSIX-only), so runFallow
  // launches it through node itself: bin becomes process.execPath and the
  // launcher script path is prepended to args.
  expect(bin).toBe(process.execPath);
  expect(args[0]).toBe(fallowBin());
  if (args[1] === 'dead-code') {
    const isWebApp = cwd.endsWith('web-app');
    return {
      status: isWebApp ? 1 : 0,
      stdout: JSON.stringify({
        total_issues: isWebApp ? 1 : 0,
        summary: {},
        unused_files: [],
        unused_exports: [],
        unused_dependencies: isWebApp
          ? [{ package_name: 'mri', path: 'package.json', location: 'dependencies' }]
          : [],
        circular_dependencies: [],
      }),
      stderr: '',
    };
  }
  return {
    status: 0,
    stdout: JSON.stringify({
      kind: 'combined',
      schema_version: 7,
      check: {
        total_issues: 2,
        summary: {},
        unused_files: [],
        unused_exports: [{ path: 'projects/lib-c/src/index.js', export_name: 'dead' }],
        unused_dependencies: [],
        circular_dependencies: [
          {
            files: ['projects/lib-c/src/index.js', 'projects/lib-d/src/index.js'],
            is_cross_package: true,
          },
        ],
      },
      dupes: { stats: { clone_groups: 2, duplication_percentage: 12.5 } },
      health: {
        summary: { files_analyzed: 9, coverage_model: 'static_estimated', max_crap_threshold: 30 },
      },
    }),
    stderr: '',
  };
};

describe('scan (orchestration via injected runner)', () => {
  it('full run: distinct-problem aggregates, real dupes/health shapes, null filter', () => {
    const rollup = scan(repoFixture(), {}, fakeExec);
    expect(rollup.projectsFilter).toBeNull();
    // 1 unused export + 1 cycle (distinct) + 1 unused dep
    expect(rollup.monorepo.totalFindings).toBe(3);
    expect(rollup.monorepo.byType['circular-dependency']).toBe(1);
    expect(rollup.monorepo.dupes).toEqual({ 'clone-groups': 2, 'duplication-percentage': 12.5 });
    expect(rollup.monorepo.health).toEqual({ 'files-analyzed': 9 });
    expect(rollup.gitSha).toBe('c'.repeat(40));
  });

  it('narrowed run records the filter, narrows counts, keeps monorepo-wide sections', () => {
    const rollup = scan(repoFixture(), { projects: ['web-app'] }, fakeExec);
    expect(rollup.projectsFilter).toEqual(['web-app']);
    expect(rollup.projects.map((p) => p.project)).toEqual(['web-app']);
    expect(rollup.monorepo.totalFindings).toBe(1);
    expect(rollup.monorepo.byType).toEqual({ 'unused-dependency': 1 });
    // monorepo-wide sections are not project-attributed and survive narrowing
    expect(rollup.monorepo.dupes['clone-groups']).toBe(2);
    expect(rollup.monorepo.health['files-analyzed']).toBe(9);
  });

  it('narrowed to both cycle members still counts the cycle once in aggregates', () => {
    const rollup = scan(repoFixture(), { projects: ['lib-c', 'lib-d'] }, fakeExec);
    expect(rollup.monorepo.byType['circular-dependency']).toBe(1);
    const cycles = rollup.projects
      .flatMap((p) => p.findings)
      .filter((f) => f.type === 'circular-dependency');
    expect(cycles).toHaveLength(2); // per-project attribution intact
  });

  it('rejects unknown --project names with a capped known-project list', () => {
    const bigRepo: RushRepo = {
      rushJsonFolder: '/repo',
      projects: Array.from({ length: 40 }, (_, i) => ({
        packageName: `pkg-${String(i).padStart(2, '0')}`,
        projectFolder: `projects/pkg-${i}`,
      })),
    };
    let message = '';
    try {
      scan(bigRepo, { projects: ['nope'] }, fakeExec);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('--project "nope" is not a Rush project');
    expect(message).toContain('(25 more)');
    expect(message.length).toBeLessThan(500);
  });

  it('surfaces a legible error when fallow emits no JSON', () => {
    const brokenExec: ProcessRunner = (bin) =>
      bin === 'git'
        ? { status: 0, stdout: 'c'.repeat(40), stderr: '' }
        : { status: 3, stdout: '', stderr: 'fallow: catastrophic failure' };
    expect(() => scan(repoFixture(), {}, brokenExec)).toThrow(
      /produced no JSON \(exit 3\).*catastrophic/s,
    );
  });

  it('runs a normal nested Rush project from its real contained directory', () => {
    const repo = repoFixture();
    const seen: string[] = [];
    const exec: ProcessRunner = (bin, args, cwd) => {
      seen.push(cwd);
      return fakeExec(bin, args, cwd);
    };
    scan(repo, { projects: ['web-app'] }, exec);
    expect(seen).toContain(fs.realpathSync(path.join(repo.rushJsonFolder, 'projects/web-app')));
  });

  it('refuses a project folder that resolves through .. to a sibling directory', () => {
    const base = tmp();
    const rushJsonFolder = path.join(base, 'repo');
    fs.mkdirSync(rushJsonFolder);
    fs.mkdirSync(path.join(base, 'sibling'));
    const traversalRepo: RushRepo = {
      rushJsonFolder,
      projects: [{ packageName: 'escape', projectFolder: '../sibling' }],
    };
    expect(() => scan(traversalRepo, {}, fakeExec)).toThrow(
      /project "escape".*resolves outside the Rush repository/s,
    );
  });

  it('refuses a symlinked project directory that resolves outside the repository', () => {
    const base = tmp();
    const rushJsonFolder = path.join(base, 'repo');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(rushJsonFolder, 'projects'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(rushJsonFolder, 'projects', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const symlinkRepo: RushRepo = {
      rushJsonFolder,
      projects: [{ packageName: 'linked', projectFolder: 'projects/linked' }],
    };
    expect(() => scan(symlinkRepo, {}, fakeExec)).toThrow(
      /project "linked".*resolves outside the Rush repository/s,
    );
  });

  it('names the project and path when its directory is missing', () => {
    const rushJsonFolder = tmp();
    const missingRepo: RushRepo = {
      rushJsonFolder,
      projects: [{ packageName: 'missing', projectFolder: 'projects/missing' }],
    };
    expect(() => scan(missingRepo, {}, fakeExec)).toThrow(
      /project "missing".*projects[/\\]missing.*cannot be resolved/s,
    );
  });
});
