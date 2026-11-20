# Contributing

Thanks for wanting to improve the Rush plugins. Two hard rules up front:

1. **Numbers carry provenance.** Every measurement or performance claim in
   docs, READMEs, or receipts states `who / hardware / date / method`.
   Estimates are labeled `est.` and never mixed into measured rows.
2. **An unrun check is not a pass.** A change is verified when the command
   was actually run and its output is quotable — not when it looks correct.

## Proposing a change

1. Branch from `main`; keep one concern per pull request.
2. This repo dogfoods Rush; run everything from the repository root through
   the checked-in installer (the same entrypoint CI uses):

   ```bash
   node common/scripts/install-run-rush.js install
   node common/scripts/install-run-rush.js build
   node common/scripts/install-run-rush.js typecheck
   node common/scripts/install-run-rush.js lint
   node common/scripts/install-run-rush.js format:check
   node common/scripts/install-run-rush.js test
   node common/scripts/install-run-rush.js publish-check
   ```

   `packages/config-rush` has permission-refusal tests that only hold for an unprivileged user; as root (CI containers, root dev shells) run `bash common/scripts/test-unprivileged.sh packages/config-rush` instead of `rush test` for that package.

3. **Change files are required.** Run
   `node common/scripts/install-run-rush.js change` and commit the file it
   writes; CI runs `rush change --verify` on every pull request.
4. Open a pull request. Describe what changed, why, and how you verified it
   — command lines with observed output beat prose.
5. CI gates (both must be green):
   - `verify` — install, `change --verify`, build, typecheck, lint,
     `format:check`, unit tests, publish checks (publint + attw).
   - `integration` — the testbed suite plus the no-mutation rule
     (`git status --porcelain packages/rush-testbed` must stay empty).

Commit messages: conventional prefixes (`feat:`, `fix:`, `docs:`, `ci:`,
`chore:`, `test:`) with a short imperative subject.

## Code of conduct

Be excellent to each other. Disagreement is fine; hostility is not.

## Security

Do not open a public issue for a suspected vulnerability — see
[`SECURITY.md`](SECURITY.md) for the private reporting channel.

## License

Contributions are accepted under the MIT license (see [`LICENSE`](LICENSE)).
