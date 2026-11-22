# Change Log - @butshouldwe/config-rush

This log was last generated on Sun, 22 Nov 2026 18:27:27 GMT and should not be manually modified.

## 0.2.1
Sun, 22 Nov 2026 18:27:27 GMT

### Patches

- Publish from GitHub Actions through npm trusted publishing, with provenance. No code changes.

## 0.2.0
Sat, 21 Nov 2026 00:13:23 GMT

### Minor changes

- Add packaged read-only project configuration discovery, validation and provenance with shared Effect and Promise APIs.
- Add safe authoring for project-local configuration: `config-preview` turns a request of set/unset/suppress/init/set-version edits into an exact byte-level plan, `config-apply` applies a plan as a whole after re-checking every input it observed (each file atomically; a late failure stops later writes and leaves earlier ones in place, reported as partial), and `config-status` reconciles an interrupted operation read-only from its journal. Writes are staged beside the target and published atomically; shared, rig and inherited sources are never edited.
- Add candidate-aware reads: preview a document as it would resolve with proposed bytes, through an explicit read context that records every input observed, so a plan can prove nothing changed underneath it before apply.

### Patches

- Prepare public npm metadata and configurable registry routing.
- Support Node 25 and 26 in config-rush.
- Fail closed instead of open whenever authoring scope cannot be proven: unreadable consumer documents, unresolvable rigs, uninstalled validator packages and shared-source ambiguity refuse the edit with a named diagnostic, while a peer's provably missing parent no longer blocks unrelated projects.
- Preserve documents byte-for-byte where they are not edited: arrays and objects follow the file's inferred indentation, ambiguous indentation is refused, `unset` below a scalar is a no-op with a note, and plan staleness is compared structurally so key-order round-trips are not stale.
- Report interruptions precisely: `config-status` names a verified staged temporary and a crash-left or unreadable lock, keeps journal cleanup evidence, and never deletes anything. Result envelopes are only written to a validated destination.
- Resolve user-supplied CLI paths against `RUSH_INVOKED_FOLDER`; classify a pointer into a scalar as a validation failure (exit 2) and a system error reading an input file as an execution failure (exit 1); give every `config-*` command a description for `rush --help`.
- Upgrade Effect runtime to 4.0.6

