import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rollup } from './types.js';

vi.mock('./scan.js', () => ({ scan: vi.fn() }));
vi.mock('./fallowBin.js', () => ({ fallowVersion: () => '3.6.0', fallowMcpBin: vi.fn() }));
import { scan } from './scan.js';
import { cliMain } from './cliMain.js';
import { writeReports } from './index.js';

const rollup: Rollup = {
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
  projects: [{ project: 'app', projectFolder: 'apps/app', counts: {}, findings: [] }],
};

// Never follow links while recording the tree: both the checkout and the
// external target must keep their entries and bytes on a refused default.
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
let out: string;
let external: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-symlink-'));
  root = path.join(tmp, 'repo');
  external = path.join(tmp, 'external');
  fs.mkdirSync(root);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(root, 'rush.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(external, 'sentinel'), 'outside bytes');
  out = path.join(root, 'common/temp/fallow-rush');
  vi.stubEnv('RUSH_INVOKED_FOLDER', root);
  vi.mocked(scan).mockReset().mockReturnValue(rollup);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(args: string[] = []): Promise<{ status: number; error: string }> {
  let error = '';
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      error += String(chunk);
      callback();
    },
  });
  return { status: await cliMain(args, sink, stderr), error };
}

function link(component: string, target: string): void {
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.symlinkSync(target, component, 'dir');
}

function expectReport(): void {
  expect(JSON.parse(fs.readFileSync(path.join(out, 'monorepo.json'), 'utf8'))).toEqual(rollup);
  expect(fs.readFileSync(path.join(out, 'monorepo.md'), 'utf8')).toContain('# Fallow rollup');
  expect(fs.existsSync(path.join(out, 'projects/app.json'))).toBe(true);
  expect(fs.existsSync(path.join(out, '.fallow-rush.lock'))).toBe(false);
}

describe('default report symlink boundary', () => {
  it.each(['absolute', 'relative'])(
    'normalizes raw %s API output before every write (F1)',
    (form) => {
      fs.mkdirSync(path.join(external, 'nested'));
      link(path.join(root, 'common/temp/jump'), path.join(external, 'nested'));
      const before = snapshot(external);
      const raw = `${root}/common/temp/jump/../fallow-rush//`;
      const argument =
        form === 'absolute'
          ? raw
          : path.relative(process.cwd(), root) + '/common/temp/jump/../fallow-rush//';
      let failure: unknown;
      try {
        writeReports(rollup, argument);
      } catch (error) {
        failure = error;
      }
      expect(snapshot(external)).toEqual(before);
      expect(failure).toBeUndefined();
      expectReport();
      // The normalized spelling is the control for both raw forms.
      writeReports(rollup, out);
      expect(snapshot(external)).toEqual(before);
      expectReport();
    },
  );
  it.each([
    ['outside leaf', 'common/temp/fallow-rush', 'outside'],
    ['inside leaf', 'common/temp/fallow-rush', 'inside'],
    ['temp parent', 'common/temp', 'outside'],
    ['common parent', 'common', 'outside'],
    ['dangling leaf', 'common/temp/fallow-rush', 'missing'],
    ['dangling parent', 'common/temp', 'missing'],
  ])('refuses %s before scan or filesystem mutation', async (_label, relative, destination) => {
    const target =
      destination === 'inside'
        ? path.join(root, 'chosen')
        : destination === 'missing'
          ? path.join(tmp, 'missing')
          : external;
    if (destination === 'inside') fs.mkdirSync(target);
    const component = path.join(root, relative);
    link(component, target);
    const before = snapshot(tmp);
    const writes = [
      vi.spyOn(fs, 'mkdirSync'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'linkSync'),
      vi.spyOn(fs, 'unlinkSync'),
      vi.spyOn(fs, 'rmSync'),
      vi.spyOn(fs, 'renameSync'),
    ];
    const result = await run();
    expect(result.status).toBe(1);
    expect(result.error).toContain('refusing default report path: symlink component');
    expect(result.error).toContain(component);
    expect(scan).not.toHaveBeenCalled();
    expect(() => writeReports(rollup, out)).toThrow('symlink component');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    }
    expect(snapshot(tmp)).toEqual(before);
    // Negative control: replacing only the link with an ordinary directory
    // admits the same default output, without changing the target.
    fs.unlinkSync(component);
    fs.mkdirSync(component);
    expect((await run()).status).toBe(0);
    expectReport();
  });

  it.each(['absent', 'empty', 'earlier report'])(
    'writes an ordinary %s directory',
    async (kind) => {
      if (kind === 'empty') fs.mkdirSync(out, { recursive: true });
      if (kind === 'earlier report') writeReports(rollup, out);
      const before = snapshot(external);
      expect((await run()).status).toBe(0);
      expectReport();
      expect(snapshot(external)).toEqual(before);
    },
  );

  it.each(['--out', '--report'])('preserves explicit %s through a symlink', async (flag) => {
    link(out, external);
    expect((await run([flag, out])).status).toBe(0);
    expectReport();
    expect(fs.readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('outside bytes');
  });

  it('fails closed on an unreadable component before scanning', async () => {
    const before = snapshot(tmp);
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      if (args[0] === path.join(root, 'common')) {
        throw Object.assign(new Error('cannot inspect component'), { code: 'EACCES' });
      }
      return original(...args);
    });
    const result = await run();
    expect(result.status).toBe(1);
    expect(result.error).toContain('cannot inspect component');
    expect(scan).not.toHaveBeenCalled();
    expect(snapshot(tmp)).toEqual(before);
  });

  it('escapes the refused component with the CLI terminal-text rules', async () => {
    root = path.join(tmp, 'repo\x1b[31m\n\x9b');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'rush.json'), '{"projects":[]}');
    vi.stubEnv('RUSH_INVOKED_FOLDER', root);
    link(path.join(root, 'common'), external);
    const before = snapshot(tmp);
    const { status, error } = await run();
    expect(status).toBe(1);
    expect(error).toContain('repo\\x1B[31m \\x9B');
    expect(error).not.toContain('\x1b');
    expect(error).not.toContain('\x9b');
    expect(error.trimEnd()).not.toContain('\n');
    expect(snapshot(tmp)).toEqual(before);
  });
});

describe('report leaf symlinks (direct exported writer)', () => {
  it('projects to an external file refuses without changing outside bytes', () => {
    fs.mkdirSync(out, { recursive: true });
    fs.symlinkSync(path.join(external, 'sentinel'), path.join(out, 'projects'), 'file');
    const before = snapshot(external);
    expect(() => writeReports(rollup, out)).toThrow();
    expect(snapshot(external)).toEqual(before);
    fs.unlinkSync(path.join(out, 'projects'));
    writeReports(rollup, out);
    expectReport();
  });

  it.each(['monorepo.md', 'monorepo.json', 'projects', '.fallow-rush.lock'])(
    '%s to an external directory never changes outside bytes',
    (leaf) => {
      fs.mkdirSync(out, { recursive: true });
      fs.symlinkSync(external, path.join(out, leaf), 'dir');
      const before = snapshot(external);
      if (leaf === '.fallow-rush.lock') {
        expect(() => writeReports(rollup, out)).toThrow('lock record not yet initialized');
      } else {
        if (leaf === 'projects') {
          fs.writeFileSync(path.join(out, 'monorepo.json'), JSON.stringify(rollup));
        }
        writeReports(rollup, out);
        expectReport();
      }
      expect(snapshot(external)).toEqual(before);
    },
  );

  it.each(['monorepo.md', 'monorepo.json', 'projects', '.fallow-rush.lock'])(
    '%s never changes outside bytes',
    (leaf) => {
      fs.mkdirSync(out, { recursive: true });
      const isDirectory = leaf === 'projects';
      const target = isDirectory ? external : path.join(external, 'sentinel');
      fs.symlinkSync(target, path.join(out, leaf), isDirectory ? 'dir' : 'file');
      // A stale lock exercises takeover without waiting for its age threshold.
      if (leaf === '.fallow-rush.lock') fs.utimesSync(target, new Date(0), new Date(0));
      const before = snapshot(external);
      if (leaf === 'projects') {
        expect(() => writeReports(rollup, out)).toThrow('refusing to delete');
        // A valid ownership record permits unlinking projects/, not following it.
        fs.writeFileSync(path.join(out, 'monorepo.json'), JSON.stringify(rollup));
      }
      writeReports(rollup, out);
      expectReport();
      expect(
        fs
          .lstatSync(path.join(out, leaf === '.fallow-rush.lock' ? 'monorepo.json' : leaf))
          .isSymbolicLink(),
      ).toBe(false);
      expect(snapshot(external)).toEqual(before);
    },
  );
});
