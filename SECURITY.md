# Security policy

## Supported versions

All three plugins are pre-1.0. Only the latest published minor of each
package receives fixes; there is no back-porting to older minors.

## Reporting a vulnerability

Report privately via GitHub Security Advisories — use "Report a vulnerability"
under the Security tab at
[github.com/butshouldwe/rush/security/advisories/new](https://github.com/butshouldwe/rush/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Expect an acknowledgment within 7 days.

## Scope

Advisory scope includes generated artifacts, not just source: SBOM output
(`rush sbom`) and Fallow reports (`rush fallow`) can embed repo-internal
values — workspace project names, file paths, dependency graphs — pulled
from the repo being scanned. Treat mishandling of that embedded data (e.g.
path traversal in report filenames, injection through project names) as
in-scope, the same as a defect in the plugin code itself.

`worktree-rush`'s surface is machine-level state, not generated reports:
branch name → `git worktree add`, `~/.claude.json` seeding, and the
`.claude/settings.local.json` copy it performs when bootstrapping a new
worktree. Treat mishandling there (e.g. branch-name injection into the git
invocation, path traversal in the seeded worktree path, or corruption/
clobbering of `~/.claude.json` state) as in-scope, the same as the other
two plugins' generated-artifact surface.
