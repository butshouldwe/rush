import { Predicate } from 'effect';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import { fail, pointer } from './json.js';

type Node = { schema: unknown; base: string };
const maps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const arrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const singles = [
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'contains',
  'not',
  'if',
  'then',
  'else',
];

export function recordSchemaBases(
  schema: unknown,
  base: string,
  known: WeakMap<object, string>,
): void {
  if (!Predicate.isObject(schema)) return;
  const here = typeof schema.$id === 'string' ? new URL(schema.$id, base).href : base;
  known.set(schema, here);
  for (const key of maps) {
    const children = schema[key];
    if (Predicate.isObject(children))
      for (const child of Object.values(children)) recordSchemaBases(child, here, known);
  }
  for (const key of arrays)
    if (Array.isArray(schema[key]))
      for (const child of schema[key]) recordSchemaBases(child, here, known);
  for (const key of singles) recordSchemaBases(schema[key], here, known);
}

function permits(value: unknown, kind: 'object' | 'array'): boolean {
  if (value === false) return false;
  if (!Predicate.isObject(value)) return true;
  if (typeof value.type === 'string') return value.type === kind;
  if (Array.isArray(value.type)) return value.type.includes(kind);
  return true;
}

/** Conservative structural admission, not a sample-value probe or a general schema theorem prover. */
export function assertSchemaPosture(
  schema: unknown,
  base: string,
  ajv: Ajv2020,
  known: WeakMap<object, string>,
  file: string,
): void {
  const ids = new WeakMap<object, number>();
  let next = 0,
    states = 0;
  const visited = new Set<string>();
  const node = (value: unknown, parent: string): Node => ({
    schema: value,
    base: Predicate.isObject(value) ? (known.get(value) ?? parent) : parent,
  });
  const id = (value: unknown): string => {
    if (!Predicate.isObject(value)) return String(value);
    if (!ids.has(value)) ids.set(value, ++next);
    return String(ids.get(value));
  };
  function flatten(input: Node[], output: Node[] = [], seen = new Set<unknown>()): Node[] {
    for (const entry of input) {
      const value = entry.schema;
      if (seen.has(value)) continue;
      seen.add(value);
      output.push(entry);
      if (!Predicate.isObject(value)) continue;
      if ('$dynamicRef' in value || '$recursiveRef' in value)
        fail(
          'SCHEMA_POSTURE',
          'Dynamic references are outside the admitted closed-object profile',
          file,
        );
      if (typeof value.$ref === 'string') {
        const ref = new URL(value.$ref, entry.base).href;
        const target = ajv.getSchema(ref)?.schema;
        if (target === undefined)
          fail('SCHEMA_POSTURE', `Cannot inspect admitted reference ${ref}`, file);
        flatten([node(target, ref.split('#')[0]!)], output, seen);
      }
      if (Array.isArray(value.allOf))
        flatten(
          value.allOf.map((child) => node(child, entry.base)),
          output,
          seen,
        );
    }
    return output;
  }
  // An annotation from any successful same-instance branch can consume unknown keys
  // before unevaluatedProperties runs. Inspect all branches, including the if predicate.
  function evaluatesArbitraryKeys(input: Node[], seen = new Set<object>()): boolean {
    for (const entry of flatten(input)) {
      const s = entry.schema;
      if (!Predicate.isObject(s) || seen.has(s)) continue;
      seen.add(s);
      if (
        [s.additionalProperties, s.unevaluatedProperties].some(
          (value) => value === true || Predicate.isObject(value),
        )
      )
        return true;
      const children: unknown[] = [];
      for (const key of ['anyOf', 'oneOf']) if (Array.isArray(s[key])) children.push(...s[key]);
      for (const key of ['if', 'then', 'else']) if (key in s) children.push(s[key]);
      if (Predicate.isObject(s.dependentSchemas))
        children.push(...Object.values(s.dependentSchemas));
      if (
        evaluatesArbitraryKeys(
          children.map((child) => node(child, entry.base)),
          seen,
        )
      )
        return true;
    }
    return false;
  }
  function predicateAnnotations(input: Node[], seen = new Set<object>()): Record<string, true> {
    const names: string[] = [];
    for (const entry of flatten(input)) {
      const s = entry.schema;
      if (!Predicate.isObject(s) || seen.has(s)) continue;
      seen.add(s);
      if (Predicate.isObject(s.properties)) names.push(...Object.keys(s.properties));
      const children: unknown[] = [];
      for (const key of ['anyOf', 'oneOf']) if (Array.isArray(s[key])) children.push(...s[key]);
      for (const key of ['if', 'then', 'else']) if (key in s) children.push(s[key]);
      if (Predicate.isObject(s.dependentSchemas))
        children.push(...Object.values(s.dependentSchemas));
      names.push(
        ...Object.keys(
          predicateAnnotations(
            children.map((child) => node(child, entry.base)),
            seen,
          ),
        ),
      );
    }
    return Object.fromEntries(names.map((name) => [name, true]));
  }
  function visit(input: Node[], parts: string[], processed: Set<object>): void {
    const flat = flatten(input);
    const key =
      `${parts.length === 0}:` +
      flat
        .map((x) => `${id(x.schema)}@${x.base}`)
        .toSorted()
        .join(',') +
      ':' +
      [...processed].map(id).toSorted().join(',');
    if (visited.has(key)) return;
    visited.add(key);
    if (++states > 2048)
      fail(
        'SCHEMA_POSTURE',
        'Schema admission complexity limit exceeded; simplify the closed-object structure',
        file,
      );
    // Expand alternatives before inspecting children; then/else are conservatively both considered.
    for (const entry of flat) {
      const value = entry.schema;
      if (!Predicate.isObject(value) || processed.has(value)) continue;
      const choices: unknown[][] = [];
      for (const op of ['anyOf', 'oneOf']) if (Array.isArray(value[op])) choices.push(value[op]);
      // The pinned validator retains predicate property annotations even on failure.
      // The false branch must inspect those names without assuming predicate constraints.
      if ('if' in value)
        choices.push([
          { allOf: [value.if, value.then ?? true] },
          {
            allOf: [
              { properties: predicateAnnotations([node(value.if, entry.base)]) },
              value.else ?? true,
            ],
          },
        ]);
      if (Predicate.isObject(value.dependentSchemas))
        choices.push([true, ...Object.values(value.dependentSchemas)]);
      if (choices.length) {
        const done = new Set(processed);
        done.add(value);
        function combine(index: number, selected: Node[]): void {
          if (index === choices.length) {
            visit([...flat, ...selected], parts, done);
            return;
          }
          for (const branch of choices[index]!)
            combine(index + 1, [...selected, node(branch, entry.base)]);
        }
        combine(0, []);
        return;
      }
    }
    // Exact finite values cannot acquire an unknown property at any depth.
    if (
      flat.some(
        ({ schema: s }) =>
          s === false || (Predicate.isObject(s) && ('const' in s || Array.isArray(s.enum))),
      )
    )
      return;
    if (flat.every(({ schema: s }) => permits(s, 'object'))) {
      const closed = flat.some(
        ({ schema: s }) =>
          Predicate.isObject(s) &&
          (s.additionalProperties === false ||
            (s.unevaluatedProperties === false && !evaluatesArbitraryKeys(flat))),
      );
      const explicitMap =
        parts.length > 0 &&
        flat.some(
          ({ schema: s }) =>
            Predicate.isObject(s) &&
            s.type === 'object' &&
            (s.additionalProperties === true || Predicate.isObject(s.additionalProperties)),
        );
      if (!closed && !explicitMap)
        fail(
          'SCHEMA_POSTURE',
          `Open object at data pointer ${pointer(parts) || '(root)'}; close it or explicitly declare a nested extension map`,
          file,
          pointer(parts),
        );
      if (!closed && explicitMap) return;
      const properties = new Map<string, Node[]>();
      for (const entry of flat) {
        const s = entry.schema;
        if (!Predicate.isObject(s) || !Predicate.isObject(s.properties)) continue;
        for (const [name, child] of Object.entries(s.properties))
          properties.set(name, [...(properties.get(name) ?? []), node(child, entry.base)]);
      }
      for (const [name, nodes] of properties) visit(nodes, [...parts, name], new Set());
      // Pattern properties declare a dynamic namespace; their value schemas remain enforced by Ajv.
    }
    if (parts.length && flat.every(({ schema: s }) => permits(s, 'array'))) {
      const count = Math.max(
        0,
        ...flat.map(({ schema: s }) =>
          Predicate.isObject(s) && Array.isArray(s.prefixItems) ? s.prefixItems.length : 0,
        ),
      );
      for (let i = 0; i <= count; i++) {
        const items = flat.map((entry) => {
          const s = entry.schema;
          if (!Predicate.isObject(s)) return node(true, entry.base);
          const item =
            Array.isArray(s.prefixItems) && i < s.prefixItems.length
              ? s.prefixItems[i]
              : (s.items ?? true);
          return node(item, entry.base);
        });
        visit(items, [...parts, String(i)], new Set());
      }
    }
  }
  visit([node(schema, base)], [], new Set());
}
