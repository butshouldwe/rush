import path from 'node:path';
import { createHash } from 'node:crypto';
import { Schema } from 'effect';
import { ReadContext, type ObservedInput } from './read-context.js';
import { contained, fail } from './json.js';
import { readRegistry, readProjects, domainNamed } from './registry.js';
import { resolve } from './resolve.js';
import type { ResolvedConfiguration, Query } from './types.js';

const requestSchema = Schema.Struct({
  documents: Schema.Array(
    Schema.Struct({
      project: Schema.NonEmptyString,
      domain: Schema.NonEmptyString,
      contents: Schema.String,
    }),
  ),
});
export interface CandidateRequest {
  documents: readonly { project: string; domain: string; contents: string }[];
}
export interface CandidatePreview {
  results: ResolvedConfiguration[];
  inputs: ObservedInput[];
  inputFingerprint: string;
  candidateFingerprint: string;
  scope: { evaluated: { project: string; domain: string }[]; repositoryWide: false };
}

/** A read-only candidate primitive, not an apply plan or a filesystem authorization token. */
export async function previewCandidates(
  root: string,
  request: CandidateRequest,
): Promise<CandidatePreview> {
  const decoded = Schema.decodeUnknownSync(requestSchema)(request, { onExcessProperty: 'error' });
  if (!decoded.documents.length || decoded.documents.length > 128)
    return fail('CANDIDATE_LIMIT', 'Preview requires between 1 and 128 named documents');
  return evaluateCandidateTargets(
    root,
    decoded,
    decoded.documents.map(({ project, domain }) => ({ project, domain })),
  );
}

/** Authoring also evaluates requested absent/no-op targets in the complete candidate context. */
export async function evaluateCandidateTargets(
  root: string,
  request: CandidateRequest,
  queries: readonly Query[],
): Promise<CandidatePreview> {
  const decoded = Schema.decodeUnknownSync(requestSchema)(request, { onExcessProperty: 'error' });
  if (decoded.documents.length > 128 || !queries.length || queries.length > 128)
    return fail('CANDIDATE_LIMIT', 'Preview requires between 1 and 128 named targets');
  const reads = new ReadContext(true);
  const repository = reads.realpath(root);
  const registry = readRegistry(repository, reads);
  const projects = readProjects(repository, reads);
  for (const rel of [
    'common/config/rush/pnpm-lock.yaml',
    'common/autoinstallers/rush-plugins/package.json',
    'common/autoinstallers/rush-plugins/pnpm-lock.yaml',
  ])
    reads.observeResource(path.join(repository, rel));
  const ordered = [...decoded.documents].toSorted(
    (a, b) => a.project.localeCompare(b.project) || a.domain.localeCompare(b.domain),
  );
  for (const document of ordered) {
    if (Buffer.byteLength(document.contents) > 1024 * 1024)
      return fail('CANDIDATE_LIMIT', 'A candidate document exceeds one MiB');
    const project = projects.find((entry) => entry.packageName === document.project);
    if (!project) return fail('UNKNOWN_PROJECT', `Unknown exact project ${document.project}`);
    const domain = domainNamed(registry, document.domain);
    const folder = contained(repository, project.projectFolder, reads);
    reads.addCandidate(folder, path.resolve(folder, domain.projectFile), document.contents);
  }
  const results: ResolvedConfiguration[] = [];
  const evaluated: { project: string; domain: string }[] = [];
  for (const query of [...queries].toSorted(
    (a, b) => a.project.localeCompare(b.project) || a.domain.localeCompare(b.domain),
  )) {
    // eslint-disable-next-line no-await-in-loop -- Trusted code and shared filesystem observations are evaluated serially.
    const result = await resolve(repository, query, [], evaluated, reads);
    results.push(result);
  }
  return {
    results,
    ...reads.snapshot(),
    candidateFingerprint: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'),
    scope: { evaluated, repositoryWide: false },
  };
}
