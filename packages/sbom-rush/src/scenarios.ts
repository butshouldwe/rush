import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseJsonc } from './jsonc.js';
import { UsageError } from './errors.js';
import type { DeployScenario, ExtractorMetadata, RushRepo } from './types.js';

const deployScenarioSchema = z.object({
  deploymentProjectNames: z.array(z.string()).min(1),
  includeDevDependencies: z.boolean().optional(),
});

// npm's own package-name grammar (see validate-npm-package-name): lowercase
// URL-safe characters, optional @scope/ prefix, max 214 characters.
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PACKAGE_NAME_MAX_LENGTH = 214;

/**
 * extractor-metadata.json is written by `rush deploy`, but this plugin reads
 * it back as semi-trusted config (a hostile or corrupted deploy folder can
 * carry attacker-controlled content). mainProjectName/projectName values
 * flow into shell-mode Windows spawns downstream (generate.ts) — constraining
 * them to the npm package-name grammar here, at the schema boundary, keeps
 * what reaches that spawn narrow regardless of how the spawn itself quotes
 * its arguments.
 */
function packageNameField(label: string): z.ZodType<string> {
  return z.string().superRefine((val, ctx) => {
    if (val.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME_PATTERN.test(val)) {
      ctx.addIssue({
        code: 'custom',
        message:
          `${label} "${val}" (from extractor-metadata.json) is not a valid npm package name ` +
          `— expected lowercase, URL-safe characters with an optional @scope/ prefix, ` +
          `max ${PACKAGE_NAME_MAX_LENGTH} characters.`,
      });
    }
  });
}

/** Lexical + realpath containment beneath the deploy folder. Throws naming
 * the entry when `projects[].path` (or the joined manifest) escapes it. */
export function assertDeployContained(
  targetFolder: string,
  projectPath: string,
  what: string,
): string {
  if (path.isAbsolute(projectPath)) {
    throw new Error(
      `${what} must be relative to the deploy folder: ${JSON.stringify(projectPath)}`,
    );
  }

  const root = path.resolve(targetFolder);
  const resolved = path.resolve(targetFolder, projectPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${what} escapes the deploy folder: ${JSON.stringify(projectPath)}`);
  }

  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync(root);
    const realResolved = fs.realpathSync(resolved);
    if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(
        `${what} escapes the deploy folder after symlink resolution: ${JSON.stringify(projectPath)}`,
      );
    }
  }
  return resolved;
}

const extractorMetadataSchema = z.object({
  mainProjectName: packageNameField('mainProjectName'),
  projects: z.array(z.object({ projectName: packageNameField('projectName'), path: z.string() })),
});

function rushConfigFolder(repo: RushRepo): string {
  return path.join(repo.rushJsonFolder, 'common', 'config', 'rush');
}

/** Parse+validate a config file, always naming the file in failures. */
function parseConfig<T>(file: string, schema: z.ZodType<T>, parse: (text: string) => unknown): T {
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${file}: ${z.prettifyError(result.error)}`, { cause: result.error });
  }
  return result.data;
}

function loadScenario(name: string, configPath: string): DeployScenario {
  const parsed = parseConfig(configPath, deployScenarioSchema, parseJsonc);
  return {
    name,
    configPath,
    deploymentProjectNames: parsed.deploymentProjectNames,
    includeDevDependencies: parsed.includeDevDependencies ?? false,
  };
}

/**
 * Discover deploy scenarios. Default = every deploy-*.json plus deploy.json.
 * If both default forms exist, deploy.json keeps "default" and the explicit
 * deploy-default.json gets the output identity "default--explicit".
 * --scenario narrows by Rush's config name, so "default" selects both forms.
 */
export function discoverScenarios(repo: RushRepo, only?: string[]): DeployScenario[] {
  const folder = rushConfigFolder(repo);
  const scenarios: DeployScenario[] = [];
  if (!fs.existsSync(folder)) return scenarios;

  const entries = fs.readdirSync(folder).toSorted();
  const foundConfigNames = new Set<string>();
  for (const entry of entries) {
    let configName: string | undefined;
    if (entry === 'deploy.json') configName = 'default';
    else if (/^deploy-[a-z0-9-]+\.json$/i.test(entry))
      configName = entry.slice('deploy-'.length, -'.json'.length);
    if (!configName) continue;
    foundConfigNames.add(configName);
    if (only && only.length > 0 && !only.includes(configName)) continue;
    const outputName =
      entry === 'deploy-default.json' && entries.includes('deploy.json')
        ? 'default--explicit'
        : configName;
    scenarios.push(loadScenario(outputName, path.join(folder, entry)));
  }

  scenarios.sort((a, b) => a.name.localeCompare(b.name));

  if (only) {
    for (const wanted of only) {
      if (!foundConfigNames.has(wanted)) {
        // Unknown --scenario is a usage error (exit 2), not a runtime failure.
        throw new UsageError(
          `Deploy scenario "${wanted}" not found (expected ${path.join(folder, wanted === 'default' ? 'deploy.json' : `deploy-${wanted}.json`)}).`,
        );
      }
    }
  }
  return scenarios;
}

/**
 * Locate the deploy output folder holding `projectName`'s deployment for a
 * scenario. Convention order:
 *   1. common/deploy-<config-name>       (named scenarios only)
 *   2. common/deploy                     (Rush's default target)
 * accepted only when the folder's extractor-metadata.json mainProjectName is
 * the requested project — a multi-project scenario deploys one project per
 * `rush deploy --project <name>` run, each into its own folder.
 */
export function resolveTargetFolder(
  repo: RushRepo,
  scenario: DeployScenario,
  projectName: string,
): string {
  const configFile = path.basename(scenario.configPath);
  const namedScenario =
    configFile === 'deploy.json'
      ? undefined
      : (/^deploy-(.+)\.json$/i.exec(configFile)?.[1] ?? scenario.name);
  const defaultTarget = path.join(repo.rushJsonFolder, 'common', 'deploy');
  const candidates = namedScenario
    ? [path.join(repo.rushJsonFolder, 'common', `deploy-${namedScenario}`), defaultTarget]
    : [defaultTarget];
  for (const candidate of candidates) {
    const metaPath = path.join(candidate, 'extractor-metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = readExtractorMetadata(candidate);
    if (meta.mainProjectName === projectName) return candidate;
  }
  const projectFlag = scenario.deploymentProjectNames.length > 1 ? ` --project ${projectName}` : '';
  const scenarioFlag = namedScenario ? ` --scenario ${namedScenario}` : '';
  const suggestedTarget = namedScenario ? `common/deploy-${namedScenario}` : 'common/deploy';
  throw new Error(
    `No deploy output found for scenario "${scenario.name}" (project "${projectName}"). ` +
      `Looked for extractor-metadata.json in: ${candidates.join(', ')}. ` +
      `Run \`rush deploy${scenarioFlag}${projectFlag} --target-folder ${suggestedTarget}\` first, or pass --target-folder.`,
  );
}

export function readExtractorMetadata(targetFolder: string): ExtractorMetadata {
  const metaPath = path.join(targetFolder, 'extractor-metadata.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(
      `"${targetFolder}" does not look like rush deploy output: missing extractor-metadata.json.`,
    );
  }
  const metadata = parseConfig(
    metaPath,
    extractorMetadataSchema,
    (text) => JSON.parse(text) as unknown,
  ) as ExtractorMetadata;
  for (const project of metadata.projects) {
    assertDeployContained(
      targetFolder,
      project.path,
      `projects[].path for ${JSON.stringify(project.projectName)}`,
    );
  }
  return metadata;
}
