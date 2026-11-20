import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Use the supplied Rush engine's declared YAML parser, not a phantom project dependency.
const engine = createRequire(process.argv[4]).resolve('@microsoft/rush-lib');
const { load } = createRequire(engine)('js-yaml');
const before = load(fs.readFileSync(process.argv[2], 'utf8'));
const after = load(fs.readFileSync(process.argv[3], 'utf8'));
for (const section of ['packages', 'snapshots'])
  for (const [name, value] of Object.entries(before[section] ?? {}))
    assert.deepEqual(after[section]?.[name], value, `${section}: ${name} changed`);
for (const [name, entry] of Object.entries(before.importers ?? {}))
  for (const [kind, values] of Object.entries(entry)) {
    if (['dependencies', 'devDependencies', 'optionalDependencies'].includes(kind)) {
      for (const [dependency, spec] of Object.entries(values))
        assert.deepEqual(
          after.importers[name][kind][dependency],
          spec,
          `Existing dependency changed: ${dependency}`,
        );
    } else
      assert.deepEqual(after.importers[name][kind], values, `Importer setting changed: ${kind}`);
  }
if (before.settings !== undefined) assert.deepEqual(after.settings, before.settings);
const seen = new Set(),
  queue = [];
for (const name of ['@butshouldwe/config-rush', '@config-rush-proof/checks'])
  queue.push(`${name}@${after.importers['.'].dependencies[name].version}`);
while (queue.length) {
  const key = queue.pop();
  if (seen.has(key)) continue;
  seen.add(key);
  for (const kind of ['dependencies', 'optionalDependencies'])
    for (const [name, version] of Object.entries(after.snapshots[key]?.[kind] ?? {}))
      queue.push(`${name}@${version}`);
}
const added = Object.keys(after.snapshots ?? {}).filter(
  (key) => !Object.hasOwn(before.snapshots ?? {}, key),
);
assert(
  added.every((key) => seen.has(key)),
  'Unrelated added dependency snapshots',
);
console.log(
  JSON.stringify({
    existingUnchanged: true,
    addedSnapshots: added.length,
    allAddedReachableFromProofPackages: true,
  }),
);
