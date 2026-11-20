import path from 'node:path';
import { createHash } from 'node:crypto';
import { Schema, Predicate } from 'effect';
import {
  modify,
  parseTree,
  type Node as JsonNode,
  applyEdits as applyTextEdits,
} from 'jsonc-parser';
import { ReadContext, type ObservedInput } from './read-context.js';
import { contained, fail, parseJson, pointerParts, diagnostic } from './json.js';
import { RigConfig } from '@rushstack/rig-package';
import { removeValue } from './jsonc-edits.js';
import { discoverSource, sourceParent } from './sources.js';
import {
  readRegistry,
  readProjects,
  domainNamed,
  envelope,
  resource,
  packageReferenceName,
} from './registry.js';
import { evaluateCandidateTargets } from './candidates.js';
import { affectedConsumers } from './affected.js';
import { determinablyAbsent, observationFailure } from './declared.js';
import { ConfigurationError, type ResolvedConfiguration, type Diagnostic } from './types.js';

const identity = { project: Schema.NonEmptyString, domain: Schema.NonEmptyString };
const editSchema = Schema.Union([
  Schema.Struct({ ...identity, operation: Schema.Literal('create'), document: Schema.Json }),
  Schema.Struct({
    ...identity,
    operation: Schema.Literal('set'),
    pointer: Schema.String,
    value: Schema.Json,
  }),
  Schema.Struct({
    ...identity,
    operation: Schema.Literals(['unset', 'suppress', 'remove-suppression']),
    pointer: Schema.String,
  }),
  Schema.Struct({
    ...identity,
    operation: Schema.Literal('set-version'),
    contractVersion: Schema.NonEmptyString,
  }),
]);
export const editRequestSchema = Schema.Struct({
  requestVersion: Schema.Literal(1),
  edits: Schema.Array(editSchema),
});
export type EditRequest = typeof editRequestSchema.Type;
type Edit = typeof editSchema.Type;
export interface EditTarget {
  project: string;
  domain: string;
  file: string;
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  changed: boolean;
  notes: string[];
}
export interface EditPlan {
  planVersion: 1;
  planId: string;
  sourceScopeFingerprint: string;
  root: string;
  request: EditRequest;
  targets: EditTarget[];
  inputs: ObservedInput[];
  inputFingerprint: string;
  effective: ResolvedConfiguration[];
  unrelated: { evaluated: { project: string; domain: string }[]; diagnostics: Diagnostic[] };
  scope: { evaluated: { project: string; domain: string }[]; repositoryWide: false };
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

function fieldPath(
  document: unknown,
  pointer: string,
  tolerateScalarDescent = false,
): (string | number)[] | undefined {
  const result: (string | number)[] = ['values'];
  let cursor: unknown = Predicate.isObject(document) ? document.values : undefined;
  for (const part of pointerParts(pointer)) {
    let key: string | number = part;
    if (cursor !== undefined && !Predicate.isObject(cursor) && !Array.isArray(cursor)) {
      if (tolerateScalarDescent) return undefined;
      return fail(
        'INVALID_POINTER',
        'A pointer cannot descend into a scalar value; edit the scalar itself',
        undefined,
        pointer,
      );
    }
    if (Array.isArray(cursor)) {
      if (
        !/^(0|[1-9][0-9]*)$/u.test(part) ||
        !Number.isSafeInteger(Number(part)) ||
        Number(part) > cursor.length
      )
        return fail(
          'INVALID_POINTER',
          'Array pointers require an existing index or the next append index',
          undefined,
          pointer,
        );
      key = Number(part);
    }
    result.push(key);
    cursor =
      (Predicate.isObject(cursor) || Array.isArray(cursor)) && Object.hasOwn(cursor, key)
        ? Reflect.get(cursor, key)
        : undefined;
  }
  return result;
}
function valueAt(value: unknown, parts: (string | number)[]): unknown {
  for (const part of parts) {
    if ((!Predicate.isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, part))
      return undefined;
    value = Reflect.get(value, part);
  }
  return value;
}
function editDocument(
  before: string | null,
  edits: Edit[],
  file: string,
): { after: string | null; notes: string[] } {
  if (edits.some((edit) => edit.operation === 'create')) {
    if (edits.length !== 1)
      return fail(
        'EDIT_CONFLICT',
        'Create supplies the complete candidate and cannot be combined with field edits',
        file,
      );
    if (before !== null) return fail('FILE_EXISTS', 'Create refuses an existing document', file);
    const first = edits[0]!;
    if (first.operation !== 'create') return fail('EDIT_CONFLICT', 'Invalid create group', file);
    return { after: JSON.stringify(first.document, null, 2) + '\n', notes: [] };
  }
  const notes: string[] = [];
  const pointers: string[] = [];
  for (const edit of edits) {
    const at =
      edit.operation === 'set-version' ? '@version' : 'pointer' in edit ? edit.pointer : '';
    if (at !== '@version') pointerParts(at);
    if (pointers.some((other) => overlaps(at, other)))
      return fail('EDIT_CONFLICT', 'Duplicate or overlapping edit pointers', file, at);
    pointers.push(at);
  }
  if (before === null) {
    if (
      edits.every((edit) => edit.operation === 'unset' || edit.operation === 'remove-suppression')
    )
      return {
        after: null,
        notes: ['No local document; no local assignment or suppression was removed'],
      };
    return fail(
      'LOCAL_DOCUMENT_REQUIRED',
      'Create an explicit complete local document before editing fields',
      file,
    );
  }
  let text = before;
  const arrayParents = new Set<string>();
  for (const edit of edits) {
    const document = parseJson(text, file);
    let jsonPath: (string | number)[];
    let value: unknown;
    if (edit.operation === 'set-version') {
      jsonPath = ['contractVersion'];
      value = edit.contractVersion;
    } else if (edit.operation === 'set' || edit.operation === 'unset') {
      // An unset below a scalar has nothing to remove: a no-op, like any absent local field.
      const resolved = fieldPath(document, edit.pointer, edit.operation === 'unset');
      if (resolved === undefined) {
        notes.push(`No local assignment at ${edit.pointer}`);
        continue;
      }
      jsonPath = resolved;
      const arrayIndex = jsonPath.findIndex((part) => typeof part === 'number');
      if (arrayIndex >= 0) {
        const arrayParent = JSON.stringify(jsonPath.slice(0, arrayIndex));
        if (arrayParents.has(arrayParent))
          return fail(
            'EDIT_CONFLICT',
            'Multiple edits in one array are order-dependent; set the whole array explicitly',
            file,
          );
        arrayParents.add(arrayParent);
      }
      const old = valueAt(document, jsonPath);
      if (edit.operation === 'unset' && old === undefined) {
        notes.push(`No local assignment at ${edit.pointer}`);
        continue;
      }
      value = edit.operation === 'set' ? edit.value : undefined;
    } else if (edit.operation === 'suppress' || edit.operation === 'remove-suppression') {
      jsonPath = ['suppress'];
      const old = valueAt(document, jsonPath);
      if (
        old !== undefined &&
        (!Array.isArray(old) || old.some((item) => typeof item !== 'string'))
      )
        return fail('INVALID_SUPPRESSION', 'Existing suppression list must contain strings', file);
      const list = (old ?? []) as string[];
      if (edit.operation === 'remove-suppression' && !list.includes(edit.pointer)) {
        notes.push(`No local suppression at ${edit.pointer}`);
        continue;
      }
      value =
        edit.operation === 'suppress'
          ? [...new Set([...list, edit.pointer])].toSorted()
          : list.filter((item) => item !== edit.pointer);
    } else return fail('EDIT_CONFLICT', 'Unexpected operation', file);
    const previous = valueAt(document, jsonPath);
    if (JSON.stringify(previous) === JSON.stringify(value)) continue;
    if (value === undefined) {
      text = removeValue(text, jsonPath, file);
      continue;
    }
    // Only a true scalar replaces in place without formatting; objects and arrays are laid
    // out by the document's inferred indentation (or refused when it cannot be inferred).
    const scalarReplacement =
      previous !== undefined &&
      value !== undefined &&
      !Predicate.isObject(value) &&
      !Array.isArray(value);
    text = applyTextEdits(
      text,
      modify(
        text,
        jsonPath,
        value,
        scalarReplacement
          ? {}
          : {
              formattingOptions: formatting(text, file),
            },
      ),
    );
  }
  return { after: text, notes };
}

function formatting(text: string, file: string) {
  const root = parseTree(text)!;
  const rootPrefix = text.slice(text.lastIndexOf('\n', root.offset - 1) + 1, root.offset);
  const base = /^[ \t]*$/u.test(rootPrefix) ? rootPrefix : '';
  const units = new Set<string>();
  function inspect(node: JsonNode, depth: number): void {
    const prefix = text.slice(text.lastIndexOf('\n', node.offset - 1) + 1, node.offset);
    if (!/^[ \t]*$/u.test(prefix)) return;
    const indent = prefix.slice(base.length);
    if (
      !prefix.startsWith(base) ||
      !indent.length ||
      indent.length % depth ||
      !/^(?: +|\t+)$/u.test(indent)
    )
      fail('INDENTATION_UNSUPPORTED', 'Cannot preserve this indentation unambiguously', file);
    units.add(indent.slice(0, indent.length / depth));
  }
  function visit(node: JsonNode, depth: number): void {
    if (node.type === 'object') {
      for (const property of node.children ?? []) {
        inspect(property, depth + 1);
        visit(property.children![1]!, depth + 1);
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) {
        inspect(child, depth + 1);
        visit(child, depth + 1);
      }
    }
  }
  visit(root, 0);
  if (units.size > 1)
    fail('INDENTATION_UNSUPPORTED', 'Mixed indentation cannot be preserved safely', file);
  const unit = [...units][0] ?? '  ';
  if (unit.includes('\t') && unit !== '\t')
    fail('INDENTATION_UNSUPPORTED', 'Unsupported tab indentation width', file);
  return {
    insertSpaces: unit !== '\t',
    tabSize: unit === '\t' ? 1 : unit.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

const inside = (boundary: string, file: string): boolean => {
  const relative = path.relative(boundary, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
};

/** Shared-source safety cannot be granted from a peer whose sources cannot be read. */
function unproven(project: string, domain: string, error: unknown): never {
  throw new ConfigurationError([
    ...diagnostic(error).diagnostics.map((item) => ({ ...item, project, domain })),
    {
      code: 'SHARED_SOURCE_UNPROVEN',
      message:
        "A registered consumer's configuration sources cannot be read, so shared-source safety cannot be established; repair it before authoring",
      project,
      domain,
      nextAction: 'Run validate for the named project and correct its configuration sources',
    },
  ]);
}
/** Protect currently discoverable shared/rig inputs; v1 project edits cannot mutate them. */
export function authoringScope(
  root: string,
  targets: readonly Pick<EditTarget, 'project' | 'domain' | 'file' | 'after'>[],
): string {
  const registry = readRegistry(root),
    projects = readProjects(root);
  const edges: string[] = [];
  const reads = new ReadContext();
  for (const admission of Object.values(registry.validators ?? {})) {
    const name = packageReferenceName(admission.module);
    if (!name) continue;
    if (targets.some((target) => target.project === name))
      fail('VALIDATOR_SOURCE_EDIT', 'Project authoring cannot edit an admitted validator package');
    let boundary: string;
    try {
      // Presence is checked first so an unreadable install path is classified, not INTERNAL.
      const install = path.join(root, 'common/autoinstallers/rush-plugins/node_modules', name);
      const installed = reads.exists(install);
      if (!installed) {
        // An admission with no installed package has no boundary to protect and does not force
        // installation.
        edges.push(JSON.stringify(['validator-package-absent', name]));
        continue;
      }
      boundary = resource(
        root,
        registry,
        `package:${name}/package.json`,
        root,
        root,
        reads,
      ).boundary;
    } catch (error) {
      if (observationFailure(error)) throw error;
      // Something is present at the install path but cannot be resolved (unreadable, dangling
      // or broken link into a project): its boundary is unknown, so authoring fails closed.
      unproven(name, 'validator-package', error);
    }
    edges.push(JSON.stringify(['validator-package', name, boundary]));
    if (targets.some((target) => inside(boundary, target.file)))
      fail(
        'VALIDATOR_SOURCE_EDIT',
        'Candidate overlaps an admitted validator-package boundary',
        boundary,
      );
  }
  for (const target of targets) {
    if (target.after === null) continue;
    const project = projects.find((item) => item.packageName === target.project);
    if (!project) fail('UNKNOWN_PROJECT', `Unknown exact project ${target.project}`);
    reads.addCandidate(contained(root, project.projectFolder), target.file, target.after);
  }

  for (const project of projects) {
    const folder = contained(root, project.projectFolder);
    let profile: string | undefined;
    try {
      const rig = RigConfig.loadForProjectFolder({ projectFolderPath: folder, bypassCache: true });
      if (rig.rigFound) profile = rig.getResolvedProfileFolder();
    } catch (error) {
      // A declared rig that cannot be resolved leaves its package boundary unknown; the
      // ordinary read path never reports it when every domain resolves from a local file.
      if (observationFailure(error)) throw error;
      unproven(project.packageName, 'rig', error);
    }
    if (profile) {
      const boundary = contained(path.resolve(profile, '../..'), '.');
      edges.push(JSON.stringify(['rig', project.packageName, boundary]));
      if (targets.some((target) => inside(boundary, target.file)))
        fail('SHARED_SOURCE_EDIT', 'Project authoring cannot modify rig package files', boundary);
    }
    for (const domain of registry.domains) {
      let current: { file: string; boundary: string } | undefined;
      try {
        const discovered = discoverSource(root, folder, domain.projectFile, reads);
        current = discovered.start;
        if (current && current.file !== discovered.local)
          edges.push(JSON.stringify(['source', discovered.local, current.file]));
      } catch (error) {
        if (observationFailure(error)) throw error;
        unproven(project.packageName, domain.name, error);
      }
      const seen = new Set<string>();
      for (let depth = 0; current && !seen.has(current.file); depth++) {
        if (depth >= 128)
          fail(
            'SOURCE_SCOPE_LIMIT',
            'Cannot establish shared-source safety beyond 128 sources',
            current.file,
          );
        seen.add(current.file);
        const file = current.file;
        if (
          targets.some(
            (target) =>
              target.file === file &&
              (target.project !== project.packageName || target.domain !== domain.name),
          )
        )
          fail(
            'SHARED_SOURCE_EDIT',
            'A requested document is a source for another registered consumer; use a separately reviewed shared-source change',
            file,
          );
        let data;
        try {
          data = envelope(file, reads);
        } catch (error) {
          if (observationFailure(error)) throw error;
          unproven(project.packageName, domain.name, error);
        }
        if (!data.extends) break;
        try {
          const parent = sourceParent(root, registry, current, data.extends, reads)!;
          edges.push(JSON.stringify(['parent', file, parent.file]));
          current = parent;
        } catch (error) {
          if (observationFailure(error)) throw error;
          const absent = determinablyAbsent(error);
          if (absent === undefined) unproven(project.packageName, domain.name, error);
          // A parent that does not exist or leaves its root is no consumer's source today; only a
          // request that would create it makes this document a shared-source consumer.
          if (targets.some((target) => target.after !== null && target.file === absent))
            fail(
              'SHARED_SOURCE_EDIT',
              'A requested document would become a source for another registered consumer; use a separately reviewed shared-source change',
              absent,
            );
          edges.push(JSON.stringify(['absent-parent', file, absent]));
          break;
        }
      }
    }
  }
  return hash(JSON.stringify(edges.toSorted()));
}

export async function previewEdits(root: string, request: EditRequest): Promise<EditPlan> {
  const decoded = Schema.decodeUnknownSync(editRequestSchema)(request, {
    onExcessProperty: 'error',
  });
  if (!decoded.edits.length || decoded.edits.length > 256)
    return fail('EDIT_LIMIT', 'Supply between 1 and 256 edits');
  const reads = new ReadContext(true);
  const repository = reads.realpath(root);
  const registry = readRegistry(repository, reads),
    projects = readProjects(repository, reads);
  const groups = new Map<string, Edit[]>();
  for (const edit of decoded.edits) {
    const key = JSON.stringify([edit.project, edit.domain]);
    groups.set(key, [...(groups.get(key) ?? []), edit]);
  }
  const targets: EditTarget[] = [];
  for (const [, edits] of [...groups].toSorted(([a], [b]) => a.localeCompare(b))) {
    const first = edits[0]!;
    const project = projects.find((item) => item.packageName === first.project);
    if (!project) return fail('UNKNOWN_PROJECT', `Unknown exact project ${first.project}`);
    const domain = domainNamed(registry, first.domain);
    const folder = contained(repository, project.projectFolder, reads);
    const file = path.resolve(folder, domain.projectFile);
    new ReadContext().addCandidate(folder, file, '');
    const before = reads.exists(file) ? reads.readText(file) : null;
    const { after, notes } = editDocument(before, edits, file);
    // Reuse destination admission even for no-op requests; a preview is not an arbitrary path reader.
    reads.addCandidate(folder, file, after ?? '');
    targets.push({
      project: first.project,
      domain: first.domain,
      file,
      before,
      after,
      beforeHash: before === null ? null : hash(before),
      afterHash: after === null ? null : hash(after),
      changed: before !== after,
      notes,
    });
  }
  const sourceScopeFingerprint = authoringScope(repository, targets);
  const documents = targets
    .filter((target) => target.after !== null)
    .map((target) => ({ project: target.project, domain: target.domain, contents: target.after! }));
  const peers = await affectedConsumers(repository, registry, projects, targets);
  const candidate = await evaluateCandidateTargets(repository, { documents }, [
    ...targets.map((target) => ({
      project: target.project,
      domain: target.domain,
      optional: target.after === null,
    })),
    ...peers.affected,
  ]);
  const effective = candidate.results;
  const inputs = new Map<string, ObservedInput>();
  for (const input of [...reads.snapshot().inputs, ...candidate.inputs, ...peers.inputs])
    inputs.set(input.path, input);
  const sorted = [...inputs.values()].toSorted((a, b) => a.path.localeCompare(b.path));
  ReadContext.assertInputs(sorted);
  const inputFingerprint = hash(JSON.stringify(sorted));
  const unrelated = peers.unrelated;
  ReadContext.assertInputs(sorted);
  const planId = hash(
    JSON.stringify({
      root: repository,
      request: decoded,
      inputFingerprint,
      sourceScopeFingerprint,
      targets,
    }),
  );
  return {
    planVersion: 1,
    planId,
    sourceScopeFingerprint,
    root: repository,
    request: decoded,
    targets,
    inputs: sorted,
    inputFingerprint,
    effective,
    unrelated,
    scope: {
      evaluated: candidate.scope.evaluated,
      repositoryWide: false,
    },
  };
}
