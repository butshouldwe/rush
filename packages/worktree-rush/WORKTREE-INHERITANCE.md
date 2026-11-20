# What must travel with a worktree — the inheritance contract

**Versioned contract.** When a new inheritance gap is discovered, it becomes
a row here — referenced by the plugin implementation and the consuming
skills, never re-derived from scratch. v2, 2026-07-23 (v1: 2026-07-18).

A worktree is, definitionally, a new absolute path. Everything below is
classified by *where the state actually lives*, because that determines the
fix.

| # | Class | What | How it travels | Owner |
|---|---|---|---|---|
| 1 | Tracked repo files | `.mcp.json`, `.claude/settings.json`, `.claude/skills/**`, `.agents/**`, `AGENTS.md`/`CLAUDE.md` | **Free** — `git worktree add` checks out the branch's tree. Nothing to build; regression-checked, not engineered. | git |
| 2 | Untracked repo-local files | `.claude/settings.local.json` (personal permission allowlist) | **Copied** (not symlinked) at creation time — a worktree may diverge without silently editing every sibling's permissions. Never overwrites an existing target. | `worktree-rush` stage `claude-bootstrap` |
| 3 | Machine-level, path-keyed state | `~/.claude.json` → `projects["<abs path>"]`: `hasTrustDialogAccepted`, `allowedTools`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `hasClaudeMdExternalIncludesApproved` | **Seeded** — the source checkout's entry is patched onto the worktree's path (exactly these five keys; session state like history never travels). Atomic, mode-preserving write; refuses to touch unparseable files; concurrent worktree-rush processes serialize on an advisory lock (Claude Code's own writer is handled by a re-read immediately before the write — best-effort by nature). On `remove`, the entry is **pruned** — the seed's symmetric inverse. | `worktree-rush` stages `claude-bootstrap` (eager) / `state-prune` + SessionStart hook (self-heal fallback, gated on the directory being a REAL linked worktree of the source repo) |
| 4 | Per-checkout caches | pnpm store (`common/temp/pnpm-store`), Rush build cache (`common/temp/build-cache`) | **Symlinked** from the source checkout (default; `--no-share-store` opts out; Windows falls back to directory junctions). Measured on a 188-project repo: cold build 9.5s → 0.7s all-from-cache on a brand-new branch — cache keys are content-keyed, not branch-keyed. Sharing is an optimization, never a gate: link failure degrades to a cold install with a legible warning; pre-existing real content is reported truthfully as NOT shared; dangling links are repaired. | `worktree-rush` stage `share-store-and-cache` |
| 5 | Workspace-indexed MCPs | codegraph (and any indexer keyed by workspace path) | **Converges, not instant** — a fresh path indexes from zero. Known, accepted gap: "fast to first shell" ≠ "fast to warm index". If a future MCP needs an explicit warm-up, that's a new row + a new bootstrap step. | (documented gap) |

## Bootstrap ordering (v2)

Stage order is `git-worktree-add → claude-bootstrap → share → install`:
agent state (classes 2–3) lands **before** dependency work, so a failed
install never strands a worktree an agent can't even open a session in.
Creation is **converge-by-default** — re-running against an existing
same-branch worktree repairs/completes every class instead of refusing, so
"run it again" is the entire recovery story after any mid-flight failure.

## Non-rows (deliberately not inherited)

- Session history, resumable conversations, per-project caches inside
  `~/.claude.json` — session state starts fresh by design.
- `node_modules` — materialized by `rush install` against the shared store,
  never copied (symlinked stores make this cheap; copying would be slower and
  fork the store).

## Failure modes this contract prevents

- **Trust dialog on first session** (class 3 missing) — hard block for
  non-interactive agents.
- **Silently missing permissions** (class 2 missing) — every Bash allowlist
  prompt re-appears.
- **MCP re-approval prompts** (class 3 `enabledMcpjsonServers` missing).
- **Cold store + cold cache** (class 4 missing) — minutes of install/build
  tax per worktree that the source checkout already paid.
- **Stranded half-created worktrees** (ordering + converge, v2) — a create
  killed mid-install used to leave a directory that blocked re-creation and
  had no agent state; now the state lands first and a re-run converges.
- **Trust seeded onto planted directories** (hook gate, v2) — a directory
  merely shaped like a worktree never receives the source repo's trust.
- **Stale `~/.claude.json` entries for deleted worktrees** (prune, v2).
