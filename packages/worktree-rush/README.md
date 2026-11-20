# @butshouldwe/worktree-rush

A [Rush](https://rushjs.io) plugin for **fast, fully-inherited git
worktrees**. Adds the `rush worktree-create` and `rush worktree-remove`
custom commands: one step from "I need a branch" to "an agent (or human) can
start working with zero interactive prompts" — and one step back.

## Why

`git worktree add` gives you the branch's files and nothing else. Everything
that actually gates a productive session — installed dependencies, a warm
build cache, trust/permission/MCP state keyed by absolute path — starts from
zero, because a worktree is a new absolute path. This plugin makes the
worktree inherit all of it, eagerly, at creation time, and reports
per-stage timings so "fast" stays measured rather than asserted.

The full inheritance contract (what travels, how, and what deliberately
doesn't) is [WORKTREE-INHERITANCE.md](./WORKTREE-INHERITANCE.md).

## Install

Add the package to a `rush-plugins` autoinstaller and register the plugin
(the autoinstaller name `rush-plugins` is what the shipped command
definitions reference):

```jsonc
// common/autoinstallers/rush-plugins/package.json
{
  "name": "rush-plugins",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@butshouldwe/worktree-rush": "^0.1.0"
  }
}
```

```jsonc
// common/config/rush/rush-plugins.json
{
  "plugins": [
    {
      "packageName": "@butshouldwe/worktree-rush",
      "pluginName": "worktree-rush-plugin",
      "autoinstallerName": "rush-plugins"
    }
  ]
}
```

Then `rush update-autoinstaller --name rush-plugins` and one `rush update`
(plugin manifests load on the next update).

## Use

```bash
rush worktree-create --branch feat/my-feature
rush worktree-create --branch feat/current --start-point origin/main
rush worktree-create --branch feat/big --to @my/app        # filtered install (repeatable; npm package names only, else exit 2)
rush worktree-create --branch fix/x --no-install           # git + state bootstrap only
rush worktree-create --branch feat/y --from /path/to/other-checkout
worktree-rush create feat/my-feature                       # standalone form (positional)

rush worktree-remove --branch feat/my-feature              # the symmetric inverse
worktree-rush remove feat/my-feature --merged-into <merge-commit>
worktree-rush remove feat/my-feature --force               # proof/dirty bypass; identity stays bound
```

`--start-point <ref>` resolves a commit from the existing local Git object
database and uses it only when creating a new local branch. It never fetches.
An existing branch or same-branch worktree converges in place and is never
reset, rebased, or moved; the report says the creation-only start point was
not reapplied. Invalid, ambiguous, and non-commit refs fail before a branch or
worktree directory is created. Without the flag, a new branch still starts at
the source checkout's current `HEAD`.

The worktree lands at `<parent-of-repo>/.worktrees/<repo>/<branch>` —
outside the repo, so it never dirties the source checkout. Stages, each
timed and reported:

1. **git-worktree-add** — resolves the new branch's commit to a full object ID,
   then runs `git worktree add <path> -b <branch> <oid>` (an existing
   branch is checked out instead of `-b`-created; stale worktree
   registrations are pruned first; transient git lock contention from
   parallel creates is retried).
2. **claude-bootstrap** — copies untracked `.claude/settings.local.json` and
   seeds the worktree's `~/.claude.json` project entry (trust dialog, allowed
   tools, MCP approvals) from the source checkout (`--no-warm-claude` skips).
   Runs *before* dependency work: a failed install never strands a worktree
   without agent state. A machine with no Claude state skips gracefully.
3. **share-store-and-cache** — symlinks the source checkout's pnpm store and
   Rush build cache into the worktree (`--no-share-store` opts out). Rush's
   build cache is content-keyed, so a fresh worktree on a new branch restores
   the source checkout's builds directly — measured on a 188-project
   monorepo: cold 9.5s → 0.7s all-from-cache. Sharing is an optimization,
   never a gate: if linking fails (see Windows notes) the install just runs
   cold, with a legible warning.
4. **rush-install** — dependency materialization via the repo's own
   `install-run-rush.js` (`--no-install` skips; `--to <project>` narrows the
   install to a project's dependency graph while the checkout stays full).

### Converge, don't refuse

Re-running `worktree-create` against an existing same-branch worktree
**converges** it: skips the git add, re-links anything missing, re-runs the
install, re-seeds agent state. A create that died mid-flight (network blip,
killed process) is recovered by simply running the same command again. A
path holding a *different* branch, or a directory that isn't a worktree,
still fails hard and legibly.

`worktree-remove` is converge-flavored too: removing an already-absent
worktree or branch is success. Before changing anything, it refuses a dirty
worktree or one checked out on a different branch, binds the worktree's actual
`HEAD` to the removal, and proves the requested branch against the target (the
source checkout's current `HEAD` when no target is supplied). A detached
worktree `HEAD` must also be contained in that target. With `--merged-into
<ref>`, exact tree equivalence is also accepted for the requested branch,
safely recognizing an ordinary squash merge. The target is resolved only from
the local object database—there is no fetch, remote deletion, or merge
inference. Prefer the exact squash commit OID: a later moving ref intentionally
refuses once its tree changes. `--force` bypasses merge proof, detached-HEAD
containment, and dirty-tree protection with an explicit warning, but not the
different-branch refusal or the stage-time `HEAD` identity recheck; it is
mutually exclusive with `--merged-into`. Branch deletion is compare-and-delete
(`update-ref -d <ref> <expected-old-oid>`) and refuses a branch checked out in
any linked worktree; if a checkout appears between that guard and the deletion,
the ref is restored at the exact OID via compare-and-create
(never overwriting a branch recreated by another actor) and the removal
refuses. Successful
removal deletes the
worktree and branch, prunes the seeded `~/.claude.json` entry, and runs
`git worktree prune`; JSON reports `removalProof` (`ancestry`,
`tree-equivalent`, `forced`, or `not-needed`) and the resolved target OID when
applicable.

### Exit codes and machine consumption

Exit codes: 0 ok · 1 a stage failed · 2 usage error. `--json` emits the
stage report as JSON — but note that `rush worktree-create --json` stdout is
prefixed by Rush's own banner and autoinstaller output. For machine
consumption either slice from the first `{`, or invoke the installed bin
directly: `common/autoinstallers/rush-plugins/node_modules/.bin/worktree-rush
create <branch> --json`.

### Non-Rush repositories

Plain git repositories are first-class: the standalone bin creates the
worktree and bootstraps agent state, skipping the Rush-specific stages with
a legible message. Only the git toplevel can be worktree'd — a nested Rush
workspace inside a bigger git repo resolves to the *outer* repo.

## The safety-net hook

Worktrees created by hand with `git worktree add` skip the bootstrap. The
package ships a `SessionStart` hook (`dist/hook.mjs`) that detects an
unbootstrapped `.worktrees/**` session and self-heals (seeding state from
the sibling source checkout). Before seeding anything it verifies the
session's directory really is a linked worktree of that source repo (its
`.git` gitdir pointer must resolve into the source's `.git/worktrees/`) — a
directory merely *shaped* like a worktree never receives trust.

Per-repo wiring (tracked `.claude/settings.json`), guarded so a missing file
is a no-op. A fresh hand-rolled worktree has no `dist/` output of its own,
so the command falls back to the sibling source checkout's installed copy:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "d=\"$CLAUDE_PROJECT_DIR\"; case \"$d\" in */.worktrees/*) r=\"${d%%/.worktrees/*}\"; n=\"${d#*/.worktrees/}\"; s=\"$r/${n%%/*}\";; *) s=\"$d\";; esac; for f in \"$d/common/autoinstallers/rush-plugins/node_modules/@butshouldwe/worktree-rush/dist/hook.mjs\" \"$s/common/autoinstallers/rush-plugins/node_modules/@butshouldwe/worktree-rush/dist/hook.mjs\"; do if [ -f \"$f\" ]; then node \"$f\"; break; fi; done; true"
      }]
    }]
  }
}
```

With the package installed globally (`npm i -g @butshouldwe/worktree-rush`),
a single **user-level** hook in `~/.claude/settings.json` can cover every
repo on the machine instead — point the command at the global install's
absolute `dist/hook.mjs` path. **Only ever reference an absolute path you
control (the global install) in user-level settings** — a repo-relative path
there would hand any untrusted repo code execution at SessionStart. On
Windows (no POSIX `sh` in hooks) use the import-guard form:
`node -e "import('file:///C:/path/to/hook.mjs').catch(()=>{})"`.

The hook is the fallback, not the path: it fires after a session already
started, so the first session may still see one prompt. `rush worktree-create`
bootstraps *eagerly* — that's what actually delivers zero prompts.

## Windows notes

Best-effort, honestly labeled:

- Store/cache sharing tries a directory **junction** when symlinks are
  unavailable (symlinks need Developer Mode or elevation); if both fail,
  creation proceeds and installs run cold — a warning, never a failure.
- The PATH fallback for `rush` (used only when a checkout has no
  `install-run-rush.js`) goes through the shell so `.cmd` shims work.
- Branch names that are valid git refnames but unrepresentable as Windows
  paths (`<>|"`, reserved device names like `con`, `nul`) are rejected up
  front on every platform.
- Hook wiring needs the `node -e` import-guard form (above) — the POSIX `sh`
  snippet does not run under cmd.exe.

## Requirements

Node ≥ 22 · git ≥ 2.30 (the floor CI exercises; older may work). Works in
any git repository — Rush-specific stages activate when `rush.json` is at
the git toplevel. Claude-state seeding activates only when `~/.claude.json`
exists; other agents inherit classes 1–2 and 4 of the contract regardless.

## License

MIT
