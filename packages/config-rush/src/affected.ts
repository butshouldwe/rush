import path from 'node:path';
import { ReadContext, type ObservedInput } from './read-context.js';
import { ConfigurationError } from './types.js';
import { resolve } from './resolve.js';
import { contained, diagnostic } from './json.js';
import { observationFailure, registerDeclaredScope } from './declared.js';
import type { Diagnostic, Query, Registry, Project } from './types.js';

interface ConsumerDiscovery {
  affected: Query[];
  unrelated: { evaluated: { project: string; domain: string }[]; diagnostics: Diagnostic[] };
  inputs: ObservedInput[];
  guards: ObservedInput[];
}
/** Discover participation without requiring unrelated existing failures to be repaired. */
export async function affectedConsumers(
  root: string,
  registry: Registry,
  projects: readonly Project[],
  targets: readonly { project: string; domain: string; file: string; changed: boolean }[],
): Promise<ConsumerDiscovery> {
  const affected: Query[] = [];
  const unrelated: { evaluated: { project: string; domain: string }[]; diagnostics: Diagnostic[] } =
    { evaluated: [], diagnostics: [] };
  const guard = new ReadContext(true);
  const discovery: ObservedInput[] = [];
  const affectedInputs: ObservedInput[] = [];
  const changed = targets.filter((target) => target.changed).map((target) => target.file);
  for (const project of projects)
    for (const domain of registry.domains) {
      if (
        targets.some(
          (target) => target.project === project.packageName && target.domain === domain.name,
        )
      )
        continue;
      const query = { project: project.packageName, domain: domain.name, optional: true };
      const folder = contained(root, project.projectFolder);
      guard.observeResource(path.resolve(folder, domain.projectFile));
      // Ordinary baseline execution keeps its streaming/unbounded package fingerprint behavior.
      const reads = new ReadContext(false, true, true);
      // Declared scope comes from the contract and raw documents, never from how far
      // composition or validation happened to get before failing.
      const { established } = registerDeclaredScope(root, folder, registry, domain, reads);
      let diagnostics: readonly Diagnostic[] = [];
      try {
        // eslint-disable-next-line no-await-in-loop -- Discover one consumer's declared scope at a time.
        diagnostics = (await resolve(root, query, [], [], reads)).diagnostics ?? [];
      } catch (error) {
        if (observationFailure(error)) throw error;
        diagnostics = diagnostic(error).diagnostics;
      }
      const inputs = reads.discoveryInputs();
      discovery.push(...inputs);
      if (reads.dependencyAffected(changed)) {
        affected.push(query);
        affectedInputs.push(...inputs);
      } else if (!established) {
        // The consumer's declared scope could not be read; unrelated is unproven, not granted.
        throw new ConfigurationError([
          ...diagnostics.map((item) => ({ ...item, project: query.project, domain: query.domain })),
          {
            code: 'CONSUMER_SCOPE_UNPROVEN',
            message:
              "A registered consumer's declared dependencies cannot be established from its configuration; repair it before authoring",
            project: query.project,
            domain: query.domain,
            nextAction: 'Run validate for the named project and correct its configuration envelope',
          },
        ]);
      } else {
        unrelated.evaluated.push({ project: query.project, domain: query.domain });
        for (const item of diagnostics)
          unrelated.diagnostics.push({ ...item, project: query.project, domain: query.domain });
      }
    }
  const inputs = [...guard.snapshot().inputs, ...discovery];
  ReadContext.assertInputs(inputs);
  return { affected, unrelated, inputs: affectedInputs, guards: inputs };
}
