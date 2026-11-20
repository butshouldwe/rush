import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Mocked so the mcp-resolution-failure test below can force `fallowMcpBin`
// to throw without needing a physically broken install (module resolution
// is tied to the calling file's real location on disk, which an in-process
// test can't relocate) — the fake stands in for a broken autoinstaller
// state, exercising cliMain's own catch/exit-2 path directly.
vi.mock('./fallowBin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fallowBin.js')>();
  return { ...actual, fallowMcpBin: vi.fn(actual.fallowMcpBin) };
});

// Mocked so the generic-runtime-error test below can force `scan` to throw a
// plain Error without needing a genuinely broken repo — the fake stands in
// for a scan/report crash, exercising cliMain's non-ScopeConflictError catch
// branch (exit 1) directly.
vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return { ...actual, scan: vi.fn(actual.scan) };
});

import { cliMain } from './cliMain.js';
import { fallowMcpBin } from './fallowBin.js';
import { scan } from './scan.js';
import type { Finding, Rollup } from './types.js';

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

async function runCliInProcess(
  args: string[],
  cwd?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const stdout = captureWriter();
  const stderr = captureWriter();
  const previousCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const status = await cliMain(args, stdout.stream, stderr.stream);
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (cwd) process.chdir(previousCwd);
  }
}

function cliRollup(options: {
  findings?: Finding[];
  unsupported?: Array<{ category: string; count: number }>;
}): Rollup {
  const findings = options.findings ?? [];
  return {
    generator: '@butshouldwe/fallow-rush',
    fallowVersion: '3.6.0',
    generatedAt: '2026-09-12T14:00:00.000Z',
    gitSha: 'a'.repeat(40),
    changedSince: null,
    projectsFilter: null,
    monorepo: {
      totalFindings: findings.length,
      byType: Object.fromEntries(findings.map((finding) => [finding.type, 1])),
      dupes: {},
      health: {},
      unsupported: options.unsupported ?? [],
      rushPlumbing: [],
      unattributed: [],
    },
    projects:
      findings.length > 0
        ? [
            {
              project: 'web-app',
              projectFolder: 'projects/web-app',
              counts: {},
              findings,
            },
          ]
        : [],
  };
}

async function withRushRepo(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'rush.json'), JSON.stringify({ projects: [] }));
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('cli contract (in-process, no build required)', () => {
  it('--help exits 0 and documents every accepted flag', async () => {
    const { status, stdout } = await runCliInProcess(['--help']);
    expect(status).toBe(0);
    for (const flag of [
      '--changed-since',
      '--project',
      '--out',
      '--report',
      '--fail-on-findings',
      '--json',
      'mcp',
    ]) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('Deprecated alias of --out');
    expect(stdout).toMatch(
      /Exit codes:.*0 ok.*1 scan\/report failure.*2 usage\/config error.*3 findings/,
    );
  });

  it('unknown flags exit 2 (usage error) with help on stderr', async () => {
    const { status, stderr } = await runCliInProcess(['--no-such-flag']);
    expect(status).toBe(2);
    expect(stderr).toContain('--no-such-flag');
    expect(stderr).toContain('Usage');
  });

  it('outside a Rush repo exits 2 with an actionable message', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-cli-'));
    try {
      const { status, stderr } = await runCliInProcess([], tmp);
      expect(status).toBe(2);
      expect(stderr).toContain('rush.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('both --out and --report given exits 2 without running a scan', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-cli-'));
    try {
      const { status, stderr } = await runCliInProcess(['--out', 'a', '--report', 'b'], tmp);
      expect(status).toBe(2);
      expect(stderr).toContain('cannot both be given');
      // proves it errored before findRushRepo ran (would otherwise be the
      // "outside a Rush repo" message, not the flag-conflict one)
      expect(stderr).not.toContain('Could not find rush.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--report alone is still accepted (deprecated alias of --out)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-cli-'));
    try {
      const { status, stderr } = await runCliInProcess(['--report', 'somewhere'], tmp);
      // outside a Rush repo, so this still exits 2 - but via findRushRepo,
      // not the flag-conflict check, proving --report alone parses fine.
      expect(status).toBe(2);
      expect(stderr).toContain('rush.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('mcp with the fallow engine unresolvable exits 2 with autoinstaller guidance, no stack trace', async () => {
    vi.mocked(fallowMcpBin).mockImplementationOnce(() => {
      throw new Error("Cannot find module 'fallow/package.json'");
    });
    try {
      const { status, stderr } = await runCliInProcess(['mcp']);
      expect(status).toBe(2);
      expect(stderr).toContain('rush-plugins autoinstaller');
      expect(stderr).not.toContain('at ');
    } finally {
      vi.mocked(fallowMcpBin).mockClear();
    }
  });

  // Finding #15: the generic (non-ScopeConflictError) runtime branch at
  // cliMain.ts:185 had no test forcing it — a refactor could silently
  // mislabel a scan crash as exit 2 and nothing would catch it.
  it('a generic runtime error during scan (not a ScopeConflictError) exits 1', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-cli-'));
    try {
      fs.writeFileSync(path.join(tmp, 'rush.json'), JSON.stringify({ projects: [] }));
      vi.mocked(scan).mockImplementationOnce(() => {
        throw new Error('boom: unexpected scan failure');
      });
      const { status, stderr } = await runCliInProcess([], tmp);
      expect(status).toBe(1);
      expect(stderr).toContain('boom: unexpected scan failure');
    } finally {
      vi.mocked(scan).mockClear();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('an unresolved-import-only rollup exits 3 under --fail-on-findings', async () => {
    const unresolved: Finding = {
      type: 'unresolved-import',
      project: 'web-app',
      path: 'projects/web-app/src/index.ts',
      detail: 'import `./missing` cannot be resolved',
      source: 'root-pass',
    };
    await withRushRepo(async (dir) => {
      vi.mocked(scan).mockImplementationOnce(() => cliRollup({ findings: [unresolved] }));
      const { status } = await runCliInProcess(['--fail-on-findings'], dir);
      expect(status).toBe(3);
    });
  });

  it('an unsupported-only rollup warns on stderr and exits 3 under --fail-on-findings', async () => {
    await withRushRepo(async (dir) => {
      vi.mocked(scan).mockImplementationOnce(() =>
        cliRollup({ unsupported: [{ category: 'policy_violations', count: 2 }] }),
      );
      const { status, stderr } = await runCliInProcess(['--fail-on-findings'], dir);
      expect(status).toBe(3);
      expect(stderr).toContain('unsupported Fallow finding categories: policy_violations (2)');
      expect(stderr.split('\n').filter(Boolean)).toHaveLength(1);
    });
  });

  it('escapes terminal control bytes in human-readable finding details', async () => {
    const finding: Finding = {
      type: 'unresolved-import',
      project: 'web-app',
      path: 'projects/web-app/src/index.ts',
      detail: 'poison\x1b[2Jstill visible',
      source: 'root-pass',
    };
    await withRushRepo(async (dir) => {
      vi.mocked(scan).mockImplementationOnce(() => cliRollup({ findings: [finding] }));
      const { status, stdout } = await runCliInProcess([], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('\x1b');
      expect(stdout).toContain('poison\\x1B[2Jstill visible');
    });
  });

  it('escapes C1 terminal controls (incl. CSI U+009B) in human-readable output', async () => {
    const finding: Finding = {
      type: 'unresolved-import',
      project: 'web-app',
      path: 'projects/web-app/src/index.ts',
      detail: 'poison\u009b2Kstill visible\u0085next',
      source: 'root-pass',
    };
    await withRushRepo(async (dir) => {
      vi.mocked(scan).mockImplementationOnce(() => cliRollup({ findings: [finding] }));
      const { status, stdout } = await runCliInProcess([], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('\u009b');
      expect(stdout).not.toContain('\u0085');
      expect(stdout).toContain('poison\\x9B2Kstill visible\\x85next');
    });
  });

  it('declares rush fallow serialized while leaving fallow-mcp simultaneous-safe', () => {
    const commandLine = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'command-line.json'), 'utf8'),
    ) as { commands: Array<{ name: string; safeForSimultaneousRushProcesses: boolean }> };
    expect(
      commandLine.commands.find((command) => command.name === 'fallow')
        ?.safeForSimultaneousRushProcesses,
    ).toBe(false);
    expect(
      commandLine.commands.find((command) => command.name === 'fallow-mcp')
        ?.safeForSimultaneousRushProcesses,
    ).toBe(true);
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
      expect(stdout).toContain('--fail-on-findings');
    });
  });
});
