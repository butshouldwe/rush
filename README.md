# rush

Rush plugin monorepo: four publishable [Rush](https://rushjs.io) plugins and
the private testbed that integration-tests them against real Rush machinery.

## Packages

| Package | What it does |
|---|---|
| [`@butshouldwe/config-rush`](packages/config-rush/README.md) | Rig-aware project configuration discovery, validation, explanation, and safe authoring |
| [`@butshouldwe/sbom-rush`](packages/sbom-rush/README.md) | `rush sbom` — one CycloneDX SBOM per deployed artifact from `rush deploy` output |
| [`@butshouldwe/fallow-rush`](packages/fallow-rush/README.md) | `rush fallow` — Fallow codebase intelligence with per-project attribution; also exposes Fallow's bundled MCP server |
| [`@butshouldwe/worktree-rush`](packages/worktree-rush/README.md) | `rush worktree-create` — fast, fully-inherited git worktrees (git worktree + dependency materialization + agent-state bootstrap) |
| [`rush-testbed`](packages/rush-testbed/README.md) | private — synthetic Rush monorepo fixture + spawn-based integration harness; invokes the plugins, never imports them |

## Install

All four published plugins install into a *consumer* Rush repo's
autoinstaller, not via `npm install` at this repo's root — see each
package's README for the `rush-plugins.json` + `command-line.json` wiring.

## Verify

From the repository root (Rush is bootstrapped by the checked-in
installer — the same entrypoint CI uses):

```bash
node common/scripts/install-run-rush.js install
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js typecheck
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js format:check
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js publish-check
```

An unrun check is not a pass. Integration runs must leave
`git status --porcelain packages/rush-testbed` empty.

## Repo layout note

The root is a real Rush monorepo: the plugins are installed, built,
typechecked, linted, tested, versioned, and published through Rush itself
(dogfooding). `packages/rush-testbed/fixture/` additionally carries a
synthetic `rush.json` — a fixture Rush workspace the testbed drives through
real Rush machinery to integration-test the plugins; the fixture's plugin
devDependencies exist for build ordering only, never as imports.

## Contributing

Human contributors: read [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch/PR
flow, required change files, and the CI gates.

For public-export policy and registry configuration, see
[`docs/public-export.md`](docs/public-export.md). Automated contributors use
the same verification commands and changefile rules as human contributors.

## Security

See [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE). Each package also ships its own copy.
