import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fallowBin, fallowVersion } from './fallowBin.js';
import { aggregateFindings, buildRollup } from './rollup.js';
import type { FallowCombinedOutput, Rollup, RushRepo } from './types.js';

/** spawnSync stdout cap. fallow JSON is KBs on small repos, MBs on huge ones;
 * 128 MiB keeps a pathological monorepo from truncating mid-document. */
const MAX_BUFFER = 128 * 1024 * 1024;

export interface ScanOptions {
  changedSince?: string;
  /** Narrow to these Rush package names. */
  projects?: string[];
}

/** Injectable process runner (defaults to {@link runProcess}); unit tests
 * drive the two-pass orchestration without spawning real fallow binaries. */
export type ProcessRunner = (
  bin: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error };

function runProcess(bin: string, args: string[], cwd: string): ReturnType<ProcessRunner> {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function runFallow(exec: ProcessRunner, args: string[], cwd: string): FallowCombinedOutput {
  // fallow's own bin is a `#!/usr/bin/env node` launcher script (not a native
  // binary — see fallowBin.ts). Shebangs are a POSIX mechanism; spawning the
  // script directly with shell:false fails on Windows. Launching it through
  // this process's own node (process.execPath) works identically on every
  // platform and needs no shell.
  const result = exec(process.execPath, [fallowBin(), ...args, '--format', 'json', '--quiet'], cwd);
  if (result.error) throw result.error;
  const stdout = result.stdout;
  if (!stdout.trim().startsWith('{')) {
    throw new Error(
      `fallow ${args.join(' ')} produced no JSON (exit ${result.status}): ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  return JSON.parse(stdout) as FallowCombinedOutput;
}

function gitSha(exec: ProcessRunner, dir: string): string {
  const result = exec('git', ['rev-parse', 'HEAD'], dir);
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

/** Cap an enumeration in an error message so 500-project repos stay legible. */
function listSome(names: string[], max = 15): string {
  return names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')}, … (${names.length - max} more)`;
}

function containedProjectDir(repoDir: string, project: RushRepo['projects'][number]): string {
  const realRepo = fs.realpathSync(repoDir);
  const candidate = path.resolve(repoDir, project.projectFolder);
  let realProject: string;
  try {
    realProject = fs.realpathSync(candidate);
  } catch (error) {
    throw new Error(
      `cannot scan Rush project "${project.packageName}": project directory "${candidate}" cannot be resolved: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (realProject !== realRepo && !realProject.startsWith(`${realRepo}${path.sep}`)) {
    throw new Error(
      `cannot scan Rush project "${project.packageName}": project directory "${candidate}" resolves outside ` +
        `the Rush repository to "${realProject}"`,
    );
  }
  return realProject;
}

/**
 * The two-pass scan (verified necessary in the testbed):
 *
 *  Pass 1 — fallow at the repo root: monorepo-aware reachability. This is the
 *  only pass that can correctly judge exports ("is this imported anywhere?")
 *  and cross-package cycles. It always scans the whole repo — `--project`
 *  narrows reporting and the per-project pass, not this cost.
 *
 *  Pass 2 — `fallow dead-code` per project: package.json dependency hygiene
 *  (unused/unlisted/dev-in-prod), which root runs do not compute for
 *  sub-workspace manifests. Reachability findings from this pass are
 *  discarded — a lone project cannot see its consumers.
 *  (Runs serially; fine below ~50 projects, revisit with a bounded pool for
 *  large repos.)
 */
export function scan(
  repo: RushRepo,
  options: ScanOptions = {},
  exec: ProcessRunner = runProcess,
): Rollup {
  const changedArgs = options.changedSince ? ['--changed-since', options.changedSince] : [];
  const narrowed = options.projects !== undefined && options.projects.length > 0;
  if (options.projects) {
    for (const name of options.projects) {
      if (!repo.projects.some((p) => p.packageName === name)) {
        throw new Error(
          `--project "${name}" is not a Rush project (known: ${listSome(repo.projects.map((p) => p.packageName))})`,
        );
      }
    }
  }
  const selected = narrowed
    ? repo.projects.filter((p) => options.projects!.includes(p.packageName))
    : repo.projects;

  const rootPass = runFallow(exec, changedArgs, repo.rushJsonFolder);

  const projectPasses = new Map<string, FallowCombinedOutput>();
  for (const project of selected) {
    const projectDir = containedProjectDir(repo.rushJsonFolder, project);
    projectPasses.set(
      project.packageName,
      runFallow(exec, ['dead-code', ...changedArgs], projectDir),
    );
  }

  const rollup = buildRollup({
    fallowVersion: fallowVersion(),
    gitSha: gitSha(exec, repo.rushJsonFolder),
    changedSince: options.changedSince ?? null,
    projectsFilter: narrowed ? [...options.projects!].toSorted() : null,
    projects: repo.projects,
    rootPass,
    projectPasses,
  });

  if (narrowed) {
    // Narrowing scopes the project rollups and the aggregate finding counts.
    // Monorepo-wide sections (dupes, health, rushPlumbing, unattributed) are
    // not project-attributed and stay as computed — projectsFilter marks the
    // document as a partial view.
    rollup.projects = rollup.projects.filter((p) => options.projects!.includes(p.project));
    const aggregate = aggregateFindings(rollup.projects.flatMap((p) => p.findings));
    rollup.monorepo.totalFindings = aggregate.totalFindings;
    rollup.monorepo.byType = aggregate.byType;
  }

  return rollup;
}
