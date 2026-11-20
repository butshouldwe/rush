import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Mocked so the "--json output shape" test below can hand cliMain a
// synthetic successful RunResult without spawning pnpm/cdxgen or a real
// `rush deploy` — the fake stands in for the real generation ladder, same
// spirit as run.test.ts/generate.test.ts's injected CommandRunner, applied
// at the runSbom boundary since cliMain's signature (argv, stdout, stderr)
// has no lower-level injection point of its own.
vi.mock('./run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run.js')>();
  return { ...actual, runSbom: vi.fn(actual.runSbom) };
});

import { cliMain } from './cliMain.js';
import { runSbom } from './run.js';
import type { RunResult } from './run.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(pkgDir, 'dist', 'cli.mjs');

/** Captures writes into a string instead of a real stream — lets tests drive
 * `cliMain` in-process, no dist build and no child process required. */
function captureWriter(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

function runCliInProcess(
  args: string[],
  cwd?: string,
): { status: number; stdout: string; stderr: string } {
  const stdout = captureWriter();
  const stderr = captureWriter();
  const previousCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const status = cliMain(args, stdout.stream, stderr.stream);
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (cwd) process.chdir(previousCwd);
  }
}

describe('cli contract (in-process, no build required)', () => {
  it('--help exits 0 and documents every accepted flag', () => {
    const { status, stdout } = runCliInProcess(['--help']);
    expect(status).toBe(0);
    for (const flag of ['--scenario', '--target-folder', '--out', '--fail-on-invalid', '--json']) {
      expect(stdout).toContain(flag);
    }
  });

  it('--help documents the validate subcommand', () => {
    const { status, stdout } = runCliInProcess(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('validate');
  });

  it('unknown flags exit 2 (usage error) with help on stderr', () => {
    const { status, stderr } = runCliInProcess(['--no-such-flag']);
    expect(status).toBe(2);
    expect(stderr).toContain('--no-such-flag');
    expect(stderr).toContain('Usage');
  });

  it('outside a Rush repo exits 2 with an actionable message', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-cli-'));
    try {
      const { status, stderr } = runCliInProcess([], tmp);
      expect(status).toBe(2);
      expect(stderr).toContain('rush.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Exit-code family contract (plan 003): usage/config-shaped throws out of
  // runSbom map to 2, everything else maps to 1 — mirrors fallow-rush's
  // ScopeConflictError split (fallow-rush/src/cliMain.ts).
  describe('exit-code contract: usage (2) vs runtime (1) — plan 003', () => {
    function writeRushRepo(dir: string): void {
      fs.mkdirSync(path.join(dir, 'common', 'config', 'rush'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'rush.json'),
        JSON.stringify({
          npmVersion: '10.0.0',
          projects: [{ packageName: 'app-a', projectFolder: 'apps/app-a' }],
        }),
      );
    }

    it('--target-folder combined with more than one --scenario exits 2 (usage error)', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-cli-usage-'));
      try {
        writeRushRepo(tmp);
        const { status, stderr } = runCliInProcess(
          ['--target-folder', 'x', '--scenario', 'a', '--scenario', 'b'],
          tmp,
        );
        expect(status).toBe(2);
        expect(stderr).toContain('at most one --scenario');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('a malformed scenario config file (JSONC parse failure) exits 1 (runtime failure, not usage)', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-cli-runtime-'));
      try {
        writeRushRepo(tmp);
        fs.writeFileSync(
          path.join(tmp, 'common', 'config', 'rush', 'deploy-bad.json'),
          '{ not valid json',
        );
        const { status, stderr } = runCliInProcess([], tmp);
        expect(status).toBe(1);
        expect(stderr).toContain('deploy-bad.json');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('a --target-folder that is not deploy output exits 1 via run.exitCode (no throw at all)', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-cli-not-deploy-'));
      try {
        writeRushRepo(tmp);
        const notDeploy = path.join(tmp, 'empty');
        fs.mkdirSync(notDeploy);
        const { status, stdout } = runCliInProcess(['--target-folder', notDeploy], tmp);
        expect(status).toBe(1);
        expect(stdout).toContain('extractor-metadata.json');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it('--json output shape on a fake-runner success: no results[].bom, exitCode passed through', () => {
    const fakeResult: RunResult = {
      outDir: '/repo/common/deploy-sbom',
      gitSha: 'a'.repeat(40),
      exitCode: 0,
      results: [
        {
          scenario: 'web',
          mainProject: 'web-app',
          attempts: [
            {
              rung: 1,
              method: 'pnpm-sbom-deploy-folder',
              outcome: 'succeeded',
              detail: 'acceptance gate passed',
            },
          ],
          bom: { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 },
          outFile: '/repo/common/deploy-sbom/web.cdx.json',
          sha256: 'deadbeef',
          componentCount: 3,
          valid: true,
        },
      ],
    };
    vi.mocked(runSbom).mockReturnValueOnce(fakeResult);
    try {
      const { status, stdout } = runCliInProcess(['--json']);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout) as {
        exitCode: number;
        results: Array<Record<string, unknown>>;
      };
      expect(parsed.exitCode).toBe(0);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0]).not.toHaveProperty('bom');
      expect(parsed.results[0]?.componentCount).toBe(3);
    } finally {
      vi.mocked(runSbom).mockClear();
    }
  });

  // The `validate <file>` verb (plan 012): runs the already-public
  // validateCycloneDx + ntiaMinimumElements against an arbitrary CycloneDX
  // document, for adopters who want to gate third-party SBOMs with the same
  // machinery sbom-rush trusts for its own output. Exit codes reuse the
  // family contract established by plan 003: schema-valid (or invalid
  // without --fail-on-invalid) -> 0, schema-invalid with --fail-on-invalid
  // -> 3, missing/unreadable/non-JSON file -> 1 (runtime), bad usage
  // (missing or extra positional, unknown flag) -> 2.
  describe('validate subcommand', () => {
    /** A minimal, schema-valid CycloneDX 1.6 document — same shape as
     * validate.test.ts's minimalBom(), duplicated here so this file's CLI
     * tests stay self-contained (no cross-file fixture coupling). */
    function validBom(): Record<string, unknown> {
      return {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
          timestamp: '2026-07-18T00:00:00.000Z',
          tools: { components: [{ type: 'application', name: 'pnpm', version: '11.11.0' }] },
          component: {
            type: 'application',
            name: 'web-app',
            version: '1.0.0',
            purl: 'pkg:npm/web-app@1.0.0',
            'bom-ref': 'pkg:npm/web-app@1.0.0',
          },
        },
        components: [
          {
            type: 'library',
            name: 'ms',
            version: '2.1.3',
            purl: 'pkg:npm/ms@2.1.3',
            'bom-ref': 'pkg:npm/ms@2.1.3',
          },
        ],
        dependencies: [
          { ref: 'pkg:npm/web-app@1.0.0', dependsOn: ['pkg:npm/ms@2.1.3'] },
          { ref: 'pkg:npm/ms@2.1.3', dependsOn: [] },
        ],
      };
    }

    /** Same document with a component `type` the CycloneDX 1.6 schema
     * rejects outright — schema-invalid, not just NTIA-incomplete. */
    function invalidBom(): Record<string, unknown> {
      const bom = validBom();
      (bom.components as Array<Record<string, unknown>>)[0]!.type = 'flying-saucer';
      return bom;
    }

    function tmpFile(name: string, content: unknown): { dir: string; file: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-validate-'));
      const file = path.join(dir, name);
      fs.writeFileSync(
        file,
        typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      );
      return { dir, file };
    }

    it('a schema-valid document exits 0 and reports VALID + an NTIA summary', () => {
      const { dir, file } = tmpFile('valid.cdx.json', validBom());
      try {
        const { status, stdout } = runCliInProcess(['validate', file]);
        expect(status).toBe(0);
        expect(stdout).toContain('VALID');
        expect(stdout).toContain('NTIA minimum elements');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a schema-invalid document exits 0 without --fail-on-invalid, reporting INVALID + errors', () => {
      const { dir, file } = tmpFile('invalid.cdx.json', invalidBom());
      try {
        const { status, stdout } = runCliInProcess(['validate', file]);
        expect(status).toBe(0);
        expect(stdout).toContain('INVALID');
        expect(stdout).toContain('schema:');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a schema-invalid document exits 3 with --fail-on-invalid (the gate)', () => {
      const { dir, file } = tmpFile('invalid.cdx.json', invalidBom());
      try {
        const { status, stdout } = runCliInProcess(['validate', file, '--fail-on-invalid']);
        expect(status).toBe(3);
        expect(stdout).toContain('INVALID');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('NTIA gaps alone (schema-valid) never trip --fail-on-invalid', () => {
      const bom = validBom();
      delete (bom.metadata as Record<string, unknown>).timestamp; // an NTIA gap, still schema-valid
      const { dir, file } = tmpFile('ntia-gap.cdx.json', bom);
      try {
        const { status, stdout } = runCliInProcess(['validate', file, '--fail-on-invalid']);
        expect(status).toBe(0);
        expect(stdout).toContain('not satisfied');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a missing file exits 1 (runtime failure) with an actionable stderr message', () => {
      const { status, stderr } = runCliInProcess([
        'validate',
        '/nonexistent/does-not-exist.cdx.json',
      ]);
      expect(status).toBe(1);
      expect(stderr).toContain('cannot read');
    });

    it('a file that is not valid JSON exits 1 (runtime failure)', () => {
      const { dir, file } = tmpFile('bad.json', '{ not valid json');
      try {
        const { status, stderr } = runCliInProcess(['validate', file]);
        expect(status).toBe(1);
        expect(stderr).toContain('not valid JSON');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a missing <file> argument exits 2 (usage error)', () => {
      const { status, stderr } = runCliInProcess(['validate']);
      expect(status).toBe(2);
      expect(stderr).toContain('missing <file>');
    });

    it('more than one positional argument exits 2 (usage error)', () => {
      const { dir, file } = tmpFile('valid.cdx.json', validBom());
      try {
        const { status, stderr } = runCliInProcess(['validate', file, 'extra-arg']);
        expect(status).toBe(2);
        expect(stderr).toContain('exactly one');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('an unknown flag exits 2 (usage error) with help on stderr', () => {
      const { status, stderr } = runCliInProcess(['validate', '--no-such-flag']);
      expect(status).toBe(2);
      expect(stderr).toContain('Usage');
    });

    it('validate --help exits 0 and shows help mentioning the verb', () => {
      const { status, stdout } = runCliInProcess(['validate', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('validate');
    });

    it('--json prints a structured {file, valid, errors, ntia} shape', () => {
      const { dir, file } = tmpFile('valid.cdx.json', validBom());
      try {
        const { status, stdout } = runCliInProcess(['validate', file, '--json']);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout) as {
          file: string;
          valid: boolean;
          errors: string[];
          ntia: { satisfied: boolean };
        };
        expect(parsed.file).toBe(file);
        expect(parsed.valid).toBe(true);
        expect(parsed.errors).toEqual([]);
        expect(parsed.ntia).toHaveProperty('satisfied');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a JSON null document reports INVALID and exits 3 with --fail-on-invalid', () => {
      const { dir, file } = tmpFile('null.cdx.json', null);
      try {
        const { status, stdout, stderr } = runCliInProcess([
          'validate',
          file,
          '--json',
          '--fail-on-invalid',
        ]);
        const parsed = JSON.parse(stdout) as {
          valid: boolean;
          errors: string[];
          ntia: { satisfied: boolean };
        };
        expect(status).toBe(3);
        expect(stderr).toBe('');
        expect(parsed.valid).toBe(false);
        expect(parsed.errors.length).toBeGreaterThan(0);
        expect(parsed.ntia.satisfied).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['a non-array components value', { ...validBom(), components: {} }],
      ['a null component entry', { ...validBom(), components: [null] }],
    ])('%s reports INVALID instead of aborting validation', (_name, bom) => {
      const { dir, file } = tmpFile('malformed-shape.cdx.json', bom);
      try {
        const { status, stdout, stderr } = runCliInProcess([
          'validate',
          file,
          '--json',
          '--fail-on-invalid',
        ]);
        const parsed = JSON.parse(stdout) as {
          valid: boolean;
          errors: string[];
          ntia: { satisfied: boolean };
        };
        expect(status).toBe(3);
        expect(stderr).toBe('');
        expect(parsed.valid).toBe(false);
        expect(parsed.errors.length).toBeGreaterThan(0);
        expect(parsed.ntia.satisfied).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not require a Rush repository (validate has no rush.json dependency)', () => {
      const { dir, file } = tmpFile('valid.cdx.json', validBom());
      try {
        // Unlike the no-verb path, `validate` never calls findRushRepo — a
        // bare tmpdir with no rush.json must still work.
        const { status } = runCliInProcess(['validate', file], dir);
        expect(status).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // One dist smoke per plugin, proving the built bin still works end to end.
  // Skips (rather than fails) when dist/ hasn't been built, so a build-free
  // `vitest run` still passes — see plan 004.
  describe.skipIf(!fs.existsSync(cliPath))('dist smoke', () => {
    function runCliDist(
      args: string[],
      cwd: string = pkgDir,
    ): { status: number | null; stdout: string; stderr: string } {
      const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }

    it('--help exits 0 via the built dist/cli.mjs', () => {
      const { status, stdout } = runCliDist(['--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('--fail-on-invalid');
    });
  });
});
