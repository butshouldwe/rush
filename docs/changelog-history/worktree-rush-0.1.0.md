# @butshouldwe/worktree-rush

## 0.1.0 (2026-07-23)

### Hardening pass (2026-07-23)

Semantics:

- **Converge-by-default**: re-running `worktree-create` against an existing
  same-branch worktree repairs/completes it (re-link, re-install, re-seed)
  instead of refusing — re-run is the whole recovery story after a
  mid-flight failure. A different branch at the path, or a non-worktree
  directory, still fails hard. An existing branch with no worktree is
  checked out rather than `-b`-recreated; stale worktree registrations are
  pruned before adding.
- **Bootstrap before install**: the Claude-state bootstrap now runs before
  dependency materialization, so a failed install never strands a worktree
  without agent state.
- **`worktree-remove`** (new command): the symmetric inverse — removes the
  worktree, deletes the branch (only if merged; `--force` overrides, also
  for dirty trees), prunes the seeded `~/.claude.json` entry, runs
  `git worktree prune`, and sweeps empty parent directories. Already-absent
  is success.
- **`--to <project>`** (new, repeatable): filtered install via
  `rush install --to` — the checkout stays full, only dependency
  materialization narrows.

Resilience & concurrency:

- Advisory lock serializes concurrent worktree-rush seeds of
  `~/.claude.json` (parallel creates); stale locks are broken; the lock
  never wedges creation. Claude Code's own writer remains handled by a
  fresh re-read immediately before the atomic write.
- Transient git lock contention (`packed-refs.lock` etc.) on parallel
  creates is retried with backoff.
- Store/cache sharing is now an optimization, never a gate: link failures
  degrade to a cold install with a legible warning; dangling links are
  repaired; pre-existing real content is reported truthfully as NOT shared.
- The atomic `~/.claude.json` write preserves the file's mode (a chmod-600
  file stays 600) and cleans up its temp file on failure.
- `--from` is canonicalized (relative paths, trailing slashes, symlinked
  spellings), and the seed probes equivalent spellings of the source key —
  no more silently skipped seeds or `.worktrees` derived inside the repo.
- Root detection is git-toplevel-first: a nested Rush workspace inside a
  bigger git repo resolves to the outer repo instead of deriving a worktree
  path inside the working tree. Unborn-HEAD repos get a purpose-built
  error; submodules are refused legibly.
- Exit codes now follow the family contract strictly: 2 only for
  usage/validation errors, 1 for runtime failures (was: every throw → 2).

Security:

- The SessionStart self-heal hook now verifies the session directory is a
  REAL linked worktree of the source repo (gitdir pointer must resolve into
  the source's `.git/worktrees/`) before seeding trust — a planted
  worktree-shaped directory no longer receives the source's trust and
  allowedTools. The hook also heals only when something would actually
  change (no more rewrite-per-session when the source lacks a trust flag),
  guards each step, and uses an exact entry-point check.

Windows (best-effort, machine-verifiable):

- Directory-junction fallback for store/cache sharing; `.cmd`-shim-safe
  spawning for the PATH `rush` fallback; mixed-separator and
  drive-relative-path handling in the hook; branch names unrepresentable as
  Windows paths (`<>|"`, reserved device names) rejected on every platform.

### Initial release (RUSH-WORKTREE-PRD B0–B3)

- `rush worktree-create` / `worktree-rush create <branch>`: git worktree at
  `<parent-of-repo>/.worktrees/<repo>/<branch>` + shared
  pnpm-store/build-cache symlinks + `rush install` + Claude-state bootstrap
  (settings.local.json copy, `~/.claude.json` trust/permissions/MCP
  seeding), with per-stage timings.
- `WORKTREE-INHERITANCE.md`: the versioned inheritance contract (5 classes).
- `dist/hook.mjs`: SessionStart self-heal hook for hand-rolled worktrees.
- B0 spike results (188-project rushstack clone): worktree add ~140ms;
  shared build cache turns a 9.5s cold build into 0.7s all-from-cache on a
  new branch (content-keyed confirmed); `enable-global-virtual-store`
  installs cleanly but showed no win over store symlinks at this scale, so
  symlink-sharing is the default and GVS is not used.

Known gaps (tracked, deliberate):

- No testbed-fixture integration test yet: creating a worktree of the
  fixture would nest a checkout of the host repo inside itself. Machinery
  verification runs against the rushstack testbed instead. A dedicated
  mini-fixture is the follow-up if this plugin becomes load-bearing for CI.
- Windows code paths are implemented and unit-tested but pending
  verification on a real Windows host.

Pre-release testing pinned `publishConfig.registry` to a private registry.
Remove the pin before publishing to the public registry.
