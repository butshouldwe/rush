import path from 'node:path';
import { ReadContext, liveReads } from './read-context.js';
import { pathToFileURL } from 'node:url';
import { Predicate, Schema } from 'effect';
import { resource, registryFile } from './registry.js';
import { inspectDeclaredPath } from './paths.js';
import { diagnostic, fail } from './json.js';
import {
  ConfigurationError,
  type Diagnostic,
  type Query,
  type Registry,
  type ResolvedConfiguration,
  type ResolvedPath,
  type ValidatorCheck,
  type ValidatorContext,
  type VersionContract,
} from './types.js';

const loadedPackageFingerprints = new Map<string, string>();

const returnedDiagnostics = Schema.Array(
  Schema.Struct({
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
    pointer: Schema.optional(Schema.String),
    severity: Schema.optional(Schema.Literals(['error', 'warning'])),
    nextAction: Schema.optional(Schema.NonEmptyString),
  }),
);
function freeze(value: unknown): void {
  if (Predicate.isObject(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
export function skippedValidators(
  query: Query,
  contract: VersionContract,
  error: unknown,
  version: string,
  source: string,
): ConfigurationError {
  const original = diagnostic(error);
  const enriched: Diagnostic[] = [];
  for (const item of original.diagnostics)
    enriched.push({
      ...item,
      project: query.project,
      domain: query.domain,
      contractVersion: version,
      file: item.file ?? source,
      severity: item.severity ?? 'error',
      nextAction:
        item.nextAction ?? 'Correct the named configuration or contract field and rerun validation',
    });
  const failure = new ConfigurationError(enriched, original.checks);
  if (failure.checks.length || !contract.validators?.length) return failure;
  const checks: ValidatorCheck[] = contract.validators.toSorted().map((validator) => ({
    validator,
    project: query.project,
    domain: query.domain,
    status: 'skipped',
    reason: 'Structural or local requirements failed',
  }));
  const diagnostics: Diagnostic[] = [...failure.diagnostics];
  for (const check of checks)
    diagnostics.push({
      code: 'VALIDATOR_SKIPPED',
      severity: 'skipped',
      validator: check.validator,
      project: query.project,
      domain: query.domain,
      contractVersion: version,
      file: source,
      message: check.reason!,
      nextAction: 'Correct structural/local diagnostics and rerun validation',
    });
  return new ConfigurationError(diagnostics, checks);
}
/** Runs explicitly admitted code, not a sandbox. Package review is part of admission. */
export async function runSemanticValidators(
  root: string,
  project: string,
  registry: Registry,
  contract: VersionContract,
  result: ResolvedConfiguration,
  reads: ReadContext = liveReads,
): Promise<ResolvedConfiguration> {
  if (!contract.validators?.length || result.absent) return result;
  const checks: ValidatorCheck[] = [],
    diagnostics: Diagnostic[] = [];
  const values: Record<string, unknown> = structuredClone(result.values ?? {});
  const paths = structuredClone(result.paths ?? {});
  freeze(values);
  freeze(paths);
  for (const id of contract.validators.toSorted()) {
    const admission = registry.validators?.[id];
    if (!admission) return fail('VALIDATOR_NOT_ADMITTED', `Validator ${id} has no admission`);
    const base = {
      validator: id,
      project: result.project,
      domain: result.domain,
      contractVersion: result.contractVersion,
      file: result.sources[0],
    };
    let inspecting = false;
    let packageChanged = false;
    try {
      const inspected: Record<string, ResolvedPath> = Object.create(null);
      inspecting = true;
      for (const [name, input] of Object.entries(admission.inputs).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        inspected[name] = inspectDeclaredPath(
          root,
          project,
          path.join(root, registryFile),
          input.path,
          input,
          name,
          reads,
        );
        Object.freeze(inspected[name]);
      }
      inspecting = false;
      // Resolve and verify the declared package version before importing any code.
      const location = resource(root, registry, admission.module, root, root, reads);
      const fingerprint = reads.packageFingerprint(location.boundary);
      const previous = loadedPackageFingerprints.get(location.boundary);
      packageChanged = previous !== undefined && previous !== fingerprint;
      if (packageChanged)
        return fail(
          'VALIDATOR_PACKAGE_CHANGED',
          'Admitted package changed after module loading; restart the consumer process',
          location.file,
        );
      loadedPackageFingerprints.set(location.boundary, fingerprint);
      // eslint-disable-next-line no-await-in-loop -- Import and invocation are one serial admitted-check step.
      const module: unknown = await import(pathToFileURL(location.file).href);
      const fn: unknown = Predicate.isObject(module) ? module[admission.export] : undefined;
      if (typeof fn !== 'function')
        return fail('VALIDATOR_EXPORT', 'Admitted export is not a function', location.file);
      const context: ValidatorContext = Object.freeze({
        values,
        paths,
        repository: root,
        domain: result.domain,
        contractVersion: result.contractVersion,
        project: Object.freeze({ name: result.project, folder: project }),
        inspect: (name: string) => {
          if (!Object.hasOwn(admission.inputs, name))
            return fail('VALIDATOR_INPUT', `Input ${name} is not declared`);
          return inspected[name]!;
        },
      });
      // eslint-disable-next-line no-await-in-loop -- Do not fan out admitted code or its declared local inspections.
      const output: unknown = await fn(context);
      const decoded = Schema.decodeUnknownSync(returnedDiagnostics)(output, {
        onExcessProperty: 'error',
      });
      let failed = false;
      for (const item of decoded) {
        const severity = item.severity ?? 'error';
        if (severity === 'error') failed = true;
        diagnostics.push({
          ...item,
          ...base,
          severity,
          nextAction: item.nextAction ?? 'Correct this field and rerun validation',
        });
      }
      checks.push({
        validator: id,
        project: result.project,
        domain: result.domain,
        status: failed ? 'failed' : 'passed',
      });
    } catch (error) {
      if (inspecting) {
        for (const d of diagnostic(error).diagnostics)
          diagnostics.push({
            ...base,
            ...d,
            severity: 'error',
            nextAction: 'Correct the declared local input and rerun validation',
          });
        checks.push({
          validator: id,
          project: result.project,
          domain: result.domain,
          status: 'skipped',
          reason: 'Declared local input requirements failed',
        });
        continue;
      }
      // Do not leak arbitrary thrown payloads, environment values, or stack traces.
      diagnostics.push({
        ...base,
        code: packageChanged ? 'VALIDATOR_PACKAGE_CHANGED' : 'VALIDATOR_FAILURE',
        severity: 'error',
        message: packageChanged
          ? 'Admitted package changed after module loading'
          : `Admitted validator ${id} could not load, threw/rejected, or returned invalid diagnostics`,
        nextAction: packageChanged
          ? 'Restart the consumer process and create a fresh preview'
          : 'Check the pinned validator export, its declared inputs and its diagnostic contract',
      });
      checks.push({
        validator: id,
        project: result.project,
        domain: result.domain,
        status: 'failed',
      });
    }
  }
  if (diagnostics.some((item) => item.severity !== 'warning'))
    throw new ConfigurationError(diagnostics, checks);
  return { ...result, checks, ...(diagnostics.length ? { diagnostics } : {}) };
}
