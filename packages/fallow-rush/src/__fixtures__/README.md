# Recorded fallow output fixtures

Real output of the pinned `fallow` binary (3.6.0, schema_version 7), recorded
2026-07-18 from a throwaway single-package project planted with: two ~44-line
identical functions (clone detection), `src/orphan.js` (unused file), two
dead re-exports plus one dead local export in `src/index.js`, and an unused
`ms` dependency. Absolute paths were not present in the raw output (fallow
already emits repo-relative paths for the sections this plugin reads), so no
path-scrubbing step was needed for this recording; if a future version leaks
an absolute path, scrub it to `<fixture-project>` before committing.

- `fallow-3.6.0-combined.json` — `fallow --format json --quiet --pretty`
  (nested `check`, `dupes` with `clone_groups`/`clone_families`/`stats`,
  `health.summary` with numeric metrics plus the string `coverage_model`).
  `--pretty` is required from fallow 3.6.0 onward (compact JSON is the new
  default; omit it on fallow < 3.6.0).
- `fallow-3.6.0-dead-code.json` — `fallow dead-code --format json --quiet --pretty`
  (check-section fields at the TOP level; no `check` key).

## Exact project layout (reproduce this precisely — see "why" below)

```
package.json      # "type": "module", "main": "src/entrypoint.js", deps: { "ms": "<any>" }
src/entrypoint.js  # imports './index.js' (side-effect only) + named imports
                    # of processAll from alpha.js and processEverything from
                    # beta.js (so alpha/beta's declarations count as used,
                    # but index.js's re-exports of the same names do not)
src/index.js       # export { processAll } from './alpha.js';
                    # export { processEverything } from './beta.js';
                    # export function deadOne() { ... }   (local dead export)
src/alpha.js        # function compute(x) {...}; export function processAll() { <44-line loop> }
src/beta.js         # function compute(x) {...}; export function processEverything() { <same 44-line loop> }
src/orphan.js        # export const nothing = 1;  (the unused file)
```

The project must be a git repo (`git init` + one commit) — fallow's
`health.hotspot_summary` block is only emitted when it can find a git
history; without it the block is silently absent and the fixture diverges
from production repos (which are always git repos).

**Why the extra `entrypoint.js` indirection**: fallow auto-marks a resolved
package entry file's *own* exports as used (unless `--include-entry-exports`
is passed — not used here, to keep the recording command identical to what
the plugin's `scan.ts` invokes). Making `src/index.js` itself the `main`
collapses the re-export findings to zero. Routing `main` through a separate
`entrypoint.js` that (a) imports `index.js` only for its side effects and
(b) imports the underlying `alpha.js`/`beta.js` exports directly reproduces
the intended shape: `index.js`'s two re-exports and its local `deadOne` are
flagged as unused, while `alpha.js`/`beta.js` stay clean (their exports are
genuinely consumed, just not through `index.js`).

Regenerate after a fallow upgrade: rebuild this exact project layout, run
both commands with the new pinned binary from the project root, scrub any
absolute paths that appear, rename the two files to
`fallow-<newversion>-*.json`, and update `rollup.realoutput.test.ts`
(fixture filenames, the `fallowVersion` fixture string, and any assertions
whose shape moved).
