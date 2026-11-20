import path from 'node:path';
import { ReadContext, liveReads } from './read-context.js';
import { discoverSource, sourceParent } from './sources.js';
import { Predicate } from 'effect';
import { declaredLexicalPath, inspectDeclaredPath } from './paths.js';
import { diagnostic, pointerParts } from './json.js';
import { envelope, registryFile, type Resource } from './registry.js';
import type { Domain, Registry } from './types.js';

/** Observation failures that must never be downgraded to an unrelated classification. */
export const observationFailure = (error: unknown): boolean =>
  diagnostic(error).diagnostics.some((item) =>
    ['OBSERVATION_LIMIT', 'INPUT_CHANGED'].includes(item.code),
  );

/**
 * A failure that proves a referenced resource is absent or outside its permitted root, returning
 * the resolved path it named. Such a resource cannot be anyone's current source or declaration.
 */
export function determinablyAbsent(error: unknown): string | undefined {
  const items = diagnostic(error).diagnostics;
  if (!items.length || !items.every((item) => ['FILE_MISSING', 'PATH_ESCAPE'].includes(item.code)))
    return undefined;
  return items[0]!.file ?? '';
}

/**
 * Register a consumer's declared dependencies from its contract and raw documents, before and
 * independent of composition. Resolution can stop at any structural, version, schema, merge or
 * ownership failure; declared participation must not depend on which of those succeeds.
 * Returns whether the declared scope was fully established. An unestablished scope is unproven,
 * not unrelated.
 */
export function registerDeclaredScope(
  root: string,
  folder: string,
  registry: Registry,
  domain: Domain,
  reads: ReadContext = liveReads,
): { established: boolean } {
  let start: Resource | undefined;
  try {
    start = discoverSource(root, folder, domain.projectFile, reads).start;
  } catch (error) {
    if (observationFailure(error)) throw error;
    return { established: false };
  }
  if (!start) return { established: true };
  let established = true;
  let contractVersion: string | undefined;
  const chain: { resource: Resource; values: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  let current: Resource | undefined = start;
  while (current && !seen.has(current.file) && chain.length < 128) {
    seen.add(current.file);
    try {
      const data = envelope(current.file, reads);
      contractVersion ??= data.contractVersion;
      chain.push({ resource: current, values: data.values ?? {} });
      current = sourceParent(root, registry, current, data.extends, reads);
    } catch (error) {
      if (observationFailure(error)) throw error;
      // A missing or root-escaping parent contributes nothing and hides nothing; the chain is
      // complete. Any other failure hides what that document may declare.
      if (determinablyAbsent(error) === undefined) established = false;
      current = undefined;
      break;
    }
  }
  if (current) established = false;
  const contract = contractVersion === undefined ? undefined : domain.versions[contractVersion];
  if (!contract) return { established: false };
  for (const validator of contract.validators ?? [])
    for (const [name, input] of Object.entries(registry.validators?.[validator]?.inputs ?? {})) {
      try {
        inspectDeclaredPath(
          root,
          folder,
          path.join(root, registryFile),
          input.path,
          input,
          name,
          reads,
        );
      } catch (error) {
        if (observationFailure(error)) throw error;
        // A policy/validity failure is re-evaluated if this declared consumer participates.
      }
    }
  for (const [at, rule] of Object.entries(contract.paths ?? {}))
    for (const { resource, values } of chain) {
      let value: unknown = values;
      for (const part of pointerParts(at)) {
        if ((!Predicate.isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) {
          value = undefined;
          break;
        }
        value = Reflect.get(value, part);
      }
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry !== 'string' || !entry || entry.includes('\0')) continue;
        try {
          reads.dependOn(declaredLexicalPath(root, folder, resource.file, entry, rule.base, reads));
        } catch (error) {
          if (observationFailure(error)) throw error;
          /* The validation pass reports the real failure if this consumer participates. */
        }
      }
    }
  return { established };
}
