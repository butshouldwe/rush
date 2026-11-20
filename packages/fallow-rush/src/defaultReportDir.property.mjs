// Offline, dependency-free probes of both production guards and writers.
// Node >=22.18 can load the production .ts. Unused SBOM generation dependencies
// throw if reached: only writeManifest and its real filesystem helpers run here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { randomBytes } from 'node:crypto';
import { guardDefaultReportDir, writeReports } from './report.ts';
import { guardDefaultOutputDir } from '../../sbom-rush/src/defaultOutputDir.ts';

const unused = {
  './rushRepo.js': ['findRushRepo', 'pnpmLadderRefusal'],
  './scenarios.js': ['discoverScenarios', 'readExtractorMetadata', 'resolveTargetFolder'],
  './generate.js': ['generateSbom'],
  './stamp.js': ['stampBom'],
  './validate.js': ['validateCycloneDx', 'ntiaMinimumElements'],
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/sbom-rush/src/run.ts')) {
      if (specifier === './errors.js' || specifier === './defaultOutputDir.js')
        return next(specifier.replace('.js', '.ts'), context);
      if (Object.hasOwn(unused, specifier))
        return {
          shortCircuit: true,
          url:
            'data:text/javascript,' +
            encodeURIComponent(
              unused[specifier]
                .map(
                  (name) =>
                    `export function ${name}(){throw new Error('unused dependency reached: ${name}')}`,
                )
                .join('\n'),
            ),
        };
    }
    return next(specifier, context);
  },
});
const { writeManifest } = await import('../../sbom-rush/src/run.ts');
hook.deregister();

const seed = Number(process.env.FALLOW_PROP_SEED ?? randomBytes(4).readUInt32LE());
const cases = Number(process.env.FALLOW_PROP_CASES ?? 160);
assert(Number.isSafeInteger(seed) && seed >= 0);
assert(Number.isSafeInteger(cases) && cases >= 40);
console.error(`FALLOW_PROP_SEED=${seed} FALLOW_PROP_CASES=${cases} per package`);
let state = seed >>> 0;
function random(n) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state % n;
}
function tree(dir) {
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      return [
        name,
        stat.isSymbolicLink()
          ? ['link', fs.readlinkSync(file)]
          : stat.isDirectory()
            ? tree(file)
            : fs.readFileSync(file).toString('hex'),
      ];
    });
}
const rollup = {
  generator: '@butshouldwe/fallow-rush',
  fallowVersion: '3.6.0',
  generatedAt: '2026-11-13T08:00:00Z',
  gitSha: 'a'.repeat(40),
  changedSince: null,
  projectsFilter: null,
  monorepo: {
    totalFindings: 0,
    byType: {},
    dupes: {},
    health: {},
    unsupported: [],
    rushPlumbing: [],
    unattributed: [],
  },
  projects: [],
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'output-prop-'));
try {
  for (const [name, suffix, guard] of [
    ['fallow', ['common', 'temp', 'fallow-rush'], guardDefaultReportDir],
    ['sbom', ['common', 'deploy-sbom'], guardDefaultOutputDir],
  ]) {
    const counts = {
      accept: 0,
      refuse: 0,
      absolute: 0,
      relative: 0,
      dotdot: 0,
      repeated: 0,
      trailing: 0,
    };
    for (let i = 0; i < cases; i++) {
      const fixture = path.join(sandbox, `${name}-${i}`);
      fs.mkdirSync(fixture);
      const names = ['plain', 'space name', 'line\nbreak', '\x1b[31m', 'é😀', '__proto__'];
      const root = path.join(fixture, names[random(names.length)]);
      const segments = [root];
      for (const segment of suffix) segments.push(path.join(segments.at(-1), segment));
      const output = segments.at(-1);
      const depth = i % segments.length;
      // Construction supplies the oracle; it does not reuse the lstat walk.
      const refusal = i % 5 !== 0;
      const target = path.join(fixture, 'target');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
      if (refusal) {
        fs.mkdirSync(path.dirname(segments[depth]), { recursive: true });
        const kind = random(4);
        const destination =
          kind === 0
            ? path.join(fixture, 'missing')
            : kind === 1
              ? path.join(target, 'sentinel')
              : kind === 2
                ? segments[depth]
                : target;
        fs.symlinkSync(destination, segments[depth], kind === 1 ? 'file' : 'dir');
      } else {
        fs.mkdirSync(segments[depth], { recursive: true });
      }
      const form = i % 4;
      let raw = output;
      if (form === 0) {
        // This link disappears during lexical normalization. Using raw mkdir
        // instead would create target/<leaf> after following jump then '..'.
        const parent = path.dirname(output);
        if (!refusal) {
          fs.mkdirSync(parent, { recursive: true });
          fs.mkdirSync(path.join(target, 'nested'));
          fs.symlinkSync(path.join(target, 'nested'), path.join(parent, 'jump'));
        }
        raw = `${parent}/jump/../${suffix.at(-1)}`;
        counts.dotdot++;
      }
      if (form === 1) {
        raw = raw.replaceAll('/', '//');
        counts.repeated++;
      }
      if (form === 2) {
        raw += '///';
        counts.trailing++;
      }
      if (i % 2 === 0) {
        // path.relative would erase the generated '..'; strip only the known
        // fixture prefix and prepend a cwd-to-sandbox path instead.
        raw = `${path.relative(process.cwd(), fixture)}/${raw.slice(fixture.length + 1)}`;
        counts.relative++;
      } else {
        counts.absolute++;
      }
      const before = tree(fixture);
      if (refusal) {
        assert.throws(
          () => guard(raw),
          (error) =>
            error.message.includes('symlink component') &&
            (error.message.includes(segments[depth]) ||
              error.message.includes(JSON.stringify(segments[depth]).slice(1, -1))),
        );
        counts.refuse++;
      } else {
        assert.equal(guard(raw), output, 'guard must return the constructed lexical path');
        counts.accept++;
      }
      assert.deepEqual(tree(fixture), before, 'guard must never mutate the fixture');
      const write = () =>
        name === 'fallow' ? writeReports(rollup, raw) : writeManifest(raw, 'property', []);
      if (refusal) {
        assert.throws(write, /symlink component/);
        assert.deepEqual(tree(fixture), before, 'refused writer must never mutate the fixture');
      } else {
        const outside = tree(target);
        write();
        assert.deepEqual(tree(target), outside, 'writer must use its admitted spelling (F1/F2)');
        assert(
          fs.existsSync(path.join(output, name === 'fallow' ? 'monorepo.json' : 'manifest.json')),
        );
      }
    }
    for (const [label, count] of Object.entries(counts))
      assert(count >= cases / 6, `starved ${name}/${label}`);
    console.log(`PASS ${name} ${JSON.stringify(counts)}`);
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
