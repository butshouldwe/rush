# @butshouldwe/fallow-rush

A [Rush](https://rushjs.io) plugin that runs [Fallow](https://www.npmjs.com/package/fallow)
codebase intelligence across a Rush monorepo with **per-project attribution**.
Adds the `rush fallow` and `rush fallow-mcp` custom commands.

The plugin is integration, not analysis: Fallow is the engine (pinned as a
dependency, currently 3.6.0 - its bins are resolved from the plugin's own
node_modules, never PATH), Rush's `rush.json` is the source of truth for what
a "project" is, and the plugin's job is making findings land on the right
project.

## Install

Same pattern as its sibling `@butshouldwe/sbom-rush`: install into an
autoinstaller named **`rush-plugins`**, register in
`common/config/rush/rush-plugins.json` (`pluginName: "fallow-rush-plugin"`),
then `rush update-autoinstaller --name rush-plugins` and one `rush update`.

## Use

```bash
rush fallow                          # full two-pass scan, reports written
rush fallow --project web-app       # narrow to named project(s)
rush fallow --changed-since main    # PR mode: only files changed since ref
rush fallow --fail-on-findings      # CI gate: exit 3 when findings exist
rush fallow --json                  # rollup JSON on stdout
rush fallow --out reports/fallow    # override report dir (default common/temp/fallow-rush)
```

Reports: `monorepo.{json,md}` plus `projects/<name>.{json,md}` - findings
attributed to Rush projects, with Rush plumbing (`common/*`: generated
scripts, autoinstallers, the temp workspace) excluded from project rollups and
reported separately. Scoped names flatten to one path segment
(`@scope/pkg` → `projects/@scope__pkg.json`), and each run rebuilds
`projects/` from scratch so stale files never sit beside fresh ones - guarded
so it never happens silently (see below).

Semantics worth knowing:

- **Counting**: `monorepo.totalFindings`/`byType` count *distinct problems* -
  a cross-package cycle appears in every involved project's rollup but counts
  once at the monorepo level.
- **`--project` narrows** the project rollups, the aggregate counts, and the
  `--fail-on-findings` gate. The monorepo-wide sections (dupes, health,
  plumbing) and the root pass's cost are unaffected; the rollup records the
  narrowing in `projectsFilter`, so a partial view is always labeled.
- **Clobber guard (closes [issue #5](https://github.com/butshouldwe/rush/issues/5))**:
  a scoped run (`--project` and/or `--changed-since`) that would land on top
  of a report recorded for a *different* `--project` scope refuses (exit 2)
  instead of silently dropping the other scope's project files when
  `projects/` is rebuilt. Full (unscoped) runs always bypass this scope check -
  a full snapshot supersedes anything that was there before. Escape hatches:
  pass `--out <fresh-dir>` for this run, or delete the existing report
  directory if you mean to replace it. `writeReports` also refuses to delete a non-empty
  `projects/` directory unless the adjacent `monorepo.json` is a regular file
  with a valid fallow-rush ownership record - it will never recursively delete
  files this plugin didn't write.
- **`--out`** (default `common/temp/fallow-rush`; `--report` is a deprecated
  alias, kept for one release - passing both errors). All report files are
  written atomically through exclusive, unpredictable temp files (temp +
  rename), while a report-directory lock serializes writers; Rush also holds
  its repository lock for `rush fallow`.
- **Default path safety**: without `--out` or `--report`, a symlink at the
  Rush root, `common`, `common/temp`, or `common/temp/fallow-rush` refuses
  with exit 1 before scanning or writing. This includes dangling links and
  links inside the root. Explicit output paths remain caller-selected.
  `writeReports` applies the same check to a conventional default path unless
  `explicitOut` is true; other API destinations remain caller-selected.
  This protects against checkout content, not concurrent directory swaps.
- **Machine consumption**: `rush fallow --json` is polluted by Rush's own
  stdout banner. Pipe-friendly options: exec the autoinstaller bin directly
  (`common/autoinstallers/rush-plugins/node_modules/.bin/fallow-rush --json`)
  or read `<report-dir>/monorepo.json`.
- **Scale**: the per-project pass runs serially - fine below ~50 projects;
  file an issue if you need a concurrency pool before we do.

## Exit codes

Shared with `@butshouldwe/sbom-rush` - both tools use one family vocabulary:

| Exit | Meaning |
|---|---|
| `0` | ok |
| `1` | runtime failure (scan or report-write failed) |
| `2` | usage/config error (bad flags, outside a Rush repo, `--out`+`--report` both given, scope-clobber refusal) |
| `3` | gate tripped - `--fail-on-findings` found attributed findings or nonempty unsupported categories |

## The two-pass model (why not just run fallow once?)

Verified against a real Rush fixture:

- **Root pass** (fallow at the repo root): the only pass that can judge
  reachability - unused exports ("does *anything in the monorepo* import
  this?"), unused files, cross-package import cycles. Fallow discovers Rush
  workspaces natively.
- **Per-project pass** (`fallow dead-code` in each project): package.json
  dependency hygiene (unused/unlisted/dev-in-prod dependencies), which root
  runs don't compute for sub-workspace manifests. Reachability findings from
  this pass are **discarded** - a lone project can't see its consumers.

Recommended root config for a Rush repo (`.fallowrc.json`):

```jsonc
{
  "includeEntryExports": true,        // library entry exports are analyzable -
                                      // fallow sees their in-repo consumers
  "ignoreExports": [                  // app entries are your public surface
    { "file": "apps/*/src/index.*", "exports": ["*"] }
  ]
}
```

## PR feedback

`--changed-since <ref>` is passed straight through to Fallow's changed-mode
(v1). Fallow's own sticky-comment CI surface (`fallow ci post-pr-comment` and
friends) is configuration passthrough - nothing is reimplemented here;
platform specifics are your CI's concern. A Rush-native change-detection
adapter (Rush's changed-projects analysis feeding the scan set) is a
documented seam with a stub in `src/changeDetection.ts`, deliberately not
implemented against a synthetic fixture.

## MCP (agents get repo-truth nearly free)

`fallow-rush mcp` (and `rush fallow-mcp` for interactive smoke tests) is a
thin exec passthrough to Fallow's **bundled** MCP server - no wrapping, no
re-serving. For agent configs, exec the autoinstaller bin directly; Rush's
stdout banner breaks MCP framing through `rush fallow-mcp`. The verified
`mcpServers` snippet lives in [HERMES-WIRING.md](./HERMES-WIRING.md)
(paste-only; this plugin never writes to any agent's configuration).

## Deliberately not exposed

`fallow fix` / auto-remediation. This plugin reports; humans and their agents
decide what to delete.

## Requirements

Node ≥ 22 · a Rush repository (any package manager - the scan doesn't touch
installs; git required for `--changed-since`).

## License

MIT
