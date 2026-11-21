# @butshouldwe/fallow-rush

## 0.1.0 (2026-07-23)

Initial release: `rush fallow` (two-pass Fallow scan with per-project
attribution) and `rush fallow-mcp` / `fallow-rush mcp` (exec passthrough to
Fallow's bundled MCP server). Pinned engine: fallow 3.6.0 (schema_version 7).

Hardening from the pre-release audit (2026-07-18):

- Scoped package names (`@scope/pkg`) no longer crash report writing; report
  filenames flatten to `@scope__pkg`.
- `monorepo.dupes` now reads fallow's real `dupes.stats` shape (was silently
  always empty); health metrics drop config-threshold echoes and strings.
- Narrowed (`--project`) runs are labeled via `projectsFilter` in the rollup
  and rebuild `projects/` so no stale files survive; monorepo aggregates count
  distinct problems (a cycle counts once).
- Markdown tables escape `|` in every cell; Windows-style paths normalize at
  ingestion.
- `parseJsonc` tolerates a UTF-8 BOM; rush.json parse errors name the file.
- `fallow-rush mcp` with an unprepared autoinstaller exits 2 with guidance
  instead of a stack trace.
- `rushChangedProjects` (unimplemented v2 seam) removed from the public API.

### Breaking changes: CLI family contract (2026-07-18)

Aligned with `@butshouldwe/sbom-rush` so the two plugins share one exit
vocabulary and output-flag name before either is adopted anywhere:

- **Exit codes changed.** `--fail-on-findings` now exits **3** (was 1). Scan
  failures and unexpected report-write failures now exit **1** (was 2),
  including the new refusal to delete a non-tool-managed `projects/`
  directory. Usage/config errors stay **2** - including the new scope-clobber
  refusal (see Fixed below).
- **`--out <dir>` replaces `--report <dir>`** as the primary output-directory
  flag (same default: `common/temp/fallow-rush`). `--report` is kept as a
  deprecated alias for one release; passing both errors (exit 2).

### Fixed: report-writer data-loss hazards

- `writeReports` no longer silently clobbers a differently-scoped report: a
  scoped run (`--project`/`--changed-since`) that would land on top of a
  report recorded for a different `--project` scope now refuses (exit 2)
  unless `--out` is given explicitly - naming both scopes in the error.
  Closes [issue #5](https://github.com/butshouldwe/rush/issues/5).
- `writeReports` no longer unconditionally recursively deletes `projects/`:
  it refuses when the directory doesn't look tool-managed (no
  `monorepo.json` beside it, and non-empty) rather than deleting files it
  doesn't own.
- Every report file is now written atomically (temp + rename), matching
  `@butshouldwe/sbom-rush`'s `writeFileAtomic` - a reader never sees a torn
  JSON file mid-write.

### Changed: engine currency

Engine currency (2026-07-18): fallow engine 3.3.0 → 3.6.0; fixtures
re-recorded against the real 3.6.0 binary; no consumer-facing behavior
change (`schema_version` stayed at 7, the `check`/`dupes`/`health` sections
and the `dead-code` subcommand's top-level shape are unchanged, and
`--changed-since` is untouched). `fallow-mcp` now exposes 31 tools (was 30 —
adds `list_suppressions`); `HERMES-WIRING.md` updated. Routine devDep patch
bumps batched in alongside: `@types/node` repinned from `26.1.0` to the
latest `22.x` (`22.20.1`) across all three packages to match the declared
`engines: { node: ">=22" }` floor, `vitest` 4.1.9 → 4.1.10, `tsdown` 0.22.2 →
0.22.9, `knip` 6.26.0 → 6.27.0 (rush-testbed only).

Pre-release testing pinned `publishConfig.registry` to a private registry.
Remove the pin before publishing to the public registry.
