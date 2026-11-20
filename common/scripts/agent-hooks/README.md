# Per-edit / per-commit checking (all agents)

`check-touched.mjs` oxlints and TypeScript-7-typechecks the files it's given.
oxlint (~ms) and the native `tsc` (~0.2s/project) are fast enough to run on
every edit, so lint/type errors are caught the instant they're introduced.

One script, every agent:

- **Claude / Fable** — `.claude/settings.json` `PostToolUse` hook (matcher
  `Edit|Write|MultiEdit`) runs it after every file edit; it reads the tool
  payload from stdin. Exit 2 feeds the errors back so the agent fixes them.
- **Everyone (humans, Codex, CI)** — `common/git-hooks/pre-commit`, installed
  into `.git/hooks` by `rush install`, runs it on staged `.ts` files.
- **Codex** — its `.agents/` config wires a post-edit command; point it at
  `node common/scripts/agent-hooks/check-touched.mjs <file>` (argv mode).
- **Manual** — `node common/scripts/agent-hooks/check-touched.mjs <files...>`.

Non-source paths (dist, node_modules, fixtures, goldens, docs, JSON) are
skipped; a missing toolchain (fresh clone) degrades to a no-op so it never
blocks editing.
