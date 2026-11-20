import { describe, expect, it } from 'vitest';
import {
  attributePath,
  buildRollup,
  findingsFromCheck,
  RUSH_PLUMBING,
  UNATTRIBUTED,
} from './rollup.js';
import type { FallowCheckSection, RushProject } from './types.js';

const projects: RushProject[] = [
  { packageName: 'lib-b', projectFolder: 'projects/lib-b' },
  { packageName: 'lib-c', projectFolder: 'projects/lib-c' },
  { packageName: 'lib-d', projectFolder: 'projects/lib-d' },
  { packageName: 'web-app', projectFolder: 'projects/web-app' },
];

function emptyCheck(): FallowCheckSection {
  return {
    total_issues: 0,
    summary: {},
    unused_files: [],
    unused_exports: [],
    unused_dependencies: [],
    circular_dependencies: [],
  };
}

/** Shaped like fallow 3.3.0's real fixture output (B1 probe). */
function rootCheck(): FallowCheckSection {
  return {
    ...emptyCheck(),
    total_issues: 6,
    unused_files: ['common/scripts/install-run.js', 'common/scripts/install-run-rush.js'],
    unused_exports: [{ path: 'projects/lib-b/src/index.js', export_name: 'deadHelper', line: 8 }],
    circular_dependencies: [
      {
        files: ['projects/lib-c/src/index.js', 'projects/lib-d/src/index.js'],
        is_cross_package: true,
      },
    ],
  };
}

describe('attributePath', () => {
  it('maps project folders to package names', () => {
    expect(attributePath('projects/web-app/src/index.js', projects)).toBe('web-app');
    expect(attributePath('projects/lib-b/package.json', projects)).toBe('lib-b');
  });
  it('sends common/* to the rush plumbing bucket', () => {
    expect(attributePath('common/scripts/install-run.js', projects)).toBe(RUSH_PLUMBING);
    expect(attributePath('common/temp/package.json', projects)).toBe(RUSH_PLUMBING);
  });
  it('leaves unknown paths unattributed', () => {
    expect(attributePath('tools/random.js', projects)).toBe(UNATTRIBUTED);
  });
  it('does not confuse folder prefixes (projects/lib-b2 is not lib-b)', () => {
    expect(attributePath('projects/lib-b2/src/x.js', projects)).toBe(UNATTRIBUTED);
  });
});

describe('findingsFromCheck', () => {
  it('attributes a cross-package cycle to every involved project', () => {
    const findings = findingsFromCheck(rootCheck(), projects, 'root-pass');
    const cycles = findings.filter((f) => f.type === 'circular-dependency');
    expect(cycles.map((c) => c.project).toSorted()).toEqual(['lib-c', 'lib-d']);
    expect(cycles[0]?.crossProject).toEqual(['lib-c', 'lib-d']);
  });

  it('normalizes backslash separators at ingestion (Windows-emitted paths)', () => {
    const check: FallowCheckSection = {
      ...emptyCheck(),
      unused_files: ['projects\\web-app\\src\\orphan.js'],
    };
    const findings = findingsFromCheck(check, projects, 'root-pass');
    expect(findings[0]?.project).toBe('web-app');
    expect(findings[0]?.path).toBe('projects/web-app/src/orphan.js');
  });

  it('tolerates a malformed circular-dependency entry missing its files array', () => {
    // fallow output is external (post-cutoff tool); a cycle entry without
    // `files` must not crash the whole scan with a raw TypeError.
    const check: FallowCheckSection = {
      ...emptyCheck(),
      circular_dependencies: [{ is_cross_package: true } as unknown as { files: string[] }],
    };
    expect(() => findingsFromCheck(check, projects, 'root-pass')).not.toThrow();
    expect(findingsFromCheck(check, projects, 'root-pass')).toEqual([]);
  });

  it('maps the four pinned Fallow 3.6 categories into attributed findings', () => {
    const check: FallowCheckSection = {
      ...emptyCheck(),
      unresolved_imports: [{ path: 'projects/web-app/src/index.ts', specifier: './missing' }],
      unused_class_members: [
        {
          path: 'projects/lib-b/src/service.ts',
          parent_name: 'Service',
          member_name: 'legacy',
        },
      ],
      duplicate_exports: [
        {
          export_name: 'Config',
          locations: [
            { path: 'projects/lib-c/src/config.ts' },
            { path: 'projects/lib-d/src/config.ts' },
          ],
        },
      ],
      boundary_violations: [
        {
          from_path: 'projects/web-app/src/ui.ts',
          to_path: 'projects/lib-b/src/internal.ts',
          from_zone: 'ui',
          to_zone: 'internal',
          import_specifier: 'lib-b/internal',
        },
      ],
    };
    const findings = findingsFromCheck(check, projects, 'root-pass');
    expect(findings.map((finding) => finding.type).toSorted()).toEqual([
      'boundary-violation',
      'duplicate-export',
      'duplicate-export',
      'unresolved-import',
      'unused-class-member',
    ]);
    expect(findings.find((finding) => finding.type === 'unresolved-import')?.project).toBe(
      'web-app',
    );
  });
});

describe('buildRollup (the fixture acceptance shape)', () => {
  const rollup = buildRollup({
    fallowVersion: '3.3.0',
    gitSha: 'a'.repeat(40),
    changedSince: null,
    projectsFilter: null,
    projects,
    // dupes/health shaped like real fallow 3.3.0 (see rollup.realoutput.test.ts)
    rootPass: {
      kind: 'combined',
      check: rootCheck(),
      dupes: {
        clone_groups: [],
        clone_families: [],
        stats: { clone_groups: 0, duplication_percentage: 0 },
      },
      health: { summary: { files_analyzed: 4, coverage_model: 'static_estimated' } },
    },
    projectPasses: new Map([
      [
        'web-app',
        {
          ...emptyCheck(),
          total_issues: 2,
          unused_dependencies: [
            { package_name: 'mri', path: 'package.json', location: 'dependencies' },
          ],
          unused_exports: [{ path: 'src/index.js', export_name: 'main' }], // must be discarded
        },
      ],
    ]),
  });

  it('finds the three planted flaws, attributed to the right projects', () => {
    const byProject = new Map(rollup.projects.map((p) => [p.project, p]));
    expect(byProject.get('lib-b')?.findings.map((f) => f.type)).toEqual(['unused-export']);
    expect(byProject.get('web-app')?.findings.map((f) => f.type)).toEqual(['unused-dependency']);
    expect(byProject.get('lib-c')?.findings.map((f) => f.type)).toEqual(['circular-dependency']);
    expect(byProject.get('lib-d')?.findings.map((f) => f.type)).toEqual(['circular-dependency']);
  });

  it('discards reachability findings from the per-project pass (false-positive-prone)', () => {
    const webApp = rollup.projects.find((p) => p.project === 'web-app');
    expect(webApp?.findings.some((f) => f.type === 'unused-export')).toBe(false);
  });

  it('rebases per-project paths onto the project folder', () => {
    const webApp = rollup.projects.find((p) => p.project === 'web-app');
    expect(webApp?.findings[0]?.path).toBe('projects/web-app/package.json');
  });

  it('excludes rush plumbing from projects but reports it monorepo-wide', () => {
    expect(rollup.monorepo.rushPlumbing).toHaveLength(2);
    expect(rollup.monorepo.rushPlumbing.every((f) => f.project === RUSH_PLUMBING)).toBe(true);
    const allProjectFindings = rollup.projects.flatMap((p) => p.findings);
    expect(allProjectFindings.some((f) => f.path.startsWith('common/'))).toBe(false);
  });

  it('counts distinct problems in the monorepo totals (one cycle = one finding)', () => {
    // 1 dead export + 1 unused dep + 1 cycle. The cycle still appears in BOTH
    // lib-c's and lib-d's project rollups (per-project attribution), but the
    // monorepo aggregate must not double-count a single problem.
    expect(rollup.monorepo.totalFindings).toBe(3);
    expect(rollup.monorepo.byType).toEqual({
      'unused-export': 1,
      'unused-dependency': 1,
      'circular-dependency': 1,
    });
  });

  it('orders findings deterministically', () => {
    const keys = rollup.projects
      .flatMap((p) => p.findings)
      .map((f) => `${f.project}|${f.type}|${f.path}`);
    expect(keys).toEqual([...keys].toSorted((a, b) => a.localeCompare(b)));
  });

  it('surfaces nonempty unmapped categories under monorepo.unsupported', () => {
    const unsupportedRollup = buildRollup({
      fallowVersion: '3.6.0',
      gitSha: 'a'.repeat(40),
      changedSince: null,
      projectsFilter: null,
      projects,
      rootPass: {
        ...emptyCheck(),
        summary: { policy_violations: 2 },
        policy_violations: [{ path: 'one' }, { path: 'two' }],
      },
      projectPasses: new Map(),
    });
    expect(unsupportedRollup.monorepo.unsupported).toEqual([
      { category: 'policy_violations', count: 2 },
    ]);
  });
});
