import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { CdxBom, DeployScenario, ExtractorMetadata, RushRepo, RungAttempt } from './types.js';
import { rushPnpmBin, rushWorkspaceRoot } from './rushRepo.js';
import { mergeSplitBoms, missingShippedProjects, type WorkspaceProjectInfo } from './merge.js';
import { assertDeployContained } from './scenarios.js';

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GenerateOutcome {
  bom?: CdxBom;
  rung?: number;
  method?: string;
  attempts: RungAttempt[];
}

interface Cmd {
  bin: string;
  args: string[];
  cwd: string;
}

/**
 * Quote a single value for cmd.exe (used only on the Windows shell-mode spawn
 * path in {@link run}). cmd.exe's own command-line parser treats shell
 * metacharacters (&, |, <, >, ^, spaces) as literal while inside a balanced
 * double-quoted string, so wrapping every argument in quotes both survives
 * paths containing spaces and neutralizes injection via those
 * metacharacters. Embedded double quotes are doubled, per cmd.exe's own
 * quoting convention (documented under `cmd /?`).
 */
export function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function run(cmd: Cmd): { status: number; stdout: string; stderr: string } {
  // Windows: pnpm/cdxgen resolve to .cmd shims which Node refuses to spawn
  // without a shell (EINVAL since the CVE-2024-27980 hardening). Node's
  // shell-mode spawn on Windows joins bin+args into one command line with a
  // plain space join and does NOT quote each argument itself, so every
  // argument reaching cmd.exe must be pre-quoted here. Guarantee: args are
  // quoted (windowsQuote), and the config-derived names that flow into them
  // (mainProjectName / projectName) are additionally constrained at the
  // schema boundary (scenarios.ts's extractorMetadataSchema). Caveat:
  // cmd.exe expands %VAR% (and !VAR! under delayed expansion) even inside a
  // balanced double-quoted string, so windowsQuote does NOT neutralize
  // env-var expansion — quoting alone is not a complete defense for a value
  // like targetFolder, which is not schema-constrained. Safety on
  // targetFolder instead rests on it being an operator-supplied local path
  // (not attacker-controlled input); config-derived names get the added
  // schema constraint on top. POSIX spawns (shell:false) are untouched:
  // bin/args pass through exactly as given.
  const useShell = process.platform === 'win32';
  const bin = useShell ? windowsQuote(cmd.bin) : cmd.bin;
  const args = useShell ? cmd.args.map(windowsQuote) : cmd.args;
  const result = spawnSync(bin, args, {
    cwd: cmd.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: process.env,
    shell: useShell,
  });
  if (result.error) {
    return { status: 127, stdout: '', stderr: String(result.error.message) };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Injectable command runner (defaults to {@link run}); ladder tests drive the
 * state machine deterministically by substituting rung outputs. */
export type CommandRunner = (cmd: { bin: string; args: string[]; cwd: string }) => {
  status: number;
  stdout: string;
  stderr: string;
};

export function firstLineOfError(stderr: string, stdout: string): string {
  const text = (stderr || stdout).trim();
  const errLine = text.split('\n').find((l) => /err/i.test(l)) ?? text.split('\n')[0] ?? '';
  return errLine.trim().slice(0, 300);
}

/** Resolve an executable to an absolute path from trusted PATH directories
 * only: empty/relative PATH entries and any directory inside the scanned
 * deploy folder are excluded. Returns undefined when nothing is found. */
function resolveTrustedTool(name: string, deployRoot: string): string | undefined {
  const resolvedDeployRoot = path.resolve(deployRoot);
  const realDeployRoot = fs.existsSync(resolvedDeployRoot)
    ? fs.realpathSync(resolvedDeployRoot)
    : resolvedDeployRoot;
  const isInsideDeploy = (candidate: string): boolean =>
    candidate === resolvedDeployRoot ||
    candidate.startsWith(`${resolvedDeployRoot}${path.sep}`) ||
    candidate === realDeployRoot ||
    candidate.startsWith(`${realDeployRoot}${path.sep}`);
  const names =
    process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];

  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const dir = path.resolve(entry);
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (isInsideDeploy(dir) || isInsideDeploy(realDir)) continue;

    for (const executable of names) {
      const candidate = path.join(dir, executable);
      try {
        const realCandidate = fs.realpathSync(candidate);
        if (!fs.statSync(realCandidate).isFile() || isInsideDeploy(realCandidate)) continue;
        return candidate;
      } catch {
        // Missing or unreadable PATH candidate — try the next extension/directory.
      }
    }
  }
  return undefined;
}

/**
 * Read the shipped projects' manifests FROM THE DEPLOY FOLDER (what actually
 * shipped, not what the repo currently says) to learn versions and
 * workspace-internal dependency edges. Edge sources mirror what rush deploy's
 * PackageExtractor actually traverses: dependencies + peerDependencies +
 * optionalDependencies, plus devDependencies when the scenario includes them.
 */
export function shippedProjectInfos(
  targetFolder: string,
  meta: ExtractorMetadata,
  includeDevDependencies = false,
): WorkspaceProjectInfo[] {
  const shippedNames = new Set(meta.projects.map((p) => p.projectName));
  return meta.projects.map((project) => {
    const entry = `projects[].path for ${JSON.stringify(project.projectName)}`;
    assertDeployContained(targetFolder, project.path, entry);
    const pkgPath = assertDeployContained(
      targetFolder,
      path.join(project.path, 'package.json'),
      `package.json joined from ${entry}`,
    );
    let pkg: {
      name?: unknown;
      version?: unknown;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as typeof pkg;
    } catch (err) {
      throw new Error(
        `cannot read ${pkgPath} from the deploy output (was it excluded by ` +
          `deploy.json's patternsToExclude?): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (pkg.name !== project.projectName) {
      throw new Error(
        `deployed manifest ${pkgPath} identifies ${JSON.stringify(pkg.name)} instead of ` +
          `${JSON.stringify(project.projectName)} from extractor-metadata.json`,
      );
    }
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
      throw new Error(
        `deployed manifest ${pkgPath} for ${project.projectName} has no valid version; ` +
          `the selected deployment cannot be bound to a workspace SBOM`,
      );
    }
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...(includeDevDependencies ? Object.keys(pkg.devDependencies ?? {}) : []),
    ];
    return {
      name: project.projectName,
      version: pkg.version,
      workspaceDependencies: [...new Set(declared)].filter((d) => shippedNames.has(d)),
    };
  });
}

function parseNdjson(stdout: string): CdxBom[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as CdxBom);
}

function packageIdentity(name: string, version: string): string {
  return `${name}\0${version}`;
}

/**
 * Build the package inventory that the selected deploy output can actually
 * evidence. Workspace projects are already bound to their shipped manifests
 * by {@link shippedProjectInfos}; third-party packages must have a readable
 * package.json beneath a materialized node_modules tree in the deployment.
 *
 * Directory symlinks are deliberately not followed. A package reachable only
 * through a link outside the selected deployment was not materialized there
 * and cannot bind an attestation to this artifact.
 */
function deployedPackageInventory(
  targetFolder: string,
  shippedProjects: WorkspaceProjectInfo[],
): Set<string> {
  const inventory = new Set(
    shippedProjects.map((project) => packageIdentity(project.name, project.version)),
  );
  const root = path.resolve(targetFolder);
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(
        `cannot inspect the selected deploy output at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.name !== 'package.json' || !entry.isFile()) continue;

      const relativeParts = path.relative(root, entryPath).split(path.sep);
      if (!relativeParts.includes('node_modules')) continue;

      let pkg: { name?: unknown; version?: unknown };
      try {
        pkg = JSON.parse(fs.readFileSync(entryPath, 'utf8')) as typeof pkg;
      } catch (err) {
        throw new Error(
          `cannot read deployed package manifest ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        inventory.add(packageIdentity(pkg.name, pkg.version));
      }
    }
  }

  return inventory;
}

function verifyDeployedDependencyInventory(
  bom: CdxBom,
  targetFolder: string,
  shippedProjects: WorkspaceProjectInfo[],
): void {
  // The deploy output can prove the complete name@version set, but without a
  // bound lockfile it cannot prove package bytes or registry dependency-edge
  // equivalence. README.md documents this deliberately narrow guarantee.
  const deployed = deployedPackageInventory(targetFolder, shippedProjects);
  const attested = new Set<string>();
  const unverifiable = new Set<string>();

  for (const component of [bom.metadata?.component, ...(bom.components ?? [])]) {
    if (!component) continue;
    const version = component.version;
    if (typeof version !== 'string') {
      unverifiable.add(`${component.name}@${version ?? '<missing version>'}`);
      continue;
    }
    const identity = packageIdentity(component.name, version);
    attested.add(identity);
    if (!deployed.has(identity)) unverifiable.add(`${component.name}@${version}`);
  }

  const unreported = [...deployed].filter((identity) => !attested.has(identity));
  const problems: string[] = [];
  if (unverifiable.size > 0)
    problems.push(
      `workspace dependency inventory is not bound to the selected deploy output: ` +
        `${[...unverifiable].toSorted().join(', ')} not materialized at the attested version ` +
        `in the selected deploy output`,
    );
  if (unreported.length > 0)
    problems.push(
      `selected deploy output contains ${unreported
        .map((identity) => identity.replace('\0', '@'))
        .toSorted()
        .join(', ')} that is not reported by the workspace SBOM`,
    );
  if (problems.length > 0) throw new Error(problems.join('; '));
}

/**
 * Which pnpm to spawn: Rush's own copy when present (right version by
 * construction), else PATH — with the fallback made visible so a user can
 * tell "wrong pnpm ran" from "pnpm missing". On Windows the local bin is a
 * .cmd shim; the shell-mode spawn in {@link run} handles it.
 */
export function resolvePnpm(
  repo: RushRepo,
  targetFolder: string,
): { bin: string | undefined; note: string } {
  const local = rushPnpmBin(repo);
  const candidates =
    process.platform === 'win32' ? [`${local}.CMD`, `${local}.cmd`, local] : [local];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { bin: candidate, note: '' };
  }
  const trusted = resolveTrustedTool('pnpm', targetFolder);
  return trusted
    ? {
        bin: trusted,
        note:
          " [using PATH pnpm: Rush's pinned copy is missing at common/temp/pnpm-local — " +
          'run `rush install` to use the pinned version]',
      }
    : {
        bin: undefined,
        note:
          "Rush's pinned copy is missing at common/temp/pnpm-local and no trusted PATH pnpm " +
          'was found — run `rush install` to use the pinned version',
      };
}

/**
 * The §2 fallback ladder. Each rung's trigger to advance is a concrete
 * observed failure, and every attempt is recorded for the receipt.
 *
 * Rung 1 — `pnpm sbom` inside the deploy folder. Verified failing on pnpm
 *   11.11.0 (rush deploy ships no lockfile), kept first because it is the
 *   cheapest and would become correct the day pnpm can read the store there.
 * Rung 2 — lockfile-mode at Rush's generated workspace root, filtered to the
 *   deployed project's closure, split per package, merged, workspace edges
 *   restored from the shipped manifests.
 * Rung 3 — cdxgen against the deploy folder, when a cdxgen binary is on PATH.
 *
 * Every rung must pass the same acceptance gate: all projects listed in
 * extractor-metadata.json appear in the SBOM.
 */
export function generateSbom(
  repo: RushRepo,
  scenario: DeployScenario,
  targetFolder: string,
  meta: ExtractorMetadata,
  pnpmLadderBlocked: string | null,
  exec: CommandRunner = run,
): GenerateOutcome {
  const attempts: RungAttempt[] = [];
  const mainProject = meta.mainProjectName;
  const mainPath = meta.projects.find((p) => p.projectName === mainProject)?.path;
  const mainProjectFolder =
    mainPath === undefined
      ? undefined
      : assertDeployContained(
          targetFolder,
          mainPath,
          `main project ${JSON.stringify(mainProject)} projects[].path`,
        );
  const projects = shippedProjectInfos(targetFolder, meta, scenario.includeDevDependencies);
  const shippedNames = meta.projects.map((p) => p.projectName);
  const prodFlags = scenario.includeDevDependencies ? [] : ['--prod'];
  const { bin: pnpm, note: pnpmNote } = resolvePnpm(repo, targetFolder);

  const accept = (
    bom: CdxBom,
    rung: 1 | 2 | 3,
    method: string,
    note = '',
  ): GenerateOutcome | undefined => {
    const missing = missingShippedProjects(bom, mainProject, shippedNames);
    if (missing.length > 0) {
      attempts.push({
        rung,
        method,
        outcome: 'failed',
        detail: `SBOM omits shipped workspace projects: ${missing.join(', ')}${note}`,
      });
      return undefined;
    }
    attempts.push({ rung, method, outcome: 'succeeded', detail: `acceptance gate passed${note}` });
    return { bom, rung, method, attempts };
  };

  // Rung 1
  if (pnpmLadderBlocked) {
    attempts.push({
      rung: 1,
      method: 'pnpm-sbom-deploy-folder',
      outcome: 'unavailable',
      detail: pnpmLadderBlocked,
    });
  } else if (!pnpm) {
    attempts.push({
      rung: 1,
      method: 'pnpm-sbom-deploy-folder',
      outcome: 'unavailable',
      detail: pnpmNote,
    });
  } else if (!mainPath) {
    attempts.push({
      rung: 1,
      method: 'pnpm-sbom-deploy-folder',
      outcome: 'failed',
      detail: `extractor-metadata.json lists no path for ${mainProject}`,
    });
  } else {
    // --ignore-workspace: the deploy folder is a standalone artifact; without
    // it pnpm walks up from the deploy folder and can adopt an unrelated
    // enclosing workspace (observed when a Rush repo is nested in one).
    const result = exec({
      bin: pnpm,
      args: [
        'sbom',
        '--sbom-format',
        'cyclonedx',
        '--sbom-spec-version',
        '1.6',
        '--ignore-workspace',
        ...prodFlags,
      ],
      cwd: mainProjectFolder!,
    });
    if (result.status === 0 && result.stdout.trim().startsWith('{')) {
      try {
        const bom = JSON.parse(result.stdout) as CdxBom;
        const outcome = accept(bom, 1, 'pnpm-sbom-deploy-folder', pnpmNote);
        if (outcome) return outcome;
      } catch (err) {
        attempts.push({
          rung: 1,
          method: 'pnpm-sbom-deploy-folder',
          outcome: 'failed',
          detail: `unparseable pnpm sbom output: ${err instanceof Error ? err.message : String(err)}${pnpmNote}`,
        });
      }
    } else {
      attempts.push({
        rung: 1,
        method: 'pnpm-sbom-deploy-folder',
        outcome: 'failed',
        detail: firstLineOfError(result.stderr, result.stdout) + pnpmNote,
      });
    }
  }

  // Rung 2
  if (pnpmLadderBlocked) {
    attempts.push({
      rung: 2,
      method: 'pnpm-sbom-workspace-split-merge',
      outcome: 'unavailable',
      detail: pnpmLadderBlocked,
    });
  } else if (!pnpm) {
    attempts.push({
      rung: 2,
      method: 'pnpm-sbom-workspace-split-merge',
      outcome: 'unavailable',
      detail: pnpmNote,
    });
  } else if (!fs.existsSync(rushWorkspaceRoot(repo))) {
    attempts.push({
      rung: 2,
      method: 'pnpm-sbom-workspace-split-merge',
      outcome: 'unavailable',
      detail:
        'the generated workspace at common/temp does not exist — run `rush install` ' +
        '(or `rush update`) first so lockfile-mode pnpm sbom has a workspace to read',
    });
  } else {
    const result = exec({
      bin: pnpm,
      args: [
        'sbom',
        '--sbom-format',
        'cyclonedx',
        '--sbom-spec-version',
        '1.6',
        '--lockfile-only',
        ...prodFlags,
        '--filter',
        `${mainProject}...`,
        '--split',
      ],
      cwd: rushWorkspaceRoot(repo),
    });
    if (result.status === 0) {
      try {
        const splits = parseNdjson(result.stdout);
        const merged = mergeSplitBoms(splits, mainProject, projects);
        verifyDeployedDependencyInventory(merged, targetFolder, projects);
        const outcome = accept(merged, 2, 'pnpm-sbom-workspace-split-merge', pnpmNote);
        if (outcome) return outcome;
      } catch (err) {
        attempts.push({
          rung: 2,
          method: 'pnpm-sbom-workspace-split-merge',
          outcome: 'failed',
          detail: (err instanceof Error ? err.message : String(err)) + pnpmNote,
        });
      }
    } else {
      attempts.push({
        rung: 2,
        method: 'pnpm-sbom-workspace-split-merge',
        outcome: 'failed',
        detail: firstLineOfError(result.stderr, result.stdout) + pnpmNote,
      });
    }
  }

  // Rung 3
  const cdxgen = resolveTrustedTool('cdxgen', targetFolder);
  if (!cdxgen) {
    attempts.push({
      rung: 3,
      method: 'cdxgen-deploy-folder',
      outcome: 'unavailable',
      detail: 'no cdxgen on a trusted PATH (current-directory lookup disabled)',
    });
  } else {
    const cdxgenCheck = exec({ bin: cdxgen, args: ['--version'], cwd: targetFolder });
    if (cdxgenCheck.status !== 0) {
      attempts.push({
        rung: 3,
        method: 'cdxgen-deploy-folder',
        outcome: 'unavailable',
        detail: 'no cdxgen on a trusted PATH (current-directory lookup disabled)',
      });
    } else {
      const outFile = path.join(
        targetFolder,
        `.sbom-rush-cdxgen-${randomBytes(6).toString('hex')}.json`,
      );
      const result = exec({
        bin: cdxgen,
        args: ['-t', 'js', '--spec-version', '1.6', '-o', outFile, '.'],
        cwd: targetFolder,
      });
      try {
        if (result.status === 0 && fs.existsSync(outFile)) {
          const bom = JSON.parse(fs.readFileSync(outFile, 'utf8')) as CdxBom;
          const outcome = accept(bom, 3, 'cdxgen-deploy-folder');
          if (outcome) return outcome;
        } else {
          attempts.push({
            rung: 3,
            method: 'cdxgen-deploy-folder',
            outcome: 'failed',
            detail: firstLineOfError(result.stderr, result.stdout),
          });
        }
      } catch (err) {
        attempts.push({
          rung: 3,
          method: 'cdxgen-deploy-folder',
          outcome: 'failed',
          detail: `unparseable cdxgen output: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        fs.rmSync(outFile, { force: true });
      }
    }
  }

  return { attempts };
}
