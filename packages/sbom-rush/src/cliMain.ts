import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { runSbom, UsageError } from './run.js';
import { validateCycloneDx, ntiaMinimumElements } from './validate.js';

const HELP = `sbom-rush: one CycloneDX SBOM per deployed artifact from rush deploy output

Usage (via Rush):   rush sbom [options]
Usage (standalone): sbom-rush [options]              (run inside a Rush repository)
                     sbom-rush validate <file> [options]  (validate any CycloneDX
                                                            SBOM; no Rush repo needed)

Options:
  --scenario <name>       Limit to the named deploy scenario(s). Repeatable.
                          Default: every common/config/rush/deploy-*.json (and
                          deploy.json as "default"). With --target-folder: at
                          most one, used as the output name.
  --target-folder <path>  Scan this rush deploy output folder directly,
                          bypassing scenario discovery. Relative paths resolve
                          from where you invoked the command (Rush sets
                          RUSH_INVOKED_FOLDER).
  --out <dir>             Output directory (default: common/deploy-sbom;
                          relative paths resolve from the repo root).
  --fail-on-invalid       Exit 3 if any SBOM fails CycloneDX 1.6 validation.
  --json                  Print the run result as JSON on stdout. Note: \`rush
                          sbom --json\` is polluted by Rush's own banner - for
                          machine consumption read manifest.json instead.
  -h, --help              Show this help.

Subcommand:
  validate <file>          Validate an arbitrary CycloneDX document against the
                          same vendored CycloneDX 1.6 schema and NTIA minimum-
                          elements report sbom-rush runs on its own output -
                          for gating vendor-delivered or CI-supplied SBOMs.
                          Standalone-bin only (not reachable via \`rush sbom\`:
                          Rush's command-line.json parameters cannot express a
                          bare positional argument - see README). Takes the
                          same --fail-on-invalid and --json flags as above:
                            sbom-rush validate ./third-party.cdx.json
                            sbom-rush validate ./third-party.cdx.json --fail-on-invalid
                            sbom-rush validate ./third-party.cdx.json --json

Behavior:
  Requires \`rush deploy\` to have run first: per scenario, the deploy output is
  expected at common/deploy-<scenario>, or common/deploy when it holds that
  deployment's project. A scenario listing several deploymentProjectNames gets
  one SBOM per deployed project (Rush's rush deploy --project model), keyed
  <scenario>--<project>. Generation walks a fallback ladder (deploy-folder pnpm
  sbom → workspace lockfile split+merge → cdxgen) and records the rung used in
  the SBOM's metadata. Output: <scenario>.cdx.json per deployment (scoped names
  flatten: @scope/app -> @scope__app) + manifest.json, which merges across runs
  so a scoped run never drops other scenarios' records.

Exit codes: 0 ok · 1 generation/read failure · 2 usage error · 3 invalid SBOM
(with --fail-on-invalid) - the same vocabulary applies to \`validate\`.
`;

/**
 * The CLI's testable core: parses argv, runs sbom-rush, and writes to the
 * given streams. Split out of `cli.ts` so unit tests can drive it in-process
 * (no dist build, no child process) while `cli.ts` stays a thin bin shim.
 * The `validate` verb is detected here (mirrors fallow-rush's `mcp` verb at
 * fallow-rush/src/cliMain.ts) before the no-verb `parseArgs` runs, so a
 * bare `sbom-rush validate <file>` never falls through to the generation
 * path's strict (no-positionals) parser.
 */
export function cliMain(
  argv: string[],
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): number {
  if (argv[0] === 'validate') {
    return runValidate(argv.slice(1), stdout, stderr);
  }

  let values: {
    scenario?: string[];
    'target-folder'?: string;
    out?: string;
    'fail-on-invalid'?: boolean;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        scenario: { type: 'string', multiple: true },
        'target-folder': { type: 'string' },
        out: { type: 'string' },
        'fail-on-invalid': { type: 'boolean' },
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

  try {
    const run = runSbom({
      cwd: process.cwd(),
      scenarios: values.scenario,
      targetFolder: values['target-folder'],
      out: values.out,
      failOnInvalid: values['fail-on-invalid'],
    });

    if (values.json) {
      const { results, ...rest } = run;
      stdout.write(
        `${JSON.stringify({ ...rest, results: results.map(({ bom: _bom, ...r }) => r) }, null, 2)}\n`,
      );
    } else {
      for (const result of run.results) {
        if (result.error) {
          stdout.write(`✗ ${result.scenario}: ${result.error}\n`);
          for (const attempt of result.attempts) {
            stdout.write(
              `    rung ${attempt.rung} (${attempt.method}): ${attempt.outcome} - ${attempt.detail}\n`,
            );
          }
          continue;
        }
        const rung = result.attempts.find((a) => a.outcome === 'succeeded');
        stdout.write(
          `✓ ${result.scenario} → ${result.outFile} (${result.componentCount} components, ` +
            `rung ${rung?.rung}: ${rung?.method}, schema ${result.valid ? 'VALID' : 'INVALID'}, ` +
            `NTIA minimum elements ${result.ntia?.satisfied ? 'satisfied' : 'not satisfied'})\n`,
        );
        if (result.valid === false) {
          for (const error of result.validationErrors ?? []) stdout.write(`    schema: ${error}\n`);
        }
        for (const field of result.ntia?.fields ?? []) {
          if (!field.present) stdout.write(`    NTIA gap: ${field.field} - ${field.detail}\n`);
        }
      }
      stdout.write(`manifest: ${path.join(run.outDir, 'manifest.json')}\n`);
    }
    return run.exitCode;
  } catch (err) {
    stderr.write(`sbom-rush: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

/**
 * `sbom-rush validate <file>`: runs the already-public {@link validateCycloneDx}
 * and {@link ntiaMinimumElements} against an arbitrary CycloneDX document, so
 * adopters can gate third-party/vendor-supplied SBOMs with the same machinery
 * sbom-rush trusts for its own output (plan 012). Deliberately independent of
 * `findRushRepo` - validating a file needs no Rush repository at all.
 *
 * Exit-code mapping stays in the family's 0/1/2/3 vocabulary (see HELP):
 *   - schema valid                              -> 0 (NTIA gaps are reported,
 *                                                      never fatal - same as
 *                                                      generation's contract)
 *   - schema invalid, no --fail-on-invalid       -> 0 (report only)
 *   - schema invalid, with --fail-on-invalid     -> 3 (the gate)
 *   - missing/extra <file> arg, unknown flag     -> 2 (usage, via UsageError)
 *   - file unreadable or not valid JSON          -> 1 (runtime)
 */
function runValidate(argv: string[], stdout: Writable, stderr: Writable): number {
  let values: { 'fail-on-invalid'?: boolean; json?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'fail-on-invalid': { type: 'boolean' },
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

  try {
    if (positionals.length === 0) {
      throw new UsageError(
        'sbom-rush validate: missing <file> argument. Usage: sbom-rush validate <file> [--fail-on-invalid] [--json]',
      );
    }
    if (positionals.length > 1) {
      throw new UsageError(
        `sbom-rush validate: expected exactly one <file> argument, got ${positionals.length} (${positionals.join(', ')})`,
      );
    }

    const filePath = path.resolve(positionals[0]!);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // Read failures (missing file, permission denied, a directory instead
      // of a file, ...) are runtime/1, not usage/2 - the argument itself was
      // well-formed, the filesystem just couldn't deliver it.
      throw new Error(
        `sbom-rush validate: cannot read "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let bom: unknown;
    try {
      bom = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new Error(
        `sbom-rush validate: "${filePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const { valid, errors } = validateCycloneDx(bom);
    const ntia = ntiaMinimumElements(bom);

    if (values.json) {
      stdout.write(`${JSON.stringify({ file: filePath, valid, errors, ntia }, null, 2)}\n`);
    } else {
      stdout.write(`${filePath}: schema ${valid ? 'VALID' : 'INVALID'} (CycloneDX 1.6)\n`);
      for (const error of errors) stdout.write(`    schema: ${error}\n`);
      stdout.write(`NTIA minimum elements ${ntia.satisfied ? 'satisfied' : 'not satisfied'}\n`);
      for (const field of ntia.fields) {
        if (!field.present) stdout.write(`    NTIA gap: ${field.field} - ${field.detail}\n`);
      }
    }

    return !valid && values['fail-on-invalid'] ? 3 : 0;
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}
