import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseJsonc } from './jsonc.js';
import type { RushRepo } from './types.js';

const rushJsonSchema = z.object({
  pnpmVersion: z.string().optional(),
  npmVersion: z.string().optional(),
  yarnVersion: z.string().optional(),
  projects: z.array(
    z.object({
      packageName: z.string(),
      projectFolder: z.string(),
    }),
  ),
});

/**
 * Walk up from `startDir` to find rush.json. Rush sets RUSH_INVOKED_FOLDER
 * for global commands; standalone runs walk up from process.cwd().
 */
export function findRushRepo(startDir: string): RushRepo {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'rush.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw = parseJsonc(fs.readFileSync(candidate, 'utf8'));
        const parsed = rushJsonSchema.parse(raw);
        return { rushJsonFolder: dir, ...parsed };
      } catch (err) {
        throw new Error(
          `Could not read "${candidate}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find rush.json in "${startDir}" or any parent folder. Run inside a Rush repository or pass --target-folder.`,
      );
    }
    dir = parent;
  }
}

/**
 * The pnpm binary Rush installed for this repo. Guaranteed present after
 * `rush install`/`rush update`, and guaranteed to match rush.json's pnpmVersion.
 */
export function rushPnpmBin(repo: RushRepo): string {
  return path.join(
    repo.rushJsonFolder,
    'common',
    'temp',
    'pnpm-local',
    'node_modules',
    '.bin',
    'pnpm',
  );
}

/**
 * The generated pnpm workspace root Rush installs into. This is where
 * lockfile-mode `pnpm sbom` must run.
 */
export function rushWorkspaceRoot(repo: RushRepo): string {
  return path.join(repo.rushJsonFolder, 'common', 'temp');
}

/**
 * §10 runtime check: the pnpm-based ladder rungs need rush.json to pin
 * pnpm >= 11 (pnpm sbom shipped in v11). Returns an explanation when the
 * ladder does not apply, or null when it does.
 */
export function pnpmLadderRefusal(repo: RushRepo): string | null {
  if (!repo.pnpmVersion) {
    const manager = repo.npmVersion
      ? 'npm'
      : repo.yarnVersion
        ? 'yarn'
        : 'an unknown package manager';
    return (
      `This Rush repo uses ${manager}, but sbom-rush's generators are pnpm-based ` +
      `(\`pnpm sbom\` requires "pnpmVersion" in rush.json). ` +
      `Use --target-folder with an external CycloneDX generator (e.g. cdxgen) instead.`
    );
  }
  const major = Number.parseInt(repo.pnpmVersion.split('.')[0] ?? '', 10);
  if (Number.isNaN(major) || major < 11) {
    return (
      `rush.json pins pnpmVersion ${repo.pnpmVersion}, but \`pnpm sbom\` requires pnpm >= 11. ` +
      `Upgrade "pnpmVersion" in rush.json, or use --target-folder with an external generator.`
    );
  }
  return null;
}
