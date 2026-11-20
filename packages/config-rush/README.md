# @butshouldwe/config-rush

Rig-aware project configuration for Rush: discover exact projects and domains, read validated values, explain sources, validate a selection, and author project-local JSONC through explicit preview/apply operations. The Effect and Promise APIs share the same resolver. This package does not deploy applications or implement classification/reduction-review policy.

## Install through Rush

Add the package (or a packed local tarball before publication) to an autoinstaller named `rush-plugins`. Register it in `common/config/rush/rush-plugins.json`:

```json
{
  "plugins": [{
    "packageName": "@butshouldwe/config-rush",
    "pluginName": "config-rush-plugin",
    "autoinstallerName": "rush-plugins"
  }]
}
```

Run `rush update-autoinstaller --name rush-plugins`, then `rush update`. Updating the autoinstaller alone does not register the contributed commands in Rush's plugin store. Commit normal consumer lockfiles; local test fixtures may use file-tarball overrides, but production configuration must not reference a developer's scratch directory.

Commands:

```text
rush config-discover
rush config-get --project @example/app --domain tool --result-file ./result.json --invocation-id ci-step-123
rush config-explain --project @example/app --domain tool
rush config-validate --project @example/app
```

Rush adds banners to stdout. CI must use a fresh `--result-file`, check the command exit, verify `resultVersion`, `invocationId`, `scope` and `status`, then consume `data`. The command refuses an existing output path. Parent directories must exist. No banner stripping or stale-success fallback.

The installed `config-rush` binary accepts the read commands `discover`, `get`, `explain`, `validate`, the authoring commands `preview`, `apply`, `status`, `init`, `set`, `unset`, `suppress`, `remove-suppression`, `set-version`, and `--json` for one clean JSON result envelope. It searches the invoking folder's ancestors for `rush.json` unless `--root` is explicit; user-supplied paths (`--root`, `--request-file`, `--plan-file`, `--document-file`, `--result-file`) resolve against `RUSH_INVOKED_FOLDER` when Rush sets it, else the process cwd. `get` and `explain` require exactly one exact project name and domain; `validate` accepts repeated selections. No fuzzy identity or alias resolution. Exit 0 is success, 2 is usage/configuration failure, 3 is a retryable precondition failure before any write (`STALE_PREVIEW`, `WRITER_BUSY`, `INPUT_CHANGED`, `JOURNAL_LIMIT`), 4 is partial or uncertain application (including a precondition failure detected after the journal recorded intent), and 1 is an unexpected execution or result-publication failure before any known configuration write, including a system error other than absence (for example `EACCES`) while reading a request, plan or document file. Empty validation selections fail unless the caller explicitly sets `allowEmpty` / `--allow-empty`.

## Repository registration

Create `common/config/rush-plugins/config-rush-plugin.json`:

```json
{
  "formatVersion": 1,
  "domains": [{
    "name": "tool",
    "projectFile": "config/tool.json",
    "required": false,
    "versions": {
      "1.0.0": {
        "schema": "schemas/tool-effective.json",
        "fragmentSchema": "schemas/tool-fragment.json",
        "resources": ["schemas/tool-fields.json"],
        "merge": {"/addons": "append", "/options": "merge"}
      }
    }
  }]
}
```

Schema paths are repository-relative. They are JSON Schema 2020-12 objects/booleans, resolved offline; `$ref` resources must be explicitly supplied. Reuse field definitions between effective and fragment views. A domain's optional availability is separate from `required`; supported exact versions coexist. `required` is a basic domain-wide requirement, not the later additive project-classification policy.

For package resources, explicitly admit the exact installed package version in top-level `packages` and use `package:@team/contracts/path/to/schema.json`. The package must be installed in the same autoinstaller and export `package.json` for version verification. Files must stay inside that package. Schema loading does not fetch URLs, execute JS, expand environment variables or inject defaults. Executable validators use the separate admission mechanism below.

## Project documents and rigs

```json
{
  "formatVersion": 1,
  "domain": "tool",
  "contractVersion": "1.0.0",
  "extends": "./base.json",
  "values": {"channel": null},
  "suppress": ["/addons"]
}
```

A local file takes precedence over the selected rig profile's file; missing local configuration falls back through `@rushstack/rig-package`. No rig is required. A local file does not implicitly merge rig values: use explicit `extends`. Relative parents resolve from the declaring source within the repository or selected package; cross-package parents use admitted `package:` references. Parent/child domain and exact version must match. Cycles fail.

Each supplied field replaces the inherited value by default. Objects are not recursively merged and arrays do not concatenate unless explicitly declared. Nested merge rules require object-merge ancestors. Schema `default` is an annotation, never injected. Null stays ordinary data. Suppression removes an inherited object property; it cannot conflict with local assignments, overlap another suppression, target array indices, or waive a required field.

Sparse inheritance requires an explicit fragment schema. Fragments are validated before composition so that a bad parent cannot hide behind an override; the effective schema runs afterward. Load-time contract admission checks closed-object posture, including declared references, alternatives, conditional branches and nested fields. Use `additionalProperties: false` or `unevaluatedProperties: false`; a nested object with an explicit `additionalProperties` declaration may serve as an extension map. This is a conservative supported profile, not a theorem prover for arbitrary schemas: dynamic references and schemas exceeding the structural proof budget are rejected rather than presumed safe. Structural schemas must be synchronous. JSON Schema `format` remains an annotation; use a pattern or an admitted semantic validator when an assertion is required.

JSONC permits comments/trailing commas, but duplicate keys and JSON5 syntax fail. Read/validate never repair files. Project and local resource paths are checked lexically and by realpath; project identity is read from `rush.json` and checked against `package.json`, without installing or shipping a second Rush engine. Undeclared business strings remain ordinary strings. Declared paths have the explicit interpretation below.

## Declared paths and local ownership

A version may register `paths` by JSON Pointer:

```json
{
  "paths": {
    "/docs": {
      "base": "project",
      "allowedRoots": [{"base": "project", "path": "."}],
      "mustExist": true,
      "symlinks": "within-roots"
    }
  },
  "projectOwned": ["/projectKey"]
}
```

Bases are `project`, `repository` or `source`. A project base always means the consuming project, including for inherited values. Source means the directory of the contributing document; appended array items retain separate origins. Both lexical and canonical paths must fit a declared allowed root. `symlinks: "reject"` additionally rejects links, while `within-roots` permits links that stay contained. Required inputs must exist; `mustExist: false` permits future outputs but still checks existing ancestors for escapes.

`values` preserves authored strings and the schema-validated representation. Consume `result.paths["/docs"].resolved` when an interpreted filesystem path is needed. Each entry also reports `authored`, `base`, `source`, `exists` and `kind`. Scalars and arrays of strings are supported; absent optional fields have no path entry. No cwd guessing occurs.

`projectOwned` requires the field and its effective descendants to have been authored in the consuming project's local document. Copying a shared value locally qualifies as local authorship, not uniqueness. Provenance includes `authoredLocally`; uniqueness needs a separate semantic check.

## Trusted semantic validators

Repository registration explicitly admits a pinned package, module export, scope and local inputs; a version selects validator IDs:

```json
{
  "packages": {"@team/checks": "1.0.0"},
  "validators": {
    "check-docs": {
      "module": "package:@team/checks/check.mjs",
      "export": "validate",
      "scope": "project",
      "inputs": {
        "manifest": {
          "base": "project", "path": "package.json",
          "allowedRoots": [{"base": "project", "path": "."}],
          "mustExist": true, "symlinks": "reject"
        }
      }
    }
  }
}
```

Add `"validators": ["check-docs"]` to the selected version. Available but unselected validator code is not imported. The export implements `SemanticValidator`: a synchronous or Promise-returning function receiving `ValidatorContext`, returning an array of `{code, message, pointer?, severity?, nextAction?}` diagnostics. Severity defaults to `error`; warnings remain warnings.

Context contains deeply frozen decoded values and interpreted paths, immutable project/repository identity, and `inspect(name)` for declared local inputs only. Inspection exposes metadata, not file contents. Input source-relative bases refer to the registration file. Required inputs are checked before importing code. Structural/local failures skip dependent checks explicitly; thrown/rejected checks or invalid diagnostic payloads become `VALIDATOR_FAILURE`. Independent checks/targets continue in deterministic order. `checks` reports passed, failed and skipped validators; skipped required checks cannot produce successful validation.

This is trusted in-process code, **not a sandbox**. Admission must include review and qualification for deterministic offline behavior, no writes, no secret/environment access and no network calls. Code can bypass the interface by importing Node facilities; package pinning and tests do not make malicious code safe. No executable validator is implied by a schema-only registration.

## Machine scope

Result envelopes retain `scope.projects` and `scope.domains` as requested filters.
`scope.requested` names those filters explicitly; empty filter arrays mean no filter,
not an empty evaluated inventory. `scope.evaluated` lists actual project/domain pairs.
`scope.repositoryWide` is true only after unfiltered validation returns its complete
coverage (which may include invalid configurations). Selection or setup failures
leave it false and report no completed coverage. Discovery is inventory, not validation.

## API

```ts
import { createClient, ConfigurationError } from '@butshouldwe/config-rush';

const client = createClient({ root: '/path/to/repo' });
const result = await client.get({ project: '@example/app', domain: 'tool' });
console.log(result.values, result.provenance, result.suppressed);
```

`get`, `discover`, `explain`, and `validate` have corresponding `getEffect`, `discoverEffect`, `explainEffect`, and `validateEffect` methods. Promise expected failures reject with `ConfigurationError`; Effect uses the same typed error channel. `explain` returns diagnostic data for invalid configuration, never a consumable partial value. `validate` aggregates independent project/domain failures. `get({optional:true,...})` returns `{absent:true,values:null,...}` only when registration permits absence; it cannot bypass requiredness.

Native JS configurations must resolve this installed package from the autoinstaller context. A bare import from an unrelated project is not assumed to work. For a native config, use Node's `createRequire` anchored at the repository's `common/autoinstallers/rush-plugins/package.json`, resolve this package, then `import()` its resolved entry. Both CJS and ESM callers may use asynchronous import; synchronous CJS loading is not promised. Do not use NODE_PATH or source-checkout imports.

## Read-only candidate previews

`client.previewCandidates({ documents: [{ project, domain, contents }] })` validates
complete JSONC document bytes without writing them. `previewCandidatesEffect` exposes
the same operation in the Effect error channel. Targets are exact registered
project/domain names, never arbitrary caller-provided paths. A single per-invocation
read context makes the full candidate set visible to the existing resolver;
ordinary `get` calls continue reading disk.

The returned results use actual repository/project/source paths. `inputs` records
observed file hashes, modes, inode/device identities, symlink targets, selected package
directory inventories and confirmed absence—not source payloads or environment
values. `inputFingerprint` binds those observations; `candidateFingerprint` binds the
ordered candidate request. A final observation pass rejects inputs changed during
validation. These are read observations, **not** an atomic snapshot or an apply token.

Limits: 128 candidate documents, one MiB per candidate, 16 MiB per observed file,
64 MiB of distinct observed file content, 16,384 observations and 4,096 entries per
admitted validator package. A limit failure returns diagnostics, never a partial
success. Candidate destinations cannot traverse symlinks or replace package/rig/Git
identity. Virtual directories exist only inside the preview, not on disk.

Admitted validator package content is fingerprinted before loading. Changed content
after a module has been cached fails with `VALIDATOR_PACKAGE_CHANGED`; restart the
consumer process and preview again. This does not sandbox trusted validators or
intercept their arbitrary direct Node IO. Declared inspections and admitted package
content are observed; dependency lockfiles are bound. The V1 trusted-code boundary
still applies.

This low-level candidate primitive is not the U02 authoring workflow: field-edit
translation, comment-preserving preview/apply plans, write-time preconditions,
cooperating-writer locking, journaling and recovery are not implemented by this API.
No new CLI write command or automatic persistence is implied.

## Verification

The package tests consume emitted `dist` output. The installed-artifact harness invokes Rush and an independent consumer process; it does not import package source. Local offline integration uses explicitly supplied artifact mappings and a real package-manager install, not fabricated Rush completion flags. Full monorepo lockfile/gate verification is distinct from a focused package test run.


## Safe project authoring

`previewEdits` and `previewEditsEffect` create a read-only, versioned plan. `applyEdits` and `applyEditsEffect` apply that exact plan. `editStatus` / `editStatusEffect` reconcile a recorded operation without writing. No convenience verb applies implicitly.

```ts
import { createClient, type EditRequest } from '@butshouldwe/config-rush';
const client = createClient({ root: process.cwd() });
const request: EditRequest = {
  requestVersion: 1,
  edits: [{
    project: '@example/app', domain: 'tool', operation: 'set',
    pointer: '/channel', value: null
  }]
};
const plan = await client.previewEdits(request);
// Inspect plan.targets before/after text, effective values, scope and diagnostics.
const result = await client.applyEdits(plan);
// An application failure after preflight can RETURN failure/partial with effects.
// Preflight errors reject (Effect API: typed ConfigurationError failure).
if (result.status !== 'success') console.error(result.effects, result.diagnostics);
```

Every edit names an exact project and registered domain. Request version 1 supports:

- `create`: a complete `document` envelope with format/domain/contract version and values. Refuses an existing local file; no skeletal invalid initialization.
- `set`: an RFC 6901 `pointer` relative to `values` and a JSON `value`. Null remains null; numbers, booleans, arrays and objects are never guessed from strings. Setting requires an existing local envelope.
- `unset`: removes only a locally authored field. Inherited values can reappear. Absent local fields/files, including a pointer below a local scalar, produce a no-change result with a note, not deletion of a shared source. `set` below a scalar is `INVALID_POINTER`.
- `suppress`: explicitly adds the pointer to the envelope's `suppress` list. Effective-schema validation still prohibits removal of required fields.
- `remove-suppression`: removes that explicit suppression, restoring normal inheritance.
- `set-version`: explicitly changes `contractVersion`; the full candidate must validate against that registered version. No migration or downgrade is automatic.

Pointers cannot address the entire envelope or escape `values`. A complete create is the way to supply new envelope metadata such as `extends`. Requests reject duplicate/ancestor-conflicting edits, unsafe paths and overlapping destinations before writes. Array indices are interpreted as indices only when traversing an actual array; multiple edits to one array must instead use an explicit whole-array value. Unrelated JSONC text/comments and the existing file's permission bits are preserved where not part of an edited range. Multiline edits infer indentation from structural JSONC tokens; ambiguous or unsupported indentation is refused, while exact scalar replacements preserve their original text surroundings.

A batch is validated as complete candidates, not invalid intermediate states. `unrelated` reports separately evaluated configuration failures outside the repair selection without blocking an otherwise valid local repair. This is not a repository-wide success certificate: `scope.repositoryWide` remains false. An unrelated value-only correction does not invalidate the selected plan. Changes to relevant metadata, sources, schemas, validator packages, file identities or permissions do.

Authoring is confined to registered project-local destinations. It refuses discovered rig-package destinations and documents referenced by other registered consumers, including consumers named in the same request. Resolution and protection share source-selection and parent-resource helpers; scope traversal uses the full candidate read context and fails closed at its explicit depth bound. It does not edit policy, shared defaults, schema registrations or validator packages as an implicit repair. Discovery and safety are bounded by the registered Rush universe; external consumers are not inferred.

### Rush / direct CLI flow

The direct binary supports the same verbs with `--json`. Rush contributes:

```text
rush config-preview --request-file request.json --result-file preview.json --invocation-id edit-preview-1
rush config-apply --plan-file preview.json --result-file applied.json --invocation-id edit-apply-1
rush config-status --operation-id <operationId>
```

The request file contains the `EditRequest` JSON object above. `--request-file -` reads stdin. Apply accepts a saved raw `EditPlan` or a successful CLI preview envelope; it re-derives the request rather than trusting supplied destination paths. Rejected authoring paths and thrown authoring preflight errors are reported on stdio only; they do not create a result artifact. A valid returned apply outcome (including partial effects) can still publish to an admitted result path. Do not edit a saved plan. A new preview is required after staleness or partial application; there is no force switch or automatic retry.

Convenience verbs construct the same preview request:

```text
rush config-init --project @example/app --domain tool --document-file complete-document.json --result-file init-plan.json
rush config-set --project @example/app --domain tool --pointer /channel --value null --result-file set-plan.json
rush config-unset --project @example/app --domain tool --pointer /channel --result-file unset-plan.json
rush config-suppress --project @example/app --domain tool --pointer /addons --result-file suppress-plan.json
rush config-remove-suppression --project @example/app --domain tool --pointer /addons --result-file unsuppress-plan.json
rush config-set-version --project @example/app --domain tool --contract-version 2.0.0 --result-file version-plan.json
```

The `--value` argument is a JSON literal (a string must include JSON quotes as well as any shell quoting). All plan/result paths must be fresh; caller-created parent directories must exist. Keep plans in an appropriate ignored/private directory: unlike journals, previews intentionally contain complete before/after configuration text. A result artifact cannot be a planned destination or occupy the writer-state directory.

### Atomicity, effects and interrupted operations

Qualification covers the tested Linux/Node 22 local-filesystem lane, not every OS or network filesystem. Existing files use a flushed sibling temporary and atomic rename. New files use atomic no-clobber hard-link publication so an intervening creator cannot be overwritten; unsupported hard links fail explicitly, with no silent fallback. The destination's own directory is flushed after publication; directories created above it are not individually flushed, so a power loss immediately after a `create` into a new directory can lose the entry while the journal says applied (status then reports it `unknown`). Newly created directories use restrictive permissions.

The Effect writer owns its operation lifetime. Interruption aborts publication at validation boundaries and joins the in-flight writer cleanup before the calling Effect exits; it does not leave a detached Promise writer. Trusted in-process validators cannot be forcibly stopped, so cancellation waits for an in-flight validator to settle. Process termination remains covered by journal/status reconciliation.

Before the first file write, the implementation revalidates under a non-waiting cooperating-writer lock. It checks observed inputs and shared-source boundaries again before subsequent writes, advancing preconditions to the planned hash and the inode produced by its own successful writes, never adopting freshly reread destination bytes. An editor that does not honor the lock can still race the final filesystem check and publication. This is not a universal compare-and-swap guarantee.

There is deliberately no repository-wide transaction. `effects` distinguishes `applied`, `failed`, `unattempted` and `unknown` targets with observed hashes. A late failure stops subsequent writes; it does not roll earlier files back. If result-file publication fails after a configuration write, the direct JSON response still carries the effects and exits 4. Human output also identifies the operation and journal.

Owned file acquisition establishes descriptor cleanup immediately after open. A failed identity read triggers one bounded ownership read during cleanup, not a write retry. If identity still cannot be established, the descriptor is closed and the path is preserved with RESOURCE_CLEANUP_UNKNOWN for explicit reconciliation; an unverified replacement is never blindly deleted.

Journals and the exclusive lock live under `common/temp/config-rush-authoring/` (Rush's ignored local temp area). Journals contain identities, hashes and phases, not configuration payloads. Storage is bounded to 256 journal files; a full store blocks new writes instead of silently deleting recovery evidence. A request may name up to 256 edits, but preview funnels its distinct destinations plus affected consumers through the candidate API, which admits 128 candidate documents; a request whose destinations exceed that fails with `CANDIDATE_LIMIT` before any validation.

Observations distinguish missing paths from existing non-files; a directory is not labeled original absence. `EditStatus` and its `Observation` union are exported. An applied file subsequently restored or changed externally remains historically applied in the journal and is classified as unknown for reconciliation, never unattempted.

`config-status` reads the journal, rechecks current destination hashes, and reports candidate/original/other/unknown observations and PID liveness. A crash between publication and its journal update remains an uncertain `writing` effect even when the bytes match the candidate. PID liveness is not proof of process identity after PID reuse, and the lock records no host: on a checkout shared or synced across machines, `ownerAlive: false` only says no such process exists on the host running status. Each target of an interrupted write also reports `temporary`, the staged candidate left beside its destination (`.config-rush-<operation>-<index>.tmp`), only when status has verified it as a regular file inside the repository; a symlink, an escaping path or a probe failure reports `null`. Status names it and never removes it.

Known, deferred design items: three source-chain walkers apply three depth policies (`SOURCE_SCOPE_LIMIT` at 128 in authoring scope, a fail-closed stop at 128 in declared-scope discovery, surfaced as `CONSUMER_SCOPE_UNPROVEN`, unbounded recursion in resolution); the ENOENT predicate and `overlaps` helper are duplicated with slightly different spellings; `config-status` reads the registry and project list unguarded; the exported client type is inferred rather than declared; `effect` is pinned to a release candidate without a peer-dependency note. None changes documented behavior; they are tracked for a follow-up slice.

`config-apply` is declared `safeForSimultaneousRushProcesses` so it never waits on Rush's repository lock: its exclusion is the writer lock below, which serializes cooperating config-rush writers only. A concurrent Rush process that purges `common/temp` (for example `rush purge`) removes that lock, and the journals beside it, from under a running or interrupted writer; do not run temp-purging Rush commands while an apply is in flight or while an interrupted operation is still unreconciled.

Abrupt termination deliberately leaves the lock and journal. A lock left empty or partial by a crash before its content was durable is reported by status as present with `readable: false` and no recorded owner; it still blocks writers. Status never deletes a lock, rewrites configuration or rolls anything back. An operator must inspect the operation, verify the owner is stopped, and separately authorize cleanup of the exact stale lock or archived journals. Do not blindly replay an interrupted request. A successful no-change apply has no journal because no configuration write occurred.


### Observation policy and aliases

Candidate observation size/count budgets apply to preview/apply validation, not ordinary U01 reads. Ordinary admitted-package fingerprints hash file contents through a fixed-size buffer without inheriting candidate budgets. Fingerprints remain content-sensitive; this is not permission to execute changed cached validator code.

Observed inputs record canonical paths for alias-aware staleness. Prospective resources resolve through admitted symbolic-link paths before consulting the candidate map. Own-write expectations advance canonical destinations and their observed aliases to the planned bytes and produced inode; independent hard links keep separate expectations. Link retargeting remains stale, and candidate write destinations still cannot traverse symlinks.


### Candidate and recovery invariants

Every requested target is resolved against the same candidate context, including no-op targets with no local document and rig-backed values. Unused unavailable validator admissions do not force installation, but declared validator-package projects and resolved package boundaries are not project-authoring destinations—even when those files are data consumed by code.

Package cache identities include lexical symlink records as well as canonical contents. Retargeting a helper link to an already-inventoried file invalidates the cached package. ObservedInput is a discriminated model: narrow kind before using identity/hash/link fields. Owned-file expectation advancement lives with that model, rather than being assembled independently by the writer.

A preflight failure and a cleanup failure are both preserved, including the exact resource path, even before a journal/outcome exists. Cleanup execution failures outrank retryable stale-input exit codes; interrupted Effects retain cleanup errors in their final cause. Status can still reconcile a journal whose project/domain is no longer mapped, without reading an arbitrary journal-supplied destination.

Unset removes the owned property/element syntax and value span without invoking the generic JSONC removal formatter. Standalone adjacent comments and comments between a key and its value survive; comments inside the removed value are part of the explicit deletion. Isolated deleted-member lines are removed cleanly; more complex trivia layouts retain untouched whitespace instead of reformatting neighboring content.


### Affected consumers and failure evidence

Authoring discovers unrequested consumers through declared validator inputs and domain path rules, read from each consumer's contract and raw documents before composition, so a consumer whose own document fails envelope, version, schema, merge or ownership checks still contributes its declared scope. A consumer whose declared scope cannot be read blocks authoring (`CONSUMER_SCOPE_UNPROVEN`) rather than being treated as unrelated; the same holds for shared-source safety (`SHARED_SOURCE_UNPROVEN`), including a declared rig or an installed validator package that cannot be resolved. A parent that provably does not exist or leaves its root is not anyone's source and does not block unrelated repairs; a request that would create such a parent is a shared-source edit. Declared business-path dependencies are currently observed by content and share the observation budgets; a declared output above 16 MiB blocks authoring, and rebuilding one between preview and apply invalidates the preview. Metadata-only observation for path rules is a planned follow-up. A participating consumer must pass against the complete candidate; a request may repair its existing constraint, but cannot ignore it. Unrelated existing failures and unrelated value changes remain nonblocking. Scope reports include the affected consumers without claiming a repository-wide pass.

Participation is recomputed between serial commits. The fresh discovery facts are checked again immediately before publication; a newly affected consumer stops further writes and requires a new preview. Affected inputs retain normal staleness protection. Discovery observation failures remain explicit rather than granting an unproved unrelated classification.

Relevant lockfiles retain both logical-link and physical-target observations. Journal capacity is checked under the writer lock. Journal write, descriptor-close and temporary-cleanup failures retain sanitized diagnostics with exact paths; descriptor closure is not blindly retried. Apply and status share tagged destination classification for every target, including those still pending when a write stops, so non-files and unreadable resources cannot be mistaken for original absence.
