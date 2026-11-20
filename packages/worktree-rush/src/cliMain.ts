import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { formatRemoveReport, removeWorktree } from './remove.js';
import { findRepoRoot } from './rushRepo.js';
import { UsageError } from './stages.js';
import { toSelectorError } from './toSelector.js';
import { createWorktree, formatReport } from './worktree.js';

const HELP = `worktree-rush: fast, fully-inherited git worktrees for Rush repos

Usage (via Rush):   rush worktree-create --branch <name> [options]
                    rush worktree-remove --branch <name> [options]
Usage (standalone): worktree-rush create <branch> [options]
                    worktree-rush remove <branch> [options]

create makes the worktree at <parent-of-repo>/.worktrees/<repo>/<branch>,
materializes dependencies, and bootstraps agent state so the first session
starts with zero interactive prompts. Re-running against an existing
same-branch worktree CONVERGES it (repairs/completes the bootstrap) instead
of refusing — re-run is the recovery story.

remove is the symmetric inverse: removes the worktree, deletes the branch
after a read-only proof, and prunes the seeded agent state.

Options (create):
  --branch <name>    Branch for the new worktree (rush form; standalone form
                     takes it as a positional).
  --from <path>      Source checkout to inherit from (default: the repo the
                     command runs in).
  --start-point <ref>
                     Use this local commit only when creating a new local branch.
                     Existing branches/worktrees are never moved; no fetch runs.
  --to <project>     Filtered install: pass through to \`rush install --to\`
                     (repeatable). The checkout stays full; only dependency
                     materialization narrows. Must be an npm package name
                     (@scope/name, lowercase, <=214 chars); else exit 2.
  --no-install       Skip dependency materialization.
  --no-share-store   Don't link the source's pnpm store + build cache into the
                     worktree (sharing is default: installs hardlink from a
                     warm store, builds restore from a warm content-keyed
                     cache; if linking fails the install just runs cold).
  --no-warm-claude   Skip the agent-state bootstrap (~/.claude.json project
                     entry seed + .claude/settings.local.json copy).
  --json             Print the stage-timing report as JSON on stdout.
  -h, --help         Show this help.

Options (remove):
  --branch <name>    Branch whose worktree to remove (standalone form takes
                     it as a positional).
  --from <path>      Source checkout the worktree belongs to.
  --merged-into <ref>
                     Resolve this local commit and prove ancestry or exact tree equivalence before removal.
  --force            Remove a dirty worktree / delete an unmerged branch;
                     mutually exclusive with --merged-into.
  --json             Print the stage-timing report as JSON on stdout.

What "bootstrapped" means (details: WORKTREE-INHERITANCE.md in this package):
tracked files (.mcp.json, .claude/settings.json, skills) arrive via git;
untracked .claude/settings.local.json is copied; machine-level path-keyed
state (trust dialog, allowed tools, MCP approvals) is seeded into
~/.claude.json for the new path.

Exit codes: 0 ok · 1 a stage failed · 2 usage error
`;

/**
 * The CLI's testable core: parses argv, runs worktree-rush, and writes to the
 * given streams. Split out of `cli.ts` so unit tests can drive it in-process
 * (no dist build, no child process) while `cli.ts` stays a thin bin shim.
 */
export function cliMain(
  argv: string[],
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): number {
  let verb: 'create' | 'remove' = 'create';
  let positionalBranch: string | undefined;
  let rest = argv;
  if (argv[0] === 'create' || argv[0] === 'remove') {
    verb = argv[0];
    rest = argv.slice(1);
    if (rest[0] && !rest[0].startsWith('-')) {
      positionalBranch = rest[0];
      rest = rest.slice(1);
    }
  }

  let values: {
    branch?: string;
    from?: string;
    'start-point'?: string;
    'merged-into'?: string;
    to?: string[];
    force?: boolean;
    'no-install'?: boolean;
    'no-share-store'?: boolean;
    'no-warm-claude'?: boolean;
    json?: boolean;
    help?: boolean;
  };
  const startPointOccurrences = rest.filter(
    (arg) => arg === '--start-point' || arg.startsWith('--start-point='),
  ).length;
  if (startPointOccurrences > 1) {
    stderr.write(`--start-point may be specified only once\n\n${HELP}`);
    return 2;
  }
  const mergedIntoOccurrences = rest.filter(
    (arg) => arg === '--merged-into' || arg.startsWith('--merged-into='),
  ).length;
  if (mergedIntoOccurrences > 1) {
    stderr.write(`--merged-into may be specified only once\n\n${HELP}`);
    return 2;
  }
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        branch: { type: 'string' },
        from: { type: 'string' },
        'start-point': { type: 'string' },
        'merged-into': { type: 'string' },
        to: { type: 'string', multiple: true },
        force: { type: 'boolean' },
        'no-install': { type: 'boolean' },
        'no-share-store': { type: 'boolean' },
        'no-warm-claude': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 2;
  }

  const toError = toSelectorError(values.to);
  if (toError) {
    stderr.write(`${toError}\n\n${HELP}`);
    return 2;
  }

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }

  if (values['start-point'] === '') {
    stderr.write(`--start-point requires one non-empty value\n\n${HELP}`);
    return 2;
  }
  if (verb === 'remove' && values['start-point'] !== undefined) {
    stderr.write(`--start-point is valid only for create\n\n${HELP}`);
    return 2;
  }
  if (values['merged-into'] === '') {
    stderr.write(`--merged-into requires one non-empty value\n\n${HELP}`);
    return 2;
  }
  if (verb === 'create' && values['merged-into'] !== undefined) {
    stderr.write(`--merged-into is valid only for remove\n\n${HELP}`);
    return 2;
  }
  if (values['merged-into'] !== undefined && values.force) {
    stderr.write(`--merged-into and --force are mutually exclusive\n\n${HELP}`);
    return 2;
  }

  const branch = values.branch ?? positionalBranch;
  if (!branch) {
    stderr.write(
      `a branch name is required (--branch <name>, or \`worktree-rush ${verb} <branch>\`)\n\n${HELP}`,
    );
    return 2;
  }

  try {
    const { root: sourceRoot } = findRepoRoot(
      values.from ?? process.env.RUSH_INVOKED_FOLDER ?? process.cwd(),
    );
    if (verb === 'remove') {
      const result = removeWorktree(sourceRoot, {
        branch,
        from: values.from,
        force: values.force,
        mergedInto: values['merged-into'],
      });
      if (values.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout.write(formatRemoveReport(result));
      }
      return result.ok ? 0 : 1;
    }
    const result = createWorktree(sourceRoot, {
      branch,
      from: values.from,
      startPoint: values['start-point'],
      to: values.to,
      install: !values['no-install'],
      shareStore: !values['no-share-store'],
      warmClaude: !values['no-warm-claude'],
    });
    if (values.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(formatReport(result));
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    stderr.write(`worktree-rush: ${err instanceof Error ? err.message : String(err)}\n`);
    // Family exit contract: 2 is reserved for usage/validation errors
    // (bad branch name, not in a repo); unexpected runtime throws are 1.
    return err instanceof UsageError ? 2 : 1;
  }
}
