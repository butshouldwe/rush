#!/usr/bin/env node
/**
 * Fallow 3.3.0 vs Knip 6.26.0 on the identical fixture — wall time +
 * findings parity for the three planted flaws. First data row for the Knip
 * disposition memo (RUSH-PLUGINS-PRD §9); the decision itself is made at
 * work against the real monorepo.
 *
 * Three configurations, because the tools' monorepo models differ:
 *   A. fallow, root pass (monorepo-aware reachability — the fallow-rush pass 1)
 *   B. fallow, root + 6 per-project dep-hygiene passes (the full `rush fallow` work)
 *   C. knip, workspace mode on a /tmp copy of the fixture with a synthesized
 *      root package.json+workspaces (knip requires one; Rush repos have none —
 *      itself a finding)
 *   D. knip, per-project (6 bare runs, no monorepo view)
 *
 * Usage: node harness/benchmark.mjs [--runs N]   (default 3, best-of reported)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testbedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(testbedRoot, 'fixture');
const fallowBin = path.join(testbedRoot, 'node_modules', '.bin', 'fallow');
const knipBin = path.join(testbedRoot, 'node_modules', '.bin', 'knip');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;

const projects = ['build-tool', 'lib-a', 'lib-b', 'lib-c', 'lib-d', 'web-app', 'docs-site'];

function time(fn) {
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    const out = fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    results.push({ ms, out });
  }
  results.sort((a, b) => a.ms - b.ms);
  return { bestMs: results[0].ms, out: results[0].out };
}

function run(bin, args, cwd) {
  return spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

// --- A: fallow root pass ---------------------------------------------------
const fallowRoot = time(() =>
  run(fallowBin, ['--format', 'json', '--quiet', '--no-cache'], fixtureRoot),
);
const fallowRootJson = JSON.parse(fallowRoot.out.stdout);

// --- B: fallow full two-pass (what `rush fallow` does) ----------------------
const fallowFull = time(() => {
  const root = run(fallowBin, ['--format', 'json', '--quiet', '--no-cache'], fixtureRoot);
  const perProject = {};
  for (const project of projects) {
    perProject[project] = run(
      fallowBin,
      ['dead-code', '--format', 'json', '--quiet', '--no-cache'],
      path.join(fixtureRoot, 'projects', project),
    );
  }
  return { root, perProject };
});

// --- C: knip workspace mode on a synthesized copy ---------------------------
const knipTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knip-bench-'));
fs.cpSync(path.join(fixtureRoot, 'projects'), path.join(knipTmp, 'projects'), { recursive: true });
fs.writeFileSync(
  path.join(knipTmp, 'package.json'),
  JSON.stringify({
    name: 'knip-bench-root',
    private: true,
    workspaces: projects.map((p) => `projects/${p}`),
  }),
);
// Fairness: the fixture gives fallow includeEntryExports via .fallowrc.json;
// give knip its equivalent (same semantics, same option name).
fs.writeFileSync(
  path.join(knipTmp, 'knip.json'),
  JSON.stringify({ includeEntryExports: true, ignoreExportsUsedInFile: false }),
);
// knip resolves workspace deps through node_modules; reuse the rush-installed ones
for (const project of projects) {
  const nm = path.join(fixtureRoot, 'projects', project, 'node_modules');
  if (fs.existsSync(nm)) {
    fs.cpSync(nm, path.join(knipTmp, 'projects', project, 'node_modules'), {
      recursive: true,
      dereference: true,
      force: true,
    });
  }
}
const knipWorkspace = time(() =>
  run(knipBin, ['--reporter', 'json', '--no-config-hints'], knipTmp),
);
let knipWorkspaceJson = null;
try {
  knipWorkspaceJson = JSON.parse(knipWorkspace.out.stdout);
} catch {
  /* recorded below */
}

// --- D: knip per-project ----------------------------------------------------
const knipPerProject = time(() => {
  const outputs = {};
  for (const project of projects) {
    outputs[project] = run(
      knipBin,
      ['--reporter', 'json', '--no-config-hints'],
      path.join(fixtureRoot, 'projects', project),
    );
  }
  return outputs;
});

// --- parity ------------------------------------------------------------------
const check = fallowRootJson.check ?? fallowRootJson;
const fallowFindsDeadExport = (check.unused_exports ?? []).some(
  (e) => e.export_name === 'deadHelper',
);
const fallowFullWebApp = JSON.parse(fallowFull.out.perProject['web-app'].stdout);
const fallowWebAppCheck = fallowFullWebApp.check ?? fallowFullWebApp;
const fallowFindsUnusedDep = (fallowWebAppCheck.unused_dependencies ?? []).some(
  (d) => d.package_name === 'mri',
);
const fallowFindsCycle = (check.circular_dependencies ?? []).some((c) => c.is_cross_package);

const knipWsText = JSON.stringify(knipWorkspaceJson ?? {});
const knipFindsDeadExport = knipWsText.includes('deadHelper');
const knipFindsUnusedDep = /mri/.test(knipWsText);
const knipPerProjectText = JSON.stringify(
  Object.fromEntries(Object.entries(knipPerProject.out).map(([k, v]) => [k, v.stdout])),
);
const knipPerFindsDeadExport = knipPerProjectText.includes('deadHelper');
const knipPerFindsUnusedDep = /mri/.test(knipPerProjectText);

const report = {
  date: new Date().toISOString(),
  fixture: 'packages/rush-testbed/fixture (6 projects, 3 planted flaws)',
  runsPerConfiguration: runs,
  wallTimeBestOfMs: {
    'A fallow root pass (monorepo reachability)': Math.round(fallowRoot.bestMs),
    'B fallow full two-pass (rush fallow work)': Math.round(fallowFull.bestMs),
    'C knip workspace mode (synthesized root)': Math.round(knipWorkspace.bestMs),
    'D knip per-project ×6 (no monorepo view)': Math.round(knipPerProject.bestMs),
  },
  parity: {
    'dead export (deadHelper in lib-b)': {
      fallow: fallowFindsDeadExport,
      knipWorkspace: knipFindsDeadExport,
      knipPerProject: `${knipPerFindsDeadExport} (no consumer view: cannot distinguish dead from externally-consumed)`,
    },
    'unused dependency (mri in web-app)': {
      fallow: fallowFindsUnusedDep,
      knipWorkspace: knipFindsUnusedDep,
      knipPerProject: knipPerFindsUnusedDep,
    },
    'circular dependency (lib-c ⇄ lib-d)': {
      fallow: fallowFindsCycle,
      knipWorkspace: 'not a knip feature',
      knipPerProject: 'not a knip feature',
    },
  },
  notes: [
    'Wall times at this fixture scale (6 tiny projects) are startup-dominated and do NOT reproduce the research-reported "5–41× vs Knip" — that claim concerns large repos and can only be tested against the real monorepo. Parity is the decisive column here.',
    'knip requires a root package.json with workspaces; the Rush fixture has none, so configuration C runs on a /tmp copy with a synthesized root — that adapter work is exactly what a knip-rush plugin would have to do.',
    'fallow discovered the Rush workspace natively with zero configuration beyond .fallowrc.json.',
    `knip workspace-mode ${knipWorkspaceJson ? 'parsed' : 'FAILED to parse'} (exit ${knipWorkspace.out.status}).`,
  ],
};

fs.rmSync(knipTmp, { recursive: true, force: true });

// tmp/ is gitignored — benchmark output must never dirty the tree (§0).
const outDir = path.join(testbedRoot, 'tmp', 'benchmark');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'BENCHMARK.json'), `${JSON.stringify(report, null, 2)}\n`);

const md = [
  '# Fallow 3.3.0 vs Knip 6.26.0 — fixture benchmark',
  '',
  `Generated ${report.date} · best-of-${runs} wall times · fixture: ${report.fixture}`,
  '',
  '| Configuration | Wall time (ms) |',
  '|---|---|',
  ...Object.entries(report.wallTimeBestOfMs).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## Findings parity (the three planted flaws)',
  '',
  '| Planted flaw | fallow | knip (workspace) | knip (per-project) |',
  '|---|---|---|---|',
  ...Object.entries(report.parity).map(
    ([flaw, r]) => `| ${flaw} | ${r.fallow} | ${r.knipWorkspace} | ${r.knipPerProject} |`,
  ),
  '',
  '## Notes',
  '',
  ...report.notes.map((n) => `- ${n}`),
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'BENCHMARK.md'), md);

console.log(md);
