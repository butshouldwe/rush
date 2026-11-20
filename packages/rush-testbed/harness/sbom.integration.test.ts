import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  expectOk,
  fixtureRoot,
  gitStatusTestbed,
  normalizeBom,
  normalizeManifest,
  readJson,
  rush,
  testbedRoot,
} from './lib.js';

const sbomOut = path.join(fixtureRoot, 'common', 'deploy-sbom');
const goldenDir = path.join(testbedRoot, 'golden');

/**
 * The acceptance flow from RUSH-PLUGINS-PRD §4: pack the plugin → wire the
 * autoinstaller → rush update → rush deploy per scenario → invoke the real
 * `rush sbom` custom command → assert on artifacts. The plugin is never
 * imported; it is invoked through Rush's own plugin machinery.
 */
beforeAll(() => {
  fs.rmSync(sbomOut, { recursive: true, force: true });

  expectOk(rush(['update-autoinstaller', '--name', 'rush-plugins']), 'rush update-autoinstaller');
  expectOk(rush(['update']), 'rush update');
  expectOk(
    rush(['deploy', '--scenario', 'web', '--target-folder', 'common/deploy-web', '--overwrite']),
    'rush deploy web',
  );
  expectOk(
    rush(['deploy', '--scenario', 'docs', '--target-folder', 'common/deploy-docs', '--overwrite']),
    'rush deploy docs',
  );
}, 600_000);

describe('rush sbom (the real custom command, via the autoinstaller)', () => {
  it('runs end-to-end and produces one SBOM per scenario plus a manifest', () => {
    const result = rush(['sbom']);
    expectOk(result, 'rush sbom');
    expect(fs.existsSync(path.join(sbomOut, 'web.cdx.json'))).toBe(true);
    expect(fs.existsSync(path.join(sbomOut, 'docs.cdx.json'))).toBe(true);
    expect(fs.existsSync(path.join(sbomOut, 'manifest.json'))).toBe(true);
  }, 240_000);

  it('web SBOM contains exactly the shipped closure and not the devDependency', () => {
    const bom = readJson(path.join(sbomOut, 'web.cdx.json'));
    const components = (bom.components as Array<{ name: string }>).map((c) => c.name).toSorted();
    expect(components).toEqual(['kleur', 'lib-a', 'lib-b', 'mri', 'ms']);
    // Plant #4: build-tool is a devDependency workspace project — pnpm's
    // filter traverses it, but it never shipped, so neither it nor its deps
    // may leak in (verified failure mode on microsoft/rush-example).
    expect(components).not.toContain('build-tool');
    expect(components).not.toContain('picocolors');
  });

  it('web SBOM dependency graph has no dangling refs', () => {
    const bom = readJson(path.join(sbomOut, 'web.cdx.json'));
    const meta = bom.metadata as { component: { 'bom-ref'?: string } };
    const known = new Set([
      meta.component['bom-ref'],
      ...(bom.components as Array<{ 'bom-ref'?: string }>).map((c) => c['bom-ref']),
    ]);
    for (const dep of bom.dependencies as Array<{ ref: string; dependsOn?: string[] }>) {
      expect(known.has(dep.ref), `dangling ref ${dep.ref}`).toBe(true);
      for (const target of dep.dependsOn ?? []) {
        expect(known.has(target), `dangling edge ${dep.ref} -> ${target}`).toBe(true);
      }
    }
  });

  it('records the ladder rung and stamp in SBOM metadata', () => {
    const bom = readJson(path.join(sbomOut, 'web.cdx.json'));
    const metadata = bom.metadata as {
      properties: Array<{ name: string; value: string }>;
      component: { name: string };
    };
    const props = Object.fromEntries(metadata.properties.map((p) => [p.name, p.value]));
    expect(metadata.component.name).toBe('web-app');
    expect(props['sbom-rush:scenario']).toBe('web');
    expect(props['sbom-rush:ladder-rung']).toBe('2');
    expect(props['sbom-rush:generator']).toBe('pnpm-sbom-workspace-split-merge');
    expect(props['sbom-rush:git-sha']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('both scenarios validate against the CycloneDX 1.6 schema and differ as planted', () => {
    const manifest = readJson(path.join(sbomOut, 'manifest.json'));
    const scenarios = manifest.scenarios as Record<
      string,
      { valid: boolean; componentCount: number; rung: number; error: string | null }
    >;
    expect(scenarios.web?.valid).toBe(true);
    expect(scenarios.docs?.valid).toBe(true);
    expect(scenarios.web?.error).toBeNull();
    expect(scenarios.docs?.error).toBeNull();
    expect(scenarios.web?.componentCount).toBe(5);
    expect(scenarios.docs?.componentCount).toBe(1);
  });

  it('--scenario narrows and exit codes stay meaningful', () => {
    const result = rush(['sbom', '--scenario', 'web']);
    expectOk(result, 'rush sbom --scenario web');
    const bad = rush(['sbom', '--scenario', 'nope']);
    expect(bad.status).not.toBe(0);
  }, 240_000);

  it('matches the committed golden artifacts (volatile fields normalized)', () => {
    if (process.env.UPDATE_GOLDENS) {
      fs.mkdirSync(goldenDir, { recursive: true });
      for (const file of ['web.cdx.json', 'docs.cdx.json']) {
        const normalized = normalizeBom(readJson(path.join(sbomOut, file)));
        fs.writeFileSync(path.join(goldenDir, file), `${JSON.stringify(normalized, null, 2)}\n`);
      }
      const normalizedManifest = normalizeManifest(readJson(path.join(sbomOut, 'manifest.json')));
      fs.writeFileSync(
        path.join(goldenDir, 'manifest.json'),
        `${JSON.stringify(normalizedManifest, null, 2)}\n`,
      );
    }
    for (const file of ['web.cdx.json', 'docs.cdx.json']) {
      const actual = normalizeBom(readJson(path.join(sbomOut, file)));
      const golden = readJson(path.join(goldenDir, file));
      expect(actual, file).toEqual(golden);
    }
    const actualManifest = normalizeManifest(readJson(path.join(sbomOut, 'manifest.json')));
    const goldenManifest = readJson(path.join(goldenDir, 'manifest.json'));
    expect(actualManifest).toEqual(goldenManifest);
  });

  it('leaves the repo clean (§0 no-mutation rule)', () => {
    expect(gitStatusTestbed()).toEqual([]);
  });
});
