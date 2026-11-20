import fs from 'node:fs';
import { cleanupFailedSettingsCopy } from '../src/claudeState.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copySettingsLocal,
  pruneClaudeProjectEntry,
  seedClaudeProjectEntry,
  type SeedResult,
} from './claudeState.js';

let tmp: string;
let claudeJson: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-claude-'));
  claudeJson = path.join(tmp, 'claude.json');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeClaudeJson(content: unknown): void {
  fs.writeFileSync(claudeJson, JSON.stringify(content, null, 2));
}

const SOURCE = '/repos/rush';
const TARGET = '/repos/.worktrees/rush/feat/x';

describe('seedClaudeProjectEntry', () => {
  it('copies exactly the trust/permission/MCP keys, nothing else', () => {
    writeClaudeJson({
      projects: {
        [SOURCE]: {
          hasTrustDialogAccepted: true,
          allowedTools: ['Bash(pnpm:*)', 'Read'],
          enabledMcpjsonServers: ['rush-mcp-server'],
          disabledMcpjsonServers: [],
          hasClaudeMdExternalIncludesApproved: true,
          history: ['secret session stuff'],
          exampleCounter: 42,
        },
      },
      otherTopLevel: { keep: 'me' },
    });
    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.action).toBe('seeded');
    expect(result.seededKeys).toEqual([
      'hasTrustDialogAccepted',
      'allowedTools',
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
      'hasClaudeMdExternalIncludesApproved',
    ]);
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[TARGET]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash(pnpm:*)', 'Read'],
      enabledMcpjsonServers: ['rush-mcp-server'],
      disabledMcpjsonServers: [],
      hasClaudeMdExternalIncludesApproved: true,
    });
    // session state must NOT travel
    expect(parsed.projects[TARGET].history).toBeUndefined();
    // and the rest of the file is untouched
    expect(parsed.otherTopLevel).toEqual({ keep: 'me' });
    expect(parsed.projects[SOURCE].history).toEqual(['secret session stuff']);
  });

  it('patches an existing target entry without destroying its other keys', () => {
    writeClaudeJson({
      projects: {
        [SOURCE]: { hasTrustDialogAccepted: true },
        [TARGET]: { somePriorState: 'kept', hasTrustDialogAccepted: false },
      },
    });
    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.action).toBe('seeded');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[TARGET].somePriorState).toBe('kept');
    expect(parsed.projects[TARGET].hasTrustDialogAccepted).toBe(true);
  });

  it('skips with guidance when the source path has no entry', () => {
    writeClaudeJson({ projects: {} });
    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain(SOURCE);
    expect(result.detail).toContain('open a session there once');
  });

  it('skips when the file is missing, and refuses to touch invalid JSON', () => {
    expect(seedClaudeProjectEntry(SOURCE, TARGET, claudeJson).action).toBe('skipped');
    fs.writeFileSync(claudeJson, '{ definitely not json');
    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('refusing');
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe('{ definitely not json');
  });

  it('skips seeding keys the source does not have (no undefined pollution)', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.seededKeys).toEqual(['hasTrustDialogAccepted']);
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect('allowedTools' in parsed.projects[TARGET]).toBe(false);
  });

  it('leaves no *.worktree-rush.*.tmp sibling behind after a successful write (atomic write contract)', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.action).toBe('seeded');
    const siblings = fs.readdirSync(tmp);
    const leftoverTmpFiles = siblings.filter((name) => /\.worktree-rush\.\d+\.tmp$/.test(name));
    expect(leftoverTmpFiles).toEqual([]);
    // and the real target is exactly what's left, holding the final content
    expect(siblings).toEqual(['claude.json']);
  });

  it('survives a concurrent writer racing between the read and the write (finding #16)', () => {
    // A real interleaving (e.g. the live SessionStart Claude process writing
    // its own ~/.claude.json state between this function's read and its
    // rename) can't be reproduced with real threads in a unit test. Instead
    // we inject the concurrent write via a spy on the first fs.readFileSync
    // call: it simulates another process landing a write (an unrelated
    // top-level counter, AND an unrelated key on a third, untouched project)
    // in the window right after our first read returns but before our
    // pre-write re-read. The fix re-reads immediately before writing, so
    // this survives; the old single-read-then-write shape would have
    // clobbered it.
    writeClaudeJson({
      projects: {
        [SOURCE]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
        '/repos/untouched': { somePriorState: 'kept' },
      },
      numStartups: 1,
    });

    const realReadFileSync = fs.readFileSync.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, 'readFileSync');
    spy.mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const out = realReadFileSync(...args);
      if (!injected && args[0] === claudeJson) {
        injected = true;
        const current = JSON.parse(out.toString());
        current.numStartups = 42; // top-level key, unrelated to any project
        current.projects['/repos/untouched'].concurrentWrite = true; // another project's entry
        fs.writeFileSync(claudeJson, JSON.stringify(current, null, 2));
      }
      return out;
    }) as typeof fs.readFileSync);

    try {
      const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
      expect(result.action).toBe('seeded');
    } finally {
      spy.mockRestore();
    }

    const final = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    // the concurrent writer's changes survived...
    expect(final.numStartups).toBe(42);
    expect(final.projects['/repos/untouched']).toEqual({
      somePriorState: 'kept',
      concurrentWrite: true,
    });
    // ...and the seed still applied
    expect(final.projects[TARGET].hasTrustDialogAccepted).toBe(true);
    expect(final.projects[TARGET].allowedTools).toEqual(['Bash']);
  });

  it('aborts without writing if the file becomes unreadable between the two reads (never clobber, per plan STOP condition)', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });

    const realReadFileSync = fs.readFileSync.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, 'readFileSync');
    spy.mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const out = realReadFileSync(...args);
      if (!injected && args[0] === claudeJson) {
        injected = true;
        // simulate a concurrent writer leaving the file corrupt/mid-write
        // right after our first read but before our pre-write re-read
        fs.writeFileSync(claudeJson, '{ not json, corrupted by a concurrent writer');
      }
      return out;
    }) as typeof fs.readFileSync);

    let result: SeedResult;
    try {
      result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    } finally {
      spy.mockRestore();
    }

    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('unreadable');
    // never clobbered: the concurrent writer's (corrupt) content is untouched
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe(
      '{ not json, corrupted by a concurrent writer',
    );
  });
});

describe('seedClaudeProjectEntry (hardening pass)', () => {
  function writeLockOwner(lockDir: string, pid: number, token: string): void {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid, token }));
  }

  it('finds the source entry under a trailing-slash or symlinked spelling of the same directory', () => {
    // Entry recorded under the REAL directory; caller passes a symlinked,
    // slash-suffixed spelling. The candidate probe must still find it.
    const realRepo = path.join(tmp, 'real-repo');
    fs.mkdirSync(realRepo);
    const linkRepo = path.join(tmp, 'linked-repo');
    fs.symlinkSync(realRepo, linkRepo, 'dir');
    writeClaudeJson({ projects: { [realRepo]: { hasTrustDialogAccepted: true } } });
    const viaLink = seedClaudeProjectEntry(`${linkRepo}${path.sep}`, TARGET, claudeJson);
    expect(viaLink.action).toBe('seeded');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[TARGET].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves a restrictive file mode across the atomic rewrite', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    fs.chmodSync(claudeJson, 0o600);
    expect(seedClaudeProjectEntry(SOURCE, TARGET, claudeJson).action).toBe('seeded');
    expect(fs.statSync(claudeJson).mode & 0o777).toBe(0o600);
  });

  it('cleans up its tmp file when the atomic rename fails (no litter, error propagates)', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const realRenameSync = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (newPath === claudeJson) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      realRenameSync(oldPath, newPath);
    });
    try {
      expect(() => seedClaudeProjectEntry(SOURCE, TARGET, claudeJson)).toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
    const leftovers = fs.readdirSync(tmp).filter((n) => n.includes('.worktree-rush.'));
    expect(leftovers).toEqual([]);
  });

  it('reclaims a lock only after its recorded owner is dead', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const lockDir = `${claudeJson}.worktree-rush.lock`;
    writeLockOwner(lockDir, 99_999_999, 'dead-owner');

    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    expect(result.action).toBe('seeded');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('does not reclaim an old lock from a live owner and skips the state update', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const lockDir = `${claudeJson}.worktree-rush.lock`;
    writeLockOwner(lockDir, process.pid, 'live-owner');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, past, past);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(100_000)
      .mockReturnValueOnce(100_000)
      .mockReturnValue(103_000);

    let result: SeedResult;
    try {
      result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);
    } finally {
      clock.mockRestore();
    }

    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('could not acquire');
    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[TARGET]).toBeUndefined();
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it('claims an empty lock directory left by a crashed initializer (no permanent skip)', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const lockDir = `${claudeJson}.worktree-rush.lock`;
    fs.mkdirSync(lockDir); // crashed between directory creation and owner record

    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);

    expect(result.action).toBe('seeded');
    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[TARGET]).toBeDefined();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('sweeps a staging directory stranded by a dead initializer', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const lockDir = `${claudeJson}.worktree-rush.lock`;
    const staging = `${lockDir}.staging.999999999-deadbeef`;
    fs.mkdirSync(staging);

    const result = seedClaudeProjectEntry(SOURCE, TARGET, claudeJson);

    expect(result.action).toBe('seeded');
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('does not delete a successor lock when ownership changes before release', () => {
    writeClaudeJson({ projects: { [SOURCE]: { hasTrustDialogAccepted: true } } });
    const lockDir = `${claudeJson}.worktree-rush.lock`;
    const ownerPath = path.join(lockDir, 'owner.json');
    const realRenameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      realRenameSync(oldPath, newPath);
      if (newPath === claudeJson) {
        fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: 'successor' }));
      }
    });

    try {
      expect(seedClaudeProjectEntry(SOURCE, TARGET, claudeJson).action).toBe('seeded');
    } finally {
      rename.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token).toBe('successor');
    expect(fs.existsSync(lockDir)).toBe(true);
  });
});

describe('pruneClaudeProjectEntry', () => {
  it('removes exactly the worktree entry, atomically, leaving everything else', () => {
    writeClaudeJson({
      projects: {
        [SOURCE]: { hasTrustDialogAccepted: true },
        [TARGET]: { hasTrustDialogAccepted: true },
      },
      numStartups: 7,
    });
    const result = pruneClaudeProjectEntry(TARGET, claudeJson);
    expect(result.action).toBe('pruned');
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(parsed.projects[TARGET]).toBeUndefined();
    expect(parsed.projects[SOURCE].hasTrustDialogAccepted).toBe(true);
    expect(parsed.numStartups).toBe(7);
  });

  it('skips when there is nothing to prune, and refuses invalid JSON', () => {
    expect(pruneClaudeProjectEntry(TARGET, claudeJson).action).toBe('skipped');
    writeClaudeJson({ projects: {} });
    expect(pruneClaudeProjectEntry(TARGET, claudeJson).action).toBe('skipped');
    fs.writeFileSync(claudeJson, '{ nope');
    const result = pruneClaudeProjectEntry(TARGET, claudeJson);
    expect(result.action).toBe('skipped');
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe('{ nope');
  });
});

describe('copySettingsLocal', () => {
  function makeCopyFixture(): { source: string; target: string } {
    const source = path.join(tmp, 'repo');
    const target = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(source, '.claude'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, '.claude', 'settings.local.json'), '{"permissions":{}}');
    return { source, target };
  }

  it('copies normally when the destination does not exist', () => {
    const { source, target } = makeCopyFixture();
    expect(copySettingsLocal(source, target).action).toBe('copied');
    expect(fs.readFileSync(path.join(target, '.claude', 'settings.local.json'), 'utf8')).toBe(
      '{"permissions":{}}',
    );
  });

  it('skips an existing regular destination file without overwriting it', () => {
    const { source, target } = makeCopyFixture();
    fs.mkdirSync(path.join(target, '.claude'));
    fs.writeFileSync(path.join(target, '.claude', 'settings.local.json'), '{"diverged":true}');
    expect(copySettingsLocal(source, target).action).toBe('skipped');
    expect(fs.readFileSync(path.join(target, '.claude', 'settings.local.json'), 'utf8')).toBe(
      '{"diverged":true}',
    );
  });

  it('skips when the source has none', () => {
    const source = path.join(tmp, 'repo2');
    fs.mkdirSync(source, { recursive: true });
    expect(copySettingsLocal(source, path.join(tmp, 'wt2')).action).toBe('skipped');
  });

  it('refuses a dangling destination symlink without creating its target', () => {
    const { source, target } = makeCopyFixture();
    const outside = path.join(tmp, 'outside-settings.json');
    const targetDir = path.join(target, '.claude');
    fs.mkdirSync(targetDir);
    fs.symlinkSync(outside, path.join(targetDir, 'settings.local.json'));

    expect(() => copySettingsLocal(source, target)).toThrow(/symbolic link/i);
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.lstatSync(path.join(targetDir, 'settings.local.json')).isSymbolicLink()).toBe(true);
  });

  it('refuses a symlinked .claude destination directory', () => {
    const { source, target } = makeCopyFixture();
    const outside = path.join(tmp, 'outside-claude');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, '.claude'), 'dir');

    expect(() => copySettingsLocal(source, target)).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outside, 'settings.local.json'))).toBe(false);
  });
});

const swappedFlag = { value: false };

describe('cleanupFailedSettingsCopy (Lyra P2: swapped-directory cleanup race)', () => {
  it('removes the created file when the path is intact', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const dir = path.join(root, '.claude');
    await fs.promises.mkdir(dir);
    const target = path.join(dir, 'settings.local.json');
    const fd = fs.openSync(target, 'wx');
    const st = fs.fstatSync(fd);
    fs.closeSync(fd);
    cleanupFailedSettingsCopy(dir, target, { dev: st.dev, ino: st.ino });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never removes through a swapped .claude symlink (external file survives)', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const external = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-external-'));
    const externalFile = path.join(external, 'settings.local.json');
    await fs.promises.writeFile(externalFile, 'external\n');
    const linkDir = path.join(root, '.claude');
    await fs.promises.symlink(external, linkDir, 'dir');
    cleanupFailedSettingsCopy(linkDir, path.join(linkDir, 'settings.local.json'), {
      dev: 1,
      ino: 1,
    });
    expect(await fs.promises.readFile(externalFile, 'utf8')).toBe('external\n');
  });

  it('skips removal when the entry is no longer our inode', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const dir = path.join(root, '.claude');
    await fs.promises.mkdir(dir);
    const target = path.join(dir, 'settings.local.json');
    await fs.promises.writeFile(target, 'someone else\n');
    cleanupFailedSettingsCopy(dir, target, { dev: 0, ino: 0 });
    expect(fs.existsSync(target)).toBe(true);
  });

  it('cannot be redirected by a real-directory replacement after validation', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const dir = path.join(root, '.claude');
    await fs.promises.mkdir(dir);
    const target = path.join(dir, 'settings.local.json');
    const fd = fs.openSync(target, 'wx');
    const st = fs.fstatSync(fd);
    fs.closeSync(fd);
    const replacement = path.join(root, '.claude-replacement');
    await fs.promises.mkdir(replacement);
    await fs.promises.writeFile(path.join(replacement, 'settings.local.json'), 'replacement\n');
    const realOpen = fs.openSync.bind(fs);
    const spy = vi
      .spyOn(fs, 'openSync')
      .mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p) === dir && !swappedFlag.value) {
          swappedFlag.value = true;
          fs.rmSync(dir, { recursive: true, force: true });
          fs.renameSync(replacement, dir);
        }
        return (realOpen as (a: fs.PathLike, ...b: unknown[]) => number)(p, ...rest);
      });
    try {
      cleanupFailedSettingsCopy(dir, target, { dev: st.dev, ino: st.ino });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.promises.readFile(target, 'utf8')).toBe('replacement\n');
  });

  it('fails closed instead of removing through a mutable parent (non-fd platforms)', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const dir = path.join(root, '.claude');
    await fs.promises.mkdir(dir);
    const target = path.join(dir, 'settings.local.json');
    const fd = fs.openSync(target, 'wx');
    const st = fs.fstatSync(fd);
    fs.closeSync(fd);
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      cleanupFailedSettingsCopy(dir, target, { dev: st.dev, ino: st.ino });
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
    // Fail closed: the entry stays put; nothing is removed via a mutable parent.
    expect(fs.existsSync(target)).toBe(true);
  });

  it('uses the fd-relative unlink on darwin (/dev/fd)', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const dir = path.join(root, '.claude');
    await fs.promises.mkdir(dir);
    const target = path.join(dir, 'settings.local.json');
    const fd = fs.openSync(target, 'wx');
    const st = fs.fstatSync(fd);
    fs.closeSync(fd);
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      cleanupFailedSettingsCopy(dir, target, { dev: st.dev, ino: st.ino });
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cannot be redirected by a swap after the lstat checks (descriptor-pinned removal)', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-cleanup-'));
    const dir = path.join(root, '.claude');
    await fs.promises.mkdir(dir);
    const target = path.join(dir, 'settings.local.json');
    const fd = fs.openSync(target, 'wx');
    const st = fs.fstatSync(fd);
    fs.closeSync(fd);
    const external = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-external-'));
    const externalFile = path.join(external, 'settings.local.json');
    await fs.promises.writeFile(externalFile, 'external\n');

    // Perform the swap INSIDE the check-to-use interval: after the file's
    // lstat has been taken but before the removal call.
    const realLstat = fs.lstatSync.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((p: fs.PathLike) => {
      const out = realLstat(p as string);
      if (!swapped && String(p).endsWith('/settings.local.json')) {
        swapped = true;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.symlinkSync(external, dir, 'dir');
      }
      return out;
    });
    cleanupFailedSettingsCopy(dir, target, { dev: st.dev, ino: st.ino });
    spy.mockRestore();
    expect(await fs.promises.readFile(externalFile, 'utf8')).toBe('external\n');
  });

  it('copySettingsLocal: a mid-copy directory swap never deletes the external target', async () => {
    const sourceRepo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-source-'));
    await fs.promises.mkdir(path.join(sourceRepo, '.claude'));
    await fs.promises.writeFile(path.join(sourceRepo, '.claude', 'settings.local.json'), '{}\n');
    const worktree = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-wt-'));
    const claudeDir = path.join(worktree, '.claude');
    const external = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-external-'));
    const externalFile = path.join(external, 'settings.local.json');
    await fs.promises.writeFile(externalFile, 'external\n');
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      fs.rmSync(claudeDir, { recursive: true, force: true });
      fs.symlinkSync(external, claudeDir, 'dir');
      throw new Error('injected mid-copy failure');
    });
    expect(() => copySettingsLocal(sourceRepo, worktree)).toThrow(/injected/);
    spy.mockRestore();
    expect(await fs.promises.readFile(externalFile, 'utf8')).toBe('external\n');
  });
});
