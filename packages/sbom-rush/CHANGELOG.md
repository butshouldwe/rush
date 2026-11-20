# @butshouldwe/sbom-rush

## 0.1.0 (2026-07-23)

Initial release: `rush sbom` — one validated CycloneDX 1.6 SBOM per deployed
artifact from `rush deploy` output, via a recorded fallback ladder
(deploy-folder `pnpm sbom` → workspace lockfile split+merge → cdxgen).

Hardening from the pre-release audit (2026-07-18, includes verification
against microsoft/rush-example):

- Rung-2 merge drops splits for workspace projects outside the shipped
  closure (devDependency projects were leaking in as phantom components and
  dangling refs), preserves richer registry components on purl collisions,
  prunes unresolvable dependency edges, and fails loudly on
  deploy-vs-workspace version skew.
- `manifest.json` merges across runs — a scoped `--scenario` run no longer
  drops other scenarios' records; writes are atomic (temp + rename).
- Multi-project deploy scenarios (`deploymentProjectNames` with several
  entries) produce one SBOM per deployed project, keyed
  `<scenario>--<project>`, instead of silently handling only the first.
- Relative `--target-folder` resolves against `RUSH_INVOKED_FOLDER` (where
  the user actually stood), not Rush's shellCommand cwd.
- Scoped names (`@scope/app`) flatten in output filenames instead of
  crashing the write; scenario names that would escape the output directory
  are rejected.
- Stamping a legacy `metadata.tools` array now appends a legacy-shaped entry
  (a component-shaped one made the document schema-invalid).
- Workspace dependency edges union `dependencies` + `peerDependencies` +
  `optionalDependencies` (+ dev when the scenario includes them), matching
  what rush deploy's PackageExtractor actually traverses.
- Config errors name the offending file (no more anonymous zod/JSON dumps);
  JSONC parsing tolerates a UTF-8 BOM, as Rush itself does.
- pnpm resolution surfaces its PATH fallback with a `rush install` remedy;
  rung 2 prechecks that `common/temp` exists; NTIA checks include the root
  component; Windows spawns use shell mode for `.cmd` shims (best-effort —
  untested on a real Windows host).
- `extractor-metadata.json`'s `mainProjectName`/`projectName` values are now
  validated against the npm package-name grammar (lowercase, URL-safe,
  optional `@scope/` prefix) before they can reach a downstream shell-mode
  spawn; a legacy uppercase project name from an older `rush deploy` layout
  is now rejected with an actionable error (exit 2) naming the offending
  value and the file, instead of flowing through unchecked.

### Fixed: catch-all exit code honored the runtime/usage split (2026-07-18)

The single outer `catch` around `runSbom` in `cliMain.ts` returned a
hardcoded exit `2` for *every* throw, so genuine runtime/I/O failures
(unreadable scenario config, a ladder rung's write failing) were reported as
"bad arguments" exactly like a real usage error — the documented `1
generation failure · 2 usage error` split was true in the help text but not
in the code. `runSbom` now throws a new, exported `UsageError` (mirroring
`@butshouldwe/fallow-rush`'s `ScopeConflictError` split) for the
argv/config-shaped conditions — not run inside a Rush repo (or an unreadable
`rush.json`), `--target-folder` combined with more than one `--scenario`,
no deploy scenarios found, and an unknown `--scenario <name>` — and `cliMain`
maps `err instanceof UsageError ? 2 : 1`. Every other top-level throw (e.g. a
malformed `deploy-*.json`, a runtime read/parse failure) now correctly exits
`1`. Per-scenario generation failures were already exit 1 via
`run.exitCode` and are unchanged.

Also: `ntiaMinimumElements` no longer throws a raw `TypeError` when a
component is missing `name` (a malformed or third-party-generated component,
e.g. a cdxgen rung-3 root) — it now reports "Component name" as an NTIA gap
like any other missing field, instead of surfacing as a confusing scenario
error.

### Family CLI contract (2026-07-18)

`sbom-rush`'s exit vocabulary (0 ok · 1 generation failure · 2 usage error ·
3 invalid SBOM with `--fail-on-invalid`) and `--out <dir>` output flag are now
the documented shared contract for the plugin family - `@butshouldwe/fallow-rush`
aligned its own exit codes and added a matching `--out` flag (with `--report`
kept as a deprecated alias) to match. No code changes here: this package's
contract was already the target.

### Added: `sbom-rush validate <file>` verb (2026-07-18)

The CLI validated its own generated output against the vendored official
CycloneDX 1.6 schema and reported NTIA minimum elements, but offered no way
to run that same check against a third-party SBOM (a vendor deliverable, a
CI input). `validateCycloneDx`/`ntiaMinimumElements` were already public API
(exported from `index.ts`) with no CLI surface exercising them directly —
this closes that asymmetry: `sbom-rush validate <file>` reads and parses an
arbitrary CycloneDX document and runs both against it, reusing the exact
functions the generation path trusts. No new validation dependency, no
changes to `validate.ts` internals.

Exit codes stay in the family's 0/1/2/3 vocabulary: schema-valid (or
schema-invalid without `--fail-on-invalid`) is `0`, schema-invalid with
`--fail-on-invalid` is `3` (NTIA gaps remain informational and never gate,
matching generation's contract), a missing/unreadable/non-JSON file is `1`,
and a missing or extra `<file>` argument is `2`. Supports `--json` for a
structured `{ file, valid, errors, ntia }` result. The default (no-verb)
`rush sbom`/`sbom-rush` behavior is unchanged.

Standalone-bin only, not wired into `command-line.json`: Rush's
custom-command parameter schema has no positional-argument kind (every
parameter requires a `--dash-delimited` `longName`), and `GlobalScriptAction`
forwards only declared parameter values to the underlying `shellCommand` —
there is no way to pass a bare `<file>` positional through `rush sbom
validate <file>` as-is. See the README's "Validating a third-party SBOM"
section for the standalone invocation and the reasoning in full.

Pre-release testing pinned `publishConfig.registry` to a private registry.
Remove the pin before publishing to the public registry.
