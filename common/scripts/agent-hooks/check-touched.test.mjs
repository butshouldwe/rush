import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hookSource = path.join(repoRoot, 'common/hooks/pre-commit');
const checkerSource = path.join(repoRoot, 'common/scripts/agent-hooks/check-touched.mjs');
const scratchDirs = [];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([n]) => !n.startsWith('GIT_')));
afterEach(() => scratchDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function temp(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); scratchDirs.push(dir); return dir; }
function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv }); assert.equal(result.status, 0, result.stderr || result.error?.message);
}
function checkerFixture() {
  const fixture = temp('check-touched-run-');
  const checker = path.join(fixture, 'common/scripts/agent-hooks/check-touched.mjs');
  const project = path.join(fixture, 'packages/demo');
  const source = path.join(project, 'src/example.ts');
  write(checker, fs.readFileSync(checkerSource));
  write(path.join(fixture, 'rush.json'), '{}\n');
  write(path.join(project, 'tsconfig.json'), '{}\n');
  write(source, 'export const value = 1;\n');
  return { checker, fixture, project, source };
}
function runChecker({ checker, source }, env = cleanEnv) {
  return spawnSync(process.execPath, [checker, source], { encoding: 'utf8', env });
}
test('pre-commit passes a staged TypeScript filename with spaces and UTF-8 intact', () => {
  const fixture = temp('check-touched-hook-');
  git(fixture, ['init', '-q', '-b', 'main']);
  const hook = path.join(fixture, 'common/hooks/pre-commit');
  const checker = path.join(fixture, 'common/scripts/agent-hooks/check-touched.mjs');
  const capture = path.join(fixture, 'captured.json');
  write(hook, fs.readFileSync(hookSource), 0o755);
  write(checker, "import fs from 'node:fs'; fs.writeFileSync(process.env.CHECK_TOUCHED_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  const staged = 'packages/demo/src/café file.ts';
  write(path.join(fixture, staged), 'export const value = 1;\n');
  git(fixture, ['add', '--', staged]);
  const result = spawnSync('sh', [hook], { cwd: fixture, encoding: 'utf8', env: { ...cleanEnv, CHECK_TOUCHED_CAPTURE: capture } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [staged]);
});
test("check-touched uses the affected project's installed linter", () => {
  const fixture = checkerFixture();
  const capture = path.join(fixture.fixture, 'linter-ran');
  write(path.join(fixture.project, 'node_modules/.bin/oxlint'), '#!/bin/sh\nprintf invoked > "$CHECK_TOUCHED_CAPTURE"\nprintf \'{"diagnostics":[{"severity":"warning"}]}\'\n', 0o755);
  const result = runChecker(fixture, { ...cleanEnv, CHECK_TOUCHED_CAPTURE: capture });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(capture, 'utf8'), 'invoked');
});
test('check-touched reports an installed validator that fails to launch', () => {
  const fixture = checkerFixture();
  write(path.join(fixture.project, 'node_modules/.bin/oxlint'), '#!/definitely/missing\n', 0o755);
  write(path.join(fixture.project, 'node_modules/.bin/tsc'), '#!/bin/sh\nexit 0\n', 0o755);
  const result = runChecker(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /oxlint.*(ENOENT|failed to start)/is);
});
test('check-touched still runs tsc when the linter is absent and reports fallback output', () => {
  const fixture = checkerFixture();
  write(path.join(fixture.project, 'node_modules/.bin/tsc'), '#!/bin/sh\necho "compiler boot failure" >&2\nexit 7\n', 0o755);
  const result = runChecker(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tsc.*demo.*compiler boot failure/is);
});
