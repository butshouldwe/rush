import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '../dist/index.js';
import { Effect, Exit, Cause } from 'effect';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

test.each([
  { allOf: [{ type: 'object', additionalProperties: true }] },
  { allOf: [{ type: 'object', additionalProperties: { type: 'string' } }] },
  { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'object' }] },
  JSON.parse('{"if":{"additionalProperties":true},"then":{"type":"object"}}'),
])('unevaluated closure cannot hide arbitrary evaluated keys: %j', async (composition) => {
  const f = fixture();
  f.put('schemas/effective.json', {
    type: 'object',
    ...composition,
    unevaluatedProperties: false,
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_POSTURE' })],
  });
});

test.each([
  'apply',
  'preview',
  'reserved',
  'reserved-alias',
  'destination-alias',
  'invalid-plan',
  'state-root',
  'early-options',
])('rejected authoring result paths never become output files: %s', async (scenario) => {
  const f = fixture();
  const destination = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(destination);
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'new' }),
      },
    ],
  };
  const plan = await f.client.previewEdits(request);
  let output = destination;
  if (scenario.startsWith('reserved')) {
    const state = path.join(f.root, 'common/temp/config-rush-authoring');
    fs.mkdirSync(state, { recursive: true });
    output = path.join(state, 'writer.lock');
    if (scenario === 'reserved-alias') {
      fs.symlinkSync(state, path.join(f.root, 'state-alias'));
      output = path.join(f.root, 'state-alias/writer.lock');
    }
  }
  if (scenario === 'state-root') {
    fs.mkdirSync(path.join(f.root, 'common/temp'), { recursive: true });
    output = path.join(f.root, 'common/temp/config-rush-authoring');
  }
  if (scenario === 'destination-alias') {
    fs.symlinkSync(path.dirname(destination), path.join(f.root, 'destination-alias'));
    output = path.join(f.root, 'destination-alias/tool.json');
  }
  if (scenario === 'invalid-plan') {
    plan.targets[0].file = path.join(f.root, 'misleading.json');
  }
  const input = path.join(f.root, 'input.json');
  fs.writeFileSync(input, JSON.stringify(scenario === 'preview' ? request : plan));
  const args =
    scenario === 'preview' ? ['preview', '--request-file', input] : ['apply', '--plan-file', input];
  if (scenario === 'early-options') args.push('--optional');
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      ...args,
      '--root',
      f.root,
      '--result-file',
      output,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).not.toBe(0);
  expect(JSON.parse(result.stdout).effects).toEqual({
    applied: [],
    failed: [],
    unattempted: [],
    unknown: [],
  });
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(destination)).toBe(false);
});

test('selected no-change consumers cannot make a shared document writable', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/other', projectFolder: 'apps/other' },
    ],
  });
  f.put('apps/other/package.json', { name: '@example/other' });
  f.put('apps/other/config/tool.json', doc({}, { extends: '../../app/config/tool.json' }));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'changed',
        },
        { project: '@example/other', domain: 'tool', operation: 'unset', pointer: '/addons' },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SHARED_SOURCE_EDIT' })],
  });
});

test('post-write refresh cannot adopt an external replacement as planned bytes', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({ ...reg.domains[0], name: 'a', projectFile: 'config/a.json' });
  saveRegistry(f, reg);
  f.put('apps/app/config/a.json', { ...doc({ channel: null }), domain: 'a' });
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: ['a', 'tool'].map((domain) => ({
      project: '@example/app',
      domain,
      operation: 'set',
      pointer: '/channel',
      value: 'planned',
    })),
  });
  const input = path.join(f.root, 'plan.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  const hook = path.join(f.root, 'external-change.mjs'),
    target = path.join(f.root, 'apps/app/config/a.json');
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;let changed=false;fs.renameSync=(a,b)=>{const r=rename(a,b);if(!changed&&b.includes('config-rush-authoring/')&&b.endsWith('.json')){const journal=JSON.parse(fs.readFileSync(b,'utf8'));if(journal.targets[0].state==='applied'){changed=true;fs.writeFileSync(${JSON.stringify(target)},${JSON.stringify(JSON.stringify({ ...doc({ channel: 'external' }), domain: 'a' }))});}}return r;};`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(4);
  expect(JSON.parse(result.stdout).effects.unknown).toHaveLength(1);
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBeNull();
});

test.each(['logical', 'physical'])(
  'symlinked reserved storage is protected through its %s path',
  (spelling) => {
    const f = fixture(),
      state = path.join(f.root, 'common/temp/config-rush-authoring'),
      physical = path.join(f.root, 'physical-state');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, state);
    const input = path.join(f.root, 'request.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        requestVersion: 1,
        edits: [
          {
            project: '@example/app',
            domain: 'tool',
            operation: 'set',
            pointer: '/channel',
            value: 'candidate',
          },
        ],
      }),
    );
    const output = path.join(spelling === 'logical' ? state : physical, 'writer.lock');
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../dist/cli.js'),
        'preview',
        '--root',
        f.root,
        '--request-file',
        input,
        '--result-file',
        output,
        '--json',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(fs.existsSync(output)).toBe(false);
  },
);

test.each([1, 2])(
  'Effect interruption owns the writer through validation boundary %s',
  async (boundary) => {
    const f = fixture();
    admitCheck(
      f,
      `let remaining=Infinity;let enter,resume;export const started=new Promise(r=>enter=r);export function arm(n){remaining=n}export function release(){resume()}export async function validate(){if(--remaining===0){enter();await new Promise(r=>resume=r)}return []}`,
    );
    const gate = await import(
      path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks/check.mjs')
    );
    const plan = await f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'must-not-write',
        },
      ],
    });
    const file = path.join(f.root, 'apps/app/config/tool.json'),
      before = fs.readFileSync(file),
      controller = new AbortController();
    gate.arm(boundary);
    let settled = false;
    const pending = Effect.runPromise(f.client.applyEditsEffect(plan), {
      signal: controller.signal,
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await gate.started;
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeCleanup = settled;
    gate.release();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settledBeforeCleanup).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(f.root, 'common/temp/config-rush-authoring/writer.lock'))).toBe(
      false,
    );
  },
);

test('recovery never rewrites applied history as unattempted after external restoration', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json'),
    before = fs.readFileSync(file);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'applied',
      },
    ],
  });
  const result = await f.client.applyEdits(plan);
  fs.writeFileSync(file, before);
  const status = await f.client.editStatus(result.operationId);
  expect(status.targets[0]).toMatchObject({ state: 'applied', observed: 'original' });
  expect(status.effects.unattempted).toHaveLength(0);
  expect(status.effects.unknown).toHaveLength(1);
});

test.each([
  ['    ', '\n'],
  ['\t', '\r\n'],
])('authoring preserves existing indentation %j and newline style', async (indent, eol) => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json');
  const formatted = (values) =>
    JSON.stringify(doc(values), null, indent)
      .replace(indent + '"values"', indent + '// retained comment\n' + indent + '"values"')
      .replaceAll('\n', eol) + eol;
  const before = formatted({ channel: null });
  fs.writeFileSync(file, before);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/addons',
        value: ['one', 'two'],
      },
    ],
  });
  expect(plan.targets[0].after).toBe(formatted({ channel: null, addons: ['one', 'two'] }));
  expect((await f.client.applyEdits(plan)).status).toBe('success');
  expect(fs.readFileSync(file, 'utf8')).toBe(plan.targets[0].after);
});

test('new inherited candidates retain their own source expectations across a batch', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' });
  saveRegistry(f, reg);
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  for (const domain of ['tool', 'other'])
    f.put(`apps/app/config/${domain}-base.json`, { ...doc({ channel: 'inherited' }), domain });
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: ['tool', 'other'].map((domain) => ({
      project: '@example/app',
      domain,
      operation: 'create',
      document: { ...doc({}, { extends: `./${domain}-base.json` }), domain },
    })),
  });
  expect((await f.client.applyEdits(plan)).effects.applied).toHaveLength(2);
});

test('unbounded shared-source discovery fails closed rather than truncating', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/other', projectFolder: 'apps/other' },
    ],
  });
  f.put('apps/other/package.json', { name: '@example/other' });
  f.put('apps/other/config/tool.json', doc({}, { extends: './parent-0.json' }));
  for (let i = 0; i < 130; i++)
    f.put(
      `apps/other/config/parent-${i}.json`,
      doc({}, { extends: i === 129 ? '../../app/config/tool.json' : `./parent-${i + 1}.json` }),
    );
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'candidate',
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SOURCE_SCOPE_LIMIT' })],
  });
});

test('ambiguous indentation is refused without changing unaffected content', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json');
  const before = JSON.stringify(doc({ channel: null }), null, '    ').replace(
    '        "channel"',
    '  "channel"',
  );
  fs.writeFileSync(file, before);
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/addons',
          value: ['new'],
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'INDENTATION_UNSUPPORTED' })],
  });
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

test.each(['lock', 'journal', 'destination'])(
  'post-open identity failure closes and cleans the %s resource',
  async (resource) => {
    const f = fixture();
    const plan = await f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'never-written',
        },
      ],
    });
    const input = path.join(f.root, 'plan.json'),
      proof = path.join(f.root, 'fds.json'),
      hook = path.join(f.root, 'fail-identity.mjs');
    fs.writeFileSync(input, JSON.stringify(plan));
    fs.writeFileSync(
      hook,
      `import fs from 'node:fs';const open=fs.openSync,stat=fs.fstatSync,close=fs.closeSync;let selected,fired=false;const outstanding=new Set();fs.openSync=(name,...args)=>{const fd=open(name,...args);const s=String(name);if(args[0]==='wx'&&(${JSON.stringify(resource)}==='lock'?s.endsWith('writer.lock'):${JSON.stringify(resource)}==='journal'?s.includes('config-rush-authoring/')&&s.endsWith('.tmp'):s.includes('/config/.config-rush-'))){selected=fd;outstanding.add(fd)}return fd;};fs.fstatSync=(fd,...args)=>{if(fd===selected&&!fired){fired=true;throw Object.assign(new Error('injected fstat failure'),{code:'EIO'})}return stat(fd,...args)};fs.closeSync=(fd)=>{const result=close(fd);outstanding.delete(fd);return result;};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({fired,closed:outstanding.size===0})));`,
    );
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        hook,
        path.resolve(import.meta.dirname, '../dist/cli.js'),
        'apply',
        '--root',
        f.root,
        '--plan-file',
        input,
        '--json',
      ],
      { encoding: 'utf8' },
    );
    expect(child.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(proof, 'utf8'))).toEqual({ fired: true, closed: true });
    const state = path.join(f.root, 'common/temp/config-rush-authoring');
    expect(
      fs.readdirSync(state).filter((name) => name === 'writer.lock' || name.endsWith('.tmp')),
    ).toEqual([]);
    expect(
      fs.readdirSync(path.join(f.root, 'apps/app/config')).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
        .channel,
    ).toBeNull();
  },
);

test('recovery distinguishes a non-file from original absence', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(file);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'created' }),
      },
    ],
  });
  const result = await f.client.applyEdits(plan);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  const status = await f.client.editStatus(result.operationId);
  expect(status.targets[0].observed).toBe('other');
  expect(status.effects.unknown).toHaveLength(1);
});

test('ordinary reads do not inherit candidate observation budgets', async () => {
  const f = fixture();
  admitCheck(f, 'export function validate(){return []}');
  fs.writeFileSync(
    path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks/unused.bin'),
    Buffer.alloc(17 * 1024 * 1024),
  );
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
  await expect(
    f.client.previewCandidates({
      documents: [
        {
          project: '@example/app',
          domain: 'tool',
          contents: JSON.stringify(doc({ channel: 'candidate' })),
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_FAILURE' })],
  });
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
});

test('prospective sources through directory aliases remain protected', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/other', projectFolder: 'apps/other' },
    ],
  });
  f.put('apps/other/package.json', { name: '@example/other' });
  fs.symlinkSync(path.join(f.root, 'apps/app/config'), path.join(f.root, 'alias'));
  f.put('apps/other/config/tool.json', doc({}, { extends: '../../../alias/tool.json' }));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'create',
          document: doc({ channel: 'new' }),
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SHARED_SOURCE_EDIT' })],
  });
});

test('own writes advance observed directory aliases but not independent hard links', async () => {
  const f = fixture(),
    reg = registry(f),
    file = path.join(f.root, 'apps/app/config/tool.json');
  fs.symlinkSync(path.join(f.root, 'apps/app/config'), path.join(f.root, 'apps/app/alias'));
  fs.linkSync(file, path.join(f.root, 'apps/app/config/independent.json'));
  const independent = fs.readFileSync(path.join(f.root, 'apps/app/config/independent.json'));
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
    '/addons/0': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'alias/tool.json',
      },
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/addons',
        value: ['config/independent.json'],
      },
    ],
  });
  const result = await f.client.applyEdits(plan);
  expect(result.status).toBe('success');
  expect(result.effects.applied).toHaveLength(1);
  expect(fs.readFileSync(path.join(f.root, 'apps/app/config/independent.json'))).toEqual(
    independent,
  );
});

test('prospective aliases advance new directory observations without losing checks', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].projectFile = 'generated/nested/tool.json';
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  fs.symlinkSync(path.join(f.root, 'apps/app/generated'), path.join(f.root, 'apps/app/alias'));
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'alias/nested/tool.json' }),
      },
    ],
  });
  expect((await f.client.applyEdits(plan)).status).toBe('success');
});

test('persistent identity failure closes the descriptor and reports preserved unknown ownership', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'not-written',
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'persistent-identity.mjs'),
    proof = path.join(f.root, 'closed.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const open=fs.openSync,stat=fs.fstatSync,close=fs.closeSync;let selected,closed=false;fs.openSync=(name,...args)=>{const fd=open(name,...args);if(String(name).endsWith('writer.lock')&&args[0]==='wx')selected=fd;return fd;};fs.fstatSync=(fd,...args)=>{if(fd===selected)throw Object.assign(new Error('persistent metadata failure'),{code:'EIO'});return stat(fd,...args);};fs.closeSync=(fd)=>{const r=close(fd);if(fd===selected){closed=true;selected=undefined}return r;};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({closed})));`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(1);
  expect(JSON.parse(child.stdout).diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'RESOURCE_CLEANUP_UNKNOWN' })]),
  );
  expect(JSON.parse(fs.readFileSync(proof, 'utf8')).closed).toBe(true);
  expect(fs.existsSync(path.join(f.root, 'common/temp/config-rush-authoring/writer.lock'))).toBe(
    true,
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBeNull();
});

test('retargeting an observed alias invalidates the preview before writes', async () => {
  const f = fixture(),
    reg = registry(f),
    alias = path.join(f.root, 'apps/app/alias');
  fs.symlinkSync(path.join(f.root, 'apps/app/config'), alias);
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'alias/tool.json',
      },
    ],
  });
  f.put('apps/app/other/tool.json', doc({ channel: null }));
  fs.unlinkSync(alias);
  fs.symlinkSync(path.join(f.root, 'apps/app/other'), alias);
  await expect(f.client.applyEdits(plan)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'STALE_PREVIEW' })],
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBeNull();
});

test('a final symbolic link to a prospective candidate retains lstat semantics', async () => {
  const f = fixture(),
    reg = registry(f);
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  fs.symlinkSync('config/tool.json', path.join(f.root, 'apps/app/leaf.json'));
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'leaf.json' }),
      },
    ],
  });
  expect((await f.client.applyEdits(plan)).status).toBe('success');
  expect(fs.lstatSync(path.join(f.root, 'apps/app/leaf.json')).isSymbolicLink()).toBe(true);
});

test('validator package fingerprints detect retargeting to an already inventoried module', async () => {
  const f = fixture();
  admitCheck(
    f,
    `import {version} from './helper.mjs';export function validate(){return version===1?[]:[{code:'NEW_RULE',message:'new rule'}]}`,
  );
  const pkg = path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks');
  fs.writeFileSync(path.join(pkg, 'v1.mjs'), 'export const version=1');
  fs.writeFileSync(path.join(pkg, 'v2.mjs'), 'export const version=2');
  fs.symlinkSync('v1.mjs', path.join(pkg, 'helper.mjs'));
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
  fs.unlinkSync(path.join(pkg, 'helper.mjs'));
  fs.symlinkSync('v2.mjs', path.join(pkg, 'helper.mjs'));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_PACKAGE_CHANGED' })],
  });
});

test('requested absent local targets validate against every candidate document', async () => {
  const f = fixture();
  admitCheck(
    f,
    `export function validate(ctx){return ctx.inspect('peer').exists?[{code:'PEER_EXISTS',message:'peer must remain absent'}]:[]}`,
  );
  const reg = registry(f);
  delete reg.domains[0].versions['1.0.0'].validators;
  reg.domains.push({
    ...reg.domains[0],
    name: 'other',
    projectFile: 'config/other.json',
    versions: { '1.0.0': { ...reg.domains[0].versions['1.0.0'], validators: ['check'] } },
  });
  reg.validators.check.inputs = {
    peer: {
      path: 'apps/app/config/tool.json',
      base: 'repository',
      allowedRoots: [{ base: 'repository', path: '.' }],
      mustExist: false,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  f.put('apps/app/config/rig.json', { rigPackageName: 'example-rig' });
  f.put('apps/app/node_modules/example-rig/package.json', {
    name: 'example-rig',
    version: '1.0.0',
  });
  f.put('apps/app/node_modules/example-rig/profiles/default/config/other.json', {
    ...doc({ channel: 'rig' }),
    domain: 'other',
  });
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'create',
          document: doc({ channel: 'new' }),
        },
        { project: '@example/app', domain: 'other', operation: 'unset', pointer: '/addons' },
      ],
    }),
  ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'PEER_EXISTS' })] });
});

test('a registered validator-package project is never an authoring destination', async () => {
  const f = fixture();
  admitCheck(
    f,
    `import rules from './config/tool.json' with {type:'json'};export function validate(ctx){return ctx.values.channel===rules.values.channel?[{code:'RULE',message:'same as rule'}]:[]}`,
  );
  const installed = path.join(
      f.root,
      'common/autoinstallers/rush-plugins/node_modules/example-checks',
    ),
    provider = path.join(f.root, 'tools/checks');
  fs.mkdirSync(path.dirname(provider), { recursive: true });
  fs.renameSync(installed, provider);
  fs.symlinkSync(provider, installed);
  f.put('tools/checks/config/tool.json', doc({ channel: 'old-rule' }));
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: 'example-checks', projectFolder: 'tools/checks' },
    ],
  });
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: 'example-checks',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'new-rule',
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_SOURCE_EDIT' })],
  });
});

test('locked preflight failure preserves both primary and cleanup diagnostics', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'not-written',
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'preflight-cleanup.mjs'),
    target = path.join(f.root, 'apps/app/config/tool.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const open=fs.openSync,write=fs.writeFileSync,unlink=fs.unlinkSync;let lock;fs.openSync=(name,...args)=>{const fd=open(name,...args);if(String(name).endsWith('writer.lock')&&args[0]==='wx')lock=fd;return fd;};fs.writeFileSync=(file,...args)=>{const result=write(file,...args);if(file===lock)fs.appendFileSync(${JSON.stringify(target)},' ');return result;};fs.unlinkSync=(file)=>{if(String(file).endsWith('writer.lock'))throw Object.assign(new Error('cleanup denied'),{code:'EACCES'});return unlink(file);};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const diagnostics = JSON.parse(child.stdout).diagnostics;
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'STALE_PREVIEW' }),
      expect.objectContaining({
        code: 'OPERATION_CLEANUP_FAILED',
        file: path.join(f.root, 'common/temp/config-rush-authoring/writer.lock'),
      }),
    ]),
  );
  expect(child.status).toBe(1);
});

test('Effect interruption retains cleanup failures in its final cause', async () => {
  const f = fixture();
  admitCheck(
    f,
    `let n=Infinity,enter,resume;export const started=new Promise(r=>enter=r);export function arm(){n=2}export function release(){resume()}export async function validate(){if(--n===0){enter();await new Promise(r=>resume=r)}return []}`,
  );
  const gate = await import(
    path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks/check.mjs')
  );
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'not-written',
      },
    ],
  });
  const controller = new AbortController();
  gate.arm();
  const pending = Effect.runPromiseExit(f.client.applyEditsEffect(plan), {
    signal: controller.signal,
  });
  await gate.started;
  const unlink = fs.unlinkSync;
  let exit;
  try {
    fs.unlinkSync = (file) => {
      if (file === path.join(f.root, 'common/temp/config-rush-authoring/writer.lock'))
        throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      return unlink(file);
    };
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    gate.release();
    exit = await pending;
  } finally {
    fs.unlinkSync = unlink;
  }
  expect(Exit.isFailure(exit)).toBe(true);
  const diagnostics = exit.cause.reasons
    .filter(Cause.isFailReason)
    .flatMap((reason) => reason.error.diagnostics ?? []);
  expect(diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'OPERATION_CLEANUP_FAILED' })]),
  );
});

test('removed domains do not disable interrupted journal reconciliation', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' });
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'written',
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'kill-after-rename.mjs'),
    file = path.join(f.root, 'apps/app/config/tool.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const r=rename(a,b);if(b===${JSON.stringify(file)})process.kill(process.pid,'SIGKILL');return r;};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.signal).toBe('SIGKILL');
  const storage = path.join(f.root, 'common/temp/config-rush-authoring'),
    journal = fs.readdirSync(storage).find((name) => name.endsWith('.json'));
  const id = JSON.parse(fs.readFileSync(path.join(storage, journal), 'utf8')).operationId;
  reg.domains = reg.domains.filter((domain) => domain.name !== 'tool');
  saveRegistry(f, reg);
  const status = await f.client.editStatus(id);
  expect(status.targets[0]).toMatchObject({ state: 'writing', observed: 'unknown' });
  expect(status.effects.unknown).toHaveLength(1);
  expect(status.lock.ownerAlive).toBe(false);
});

test('unset preserves standalone adjacent comments exactly', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json');
  const before =
    '{\n  "formatVersion": 1,\n  "domain": "tool",\n  "contractVersion": "1.0.0",\n  "values": {\n    // keep before\n    "addons": ["a"],\n    // keep after\n    "channel": null\n  }\n}\n';
  const expected =
    '{\n  "formatVersion": 1,\n  "domain": "tool",\n  "contractVersion": "1.0.0",\n  "values": {\n    // keep before\n    // keep after\n    "channel": null\n  }\n}\n';
  fs.writeFileSync(file, before);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [{ project: '@example/app', domain: 'tool', operation: 'unset', pointer: '/addons' }],
  });
  expect(plan.targets[0].after).toBe(expected);
  expect((await f.client.applyEdits(plan)).status).toBe('success');
  expect(fs.readFileSync(file, 'utf8')).toBe(expected);
});

test.each(['first', 'last', 'only', 'key-comment'])(
  'unset preserves comment trivia for %s properties',
  async (position) => {
    const f = fixture(),
      file = path.join(f.root, 'apps/app/config/tool.json');
    f.put('apps/app/config/base.json', doc({ channel: 'inherited' }));
    const target =
      position === 'key-comment'
        ? '"addons":\n    // between key and value\n    ["a" /* inside removed value */]'
        : '"addons": ["a" /* inside removed value */]';
    const members =
      position === 'last'
        ? `    "channel": null,\n    // before\n    ${target}\n    // after`
        : `    // before\n    ${target},\n    // after${position === 'only' ? '' : '\n    "channel": null'}`;
    const text = `{\n  "formatVersion": 1,\n  "domain": "tool",\n  "contractVersion": "1.0.0",\n  "extends": "./base.json",\n  "values": {\n${members}\n  }\n}\n`;
    fs.writeFileSync(file, text);
    const plan = await f.client.previewEdits({
      requestVersion: 1,
      edits: [{ project: '@example/app', domain: 'tool', operation: 'unset', pointer: '/addons' }],
    });
    expect(plan.targets[0].after).toContain('    // before');
    expect(plan.targets[0].after).toContain('    // after');
    expect(plan.targets[0].after).not.toContain('inside removed value');
    if (position === 'key-comment')
      expect(plan.targets[0].after).toContain('    // between key and value');
    expect((await f.client.applyEdits(plan)).status).toBe('success');
    expect(
      (await f.client.get({ project: '@example/app', domain: 'tool' })).values.addons,
    ).toBeUndefined();
  },
);

test('array deletion preserves standalone comments and remaining values', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json');
  fs.writeFileSync(
    file,
    `{ "formatVersion":1,"domain":"tool","contractVersion":"1.0.0","values":{"channel":null,"addons":[\n  "a",\n  // before\n  "b",\n  // after\n  "c"\n]}}`,
  );
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [{ project: '@example/app', domain: 'tool', operation: 'unset', pointer: '/addons/1' }],
  });
  expect(plan.targets[0].after).toContain('// before');
  expect(plan.targets[0].after).toContain('// after');
  expect(plan.effective[0].values.addons).toEqual(['a', 'c']);
});

test('unused unavailable validator admission does not force installation', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.packages = { missing: '1.0.0' };
  reg.validators = {
    unused: {
      module: 'package:missing/check.mjs',
      export: 'validate',
      scope: 'project',
      inputs: {},
    },
  };
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'local',
      },
    ],
  });
  expect((await f.client.applyEdits(plan)).status).toBe('success');
});

test('validator-package subdirectories inside another project stay protected', async () => {
  const f = fixture();
  admitCheck(f, 'export function validate(){return []}');
  const installed = path.join(
      f.root,
      'common/autoinstallers/rush-plugins/node_modules/example-checks',
    ),
    provider = path.join(f.root, 'apps/app/vendor/checks');
  fs.mkdirSync(path.dirname(provider), { recursive: true });
  fs.renameSync(installed, provider);
  fs.symlinkSync(provider, installed);
  f.put('apps/app/vendor/checks/config/tool.json', doc({ channel: 'old' }));
  const reg = registry(f);
  reg.domains[0].projectFile = 'vendor/checks/config/tool.json';
  saveRegistry(f, reg);
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'new',
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_SOURCE_EDIT' })],
  });
});

test.each([
  'common/config/rush/pnpm-lock.yaml',
  'common/autoinstallers/rush-plugins/pnpm-lock.yaml',
])('symlinked lockfile content is a precondition: %s', async (name) => {
  const f = fixture();
  f.put('pins/lock.yaml', { old: true });
  const file = path.join(f.root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(path.join(f.root, 'pins/lock.yaml'), file);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
    ],
  });
  f.put('pins/lock.yaml', { new: true });
  await expect(f.client.applyEdits(plan)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'STALE_PREVIEW' })],
  });
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
});

test.each(['unlink', 'close-and-unlink'])(
  'journal primary and cleanup errors retain every temporary path: %s',
  async (mode) => {
    const f = fixture();
    const plan = await f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'new',
        },
      ],
    });
    const input = path.join(f.root, 'plan.json'),
      hook = path.join(f.root, 'journal-errors.mjs');
    fs.writeFileSync(input, JSON.stringify(plan));
    fs.writeFileSync(
      hook,
      `import fs from 'node:fs';const open=fs.openSync,sync=fs.fsyncSync,close=fs.closeSync,unlink=fs.unlinkSync;const journals=new Set();fs.openSync=(name,...args)=>{const fd=open(name,...args);if(String(name).includes('config-rush-authoring')&&String(name).endsWith('.tmp')&&args[0]==='wx')journals.add(fd);return fd;};fs.closeSync=(fd)=>{const owned=journals.delete(fd);const result=close(fd);if(owned&&${JSON.stringify(mode === 'close-and-unlink')})throw Object.assign(new Error('private close payload'),{code:'EIO'});return result;};fs.fsyncSync=(fd)=>{if(journals.has(fd))throw Object.assign(new Error('private payload'),{code:'EIO'});return sync(fd);};fs.unlinkSync=(file)=>{if(String(file).includes('config-rush-authoring')&&String(file).endsWith('.tmp'))throw Object.assign(new Error('private cleanup payload'),{code:'EACCES'});return unlink(file);};`,
    );
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        hook,
        path.resolve(import.meta.dirname, '../dist/cli.js'),
        'apply',
        '--root',
        f.root,
        '--plan-file',
        input,
        '--json',
      ],
      { encoding: 'utf8' },
    );
    const frame = JSON.parse(child.stdout),
      storage = path.join(f.root, 'common/temp/config-rush-authoring');
    const remains = fs.readdirSync(storage).filter((name) => name.endsWith('.tmp'));
    expect(remains.length).toBeGreaterThan(0);
    for (const name of remains)
      expect(frame.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'JOURNAL_TEMPORARY_CLEANUP_FAILED',
            file: path.join(storage, name),
          }),
          expect.objectContaining({ code: 'JOURNAL_WRITE_FAILED', file: path.join(storage, name) }),
        ]),
      );
    if (mode === 'close-and-unlink')
      expect(frame.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'JOURNAL_DESCRIPTOR_CLEANUP_FAILED' }),
        ]),
      );
    expect(child.stdout).not.toContain('private');
    expect(child.status).not.toBe(0);
    expect(
      (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
    ).toBeNull();
  },
);

test('journal capacity is rechecked after a cooperating writer wins the lock', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  f.put('apps/second/config/tool.json', doc({ channel: null }));
  const plans = [];
  for (const project of ['@example/app', '@example/second'])
    plans.push(
      // eslint-disable-next-line no-await-in-loop -- Freeze the two independent plans before the interleaving.
      await f.client.previewEdits({
        requestVersion: 1,
        edits: [{ project, domain: 'tool', operation: 'set', pointer: '/channel', value: 'new' }],
      }),
    );
  const storage = path.join(f.root, 'common/temp/config-rush-authoring');
  fs.mkdirSync(storage, { recursive: true });
  for (let i = 0; i < 255; i++) fs.writeFileSync(path.join(storage, `history-${i}.json`), '{}');
  const first = path.join(f.root, 'a-plan.json'),
    second = path.join(f.root, 'b-plan.json'),
    hook = path.join(f.root, 'capacity.mjs'),
    cli = path.resolve(import.meta.dirname, '../dist/cli.js');
  fs.writeFileSync(first, JSON.stringify(plans[0]));
  fs.writeFileSync(second, JSON.stringify(plans[1]));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';import {spawnSync} from 'node:child_process';const open=fs.openSync;let fired=false;fs.openSync=(file,...args)=>{if(!fired&&String(file).endsWith('writer.lock')&&args[0]==='wx'){fired=true;const other=spawnSync(process.execPath,[${JSON.stringify(cli)},'apply','--root',${JSON.stringify(f.root)},'--plan-file',${JSON.stringify(second)},'--json'],{encoding:'utf8'});if(other.status!==0)throw Error('other writer failed: '+other.stdout);}return open(file,...args);};`,
  );
  const child = spawnSync(
    process.execPath,
    ['--import', hook, cli, 'apply', '--root', f.root, '--plan-file', first, '--json'],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(child.stdout).diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'JOURNAL_LIMIT' })]),
  );
  expect(fs.readdirSync(storage).filter((n) => n.endsWith('.json'))).toHaveLength(256);
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
  expect((await f.client.get({ project: '@example/second', domain: 'tool' })).values.channel).toBe(
    'new',
  );
});

test('apply and status agree on a directory replacing planned absence', async () => {
  const f = fixture(),
    target = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(target);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'new' }),
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'directory-race.mjs');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;let fired=false;fs.renameSync=(from,to)=>{const result=rename(from,to);if(!fired&&String(to).includes('config-rush-authoring')&&String(to).endsWith('.json')&&JSON.parse(fs.readFileSync(to,'utf8')).targets.some(t=>t.state==='writing')){fired=true;fs.mkdirSync(${JSON.stringify(target)});}return result;};`,
  );
  const child = spawnSync(
      process.execPath,
      [
        '--import',
        hook,
        path.resolve(import.meta.dirname, '../dist/cli.js'),
        'apply',
        '--root',
        f.root,
        '--plan-file',
        input,
        '--json',
      ],
      { encoding: 'utf8' },
    ),
    result = JSON.parse(child.stdout).data;
  expect(result.effects.unknown).toHaveLength(1);
  expect(result.effects.failed).toHaveLength(0);
  const status = await f.client.editStatus(result.operationId);
  expect(status.effects).toEqual(result.effects);
  expect(status.targets[0].observed).toBe('other');
  expect(fs.statSync(target).isDirectory()).toBe(true);
});

test.each(['new-failure', 'participating-existing-failure', 'unrelated-existing-failure'])(
  'unrequested consumer constraints: %s',
  async (scenario) => {
    const f = fixture();
    f.put('rush.json', {
      projects: [
        { packageName: '@example/app', projectFolder: 'apps/app' },
        { packageName: '@example/second', projectFolder: 'apps/second' },
      ],
    });
    f.put('apps/second/package.json', { name: '@example/second' });
    f.put('apps/second/config/tool.json', doc({ channel: null }));
    fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
    admitCheck(
      f,
      `export function validate(c){if(c.project.name!=='@example/second')return [];return ${scenario === 'new-failure' ? "c.inspect('peer').exists" : 'true'}?[{code:'PEER_CONSTRAINT',message:'Peer constraint failed'}]:[]}`,
      {
        peer: {
          path:
            scenario === 'unrelated-existing-failure'
              ? 'apps/third/config/tool.json'
              : 'apps/app/config/tool.json',
          base: 'repository',
          allowedRoots: [{ base: 'repository', path: '.' }],
          mustExist: false,
          symlinks: 'within-roots',
        },
      },
    );
    const request = {
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'create',
          document: doc({ channel: 'new' }),
        },
      ],
    };
    if (scenario === 'unrelated-existing-failure') {
      const plan = await f.client.previewEdits(request);
      expect(plan.unrelated.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PEER_CONSTRAINT' })]),
      );
      expect((await f.client.applyEdits(plan)).status).toBe('success');
    } else {
      await expect(f.client.previewEdits(request)).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'PEER_CONSTRAINT', project: '@example/second' }),
        ]),
      });
      expect(fs.existsSync(path.join(f.root, 'apps/app/config/tool.json'))).toBe(false);
    }
  },
);

test.each(['repair', 'stale', 'structural'])(
  'affected consumer qualification: %s',
  async (scenario) => {
    const f = fixture();
    f.put('rush.json', {
      projects: [
        { packageName: '@example/app', projectFolder: 'apps/app' },
        { packageName: '@example/second', projectFolder: 'apps/second' },
      ],
    });
    f.put('apps/second/package.json', { name: '@example/second' });
    f.put('apps/second/config/tool.json', doc(scenario === 'structural' ? {} : { channel: null }));
    fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
    admitCheck(
      f,
      `export function validate(c){return c.project.name==='@example/second'&&!c.inspect('peer').exists?[{code:'NEEDS_PEER',message:'Peer required'}]:[]}`,
      {
        peer: {
          path: 'apps/app/config/tool.json',
          base: 'repository',
          allowedRoots: [{ base: 'repository', path: '.' }],
          mustExist: false,
          symlinks: 'within-roots',
        },
      },
    );
    const request = {
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'create',
          document: doc({ channel: 'new' }),
        },
      ],
    };
    if (scenario === 'structural') {
      await expect(f.client.previewEdits(request)).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'SCHEMA_INVALID', project: '@example/second' }),
        ]),
      });
      return;
    }
    const plan = await f.client.previewEdits(request);
    expect(plan.scope.evaluated).toContainEqual({ project: '@example/second', domain: 'tool' });
    expect(plan.unrelated.evaluated).toHaveLength(0);
    if (scenario === 'stale') {
      f.put('apps/second/config/tool.json', doc({ channel: 'changed' }));
      await expect(f.client.applyEdits(plan)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'STALE_PREVIEW' })],
      });
    } else {
      expect((await f.client.applyEdits(plan)).status).toBe('success');
      expect((await f.client.validate()).valid).toBe(true);
    }
  },
);

test('newly affected consumers stop a later write without blocking unrelated value changes', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  f.put('apps/second/config/tool.json', doc({ channel: 'elsewhere/missing.json' }));
  f.put('apps/app/config/other.json', { ...doc({ channel: null }), domain: 'other' });
  const reg = registry(f);
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'repository',
      allowedRoots: [{ base: 'repository', path: '.' }],
      mustExist: false,
      symlinks: 'within-roots',
    },
  };
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' });
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: ['other', 'tool'].map((domain) => ({
      project: '@example/app',
      domain,
      operation: 'set',
      pointer: '/channel',
      value: 'new',
    })),
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'scope-change.mjs'),
    first = path.join(f.root, 'apps/app/config/other.json'),
    peer = path.join(f.root, 'apps/second/config/tool.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const result=rename(a,b);if(b===${JSON.stringify(first)})fs.writeFileSync(${JSON.stringify(peer)},${JSON.stringify(JSON.stringify(doc({ channel: 'apps/app/config/tool.json' })))});return result;};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(child.stdout).data;
  expect(result.status).toBe('partial');
  expect(result.effects.applied).toHaveLength(1);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'STALE_PREVIEW',
        message: expect.stringContaining('Affected consumer scope'),
      }),
    ]),
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBeNull();
});

test('candidate file parents cannot hide an affected descendant-path failure', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  f.put('apps/second/config/tool.json', doc({ channel: null }));
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  admitCheck(f, 'export function validate(){return []}', {
    peer: {
      path: 'apps/app/config/tool.json/child',
      base: 'repository',
      allowedRoots: [{ base: 'repository', path: '.' }],
      mustExist: false,
      symlinks: 'within-roots',
    },
  });
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'create',
          document: doc({ channel: 'new' }),
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({ code: 'INTERNAL', kind: 'execution', project: '@example/app' }),
    ],
  });
});

test('unreadable destinations remain unknown in apply and status', async () => {
  const f = fixture(),
    target = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(target);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'new' }),
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    driver = path.join(f.root, 'unreadable.mjs');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    driver,
    `import fs from 'node:fs';import {createClient} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../dist/index.js')).href)};const rename=fs.renameSync,read=fs.readFileSync,open=fs.openSync;let fired=false;const target=${JSON.stringify(target)};fs.renameSync=(a,b)=>{const result=rename(a,b);if(!fired&&String(b).includes('config-rush-authoring')&&String(b).endsWith('.json')&&JSON.parse(read(b,'utf8')).targets.some(t=>t.state==='writing')){fired=true;fs.writeFileSync(target,'external');}return result;};fs.readFileSync=(file,...args)=>{if(fired&&file===target)throw Object.assign(new Error('denied'),{code:'EACCES'});return read(file,...args);};fs.openSync=(file,...args)=>{if(fired&&file===target)throw Object.assign(new Error('denied'),{code:'EACCES'});return open(file,...args);};const client=createClient({root:${JSON.stringify(f.root)}});const result=await client.applyEdits(JSON.parse(read(${JSON.stringify(input)},'utf8')));const status=await client.editStatus(result.operationId);console.log(JSON.stringify({result,status}));`,
  );
  const child = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  const { result, status } = JSON.parse(child.stdout);
  expect(result.effects.unknown).toHaveLength(1);
  expect(result.effects.failed).toHaveLength(0);
  expect(status.effects).toEqual(result.effects);
  expect(status.targets[0].observed).toBe('unknown');
});

test('authoring previews preserve comments and validate a whole candidate', async () => {
  const f = fixture();
  const local = path.join(f.root, 'apps/app/config/tool.json');
  const before =
    '{ // keep this comment\n"formatVersion":1,"domain":"tool","contractVersion":"1.0.0","values":{"channel":null}}\n';
  fs.writeFileSync(local, before);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'ops',
      },
    ],
  });
  expect(plan.targets[0].after).toContain('// keep this comment');
  expect(plan.effective[0].values.channel).toBe('ops');
  expect(plan.scope.repositoryWide).toBe(false);
  expect(fs.readFileSync(local, 'utf8')).toBe(before);
});

test('authoring applies a complete multi-target plan and advances its own preconditions', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' });
  saveRegistry(f, reg);
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'one' }),
      },
      {
        project: '@example/app',
        domain: 'other',
        operation: 'create',
        document: { ...doc({ channel: 'two' }), domain: 'other' },
      },
    ],
  };
  const plan = await f.client.previewEdits(request);
  const result = await f.client.applyEdits(plan);
  expect(result.status).toBe('success');
  expect(result.effects.applied).toHaveLength(2);
  expect(result.effects.unattempted).toHaveLength(0);
  expect((await f.client.get({ project: '@example/app', domain: 'other' })).values.channel).toBe(
    'two',
  );
  expect((await f.client.editStatus(result.operationId)).targets.map((t) => t.observed)).toEqual([
    'candidate',
    'candidate',
  ]);
  await expect(f.client.applyEdits(plan)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'STALE_PREVIEW' })],
  });
});

test('authoring CLI produces a typed preview then applies its saved plan', () => {
  const f = fixture();
  const bin = path.resolve(import.meta.dirname, '../dist/cli.js');
  const planFile = path.join(f.root, 'plan.json');
  const preview = spawnSync(
    process.execPath,
    [
      bin,
      'set',
      '--root',
      f.root,
      '--project',
      '@example/app',
      '--domain',
      'tool',
      '--pointer',
      '/channel',
      '--value',
      'null',
      '--result-file',
      planFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(preview.status).toBe(0);
  const plan = JSON.parse(preview.stdout).data;
  expect(plan.effective[0].values.channel).toBeNull();
  const applied = spawnSync(
    process.execPath,
    [bin, 'apply', '--root', f.root, '--plan-file', planFile, '--json'],
    { encoding: 'utf8' },
  );
  expect(applied.status).toBe(0);
  expect(JSON.parse(applied.stdout).status).toBe('success');
});

test('authoring preflight rejects invalid batch members and permits isolated repair', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' });
  saveRegistry(f, reg);
  f.put('apps/app/config/tool.json', doc({ channel: 123 }));
  const before = fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'repair',
        },
        {
          project: '@example/app',
          domain: 'other',
          operation: 'create',
          document: { ...doc({ channel: 123 }), domain: 'other' },
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_INVALID' })]),
  });
  expect(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'))).toEqual(before);
  expect(fs.existsSync(path.join(f.root, 'apps/app/config/other.json'))).toBe(false);
  reg.domains[1].required = true;
  saveRegistry(f, reg);
  const repaired = await f.client.applyEdits(
    await f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'repair',
        },
      ],
    }),
  );
  expect(repaired.status).toBe('success');
  expect(repaired.scope.repositoryWide).toBe(false);
  expect(
    repaired.unrelated.diagnostics.some((item) => item.code === 'REQUIRED_DOMAIN_MISSING'),
  ).toBe(true);
  expect((await f.client.validate()).valid).toBe(false);
});

test('authoring rejects stale or tampered plans before changing destination bytes', async () => {
  const f = fixture();
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
    ],
  };
  const plan = await f.client.previewEdits(request);
  const tampered = structuredClone(plan);
  tampered.targets[0].after = 'tampered';
  await expect(f.client.applyEdits(tampered)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'STALE_PREVIEW' })],
  });
  f.put('common/config/rush/pnpm-lock.yaml', { changed: true });
  await expect(f.client.applyEdits(plan)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'STALE_PREVIEW' })],
  });
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
});

test('authoring preserves ordinary null, inherited suppression and existing file mode', async () => {
  const f = fixture();
  f.put('apps/app/config/base.json', doc({ channel: 'parent', addons: ['base'] }));
  f.put('apps/app/config/tool.json', doc({ channel: null }, { extends: './base.json' }));
  const file = path.join(f.root, 'apps/app/config/tool.json');
  fs.chmodSync(file, 0o640);
  const make = (edit) =>
    f.client.previewEdits({
      requestVersion: 1,
      edits: [{ project: '@example/app', domain: 'tool', ...edit }],
    });
  await f.client.applyEdits(await make({ operation: 'suppress', pointer: '/addons' }));
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).suppressed['/addons'],
  ).toBeDefined();
  await f.client.applyEdits(await make({ operation: 'remove-suppression', pointer: '/addons' }));
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values.addons).toEqual([
    'base',
  ]);
  await f.client.applyEdits(await make({ operation: 'unset', pointer: '/channel' }));
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel).toBe(
    'parent',
  );
  const noChange = await make({ operation: 'unset', pointer: '/channel' });
  expect(noChange.targets[0].changed).toBe(false);
  expect(noChange.targets[0].notes[0]).toContain('No local assignment');
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
});

test('authoring ignores unrelated configuration changes but not required input changes', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'config/other.json' });
  saveRegistry(f, reg);
  f.put('apps/app/config/other.json', { ...doc({ channel: 5 }), domain: 'other' });
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'repair',
      },
    ],
  });
  expect(plan.unrelated.diagnostics.length).toBeGreaterThan(0);
  f.put('apps/app/config/other.json', { ...doc({ channel: 'fixed separately' }), domain: 'other' });
  expect((await f.client.applyEdits(plan)).status).toBe('success');
});

test('authoring writer lock refuses a second process without changing files', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'changed',
      },
    ],
  });
  f.put('common/temp/config-rush-authoring/writer.lock', {
    operationId: 'other',
    ownerPid: process.pid,
  });
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const child = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      planFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(3);
  expect(JSON.parse(child.stdout).diagnostics[0].code).toBe('WRITER_BUSY');
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
});

test('authoring publication failure after writes reports partial effects', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'changed',
      },
    ],
  });
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const child = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      planFile,
      '--result-file',
      path.join(f.root, 'missing/result.json'),
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(4);
  const result = JSON.parse(child.stdout);
  expect(result.status).toBe('partial');
  expect(result.effects.applied).toHaveLength(1);
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel).toBe(
    'changed',
  );
});

test('authoring detects late staleness and reports applied failed and unattempted targets', async () => {
  const f = fixture(),
    reg = registry(f);
  for (const name of ['a', 'b']) {
    reg.domains.push({ ...reg.domains[0], name, projectFile: `config/${name}.json` });
    f.put(`apps/app/config/${name}.json`, { ...doc({ channel: null }), domain: name });
  }
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: ['a', 'b', 'tool'].map((domain) => ({
      project: '@example/app',
      domain,
      operation: 'set',
      pointer: '/channel',
      value: 'changed',
    })),
  });
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const hook = path.join(f.root, 'late-change.mjs');
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const result=rename(a,b);if(b===${JSON.stringify(path.join(f.root, 'apps/app/config/a.json'))})fs.appendFileSync(${JSON.stringify(path.join(f.root, 'schemas/effective.json'))},' ');return result;};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      planFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(4);
  const result = JSON.parse(child.stdout);
  expect(result.effects.applied).toHaveLength(1);
  expect(result.effects.failed).toHaveLength(1);
  expect(result.effects.unattempted).toHaveLength(1);
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/b.json'), 'utf8')).values.channel,
  ).toBeNull();
});

test('authoring abrupt post-rename termination leaves recoverable unknown state without payloads', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new-channel-private-payload',
      },
    ],
  });
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const hook = path.join(f.root, 'crash.mjs');
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const result=rename(a,b);if(b===${JSON.stringify(path.join(f.root, 'apps/app/config/tool.json'))})process.kill(process.pid,'SIGKILL');return result;};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      planFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.signal).toBe('SIGKILL');
  const storage = path.join(f.root, 'common/temp/config-rush-authoring');
  const journalName = fs.readdirSync(storage).find((name) => name.endsWith('.json'));
  const journal = fs.readFileSync(path.join(storage, journalName), 'utf8');
  expect(journal).not.toContain('new-channel-private-payload');
  const status = await f.client.editStatus(journalName.slice(0, -5));
  expect(status.effects.unknown).toHaveLength(1);
  expect(status.targets[0].observed).toBe('candidate');
  expect(status.lock.ownerAlive).toBe(false);
  expect(status.targets[0].state).toBe('writing');
});

test('authoring live cooperating processes serialize without waiting indefinitely', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'serialized',
      },
    ],
  });
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const marker = path.join(f.root, 'writer-entered'),
    release = path.join(f.root, 'writer-release');
  const hook = path.join(f.root, 'hold.mjs');
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===${JSON.stringify(path.join(f.root, 'apps/app/config/tool.json'))}){fs.writeFileSync(${JSON.stringify(marker)},'ready');const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('fixture timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return rename(a,b);};`,
  );
  const args = [
    path.resolve(import.meta.dirname, '../dist/cli.js'),
    'apply',
    '--root',
    f.root,
    '--plan-file',
    planFile,
    '--json',
  ];
  const child = spawn(process.execPath, ['--import', hook, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const ended = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    const end = Date.now() + 10000;
    while (!fs.existsSync(marker)) {
      if (Date.now() > end) throw new Error('Writer did not reach filesystem boundary');
      // eslint-disable-next-line no-await-in-loop -- Synchronize with the real held writer before launching its competitor.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(second.status).toBe(3);
    expect(JSON.parse(second.stdout).diagnostics[0].code).toBe('WRITER_BUSY');
  } finally {
    fs.writeFileSync(release, 'go');
  }
  expect(await ended).toEqual({ code: 0, signal: null });
});

test('authoring post-rename reporting errors preserve unknown effects', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'written',
      },
    ],
  });
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const hook = path.join(f.root, 'after-rename.mjs');
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const value=rename(a,b);if(b===${JSON.stringify(path.join(f.root, 'apps/app/config/tool.json'))})throw Error('post-rename injected failure');return value;};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      planFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(4);
  const result = JSON.parse(child.stdout);
  expect(result.effects.unknown).toHaveLength(1);
  expect(result.effects.failed).toHaveLength(0);
  expect((await f.client.editStatus(result.data.operationId)).targets[0].observed).toBe(
    'candidate',
  );
});

test('authoring refuses shared parents', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/other', projectFolder: 'apps/other' },
    ],
  });
  f.put('apps/other/package.json', { name: '@example/other' });
  f.put('apps/other/config/tool.json', doc({}, { extends: '../../app/config/tool.json' }));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'shared',
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SHARED_SOURCE_EDIT' })],
  });
});

test('authoring creates nested destinations and preserves its own new-directory state', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].projectFile = 'generated/deep/tool.json';
  reg.domains.push({ ...reg.domains[0], name: 'other', projectFile: 'generated/deep/other.json' });
  saveRegistry(f, reg);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: ['tool', 'other'].map((domain) => ({
      project: '@example/app',
      domain,
      operation: 'create',
      document: { ...doc({ channel: 'created' }), domain },
    })),
  });
  expect((await f.client.applyEdits(plan)).effects.applied).toHaveLength(2);
});

test('authoring refuses edits inside discovered rig packages even with local consumer overrides', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: 'example-rig', projectFolder: 'rigs/example-rig' },
    ],
  });
  f.put('rigs/example-rig/package.json', { name: 'example-rig', version: '1.0.0' });
  f.put('rigs/example-rig/profiles/default/config/tool.json', doc({ channel: 'rig' }));
  f.put('apps/app/config/rig.json', { rigPackageName: 'example-rig' });
  fs.mkdirSync(path.join(f.root, 'apps/app/node_modules'), { recursive: true });
  fs.symlinkSync(
    path.join(f.root, 'rigs/example-rig'),
    path.join(f.root, 'apps/app/node_modules/example-rig'),
  );
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: 'example-rig',
          domain: 'tool',
          operation: 'create',
          document: doc({ channel: 'not-authorized' }),
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SHARED_SOURCE_EDIT' })],
  });
});

test('authoring unset suppress and remove-suppression preserve inheritance distinctions', async () => {
  const f = fixture();
  f.put('apps/app/config/base.json', doc({ channel: 'inherited', addons: ['base'] }));
  f.put('apps/app/config/tool.json', doc({ channel: 'local' }, { extends: './base.json' }));
  const edit = async (operation, pointer) => {
    const plan = await f.client.previewEdits({
      requestVersion: 1,
      edits: [{ project: '@example/app', domain: 'tool', operation, pointer }],
    });
    expect((await f.client.applyEdits(plan)).status).toBe('success');
    return f.client.get({ project: '@example/app', domain: 'tool' });
  };
  expect((await edit('unset', '/channel')).values.channel).toBe('inherited');
  const suppressed = await edit('suppress', '/addons');
  expect(suppressed.values.addons).toBeUndefined();
  expect(suppressed.suppressed['/addons']).toBeDefined();
  expect((await edit('remove-suppression', '/addons')).values.addons).toEqual(['base']);
  await expect(edit('suppress', '/channel')).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_INVALID' })],
  });
});

test('authoring versions are explicit and array edits remain JSON-typed', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['2.0.0'] = { ...reg.domains[0].versions['1.0.0'] };
  saveRegistry(f, reg);
  f.put('apps/app/config/tool.json', doc({ channel: null, addons: ['one', 'two'] }));
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set-version',
        contractVersion: '2.0.0',
      },
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/addons/1',
        value: 'changed',
      },
    ],
  });
  expect(JSON.parse(plan.targets[0].after).contractVersion).toBe('2.0.0');
  expect(plan.effective[0].values.addons).toEqual(['one', 'changed']);
  expect((await f.client.applyEdits(plan)).status).toBe('success');
});

test('candidate previews validate unwritten documents at their real project paths', async () => {
  const f = fixture();
  const target = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(target);
  const preview = await f.client.previewCandidates({
    documents: [
      {
        project: '@example/app',
        domain: 'tool',
        contents: JSON.stringify(doc({ channel: 'candidate' })),
      },
    ],
  });
  expect(preview.results[0].values).toEqual({ channel: 'candidate' });
  expect(preview.results[0].provenance['/channel'].source).toBe(target);
  expect(fs.existsSync(target)).toBe(false);
  expect(preview.inputs.some((input) => input.path === target && input.kind === 'missing')).toBe(
    true,
  );
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool', optional: true })).absent,
  ).toBe(true);
});

test('candidate sets compose together without writes and isolate concurrent previews', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/other', projectFolder: 'apps/other' },
    ],
  });
  f.put('apps/other/package.json', { name: '@example/other' });
  const original = fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'));
  const request = (channel) => ({
    documents: [
      { project: '@example/app', domain: 'tool', contents: JSON.stringify(doc({ channel })) },
      {
        project: '@example/other',
        domain: 'tool',
        contents: JSON.stringify(doc({}, { extends: '../../app/config/tool.json' })),
      },
    ],
  });
  const [left, right] = await Promise.all([
    f.client.previewCandidates(request('left')),
    f.client.previewCandidates(request('right')),
  ]);
  expect(left.results.map((v) => v.values.channel)).toEqual(['left', 'left']);
  expect(right.results.map((v) => v.values.channel)).toEqual(['right', 'right']);
  expect(left.inputFingerprint).toBe(right.inputFingerprint);
  expect(left.candidateFingerprint).not.toBe(right.candidateFingerprint);
  expect(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'))).toEqual(original);
  expect(fs.existsSync(path.join(f.root, 'apps/other/config'))).toBe(false);
});

test('candidate observations cover schemas and confirmed lockfile absence', async () => {
  const f = fixture();
  const request = {
    documents: [
      {
        project: '@example/app',
        domain: 'tool',
        contents: JSON.stringify(doc({ channel: 'candidate' })),
      },
    ],
  };
  const before = await f.client.previewCandidates(request);
  expect(before.inputs.some((v) => v.path.endsWith('schemas/effective.json') && v.sha256)).toBe(
    true,
  );
  expect(
    before.inputs.some(
      (v) => v.path.endsWith('common/config/rush/pnpm-lock.yaml') && v.kind === 'missing',
    ),
  ).toBe(true);
  f.put('common/config/rush/pnpm-lock.yaml', { test: 'changed' });
  const after = await f.client.previewCandidates(request);
  expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
});

test('invalid candidates and symlinked destinations fail without writing', async () => {
  const f = fixture();
  const original = fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'));
  await expect(
    f.client.previewCandidates({
      documents: [
        { project: '@example/app', domain: 'tool', contents: JSON.stringify(doc({ channel: 12 })) },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_INVALID' })]),
  });
  expect(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'))).toEqual(original);
  fs.renameSync(path.join(f.root, 'apps/app/config'), path.join(f.root, 'apps/app/real-config'));
  fs.symlinkSync('real-config', path.join(f.root, 'apps/app/config'));
  await expect(
    f.client.previewCandidates({
      documents: [
        {
          project: '@example/app',
          domain: 'tool',
          contents: JSON.stringify(doc({ channel: 'new' })),
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'CANDIDATE_SYMLINK' })],
  });
});

test('candidate fingerprints cover admitted validator package content', async () => {
  const f = fixture();
  admitCheck(f, 'export function validate(){return []}');
  f.put('common/autoinstallers/rush-plugins/node_modules/example-checks/helper.json', {
    rule: 'one',
  });
  const request = {
    documents: [
      {
        project: '@example/app',
        domain: 'tool',
        contents: JSON.stringify(doc({ channel: 'candidate' })),
      },
    ],
  };
  const result = await f.client.previewCandidates(request);
  expect(
    result.inputs.some((v) => v.path.endsWith('/example-checks/helper.json') && v.sha256),
  ).toBe(true);
});

test('candidate previews detect a schema changed while an admitted check is running', async () => {
  const f = fixture();
  admitCheck(
    f,
    `let enter;export const started=new Promise(r=>enter=r);let resume;export function release(){resume()}export async function validate(){enter();await new Promise(r=>resume=r);return []}`,
  );
  const gate = await import(
    path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks/check.mjs')
  );
  const pending = f.client.previewCandidates({
    documents: [
      {
        project: '@example/app',
        domain: 'tool',
        contents: JSON.stringify(doc({ channel: 'candidate' })),
      },
    ],
  });
  await gate.started;
  f.put('schemas/effective.json', {
    type: 'object',
    properties: { channel: { type: 'string' } },
    additionalProperties: false,
  });
  gate.release();
  await expect(pending).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'INPUT_CHANGED' })],
  });
});

test('candidate paths use consuming projects and the declared in-memory file set', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  const result = await f.client.previewCandidates({
    documents: [
      {
        project: '@example/app',
        domain: 'tool',
        contents: JSON.stringify(doc({ channel: 'config/tool.json' })),
      },
    ],
  });
  expect(result.results[0].paths['/channel']).toMatchObject({
    resolved: path.join(f.root, 'apps/app/config/tool.json'),
    exists: true,
    kind: 'file',
  });
  expect(fs.existsSync(path.join(f.root, 'apps/app/config/tool.json'))).toBe(false);
  expect(
    await Effect.runPromise(
      f.client.previewCandidatesEffect({
        documents: [
          {
            project: '@example/app',
            domain: 'tool',
            contents: JSON.stringify(doc({ channel: 'config/tool.json' })),
          },
        ],
      }),
    ),
  ).toEqual(result);
});

test('candidate requests reject malformed JSONC, duplicate targets and identity destinations', async () => {
  const f = fixture();
  const item = {
    project: '@example/app',
    domain: 'tool',
    contents:
      '{"formatVersion":1,"domain":"tool","contractVersion":"1.0.0","values":{"channel":null,"channel":"duplicate"}}',
  };
  await expect(f.client.previewCandidates({ documents: [item] })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'DUPLICATE_KEY' })],
  });
  item.contents = JSON.stringify(doc({ channel: null }));
  await expect(f.client.previewCandidates({ documents: [item, item] })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'DUPLICATE_TARGET' })],
  });
  const reg = registry(f);
  reg.domains[0].projectFile = 'package.json';
  saveRegistry(f, reg);
  await expect(f.client.previewCandidates({ documents: [item] })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'CANDIDATE_PATH' })],
  });
});

test('changed admitted code cannot be silently validated using a cached module', async () => {
  const f = fixture();
  admitCheck(f, 'export function validate(){return []}');
  const request = {
    documents: [
      {
        project: '@example/app',
        domain: 'tool',
        contents: JSON.stringify(doc({ channel: 'candidate' })),
      },
    ],
  };
  await f.client.previewCandidates(request);
  admitCheck(f, 'export function validate(){return [{code:"NOW_INVALID",message:"changed"}]}');
  await expect(f.client.previewCandidates(request)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_PACKAGE_CHANGED' })],
  });
});

test('candidate files cannot also serve as directories for another target', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({
    ...reg.domains[0],
    name: 'z-other',
    projectFile: 'config/tool.json/child.json',
  });
  saveRegistry(f, reg);
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  await expect(
    f.client.previewCandidates({
      documents: [
        {
          project: '@example/app',
          domain: 'tool',
          contents: JSON.stringify(doc({ channel: null })),
        },
        {
          project: '@example/app',
          domain: 'z-other',
          contents: JSON.stringify({ ...doc({ channel: null }), domain: 'z-other' }),
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'CANDIDATE_CONFLICT' })],
  });
});

test('predicate-only nested properties must have a closed schema', async () => {
  const f = fixture();
  const reg = registry(f);
  delete reg.domains[0].versions['1.0.0'].fragmentSchema;
  saveRegistry(f, reg);
  const schema = JSON.parse(
    '{"type":"object","if":{"properties":{"payload":{"type":"object"}}},"then":{"type":"object"},"unevaluatedProperties":false}',
  );
  f.put('schemas/effective.json', schema);
  f.put('apps/app/config/tool.json', doc({ payload: { typo: 1 } }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_POSTURE', pointer: '/payload' })],
  });
  schema.else = false;
  schema.if.properties.payload = {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    additionalProperties: false,
  };
  f.put('schemas/effective.json', schema);
  f.put('apps/app/config/tool.json', doc({ payload: { enabled: true } }));
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values).toEqual({
    payload: { enabled: true },
  });
});

test.each(['local', 'local-with-rig', 'rig'])(
  'unreadable discovery is never optional absence or fallback: %s',
  async (location) => {
    const f = fixture(),
      reg = registry(f);
    reg.domains[0].projectFile = 'config/private/tool.json';
    saveRegistry(f, reg);
    const rigFile = 'apps/app/node_modules/example-rig/profiles/default/config/private/tool.json';
    if (location !== 'local') {
      f.put('apps/app/node_modules/example-rig/package.json', {
        name: 'example-rig',
        version: '1.0.0',
      });
      f.put(rigFile, doc({ channel: 'rig' }));
      f.put('apps/app/config/rig.json', { rigPackageName: 'example-rig' });
    }
    const selected = location === 'rig' ? rigFile : 'apps/app/config/private/tool.json';
    f.put(selected, doc({ channel: 'private' }));
    const directory = path.dirname(path.join(f.root, selected));
    denyAccess(directory);
    try {
      const q = { project: '@example/app', domain: 'tool', optional: true };
      await expect(f.client.get(q)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ kind: 'execution', code: 'INTERNAL' })],
      });
      const explained = await f.client.explain(q);
      expect(explained.valid).toBe(false);
      expect(explained.diagnostics[0].kind).toBe('execution');
      const checked = await f.client.validate();
      expect(checked.valid).toBe(false);
      expect(checked.diagnostics[0].kind).toBe('execution');
      for (const operation of ['get', 'explain', 'validate']) {
        const argv = [
          path.resolve(import.meta.dirname, '../dist/cli.js'),
          operation,
          '--root',
          f.root,
          '--project',
          q.project,
          '--domain',
          q.domain,
          '--json',
        ];
        if (operation !== 'validate') argv.push('--optional');
        const child = spawnSync(process.execPath, argv, { encoding: 'utf8' });
        expect(child.status).toBe(1);
        expect(JSON.parse(child.stdout).status).toBe('failure');
      }
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  },
);

test.each(['get', 'explain', 'validate'])(
  'unknown identities have no evaluated coverage in %s',
  async (operation) => {
    const f = fixture();
    const targets = [
      ['unknown', 'tool'],
      ['@example/app', 'unknown'],
    ];
    if (operation === 'explain') {
      const results = await Promise.all(
        targets.map(([project, domain]) => f.client.explain({ project, domain })),
      );
      for (const result of results) expect(result.evaluated).toEqual([]);
    }
    for (const [project, domain] of targets) {
      const child = spawnSync(
        process.execPath,
        [
          path.resolve(import.meta.dirname, '../dist/cli.js'),
          operation,
          '--root',
          f.root,
          '--project',
          project,
          '--domain',
          domain,
          '--json',
        ],
        { encoding: 'utf8' },
      );
      expect(child.status).toBe(2);
      const result = JSON.parse(child.stdout);
      expect(result.scope.evaluated).toEqual([]);
      expect(result.scope.repositoryWide).toBe(false);
    }
    if (operation === 'explain') {
      f.put('apps/app/config/tool.json', doc({ channel: 42 }));
      const result = await f.client.explain({ project: '@example/app', domain: 'tool' });
      expect(result.valid).toBe(false);
      expect(result.evaluated).toEqual([{ project: '@example/app', domain: 'tool' }]);
    }
  },
);

test('conditional closure inspects else fields without imposing the true predicate', async () => {
  const f = fixture(),
    reg = registry(f);
  delete reg.domains[0].versions['1.0.0'].fragmentSchema;
  saveRegistry(f, reg);
  const schema = JSON.parse(
    '{"type":"object","if":{"properties":{"payload":{"type":"string"}},"required":["payload"]},"then":{"type":"object"},"else":{"properties":{"payload":{"type":"object","properties":{"enabled":{"type":"boolean"}},"additionalProperties":false}}},"unevaluatedProperties":false}',
  );
  f.put('schemas/effective.json', schema);
  f.put('apps/app/config/tool.json', doc({ payload: { enabled: true } }));
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values.payload).toEqual({
    enabled: true,
  });
  f.put('apps/app/config/tool.json', doc({ payload: { typo: true } }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_INVALID' })]),
  });
});

test('failed predicates cannot authorize unchecked nested properties', async () => {
  const f = fixture(),
    reg = registry(f);
  delete reg.domains[0].versions['1.0.0'].fragmentSchema;
  saveRegistry(f, reg);
  const schema = JSON.parse(
    '{"type":"object","if":{"properties":{"payload":{"type":"object","properties":{"enabled":{"type":"boolean"}},"additionalProperties":false}}},"then":{"type":"object"},"unevaluatedProperties":false}',
  );
  f.put('schemas/effective.json', schema);
  f.put('apps/app/config/tool.json', doc({ payload: { typo: true } }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_POSTURE', pointer: '/payload' })],
  });
});

test('validator package name must match admission before loading code', async () => {
  const f = fixture();
  const marker = path.join(f.root, 'must-not-run');
  admitCheck(
    f,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)}, 'ran');export function validate(){return []}`,
  );
  f.put('common/autoinstallers/rush-plugins/node_modules/example-checks/package.json', {
    name: 'different-checks',
    version: '1.0.0',
    type: 'module',
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_FAILURE' })],
  });
  expect(fs.existsSync(marker)).toBe(false);
});

test('merging a sibling preserves suppression until that field is reassigned', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['1.0.0'].merge = { '/options': 'merge' };
  saveRegistry(f, reg);
  f.put('apps/app/config/base.json', doc({ channel: null, options: { channel: 'ops' } }));
  f.put(
    'apps/app/config/parent.json',
    doc({}, { extends: './base.json', suppress: ['/options/channel'] }),
  );
  f.put(
    'apps/app/config/tool.json',
    doc({ options: { enabled: true } }, { extends: './parent.json' }),
  );
  const result = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(result.values.options).toEqual({ enabled: true });
  expect(result.suppressed['/options/channel'].source).toMatch(/parent.json$/);
  f.put(
    'apps/app/config/tool.json',
    doc({ options: { channel: null } }, { extends: './parent.json' }),
  );
  const restored = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(restored.values.options.channel).toBeNull();
  expect(restored.suppressed['/options/channel']).toBeUndefined();
});

test.each([[[]], [['--project', '@example/app']], [['--project', 'unknown']]])(
  'CLI scope separates requested filters and evaluated coverage: %j',
  (filters) => {
    const f = fixture();
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../dist/cli.js'),
        'validate',
        '--root',
        f.root,
        '--json',
        ...filters,
      ],
      { encoding: 'utf8' },
    );
    const envelope = JSON.parse(result.stdout);
    const unknown = filters.includes('unknown');
    expect(result.status).toBe(unknown ? 2 : 0);
    expect(envelope.scope.requested).toEqual({
      projects: filters.length ? [filters[1]] : [],
      domains: [],
    });
    expect(envelope.scope.evaluated).toEqual(
      unknown ? [] : [{ project: '@example/app', domain: 'tool' }],
    );
    expect(envelope.scope.repositoryWide).toBe(filters.length === 0);
  },
);

test.each(['read', 'realpath'])(
  'filesystem permission failures retain execution classification: %s',
  async (boundary) => {
    const f = fixture();
    const target = path.join(
      f.root,
      boundary === 'read'
        ? 'common/config/rush-plugins/config-rush-plugin.json'
        : 'schemas/effective.json',
    );
    if (boundary === 'read') denyAccess(target);
    else fs.chmodSync(target, 0o600);
    if (boundary === 'realpath') denyAccess(path.dirname(target));
    try {
      await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject(
        {
          diagnostics: [expect.objectContaining({ kind: 'execution', code: 'INTERNAL' })],
        },
      );
      const child = spawnSync(
        process.execPath,
        [
          path.resolve(import.meta.dirname, '../dist/cli.js'),
          'get',
          '--root',
          f.root,
          '--project',
          '@example/app',
          '--domain',
          'tool',
          '--json',
        ],
        { encoding: 'utf8' },
      );
      expect(child.status).toBe(1);
      expect(JSON.parse(child.stdout).diagnostics[0].kind).toBe('execution');
    } finally {
      if (boundary === 'realpath') fs.chmodSync(path.dirname(target), 0o700);
      fs.chmodSync(target, 0o600);
    }
  },
);

test('declared inherited paths use the consuming project, not the parent or cwd', async () => {
  const f = fixture();
  const props = { channel: { type: ['string', 'null'] }, docs: { type: 'string' } };
  f.put('schemas/effective.json', {
    type: 'object',
    properties: props,
    required: ['docs'],
    additionalProperties: false,
  });
  f.put('schemas/fragment.json', {
    type: 'object',
    properties: props,
    additionalProperties: false,
  });
  const reg = registry(f);
  reg.domains[0].versions['1.0.0'].paths = {
    '/docs': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  f.put('common/base.json', doc({ docs: 'docs', channel: 'parent' }));
  f.put('apps/app/docs/index.json', {});
  f.put('apps/app/config/tool.json', doc({}, { extends: '../../../common/base.json' }));
  const result = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(result.values.docs).toBe('docs');
  expect(result.paths['/docs']).toMatchObject({
    authored: 'docs',
    resolved: path.join(f.root, 'apps/app/docs'),
    base: 'project',
    exists: true,
    source: path.join(f.root, 'common/base.json'),
  });
  const child = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'get',
      '--root',
      f.root,
      '--project',
      '@example/app',
      '--domain',
      'tool',
      '--json',
    ],
    { cwd: '/', encoding: 'utf8' },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).data.paths).toEqual(result.paths);
});

test('project-owned fields cannot be satisfied solely by an inherited assignment', async () => {
  const f = fixture();
  const reg = registry(f);
  reg.domains[0].versions['1.0.0'].projectOwned = ['/channel'];
  saveRegistry(f, reg);
  f.put('common/base.json', doc({ channel: 'shared' }));
  f.put('apps/app/config/tool.json', doc({}, { extends: '../../../common/base.json' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'PROJECT_OWNED_REQUIRED', pointer: '/channel' })],
  });
  f.put(
    'apps/app/config/tool.json',
    doc({ channel: 'shared' }, { extends: '../../../common/base.json' }),
  );
  const value = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(value.provenance['/channel'].authoredLocally).toBe(true);
});

test('admitted async semantic validators receive immutable values and declared resource inspection', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.packages = { 'example-checks': '1.0.0' };
  reg.validators = {
    'channel-check': {
      module: 'package:example-checks/check.mjs',
      export: 'validate',
      scope: 'project',
      inputs: {
        docs: {
          base: 'project',
          path: 'docs',
          allowedRoots: [{ base: 'project', path: '.' }],
          mustExist: true,
          symlinks: 'reject',
        },
      },
    },
  };
  reg.domains[0].versions['1.0.0'].validators = ['channel-check'];
  saveRegistry(f, reg);
  f.put('common/autoinstallers/rush-plugins/node_modules/example-checks/package.json', {
    name: 'example-checks',
    version: '1.0.0',
    type: 'module',
  });
  fs.writeFileSync(
    path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks/check.mjs'),
    `export async function validate(context) {
    if (!Object.isFrozen(context.values) || !Object.isFrozen(context.project)) throw Error('mutable');
    if (context.inspect('docs').kind !== 'directory') throw Error('wrong resource');
    await Promise.resolve();
    return context.values.channel === null ? [{code:'CHANNEL_REQUIRED',message:'Select a channel',pointer:'/channel',severity:'error'}] : [];
  }`,
  );
  f.put('apps/app/docs/index.json', {});
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({
        code: 'CHANNEL_REQUIRED',
        validator: 'channel-check',
        project: '@example/app',
        contractVersion: '1.0.0',
      }),
    ],
  });
  f.put('apps/app/config/tool.json', doc({ channel: 'local' }));
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).checks).toEqual([
    expect.objectContaining({ validator: 'channel-check', status: 'passed' }),
  ]);
});

function admitCheck(f, body, inputs = {}) {
  const reg = registry(f);
  reg.packages = { 'example-checks': '1.0.0' };
  reg.validators = {
    check: {
      module: 'package:example-checks/check.mjs',
      export: 'validate',
      scope: 'project',
      inputs,
    },
  };
  reg.domains[0].versions['1.0.0'].validators = ['check'];
  saveRegistry(f, reg);
  f.put('common/autoinstallers/rush-plugins/node_modules/example-checks/package.json', {
    name: 'example-checks',
    version: '1.0.0',
    type: 'module',
  });
  fs.writeFileSync(
    path.join(f.root, 'common/autoinstallers/rush-plugins/node_modules/example-checks/check.mjs'),
    body,
  );
}

test('semantic rejection aggregates independent targets and warnings do not become errors', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  f.put('apps/second/config/tool.json', doc({ channel: null }));
  admitCheck(
    f,
    `export async function validate(c){if(c.project.name==='@example/app')throw Error('private payload');return [{code:'ADVICE',message:'Consider a channel',severity:'warning'}]}`,
  );
  const report = await f.client.validate();
  expect(report.valid).toBe(false);
  expect(report.diagnostics.map((d) => d.code)).toEqual(['VALIDATOR_FAILURE', 'ADVICE']);
  expect(JSON.stringify(report)).not.toContain('private payload');
  const q = { project: '@example/second', domain: 'tool' };
  const value = await f.client.get(q);
  expect(value.diagnostics[0].severity).toBe('warning');
  expect(await Effect.runPromise(f.client.getEffect(q))).toEqual(value);
  expect((await f.client.validate({ projects: ['@example/second'] })).valid).toBe(true);
  expect((await f.client.explain(q)).diagnostics[0].severity).toBe('warning');
});

test('invalid structural input skips validator import and reports incomplete checks', async () => {
  const f = fixture(),
    marker = path.join(f.root, 'must-not-exist');
  admitCheck(
    f,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');export const validate=()=>[];`,
  );
  f.put('apps/app/config/tool.json', doc({ channel: 42 }));
  const result = await f.client.explain({ project: '@example/app', domain: 'tool' });
  expect(result.valid).toBe(false);
  expect(result.result).toBeNull();
  expect(result.checks).toEqual([
    expect.objectContaining({ status: 'skipped', validator: 'check' }),
  ]);
  expect(result.diagnostics.map((d) => d.code)).toEqual(['SCHEMA_INVALID', 'VALIDATOR_SKIPPED']);
  expect(fs.existsSync(marker)).toBe(false);
});

test.each([`c.values.channel='changed';`, `c.inspect('undeclared');`])(
  'validator capability denial: %s',
  async (operation) => {
    const f = fixture();
    admitCheck(f, `export function validate(c){${operation}return []}`);
    const file = path.join(f.root, 'apps/app/config/tool.json'),
      before = fs.readFileSync(file);
    await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'VALIDATOR_FAILURE' })],
    });
    expect(fs.readFileSync(file)).toEqual(before);
  },
);

test('schema-only configuration never loads merely available validator code', async () => {
  const f = fixture(),
    marker = path.join(f.root, 'must-not-run');
  admitCheck(
    f,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');export const validate=()=>[];`,
  );
  const reg = registry(f);
  delete reg.domains[0].versions['1.0.0'].validators;
  saveRegistry(f, reg);
  await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(fs.existsSync(marker)).toBe(false);
});

test('validator package mismatches are rejected before code loads', async () => {
  const f = fixture(),
    marker = path.join(f.root, 'must-not-run');
  admitCheck(
    f,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');export const validate=()=>[];`,
  );
  f.put('common/autoinstallers/rush-plugins/node_modules/example-checks/package.json', {
    name: 'example-checks',
    version: '2.0.0',
    type: 'module',
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_FAILURE' })],
  });
  expect(fs.existsSync(marker)).toBe(false);
});

test('missing declared validator inputs skip code loading and fail validation', async () => {
  const f = fixture(),
    marker = path.join(f.root, 'must-not-run');
  admitCheck(
    f,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');export const validate=()=>[];`,
    {
      docs: {
        base: 'project',
        path: 'missing',
        allowedRoots: [{ base: 'project', path: '.' }],
        mustExist: true,
        symlinks: 'reject',
      },
    },
  );
  const report = await f.client.explain({ project: '@example/app', domain: 'tool' });
  expect(report.valid).toBe(false);
  expect(report.checks[0].status).toBe('skipped');
  expect(fs.existsSync(marker)).toBe(false);
});

test('registration rejects an open schema even when this particular document has no typos', async () => {
  const f = fixture();
  f.put('schemas/effective.json', {
    type: 'object',
    properties: { channel: { type: ['string', 'null'] } },
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_POSTURE' })],
  });
});

test('conditional effective requirements are evaluated after explicit fragment composition', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['1.0.0'].resources = ['schemas/fields.json'];
  saveRegistry(f, reg);
  f.put('schemas/fields.json', {
    $id: 'urn:test:fields',
    type: 'object',
    properties: { mode: { enum: ['on', 'off'] }, channel: { type: ['string', 'null'] } },
  });
  f.put('schemas/fragment.json', {
    type: 'object',
    allOf: [{ $ref: 'urn:test:fields' }],
    unevaluatedProperties: false,
  });
  f.put(
    'schemas/effective.json',
    JSON.parse(
      '{"type":"object","allOf":[{"$ref":"urn:test:fields"},{"if":{"properties":{"mode":{"const":"on"}},"required":["mode"]},"then":{"required":["channel"]}}],"required":["mode"],"unevaluatedProperties":false}',
    ),
  );
  f.put('common/base.json', doc({ mode: 'on' }));
  f.put(
    'apps/app/config/tool.json',
    doc({ channel: null }, { extends: '../../../common/base.json' }),
  );
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values).toEqual({
    mode: 'on',
    channel: null,
  });
  f.put('apps/app/config/tool.json', doc({}, { extends: '../../../common/base.json' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_INVALID' })]),
  });
  f.put(
    'apps/app/config/tool.json',
    doc({ channel: 'local' }, { extends: '../../../common/base.json' }),
  );
  f.put('common/base.json', doc({ mode: 'on', channeel: 'typo' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        code: 'SCHEMA_INVALID',
        file: path.join(f.root, 'common/base.json'),
      }),
    ]),
  });
});

test('closed top-level schema cannot hide an open nested union branch', async () => {
  const f = fixture();
  f.put('schemas/effective.json', {
    type: 'object',
    properties: {
      channel: { type: ['string', 'null'] },
      options: {
        anyOf: [
          { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
          { type: 'object' },
        ],
      },
    },
    additionalProperties: false,
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_POSTURE' })],
  });
});

test('asynchronous structural schemas cannot masquerade as a successful boolean check', async () => {
  const f = fixture();
  f.put('schemas/effective.json', {
    $async: true,
    type: 'object',
    properties: { channel: { type: ['string', 'null'] } },
    additionalProperties: false,
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_INVALID' })],
  });
});

test('declared source-relative array paths retain each appended item source and future outputs', async () => {
  const f = fixture(),
    reg = registry(f),
    props = { files: { type: 'array', items: { type: 'string' } } };
  f.put('schemas/effective.json', {
    type: 'object',
    properties: props,
    additionalProperties: false,
  });
  f.put('schemas/fragment.json', {
    type: 'object',
    properties: props,
    additionalProperties: false,
  });
  reg.domains[0].versions['1.0.0'].paths = {
    '/files': {
      base: 'source',
      allowedRoots: [{ base: 'source', path: '.' }],
      mustExist: false,
      symlinks: 'within-roots',
    },
  };
  reg.domains[0].versions['1.0.0'].merge = { '/files': 'append' };
  saveRegistry(f, reg);
  f.put('common/base.json', doc({ files: ['parent-output'] }));
  f.put(
    'apps/app/config/tool.json',
    doc({ files: ['child-output'] }, { extends: '../../../common/base.json' }),
  );
  const value = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(value.paths['/files/0']).toMatchObject({
    resolved: path.join(f.root, 'common/parent-output'),
    exists: false,
  });
  expect(value.paths['/files/1']).toMatchObject({
    resolved: path.join(f.root, 'apps/app/config/child-output'),
    exists: false,
  });
});

test('path roots and symlink policies distinguish inputs, outputs and escapes', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: false,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  f.put('apps/app/config/tool.json', doc({ channel: 'future/out' }));
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).paths['/channel'].exists,
  ).toBe(false);
  reg.domains[0].versions['1.0.0'].paths['/channel'].mustExist = true;
  saveRegistry(f, reg);
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'PATH_NOT_FOUND' })],
  });
  f.put('outside/file.json', {});
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'apps/app/escape'));
  f.put('apps/app/config/tool.json', doc({ channel: 'escape/file.json' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'PATH_ESCAPE' })],
  });
  f.put('apps/app/inside/file.json', {});
  fs.symlinkSync(path.join(f.root, 'apps/app/inside'), path.join(f.root, 'apps/app/link'));
  f.put('apps/app/config/tool.json', doc({ channel: 'link/file.json' }));
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).paths['/channel'].exists,
  ).toBe(true);
  reg.domains[0].versions['1.0.0'].paths['/channel'].symlinks = 'reject';
  saveRegistry(f, reg);
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'PATH_SYMLINK' })],
  });
});

test('empty validation selections require explicit permission', async () => {
  const f = fixture();
  await expect(f.client.validate({ projects: [] })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'EMPTY_SELECTION' })],
  });
  expect(await f.client.validate({ projects: [], allowEmpty: true })).toMatchObject({
    valid: true,
    evaluated: [],
  });
});

test('direct JSON mode returns a failure envelope for invalid command arguments', () => {
  const child = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, '../dist/cli.js'), 'get', '--json', '--unknown-flag'],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(2);
  expect(JSON.parse(child.stdout).status).toBe('failure');
});

test('unexpected local IO defects are execution failures, not invalid configuration', () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['1.0.0'].paths = {
    '/channel': {
      base: 'project',
      allowedRoots: [{ base: 'project', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  f.put('apps/app/data.json', {});
  f.put('apps/app/config/tool.json', doc({ channel: 'data.json' }));
  const preload = path.join(f.root, 'fault.mjs');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';const original=fs.statSync;fs.statSync=(p,...args)=>{if(p===${JSON.stringify(path.join(f.root, 'apps/app/data.json'))})throw Error('private-payload');return original(p,...args)};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'get',
      '--root',
      f.root,
      '--project',
      '@example/app',
      '--domain',
      'tool',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(1);
  const result = JSON.parse(child.stdout);
  expect(result.diagnostics[0].code).toBe('INTERNAL');
  expect(child.stdout).not.toContain('private-payload');
});

test('contract version tokens are validated without repairing leading zeroes', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['01.0.0'] = reg.domains[0].versions['1.0.0'];
  saveRegistry(f, reg);
  f.put('apps/app/config/tool.json', doc({ channel: null }, { contractVersion: '01.0.0' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_INVALID' })]),
  });
});

const roots = [];
/**
 * Make `target` unreadable and prove it. Permission tests must never pass vacuously: a
 * privileged process (root, CAP_DAC_OVERRIDE) ignores mode 0, so the fixture is checked
 * with a real read and the test fails by name when the denial does not hold.
 */
function denyAccess(target, mode = 0) {
  fs.chmodSync(target, mode);
  let denied = false;
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.readdirSync(target);
    else fs.readFileSync(target);
  } catch (error) {
    denied = error && (error.code === 'EACCES' || error.code === 'EPERM');
  }
  if (!denied)
    throw new Error(
      `PERMISSION_FIXTURE_INEFFECTIVE: mode ${mode.toString(8)} on ${target} does not deny access (running as uid ${process.getuid?.() ?? 'unknown'}); run the suite unprivileged`,
    );
}

export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-rush-test-'));
  roots.push(root);
  const put = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  put('rush.json', {
    rushVersion: '5.177.2',
    pnpmVersion: '10.24.0',
    projects: [{ packageName: '@example/app', projectFolder: 'apps/app' }],
  });
  put('apps/app/package.json', { name: '@example/app', version: '1.0.0' });
  put('schemas/fragment.json', {
    type: 'object',
    properties: {
      channel: { type: ['string', 'null'] },
      addons: { type: 'array', items: { type: 'string' } },
      options: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  });
  put('schemas/effective.json', {
    type: 'object',
    properties: {
      channel: { type: ['string', 'null'] },
      addons: { type: 'array', items: { type: 'string' } },
      options: { type: 'object', additionalProperties: true },
    },
    required: ['channel'],
    additionalProperties: false,
  });
  put('common/config/rush-plugins/config-rush-plugin.json', {
    formatVersion: 1,
    domains: [
      {
        name: 'tool',
        projectFile: 'config/tool.json',
        versions: {
          '1.0.0': { schema: 'schemas/effective.json', fragmentSchema: 'schemas/fragment.json' },
        },
      },
    ],
  });
  put('apps/app/config/tool.json', {
    formatVersion: 1,
    domain: 'tool',
    contractVersion: '1.0.0',
    values: { channel: null },
  });
  return { root, put, client: createClient({ root }) };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('reads a registered project domain and preserves ordinary null', async () => {
  const { client } = fixture();
  const result = await client.get({ project: '@example/app', domain: 'tool' });
  expect(result.values).toEqual({ channel: null });
  expect(result.contractVersion).toBe('1.0.0');
});

function doc(values, extra = {}) {
  return { formatVersion: 1, domain: 'tool', contractVersion: '1.0.0', values, ...extra };
}
function registry(f) {
  return JSON.parse(
    fs.readFileSync(
      path.join(f.root, 'common/config/rush-plugins/config-rush-plugin.json'),
      'utf8',
    ),
  );
}
function saveRegistry(f, r) {
  f.put('common/config/rush-plugins/config-rush-plugin.json', r);
}

test('explicit inheritance replaces arrays/objects and attributes fields', async () => {
  const f = fixture();
  f.put(
    'apps/app/config/base.json',
    doc({ channel: 'ops', addons: ['a'], options: { one: 1, two: 2 } }),
  );
  f.put(
    'apps/app/config/tool.json',
    doc({ channel: null, addons: ['b'], options: { two: 3 } }, { extends: './base.json' }),
  );
  const r = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(r.values).toEqual({ channel: null, addons: ['b'], options: { two: 3 } });
  expect(r.provenance['/channel'].source).toMatch(/tool.json$/);
  expect(r.sources).toHaveLength(2);
});

test('declared append and shallow merge preserve parent field provenance', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['1.0.0'].merge = { '/addons': 'append', '/options': 'merge' };
  saveRegistry(f, reg);
  f.put(
    'apps/app/config/base.json',
    doc({ channel: 'ops', addons: ['a'], options: { one: 1, two: 2 } }),
  );
  f.put(
    'apps/app/config/tool.json',
    doc({ addons: ['b'], options: { two: 3 } }, { extends: './base.json' }),
  );
  const r = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(r.values).toEqual({ channel: 'ops', addons: ['a', 'b'], options: { one: 1, two: 3 } });
  expect(r.provenance['/options/one'].source).toMatch(/base.json$/);
  expect(r.provenance['/addons/1'].source).toMatch(/tool.json$/);
});

test('suppression removes inherited value without changing null or waiving required fields', async () => {
  const f = fixture();
  f.put('apps/app/config/base.json', doc({ channel: 'ops', addons: ['a'] }));
  f.put(
    'apps/app/config/tool.json',
    doc({ channel: null }, { extends: './base.json', suppress: ['/addons'] }),
  );
  const r = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(r.values).toEqual({ channel: null });
  expect(r.suppressed['/addons']).toBeDefined();
  f.put('apps/app/config/tool.json', doc({}, { extends: './base.json', suppress: ['/channel'] }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_INVALID' })],
  });
});

test.each([
  ['cycle', doc({}, { extends: './tool.json' }), 'INHERITANCE_CYCLE'],
  ['wrong version', doc({ channel: null }, { contractVersion: '2.0.0' }), 'UNSUPPORTED_VERSION'],
  ['wrong domain', doc({ channel: null }, { domain: 'other' }), 'DOMAIN_MISMATCH'],
  ['unknown field', doc({ channel: null, typo: 1 }), 'SCHEMA_INVALID'],
  ['unknown envelope field', { ...doc({ channel: null }), typo: 1 }, 'SCHEMA_INVALID'],
  [
    'suppression overlap',
    doc({ channel: null }, { extends: './base.json', suppress: ['/addons', '/addons/0'] }),
    'SUPPRESSION_CONFLICT',
  ],
  [
    'assignment/suppression conflict',
    doc({ channel: null }, { extends: './base.json', suppress: ['/channel'] }),
    'SUPPRESSION_CONFLICT',
  ],
])('%s fails with a structured rejected error', async (_name, input, code) => {
  const f = fixture();
  f.put('apps/app/config/base.json', doc({ channel: 'ops', addons: ['a'] }));
  f.put('apps/app/config/tool.json', input);
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    _tag: 'ConfigurationError',
    diagnostics: [expect.objectContaining({ code })],
  });
});

test('parent version mismatch fails, even if both versions are supported', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['2.0.0'] = reg.domains[0].versions['1.0.0'];
  saveRegistry(f, reg);
  f.put('apps/app/config/base.json', doc({ channel: 'ops' }, { contractVersion: '2.0.0' }));
  f.put('apps/app/config/tool.json', doc({}, { extends: './base.json' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'INHERITANCE_VERSION' })],
  });
});

test('rig fallback is used only without a local file', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  f.put('apps/app/node_modules/example-rig/package.json', {
    name: 'example-rig',
    version: '1.0.0',
  });
  f.put(
    'apps/app/node_modules/example-rig/profiles/default/config/tool.json',
    doc({ channel: 'rig', addons: ['a'] }),
  );
  f.put('apps/app/config/rig.json', { rigPackageName: 'example-rig' });
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel).toBe(
    'rig',
  );
  f.put('apps/app/config/tool.json', doc({ channel: null }));
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values).toEqual({
    channel: null,
  });
});

test('optional absence is explicit and cannot weaken required registration', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  expect(
    await f.client.get({ project: '@example/app', domain: 'tool', optional: true }),
  ).toMatchObject({ absent: true, values: null });
  const reg = registry(f);
  reg.domains[0].required = true;
  saveRegistry(f, reg);
  await expect(
    f.client.get({ project: '@example/app', domain: 'tool', optional: true }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'REQUIRED_DOMAIN_MISSING' })],
  });
});

test('explain returns invalid diagnostics and no consumable partial value', async () => {
  const f = fixture();
  f.put('apps/app/config/tool.json', doc({ channel: 42 }));
  const r = await f.client.explain({ project: '@example/app', domain: 'tool' });
  expect(r).toMatchObject({ valid: false, result: null });
  expect(r.sources).toHaveLength(1);
  expect(r.diagnostics.length).toBeGreaterThan(0);
});

test('exact project names and unknown selections fail instead of yielding an empty success', async () => {
  const f = fixture();
  await expect(f.client.get({ project: 'app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'UNKNOWN_PROJECT' })],
  });
  await expect(f.client.validate({ projects: ['missing'] })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'UNKNOWN_PROJECT' })],
  });
  expect((await f.client.discover()).domains[0].versions).toEqual(['1.0.0']);
});

test('duplicate keys report both locations and do not mutate source bytes', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json'),
    text =
      '{"formatVersion":1,"domain":"tool","contractVersion":"1.0.0","values":{"channel":null,"channel":"x"}}';
  fs.writeFileSync(file, text);
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [
      expect.objectContaining({
        code: 'DUPLICATE_KEY',
        offset: expect.any(Number),
        relatedOffset: expect.any(Number),
      }),
    ],
  });
  expect(fs.readFileSync(file, 'utf8')).toBe(text);
});

test('missing schema references fail locally without a network loader', async () => {
  const f = fixture();
  f.put('schemas/effective.json', { $ref: 'https://example.invalid/missing.json' });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SCHEMA_INVALID' })],
  });
});

test('validation aggregates independent invalid domains', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({
    ...reg.domains[0],
    name: 'other',
    projectFile: 'config/other.json',
    required: true,
  });
  saveRegistry(f, reg);
  f.put('apps/app/config/tool.json', doc({ channel: 42 }));
  const r = await f.client.validate();
  expect(r.valid).toBe(false);
  expect(r.evaluated).toHaveLength(2);
  expect(r.diagnostics).toHaveLength(2);
});

test('an admitted schema package is version checked without executing its code', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.packages = { '@team/contracts': '1.0.0' };
  reg.domains[0].versions['1.0.0'].schema = 'package:@team/contracts/effective.json';
  saveRegistry(f, reg);
  f.put('common/autoinstallers/rush-plugins/node_modules/@team/contracts/package.json', {
    name: '@team/contracts',
    version: '1.0.0',
  });
  f.put('common/autoinstallers/rush-plugins/node_modules/@team/contracts/effective.json', {
    type: 'object',
    properties: { channel: { type: ['null', 'string'] } },
    required: ['channel'],
    additionalProperties: false,
  });
  expect((await f.client.get({ project: '@example/app', domain: 'tool' })).values).toEqual({
    channel: null,
  });
  f.put('common/autoinstallers/rush-plugins/node_modules/@team/contracts/package.json', {
    name: '@team/contracts',
    version: '1.0.1',
  });
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'PACKAGE_VERSION_MISMATCH' })],
  });
});

test('inheritance without an explicit fragment schema fails rather than deriving one', async () => {
  const f = fixture(),
    reg = registry(f);
  delete reg.domains[0].versions['1.0.0'].fragmentSchema;
  saveRegistry(f, reg);
  expect(
    (await f.client.get({ project: '@example/app', domain: 'tool' })).values.channel,
  ).toBeNull();
  f.put('apps/app/config/base.json', doc({ channel: 'parent' }));
  f.put('apps/app/config/tool.json', doc({}, { extends: './base.json' }));
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'FRAGMENT_SCHEMA_REQUIRED' })],
  });
});

test('new supported versions do not automatically migrate existing documents', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].versions['2.0.0'] = {
    schema: 'schemas/v2.json',
    fragmentSchema: 'schemas/fragment.json',
  };
  f.put('schemas/v2.json', { type: 'object', required: ['newFeature'] });
  saveRegistry(f, reg);
  const value = await f.client.get({ project: '@example/app', domain: 'tool' });
  expect(value.contractVersion).toBe('1.0.0');
  expect(value.values.channel).toBeNull();
});

test('symlinked project config cannot escape the project root', async () => {
  const f = fixture();
  f.put('outside.json', doc({ channel: 'outside' }));
  const local = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(local);
  fs.symlinkSync(path.join(f.root, 'outside.json'), local);
  await expect(f.client.get({ project: '@example/app', domain: 'tool' })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'PATH_ESCAPE' })],
  });
});

test('a later declared path dependency is registered even when an earlier one fails validation', async () => {
  const f = fixture(),
    reg = registry(f);
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  reg.domains[0].versions['1.0.0'].paths = {
    '/addons': {
      base: 'repository',
      allowedRoots: [{ base: 'repository', path: '.' }],
      mustExist: true,
      symlinks: 'within-roots',
    },
  };
  saveRegistry(f, reg);
  f.put(
    'apps/second/config/tool.json',
    doc({ channel: 'ok', addons: ['missing-required.json', 'apps/app/config/tool.json'] }),
  );
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
    ],
  };
  // '/addons/0' fails PATH_NOT_FOUND before '/addons/1' (the file this edit changes) is reached;
  // the dependency on '/addons/1' must still be registered so this consumer counts as affected,
  // not unrelated, and the edit is blocked rather than silently proceeding.
  await expect(f.client.previewEdits(request)).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'PATH_NOT_FOUND', project: '@example/second' }),
    ]),
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBeNull();
});

test('creating a destination directory does not stale an unrelated affected-consumer guard', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains[0].projectFile = 'config/deep/tool.json';
  reg.domains.push({
    name: 'sibling',
    projectFile: 'config/deep/sibling.json',
    versions: reg.domains[0].versions,
  });
  saveRegistry(f, reg);
  fs.rmSync(path.join(f.root, 'apps/app/config/tool.json'), { force: true });
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'new' }),
      },
    ],
  });
  const result = await f.client.applyEdits(plan);
  expect(result.status).toBe('success');
  expect(result.diagnostics).toEqual([]);
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/deep/tool.json'), 'utf8')).values
      .channel,
  ).toBe('new');
});

test('a lock descriptor close failure does not skip independent lock-file cleanup', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'lock-close.mjs');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const open=fs.openSync,close=fs.closeSync;let target;fs.openSync=(name,...args)=>{const fd=open(name,...args);if(args[0]==='wx'&&String(name).endsWith('writer.lock'))target=fd;return fd;};fs.closeSync=(fd)=>{if(fd===target){target=undefined;throw Object.assign(new Error('injected lock close failure'),{code:'EIO'})}return close(fd);};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(child.stdout);
  expect(result.status).toBe('partial');
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'OPERATION_CLEANUP_FAILED' })]),
  );
  expect(fs.existsSync(path.join(f.root, 'common/temp/config-rush-authoring/writer.lock'))).toBe(
    false,
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBe('new');
});

test('CLI result publication closes its temporary descriptor exactly once', async () => {
  const f = fixture();
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
    ],
  };
  const input = path.join(f.root, 'request.json'),
    output = path.join(f.root, 'preview-result.json'),
    proof = path.join(f.root, 'closes.json'),
    hook = path.join(f.root, 'publish-close.mjs');
  fs.writeFileSync(input, JSON.stringify(request));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const open=fs.openSync,close=fs.closeSync;let target,closes=0;fs.openSync=(name,...args)=>{const fd=open(name,...args);if(args[0]==='wx'&&String(name).includes('.tmp'))target=fd;return fd;};fs.closeSync=(fd)=>{if(fd===target){closes++;throw Object.assign(new Error('injected close failure'),{code:'EIO'})}return close(fd);};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({closes})));`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'preview',
      '--request-file',
      input,
      '--root',
      f.root,
      '--result-file',
      output,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).not.toBe(0);
  expect(JSON.parse(fs.readFileSync(proof, 'utf8')).closes).toBe(1);
  expect(fs.existsSync(output)).toBe(false);
  expect(child.stderr).toContain('RESULT_PUBLICATION_FAILED');
});

test.each(['schema', 'version', 'duplicate-key', 'project-owned'])(
  'declared path participation survives a consumer whose own document fails: %s',
  async (failure) => {
    const f = fixture(),
      reg = registry(f);
    f.put('rush.json', {
      projects: [
        { packageName: '@example/app', projectFolder: 'apps/app' },
        { packageName: '@example/second', projectFolder: 'apps/second' },
      ],
    });
    f.put('apps/second/package.json', { name: '@example/second' });
    reg.domains[0].versions['1.0.0'].paths = {
      '/addons': {
        base: 'repository',
        allowedRoots: [{ base: 'repository', path: '.' }],
        mustExist: true,
        symlinks: 'within-roots',
      },
    };
    if (failure === 'project-owned') {
      // Only the peer violates ownership: it inherits /channel from a shared parent.
      reg.domains[0].versions['1.0.0'].projectOwned = ['/channel'];
      f.put('common/base.json', doc({ channel: 'shared' }));
    }
    saveRegistry(f, reg);
    const second = path.join(f.root, 'apps/second/config/tool.json');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    if (failure === 'duplicate-key')
      fs.writeFileSync(
        second,
        '{"formatVersion":1,"domain":"tool","contractVersion":"1.0.0","values":{"addons":["apps/app/config/tool.json"],"channel":"a","channel":"b"}}',
      );
    else
      f.put(
        'apps/second/config/tool.json',
        doc(
          failure === 'schema'
            ? { addons: ['apps/app/config/tool.json'], unknownField: true }
            : { addons: ['apps/app/config/tool.json'] },
          failure === 'version'
            ? { contractVersion: '9.9.9' }
            : failure === 'project-owned'
              ? { extends: '../../../common/base.json' }
              : {},
        ),
      );
    const request = {
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'new',
        },
      ],
    };
    // The peer's document declares a dependency on the file this edit changes; its own
    // composition or validation failure must not erase that declaration and grant "unrelated".
    const outcome = await f.client.previewEdits(request).then(
      (plan) => ({ plan }),
      (error) => ({ error }),
    );
    expect(outcome.plan).toBeUndefined();
    expect(outcome.error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ project: '@example/second' })]),
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
        .channel,
    ).toBeNull();
  },
);

test('a consumer whose declared scope cannot be read blocks authoring instead of being unrelated', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  f.put('apps/second/config/tool.json', doc({ channel: 'ok' }));
  const directory = path.join(f.root, 'apps/second/config');
  denyAccess(directory);
  try {
    await expect(
      f.client.previewEdits({
        requestVersion: 1,
        edits: [
          {
            project: '@example/app',
            domain: 'tool',
            operation: 'set',
            pointer: '/channel',
            value: 'new',
          },
        ],
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^(CONSUMER_SCOPE_UNPROVEN|SHARED_SOURCE_UNPROVEN)$/u),
          project: '@example/second',
        }),
      ]),
    });
  } finally {
    fs.chmodSync(directory, 0o700);
  }
});

test('shared-source protection fails closed when a dependent peer cannot be read', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/other', projectFolder: 'apps/other' },
    ],
  });
  f.put('apps/other/package.json', { name: '@example/other' });
  f.put('apps/other/config/tool.json', doc({}, { extends: '../../app/config/tool.json' }));
  const directory = path.join(f.root, 'apps/other/config');
  denyAccess(directory);
  try {
    const outcome = await f.client
      .previewEdits({
        requestVersion: 1,
        edits: [
          {
            project: '@example/app',
            domain: 'tool',
            operation: 'set',
            pointer: '/channel',
            value: 'shared',
          },
        ],
      })
      .then(
        (plan) => ({ plan }),
        (error) => ({ error }),
      );
    expect(outcome.plan).toBeUndefined();
    expect(outcome.error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ project: '@example/other' })]),
    );
  } finally {
    fs.chmodSync(directory, 0o700);
  }
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBeNull();
});

test('status reports an empty crash-left lock instead of failing every operation', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'done',
      },
    ],
  });
  const result = await f.client.applyEdits(plan);
  expect(result.status).toBe('success');
  const lockFile = path.join(f.root, 'common/temp/config-rush-authoring/writer.lock');
  fs.writeFileSync(lockFile, '');
  const status = await f.client.editStatus(result.operationId);
  expect(status.lock).toEqual({
    operationId: null,
    ownerPid: null,
    ownerAlive: 'unknown',
    readable: false,
  });
  expect(status.effects.applied).toHaveLength(1);
  expect(fs.existsSync(lockFile)).toBe(true);
  // Status never removes the lock; a fresh writer still finds it held.
  const next = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'again',
      },
    ],
  });
  await expect(f.client.applyEdits(next)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'WRITER_BUSY' })],
  });
});

test('apply and status classify a replaced pending destination identically', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/b', projectFolder: 'apps/b' },
      { packageName: '@example/c', projectFolder: 'apps/c' },
    ],
  });
  for (const name of ['b', 'c']) {
    f.put(`apps/${name}/package.json`, { name: `@example/${name}` });
    f.put(`apps/${name}/config/tool.json`, doc({ channel: null }));
  }
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: ['@example/app', '@example/b', '@example/c'].map((project) => ({
      project,
      domain: 'tool',
      operation: 'set',
      pointer: '/channel',
      value: 'x',
    })),
  });
  const input = path.join(f.root, 'plan.json'),
    driver = path.join(f.root, 'replace-pending.mjs'),
    victim = path.join(f.root, 'apps/c/config/tool.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  // After the first commit, replace the third (still pending) destination with a directory.
  // The second write then fails its precondition; apply and status must both file the third
  // target as unknown, never as an untouched original.
  fs.writeFileSync(
    driver,
    `import fs from 'node:fs';import {createClient} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../dist/index.js')).href)};const rename=fs.renameSync;let fired=false;const victim=${JSON.stringify(victim)};fs.renameSync=(a,b)=>{const result=rename(a,b);if(!fired&&String(b).endsWith('apps/app/config/tool.json')){fired=true;fs.rmSync(victim);fs.mkdirSync(victim);}return result;};const client=createClient({root:${JSON.stringify(f.root)}});const result=await client.applyEdits(JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8')));const status=await client.editStatus(result.operationId);console.log(JSON.stringify({result,status}));`,
  );
  const child = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  const { result, status } = JSON.parse(child.stdout);
  expect(result.status).toBe('partial');
  expect(result.effects.applied.map((t) => t.project)).toEqual(['@example/app']);
  expect(result.effects.unattempted).toHaveLength(0);
  expect(result.effects.unknown.map((t) => t.project)).toContain('@example/c');
  expect(status.effects).toEqual(result.effects);
});

test('an unresolvable declared rig fails authoring closed instead of dropping the rig boundary', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: 'example-rig', projectFolder: 'rigs/example-rig' },
    ],
  });
  f.put('rigs/example-rig/package.json', { name: 'example-rig', version: '1.0.0' });
  f.put('rigs/example-rig/profiles/default/config/tool.json', doc({ channel: 'rig' }));
  f.put('rigs/example-rig/config/tool.json', doc({ channel: null }));
  // The app has a local document for every domain, so ordinary reads never consult the rig,
  // yet it declares one that is not installed.
  f.put('apps/app/config/rig.json', { rigPackageName: 'example-rig' });
  const outcome = await f.client
    .previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: 'example-rig',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'edited',
        },
      ],
    })
    .then(
      (plan) => ({ plan }),
      (error) => ({ error }),
    );
  expect(outcome.plan).toBeUndefined();
  expect(outcome.error.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'SHARED_SOURCE_UNPROVEN', project: '@example/app' }),
    ]),
  );
});

test('an unresolvable admitted validator package fails authoring closed instead of dropping its boundary', async () => {
  const f = fixture();
  admitCheck(f, 'export function validate(){return []}');
  const installed = path.join(
      f.root,
      'common/autoinstallers/rush-plugins/node_modules/example-checks',
    ),
    provider = path.join(f.root, 'apps/app/vendor/checks');
  fs.mkdirSync(path.dirname(provider), { recursive: true });
  fs.renameSync(installed, provider);
  fs.symlinkSync(provider, installed);
  f.put('apps/app/vendor/checks/config/tool.json', doc({ channel: 'old' }));
  const reg = registry(f);
  reg.domains[0].projectFile = 'vendor/checks/config/tool.json';
  saveRegistry(f, reg);
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
    ],
  };
  await expect(f.client.previewEdits(request)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'VALIDATOR_SOURCE_EDIT' })],
  });
  // Make the package unresolvable while a link into the project still exists: the autoinstaller
  // tree unreadable, then the link dangling. Neither may silently drop the boundary.
  const modules = path.dirname(installed);
  denyAccess(modules);
  try {
    await expect(f.client.previewEdits(request)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'SHARED_SOURCE_UNPROVEN', project: 'example-checks' }),
      ]),
    });
  } finally {
    fs.chmodSync(modules, 0o700);
  }
  fs.rmSync(path.join(provider, 'package.json'));
  await expect(f.client.previewEdits(request)).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'SHARED_SOURCE_UNPROVEN', project: 'example-checks' }),
    ]),
  });
});

test.each(['missing', 'escaping'])(
  'a peer whose parent is determinably absent does not block an unrelated repair: %s',
  async (kind) => {
    const f = fixture();
    f.put('rush.json', {
      projects: [
        { packageName: '@example/app', projectFolder: 'apps/app' },
        { packageName: '@example/b', projectFolder: 'apps/b' },
      ],
    });
    f.put('apps/b/package.json', { name: '@example/b' });
    f.put(
      'apps/b/config/tool.json',
      doc({}, { extends: kind === 'missing' ? './base.json' : '../../../../outside/base.json' }),
    );
    const plan = await f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 'fixed',
        },
      ],
    });
    expect(plan.unrelated.evaluated).toContainEqual({ project: '@example/b', domain: 'tool' });
    expect(plan.unrelated.diagnostics.map((d) => d.code)).toContain(
      kind === 'missing' ? 'FILE_MISSING' : 'PATH_ESCAPE',
    );
    expect((await f.client.applyEdits(plan)).status).toBe('success');
  },
);

test('creating the missing parent of another consumer is a shared-source edit', async () => {
  const f = fixture(),
    reg = registry(f);
  reg.domains.push({
    name: 'shared',
    projectFile: 'config/shared.json',
    versions: reg.domains[0].versions,
  });
  saveRegistry(f, reg);
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/b', projectFolder: 'apps/b' },
    ],
  });
  f.put('apps/b/package.json', { name: '@example/b' });
  // b's tool document extends a file that does not exist yet but is exactly app's shared document.
  f.put('apps/b/config/tool.json', doc({}, { extends: '../../app/config/shared.json' }));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'shared',
          operation: 'create',
          document: { ...doc({ channel: 'x' }), domain: 'shared' },
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'SHARED_SOURCE_EDIT' })],
  });
});

function cli(f, args, options = {}) {
  const result = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, '../dist/cli.js'), ...args, '--json'],
    { encoding: 'utf8', cwd: options.cwd ?? f.root, env: { ...process.env, ...options.env } },
  );
  return { status: result.status, envelope: JSON.parse(result.stdout), stderr: result.stderr };
}

test.each([
  ['suppress', ['--pointer', '/addons'], (edit) => edit.operation === 'suppress'],
  [
    'remove-suppression',
    ['--pointer', '/addons'],
    (edit) => edit.operation === 'remove-suppression',
  ],
  ['set-version', ['--contract-version', '1.0.0'], (edit) => edit.contractVersion === '1.0.0'],
])(
  'the %s command previews its single-edit request through the built CLI',
  (verb, extra, check) => {
    const f = fixture();
    // Suppression needs an inherited value: give the project a parent that assigns /addons.
    f.put('apps/app/config/base.json', doc({ addons: ['inherited'] }));
    f.put('apps/app/config/tool.json', doc({ channel: null }, { extends: './base.json' }));
    const { status, envelope } = cli(f, [
      verb,
      '--project',
      '@example/app',
      '--domain',
      'tool',
      ...extra,
      '--root',
      f.root,
    ]);
    expect(status).toBe(0);
    expect(envelope.status).toBe('success');
    expect(envelope.data.request.edits).toHaveLength(1);
    expect(check(envelope.data.request.edits[0])).toBe(true);
    expect(fs.existsSync(path.join(f.root, 'common/temp/config-rush-authoring/writer.lock'))).toBe(
      false,
    );
  },
);

test('the init command previews a create edit from --document-file', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  const document = path.join(f.root, 'new-document.json');
  fs.writeFileSync(document, JSON.stringify(doc({ channel: 'fresh' })));
  const { status, envelope } = cli(f, [
    'init',
    '--project',
    '@example/app',
    '--domain',
    'tool',
    '--document-file',
    document,
    '--root',
    f.root,
  ]);
  expect(status).toBe(0);
  expect(envelope.data.request.edits[0]).toMatchObject({ operation: 'create' });
  expect(envelope.data.targets[0]).toMatchObject({ before: null, changed: true });
  expect(fs.existsSync(path.join(f.root, 'apps/app/config/tool.json'))).toBe(false);
});

test('user-supplied paths resolve against RUSH_INVOKED_FOLDER, not the process cwd', () => {
  const f = fixture();
  const invoked = path.join(f.root, 'apps/app');
  fs.writeFileSync(
    path.join(invoked, 'document.json'),
    JSON.stringify(doc({ channel: 'from-invoked-folder' })),
  );
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  // Rush runs custom commands from the repository root and records where the user typed.
  const { status, envelope } = cli(
    f,
    ['init', '--project', '@example/app', '--domain', 'tool', '--document-file', 'document.json'],
    { cwd: f.root, env: { RUSH_INVOKED_FOLDER: invoked } },
  );
  expect(status).toBe(0);
  expect(envelope.data.request.edits[0].document.values.channel).toBe('from-invoked-folder');
  const result = cli(f, ['discover', '--result-file', 'result.json'], {
    cwd: f.root,
    env: { RUSH_INVOKED_FOLDER: invoked },
  });
  expect(result.status).toBe(0);
  expect(fs.existsSync(path.join(invoked, 'result.json'))).toBe(true);
  expect(fs.existsSync(path.join(f.root, 'result.json'))).toBe(false);
});

test('a pointer descending into a scalar is an invalid-pointer validation failure', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, 'apps/app/config/tool.json'),
    JSON.stringify(doc({ channel: 'abc' })),
  );
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel/0',
          value: 'x',
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'INVALID_POINTER', pointer: '/channel/0' })],
  });
  const { status, envelope } = cli(f, [
    'set',
    '--project',
    '@example/app',
    '--domain',
    'tool',
    '--pointer',
    '/channel/0',
    '--value',
    '"x"',
    '--root',
    f.root,
  ]);
  expect(status).toBe(2);
  expect(envelope.diagnostics[0]).toMatchObject({ code: 'INVALID_POINTER' });
});

test('the CLI catch-all names a next action instead of re-printing the exception', () => {
  const f = fixture();
  const { status, envelope } = cli(f, ['preview', '--request-file', '--root', f.root]);
  expect(status).toBe(2);
  expect(envelope.diagnostics[0].code).toBe('USAGE_OR_IO');
  expect(envelope.diagnostics[0].message).toMatch(/Run with --help/u);
});

test('status names a staged candidate left beside the destination by a kill before commit', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'written',
      },
    ],
  });
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, 'kill-before-rename.mjs'),
    file = path.join(f.root, 'apps/app/config/tool.json');
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(
    hook,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===${JSON.stringify(file)})process.kill(process.pid,'SIGKILL');return rename(a,b);};`,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  expect(child.signal).toBe('SIGKILL');
  const storage = path.join(f.root, 'common/temp/config-rush-authoring'),
    journal = fs.readdirSync(storage).find((name) => name.endsWith('.json'));
  const id = JSON.parse(fs.readFileSync(path.join(storage, journal), 'utf8')).operationId;
  const staged = path.join(f.root, 'apps/app/config', `.config-rush-${id}-0.tmp`);
  expect(fs.existsSync(staged)).toBe(true);
  const status = await f.client.editStatus(id);
  expect(status.targets[0]).toMatchObject({
    state: 'writing',
    observed: 'original',
    temporary: staged,
  });
  expect(status.recovery).toMatch(/temporary/u);
  expect(fs.existsSync(staged)).toBe(true);
});

test('a completed target reports no staged temporary', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'x',
      },
    ],
  });
  const result = await f.client.applyEdits(plan);
  expect(result.status).toBe('success');
  const id = path.basename(result.journal, '.json');
  const status = await f.client.editStatus(id);
  expect(status.targets[0]).toMatchObject({ state: 'applied', temporary: null });
});

test('a batch mixing a changed target with a no-op target still writes the changed one', async () => {
  const f = fixture();
  f.put('rush.json', {
    projects: [
      { packageName: '@example/app', projectFolder: 'apps/app' },
      { packageName: '@example/second', projectFolder: 'apps/second' },
    ],
  });
  f.put('apps/second/package.json', { name: '@example/second' });
  f.put('apps/second/config/tool.json', doc({ channel: 'same' }));
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'new',
      },
      {
        project: '@example/second',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'same',
      },
    ],
  });
  expect(plan.targets.map((target) => target.changed)).toEqual([true, false]);
  const result = await f.client.applyEdits(plan);
  expect(result.status).toBe('success');
  expect(result.effects.applied).toHaveLength(1);
  expect(result.journal).not.toBeNull();
  expect(
    JSON.parse(fs.readFileSync(path.join(f.root, 'apps/app/config/tool.json'), 'utf8')).values
      .channel,
  ).toBe('new');
});

test.each([
  [
    'duplicate pointers',
    [
      { operation: 'set', pointer: '/channel', value: 1 },
      { operation: 'unset', pointer: '/channel' },
    ],
    'EDIT_CONFLICT',
  ],
  [
    'ancestor and descendant pointers',
    [
      { operation: 'set', pointer: '/addons', value: [] },
      { operation: 'set', pointer: '/addons/0', value: 'x' },
    ],
    'EDIT_CONFLICT',
  ],
  [
    'create combined with a field edit',
    [
      { operation: 'create', document: doc({}) },
      { operation: 'set', pointer: '/channel', value: 1 },
    ],
    'EDIT_CONFLICT',
  ],
  [
    'two set-version edits',
    [
      { operation: 'set-version', contractVersion: '1.0.0' },
      { operation: 'set-version', contractVersion: '1.0.0' },
    ],
    'EDIT_CONFLICT',
  ],
])('request rejection: %s', async (_name, edits, code) => {
  const f = fixture();
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: edits.map((edit) => ({ project: '@example/app', domain: 'tool', ...edit })),
    }),
  ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code })] });
});

test('field edits on an absent local document require an explicit create first', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'apps/app/config/tool.json'));
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel',
          value: 1,
        },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'LOCAL_DOCUMENT_REQUIRED' })],
  });
});

test('the authoring storage directory is created private to the writer', async () => {
  const f = fixture();
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/channel',
        value: 'x',
      },
    ],
  });
  expect((await f.client.applyEdits(plan)).status).toBe('success');
  const storage = path.join(f.root, 'common/temp/config-rush-authoring');
  expect(fs.statSync(storage).mode & 0o777).toBe(0o700);
});

test('the observation budget is pinned at 16384 inputs', async () => {
  const f = fixture();
  const { ReadContext } = await import('../dist/read-context.js');
  const context = new ReadContext(true);
  let admitted = 0;
  let failure;
  try {
    for (let index = 0; index < 20000; index += 1) {
      context.observePath(path.join(f.root, `absent-${index}`));
      admitted += 1;
    }
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'OBSERVATION_LIMIT' })],
  });
  // The budget counts every distinct observed path, including the fixture root's ancestors;
  // a mutated bound moves this number.
  const ancestors = f.root.split(path.sep).filter(Boolean).length + 1;
  expect(admitted).toBe(16384 - ancestors);
});

function applyThroughHook(f, plan, hookSource) {
  const input = path.join(f.root, 'plan.json'),
    hook = path.join(f.root, `hook-${randomUUID()}.mjs`);
  fs.writeFileSync(input, JSON.stringify(plan));
  fs.writeFileSync(hook, hookSource);
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      path.resolve(import.meta.dirname, '../dist/cli.js'),
      'apply',
      '--root',
      f.root,
      '--plan-file',
      input,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  return { child, envelope: child.stdout ? JSON.parse(child.stdout) : null };
}

async function singleSetPlan(f, value = 'written') {
  return f.client.previewEdits({
    requestVersion: 1,
    edits: [
      { project: '@example/app', domain: 'tool', operation: 'set', pointer: '/channel', value },
    ],
  });
}

test('an external replacement of the destination after the journal write is caught before the rename', async () => {
  const f = fixture();
  const plan = await singleSetPlan(f);
  const file = path.join(f.root, 'apps/app/config/tool.json');
  // Between the durable-intent journal write and the commit primitive, replace the destination.
  const { child, envelope } = applyThroughHook(
    f,
    plan,
    `import fs from 'node:fs';const rename=fs.renameSync;let journalSaves=0;fs.renameSync=(a,b)=>{const r=rename(a,b);if(b.includes('config-rush-authoring')&&b.endsWith('.json')){journalSaves+=1;if(journalSaves===2)fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(doc({ channel: 'raced' })))});}return r;};`,
  );
  // The journal already records intent, so this is a partial outcome for reconciliation.
  expect(child.status).toBe(4);
  expect(envelope.status).toBe('partial');
  expect(envelope.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'INPUT_CHANGED' })]),
  );
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).values.channel).toBe('raced');
  expect(envelope.effects.applied).toEqual([]);
});

test('a destination that does not match the candidate after commit is a write-verification failure', async () => {
  const f = fixture();
  const plan = await singleSetPlan(f);
  const file = path.join(f.root, 'apps/app/config/tool.json');
  // Corrupt the bytes the moment the rename lands, before the writer re-reads them.
  const { child, envelope } = applyThroughHook(
    f,
    plan,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const r=rename(a,b);if(b===${JSON.stringify(file)})fs.appendFileSync(b,'\\n// tampered');return r;};`,
  );
  expect(child.status).not.toBe(0);
  expect(envelope.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'WRITE_VERIFICATION_FAILED', file })]),
  );
  expect(envelope.status).toBe('partial');
});

test('create publication never clobbers a file that appeared after preview', async () => {
  const f = fixture();
  const file = path.join(f.root, 'apps/app/config/tool.json');
  fs.unlinkSync(file);
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'create',
        document: doc({ channel: 'mine' }),
      },
    ],
  });
  // A foreign file lands at the destination after every precondition check, immediately
  // before the publication primitive: only a no-clobber primitive can refuse it.
  const { child, envelope } = applyThroughHook(
    f,
    plan,
    `import fs from 'node:fs';const link=fs.linkSync,rename=fs.renameSync;const plant=()=>fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(doc({ channel: 'theirs' })))});fs.linkSync=(a,b)=>{if(b===${JSON.stringify(file)})plant();return link(a,b);};fs.renameSync=(a,b)=>{if(b===${JSON.stringify(file)})plant();return rename(a,b);};`,
  );
  expect(child.status).not.toBe(0);
  expect(envelope.effects.applied).toEqual([]);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).values.channel).toBe('theirs');
});

test('the writer only removes the lock it created, never a replacement', async () => {
  const f = fixture();
  const plan = await singleSetPlan(f);
  const lock = path.join(f.root, 'common/temp/config-rush-authoring/writer.lock');
  // After the commit, swap the lock for a foreign one before the writer's cleanup runs.
  const { child, envelope } = applyThroughHook(
    f,
    plan,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{const r=rename(a,b);if(b.endsWith('tool.json')){fs.unlinkSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({operationId:'00000000-0000-4000-8000-000000000000',ownerPid:1}));}return r;};`,
  );
  expect(child.status).toBe(0);
  expect(envelope.status).toBe('success');
  expect(fs.existsSync(lock)).toBe(true);
  expect(JSON.parse(fs.readFileSync(lock, 'utf8')).ownerPid).toBe(1);
});

test('an array set into an existing field follows the inferred indentation and its refusal', async () => {
  const f = fixture(),
    file = path.join(f.root, 'apps/app/config/tool.json');
  const fourSpace = JSON.stringify(doc({ channel: null, addons: ['old'] }), null, '    ') + '\n';
  fs.writeFileSync(file, fourSpace);
  const request = {
    requestVersion: 1,
    edits: [
      {
        project: '@example/app',
        domain: 'tool',
        operation: 'set',
        pointer: '/addons',
        value: ['x', 'y'],
      },
    ],
  };
  const plan = await f.client.previewEdits(request);
  expect(plan.targets[0].after).toContain(
    '"addons": [\n            "x",\n            "y"\n        ]',
  );
  // The same document is refused when its indentation is ambiguous, existing field or not.
  const ambiguous = fourSpace.replace('        "channel"', '  "channel"');
  fs.writeFileSync(file, ambiguous);
  await expect(f.client.previewEdits(request)).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'INDENTATION_UNSUPPORTED' })],
  });
  expect(fs.readFileSync(file, 'utf8')).toBe(ambiguous);
});

test('unset below a scalar is a no-op with a note; set below a scalar is an invalid pointer', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, 'apps/app/config/tool.json'),
    JSON.stringify(doc({ channel: 'abc' })),
  );
  const plan = await f.client.previewEdits({
    requestVersion: 1,
    edits: [{ project: '@example/app', domain: 'tool', operation: 'unset', pointer: '/channel/0' }],
  });
  expect(plan.targets[0].changed).toBe(false);
  expect(plan.targets[0].notes).toEqual([
    expect.stringContaining('No local assignment at /channel/0'),
  ]);
  await expect(
    f.client.previewEdits({
      requestVersion: 1,
      edits: [
        {
          project: '@example/app',
          domain: 'tool',
          operation: 'set',
          pointer: '/channel/0',
          value: 'x',
        },
      ],
    }),
  ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'INVALID_POINTER' })] });
});

test('a plan round-tripped through a key-sorting normalizer is not stale', async () => {
  const f = fixture();
  const plan = await singleSetPlan(f);
  const sortKeys = (value) =>
    Array.isArray(value)
      ? value.map(sortKeys)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sortKeys(value[key])]),
          )
        : value;
  const normalized = JSON.parse(JSON.stringify(sortKeys(plan)));
  expect(JSON.stringify(normalized)).not.toBe(JSON.stringify(plan));
  const result = await f.client.applyEdits(normalized);
  expect(result.status).toBe('success');
  expect(result.effects.applied).toHaveLength(1);
});

test('status still names a staged temporary after the project is relocated in rush.json', async () => {
  const f = fixture();
  const plan = await singleSetPlan(f);
  const file = path.join(f.root, 'apps/app/config/tool.json');
  const { child } = applyThroughHook(
    f,
    plan,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===${JSON.stringify(file)})process.kill(process.pid,'SIGKILL');return rename(a,b);};`,
  );
  expect(child.signal).toBe('SIGKILL');
  const storage = path.join(f.root, 'common/temp/config-rush-authoring'),
    journal = fs.readdirSync(storage).find((name) => name.endsWith('.json'));
  const id = JSON.parse(fs.readFileSync(path.join(storage, journal), 'utf8')).operationId;
  // Relocate the project so the journaled destination no longer maps to a registered file.
  f.put('rush.json', {
    rushVersion: '5.177.2',
    pnpmVersion: '10.24.0',
    projects: [{ packageName: '@example/app', projectFolder: 'apps/moved' }],
  });
  f.put('apps/moved/package.json', { name: '@example/app', version: '1.0.0' });
  const status = await f.client.editStatus(id);
  expect(status.targets[0]).toMatchObject({
    observed: 'unknown',
    temporary: path.join(f.root, 'apps/app/config', `.config-rush-${id}-0.tmp`),
  });
});

test('a permission failure reading a request file is an execution failure, exit 1', () => {
  const f = fixture();
  const request = path.join(f.root, 'request.json');
  fs.writeFileSync(request, '{}');
  denyAccess(request);
  try {
    const { status, envelope } = cli(f, ['preview', '--request-file', request, '--root', f.root]);
    expect(status).toBe(1);
    expect(envelope.diagnostics[0]).toMatchObject({ code: 'IO_FAILURE', kind: 'execution' });
  } finally {
    fs.chmodSync(request, 0o600);
  }
});

test('status reports no temporary for a planted symlink or an out-of-repository journal target', async () => {
  const f = fixture();
  const plan = await singleSetPlan(f);
  const file = path.join(f.root, 'apps/app/config/tool.json');
  const { child } = applyThroughHook(
    f,
    plan,
    `import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===${JSON.stringify(file)})process.kill(process.pid,'SIGKILL');return rename(a,b);};`,
  );
  expect(child.signal).toBe('SIGKILL');
  const storage = path.join(f.root, 'common/temp/config-rush-authoring'),
    journalName = fs.readdirSync(storage).find((name) => name.endsWith('.json')),
    journalPath = path.join(storage, journalName),
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')),
    id = journal.operationId,
    staged = path.join(f.root, 'apps/app/config', `.config-rush-${id}-0.tmp`);
  // A symlink planted at the staged name is not a staged candidate.
  fs.rmSync(staged);
  fs.symlinkSync(file, staged);
  expect((await f.client.editStatus(id)).targets[0].temporary).toBeNull();
  // A journal whose target escapes the repository must not name a path outside it.
  const outside = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'config-rush-outside-')),
    'notes.json',
  );
  fs.writeFileSync(
    journalPath,
    JSON.stringify({ ...journal, targets: [{ ...journal.targets[0], file: outside }] }),
  );
  const status = await f.client.editStatus(id);
  expect(status.targets[0].temporary).toBeNull();
  expect(JSON.stringify(status)).not.toContain('.config-rush-');
});
