<!--
Conventions: AGENTS.md ("## Verify" / "## Verification") and README.md
("## Verify"). PR-only into main; no stale heads — rebase onto latest main
before merging.
-->

## Summary

<!-- What changed and why, in a sentence or two. -->

## Related issue

<!-- e.g. Closes #123, or Blocked by: #123. -->

## Verify gate

Ran from the repository root:

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm -r build`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`

An unrun check is not a pass — record exact commands and results below (or in
`progress.md`).

## §0 no-mutation rule (testbed changes only)

<!-- Required only if this PR touches packages/rush-testbed/fixture/**. -->

- [ ] `git status --porcelain packages/rush-testbed` is empty after the
      integration suite runs (the fixture is a golden input, not an output).

## Notes for reviewers

<!-- Anything a reviewer should know: scope boundaries, deferred follow-ups,
STOP conditions hit, etc. -->
