import { ReadContext, liveReads } from './read-context.js';
import { Schema } from 'effect';
import path from 'node:path';
import { getNodeValue, parseTree, printParseErrorCode, type Node } from 'jsonc-parser';
import { ConfigurationError, type Diagnostic } from './types.js';

export function fail(code: string, message: string, file?: string, at?: string): never {
  throw new ConfigurationError([
    { code, message, ...(file ? { file } : {}), ...(at ? { pointer: at } : {}) },
  ]);
}

export function readJson(file: string, reads: ReadContext = liveReads): unknown {
  let text: string;
  try {
    text = reads.readText(file);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'IO_ERROR';
    if (code === 'ENOENT') return fail('FILE_MISSING', 'Cannot read configuration resource', file);
    throw error;
  }
  return parseJson(text, file);
}

export function parseJson(text: string, file: string): unknown {
  const errors: import('jsonc-parser').ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const diagnostics: Diagnostic[] = errors.map((e) => ({
    code: 'INVALID_JSONC',
    message: printParseErrorCode(e.error),
    file,
    offset: e.offset,
  }));
  if (!tree || diagnostics.length)
    throw new ConfigurationError(
      diagnostics.length
        ? diagnostics
        : [{ code: 'INVALID_JSONC', message: 'Expected JSON data', file }],
    );
  function visit(node: Node): void {
    if (node.type === 'object') {
      const keys = new Map<string, number>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0];
        if (!key) continue;
        const name: string = key.value;
        const previous = keys.get(name);
        if (previous !== undefined)
          diagnostics.push({
            code: 'DUPLICATE_KEY',
            message: `Duplicate property ${name}`,
            file,
            offset: key.offset,
            relatedOffset: previous,
          });
        keys.set(name, key.offset);
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  if (diagnostics.length) throw new ConfigurationError(diagnostics);
  return getNodeValue(tree);
}

/** Both lexical and realpath checks prevent symlink escapes. Missing resources fail closed. */
export function contained(base: string, file: string, reads: ReadContext = liveReads): string {
  const resolved = path.resolve(base, file);
  const relative = path.relative(base, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    return fail('PATH_ESCAPE', 'Resource leaves its permitted root', resolved);
  let real: string;
  try {
    real = reads.realpath(resolved);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return fail('FILE_MISSING', 'Resource does not exist', resolved);
    throw error;
  }
  const realBase = reads.realpath(base);
  const realRelative = path.relative(realBase, real);
  if (
    realRelative === '..' ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  )
    return fail('PATH_ESCAPE', 'Resource symlink leaves its permitted root', resolved);
  return real;
}

export function diagnostic(error: unknown): ConfigurationError {
  if (error instanceof ConfigurationError) return error;
  return new ConfigurationError([
    {
      code: Schema.isSchemaError(error) ? 'INVALID_INPUT' : 'INTERNAL',
      kind: Schema.isSchemaError(error) ? 'validation' : 'execution',
      message: Schema.isSchemaError(error)
        ? error.message
        : 'Unexpected runtime or filesystem failure',
      nextAction: Schema.isSchemaError(error)
        ? 'Correct the request to match the public API schema'
        : 'Check the runtime and filesystem before retrying',
    },
  ]);
}

export function pointer(parts: readonly string[]): string {
  return parts.map((p) => '/' + p.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
}
export function pointerParts(value: string): string[] {
  if (!value.startsWith('/') || /~(?![01])/u.test(value))
    return fail('INVALID_POINTER', 'Expected a non-root RFC 6901 JSON Pointer', undefined, value);
  return value
    .slice(1)
    .split('/')
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
}
