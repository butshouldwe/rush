import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Effect, Schema, Exit, Cause, Predicate } from 'effect';
import {
  editRequestSchema,
  previewEdits,
  authoringScope,
  type EditPlan,
  type EditTarget,
} from './edits.js';
import { affectedConsumers } from './affected.js';
import { ReadContext, type ObservedInput, type FileObservation } from './read-context.js';
import { diagnostic, fail, readJson, contained } from './json.js';
import { readRegistry, readProjects } from './registry.js';
import { ConfigurationError, type Diagnostic } from './types.js';

export interface TargetEffect {
  project: string;
  domain: string;
  file: string;
  observedHash: string | null;
}
export interface EditEffects {
  applied: TargetEffect[];
  failed: TargetEffect[];
  unattempted: TargetEffect[];
  unknown: TargetEffect[];
}
export interface ApplyResult {
  operationId: string;
  planId: string;
  status: 'success' | 'failure' | 'partial';
  effects: EditEffects;
  diagnostics: readonly Diagnostic[];
  journal: string | null;
  scope: EditPlan['scope'];
  unrelated: EditPlan['unrelated'];
}
const savedPlanSchema = Schema.Struct({
  planVersion: Schema.Literal(1),
  root: Schema.String,
  planId: Schema.String,
  request: editRequestSchema,
});
const targetSchema = Schema.Struct({
  project: Schema.String,
  domain: Schema.String,
  file: Schema.String,
  beforeHash: Schema.NullOr(Schema.String),
  afterHash: Schema.NullOr(Schema.String),
  state: Schema.Literals(['pending', 'writing', 'applied', 'failed']),
});
const journalSchema = Schema.Struct({
  journalVersion: Schema.Literal(1),
  operationId: Schema.String,
  planId: Schema.String,
  ownerPid: Schema.Number,
  status: Schema.Literals(['applying', 'success', 'failure', 'partial']),
  targets: Schema.Array(targetSchema),
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Journal = Omit<Mutable<typeof journalSchema.Type>, 'targets'> & {
  targets: Mutable<typeof targetSchema.Type>[];
};
const lockSchema = Schema.Struct({ operationId: Schema.String, ownerPid: Schema.Number });
const decodePlan = Schema.decodeUnknownSync(savedPlanSchema);
const decodeJournal = Schema.decodeUnknownSync(journalSchema);
const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function requireLocalPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    fail('PATH_ESCAPE', 'Operation path leaves repository', target);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        fail('PATH_SYMLINK', 'Operation paths must not traverse symlinks', cursor);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
function mkdirs(root: string, directory: string): string[] {
  requireLocalPath(root, directory);
  const created: string[] = [];
  let cursor = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      fs.mkdirSync(cursor, { mode: 0o700 });
      created.push(cursor);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (!fs.lstatSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink())
        fail('PATH_SYMLINK', 'Expected a real directory', cursor);
    }
  }
  return created;
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function removeOwnedTemporary(file: string, identity: { dev: number; ino: number }): unknown {
  try {
    const current = fs.lstatSync(file);
    if (current.dev !== identity.dev || current.ino !== identity.ino)
      return new Error('Temporary ownership changed; file was preserved');
    fs.unlinkSync(file);
  } catch (error) {
    if (!missing(error)) return error;
  }
  return undefined;
}
interface OwnedFile {
  fd: number;
  identity: { dev: number; ino: number };
}
function openOwnedFile(file: string): OwnedFile {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    return { fd, identity: fs.fstatSync(fd) };
  } catch (error) {
    let identity: OwnedFile['identity'] | undefined;
    // A bounded metadata read during cleanup may recover ownership; never retry the write.
    try {
      identity = fs.fstatSync(fd);
    } catch {
      /* Ownership remains unknown. */
    }
    let closed = false;
    try {
      fs.closeSync(fd);
      closed = true;
    } catch {
      /* Surface uncertainty below, without unsafe close retries. */
    }
    const cleanup = identity
      ? removeOwnedTemporary(file, identity)
      : new Error('Unknown ownership');
    if (!closed || cleanup !== undefined)
      throw new ConfigurationError([
        {
          code: 'RESOURCE_CLEANUP_UNKNOWN',
          kind: 'execution',
          file,
          message:
            'Acquisition failed and resource cleanup could not be verified; inspect this exact path before retrying',
          nextAction:
            'Verify resource ownership before explicitly cleaning up; no unsafe deletion was attempted',
        },
      ]);
    throw error;
  }
}
/** Key-order-independent serialization, so a plan round-tripped through a normalizer still matches. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    Predicate.isObject(item) && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .toSorted()
            .map((k) => [k, Reflect.get(item, k)]),
        )
      : item,
  );
}
function saveJournal(file: string, journal: Journal): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { fd, identity } = openOwnedFile(temporary);
  let failed = false,
    failure: unknown,
    closeFailure: unknown;
  try {
    fs.writeFileSync(fd, JSON.stringify(journal, null, 2) + '\n');
    fs.fsyncSync(fd);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      closeFailure = error;
    }
  }
  if (!failed && closeFailure === undefined) {
    try {
      fs.renameSync(temporary, file);
      syncDirectory(path.dirname(file));
    } catch (error) {
      failed = true;
      failure = error;
    }
  }
  const cleanup = removeOwnedTemporary(temporary, identity);
  if (failed || closeFailure !== undefined || cleanup !== undefined)
    throw new ConfigurationError([
      ...(failed
        ? [
            {
              code: 'JOURNAL_WRITE_FAILED',
              kind: 'execution' as const,
              file: temporary,
              message:
                'Journal publication failed; reconcile the intended journal and this temporary',
              nextAction: 'Inspect journal state before any explicit retry',
            },
            ...(failure instanceof ConfigurationError ? failure.diagnostics : []),
          ]
        : []),
      ...(closeFailure !== undefined
        ? [
            {
              code: 'JOURNAL_DESCRIPTOR_CLEANUP_FAILED',
              kind: 'execution' as const,
              file: temporary,
              message:
                'Journal descriptor closure could not be confirmed; no close retry was attempted',
              nextAction: 'Inspect process resources before explicitly retrying',
            },
          ]
        : []),
      ...(cleanup !== undefined
        ? [
            {
              code: 'JOURNAL_TEMPORARY_CLEANUP_FAILED',
              kind: 'execution' as const,
              file: temporary,
              message: 'Journal temporary cleanup failed; this owned path may remain',
              nextAction: 'Verify ownership before explicitly removing this temporary',
            },
          ]
        : []),
    ]);
}
type DestinationObservation =
  | { kind: 'file'; sha256: string }
  | { kind: 'missing' | 'non-file' | 'unknown'; sha256: null };
function observeDestination(file: string): DestinationObservation {
  try {
    if (!fs.lstatSync(file).isFile()) return { kind: 'non-file', sha256: null };
    return {
      kind: 'file',
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    };
  } catch (error) {
    return { kind: missing(error) ? 'missing' : 'unknown', sha256: null };
  }
}
function targetEffect(
  target: { project: string; domain: string; file: string },
  observation = observeDestination(target.file),
): TargetEffect {
  return {
    project: target.project,
    domain: target.domain,
    file: target.file,
    observedHash: observation.sha256,
  };
}
function observeTarget(
  target: Pick<EditTarget, 'project' | 'domain' | 'file' | 'beforeHash' | 'afterHash'>,
): TargetEffect & { observed: Observation } {
  const value = observeDestination(target.file);
  const observed: Observation =
    value.kind === 'unknown'
      ? 'unknown'
      : value.kind === 'non-file'
        ? 'other'
        : value.kind === 'file' && value.sha256 === target.afterHash
          ? 'candidate'
          : value.sha256 === target.beforeHash
            ? 'original'
            : 'other';
  return { ...targetEffect(target, value), observed };
}
function refreshOwned(inputs: ObservedInput[], changed: Set<string>): ObservedInput[] {
  const updated = new Map(
    ReadContext.currentInputs(inputs.filter((input) => changed.has(input.path))).map((input) => [
      input.path,
      input,
    ]),
  );
  return inputs.map((input) => {
    const direct = updated.get(input.path);
    if (direct) return direct;
    const canonical = input.canonicalPath && updated.get(input.canonicalPath);
    return canonical && input.kind === 'missing' ? { ...canonical, path: input.path } : input;
  });
}
async function revalidate(
  root: string,
  saved: ReturnType<typeof decodePlan>,
  submitted: EditPlan,
): Promise<EditPlan> {
  try {
    const fresh = await previewEdits(root, saved.request);
    if (
      fresh.root !== saved.root ||
      fresh.planId !== saved.planId ||
      canonical({ ...fresh, unrelated: undefined }) !==
        canonical({ ...submitted, unrelated: undefined })
    )
      return fail('STALE_PREVIEW', 'Preview no longer matches inputs or request; preview again');
    return fresh;
  } catch (error) {
    if (diagnostic(error).diagnostics.some((item) => item.kind === 'execution')) throw error;
    return fail(
      'STALE_PREVIEW',
      'Preview no longer matches valid current inputs; create a fresh preview',
    );
  }
}

/** Cooperating writers serialize; external check-to-rename replacement remains a documented race. */
interface WriterLifetime {
  controller: AbortController;
  pending?: Promise<ApplyResult>;
}

/** Interruption waits for the in-flight validator and writer cleanup; no detached writer survives the Effect. */
export const applyEditsEffect = Effect.fn('config-rush.applyEdits')(function* (
  root: string,
  plan: EditPlan,
) {
  return yield* Effect.acquireUseRelease(
    Effect.sync((): WriterLifetime => ({ controller: new AbortController() })),
    (lifetime) =>
      Effect.tryPromise({
        try: () => {
          lifetime.pending = applyEdits(root, plan, lifetime.controller.signal);
          return lifetime.pending;
        },
        catch: diagnostic,
      }),
    (lifetime, exit) =>
      Effect.tryPromise({
        try: async () => {
          lifetime.controller.abort();
          try {
            const outcome = await lifetime.pending;
            if (
              Exit.isFailure(exit) &&
              exit.cause.reasons.some(Cause.isInterruptReason) &&
              outcome?.diagnostics.some((item) => item.kind === 'execution')
            )
              throw new ConfigurationError(outcome.diagnostics);
          } catch (error) {
            // Ordinary failures already belong to use; interruption must not hide cleanup failure.
            if (
              Exit.isFailure(exit) &&
              exit.cause.reasons.some(Cause.isInterruptReason) &&
              diagnostic(error).diagnostics.some((item) => item.kind === 'execution')
            )
              throw error;
          }
        },
        catch: diagnostic,
      }),
  );
});

function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted) fail('OPERATION_INTERRUPTED', 'Authoring was interrupted before publication');
}
const scopeKey = (entries: readonly { project: string; domain: string }[]): string =>
  JSON.stringify(entries.map(({ project, domain }) => [project, domain]).toSorted());
function requireJournalCapacity(storage: string): void {
  if (fs.readdirSync(storage).filter((name) => name.endsWith('.json')).length >= 256)
    return fail(
      'JOURNAL_LIMIT',
      'Operation history is full; archive reviewed journals explicitly',
      storage,
    );
}

async function applyEdits(root: string, plan: EditPlan, signal: AbortSignal): Promise<ApplyResult> {
  checkInterrupted(signal);
  const saved = decodePlan(plan); // Other submitted summary/target fields never grant write authority.
  const initial = await revalidate(root, saved, plan);
  checkInterrupted(signal);
  const operationId = randomUUID();
  const empty: EditEffects = { applied: [], failed: [], unattempted: [], unknown: [] };
  if (initial.targets.every((target) => !target.changed))
    return {
      operationId,
      planId: saved.planId,
      status: 'success',
      effects: empty,
      diagnostics: [],
      journal: null,
      scope: initial.scope,
      unrelated: initial.unrelated,
    };
  const repository = initial.root;
  const storage = path.join(repository, 'common/temp/config-rush-authoring');
  mkdirs(repository, storage);
  requireJournalCapacity(storage);
  const lockFile = path.join(storage, 'writer.lock');
  let acquired: OwnedFile;
  try {
    acquired = openOwnedFile(lockFile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return fail(
        'WRITER_BUSY',
        'Another writer or an unreconciled interrupted writer owns the lock',
        lockFile,
      );
    throw error;
  }
  const { fd: lockFd, identity: owner } = acquired;
  const journalFile = path.join(storage, `${operationId}.json`);
  let journal: Journal | undefined;
  let effects = empty;
  let diagnostics: readonly Diagnostic[] = [];
  let current: EditTarget | undefined;
  let outcome: ApplyResult | undefined;
  let preflightFailure: ConfigurationError | undefined;
  let leftoverTemporary: string | undefined;
  let leftoverIdentity: { dev: number; ino: number } | undefined;
  let committedCurrent = false;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ operationId, ownerPid: process.pid }));
    fs.fsyncSync(lockFd);
    requireJournalCapacity(storage);
    const fresh = await revalidate(repository, saved, plan);
    checkInterrupted(signal);
    let expected = fresh.inputs;
    const targets = fresh.targets.filter((target) => target.changed);
    journal = {
      journalVersion: 1,
      operationId,
      planId: fresh.planId,
      ownerPid: process.pid,
      status: 'applying',
      targets: targets.map((target) => ({
        project: target.project,
        domain: target.domain,
        file: target.file,
        beforeHash: target.beforeHash,
        afterHash: target.afterHash,
        state: 'pending',
      })),
    };
    saveJournal(journalFile, journal);
    for (const [index, target] of targets.entries()) {
      checkInterrupted(signal);
      current = target;
      committedCurrent = false;
      try {
        ReadContext.assertInputs(expected);
      } catch (error) {
        if (diagnostic(error).diagnostics.some((item) => item.code === 'INPUT_CHANGED'))
          return fail(
            'STALE_PREVIEW',
            'Inputs changed before the next write; inspect the operation status',
            target.file,
          );
        throw error;
      }
      if (authoringScope(repository, fresh.targets) !== fresh.sourceScopeFingerprint)
        return fail(
          'STALE_PREVIEW',
          'Shared-source relationships changed; preview again',
          target.file,
        );
      // Recompute participation, not unrelated value hashes: a newly affected consumer invalidates this plan.
      // eslint-disable-next-line no-await-in-loop -- Recheck consumer participation between serial file commits.
      const peers = await affectedConsumers(
        repository,
        readRegistry(repository),
        readProjects(repository),
        fresh.targets,
      );
      const expectedPeers = fresh.scope.evaluated.filter(
        (entry) =>
          !fresh.targets.some(
            (item) => item.project === entry.project && item.domain === entry.domain,
          ),
      );
      if (scopeKey(peers.affected) !== scopeKey(expectedPeers))
        return fail(
          'STALE_PREVIEW',
          'Affected consumer scope changed; create a fresh preview',
          target.file,
        );
      checkInterrupted(signal);
      ReadContext.assertInputs(expected);
      requireLocalPath(repository, target.file);
      const created = mkdirs(repository, path.dirname(target.file));
      expected = refreshOwned(expected, new Set(created));
      // This target's own mkdirs() advanced `expected`; the affected-consumer guard
      // snapshot was taken before that and must not treat our own creation as external.
      peers.guards = refreshOwned(peers.guards, new Set(created));
      const temporary = temporaryFor(target.file, operationId, index);
      const { fd, identity } = openOwnedFile(temporary);
      leftoverTemporary = temporary;
      leftoverIdentity = identity;
      let produced: FileObservation;
      try {
        const mode = target.before !== null ? fs.statSync(target.file).mode & 0o7777 : 0o600;
        fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, target.after!);
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        produced = ReadContext.producedFile(target.file, stat, target.afterHash!);
      } finally {
        fs.closeSync(fd);
      }
      let temporaryCleanup: unknown;
      try {
        ReadContext.assertInputs(expected, [temporary]);
        journal.targets[index]!.state = 'writing';
        saveJournal(journalFile, journal);
        // Recheck after durable intent, immediately before the filesystem commit primitive.
        ReadContext.assertInputs(expected, [temporary]);
        ReadContext.assertInputs(peers.guards, [temporary]);
        if (target.before === null) fs.linkSync(temporary, target.file);
        else fs.renameSync(temporary, target.file);
        committedCurrent = true;
        const observed = targetEffect(target);
        effects.applied.push(observed);
        if (observed.observedHash !== target.afterHash)
          return fail(
            'WRITE_VERIFICATION_FAILED',
            'Written file does not match the candidate; reconcile operation status',
            target.file,
          );
        syncDirectory(path.dirname(target.file));
        journal.targets[index]!.state = 'applied';
        saveJournal(journalFile, journal);
        // Pin the intended bytes and the inode actually produced, never reread a
        // possibly replaced destination to define what this operation expects.
        expected = ReadContext.advanceWrite(expected, produced);
      } finally {
        temporaryCleanup = removeOwnedTemporary(temporary, leftoverIdentity);
      }
      if (temporaryCleanup !== undefined) throw temporaryCleanup;
    }
    ReadContext.assertInputs(expected);
    journal.status = 'success';
    saveJournal(journalFile, journal);
    return (outcome = {
      operationId,
      planId: saved.planId,
      status: 'success',
      effects,
      diagnostics,
      journal: journalFile,
      scope: initial.scope,
      unrelated: initial.unrelated,
    });
  } catch (error) {
    diagnostics = diagnostic(error).diagnostics;
    if (!journal) preflightFailure = diagnostic(error);
    else {
      const currentEntry = journal.targets.find((target) => target.file === current?.file);
      if (current && !committedCurrent) {
        const { observed: classification, ...observed } = observeTarget(current);
        if (classification === 'original') {
          effects.failed.push(observed);
          if (currentEntry) currentEntry.state = 'failed';
        } else {
          effects.unknown.push(observed);
          if (currentEntry) currentEntry.state = 'writing';
        }
      }
      if (current && committedCurrent && currentEntry?.state !== 'applied') {
        effects.applied = effects.applied.filter((target) => target.file !== current!.file);
        effects.unknown.push(targetEffect(current));
      }
      for (const applied of effects.applied) {
        const observed = targetEffect(applied);
        if (
          observed.observedHash !==
          journal.targets.find((target) => target.file === applied.file)?.afterHash
        ) {
          effects.applied = effects.applied.filter((target) => target.file !== applied.file);
          if (!effects.unknown.some((target) => target.file === applied.file))
            effects.unknown.push(observed);
        }
      }
      // Pending targets share status's tagged classification: only an observed original is
      // unattempted; a replaced, non-file or unreadable destination is unknown in both views.
      for (const target of journal.targets) {
        if (target.state !== 'pending' || target.file === current?.file) continue;
        const { observed: classification, ...observed } = observeTarget(target);
        (classification === 'original' ? effects.unattempted : effects.unknown).push(observed);
      }
      journal.status = effects.applied.length || effects.unknown.length ? 'partial' : 'failure';
      try {
        saveJournal(journalFile, journal);
      } catch (journalError) {
        diagnostics = [
          ...diagnostics,
          ...diagnostic(journalError).diagnostics,
          {
            code: 'JOURNAL_WRITE_FAILED',
            kind: 'execution',
            message: 'Journal update failed; reconcile actual files before retrying',
          },
        ];
      }
      return (outcome = {
        operationId,
        planId: saved.planId,
        status: journal.status,
        effects,
        diagnostics,
        journal: journalFile,
        scope: initial.scope,
        unrelated: initial.unrelated,
      });
    }
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      fs.closeSync(lockFd);
    } catch (error) {
      if (!missing(error)) cleanupFailures.push(error);
    }
    // Temporary cleanup is independently possible even when closing the lock
    // descriptor failed above; one resource's close error must not skip another's.
    if (leftoverTemporary && leftoverIdentity) {
      const cleanup = removeOwnedTemporary(leftoverTemporary, leftoverIdentity);
      if (cleanup !== undefined && outcome) {
        outcome.status =
          outcome.effects.applied.length || outcome.effects.unknown.length ? 'partial' : 'failure';
        outcome.diagnostics = [
          ...outcome.diagnostics,
          {
            code: 'TEMPORARY_CLEANUP_FAILED',
            kind: 'execution',
            message: 'Temporary cleanup failed; inspect the recorded operation before retrying',
          },
        ];
        if (journal) {
          journal.status = outcome.status;
          try {
            saveJournal(journalFile, journal);
          } catch (journalError) {
            outcome.diagnostics = [...outcome.diagnostics, ...diagnostic(journalError).diagnostics];
          }
        }
      } else if (cleanup !== undefined) {
        cleanupFailures.push(cleanup);
      }
    }
    try {
      const currentLock = fs.lstatSync(lockFile);
      if (currentLock.dev === owner.dev && currentLock.ino === owner.ino) fs.unlinkSync(lockFile);
    } catch (error) {
      if (!missing(error)) cleanupFailures.push(error);
    }
    for (const error of cleanupFailures) {
      if (!outcome) {
        preflightFailure = new ConfigurationError(
          [
            ...(preflightFailure?.diagnostics ?? []),
            {
              code: 'OPERATION_CLEANUP_FAILED',
              kind: 'execution',
              file: lockFile,
              message:
                'Writer cleanup failed before an outcome existed; inspect this exact lock path',
              nextAction:
                'Resolve the original failure and verify lock ownership before explicit cleanup',
            },
          ],
          preflightFailure?.checks,
        );
        continue;
      }
      outcome.status =
        outcome.effects.applied.length || outcome.effects.unknown.length ? 'partial' : 'failure';
      outcome.diagnostics = [
        ...outcome.diagnostics,
        ...(error instanceof ConfigurationError ? error.diagnostics : []),
        {
          code: 'OPERATION_CLEANUP_FAILED',
          kind: 'execution',
          message: 'Inspect the journal and writer lock before retrying',
        },
      ];
      if (journal) {
        journal.status = outcome.status;
        try {
          saveJournal(journalFile, journal);
        } catch (journalError) {
          outcome.diagnostics = [...outcome.diagnostics, ...diagnostic(journalError).diagnostics];
        }
      }
    }
  }
  throw preflightFailure ?? new Error('Writer ended without an outcome');
}

/** The staged candidate lives beside its destination under a name derived from the operation. */
const temporaryFor = (file: string, operationId: string, index: number): string =>
  path.join(path.dirname(file), `.config-rush-${operationId}-${index}.tmp`);
export type Observation = 'candidate' | 'original' | 'other' | 'unknown';
export interface EditStatus extends Readonly<Omit<Journal, 'targets'>> {
  readonly targets: readonly (Readonly<Journal['targets'][number]> & {
    readonly observed: Observation;
    readonly observedHash: string | null;
    /** A staged candidate left beside the destination by an interrupted write, if present. */
    readonly temporary: string | null;
  })[];
  readonly effects: EditEffects;
  readonly lock:
    | { operationId: string; ownerPid: number; ownerAlive: boolean | 'unknown'; readable: true }
    | { operationId: null; ownerPid: null; ownerAlive: 'unknown'; readable: false }
    | null;
  readonly recovery: string;
}
export async function editStatus(root: string, operationId: string): Promise<EditStatus> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId))
    return fail('INVALID_OPERATION_ID', 'Expected the exact operation UUID');
  const repository = fs.realpathSync(root);
  const storage = path.join(repository, 'common/temp/config-rush-authoring');
  const file = path.join(storage, `${operationId}.json`);
  requireLocalPath(repository, file);
  const journal = decodeJournal(readJson(file), { onExcessProperty: 'error' });
  if (journal.operationId !== operationId)
    return fail('JOURNAL_IDENTITY', 'Journal identity mismatch', file);
  const registry = readRegistry(repository),
    projects = readProjects(repository);
  const targets = journal.targets.map<EditStatus['targets'][number]>((target, index) => {
    // An interrupted write may leave the staged candidate beside its destination; it is
    // reported by name so the operator has an identifier even when the destination no
    // longer maps to a registered project or domain. Status never removes it.
    // Report a staged temporary only when it is verified: inside the repository and a
    // regular file. A containment failure (escape, symlink) or an unreadable probe is
    // not a staged candidate, so it stays null rather than naming an unverified path.
    const staged = temporaryFor(target.file, operationId, index);
    let temporary: string | null = null;
    try {
      requireLocalPath(repository, staged);
      if (fs.lstatSync(staged).isFile()) temporary = staged;
    } catch {
      temporary = null;
    }
    const unknown = { ...target, observed: 'unknown' as const, observedHash: null, temporary };
    const project = projects.find((entry) => entry.packageName === target.project);
    if (!project) return unknown;
    const domain = registry.domains.find((entry) => entry.name === target.domain);
    if (!domain) return unknown;
    const expected = path.resolve(contained(repository, project.projectFolder), domain.projectFile);
    if (expected !== target.file) return unknown;
    requireLocalPath(repository, expected);
    return { ...target, ...observeTarget(target), temporary };
  });
  let lock: EditStatus['lock'] = null;
  const lockFile = path.join(storage, 'writer.lock');
  requireLocalPath(repository, lockFile);
  // A crash between lock creation and its content fsync leaves an empty or partial lock; an
  // unreadable lock still exists and still blocks writers, so status reports it rather than failing.
  let present = true;
  try {
    fs.lstatSync(lockFile);
  } catch (error) {
    if (missing(error)) present = false;
    else lock = { operationId: null, ownerPid: null, ownerAlive: 'unknown', readable: false };
  }
  if (present && !lock)
    try {
      const owner = Schema.decodeUnknownSync(lockSchema)(readJson(lockFile), {
        onExcessProperty: 'error',
      });
      let ownerAlive: boolean | 'unknown' = 'unknown';
      if (Number.isSafeInteger(owner.ownerPid) && owner.ownerPid > 0) {
        try {
          process.kill(owner.ownerPid, 0);
          ownerAlive = true;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
            ownerAlive = false;
        }
      }
      lock = { ...owner, ownerAlive, readable: true };
    } catch (error) {
      if (diagnostic(error).diagnostics.every((item) => item.code === 'FILE_MISSING')) lock = null;
      else lock = { operationId: null, ownerPid: null, ownerAlive: 'unknown', readable: false };
    }
  const effects: EditEffects = { applied: [], failed: [], unattempted: [], unknown: [] };
  for (const target of targets) {
    const key =
      target.state === 'applied' && target.observed === 'candidate'
        ? 'applied'
        : target.state === 'failed' && target.observed === 'original'
          ? 'failed'
          : target.state === 'pending' && target.observed === 'original'
            ? 'unattempted'
            : 'unknown';
    effects[key].push({
      project: target.project,
      domain: target.domain,
      file: target.file,
      observedHash: target.observedHash,
    });
  }
  return {
    ...journal,
    targets,
    effects,
    lock,
    recovery:
      'Read-only reconciliation: candidate/original describe current bytes, not proof of interrupted execution. Do not replay saved requests or delete files automatically. If a dead writer left a lock, verify ownership and remove that lock explicitly before creating a fresh preview. An unreadable lock has no recorded owner; confirm no writer is running before removing it. A target with a `temporary` path holds a staged candidate left by an interrupted write; it is owned by that operation and may be removed once no writer is running.',
  };
}
