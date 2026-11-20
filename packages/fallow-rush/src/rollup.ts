import path from 'node:path';
import type {
  FallowCheckSection,
  FallowCombinedOutput,
  Finding,
  ProjectRollup,
  Rollup,
  RushProject,
} from './types.js';

export const RUSH_PLUMBING = '(rush)';
export const UNATTRIBUTED = '(repo)';

/**
 * Attribute a repo-relative path to a Rush project by folder prefix.
 * Anything under common/ is Rush plumbing (generated scripts, autoinstallers,
 * the temp workspace fallow discovers as "rush-common") — reported, never
 * attributed to a project.
 */
export function attributePath(filePath: string, projects: RushProject[]): string {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.startsWith('common/')) return RUSH_PLUMBING;
  for (const project of projects) {
    const folder = project.projectFolder.replaceAll('\\', '/');
    if (normalized === folder || normalized.startsWith(`${folder}/`)) return project.packageName;
  }
  return UNATTRIBUTED;
}

function kebab(snake: string): string {
  return snake.replaceAll('_', '-');
}

/** Normalize separators once at ingestion so stored paths are always posix. */
function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

const UNSUPPORTED_CHECK_CATEGORIES = [
  'private_type_leaks',
  'unused_enum_members',
  'unused_store_members',
  'unprovided_injects',
  'unrendered_components',
  'unused_component_props',
  'unused_component_emits',
  'unused_component_inputs',
  'unused_component_outputs',
  'unused_svelte_events',
  'unused_server_actions',
  'unused_load_data_keys',
  'type_only_dependencies',
  'test_only_dependencies',
  're_export_cycles',
  'boundary_coverage_violations',
  'boundary_call_violations',
  'policy_violations',
  'stale_suppressions',
  'unused_catalog_entries',
  'empty_catalog_groups',
  'unresolved_catalog_references',
  'unused_dependency_overrides',
  'misconfigured_dependency_overrides',
  'invalid_client_exports',
  'mixed_client_server_barrels',
  'misplaced_directives',
  'route_collisions',
  'dynamic_segment_name_conflicts',
] as const;

function unsupportedFromCheck(
  check: FallowCheckSection,
): Array<{ category: string; count: number }> {
  return UNSUPPORTED_CHECK_CATEGORIES.flatMap((category) => {
    const summaryCount = check.summary?.[category];
    const entries = check[category];
    const count =
      typeof summaryCount === 'number' && summaryCount > 0
        ? summaryCount
        : Array.isArray(entries)
          ? entries.length
          : 0;
    return count > 0 ? [{ category, count }] : [];
  });
}

/** Flatten fallow's check section into attributed findings. */
export function findingsFromCheck(
  check: FallowCheckSection,
  projects: RushProject[],
  source: Finding['source'],
): Finding[] {
  const findings: Finding[] = [];

  for (const entry of check.unused_files ?? []) {
    const filePath = normalizePath(typeof entry === 'string' ? entry : entry.path);
    findings.push({
      type: 'unused-file',
      project: attributePath(filePath, projects),
      path: filePath,
      detail: 'file is never imported by any entry point',
      source,
    });
  }

  for (const entry of check.unused_exports ?? []) {
    findings.push({
      type: 'unused-export',
      project: attributePath(entry.path, projects),
      path: entry.path,
      detail: `export \`${entry.export_name}\` is never imported anywhere in the monorepo`,
      source,
    });
  }

  for (const entry of check.unused_types ?? []) {
    findings.push({
      type: 'unused-type',
      project: attributePath(entry.path, projects),
      path: entry.path,
      detail: `type export \`${entry.export_name ?? '?'}\` is never imported`,
      source,
    });
  }

  for (const entry of check.unused_class_members ?? []) {
    findings.push({
      type: 'unused-class-member',
      project: attributePath(entry.path, projects),
      path: entry.path,
      detail: `class member \`${entry.parent_name}.${entry.member_name}\` is never used`,
      source,
    });
  }

  for (const entry of check.unresolved_imports ?? []) {
    findings.push({
      type: 'unresolved-import',
      project: attributePath(entry.path, projects),
      path: entry.path,
      detail: `import \`${entry.specifier}\` cannot be resolved`,
      source,
    });
  }

  for (const entry of check.duplicate_exports ?? []) {
    const files = entry.locations.map((location) => normalizePath(location.path));
    const involved = [...new Set(files.map((file) => attributePath(file, projects)))].toSorted();
    for (const project of involved) {
      findings.push({
        type: 'duplicate-export',
        project,
        path: files.join(' ⇄ '),
        detail: `export \`${entry.export_name}\` is declared in multiple files: ${files.join(', ')}`,
        source,
        crossProject: involved.length > 1 ? involved : undefined,
      });
    }
  }

  for (const entry of check.unused_dependencies ?? []) {
    findings.push({
      type: 'unused-dependency',
      project: attributePath(entry.path, projects),
      path: entry.path,
      detail: `dependency \`${entry.package_name}\` is declared but never imported`,
      source,
    });
  }

  for (const entry of check.unlisted_dependencies ?? []) {
    findings.push({
      type: 'unlisted-dependency',
      project: attributePath(entry.path ?? '', projects),
      path: entry.path ?? '',
      detail: `\`${entry.package_name ?? '?'}\` is imported but not declared in package.json`,
      source,
    });
  }

  for (const entry of check.dev_dependencies_in_production ?? []) {
    findings.push({
      type: 'dev-dependency-in-production',
      project: attributePath(entry.path ?? '', projects),
      path: entry.path ?? '',
      detail: `devDependency \`${entry.package_name ?? '?'}\` is used by production code`,
      source,
    });
  }

  for (const cycle of check.circular_dependencies ?? []) {
    const files = (cycle.files ?? []).map(normalizePath);
    const involved = [...new Set(files.map((f) => attributePath(f, projects)))].toSorted();
    for (const project of involved) {
      findings.push({
        type: 'circular-dependency',
        project,
        path: files.join(' ⇄ '),
        detail: cycle.is_cross_package
          ? `cross-package import cycle: ${files.join(' → ')}`
          : `import cycle: ${files.join(' → ')}`,
        source,
        crossProject: involved.length > 1 ? involved : undefined,
      });
    }
  }

  for (const entry of check.boundary_violations ?? []) {
    findings.push({
      type: 'boundary-violation',
      project: attributePath(entry.from_path, projects),
      path: entry.from_path,
      detail:
        `boundary violation: ${entry.from_zone} cannot import ${entry.to_zone} via ` +
        `\`${entry.import_specifier}\` (${normalizePath(entry.to_path)})`,
      source,
    });
  }

  return findings.map((f) => ({ ...f, path: normalizePath(f.path) }));
}

/**
 * Aggregate counts of DISTINCT problems: a cross-project finding (e.g. one
 * cycle) appears in every involved project's rollup but adds one to
 * totalFindings/byType. Identity for the fan-out copies is type+path.
 */
export function aggregateFindings(findings: Finding[]): {
  totalFindings: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};
  const seenCrossProject = new Set<string>();
  let totalFindings = 0;
  for (const finding of findings) {
    if (finding.crossProject) {
      const key = `${finding.type}|${finding.path}`;
      if (seenCrossProject.has(key)) continue;
      seenCrossProject.add(key);
    }
    totalFindings += 1;
    byType[finding.type] = (byType[finding.type] ?? 0) + 1;
  }
  return { totalFindings, byType };
}

export interface BuildRollupInput {
  fallowVersion: string;
  gitSha: string;
  changedSince: string | null;
  /** Project narrowing in effect (--project), or null for a full-repo run. */
  projectsFilter: string[] | null;
  projects: RushProject[];
  /** Combined output of the monorepo-aware root pass. */
  rootPass: FallowCombinedOutput;
  /** Per-project dead-code outputs: package.json-scoped findings only. */
  projectPasses: Map<string, FallowCombinedOutput>;
}

/** Finding types taken from the per-project pass — the ones the root pass
 * cannot see (B1-verified). Reachability findings from a lone-project run are
 * discarded: without the monorepo view they are false-positive-prone. */
const PROJECT_PASS_TYPES = new Set([
  'unused-dependency',
  'unlisted-dependency',
  'dev-dependency-in-production',
]);

export function buildRollup(input: BuildRollupInput): Rollup {
  const rootCheck = input.rootPass.check ?? (input.rootPass as unknown as FallowCheckSection);
  const rootFindings = findingsFromCheck(rootCheck, input.projects, 'root-pass');

  const unsupportedCounts = new Map<string, number>();
  const collectUnsupported = (check: FallowCheckSection): void => {
    for (const entry of unsupportedFromCheck(check)) {
      unsupportedCounts.set(
        entry.category,
        (unsupportedCounts.get(entry.category) ?? 0) + entry.count,
      );
    }
  };
  collectUnsupported(rootCheck);

  const projectFindings: Finding[] = [];
  for (const [projectName, output] of input.projectPasses) {
    const check = output.check ?? (output as unknown as FallowCheckSection);
    collectUnsupported(check);
    const project = input.projects.find((p) => p.packageName === projectName);
    if (!project) continue;
    const all = findingsFromCheck(check, [project], 'project-pass');
    for (const finding of all) {
      if (!PROJECT_PASS_TYPES.has(finding.type)) continue;
      // Paths from a per-project run are relative to the project folder.
      projectFindings.push({
        ...finding,
        project: projectName,
        path: finding.path
          ? path.posix.join(project.projectFolder, finding.path)
          : project.projectFolder,
      });
    }
  }

  const all = [...rootFindings, ...projectFindings].toSorted(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.type.localeCompare(b.type) ||
      a.path.localeCompare(b.path),
  );

  const rushPlumbing = all.filter((f) => f.project === RUSH_PLUMBING);
  const unattributed = all.filter((f) => f.project === UNATTRIBUTED);
  const attributed = all.filter((f) => f.project !== RUSH_PLUMBING && f.project !== UNATTRIBUTED);

  const { totalFindings, byType } = aggregateFindings(attributed);
  const unsupported = [...unsupportedCounts]
    .map(([category, count]) => ({ category, count }))
    .toSorted((a, b) => a.category.localeCompare(b.category));

  const projectRollups: ProjectRollup[] = input.projects
    .map((project) => {
      const findings = attributed.filter((f) => f.project === project.packageName);
      const counts: Record<string, number> = {};
      for (const finding of findings) counts[finding.type] = (counts[finding.type] ?? 0) + 1;
      return {
        project: project.packageName,
        projectFolder: project.projectFolder,
        counts,
        findings,
      };
    })
    .toSorted((a, b) => a.project.localeCompare(b.project));

  // fallow's dupes section has no `summary` (confirmed unchanged through
  // 3.6.0); the numbers live in dupes.stats. Whitelist the metrics that
  // describe found duplication
  // (total_files/total_lines etc. are corpus size, not findings).
  const DUPE_METRICS = [
    'clone_groups',
    'clone_instances',
    'duplicated_lines',
    'duplicated_tokens',
    'duplication_percentage',
  ];
  const dupes: Record<string, number> = {};
  const stats = input.rootPass.dupes?.stats ?? {};
  for (const key of DUPE_METRICS) {
    const value = stats[key];
    if (typeof value === 'number' && value > 0) dupes[kebab(key)] = value;
  }

  // health.summary mixes finding metrics with config echoes (max_*_threshold)
  // and strings (coverage_model) — keep only the numeric metrics.
  const health: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.rootPass.health?.summary ?? {})) {
    if (typeof value !== 'number' || value <= 0 || key.includes('threshold')) continue;
    health[kebab(key)] = value;
  }

  return {
    generator: '@butshouldwe/fallow-rush',
    fallowVersion: input.fallowVersion,
    generatedAt: new Date().toISOString(),
    gitSha: input.gitSha,
    changedSince: input.changedSince,
    projectsFilter: input.projectsFilter,
    monorepo: {
      totalFindings,
      byType,
      dupes,
      health,
      unsupported,
      rushPlumbing,
      unattributed,
    },
    projects: projectRollups,
  };
}
