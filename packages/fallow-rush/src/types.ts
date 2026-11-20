/** A Rush project as declared in rush.json. */
export interface RushProject {
  packageName: string;
  projectFolder: string;
}

export interface RushRepo {
  /** Absolute path to the folder containing rush.json. */
  rushJsonFolder: string;
  projects: RushProject[];
}

/** One attributed finding in the rollup. */
export interface Finding {
  /** fallow's snake_case bucket, kebab-cased (e.g. "unused-export"). */
  type: string;
  /** Rush package name, "(rush)" for Rush plumbing, or "(repo)" for unattributed paths. */
  project: string;
  path: string;
  detail: string;
  /** Which pass produced it: the monorepo-aware root pass or the per-project dep-hygiene pass. */
  source: 'root-pass' | 'project-pass';
  /** Set when one finding spans several projects (e.g. a cross-package cycle). */
  crossProject?: string[];
}

export interface ProjectRollup {
  project: string;
  projectFolder: string;
  counts: Record<string, number>;
  findings: Finding[];
}

export interface Rollup {
  generator: string;
  fallowVersion: string;
  generatedAt: string;
  gitSha: string;
  changedSince: string | null;
  /** Project narrowing in effect (--project), or null for a full-repo run.
   * Consumers must treat a non-null value as a partial view. */
  projectsFilter: string[] | null;
  monorepo: {
    /** Distinct problems across attributed findings: a cross-project finding
     * (one cycle) appears in every involved project's rollup but counts once
     * here and in byType. */
    totalFindings: number;
    byType: Record<string, number>;
    /** Duplication metrics from fallow's dupes.stats (monorepo-wide; not
     * narrowed by --project). */
    dupes: Record<string, number>;
    /** Numeric health metrics from fallow's health.summary (monorepo-wide;
     * config thresholds and strings dropped). */
    health: Record<string, number>;
    /** Nonempty Fallow categories this plugin does not yet map into attributed findings. */
    unsupported: Array<{ category: string; count: number }>;
    /** Findings in Rush plumbing (common/*) — reported, never attributed to a project. */
    rushPlumbing: Finding[];
    unattributed: Finding[];
  };
  projects: ProjectRollup[];
}

/** The slice of fallow's combined JSON output (schema_version 7) we consume. */
export interface FallowCheckSection {
  total_issues: number;
  summary: Record<string, number>;
  unused_files: Array<{ path: string } | string>;
  unused_exports: Array<{ path: string; export_name: string; line?: number }>;
  unused_types?: Array<{ path: string; export_name?: string; line?: number }>;
  unused_class_members?: Array<{
    path: string;
    parent_name: string;
    member_name: string;
    kind?: string;
    line?: number;
    col?: number;
  }>;
  unresolved_imports?: Array<{
    path: string;
    specifier: string;
    line?: number;
    col?: number;
    specifier_col?: number;
  }>;
  duplicate_exports?: Array<{
    export_name: string;
    locations: Array<{ path: string; line?: number; col?: number }>;
  }>;
  unused_dependencies: Array<{ package_name: string; path: string; location?: string }>;
  unlisted_dependencies?: Array<{ package_name?: string; path?: string }>;
  dev_dependencies_in_production?: Array<{ package_name?: string; path?: string }>;
  circular_dependencies: Array<{ files: string[]; is_cross_package?: boolean }>;
  boundary_violations?: Array<{
    from_path: string;
    to_path: string;
    from_zone: string;
    to_zone: string;
    import_specifier: string;
    line?: number;
    col?: number;
  }>;
  [key: string]: unknown;
}

export interface FallowCombinedOutput {
  kind?: string;
  schema_version?: number;
  version?: string;
  check?: FallowCheckSection;
  /** Real shape as of fallow 3.6.0: no `summary`; numbers live in `stats`
   * (see __fixtures__/fallow-3.6.0-combined.json). */
  dupes?: {
    clone_groups?: unknown[];
    clone_families?: unknown[];
    stats?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** health.summary mixes numeric metrics, config threshold echoes, and
   * strings (e.g. coverage_model). */
  health?: { summary?: Record<string, unknown>; [key: string]: unknown };
  /** dead-code subcommand output is the check section at the top level. */
  summary?: Record<string, number>;
  [key: string]: unknown;
}
