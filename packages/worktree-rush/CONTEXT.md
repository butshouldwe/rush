# worktree-rush

Fast, fully-inherited git worktrees: creation, agent-state bootstrap, and
symmetric removal, as a published Rush plugin.

## Language

**Source checkout**:
The main (non-linked) checkout of a repository that a worktree is created
from and inherits state from.
_Avoid_: parent repo, origin checkout

**Worktree**:
A linked git worktree at `<parent-of-repo>/.worktrees/<repo>/<branch>` —
always outside the source checkout.
_Avoid_: sandbox, clone

**Convention path**:
The canonical worktree location `<parent-of-repo>/.worktrees/<repo>/<branch>`.
_Avoid_: family convention path (published surfaces), worktree dir

**Bootstrap**:
The eager transfer of agent state to a new worktree at creation time:
settings copy plus seed. Runs before dependency work.
_Avoid_: warm-up, provisioning

**Seed**:
Patching the source checkout's trust/permission/MCP keys onto the
worktree's path entry in `~/.claude.json`. Copies exactly the five seeded
keys, never session state.
_Avoid_: sync, clone (of state)

**Prune** (state):
The seed's inverse — deleting a removed worktree's `~/.claude.json` entry.
_Avoid_: cleanup (ambiguous with git worktree prune)

**Converge**:
Re-running create (or remove) against an already-existing (or
already-absent) target to repair/complete it rather than refuse. The
recovery story is "run it again".
_Avoid_: repair mode, idempotent retry

**Share** (store/cache):
Symlinking (or junctioning) the source checkout's pnpm store and Rush build
cache into the worktree. An optimization, never a gate.
_Avoid_: cache inheritance

**Filtered install**:
`--to <project>` narrowing of dependency materialization to a project's
dependency graph; the checkout itself stays full.
_Avoid_: sparse (that means a partial checkout, which this deliberately is not)

**Self-heal**:
The SessionStart hook's reactive bootstrap of a hand-rolled worktree,
gated on the directory being a real linked worktree of the source repo.
_Avoid_: auto-trust
