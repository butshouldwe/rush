import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRollup } from './rollup.js';
import type { FallowCombinedOutput, RushProject } from './types.js';

/**
 * Recorded output of the real pinned fallow 3.6.0 binary (see
 * __fixtures__/README.md for regeneration). These tests pin the plugin to
 * fallow's *actual* JSON shapes — schema drift on a fallow upgrade must land
 * here first, not in production.
 */
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function load(name: string): FallowCombinedOutput {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as FallowCombinedOutput;
}

const combined = load('fallow-3.6.0-combined.json');
const deadCode = load('fallow-3.6.0-dead-code.json');

// The recorded project is single-package; attribute everything to one project.
const projects: RushProject[] = [{ packageName: 'fixture-gen', projectFolder: 'src' }];

describe('against recorded fallow 3.6.0 output', () => {
  it('is schema_version 7 (bump = re-verify every shape in types.ts)', () => {
    expect(combined.schema_version).toBe(7);
  });

  const rollup = buildRollup({
    fallowVersion: '3.6.0',
    gitSha: 'b'.repeat(40),
    changedSince: null,
    projectsFilter: null,
    projects,
    rootPass: combined,
    projectPasses: new Map([['fixture-gen', deadCode]]),
  });

  it('surfaces duplication stats (dupes has no `summary` key in real output)', () => {
    // The fixture project plants two ~44-line identical functions.
    expect(rollup.monorepo.dupes['clone-groups']).toBe(1);
    expect(rollup.monorepo.dupes['duplication-percentage']).toBeGreaterThan(50);
    expect(rollup.monorepo.dupes['duplicated-lines']).toBeGreaterThan(40);
  });

  it('surfaces only numeric health metrics, dropping config thresholds and strings', () => {
    // real health.summary carries coverage_model: "static_estimated" (a string)
    // and max_*_threshold config echoes — neither is a finding metric.
    expect(Object.keys(rollup.monorepo.health).some((k) => k.includes('threshold'))).toBe(false);
    expect(Object.keys(rollup.monorepo.health)).not.toContain('coverage-model');
    expect(rollup.monorepo.health['files-analyzed']).toBeGreaterThan(0);
    for (const value of Object.values(rollup.monorepo.health)) {
      expect(typeof value).toBe('number');
    }
  });

  it('ingests real check findings (unused file + unused exports from the root pass)', () => {
    const all = rollup.projects.flatMap((p) => p.findings);
    expect(all.some((f) => f.type === 'unused-file' && f.path.includes('orphan'))).toBe(true);
    expect(all.some((f) => f.type === 'unused-export')).toBe(true);
  });

  it('ingests the dead-code pass (top-level check fields, no `check` key)', () => {
    expect(deadCode.check).toBeUndefined();
    const deps = rollup.projects
      .flatMap((p) => p.findings)
      .filter((f) => f.type === 'unused-dependency');
    expect(deps.some((f) => f.detail.includes('`ms`'))).toBe(true);
  });
});
