#!/usr/bin/env node
/**
 * Aggressive per-edit gate for ALL agents: after a file is touched, oxlint it
 * and TypeScript-7-typecheck its project. oxlint (~ms) and tsgo (~0.2s/project)
 * are fast enough to run on every edit, so agents catch lint/type errors the
 * instant they introduce them instead of at the end of a task.
 *
 * Two invocation modes (one script, every agent):
 *   - Claude Code PostToolUse hook: reads the tool payload as JSON on stdin
 *     and pulls `.tool_input.file_path`.
 *   - Direct / other agents (Codex, humans): pass file paths as argv.
 *
 * Exit 2 with a report on stderr when there are errors — Claude feeds that
 * back to the agent to fix. Exit 0 (silent) when clean or nothing to check.
 * Degrades to exit 0 if the toolchain isn't installed (never blocks editing
 * on a fresh clone).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this script to the Rush root (the folder with rush.json). */
function findRepoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'rush.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir; // fell off the top — degrade gracefully
    dir = parent;
  }
}
const repoRoot = findRepoRoot();

function collectFiles() {
  const argv = process.argv.slice(2);
  if (argv.length > 0) return argv;
  // Hook mode: parse the tool payload from stdin.
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  try {
    const payload = JSON.parse(raw);
    const fp = payload?.tool_input?.file_path;
    return fp ? [fp] : [];
  } catch {
    return [];
  }
}

/** Only source TS the toolchain owns; skip generated/vendored/fixture trees. */
function isCheckable(file) {
  const abs = path.resolve(file);
  if (!/\.(ts|tsx|mts|cts)$/.test(abs)) return false;
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith('..')) return false; // outside the repo
  if (!rel.startsWith(`packages${path.sep}`)) return false;
  return !/(^|[/\\])(dist|node_modules|__fixtures__)([/\\])/.test(rel) &&
    !rel.includes(`rush-testbed${path.sep}fixture${path.sep}`) &&
    !rel.includes(`rush-testbed${path.sep}golden${path.sep}`);
}

/** packages/<pkg>/... -> packages/<pkg> (the project root with a tsconfig). */
function projectDirOf(file) {
  const rel = path.relative(repoRoot, path.resolve(file));
  const parts = rel.split(path.sep);
  return path.join(repoRoot, parts[0], parts[1]);
}

const files = [...new Set(collectFiles().map((f) => path.resolve(f)))].filter(isCheckable);
if (files.length === 0) process.exit(0);
const problems = [];
function processFailure(label, result, structuredLint = false) {
  if (result.error) return `${label} failed to start: ${result.error.message}`;
  if (result.signal) return `${label} terminated by signal ${result.signal}`;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (structuredLint) {
    try {
      const parsed = JSON.parse(result.stdout || '{}');
      const errors = Array.isArray(parsed.diagnostics)
        ? parsed.diagnostics.filter((item) => item?.severity === 'error' || item?.severity === 2)
        : [];
      if (errors.length > 0) {
        return `${label}:\n${errors.map((item) => JSON.stringify(item)).join('\n')}`;
      }
    } catch {
      // Older validator output falls through to the exit-status fallback.
    }
  }
  if (result.status !== 0) {
    return `${label} failed (exit ${String(result.status)}): ${output || 'no diagnostic output'}`;
  }
  return undefined;
}
const projectFiles = new Map();
for (const file of files) {
  const dir = projectDirOf(file);
  const grouped = projectFiles.get(dir) ?? [];
  grouped.push(file);
  projectFiles.set(dir, grouped);
}
// Resolve both tools per project and run them independently. A fresh clone
// with neither installed remains a no-op; one missing tool never suppresses
// the other validator.
for (const [dir, affectedFiles] of projectFiles) {
  const project = path.basename(dir);
  const oxlint = path.join(dir, 'node_modules/.bin/oxlint');
  if (fs.existsSync(oxlint)) {
    const lint = spawnSync(oxlint, ['--format=json', ...affectedFiles], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const failure = processFailure(`oxlint (${project})`, lint, true);
    if (failure) problems.push(failure);
  }
  const tsc = path.join(dir, 'node_modules/.bin/tsc');
  const tsconfig = path.join(dir, 'tsconfig.json');
  if (fs.existsSync(tsc) && fs.existsSync(tsconfig)) {
    const tc = spawnSync(tsc, ['--noEmit', '-p', tsconfig], { cwd: dir, encoding: 'utf8' });
    const failure = processFailure(`tsc (${project})`, tc);
    if (failure) problems.push(failure);
  }
}
if (problems.length > 0) {
  process.stderr.write(
    `Touched-file check found issues — fix before continuing:\n\n${problems.join('\n\n')}\n`,
  );
  process.exit(2);
}
process.exit(0);
