import path from 'node:path';
import { applyEditsEffect as managedApplyEdits, editStatus } from './authoring.js';
export type {
  ApplyResult,
  EditEffects,
  TargetEffect,
  EditStatus,
  Observation,
} from './authoring.js';
import { previewEdits, type EditRequest, type EditPlan } from './edits.js';
export type { EditRequest, EditPlan, EditTarget } from './edits.js';
import { previewCandidates } from './candidates.js';
import { Effect, Schema } from 'effect';
import { diagnostic, fail } from './json.js';
import { readProjects, readRegistry } from './registry.js';
import { resolve } from './resolve.js';
import type { Explanation, Query, ValidationResult } from './types.js';
export type { CandidateRequest, CandidatePreview } from './candidates.js';
export type { ObservedInput } from './read-context.js';
export { ConfigurationError } from './types.js';
export type {
  Diagnostic,
  Query,
  Origin,
  ResolvedConfiguration,
  Explanation,
  ValidationResult,
  Registry,
  Domain,
  VersionContract,
  PathBase,
  PathRoot,
  PathRule,
  ResolvedPath,
  ValidatorAdmission,
  ValidatorContext,
  ValidatorDiagnostic,
  SemanticValidator,
  ValidatorCheck,
} from './types.js';

const querySchema = Schema.Struct({
  project: Schema.NonEmptyString,
  domain: Schema.NonEmptyString,
  optional: Schema.optional(Schema.Boolean),
});
const selectionSchema = Schema.Struct({
  allowEmpty: Schema.optional(Schema.Boolean),
  projects: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  domains: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});
const optionsSchema = Schema.Struct({ root: Schema.NonEmptyString });
const decodeQuery = Schema.decodeUnknownSync(querySchema);

export interface Selection {
  allowEmpty?: boolean;
  projects?: readonly string[];
  domains?: readonly string[];
}

/** A client is bound to one explicit repository; it does not change cwd or initialize Rush. */
export function createClient(options: { root: string }) {
  const { root: suppliedRoot } = Schema.decodeUnknownSync(optionsSchema)(options, {
    onExcessProperty: 'error',
  });
  const root = path.resolve(suppliedRoot);
  const getEffect = (query: Query) =>
    Effect.tryPromise({
      try: () => resolve(root, decodeQuery(query, { onExcessProperty: 'error' })),
      catch: diagnostic,
    });
  const explainEffect = (query: Query) =>
    Effect.tryPromise({
      try: async (): Promise<Explanation> => {
        const decoded = decodeQuery(query, { onExcessProperty: 'error' });
        const sources: string[] = [];
        const evaluated: Explanation['evaluated'] = [];
        try {
          const resolved = await resolve(root, decoded, sources, evaluated);
          return {
            project: decoded.project,
            domain: decoded.domain,
            valid: true,
            result: resolved,
            sources,
            evaluated,
            diagnostics: resolved.diagnostics ?? [],
            ...(resolved.checks ? { checks: resolved.checks } : {}),
          };
        } catch (error) {
          return {
            project: decoded.project,
            domain: decoded.domain,
            valid: false,
            result: null,
            sources,
            evaluated,
            diagnostics: diagnostic(error).diagnostics,
            ...(diagnostic(error).checks.length ? { checks: diagnostic(error).checks } : {}),
          };
        }
      },
      catch: diagnostic,
    });
  const discoverEffect = () =>
    Effect.try({
      try: () => ({
        projects: readProjects(root)
          .map((p) => ({ name: p.packageName, folder: p.projectFolder }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
        domains: readRegistry(root)
          .domains.map((d) => ({
            name: d.name,
            projectFile: d.projectFile,
            required: d.required ?? false,
            versions: Object.keys(d.versions).toSorted(),
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      }),
      catch: diagnostic,
    });
  const validateEffect = (selection: Selection = {}) =>
    Effect.tryPromise({
      try: async (): Promise<ValidationResult> => {
        const selected = Schema.decodeUnknownSync(selectionSchema)(selection, {
          onExcessProperty: 'error',
        });
        const projects = readProjects(root)
          .map((p) => p.packageName)
          .toSorted();
        const domains = readRegistry(root)
          .domains.map((d) => d.name)
          .toSorted();
        for (const p of selected.projects ?? [])
          if (!projects.includes(p)) fail('UNKNOWN_PROJECT', `Unknown exact project ${p}`);
        for (const d of selected.domains ?? [])
          if (!domains.includes(d)) fail('UNKNOWN_DOMAIN', `Unknown domain ${d}`);
        const wantedProjects = [...new Set(selected.projects ?? projects)].toSorted();
        const wantedDomains = [...new Set(selected.domains ?? domains)].toSorted();
        if ((!wantedProjects.length || !wantedDomains.length) && !selected.allowEmpty)
          fail(
            'EMPTY_SELECTION',
            'Validation selected no project/domain pairs; set allowEmpty explicitly only when intended',
          );
        const result: ValidationResult = { valid: true, evaluated: [], diagnostics: [] };
        const errors = [];
        const checks = [];
        for (const project of wantedProjects)
          for (const domain of wantedDomains) {
            result.evaluated.push({ project, domain });
            try {
              // eslint-disable-next-line no-await-in-loop -- Bound workspace IO; keep target evaluation serial and ordered.
              const value = await resolve(root, { project, domain, optional: true });
              errors.push(...(value.diagnostics ?? []));
              checks.push(...(value.checks ?? []));
            } catch (error) {
              for (const d of diagnostic(error).diagnostics) errors.push({ ...d, project, domain });
              checks.push(...diagnostic(error).checks);
            }
          }
        return {
          ...result,
          valid: !errors.some((item) => item.severity !== 'warning'),
          diagnostics: errors,
          ...(checks.length ? { checks } : {}),
        };
      },
      catch: diagnostic,
    });
  const previewCandidatesEffect = (request: import('./candidates.js').CandidateRequest) =>
    Effect.tryPromise({ try: () => previewCandidates(root, request), catch: diagnostic });
  const previewEditsEffect = (request: EditRequest) =>
    Effect.tryPromise({ try: () => previewEdits(root, request), catch: diagnostic });
  const applyEditsEffect = (plan: EditPlan) => managedApplyEdits(root, plan);
  const editStatusEffect = (operationId: string) =>
    Effect.tryPromise({ try: () => editStatus(root, operationId), catch: diagnostic });
  return {
    applyEditsEffect,
    applyEdits: (plan: EditPlan) => Effect.runPromise(applyEditsEffect(plan)),
    editStatusEffect,
    editStatus: (operationId: string) => Effect.runPromise(editStatusEffect(operationId)),
    previewEditsEffect,
    previewEdits: (request: EditRequest) => Effect.runPromise(previewEditsEffect(request)),
    previewCandidatesEffect,
    previewCandidates: (request: import('./candidates.js').CandidateRequest) =>
      Effect.runPromise(previewCandidatesEffect(request)),
    getEffect,
    explainEffect,
    discoverEffect,
    validateEffect,
    get: (query: Query) => Effect.runPromise(getEffect(query)),
    explain: (query: Query) => Effect.runPromise(explainEffect(query)),
    discover: () => Effect.runPromise(discoverEffect()),
    validate: (selection: Selection = {}) => Effect.runPromise(validateEffect(selection)),
  };
}
export type ConfigurationClient = ReturnType<typeof createClient>;
