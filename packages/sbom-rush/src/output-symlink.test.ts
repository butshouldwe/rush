import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./generate.js', () => ({ generateSbom: vi.fn() }));
import { generateSbom } from './generate.js';
import { runSbom, writeManifest } from './run.js';

function snapshot(dir: string): unknown {
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
            ? snapshot(file)
            : fs.readFileSync(file).toString('hex'),
      ];
    });
}
let tmp: string;
let root: string;
let external: string;
let out: string;
let target: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-symlink-'));
  root = path.join(tmp, 'repo');
  external = path.join(tmp, 'external');
  target = path.join(tmp, 'deploy-input');
  for (const dir of [root, external, target]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'rush.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(external, 'manifest.json'), 'UNRELATED BYTES');
  fs.writeFileSync(
    path.join(target, 'extractor-metadata.json'),
    JSON.stringify({ mainProjectName: 'app', projects: [] }),
  );
  out = path.join(root, 'common/deploy-sbom');
  vi.stubEnv('RUSH_INVOKED_FOLDER', root);
  vi.mocked(generateSbom).mockReset().mockReturnValue({ attempts: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});
function link(depth: string): string {
  const component = depth === 'root' ? root : depth === 'common' ? path.join(root, 'common') : out;
  if (depth === 'root') {
    fs.copyFileSync(path.join(root, 'rush.json'), path.join(external, 'rush.json'));
    fs.rmSync(root, { recursive: true });
  }
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.symlinkSync(external, component, 'dir');
  return component;
}
function options() {
  return { cwd: root, targetFolder: target };
}

describe('SBOM default output boundary (F2)', () => {
  it('escapes terminal controls in the refused component', () => {
    root = path.join(tmp, 'repo\x1b[31m\n\x9b');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'rush.json'), '{"projects":[]}');
    vi.stubEnv('RUSH_INVOKED_FOLDER', root);
    fs.symlinkSync(external, path.join(root, 'common'));
    expect(() => runSbom(options())).toThrow('\\u009b');
    expect(() => runSbom(options())).toThrow('\\u001b');
  });
  it.each(['absolute', 'relative'])(
    'normalizes raw %s writer paths before every operation',
    (form) => {
      fs.mkdirSync(path.join(external, 'nested'));
      fs.mkdirSync(path.join(root, 'common'));
      fs.symlinkSync(path.join(external, 'nested'), path.join(root, 'common/jump'));
      const argument =
        (form === 'absolute' ? root : path.relative(process.cwd(), root)) +
        '/common//jump/../deploy-sbom/';
      const before = snapshot(external);
      let failure: unknown;
      try {
        writeManifest(argument, 'review', []);
      } catch (error) {
        failure = error;
      }
      expect(snapshot(external)).toEqual(before);
      expect(failure).toBeUndefined();
      expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(true);
      writeManifest(out, 'control', []);
      expect(snapshot(external)).toEqual(before);
    },
  );

  it.each(['common', 'deploy-sbom'])('refuses dangling %s', (depth) => {
    const component = depth === 'common' ? path.join(root, 'common') : out;
    fs.mkdirSync(path.dirname(component), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'missing'), component);
    const before = snapshot(tmp);
    expect(() => writeManifest(out, 'review', [])).toThrow('symlink component');
    expect(() => runSbom(options())).toThrow('symlink component');
    expect(snapshot(tmp)).toEqual(before);
    fs.unlinkSync(component);
    fs.mkdirSync(component);
    writeManifest(out, 'control', []);
  });

  it('fails closed on an unreadable component', () => {
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      if (args[0] === path.join(root, 'common'))
        throw Object.assign(new Error('cannot inspect component'), { code: 'EACCES' });
      return original(...args);
    });
    expect(() => runSbom(options())).toThrow('cannot inspect component');
    expect(() => writeManifest(out, 'review', [])).toThrow('cannot inspect component');
    expect(generateSbom).not.toHaveBeenCalled();
    expect(fs.existsSync(out)).toBe(false);
  });

  it.each(['root', 'common', 'deploy-sbom'])(
    'refuses direct writer at %s before mutation',
    (depth) => {
      const component = link(depth);
      // Plant the unrelated manifest at the exact destination at every depth.
      fs.mkdirSync(path.dirname(path.join(out, 'manifest.json')), { recursive: true });
      fs.writeFileSync(path.join(out, 'manifest.json'), 'UNRELATED BYTES');
      const before = snapshot(tmp);
      expect(() => writeManifest(out, 'review', [])).toThrow(`symlink component "${component}"`);
      expect(snapshot(tmp)).toEqual(before);
      fs.unlinkSync(component);
      fs.mkdirSync(component);
      writeManifest(out, 'review', []);
      expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).generator).toBe(
        '@butshouldwe/sbom-rush',
      );
    },
  );

  it.each(
    ['root', 'common', 'deploy-sbom'].flatMap((depth) =>
      ['normal', 'metadata-error'].map((publication) => [depth, publication]),
    ),
  )('refuses %s before generation on %s publication', (depth, publication) => {
    const component = link(depth);
    if (publication === 'metadata-error') fs.rmSync(path.join(target, 'extractor-metadata.json'));
    const before = snapshot(tmp);
    expect(() => runSbom(options())).toThrow(`symlink component "${component}"`);
    expect(generateSbom).not.toHaveBeenCalled();
    expect(snapshot(tmp)).toEqual(before);
  });

  it.each(['absent', 'empty', 'earlier report'])('writes ordinary %s output', (kind) => {
    if (kind !== 'absent') fs.mkdirSync(out, { recursive: true });
    if (kind === 'earlier report') writeManifest(out, 'earlier', []);
    const before = snapshot(external);
    expect(runSbom(options()).exitCode).toBe(1);
    expect(generateSbom).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).generator).toBe(
      '@butshouldwe/sbom-rush',
    );
    expect(snapshot(external)).toEqual(before);
  });

  it('preserves explicit output through a symlink on both publication paths', () => {
    link('deploy-sbom');
    expect(runSbom({ ...options(), out }).exitCode).toBe(1);
    expect(generateSbom).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(path.join(external, 'manifest.json'), 'utf8')).generator,
    ).toBe('@butshouldwe/sbom-rush');
    fs.rmSync(path.join(target, 'extractor-metadata.json'));
    expect(runSbom({ ...options(), out }).exitCode).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(external, 'manifest.json'), 'utf8')).generator,
    ).toBe('@butshouldwe/sbom-rush');
  });

  it.each([false, true])('publishes generated SBOMs with explicitOut=%s', (explicit) => {
    vi.mocked(generateSbom).mockReturnValue({
      attempts: [],
      rung: 1,
      method: 'fixture',
      bom: { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: [] },
    });
    if (explicit) link('deploy-sbom');
    const before = snapshot(external);
    const result = runSbom({ ...options(), ...(explicit ? { out } : {}) });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(out, 'app.cdx.json'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).scenarios.app,
    ).toBeDefined();
    if (!explicit) expect(snapshot(external)).toEqual(before);
  });

  it('replaces the manifest leaf link without changing its target', () => {
    fs.mkdirSync(out, { recursive: true });
    fs.symlinkSync(path.join(external, 'manifest.json'), path.join(out, 'manifest.json'));
    const before = snapshot(external);
    writeManifest(out, 'review', []);
    expect(fs.lstatSync(path.join(out, 'manifest.json')).isSymbolicLink()).toBe(false);
    expect(snapshot(external)).toEqual(before);
  });
});
