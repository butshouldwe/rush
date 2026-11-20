import { ReadContext, liveReads } from './read-context.js';
import { discoverSource, sourceParent } from './sources.js';
import { Predicate } from 'effect';
import { interpretPaths } from './paths.js';
import { runSemanticValidators, skippedValidators } from './semantic.js';
import { contained, fail, pointer, pointerParts } from './json.js';
import {
  checked,
  domainNamed,
  envelope,
  readProjects,
  readRegistry,
  validators,
  type Resource,
} from './registry.js';
import type { Origin, Query, ResolvedConfiguration, VersionContract } from './types.js';

interface State {
  values: Record<string, unknown>;
  provenance: Record<string, Origin>;
  suppressed: Record<string, Origin>;
}
const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
function clear(map: Record<string, Origin>, prefix: string): void {
  for (const key of Object.keys(map))
    if (key === prefix || key.startsWith(`${prefix}/`)) delete map[key];
}
function own(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function record(
  value: unknown,
  parts: string[],
  origin: Origin,
  map: Record<string, Origin>,
): void {
  map[pointer(parts)] = origin;
  if (Array.isArray(value)) value.forEach((v, i) => record(v, [...parts, String(i)], origin, map));
  else if (Predicate.isObject(value))
    for (const [key, v] of Object.entries(value)) record(v, [...parts, key], origin, map);
}
function assign(
  state: State,
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  parts: string[],
  origin: Origin,
  contract: VersionContract,
): void {
  const at = pointer(parts);
  const mode = contract.merge?.[at] ?? 'replace';
  const previous = Object.hasOwn(target, key) ? target[key] : undefined;
  if (mode === 'merge' && previous !== undefined) {
    if (!Predicate.isObject(previous) || !Predicate.isObject(value))
      return fail('MERGE_TYPE', 'Object merge requires object inputs', origin.source, at);
    for (const [child, childValue] of Object.entries(value))
      assign(state, previous, child, childValue, [...parts, child], origin, contract);
    state.provenance[at] = origin;
  } else if (mode === 'append' && previous !== undefined) {
    if (!Array.isArray(previous) || !Array.isArray(value))
      return fail('MERGE_TYPE', 'Array append requires array inputs', origin.source, at);
    const offset = previous.length;
    own(target, key, [...previous, ...structuredClone(value)]);
    state.provenance[at] = origin;
    value.forEach((v, i) => record(v, [...parts, String(offset + i)], origin, state.provenance));
  } else {
    if (mode === 'merge' && !Predicate.isObject(value))
      return fail('MERGE_TYPE', 'Object merge requires an object', origin.source, at);
    if (mode === 'append' && !Array.isArray(value))
      return fail('MERGE_TYPE', 'Array append requires an array', origin.source, at);
    own(target, key, structuredClone(value));
    clear(state.provenance, at);
    record(value, parts, origin, state.provenance);
  }
  if (mode === 'merge' && previous !== undefined) delete state.suppressed[at];
  else clear(state.suppressed, at);
}
function suppress(state: State, at: string, origin: Origin): void {
  const parts = pointerParts(at);
  let target: Record<string, unknown> = state.values;
  for (const part of parts.slice(0, -1)) {
    const value = Object.hasOwn(target, part) ? target[part] : undefined;
    if (!Predicate.isObject(value))
      return fail(
        'SUPPRESSION_TARGET',
        'Suppression requires an inherited object property, not an array element',
        origin.source,
        at,
      );
    target = value;
  }
  const last = parts[parts.length - 1]!;
  if (!Object.hasOwn(target, last))
    return fail(
      'SUPPRESSION_TARGET',
      'No inherited value exists at this pointer',
      origin.source,
      at,
    );
  delete target[last];
  clear(state.provenance, at);
  state.suppressed[at] = origin;
}
function mergeRules(contract: VersionContract): void {
  for (const at of Object.keys(contract.merge ?? {})) {
    const parts = pointerParts(at);
    for (let i = 1; i < parts.length; i++) {
      if (contract.merge?.[pointer(parts.slice(0, i))] !== 'merge')
        fail(
          'MERGE_RULE_UNREACHABLE',
          'Nested merge rules require object-merge ancestors',
          undefined,
          at,
        );
    }
  }
}

export async function resolve(
  root: string,
  query: Query,
  sources: string[] = [],
  evaluated: { project: string; domain: string }[] = [],
  reads: ReadContext = liveReads,
): Promise<ResolvedConfiguration> {
  const registry = readRegistry(root, reads);
  const domain = domainNamed(registry, query.domain);
  const project = readProjects(root, reads).find((p) => p.packageName === query.project);
  if (!project)
    return fail(
      'UNKNOWN_PROJECT',
      `Unknown exact project ${query.project}; use discover for registered names`,
    );
  evaluated.push({ project: query.project, domain: query.domain });
  const folder = contained(root, project.projectFolder, reads);
  const { local, localIdentity, start } = discoverSource(root, folder, domain.projectFile, reads);
  if (!start) {
    if (!query.optional || domain.required)
      return fail('REQUIRED_DOMAIN_MISSING', `Configuration for ${query.domain} is absent`, local);
    return {
      project: query.project,
      domain: query.domain,
      contractVersion: '',
      absent: true,
      values: null,
      sources: [],
      provenance: {},
      suppressed: {},
    };
  }
  const first = envelope(start.file, reads);
  const contract =
    domain.versions[first.contractVersion] ??
    fail(
      'UNSUPPORTED_VERSION',
      `Unsupported ${query.domain} contract ${first.contractVersion}`,
      start.file,
    );
  try {
    mergeRules(contract);
    const validate = validators(root, registry, contract, reads);
    const active = new Set<string>();
    function load(current: Resource): State {
      if (active.has(current.file))
        return fail('INHERITANCE_CYCLE', 'Configuration inheritance cycle', current.file);
      active.add(current.file);
      if (!sources.includes(current.file)) sources.push(current.file);
      const data = envelope(current.file, reads);
      if (data.domain !== query.domain)
        return fail(
          'DOMAIN_MISMATCH',
          'Document domain does not match the selected domain',
          current.file,
        );
      if (data.contractVersion !== first.contractVersion)
        return fail(
          'INHERITANCE_VERSION',
          'Parent and child must select the same exact contract version',
          current.file,
        );
      const values = data.values ?? {};
      if (validate.fragment) checked(validate.fragment, values, current.file);
      else if (data.extends)
        return fail(
          'FRAGMENT_SCHEMA_REQUIRED',
          'Sparse inheritance requires an explicit fragment schema',
          current.file,
        );
      let state: State = { values: {}, provenance: {}, suppressed: {} };
      const parent = sourceParent(root, registry, current, data.extends, reads);
      if (parent) state = load(parent);
      const origin: Origin = {
        source: current.file,
        contractVersion: first.contractVersion,
        authoredLocally: current.file === localIdentity,
      };
      const suppressions = data.suppress ?? [];
      for (let i = 0; i < suppressions.length; i++) {
        const at = suppressions[i]!;
        pointerParts(at);
        if (suppressions.slice(i + 1).some((other) => overlaps(at, other)))
          return fail('SUPPRESSION_CONFLICT', 'Suppression pointers overlap', current.file, at);
        if (Object.keys(values).some((key) => overlaps(pointer([key]), at)))
          return fail(
            'SUPPRESSION_CONFLICT',
            'Local assignment overlaps suppression',
            current.file,
            at,
          );
        suppress(state, at, origin);
      }
      for (const [key, value] of Object.entries(values))
        assign(state, state.values, key, value, [key], origin, contract);
      active.delete(current.file);
      return state;
    }
    const state = load(start);
    checked(validate.effective, state.values, start.file);
    for (const at of contract.projectOwned ?? []) {
      pointerParts(at);
      const entries = Object.entries(state.provenance).filter(
        ([key]) => key === at || key.startsWith(`${at}/`),
      );
      if (!entries.length || entries.some(([, origin]) => !origin.authoredLocally))
        fail(
          'PROJECT_OWNED_REQUIRED',
          'Field and its effective descendants must be authored in the consuming project',
          start.file,
          at,
        );
    }
    const result: ResolvedConfiguration = {
      project: query.project,
      domain: query.domain,
      contractVersion: first.contractVersion,
      absent: false,
      sources,
      ...state,
      ...(contract.paths
        ? {
            paths: interpretPaths(
              root,
              folder,
              state.values,
              state.provenance,
              contract.paths,
              reads,
            ),
          }
        : {}),
    };
    return await runSemanticValidators(root, folder, registry, contract, result, reads);
  } catch (error) {
    throw skippedValidators(query, contract, error, first.contractVersion, start.file);
  }
}
