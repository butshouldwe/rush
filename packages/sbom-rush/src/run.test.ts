import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectManifestLock,
  runSbom,
  scenarioFileBase,
  tryReclaimManifestLock,
  tryReleaseManifestLock,
  writeManifest,
  UsageError,
} from './run.js';
import type { CommandRunner } from './generate.js';
import type { ScenarioResult } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-run-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.RUSH_INVOKED_FOLDER;
});

function result(scenario: string, overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return { scenario, mainProject: scenario, attempts: [], ...overrides };
}

describe('scenarioFileBase (audit N1)', () => {
  it('flattens scoped names', () => {
    expect(scenarioFileBase('@scope/app')).toBe('@scope__app');
    expect(scenarioFileBase('web')).toBe('web');
  });
  it('rejects names that would escape the output directory', () => {
    expect(() => scenarioFileBase('../evil')).toThrow(/cannot be used/);
    expect(() => scenarioFileBase('..')).toThrow(/cannot be used/);
  });
  it('disambiguates flattened separators from literal double underscores', () => {
    expect(scenarioFileBase('@a/b__c')).not.toBe(scenarioFileBase('@a__b/c'));
  });
});

describe('writeManifest merge semantics (audit S1)', () => {
  it('a scoped run preserves other scenarios whose SBOMs still exist', () => {
    fs.writeFileSync(path.join(tmp, 'docs.cdx.json'), '{}');
    writeManifest(tmp, 'a'.repeat(40), [
      result('docs', {
        outFile: path.join(tmp, 'docs.cdx.json'),
        sha256: 'x',
        componentCount: 1,
        valid: true,
      }),
    ]);
    fs.writeFileSync(path.join(tmp, 'web.cdx.json'), '{}');
    writeManifest(tmp, 'a'.repeat(40), [
      result('web', {
        outFile: path.join(tmp, 'web.cdx.json'),
        sha256: 'y',
        componentCount: 5,
        valid: true,
      }),
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, { sha256: string | null }>;
    };
    expect(Object.keys(manifest.scenarios).toSorted()).toEqual(['docs', 'web']);
    expect(manifest.scenarios.docs?.sha256).toBe('x');
  });

  it('prunes entries whose SBOM file has been deleted', () => {
    fs.writeFileSync(path.join(tmp, 'docs.cdx.json'), '{}');
    writeManifest(tmp, 'a'.repeat(40), [
      result('docs', { outFile: path.join(tmp, 'docs.cdx.json'), sha256: 'x' }),
    ]);
    fs.rmSync(path.join(tmp, 'docs.cdx.json'));
    fs.writeFileSync(path.join(tmp, 'web.cdx.json'), '{}');
    writeManifest(tmp, 'a'.repeat(40), [
      result('web', { outFile: path.join(tmp, 'web.cdx.json'), sha256: 'y' }),
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, unknown>;
    };
    expect(Object.keys(manifest.scenarios)).toEqual(['web']);
  });

  it('tolerates a corrupt existing manifest', () => {
    fs.writeFileSync(path.join(tmp, 'manifest.json'), '{ not json');
    writeManifest(tmp, 'a'.repeat(40), [result('web')]);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, unknown>;
    };
    expect(Object.keys(manifest.scenarios)).toEqual(['web']);
  });

  it('preserves a scenario entry another (concurrent) run wrote directly to disk (finding #17)', () => {
    // Simulate a concurrent `rush sbom` run: it writes its own scenario (B)
    // to manifest.json directly (not via this process's writeManifest),
    // representing another process's write landing on disk. Our run only
    // knows about scenario A; both must survive the merge.
    fs.writeFileSync(path.join(tmp, 'a.cdx.json'), '{}');
    writeManifest(tmp, 'a'.repeat(40), [
      result('a', { outFile: path.join(tmp, 'a.cdx.json'), sha256: 'a-sha' }),
    ]);

    fs.writeFileSync(path.join(tmp, 'b.cdx.json'), '{}');
    const raced = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, unknown>;
    };
    raced.scenarios.b = { mainProject: 'b', file: 'b.cdx.json', sha256: 'b-sha' };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(raced, null, 2));

    writeManifest(tmp, 'a'.repeat(40), [
      result('a', { outFile: path.join(tmp, 'a.cdx.json'), sha256: 'a-sha' }),
    ]);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, { sha256: string | null }>;
    };
    expect(Object.keys(manifest.scenarios).toSorted()).toEqual(['a', 'b']);
    expect(manifest.scenarios.b?.sha256).toBe('b-sha');
  });

  it('releases the exclusive lock after writing (no lockfile left behind)', () => {
    fs.writeFileSync(path.join(tmp, 'a.cdx.json'), '{}');
    writeManifest(tmp, 'a'.repeat(40), [
      result('a', { outFile: path.join(tmp, 'a.cdx.json'), sha256: 'a-sha' }),
    ]);
    expect(fs.existsSync(path.join(tmp, 'manifest.json.lock'))).toBe(false);
  });

  it('releases the lock even when the write throws (no lockfile wedged on failure, verification F4)', () => {
    // Make manifest.json a directory so the atomic rename fails *inside* the
    // locked section (outDir exists → lock is acquired → writeFileAtomic's
    // rename onto a directory throws). The finally must still drop the lock.
    const manifestPath = path.join(tmp, 'manifest.json');
    fs.mkdirSync(manifestPath); // a directory where the file should be
    expect(() => writeManifest(tmp, 'a'.repeat(40), [result('web')])).toThrow();
    expect(fs.existsSync(`${manifestPath}.lock`)).toBe(false);
  });

  it('reclaims a malformed lock (a crashed writer cannot wedge the manifest forever)', () => {
    fs.writeFileSync(path.join(tmp, 'a.cdx.json'), '{}');
    const lockPath = path.join(tmp, 'manifest.json.lock');
    fs.writeFileSync(lockPath, '');

    writeManifest(tmp, 'a'.repeat(40), [
      result('a', { outFile: path.join(tmp, 'a.cdx.json'), sha256: 'a-sha' }),
    ]);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, unknown>;
    };
    expect(Object.keys(manifest.scenarios)).toEqual(['a']);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim an old lock while its owner process is alive', () => {
    const lockPath = path.join(tmp, 'manifest.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-owner' }));
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockPath, old, old);

    const observed = inspectManifestLock(lockPath);

    expect(tryReclaimManifestLock(lockPath, observed)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('does not remove a successor lock after observing an abandoned predecessor', () => {
    const lockPath = path.join(tmp, 'manifest.json.lock');
    fs.writeFileSync(lockPath, 'malformed predecessor');
    const predecessor = inspectManifestLock(lockPath);

    fs.rmSync(lockPath);
    const successor = JSON.stringify({ pid: process.pid, token: 'successor' });
    fs.writeFileSync(lockPath, successor);

    expect(tryReclaimManifestLock(lockPath, predecessor)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(successor);
  });

  it('recovers a reclaim marker stranded by a dead claimant (no publication DoS)', () => {
    const lockPath = path.join(tmp, 'manifest.json.lock');
    fs.writeFileSync(lockPath, 'abandoned lock');
    const observed = inspectManifestLock(lockPath);
    // A reclaimer crashed after taking the marker: its token names a dead pid.
    fs.writeFileSync(`${lockPath}.reclaim`, `999999-${'f'.repeat(24)}`);

    expect(tryReclaimManifestLock(lockPath, observed)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it('does not clear a live claimant\u2019s reclaim marker', () => {
    const lockPath = path.join(tmp, 'manifest.json.lock');
    fs.writeFileSync(lockPath, 'abandoned lock');
    const observed = inspectManifestLock(lockPath);
    const marker = `${process.pid}-${'a'.repeat(24)}`;
    fs.writeFileSync(`${lockPath}.reclaim`, marker);

    expect(tryReclaimManifestLock(lockPath, observed)).toBe(false);
    expect(fs.readFileSync(`${lockPath}.reclaim`, 'utf8')).toBe(marker);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('does not release a successor lock with a predecessor owner token', () => {
    const lockPath = path.join(tmp, 'manifest.json.lock');
    const successor = JSON.stringify({ pid: process.pid, token: 'successor' });
    fs.writeFileSync(lockPath, successor);

    expect(tryReleaseManifestLock(lockPath, 'predecessor')).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(successor);
  });
});

/** A rush repo where the pnpm ladder is blocked (npm), so runSbom exercises
 * orchestration without spawning pnpm. */
function writeNpmRepo(): string {
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repoDir, 'common', 'config', 'rush'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'rush.json'),
    JSON.stringify({
      npmVersion: '10.0.0',
      projects: [{ packageName: 'app-a', projectFolder: 'apps/app-a' }],
    }),
  );
  return repoDir;
}

/** A rush repo where the pnpm ladder is NOT blocked (pnpm >= 11), so an
 * injected {@link CommandRunner} actually gets exercised instead of every
 * rung reporting "unavailable". */
function writePnpmRepo(): string {
  const repoDir = path.join(tmp, 'repo-pnpm');
  fs.mkdirSync(path.join(repoDir, 'common', 'config', 'rush'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'rush.json'),
    JSON.stringify({
      pnpmVersion: '11.11.0',
      projects: [{ packageName: 'app-a', projectFolder: 'apps/app-a' }],
    }),
  );
  const pnpmBin = path.join(repoDir, 'common', 'temp', 'pnpm-local', 'node_modules', '.bin');
  fs.mkdirSync(pnpmBin, { recursive: true });
  fs.writeFileSync(path.join(pnpmBin, 'pnpm'), 'test-only pinned pnpm shim');
  return repoDir;
}

function writeDeployOutput(repoDir: string, folder: string, mainProject: string): string {
  const target = path.join(repoDir, 'common', folder);
  const projectPath = path.join('apps', mainProject.replace(/^@[^/]+\//, ''));
  fs.mkdirSync(path.join(target, projectPath), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'extractor-metadata.json'),
    JSON.stringify({
      mainProjectName: mainProject,
      projects: [{ projectName: mainProject, path: projectPath }],
    }),
  );
  fs.writeFileSync(
    path.join(target, projectPath, 'package.json'),
    JSON.stringify({ name: mainProject, version: '1.0.0' }),
  );
  return target;
}

describe('runSbom orchestration (ladder-blocked repo, no pnpm spawned)', () => {
  it('resolves a relative --target-folder against RUSH_INVOKED_FOLDER, not cwd (audit S2)', () => {
    const repoDir = writeNpmRepo();
    writeDeployOutput(repoDir, 'deploy-x', 'app-a');
    const invoked = path.join(repoDir, 'apps', 'app-a');
    fs.mkdirSync(invoked, { recursive: true });
    process.env.RUSH_INVOKED_FOLDER = invoked;
    const run = runSbom({ cwd: repoDir, targetFolder: '../../common/deploy-x' });
    // The deploy output was found (attempts recorded), proving resolution
    // against the invoked folder; generation itself fails (ladder blocked).
    expect(run.results[0]?.attempts.length).toBeGreaterThan(0);
    expect(run.results[0]?.mainProject).toBe('app-a');
  });

  it('routes --target-folder metadata failures through the scenario error path, exit 1 (audit N5)', () => {
    const repoDir = writeNpmRepo();
    const notDeploy = path.join(repoDir, 'empty');
    fs.mkdirSync(notDeploy);
    const run = runSbom({ cwd: repoDir, targetFolder: notDeploy });
    expect(run.exitCode).toBe(1);
    expect(run.results[0]?.error).toContain('extractor-metadata.json');
  });

  it('rejects multiple --scenario values with --target-folder as a UsageError (exit 2, plan 003)', () => {
    const repoDir = writeNpmRepo();
    expect(() => runSbom({ cwd: repoDir, targetFolder: 'x', scenarios: ['a', 'b'] })).toThrow(
      /at most one --scenario/,
    );
    try {
      runSbom({ cwd: repoDir, targetFolder: 'x', scenarios: ['a', 'b'] });
      expect.unreachable('runSbom should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
    }
  });

  it('expands a multi-name scenario into one job per deployment project (audit S3)', () => {
    const repoDir = writeNpmRepo();
    fs.writeFileSync(
      path.join(repoDir, 'common', 'config', 'rush', 'deploy-apps.json'),
      JSON.stringify({ deploymentProjectNames: ['app-a', 'app-b'] }),
    );
    // only app-b was deployed
    writeDeployOutput(repoDir, 'deploy-apps', 'app-b');
    const run = runSbom({ cwd: repoDir });
    const byKey = new Map(run.results.map((r) => [r.scenario, r]));
    expect([...byKey.keys()].toSorted()).toEqual(['apps--app-a', 'apps--app-b']);
    // app-a: not deployed → explicit, actionable error naming --project
    expect(byKey.get('apps--app-a')?.error).toMatch(/rush deploy --scenario apps --project app-a/);
    // app-b: found its deploy output and walked the (blocked) ladder
    expect(byKey.get('apps--app-b')?.attempts.length).toBeGreaterThan(0);
  });

  it('writes scoped-name SBOM keys with flattened filenames in target-folder mode (audit N1)', () => {
    const repoDir = writeNpmRepo();
    const target = writeDeployOutput(repoDir, 'deploy-scoped', '@scope/app');
    const run = runSbom({ cwd: repoDir, targetFolder: target });
    // ladder blocked → no SBOM written, but the scenario key must be usable:
    // no crash, and the manifest records the scoped key
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'common', 'deploy-sbom', 'manifest.json'), 'utf8'),
    ) as { scenarios: Record<string, unknown> };
    expect(Object.keys(manifest.scenarios)).toEqual(['@scope/app']);
    expect(run.results[0]?.error).toBeDefined(); // blocked ladder, not ENOENT
    expect(run.results[0]?.error).not.toContain('ENOENT');
  });

  it.skipIf(process.platform === 'win32')(
    'leaves a pre-planted old predictable temp symlink untouched and still writes the report',
    () => {
      const repoDir = writePnpmRepo();
      const target = writeDeployOutput(repoDir, 'deploy-x', 'app-a');
      const outDir = path.join(repoDir, 'common', 'deploy-sbom');
      const outFile = path.join(outDir, 'app-a.cdx.json');
      const external = path.join(tmp, 'external-target.txt');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(external, 'must remain untouched');
      fs.symlinkSync(external, `${outFile}.${process.pid}.tmp`, 'file');
      const validBom = JSON.parse(invalidBomJson('app-a')) as Record<string, unknown>;
      validBom.bomFormat = 'CycloneDX';

      const run = runSbom({
        cwd: repoDir,
        targetFolder: target,
        exec: rung1Runner(JSON.stringify(validBom)),
      });

      expect(run.exitCode).toBe(0);
      expect(fs.readFileSync(external, 'utf8')).toBe('must remain untouched');
      expect(fs.existsSync(outFile)).toBe(true);
      expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
    },
  );
});

describe('runSbom SBOM/manifest publication', () => {
  it('does not overwrite an existing artifact that the manifest does not own', () => {
    const repoDir = writePnpmRepo();
    const target = writeDeployOutput(repoDir, 'deploy-x', 'app-a');
    const outDir = path.join(repoDir, 'common', 'deploy-sbom');
    const occupied = path.join(outDir, 'app-a.cdx.json');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(occupied, 'pre-existing artifact');
    const bom = JSON.parse(invalidBomJson('app-a')) as Record<string, unknown>;
    bom.bomFormat = 'CycloneDX';

    const run = runSbom({
      cwd: repoDir,
      targetFolder: target,
      exec: rung1Runner(JSON.stringify(bom)),
    });

    expect(run.exitCode).toBe(0);
    expect(fs.readFileSync(occupied, 'utf8')).toBe('pre-existing artifact');
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as {
      scenarios: Record<string, { file: string }>;
    };
    expect(manifest.scenarios['app-a']?.file).toMatch(/^app-a--[a-f0-9]{64}\.cdx\.json$/);
  });

  it('keeps colliding flattened project names in distinct artifacts across runs', () => {
    const repoDir = writePnpmRepo();
    const firstName = '@a/b__c';
    const secondName = '@a__b/c';
    const firstTarget = writeDeployOutput(repoDir, 'deploy-first', firstName);
    const secondTarget = writeDeployOutput(repoDir, 'deploy-second', secondName);

    for (const [target, project] of [
      [firstTarget, firstName],
      [secondTarget, secondName],
    ] as const) {
      const bom = JSON.parse(invalidBomJson(project)) as Record<string, unknown>;
      bom.bomFormat = 'CycloneDX';
      expect(
        runSbom({ cwd: repoDir, targetFolder: target, exec: rung1Runner(JSON.stringify(bom)) })
          .exitCode,
      ).toBe(0);
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'common', 'deploy-sbom', 'manifest.json'), 'utf8'),
    ) as { scenarios: Record<string, { file: string; sha256: string }> };
    const first = manifest.scenarios[firstName]!;
    const second = manifest.scenarios[secondName]!;
    expect(first.file).not.toBe(second.file);
    for (const entry of [first, second]) {
      const hash = createHash('sha256')
        .update(fs.readFileSync(path.join(repoDir, 'common', 'deploy-sbom', entry.file)))
        .digest('hex');
      expect(entry.sha256).toBe(hash);
    }
  });

  it('records the hash of the exact bytes present after a competing replacement', () => {
    const repoDir = writePnpmRepo();
    const target = writeDeployOutput(repoDir, 'deploy-x', 'app-a');
    const validBom = JSON.parse(invalidBomJson('app-a')) as Record<string, unknown>;
    validBom.bomFormat = 'CycloneDX';
    const renameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renameSync(from, to);
      if (String(to).endsWith('.cdx.json')) fs.appendFileSync(to, ' ');
    });

    try {
      const run = runSbom({
        cwd: repoDir,
        targetFolder: target,
        exec: rung1Runner(JSON.stringify(validBom)),
      });
      expect(run.exitCode).toBe(0);
    } finally {
      renameSpy.mockRestore();
    }

    const outFile = path.join(repoDir, 'common', 'deploy-sbom', 'app-a.cdx.json');
    const actualHash = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'common', 'deploy-sbom', 'manifest.json'), 'utf8'),
    ) as { scenarios: Record<string, { sha256: string }> };
    expect(manifest.scenarios['app-a']?.sha256).toBe(actualHash);
  });
});

/** A schema-invalid CycloneDX document (a required field, `bomFormat`, is
 * deleted from an otherwise well-formed BOM) that still passes generateSbom's
 * own acceptance gate — the root component name matches `mainProject` and
 * there are no shipped projects to omit — so it reaches validateCycloneDx. */
function invalidBomJson(mainProject: string): string {
  const bom: Record<string, unknown> = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: '2026-07-18T00:00:00.000Z',
      component: {
        type: 'application',
        name: mainProject,
        version: '1.0.0',
        purl: `pkg:npm/${mainProject}@1.0.0`,
        'bom-ref': `pkg:npm/${mainProject}@1.0.0`,
      },
    },
    components: [],
    dependencies: [],
  };
  delete bom.bomFormat; // the deleted required field that makes this invalid
  return JSON.stringify(bom);
}

/** Answers rung 1 (`pnpm sbom --ignore-workspace`) with the given BOM JSON,
 * exactly as generate.test.ts's `runner()` fake does — copied rather than
 * imported since that helper is local to generate.test.ts. */
function rung1Runner(bomJson: string): CommandRunner {
  return (cmd) => {
    if (cmd.args.includes('--ignore-workspace')) return { status: 0, stdout: bomJson, stderr: '' };
    throw new Error(`unexpected command in exit-3 fixture: ${cmd.bin} ${cmd.args.join(' ')}`);
  };
}

describe('runSbom exit code 3 (audit N7 — --fail-on-invalid, run.ts:185)', () => {
  it('exits 3 when a generated SBOM fails CycloneDX 1.6 validation and --fail-on-invalid is set', () => {
    const repoDir = writePnpmRepo();
    const target = writeDeployOutput(repoDir, 'deploy-x', 'app-a');
    const run = runSbom({
      cwd: repoDir,
      targetFolder: target,
      failOnInvalid: true,
      exec: rung1Runner(invalidBomJson('app-a')),
    });
    expect(run.exitCode).toBe(3);
    expect(run.results[0]?.valid).toBe(false);
    expect(run.results[0]?.error).toBeUndefined(); // generation succeeded; only validation failed
  });

  it('records valid:false but exits 0 when --fail-on-invalid is unset (same invalid input)', () => {
    const repoDir = writePnpmRepo();
    const target = writeDeployOutput(repoDir, 'deploy-x', 'app-a');
    const run = runSbom({
      cwd: repoDir,
      targetFolder: target,
      exec: rung1Runner(invalidBomJson('app-a')),
    });
    expect(run.exitCode).toBe(0);
    expect(run.results[0]?.valid).toBe(false);
  });
});

describe('runSbom top-level throw classification: UsageError (exit 2) vs plain Error (exit 1) — plan 003', () => {
  it('classifies "not a Rush repo" (findRushRepo failure) as a UsageError', () => {
    // tmp is a fresh mkdtemp dir under os.tmpdir() with no rush.json in it
    // or any parent — findRushRepo's walk-up-to-root throw path.
    try {
      runSbom({ cwd: tmp });
      expect.unreachable('runSbom should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('rush.json');
    }
  });

  it('classifies "no deploy scenarios found" as a UsageError', () => {
    // writeNpmRepo() creates common/config/rush/ but writes no deploy*.json
    // into it, so discoverScenarios finds zero scenarios.
    const repoDir = writeNpmRepo();
    try {
      runSbom({ cwd: repoDir });
      expect.unreachable('runSbom should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain('No deploy scenarios found');
    }
  });

  it('classifies an unknown --scenario name as a UsageError (exit 2, verification F2)', () => {
    // A real deploy-web.json exists, but the user asked for a scenario that
    // does not — a usage error (exit 2), not a runtime failure (exit 1).
    const repoDir = writeNpmRepo();
    fs.writeFileSync(
      path.join(repoDir, 'common', 'config', 'rush', 'deploy-web.json'),
      JSON.stringify({ deploymentProjectNames: ['app-a'] }),
    );
    try {
      runSbom({ cwd: repoDir, scenarios: ['nope'] });
      expect.unreachable('runSbom should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain('"nope" not found');
    }
  });

  it('leaves an unrelated top-level throw (malformed scenario config JSON) as a plain Error, not UsageError', () => {
    // A parse/config failure is NOT reclassified (only "unknown scenario
    // name" is — see the test above) — a malformed file must still map to
    // exit 1 (runtime), not exit 2, proving the split is a narrow allowlist
    // rather than "every throw from scenarios.ts defaults to usage".
    const repoDir = writeNpmRepo();
    fs.writeFileSync(
      path.join(repoDir, 'common', 'config', 'rush', 'deploy-bad.json'),
      '{ not valid json',
    );
    try {
      runSbom({ cwd: repoDir });
      expect.unreachable('runSbom should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain('deploy-bad.json');
    }
  });
});
