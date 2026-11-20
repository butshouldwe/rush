import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  firstLineOfError,
  generateSbom,
  resolvePnpm,
  shippedProjectInfos,
  windowsQuote,
  type CommandRunner,
} from './generate.js';
import type { CdxBom, DeployScenario, ExtractorMetadata, RushRepo } from './types.js';

/**
 * The fallback ladder state machine (PRD §5.2 / §7), driven with an injected
 * command runner so every rung transition is exercised deterministically —
 * without spawning pnpm or cdxgen.
 */

let tmp: string;
let targetFolder: string;
let trustedToolsDir: string;
let originalPath: string | undefined;

const meta: ExtractorMetadata = {
  mainProjectName: 'web-app',
  projects: [
    { projectName: 'web-app', path: 'projects/web-app' },
    { projectName: 'lib-a', path: 'projects/lib-a' },
  ],
};

const scenario: DeployScenario = {
  name: 'web',
  configPath: '(test)',
  deploymentProjectNames: ['web-app'],
  includeDevDependencies: false,
};

function repo(): RushRepo {
  return { rushJsonFolder: tmp, pnpmVersion: '11.11.0', projects: [] };
}

type Result = { status: number; stdout: string; stderr: string };
const ok = (stdout: string): Result => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string): Result => ({ status: 1, stdout: '', stderr });

/** A complete single-document BOM (what rung 1 / rung 3 emit). */
function singleBom(rootName: string, componentNames: string[]): string {
  const bom: CdxBom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: { type: 'application', name: rootName, version: '1.0.0' } },
    components: componentNames.map((name) => ({
      type: 'library',
      name,
      version: '1.0.0',
      purl: `pkg:npm/${name}@1.0.0`,
      'bom-ref': `pkg:npm/${name}@1.0.0`,
    })),
    dependencies: [],
  };
  return JSON.stringify(bom);
}

/** One line of pnpm `sbom --split` NDJSON (what rung 2 emits, per package). */
function splitLine(rootName: string, components: Array<[string, string]> = []): string {
  const bom: CdxBom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'library',
        name: rootName,
        version: '1.0.0',
        purl: `pkg:npm/${rootName}@1.0.0`,
        'bom-ref': `pkg:npm/${rootName}@1.0.0`,
      },
    },
    components: components.map(([name, version]) => ({
      type: 'library',
      name,
      version,
      purl: `pkg:npm/${name}@${version}`,
      'bom-ref': `pkg:npm/${name}@${version}`,
    })),
    dependencies: [
      {
        ref: `pkg:npm/${rootName}@1.0.0`,
        dependsOn: components.map(([name, version]) => `pkg:npm/${name}@${version}`),
      },
    ],
  };
  return JSON.stringify(bom);
}

function materializeDeployedPackage(name: string, version: string): void {
  const dir = path.join(
    targetFolder,
    'common',
    'temp',
    'node_modules',
    '.pnpm',
    `${name}@${version}`,
    'node_modules',
    name,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
}

function writeTestTool(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, content);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
}

/** Valid rung-2 output: one split per shipped project. */
const rung2Ok = ok([splitLine('web-app'), splitLine('lib-a')].join('\n'));

interface Handlers {
  rung1?: () => Result;
  rung2?: () => Result;
  cdxgenVersion?: () => Result;
  cdxgen?: (outFile: string) => Result;
}

/** Dispatch injected results by inspecting the command the ladder would spawn. */
function runner(handlers: Handlers): CommandRunner {
  return (cmd) => {
    const tool = path.basename(cmd.bin).toLowerCase();
    if (tool.startsWith('cdxgen') && cmd.args.includes('--version')) {
      return handlers.cdxgenVersion?.() ?? fail('cdxgen: command not found');
    }
    if (tool.startsWith('cdxgen')) {
      const outFile = cmd.args[cmd.args.indexOf('-o') + 1]!;
      return handlers.cdxgen?.(outFile) ?? fail('cdxgen run not stubbed');
    }
    if (cmd.args.includes('--split')) return handlers.rung2?.() ?? fail('rung 2 not stubbed');
    if (cmd.args.includes('--ignore-workspace'))
      return handlers.rung1?.() ?? fail('rung 1 not stubbed');
    return fail(`unexpected command: ${cmd.bin} ${cmd.args.join(' ')}`);
  };
}

beforeEach(() => {
  originalPath = process.env.PATH;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-rush-generate-'));
  // rung 2 prechecks that Rush's generated workspace exists
  fs.mkdirSync(path.join(tmp, 'common', 'temp'), { recursive: true });
  targetFolder = path.join(tmp, 'deploy');
  trustedToolsDir = path.join(tmp, 'trusted-tools');
  const inertTool = process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n';
  writeTestTool(trustedToolsDir, 'pnpm', inertTool);
  writeTestTool(trustedToolsDir, 'cdxgen', inertTool);
  process.env.PATH = trustedToolsDir;
  for (const project of meta.projects) {
    const dir = path.join(targetFolder, project.path);
    fs.mkdirSync(dir, { recursive: true });
    const pkg =
      project.projectName === 'web-app'
        ? { name: 'web-app', version: '1.0.0', dependencies: { 'lib-a': 'workspace:*' } }
        : { name: 'lib-a', version: '1.0.0' };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  }
});
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('generateSbom ladder', () => {
  it('records every rung as unavailable when pnpm is blocked and cdxgen is absent', () => {
    const outcome = generateSbom(repo(), scenario, targetFolder, meta, 'pnpm blocked', runner({}));
    expect(outcome.bom).toBeUndefined();
    expect(outcome.rung).toBeUndefined();
    expect(outcome.attempts.map((a) => [a.rung, a.outcome])).toEqual([
      [1, 'unavailable'],
      [2, 'unavailable'],
      [3, 'unavailable'],
    ]);
  });

  it('falls through a non-zero rung 1 to a successful rung 2', () => {
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({ rung1: () => fail('ERR_PNPM_NO_LOCKFILE'), rung2: () => rung2Ok }),
    );
    expect(outcome.rung).toBe(2);
    expect(outcome.bom?.metadata?.component?.name).toBe('web-app');
    expect(outcome.attempts.find((a) => a.rung === 1)?.outcome).toBe('failed');
    expect(outcome.attempts.find((a) => a.rung === 2)?.outcome).toBe('succeeded');
  });

  it('rejects a workspace dependency version that is not materialized in the deployment', () => {
    // rush deploy ships no lockfile, so the selected deployment's materialized
    // package files are the binding evidence. The app version is deliberately
    // unchanged while the workspace split attests a newer third-party version.
    materializeDeployedPackage('ms', '2.1.3');
    const workspaceSplits = ok(
      [splitLine('web-app', [['ms', '2.1.4']]), splitLine('lib-a')].join('\n'),
    );

    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({ rung1: () => fail('ERR_PNPM_NO_LOCKFILE'), rung2: () => workspaceSplits }),
    );

    expect(outcome.bom).toBeUndefined();
    const rung2 = outcome.attempts.find((a) => a.rung === 2);
    expect(rung2?.outcome).toBe('failed');
    expect(rung2?.detail).toMatch(/ms@2\.1\.4.*not materialized.*selected deploy output/s);
  });

  it('rejects rung 2 when it omits a package materialized in the deployment', () => {
    materializeDeployedPackage('left-pad', '1.3.0');

    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({ rung1: () => fail('ERR_PNPM_NO_LOCKFILE'), rung2: () => rung2Ok }),
    );

    expect(outcome.bom).toBeUndefined();
    const rung2 = outcome.attempts.find((attempt) => attempt.rung === 2);
    expect(rung2?.outcome).toBe('failed');
    expect(rung2?.detail).toMatch(
      /selected deploy output contains left-pad@1\.3\.0.*not reported/s,
    );
  });

  it('rejects rung 2 when a non-main shipped project has no generator split', () => {
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({
        rung1: () => fail('ERR_PNPM_NO_LOCKFILE'),
        rung2: () => ok(splitLine('web-app')),
      }),
    );

    expect(outcome.bom).toBeUndefined();
    const rung2 = outcome.attempts.find((a) => a.rung === 2);
    expect(rung2?.outcome).toBe('failed');
    expect(rung2?.detail).toMatch(/no SBOM.*shipped project.*lib-a/s);
  });

  it('falls through rung 2 when a shipped split has no root version', () => {
    const versionless = JSON.parse(splitLine('lib-a')) as CdxBom;
    delete versionless.metadata?.component?.version;

    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({
        rung1: () => fail('ERR_PNPM_NO_LOCKFILE'),
        rung2: () => ok([splitLine('web-app'), JSON.stringify(versionless)].join('\n')),
        cdxgenVersion: () => ok('12.7.1'),
        cdxgen: (outFile) => {
          fs.writeFileSync(outFile, singleBom('web-app', ['lib-a']));
          return ok('');
        },
      }),
    );

    expect(outcome.rung).toBe(3);
    expect(outcome.attempts.find((attempt) => attempt.rung === 2)).toMatchObject({
      outcome: 'failed',
    });
    expect(outcome.attempts.find((attempt) => attempt.rung === 2)?.detail).toMatch(
      /version skew.*lib-a.*1\.0\.0.*missing version/s,
    );
  });

  it('does not throw when rung 1 exits 0 with unparseable JSON — records it and continues', () => {
    // Regression guard: an exit-0 rung emitting malformed JSON must be recorded
    // as a failed attempt and let the ladder proceed, not abort the scenario.
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({ rung1: () => ok('{ not valid json at all'), rung2: () => rung2Ok }),
    );
    expect(outcome.rung).toBe(2);
    const rung1 = outcome.attempts.find((a) => a.rung === 1);
    expect(rung1?.outcome).toBe('failed');
    expect(rung1?.detail).toMatch(/unparseable/);
  });

  it('accepts a complete rung 1 and never attempts rung 2', () => {
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({ rung1: () => ok(singleBom('web-app', ['lib-a', 'ms'])), rung2: () => rung2Ok }),
    );
    expect(outcome.rung).toBe(1);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ rung: 1, outcome: 'succeeded' });
  });

  it('rejects a rung whose SBOM omits a shipped workspace project (acceptance gate)', () => {
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      // rung 1 BOM is missing lib-a → gate fails → fall through to rung 2
      runner({ rung1: () => ok(singleBom('web-app', ['ms'])), rung2: () => rung2Ok }),
    );
    expect(outcome.rung).toBe(2);
    const rung1 = outcome.attempts.find((a) => a.rung === 1);
    expect(rung1?.outcome).toBe('failed');
    expect(rung1?.detail).toMatch(/omits shipped workspace projects: lib-a/);
  });

  it('reaches rung 3 (cdxgen) when both pnpm rungs fail', () => {
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      null,
      runner({
        rung1: () => fail('no lockfile'),
        rung2: () => fail('pnpm sbom exploded'),
        cdxgenVersion: () => ok('12.7.1'),
        cdxgen: (outFile) => {
          fs.writeFileSync(outFile, singleBom('web-app', ['lib-a', 'ms']));
          return ok('');
        },
      }),
    );
    expect(outcome.rung).toBe(3);
    expect(outcome.attempts.find((a) => a.rung === 3)?.outcome).toBe('succeeded');
    // The temp cdxgen file is cleaned up regardless of outcome.
    expect(fs.readdirSync(targetFolder).some((f) => f.startsWith('.sbom-rush-cdxgen-'))).toBe(
      false,
    );
  });

  it('does not throw when rung 3 writes unparseable output — records and cleans up', () => {
    const outcome = generateSbom(
      repo(),
      scenario,
      targetFolder,
      meta,
      'pnpm blocked',
      runner({
        cdxgenVersion: () => ok('12.7.1'),
        cdxgen: (outFile) => {
          fs.writeFileSync(outFile, 'not json');
          return ok('');
        },
      }),
    );
    expect(outcome.bom).toBeUndefined();
    const rung3 = outcome.attempts.find((a) => a.rung === 3);
    expect(rung3?.outcome).toBe('failed');
    expect(rung3?.detail).toMatch(/unparseable/);
    expect(fs.readdirSync(targetFolder).some((f) => f.startsWith('.sbom-rush-cdxgen-'))).toBe(
      false,
    );
  });

  it('does not execute cdxgen found only inside the scanned deploy folder', () => {
    const toolDir = path.join(targetFolder, 'artifact-bin');
    const sentinel = path.join(tmp, 'untrusted-cdxgen-executed');
    const script =
      process.platform === 'win32'
        ? `@echo executed>"${sentinel}"\r\n@echo 12.7.1\r\n`
        : `#!/bin/sh\nprintf executed > '${sentinel}'\nprintf '12.7.1\\n'\n`;
    writeTestTool(toolDir, 'cdxgen', script);
    process.env.PATH = toolDir;

    const outcome = generateSbom(repo(), scenario, targetFolder, meta, 'pnpm blocked');

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(outcome.attempts.find((attempt) => attempt.rung === 3)).toMatchObject({
      outcome: 'unavailable',
      detail: 'no cdxgen on a trusted PATH (current-directory lookup disabled)',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'finds and executes cdxgen from a trusted absolute PATH directory',
    () => {
      const sentinel = path.join(tmp, 'trusted-cdxgen-executed');
      const bom = singleBom('web-app', ['lib-a']);
      writeTestTool(
        trustedToolsDir,
        'cdxgen',
        `#!/bin/sh\n` +
          `if [ "$1" = "--version" ]; then printf '12.7.1\\n'; exit 0; fi\n` +
          `out=''\n` +
          `while [ "$#" -gt 0 ]; do\n` +
          `  if [ "$1" = "-o" ]; then shift; out="$1"; fi\n` +
          `  shift\n` +
          `done\n` +
          `printf '%s' '${bom}' > "$out"\n` +
          `printf executed > '${sentinel}'\n`,
      );
      process.env.PATH = trustedToolsDir;

      const outcome = generateSbom(repo(), scenario, targetFolder, meta, 'pnpm blocked');

      expect(outcome.rung).toBe(3);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('executed');
    },
  );

  it('refuses an escaping main-project path before spawning pnpm', () => {
    const outside = path.join(tmp, 'outside-project');
    fs.mkdirSync(outside);
    fs.writeFileSync(
      path.join(outside, 'package.json'),
      JSON.stringify({ name: 'web-app', version: '1.0.0' }),
    );
    const escapingMeta: ExtractorMetadata = {
      mainProjectName: 'web-app',
      projects: [{ projectName: 'web-app', path: '../outside-project' }],
    };
    let spawnCount = 0;
    const exec: CommandRunner = () => {
      spawnCount += 1;
      return fail('must not spawn');
    };

    expect(() => generateSbom(repo(), scenario, targetFolder, escapingMeta, null, exec)).toThrow(
      /main project.*projects\[\]\.path.*escapes the deploy folder/s,
    );
    expect(spawnCount).toBe(0);
  });
});

describe('shippedProjectInfos (audit S5)', () => {
  it('unions dependencies, peerDependencies, and optionalDependencies for workspace edges', () => {
    const dir = path.join(tmp, 'deploy-edges');
    for (const [name, pkg] of Object.entries({
      'web-app': {
        name: 'web-app',
        version: '1.0.0',
        dependencies: { 'lib-a': 'workspace:*' },
        peerDependencies: { 'lib-b': 'workspace:*' },
        optionalDependencies: { 'lib-c': 'workspace:*' },
        devDependencies: { 'lib-d': 'workspace:*' },
      },
      'lib-a': { name: 'lib-a', version: '1.0.0' },
      'lib-b': { name: 'lib-b', version: '1.0.0' },
      'lib-c': { name: 'lib-c', version: '1.0.0' },
      'lib-d': { name: 'lib-d', version: '1.0.0' },
    })) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify(pkg));
    }
    const edgeMeta = {
      mainProjectName: 'web-app',
      projects: ['web-app', 'lib-a', 'lib-b', 'lib-c', 'lib-d'].map((n) => ({
        projectName: n,
        path: n,
      })),
    };
    const prod = shippedProjectInfos(dir, edgeMeta, false);
    expect(prod.find((p) => p.name === 'web-app')?.workspaceDependencies.toSorted()).toEqual([
      'lib-a',
      'lib-b',
      'lib-c',
    ]);
    const withDev = shippedProjectInfos(dir, edgeMeta, true);
    expect(withDev.find((p) => p.name === 'web-app')?.workspaceDependencies.toSorted()).toEqual([
      'lib-a',
      'lib-b',
      'lib-c',
      'lib-d',
    ]);
  });

  it('explains a missing package.json instead of a raw ENOENT', () => {
    const dir = path.join(tmp, 'deploy-missing');
    fs.mkdirSync(dir, { recursive: true });
    expect(() =>
      shippedProjectInfos(dir, {
        mainProjectName: 'x',
        projects: [{ projectName: 'x', path: 'x' }],
      }),
    ).toThrow(/cannot read .*package\.json.*patternsToExclude/s);
  });

  it('refuses a deployed workspace manifest without a verifiable version', () => {
    const dir = path.join(tmp, 'deploy-versionless');
    fs.mkdirSync(path.join(dir, 'web-app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'web-app', 'package.json'),
      JSON.stringify({ name: 'web-app' }),
    );

    expect(() =>
      shippedProjectInfos(dir, {
        mainProjectName: 'web-app',
        projects: [{ projectName: 'web-app', path: 'web-app' }],
      }),
    ).toThrow(/deployed manifest.*web-app.*valid version/s);
  });
});

describe('resolvePnpm (audit S7)', () => {
  it('prefers the rush-local pnpm silently', () => {
    const local = path.join(tmp, 'common', 'temp', 'pnpm-local', 'node_modules', '.bin');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'pnpm'), '#!/bin/sh\n');
    const resolved = resolvePnpm(repo(), targetFolder);
    expect(resolved.bin).toBe(path.join(local, 'pnpm'));
    expect(resolved.note).toBe('');
  });

  it('falls back to PATH pnpm with a visible, actionable note', () => {
    const resolved = resolvePnpm(repo(), targetFolder);
    expect(resolved.bin).toBe(path.join(trustedToolsDir, 'pnpm'));
    expect(resolved.note).toMatch(/PATH pnpm.*rush install/s);
  });

  it('does not fall back to a pnpm supplied by the deploy folder', () => {
    const toolDir = path.join(targetFolder, 'artifact-bin');
    writeTestTool(toolDir, 'pnpm', process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\n');
    process.env.PATH = toolDir;
    const resolved = resolvePnpm(repo(), targetFolder);
    expect(resolved.bin).toBeUndefined();
    expect(resolved.note).toMatch(/pinned copy is missing.*no trusted PATH pnpm/s);
  });
});

describe('windowsQuote (audit S3 — Windows shell-mode spawn quoting)', () => {
  it('wraps a plain flag in quotes, content unchanged', () => {
    expect(windowsQuote('--filter')).toBe('"--filter"');
  });

  it('quotes a path containing spaces', () => {
    expect(windowsQuote('C:\\Users\\John Doe\\repo')).toBe('"C:\\Users\\John Doe\\repo"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(windowsQuote('say "hi"')).toBe('"say ""hi"""');
  });

  it('neutralizes cmd.exe metacharacters by keeping them inside the quoted region', () => {
    expect(windowsQuote('a&b|c')).toBe('"a&b|c"');
  });
});

describe('firstLineOfError', () => {
  it('picks the first error-looking line and truncates', () => {
    expect(firstLineOfError('warning: x\nERR_PNPM_NO_LOCKFILE broke\nmore', '')).toBe(
      'ERR_PNPM_NO_LOCKFILE broke',
    );
    expect(firstLineOfError('', 'plain output only')).toBe('plain output only');
  });
});
