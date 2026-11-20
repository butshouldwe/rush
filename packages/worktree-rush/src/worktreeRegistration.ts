import fs from 'node:fs';
import path from 'node:path';

function regularFile(filePath: string): boolean {
  return fs.lstatSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

function directory(directoryPath: string): boolean {
  return fs.lstatSync(directoryPath, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Authenticate Git's two-way linked-worktree registration before any
 * path-keyed agent state is copied. A pointer into `.git/worktrees` is not
 * proof by itself: the administrative directory must be owned by the
 * expected source repository and must point back to this exact `.git` file.
 */
export function isAuthenticatedLinkedWorktree(sourceRoot: string, worktreeRoot: string): boolean {
  try {
    const sourceGitPath = path.join(fs.realpathSync(sourceRoot), '.git');
    if (!directory(sourceGitPath)) return false;
    const sourceGitDir = fs.realpathSync(sourceGitPath);

    const dotGit = path.join(worktreeRoot, '.git');
    if (!regularFile(dotGit)) return false;
    const dotGitPath = fs.realpathSync(dotGit);
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) return false;

    const namedAdminDir = path.resolve(worktreeRoot, match[1]!);
    if (!directory(namedAdminDir)) return false;
    const adminDir = fs.realpathSync(namedAdminDir);
    const worktreesDir = fs.realpathSync(path.join(sourceGitDir, 'worktrees'));
    if (path.dirname(adminDir) !== worktreesDir) return false;

    const backlinkFile = path.join(adminDir, 'gitdir');
    if (!regularFile(backlinkFile)) return false;
    const backlink = fs.readFileSync(backlinkFile, 'utf8').trim();
    if (!backlink) return false;
    const registeredDotGit = fs.realpathSync(path.resolve(adminDir, backlink));
    if (registeredDotGit !== dotGitPath) return false;

    const commonDirFile = path.join(adminDir, 'commondir');
    let commonDir: string;
    const commonDirEntry = fs.lstatSync(commonDirFile, { throwIfNoEntry: false });
    if (commonDirEntry) {
      if (!commonDirEntry.isFile()) return false;
      const commonDirPointer = fs.readFileSync(commonDirFile, 'utf8').trim();
      if (!commonDirPointer) return false;
      commonDir = fs.realpathSync(path.resolve(adminDir, commonDirPointer));
    } else {
      commonDir = fs.realpathSync(path.dirname(path.dirname(adminDir)));
    }
    return commonDir === sourceGitDir;
  } catch {
    return false;
  }
}
