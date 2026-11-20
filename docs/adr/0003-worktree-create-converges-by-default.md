---
status: accepted
date: 2026-07-23
---

# worktree-create converges by default instead of refusing existing paths

A create that dies mid-flight (registry blip, killed process) used to
strand a worktree that existed but had no agent state — and re-running
refused with "already exists", a dead end for non-interactive agents.
Decided (Steve, grill session 2026-07-23): re-running against an existing
SAME-branch worktree converges it — skip the git add, re-link missing
store/cache links, re-run the install, re-seed agent state — so "run it
again" is the entire recovery story. A different branch at the path, or a
directory that is not a worktree, still hard-fails. The claude-bootstrap
stage also moved BEFORE the install so agent state never depends on install
success. Rejected alternatives: an explicit `--repair` flag (non-interactive
callers would have to know to pass it — the resilience would exist but not
be reachable by the agents that need it), and status-quo refusal.
`worktree-remove` follows the same philosophy: already-absent is success.
