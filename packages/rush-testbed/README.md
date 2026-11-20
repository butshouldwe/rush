# @butshouldwe/rush-testbed (private, never published)

The shared test bed for `@butshouldwe/sbom-rush` and `@butshouldwe/fallow-rush`:
a deliberately small, deliberately flawed synthetic Rush monorepo plus a
spawn-based integration harness. The testbed **invokes** the plugins through
Rush's real plugin machinery; it never imports them.

## The fixture (`fixture/`)

Rush 5.177.2 / pnpm 11.11.0, six projects with planted flaws that serve as
acceptance criteria:

| Plant | Where | Must be caught by |
|---|---|---|
| Dead export `deadHelper` | `lib-b` | `rush fallow` (root pass, attributed to lib-b) |
| Dev-only workspace project `build-tool` (+ its dep `picocolors`) | devDependency of `web-app` | **excluded** from `rush sbom` output — pnpm's filter traverses it, but it never ships (real-world failure mode found on microsoft/rush-example) |
| Unused dependency `mri` | `web-app` | `rush fallow` (per-project pass) |
| Circular dependency | `lib-c` ⇄ `lib-d` (declared both ways) | `rush fallow` (cross-package, attributed to both) |
| devDependency `is-odd` | `web-app` | **excluded** from `rush sbom` output |
| Two deploy scenarios | `deploy-web.json`, `deploy-docs.json` | different component sets in `rush sbom` output |

## Running

```bash
pnpm test                      # full integration suite (packs plugins, wires
                               # the autoinstaller, rush update/deploy, runs
                               # rush sbom + rush fallow + MCP handshake)
UPDATE_GOLDENS=1 pnpm test     # regenerate golden/ (normalized artifacts)
node harness/benchmark.mjs     # Fallow vs Knip wall-time + parity table
```

Every suite ends by asserting `git status` is clean for this package — no
tool run may mutate the repo (fallow caches, rush install state, and the rush
plugin store are gitignored for exactly this reason).

## Quirks worth knowing (all receipted in REASONING_RECEIPT-rush.md)

- The fixture is a Rush repo **nested inside a pnpm workspace**, which pnpm
  loves to escape from during installs. Seals: `useWorkspaces: true` in
  `pnpm-config.json` (generates the sealing `common/temp/pnpm-workspace.yaml`)
  and a committed empty `pnpm-workspace.yaml` in the autoinstaller folder.
  Standalone Rush repos never need the latter, but it is harmless there.
- The autoinstaller's `pnpm-lock.yaml` is gitignored (deviating from Rush
  convention) because it resolves freshly-packed `file:` tarballs whose
  integrity churns every run.
- The fixture sits under rush-testbed's `"type": "module"` package.json, so
  `fixture/common/scripts/package.json` carries a `{"type":"commonjs"}` scope
  marker — Rush's generated `install-run*.js` are CommonJS and crash as ESM
  without it, which breaks every rush-sdk consumer (`@rushstack/mcp-server`
  loads rush-lib through exactly that path; the MCP integration test guards
  this). Real Rush repos don't need the marker.
- `rush build` was never wired: the lib-c⇄lib-d cycle exists on purpose and
  Rush's build graph may refuse it. Install, deploy, and both plugins are
  unaffected.
