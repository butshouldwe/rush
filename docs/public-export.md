# Public export and registry configuration

Forgejo is canonical and retains full history and internal documents. The
public GitHub repository starts with a fresh single commit from a filtered
HEAD tree. Exporting does not create that commit, push, publish packages, or
change source Git state.

## Export

Requirements: Git, Bash, Python 3.12+ (standard library only) and gitleaks. From a
checkout with the desired changes committed:

```bash
scripts/public-export.sh /path/to/new-public-tree
scripts/public-export-check.sh /path/to/new-public-tree
sha256sum --strict -c .public-export-source
```

The destination must be new or empty, outside the source checkout, and not
an ancestor of it. Existing nonempty destinations are refused. Only HEAD
bytes are exported: uncommitted edits (including edits to the exclude list)
and untracked files never participate. `.public-export-exclude` is the single
source of exclusion policy; patterns are root-relative, case-sensitive
shell globs, and a matching directory excludes its descendants. Comments
and blank lines are ignored; negation, absolute paths and parent traversal
are rejected. The exported scripts and policy can export a fresh public
checkout again without changes to its public file set.

The three scripts (`scripts/public_export.py`, `scripts/public-export.sh`, and
`scripts/public-export-check.sh`) are copies of the canonical local-gates
public-export source. `.public-export-source` records the source commit and
three SHA-256 hashes. `sha256sum --strict -c .public-export-source` verifies
the copied bytes. Change the canonical source and synchronize these copies;
do not edit them independently.

Repository-owned policy lives in `.public-export-emails` and
`.public-export-reviewed-text`. The first permits two exact automation
addresses within Rush changefile JSON paths. The second permits the API key
content rule for one reviewed schema at its exact path and raw-byte SHA-256.
It does not exempt other rules, paths, changed bytes or gitleaks. Both files
reject malformed, duplicate and unused entries. Reserved example email
domains remain built in. Exporter regression tests live with the canonical
source rather than in this repository.

The checker examines every file, path and symlink target and reports
locations and categories without printing matching values. Each location is
a sha256 prefix of the relative path (`path-sha256:<12 hex>`), so no path text
reaches logs; set `PUBLIC_EXPORT_SHOW_PATHS=1` locally to see real paths. The public tree
is text-only: any file that is not valid UTF-8 or contains a NUL byte fails,
including every archive and compressed form, unless it has a reviewed entry
in `.public-export-binaries` (no binary exemptions today). It also fails on
unsafe symlinks, unsupported filesystem entries, read errors, empty input
and files over 32 MiB. It rejects private topology (IPv4 and IPv6 private ranges, including
IPv4-mapped forms), host paths and personal email addresses. Credentials are
checked by both the patterns in `scripts/public_export.py` and `gitleaks dir`,
which must be on PATH (the check fails without it; CI installs a pinned,
checksum-verified release). The only email
exemptions are reserved example domains and two exact non-personal
changefile automation identities, scoped to Rush changefile JSON paths.
There is no credential-prefix prose exemption today. Add any future
exemption narrowly, with a comment and a regression test.

## Threat model

The export check catches **accidental** disclosure by maintainers: a tailnet
hostname in a doc, a host path in a test, a private address in a log, a key
someone forgot about. It is a second layer behind maintainer review and a
clean export; it is not an adversarial security boundary.

In scope: accidental private addresses, hostnames, host paths, personal
emails, credentials (built-in patterns plus gitleaks), and binaries or
archives that would hide them. Repository policies do not weaken the
gitleaks pass: it runs with a fixed config from outside the tree, ignores
`gitleaks:allow` comments and reads no tree `.gitleaksignore`.

Out of scope: content crafted to evade the scanner (for example, ambiguous
IPv6 text such as a hex word like `cafe:` followed by a ULA address, which
reads as one public address), and
maintainers who bypass the export entirely. A maintainer can push to the
public repository directly, so the scanner cannot be the control for that;
review of every public push is. Hostile-input findings are tracked as
follow-ups, not release blockers, unless they show a realistic accident.

## What is omitted, and why

- Agent configuration/instructions/adapters and their lock: private host
  wiring and internal procedures, not needed to install, build or test.
- Handoffs, progress ledgers, operational receipts and reasoning receipts:
  internal coordination/provenance, retained in canonical history.
- Forgejo workflow: private registry routing/auth setup, while the public
  GitHub workflow remains available.
- Two internal infrastructure ADRs and the host hook installation note:
  topology/operations, not the public package behavior contract. ADR 0003
  (worktree convergence behavior) stays public.
- Internal worktree plugin dogfooding autoinstaller and registration:
  its previously published vendored tarball embeds internal host paths.
  Preserve the exact artifact internally; do not silently repack it or
  switch canonical dogfooding to local sources. The public root does not
  load `rush worktree-create`/`worktree-remove` until maintainers register
  a public artifact after launch. All plugin sources and tests remain.
- `somewhere/`: generated Fallow rollups from a historical run, accidentally
  tracked output, not an input, maintained report, or test golden. Kept on
  Forgejo rather than deleted with internal evidence.
- The host-specific worktree benchmark: internal experiment setup. Unit
  tests and synthetic integration goldens remain public.

## Public and internal install routing

Checked-in npm configs default to `https://registry.npmjs.org/`. All sibling
plugin dependencies in the testbed use `workspace:*`; they do not require
published copies of our packages. The canonical worktree autoinstaller
still uses its vendored published artifact, not a registry lookup.

For internal installs, configure the `@butshouldwe:registry` scoped key in
the user's npm configuration using the organization's approved registry
URL. CI already configures that scoped key and authentication in its user
npm configuration; removing a checked-in scope override does not remove
CI's routing. No private registry URL or credential is required by the
public checkout. Credentials must come from the approved secret mechanism,
not checked-in files or hand-built commands.

## Publishing (not performed by export)

All four publishable manifests declare MIT, repository directory, bugs,
homepage and `publishConfig.access: public`. They have no pinned registry.
A release owner must explicitly select the destination and credentials:

- Public: use `.github/workflows/publish.yml` and npm OIDC Trusted Publishing,
  with `--provenance` and the protected `npm-release` environment. No stored
  npm write token is needed. [NPM-RELEASE.md](NPM-RELEASE.md) covers a maintainer's
  first interactive publish and the npm/GitHub settings. worktree-rush is
  held outside the public publish allowlist until its public bundle is fixed.
- Internal: select `rush publish --registry <approved-internal-registry-url>` and
  approved runtime injection of `NPM_AUTH_TOKEN` plus the non-secret
  `BUTSHOULDWE_NPM_AUTH_PATH` (`//host/path/` matching that registry).

Rush creates an isolated publish HOME from `.npmrc-publish`; auth lines
with missing environment variables are commented out. `rush publish` is
read-only unless release owners separately approve and supply `--publish`
and any required version/changefile application flags. For the initial
public scoped release, explicitly use `--set-access-level public`: Rush's
CLI otherwise defaults its access argument to restricted, even though the
manifests declare public access. Internal scoped install
routing is separate from the publish destination. This change intentionally
makes npm the safe public default, so internal release jobs must select
`--registry` explicitly. No release command has been run as part of export
readiness.

## Stranger verification

Initialize/commit the exported tree only in a disposable verification
repository when running integration tests: the test harness checks Git
cleanliness and the worktree tests create their own synthetic Git fixtures.
Use an isolated HOME and npm configuration, with public npm as the only
registry and no credentials. Run the commands in CONTRIBUTING.md, including
format and publish checks, plus the export and hash checks above. If local
Git policy blocks Rush in the canonical worktree, use `install --bypass-policy`
locally; clean public clones do not need the bypass.
