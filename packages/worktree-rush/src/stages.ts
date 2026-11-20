import { spawnSync } from 'node:child_process';

/** Usage/validation errors exit 2 (family contract); everything else is a
 * runtime failure (1). Same sentinel pattern as the sibling plugins. */
export class UsageError extends Error {}

/** Injectable process runner (defaults to spawnSync); unit tests drive the
 * orchestration without spawning git or rush. Same seam pattern as the
 * sibling plugins. */
export type ProcessRunner = (
  bin: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error };

/** Quote one argument for the Windows shell-mode spawn path. Policy is
 * identical to sbom-rush's windowsQuote (not imported: zero-workspace-imports
 * contract; parity is pinned by sbom-rush tests): wrap in double
 * quotes and double each embedded `"`. Inside a balanced quoted string
 * cmd.exe treats `&`, `|`, `<`, `>`, `^` and spaces as literal. Limits: cmd.exe
 * still expands `%VAR%` (and `!VAR!` under delayed expansion) inside quotes,
 * so this is not a complete defense; untrusted values must be validated
 * upstream (see toSelector.ts). Not exercised on native Windows by our tests. */
export function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function runProcess(bin: string, args: string[], cwd: string): ReturnType<ProcessRunner> {
  // On Windows, `rush` (and other npm bins) are .cmd shims that Node refuses
  // to spawn without a shell (EINVAL, since the .bat/.cmd hardening). git and
  // node are real executables and never need this. Args are pre-quoted
  // because shell-mode join does no escaping of its own.
  const useShell = process.platform === 'win32' && bin !== 'git' && bin !== 'node';
  const result = useShell
    ? spawnSync(windowsQuote(bin), args.map(windowsQuote), {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        shell: true,
      })
    : spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

export interface Stage {
  name: string;
  ms: number;
  detail: string;
  ok: boolean;
  /** Present only when the stage died on an unexpected throw — the stack
   * makes a genuine bug distinguishable from a domain failure in --json
   * output without polluting the human report. */
  stack?: string;
}

export interface StageOutcome {
  detail: string;
  ok: boolean;
}

/** Timed stage runner shared by create and remove. Throws inside a stage
 * become a failed stage with the error message as detail (stack preserved on
 * the Stage for --json consumers) — the report stays the product even when a
 * step dies. */
export function makeStageRunner(stages: Stage[]) {
  return (name: string, fn: () => StageOutcome): boolean => {
    const start = process.hrtime.bigint();
    let outcome: StageOutcome;
    let stack: string | undefined;
    try {
      outcome = fn();
    } catch (err) {
      outcome = { detail: err instanceof Error ? err.message : String(err), ok: false };
      if (err instanceof Error && err.stack) stack = err.stack;
    }
    stages.push({
      name,
      ms: Number(process.hrtime.bigint() - start) / 1e6,
      ...outcome,
      ...(stack === undefined ? {} : { stack }),
    });
    return outcome.ok;
  };
}

export interface StageReport {
  branch: string;
  stages: Stage[];
  ok: boolean;
}

export function formatStageReport(headline: string, result: StageReport): string {
  const lines = [
    `${result.ok ? '✓' : '✗'} ${headline}`,
    ...result.stages.map(
      (s) =>
        `  ${s.ok ? '✓' : '✗'} ${s.name.padEnd(24)} ${String(Math.round(s.ms)).padStart(7)}ms  ${s.detail}`,
    ),
    `  total ${Math.round(result.stages.reduce((n, s) => n + s.ms, 0))}ms`,
  ];
  return `${lines.join('\n')}\n`;
}
