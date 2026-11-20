import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { findRushRepo } from './rushRepo.js';
import { scan } from './scan.js';
import { guardDefaultReportDir, ScopeConflictError, writeReports } from './report.js';
import { fallowMcpBin, fallowVersion } from './fallowBin.js';

const HELP = `fallow-rush: Fallow codebase intelligence across a Rush monorepo

Usage (via Rush):   rush fallow [options]        rush fallow-mcp
Usage (standalone): fallow-rush [options]        fallow-rush mcp

Options:
  --changed-since <ref>   Only report issues in files changed since this git
                          ref (passed through to fallow).
  --project <name>        Narrow to the named Rush project(s). Repeatable.
                          Narrows project rollups, aggregate counts, and the
                          --fail-on-findings gate; monorepo-wide dupes/health
                          and the root pass are unaffected. The rollup records
                          the filter in "projectsFilter".
  --out <dir>             Report directory (default: common/temp/fallow-rush;
                          relative paths resolve from the repo root). Writes
                          monorepo.{json,md} + projects/<name>.{json,md}
                          (scoped names flatten: @scope/pkg -> @scope__pkg). A
                          scoped run (--project/--changed-since) that would
                          overwrite a report recorded for a different project
                          scope refuses (exit 2) unless --out is given
                          explicitly - pass a fresh directory, or delete the
                          existing one, to proceed.
  --report <dir>          Deprecated alias of --out (will be removed in a
                          future release). Error (exit 2) if both --out and
                          --report are given.
  --fail-on-findings      Exit 3 when any attributed finding or unsupported
                          Fallow category exists (CI gate; with --project,
                          attributed findings gate selected projects only).
  --json                  Print the rollup JSON on stdout. Note: \`rush fallow
                          --json\` is polluted by Rush's own banner - for
                          machine consumption exec the autoinstaller bin
                          directly or read <report-dir>/monorepo.json.
  -h, --help              Show this help.

Subcommand:
  mcp                     Exec fallow's bundled MCP server (stdio passthrough;
                          must be the first argument, remaining args are
                          forwarded to fallow-mcp).
                          Wire-up snippet: see HERMES-WIRING.md in this package.

Scanning is two-pass: a monorepo-aware root pass (reachability: unused
exports/files, cross-package cycles) plus a per-project pass for package.json
dependency hygiene, merged into per-project rollups keyed by rush.json.
Reporting only; fallow's auto-fix is deliberately not exposed.

Exit codes: 0 ok · 1 scan/report failure · 2 usage/config error · 3 findings with --fail-on-findings
`;

function isControlCode(code: number): boolean {
  return (
    (code >= 0 && code <= 8) ||
    (code >= 11 && code <= 31) ||
    code === 127 ||
    (code >= 0x80 && code <= 0x9f) // C1 range, incl. CSI (U+009B)
  );
}

function terminalText(text: string): string {
  return [...text.replace(/\r\n|\r|\n/g, ' ')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return isControlCode(code)
        ? `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`
        : character;
    })
    .join('');
}

/**
 * The CLI's testable core: parses argv, runs fallow-rush, and writes to the
 * given streams. Split out of `cli.ts` so unit tests can drive it in-process
 * (no dist build, no child process) while `cli.ts` stays a thin bin shim. The
 * `mcp` subcommand keeps using real `spawn` — it stays here untouched, since
 * it is a stdio passthrough rather than something that writes to
 * stdout/stderr itself.
 */
export async function cliMain(
  argv: string[],
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): Promise<number> {
  if (argv[0] === 'mcp') {
    // Thin exec passthrough to fallow's bundled MCP server: no wrapping, no
    // re-serving — the MCP client speaks to fallow-mcp directly over
    // inherited stdio. Remaining argv is forwarded to fallow-mcp verbatim.
    let bin: string;
    try {
      bin = fallowMcpBin();
    } catch {
      stderr.write(
        'fallow-rush mcp: the pinned fallow engine is not installed next to this plugin. ' +
          'Run any rush command (e.g. `rush update`) to prepare the rush-plugins autoinstaller, ' +
          'then retry. Wiring notes: HERMES-WIRING.md in @butshouldwe/fallow-rush.\n',
      );
      return 2;
    }
    // bin is fallow-mcp's own `#!/usr/bin/env node` launcher script (see
    // fallowBin.ts): launch it through this process's node (process.execPath)
    // rather than executing it directly, so the shebang isn't relied on
    // (POSIX-only; a direct shell:false spawn of it fails on Windows).
    const child = spawn(process.execPath, [bin, ...argv.slice(1)], { stdio: 'inherit' });
    return await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', (err) => {
        stderr.write(`fallow-rush mcp: ${err.message}\n`);
        resolve(2);
      });
    });
  }

  let values: {
    'changed-since'?: string;
    project?: string[];
    report?: string;
    out?: string;
    'fail-on-findings'?: boolean;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'changed-since': { type: 'string' },
        project: { type: 'string', multiple: true },
        report: { type: 'string' },
        out: { type: 'string' },
        'fail-on-findings': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 2;
  }

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }

  if (values.out !== undefined && values.report !== undefined) {
    stderr.write(
      `fallow-rush: --out and --report cannot both be given (--report is a deprecated alias of --out) - pick one.\n\n${HELP}`,
    );
    return 2;
  }

  // findRushRepo + argv-shaped problems are usage/config errors (exit 2);
  // once we're inside a real Rush repo with valid args, failures are
  // scan/report runtime failures (exit 1) - split from the block below so
  // the two error classes don't get conflated.
  let repo: ReturnType<typeof findRushRepo>;
  try {
    repo = findRushRepo(process.env.RUSH_INVOKED_FOLDER ?? process.cwd());
  } catch (err) {
    stderr.write(`fallow-rush: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const output = values.out ?? values.report;
  const explicitOut = output !== undefined;
  try {
    const reportDir =
      output !== undefined
        ? path.resolve(repo.rushJsonFolder, output)
        : path.join(repo.rushJsonFolder, 'common', 'temp', 'fallow-rush');
    if (!explicitOut) guardDefaultReportDir(reportDir);
    const rollup = scan(repo, {
      changedSince: values['changed-since'],
      projects: values.project,
    });
    if (rollup.monorepo.unsupported.length > 0) {
      stderr.write(
        `fallow-rush: unsupported Fallow finding categories: ${rollup.monorepo.unsupported
          .map(({ category, count }) => `${terminalText(category)} (${count})`)
          .join(', ')}\n`,
      );
    }
    writeReports(rollup, reportDir, { explicitOut });

    if (values.json) {
      stdout.write(`${JSON.stringify(rollup, null, 2)}\n`);
    } else {
      stdout.write(
        `fallow ${fallowVersion()} · ${rollup.monorepo.totalFindings} attributed finding(s)` +
          `${rollup.changedSince ? ` since ${terminalText(rollup.changedSince)}` : ''}\n`,
      );
      for (const project of rollup.projects) {
        if (project.findings.length === 0) continue;
        stdout.write(`  ${terminalText(project.project)}: ${project.findings.length}\n`);
        for (const finding of project.findings) {
          stdout.write(`    - [${terminalText(finding.type)}] ${terminalText(finding.detail)}\n`);
        }
      }
      if (rollup.monorepo.rushPlumbing.length > 0) {
        stdout.write(`  (rush plumbing, excluded: ${rollup.monorepo.rushPlumbing.length})\n`);
      }
      stdout.write(`reports: ${terminalText(reportDir)}\n`);
    }
    return values['fail-on-findings'] &&
      (rollup.monorepo.totalFindings > 0 || rollup.monorepo.unsupported.length > 0)
      ? 3
      : 0;
  } catch (err) {
    stderr.write(
      `fallow-rush: ${terminalText(err instanceof Error ? err.message : String(err))}\n`,
    );
    return err instanceof ScopeConflictError ? 2 : 1;
  }
}
