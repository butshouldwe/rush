import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverScenarios, readExtractorMetadata, resolveTargetFolder } from './scenarios.js';
import { parseJsonc } from './jsonc.js';
import { pnpmLadderRefusal } from './rushRepo.js';
import type { RushRepo } from './types.js';

let tmp: string;

function repo(): RushRepo {
  return { rushJsonFolder: tmp, pnpmVersion: '11.11.0', projects: [] };
}

function writeScenario(
  file: string,
  projectNames: string[],
  extra: Record<string, unknown> = {},
): void {
  const dir = path.join(tmp, 'common', 'config', 'rush');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify({ deploymentProjectNames: projectNames, ...extra }),
  );
}

function writeDeployOutput(folder: string, mainProjectName: string): void {
  const dir = path.join(tmp, 'common', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extractor-metadata.json'),
    JSON.stringify({
      mainProjectName,
      projects: [{ projectName: mainProjectName, path: `projects/${mainProjectName}` }],
    }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-rush-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('discoverScenarios', () => {
  it('discovers every deploy-*.json plus deploy.json as "default", sorted', () => {
    writeScenario('deploy-web.json', ['web-app']);
    writeScenario('deploy-docs.json', ['docs-site']);
    writeScenario('deploy.json', ['legacy-app']);
    const names = discoverScenarios(repo()).map((s) => s.name);
    expect(names).toEqual(['default', 'docs', 'web']);
  });

  it('gives deploy.json and deploy-default.json distinct output identities', () => {
    writeScenario('deploy.json', ['implicit-app']);
    writeScenario('deploy-default.json', ['named-app']);

    const scenarios = discoverScenarios(repo(), ['default']);

    expect(
      scenarios.map((scenario) => [scenario.name, path.basename(scenario.configPath)]),
    ).toEqual([
      ['default', 'deploy.json'],
      ['default--explicit', 'deploy-default.json'],
    ]);
  });

  it('parses JSONC scenario files with comments (the rush-real case)', () => {
    const dir = path.join(tmp, 'common', 'config', 'rush');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'deploy-web.json'),
      `{
        // ship the web app
        "deploymentProjectNames": ["web-app"], /* trailing comma next */
      }`,
    );
    const scenarios = discoverScenarios(repo());
    expect(scenarios[0]?.deploymentProjectNames).toEqual(['web-app']);
  });

  it('narrows with --scenario and rejects unknown names', () => {
    writeScenario('deploy-web.json', ['web-app']);
    writeScenario('deploy-docs.json', ['docs-site']);
    expect(discoverScenarios(repo(), ['web']).map((s) => s.name)).toEqual(['web']);
    expect(() => discoverScenarios(repo(), ['nope'])).toThrow(/"nope" not found/);
  });

  it('reads includeDevDependencies (defaults false)', () => {
    writeScenario('deploy-web.json', ['web-app'], { includeDevDependencies: true });
    writeScenario('deploy-docs.json', ['docs-site']);
    const byName = new Map(discoverScenarios(repo()).map((s) => [s.name, s]));
    expect(byName.get('web')?.includeDevDependencies).toBe(true);
    expect(byName.get('docs')?.includeDevDependencies).toBe(false);
  });
});

describe('resolveTargetFolder', () => {
  it('does not alias implicit and explicitly named default deploy folders', () => {
    writeScenario('deploy.json', ['app']);
    writeScenario('deploy-default.json', ['app']);
    writeDeployOutput('deploy', 'app');
    writeDeployOutput('deploy-default', 'app');
    const scenarios = discoverScenarios(repo(), ['default']);
    const implicit = scenarios.find(
      (scenario) => path.basename(scenario.configPath) === 'deploy.json',
    );
    const explicit = scenarios.find(
      (scenario) => path.basename(scenario.configPath) === 'deploy-default.json',
    );

    expect(resolveTargetFolder(repo(), implicit!, 'app')).toBe(path.join(tmp, 'common', 'deploy'));
    expect(resolveTargetFolder(repo(), explicit!, 'app')).toBe(
      path.join(tmp, 'common', 'deploy-default'),
    );
  });

  it('prefers common/deploy-<scenario>', () => {
    writeScenario('deploy-web.json', ['web-app']);
    writeDeployOutput('deploy-web', 'web-app');
    writeDeployOutput('deploy', 'something-else');
    const [scenario] = discoverScenarios(repo(), ['web']);
    expect(resolveTargetFolder(repo(), scenario!, 'web-app')).toBe(
      path.join(tmp, 'common', 'deploy-web'),
    );
  });

  it('accepts common/deploy only when its main project matches', () => {
    writeScenario('deploy-web.json', ['web-app']);
    writeDeployOutput('deploy', 'web-app');
    const [scenario] = discoverScenarios(repo(), ['web']);
    expect(resolveTargetFolder(repo(), scenario!, 'web-app')).toBe(
      path.join(tmp, 'common', 'deploy'),
    );
  });

  it('fails with actionable guidance when no deploy output exists', () => {
    writeScenario('deploy-web.json', ['web-app']);
    const [scenario] = discoverScenarios(repo(), ['web']);
    expect(() => resolveTargetFolder(repo(), scenario!, 'web-app')).toThrow(
      /rush deploy --scenario web/,
    );
  });
});

describe('pnpmLadderRefusal (§10 runtime manager check)', () => {
  it('accepts pnpm >= 11', () => {
    expect(
      pnpmLadderRefusal({ rushJsonFolder: tmp, pnpmVersion: '11.11.0', projects: [] }),
    ).toBeNull();
  });
  it('refuses politely for pnpm < 11', () => {
    expect(pnpmLadderRefusal({ rushJsonFolder: tmp, pnpmVersion: '9.15.9', projects: [] })).toMatch(
      /requires pnpm >= 11/,
    );
  });
  it('refuses politely for npm/yarn repos', () => {
    expect(pnpmLadderRefusal({ rushJsonFolder: tmp, npmVersion: '10.0.0', projects: [] })).toMatch(
      /uses npm/,
    );
  });
});

describe('parseJsonc', () => {
  it('preserves // and /* */ inside string literals', () => {
    const parsed = parseJsonc<{ url: string; glob: string }>(
      '{ "url": "https://example.com/path", "glob": "src/**/*.ts" /* real comment */ }',
    );
    expect(parsed.url).toBe('https://example.com/path');
    expect(parsed.glob).toBe('src/**/*.ts');
  });

  it('handles escaped quotes in strings', () => {
    expect(parseJsonc<{ s: string }>('{ "s": "a \\" // not a comment" }').s).toBe(
      'a " // not a comment',
    );
  });

  it('strips trailing commas in objects and arrays', () => {
    expect(parseJsonc('{ "a": 1, }')).toEqual({ a: 1 });
    expect(parseJsonc('{ "a": [1, 2, ] }')).toEqual({ a: [1, 2] });
    expect(parseJsonc('{\n  "a": 1,\n  "b": 2,\n}')).toEqual({ a: 1, b: 2 });
  });

  it('does not strip a comma inside a string value that precedes } or ]', () => {
    // The trailing-comma remover must be string-aware: a "," before a closing
    // brace/bracket *inside a string* is data, not a trailing comma.
    expect(parseJsonc<{ s: string }>('{ "s": "a,}" }').s).toBe('a,}');
    expect(parseJsonc<{ s: string }>('{ "s": "x,]y" }').s).toBe('x,]y');
    expect(parseJsonc<{ s: string }>('{ "s": "hi, }" }').s).toBe('hi, }');
    expect(parseJsonc<{ names: string[] }>('{ "names": ["a,]", "b,}"] }').names).toEqual([
      'a,]',
      'b,}',
    ]);
  });
});

describe('extractorMetadataSchema mainProjectName grammar (audit S6)', () => {
  function writeMeta(mainProjectName: string, projectName = mainProjectName): string {
    const dir = path.join(tmp, 'deploy-meta');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extractor-metadata.json'),
      JSON.stringify({ mainProjectName, projects: [{ projectName, path: '.' }] }),
    );
    return dir;
  }

  it('accepts a scoped npm package name', () => {
    const dir = writeMeta('@scope/app');
    expect(readExtractorMetadata(dir).mainProjectName).toBe('@scope/app');
  });

  it('accepts a plain lowercase name', () => {
    const dir = writeMeta('web-app');
    expect(readExtractorMetadata(dir).mainProjectName).toBe('web-app');
  });

  it('rejects a name containing a space, naming the value and the file', () => {
    const dir = writeMeta('web app');
    expect(() => readExtractorMetadata(dir)).toThrow(/mainProjectName.*"web app"/s);
    expect(() => readExtractorMetadata(dir)).toThrow(/extractor-metadata\.json/);
  });

  it('rejects a name containing a semicolon (shell-injection shape)', () => {
    const dir = writeMeta('web;rm -rf /');
    expect(() => readExtractorMetadata(dir)).toThrow(/mainProjectName.*"web;rm -rf \/"/s);
  });

  it('rejects a name containing ".." (path-traversal shape)', () => {
    const dir = writeMeta('../../evil');
    expect(() => readExtractorMetadata(dir)).toThrow(/mainProjectName/);
  });

  it('applies the same grammar to projects[].projectName', () => {
    const dir = writeMeta('web-app', 'lib a');
    expect(() => readExtractorMetadata(dir)).toThrow(/projectName.*"lib a"/s);
  });
});

describe('extractor metadata deploy containment', () => {
  function writeMeta(target: string, projectPath: string): void {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'extractor-metadata.json'),
      JSON.stringify({
        mainProjectName: 'web-app',
        projects: [{ projectName: 'web-app', path: projectPath }],
      }),
    );
  }

  it('rejects a lexical projects[].path traversal and names the entry', () => {
    const target = path.join(tmp, 'deploy-traversal');
    fs.mkdirSync(path.join(tmp, 'sibling'));
    writeMeta(target, '../sibling');

    expect(() => readExtractorMetadata(target)).toThrow(
      /projects\[\]\.path for "web-app".*escapes the deploy folder.*\.\.\/sibling/s,
    );
  });

  it('rejects a symlinked projects[].path that resolves outside and names the entry', () => {
    const target = path.join(tmp, 'deploy-symlink');
    const outside = path.join(tmp, 'outside-project');
    fs.mkdirSync(outside);
    writeMeta(target, 'projects/web-app');
    fs.mkdirSync(path.join(target, 'projects'));
    fs.symlinkSync(
      outside,
      path.join(target, 'projects', 'web-app'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => readExtractorMetadata(target)).toThrow(
      /projects\[\]\.path for "web-app".*escapes the deploy folder after symlink resolution/s,
    );
  });

  it('accepts a normal nested projects[].path', () => {
    const target = path.join(tmp, 'deploy-nested');
    writeMeta(target, 'projects/web-app');
    fs.mkdirSync(path.join(target, 'projects', 'web-app'), { recursive: true });

    expect(readExtractorMetadata(target).projects[0]?.path).toBe('projects/web-app');
  });
});

describe('parseJsonc hardening (audit S4/N4)', () => {
  it('tolerates a UTF-8 BOM, as Rush itself does', () => {
    expect(parseJsonc('﻿{ "a": 1, /* c */ }')).toEqual({ a: 1 });
  });

  it('names the offending file when a scenario config is invalid', () => {
    writeScenario('deploy-web.json', ['web-app']);
    fs.writeFileSync(
      path.join(tmp, 'common', 'config', 'rush', 'deploy-bad.json'),
      '{ "wrongKey": true }',
    );
    let message = '';
    try {
      discoverScenarios(repo());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('deploy-bad.json');
    expect(message).toContain('deploymentProjectNames');
    expect(message).not.toContain('"code":'); // no raw zod issue dump
  });
});
