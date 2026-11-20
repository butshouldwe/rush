import { ReadContext, liveReads, type FileInfo } from './read-context.js';
import path from 'node:path';
import { Predicate } from 'effect';
import { fail, pointerParts } from './json.js';
import type { Origin, PathBase, PathRule, ResolvedPath } from './types.js';

const baseSchema = { enum: ['project', 'repository', 'source'] };
export const pathRuleSchema = {
  type: 'object',
  required: ['base', 'allowedRoots', 'mustExist', 'symlinks'],
  additionalProperties: false,
  properties: {
    base: baseSchema,
    allowedRoots: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['base', 'path'],
        additionalProperties: false,
        properties: { base: baseSchema, path: { type: 'string', minLength: 1 } },
      },
    },
    mustExist: { type: 'boolean' },
    symlinks: { enum: ['reject', 'within-roots'] },
  },
};

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function isMissing(error: unknown): boolean {
  return Predicate.isObject(error) && error.code === 'ENOENT';
}
/** Resolve existing ancestors too: an absent output must not hide an escaping symlink. */
function canonicalFuture(candidate: string, reads: ReadContext): string {
  try {
    return reads.realpath(candidate);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      if (reads.lstat(candidate).isSymbolicLink())
        return fail('PATH_BROKEN_SYMLINK', 'Broken path symlink', candidate);
    } catch (statError) {
      if (!isMissing(statError)) throw statError;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(canonicalFuture(parent, reads), path.basename(candidate));
  }
}
function rejectSymlinks(candidate: string, source: string, at: string, reads: ReadContext): void {
  let cursor = path.parse(candidate).root;
  for (const part of candidate.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (reads.lstat(cursor).isSymbolicLink())
        fail('PATH_SYMLINK', 'Declared path forbids symlinks', source, at);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
export function declaredLexicalPath(
  root: string,
  project: string,
  source: string,
  authored: string,
  base: PathBase,
  reads: ReadContext,
): string {
  const bases: Record<PathBase, string> = {
    repository: reads.realpath(root),
    project,
    source: path.dirname(source),
  };
  return path.resolve(bases[base], authored);
}
export function inspectDeclaredPath(
  root: string,
  project: string,
  source: string,
  authored: string,
  rule: PathRule,
  at: string,
  reads: ReadContext = liveReads,
): ResolvedPath {
  if (!authored || authored.includes('\0') || /^[a-z][a-z0-9+.-]*:/iu.test(authored))
    return fail('PATH_VALUE', 'Expected a nonempty local filesystem path', source, at);
  const bases: Record<PathBase, string> = {
    repository: reads.realpath(root),
    project,
    source: path.dirname(source),
  };
  const lexical = path.resolve(bases[rule.base], authored);
  reads.dependOn(lexical);
  if (rule.symlinks === 'reject') rejectSymlinks(lexical, source, at, reads);
  const resolved = canonicalFuture(lexical, reads);
  const allowed = rule.allowedRoots.some((declaration) => {
    if (path.isAbsolute(declaration.path))
      fail(
        'PATH_RULE_INVALID',
        'Allowed-root paths must be relative to their declared base',
        source,
        at,
      );
    const boundary = path.resolve(bases[declaration.base], declaration.path);
    return inside(boundary, lexical) && inside(canonicalFuture(boundary, reads), resolved);
  });
  if (!allowed)
    return fail(
      'PATH_ESCAPE',
      `Authored path ${JSON.stringify(authored)} resolves outside its declared roots: ${resolved}`,
      source,
      at,
    );
  let stat: FileInfo | undefined;
  try {
    stat = reads.stat(resolved);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!stat && rule.mustExist)
    return fail(
      'PATH_NOT_FOUND',
      `Required input ${JSON.stringify(authored)} resolves to missing path ${resolved}`,
      source,
      at,
    );
  return {
    authored,
    resolved,
    base: rule.base,
    source,
    exists: !!stat,
    kind: stat ? (stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other') : 'missing',
  };
}
export function interpretPaths(
  root: string,
  project: string,
  values: Record<string, unknown>,
  provenance: Record<string, Origin>,
  rules: Record<string, PathRule>,
  reads: ReadContext = liveReads,
): Record<string, ResolvedPath> {
  const located: { location: string; rule: PathRule; entry: unknown }[] = [];
  for (const [at, rule] of Object.entries(rules).toSorted(([a], [b]) => a.localeCompare(b))) {
    let value: unknown = values;
    for (const part of pointerParts(at)) {
      if ((!Predicate.isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) {
        value = undefined;
        break;
      }
      value = Reflect.get(value, part);
    }
    if (value === undefined) continue;
    if (Array.isArray(value))
      value.forEach((entry, i) => located.push({ location: `${at}/${i}`, rule, entry }));
    else located.push({ location: at, rule, entry: value });
  }
  // Register every declared dependency before any single rule's own validity can
  // short-circuit the loop below and hide what a later rule depends on.
  for (const { location, rule, entry } of located) {
    const origin = provenance[location];
    if (typeof entry !== 'string' || !origin || !entry || entry.includes('\0')) continue;
    try {
      reads.dependOn(declaredLexicalPath(root, project, origin.source, entry, rule.base, reads));
    } catch {
      /* Best-effort registration; the validation pass below reports the real failure. */
    }
  }
  const result: Record<string, ResolvedPath> = {};
  for (const { location, rule, entry } of located) {
    const origin = provenance[location];
    if (typeof entry !== 'string' || !origin)
      return fail(
        'PATH_VALUE',
        'Declared path must be a string with provenance',
        origin?.source,
        location,
      );
    result[location] = inspectDeclaredPath(
      root,
      project,
      origin.source,
      entry,
      rule,
      location,
      reads,
    );
  }
  return result;
}
