# @butshouldwe/sbom-rush

A [Rush](https://rushjs.io) plugin that generates **one CycloneDX SBOM per
deployed artifact** from `rush deploy` output. Adds the `rush sbom` custom
command.

Requires the consuming repo to be on pnpm ≥ 11 (see [Requirements](#requirements)).

## Why deploy output?

A monorepo dependency dump is not a bill of materials for anything you
actually ship. `rush deploy` has already computed the answer - the pruned,
devDependency-excluded, closure-resolved file set for one deployable project -
into a real folder. `sbom-rush` scans that artifact directly when possible;
its workspace-lockfile fallback is accepted only after the package identity
set is bound back to evidence materialized in that selected deploy output.

## Install

The plugin expects to live in an autoinstaller named **`rush-plugins`**
(that name is how its command finds its own binary on PATH):

```jsonc
// common/autoinstallers/rush-plugins/package.json
{
  "name": "rush-plugins",
  "version": "0.0.0",
  "private": true,
  "dependencies": { "@butshouldwe/sbom-rush": "^0.1.0" }
}
```

```jsonc
// common/config/rush/rush-plugins.json
{
  "plugins": [
    {
      "packageName": "@butshouldwe/sbom-rush",
      "pluginName": "sbom-rush-plugin",
      "autoinstallerName": "rush-plugins"
    }
  ]
}
```

Then `rush update-autoinstaller --name rush-plugins` and one `rush update`
(Rush loads newly registered plugin manifests on the next update).

## Use

```bash
rush deploy --scenario web --target-folder common/deploy-web
rush sbom                      # every scenario found in common/config/rush
rush sbom --scenario web       # narrow
rush sbom --fail-on-invalid    # CI gate: exit 3 on schema-invalid output
rush sbom --json               # machine-readable run result
rush sbom --target-folder path/to/any/deploy-output   # escape hatch
```

Per scenario, the deploy output is expected at `common/deploy-<scenario>`, or
`common/deploy` when its `extractor-metadata.json` main project matches.
`rush sbom` never runs `rush deploy` itself - CI calls them as discrete steps.

A scenario listing several `deploymentProjectNames` defines one deployable
artifact per project (Rush's `rush deploy --project <name>` model); `rush
sbom` emits one SBOM per deployed project, keyed `<scenario>--<project>`, and
reports the projects whose deploy output is missing.

If both `deploy.json` and an explicitly named `deploy-default.json` exist,
`--scenario default` runs both without aliasing them: the implicit config keeps
the output identity `default` and `common/deploy`, while the explicitly named
config uses `default--explicit` and `common/deploy-default`.

Output (default `common/deploy-sbom/`, override with `--out`; relative `--out`
resolves from the repo root, relative `--target-folder` from where you
invoked the command). The implicit output refuses symbolic links at the Rush
root, `common`, or `deploy-sbom`, before generation or filesystem writes.
An explicit `--out` remains your chosen path and may traverse symbolic links.
This check covers static checkout content, not concurrent directory swaps.
Output files:

- `<scenario>.cdx.json` - CycloneDX 1.6, one per deployment (scoped names
  flatten: `@scope/app` → `@scope__app.cdx.json`; names containing a literal
  `__` receive a deterministic digest suffix so distinct project names cannot
  flatten to the same file)
- `manifest.json` - scenario → file, sha256, component count, validation
  status, ladder rung. Merged across runs: a scoped `--scenario` run updates
  its own entries and keeps the others as long as their SBOM files exist.
  Each SBOM atomic replacement and its manifest entry are published under one
  pid+random ownership lock; the recorded digest is read from the exact bytes
  published on disk. Existing files without matching manifest ownership are
  preserved and the new artifact is deterministically disambiguated.

## Validating a third-party SBOM

`sbom-rush` validates every SBOM it generates against the vendored official
CycloneDX 1.6 schema and reports NTIA minimum elements. The `validate` verb
exposes that same machinery for SBOMs you didn't generate - a vendor
deliverable, a CI input, anything CycloneDX-shaped:

```bash
sbom-rush validate ./third-party.cdx.json                    # report only
sbom-rush validate ./third-party.cdx.json --fail-on-invalid   # CI gate: exit 3 on schema-invalid
sbom-rush validate ./third-party.cdx.json --json              # machine-readable {file, valid, errors, ntia}
```

No `rush deploy` output or even a Rush repository is required - `validate`
reads and parses the file directly. Exit codes follow the same family
vocabulary as `rush sbom` (see [Exit codes](#exit-codes) below): schema-valid
(or schema-invalid without `--fail-on-invalid`) is `0`; schema-invalid with
`--fail-on-invalid` is `3`; a missing/unreadable/non-JSON file is `1`; a
missing or extra `<file>` argument is `2`. NTIA gaps are always informational
and never affect the exit code, matching generation's own contract.

**Standalone-bin only** - `sbom-rush validate <file>` is not reachable as
`rush sbom validate <file>`. Rush's `command-line.json` parameter schema has
no positional-argument kind: every parameter needs a `--dash-delimited`
`longName` (`parameterKind: flag | choice | string | integer | stringList |
integerList | choiceList`, all matching `^-(-[a-z0-9]+)+$`), and
`GlobalScriptAction` only forwards declared parameter values to the
underlying `shellCommand` - never raw/unrecognized argv. There's no way to
express a bare positional file path through that contract without changing
the verb into a flag (e.g. `rush sbom --validate <file>`), which would be a
different, non-symmetric CLI shape from the standalone `validate <file>`
verb documented above. Run the autoinstaller's binary directly instead:
`common/autoinstallers/rush-plugins/node_modules/.bin/sbom-rush validate
<file>`.

## How the SBOM is generated

A fallback ladder, attempted in order per scenario; the winning rung is
recorded in the SBOM's `metadata.properties` (`sbom-rush:ladder-rung`):

1. **`pnpm sbom` inside the deploy folder** - cheapest; currently fails
   because `rush deploy` output contains no lockfile (pnpm ≤ 11.11 needs one),
   kept first so it wins the day pnpm can read the store there.
2. **Lockfile mode at Rush's workspace root** - `pnpm sbom --lockfile-only
   --prod --filter "<project>..." --split` in `common/temp`, merged into one
   document: registry components deduped, workspace projects added as
   components (marked `sbom-rush:workspace-project`), workspace dependency
   edges restored from the shipped manifests. This is the rung that works
   today.
3. **cdxgen against the deploy folder** - when `cdxgen` resolves from a trusted
   absolute PATH directory outside the deploy folder.

PATH fallbacks for pnpm and cdxgen use absolute tool paths only; relative,
current-directory, and deploy-folder PATH entries are ignored.

Every rung must pass the same acceptance gate: **every project listed in the
deploy's `extractor-metadata.json` appears in the SBOM.** Generation is
followed by a hard validation gate (ajv against the vendored official
CycloneDX 1.6 schema) and an informational NTIA minimum-elements report
(pnpm emits no supplier data; the gap is reported, not fatal).
Extractor project paths must remain beneath the deploy folder both lexically
and after symlink resolution.

Every SBOM says how it was made: scenario, deployed project, git SHA,
generator + rung, and tool versions are stamped into `metadata`. The stamp
uses the `sbom-rush:` property namespace (`sbom-rush:scenario`,
`sbom-rush:main-project`, `sbom-rush:git-sha`, `sbom-rush:ladder-rung`,
`sbom-rush:generator`, plus `sbom-rush:workspace-project` on merged workspace
components) - CycloneDX `properties` are open name/value pairs; this
namespace is documented here rather than registered in the official taxonomy.

The rung-2 merge is strict about what ships: every shipped workspace project
must have a split root with the exact version read from its deployed manifest;
splits outside the deploy's shipped closure (e.g. devDependency tooling
projects) are dropped; and dependency refs must resolve (no dangling edges).
Missing splits, missing root versions, and version skew fail the rung loudly
and continue the fallback ladder.

Rung 2's precise provenance guarantee is **package-identity set equality**.
The root plus component `name@version` values must exactly equal the workspace
projects read from deployed manifests plus third-party package manifests
materialized beneath the selected deployment's `node_modules` trees. A
workspace-only version, or a deployed package omitted by the workspace SBOM,
rejects the rung. This does **not** prove package byte/integrity equality or
third-party dependency-edge equality: the deploy output has no bound lockfile,
so those edges and registry metadata still originate in the current workspace
lockfile. Two artifacts with the same `name@version` set but different bytes
or third-party edge topology cannot be distinguished by rung 2 and require a
direct deploy-folder rung for that stronger claim.

## Requirements

- Node ≥ 22
- Rush repo using pnpm ≥ 11 (`pnpmVersion` ≥ 11 in `rush.json`; `pnpm sbom`
  shipped in pnpm 11). Repos on npm/yarn/older pnpm get a polite refusal with
  guidance.
- The `--target-folder` + cdxgen escape hatch exists but does **not**
  currently produce an accepted SBOM against symlinked `rush deploy` output —
  confirmed against a real pnpm-10 Rush clone, see
  [issue #3](https://github.com/butshouldwe/rush/issues/3). Until that's
  fixed, repos on pnpm < 11 have no working path to an SBOM through this
  plugin.

## Exit codes

Shared with `@butshouldwe/fallow-rush` - both tools use one family vocabulary.
Applies identically to `rush sbom` (generation) and `sbom-rush validate`
(third-party validation):

| Exit | Meaning |
|---|---|
| `0` | ok |
| `1` | generation failure, or (for `validate`) the file couldn't be read/parsed |
| `2` | usage error |
| `3` | gate tripped - `--fail-on-invalid` found a schema-invalid SBOM |

## Where should SBOMs land?

Recommendation: treat them as **CI-ephemeral artifacts** - generate on every
release build, upload to your compliance pipeline/artifact store keyed by the
stamped git SHA, don't commit them (size, merge noise, instant staleness).
The plugin doesn't impose this: `--out` writes wherever you point it.

## License

MIT
