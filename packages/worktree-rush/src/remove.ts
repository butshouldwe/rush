import fs from 'node:fs';
import path from 'node:path';
import { pruneClaudeProjectEntry, type PruneResult } from './claudeState.js';
import {
  checkAncestor,
  resolveCommitOid,
  resolveTreeOid,
  validateBranchName,
  worktreePathFor,
} from './gitWorktree.js';
import { mainRootOf } from './rushRepo.js';
import {
  formatStageReport,
  makeStageRunner,
  runProcess,
  UsageError,
  type ProcessRunner,
  type Stage,
} from './stages.js';
import { canonicalSource } from './worktree.js';

export type RemovalProof = 'ancestry' | 'tree-equivalent' | 'forced' | 'not-needed';

/** Opaque authorization produced by the read-only preflight. Destructive
 * stages receive this token, never an unchecked CLI ref. */
interface RemovalAuthorization {
  proof: RemovalProof;
  branchOid?: string;
  resolvedTargetOid?: string;
  worktreeBranch?: string;
  worktreeHeadOid?: string;
  worktreePresent: boolean;
}

type WorktreeHeadInspection =
  | { ok: true; branch?: string; oid: string }
  | { ok: false; detail: string };

function inspectWorktreeHead(worktreePath: string, exec: ProcessRunner): WorktreeHeadInspection {
  const symbolic = exec('git', ['symbolic-ref', '-q', 'HEAD'], worktreePath);
  if (symbolic.error) return { detail: symbolic.error.message, ok: false };
  const branch = symbolic.stdout.trim();
  if (
    !(
      (symbolic.status === 0 && /^refs\/heads\/[^\r\n]+$/.test(branch)) ||
      (symbolic.status === 1 && branch.length === 0)
    )
  ) {
    return {
      detail: (symbolic.stderr || symbolic.stdout).trim() || 'could not inspect worktree HEAD',
      ok: false,
    };
  }

  const head = resolveCommitOid(worktreePath, 'HEAD', exec, 'worktree HEAD');
  if (!head.ok) return { detail: head.detail, ok: false };
  return { ...(branch.length === 0 ? {} : { branch }), oid: head.oid, ok: true };
}

function parseCheckedOutBranches(output: string): Set<string> | undefined {
  const normalized = output.replaceAll('\r\n', '\n').trimEnd();
  if (normalized.length === 0) return undefined;
  const branches = new Set<string>();
  for (const record of normalized.split('\n\n')) {
    const lines = record.split('\n');
    if (lines[0]?.startsWith('worktree ') !== true || lines[0].length === 'worktree '.length) {
      return undefined;
    }
    let foundBranch = false;
    for (const line of lines.slice(1)) {
      if (line === 'branch' || line.startsWith('branch ')) {
        if (foundBranch || !/^branch refs\/heads\/.+$/.test(line)) return undefined;
        branches.add(line.slice('branch '.length));
        foundBranch = true;
      }
    }
  }
  return branches;
}

export function deleteBranchAtomically(
  repoRoot: string,
  branch: string,
  expectedOid: string,
  exec: ProcessRunner = runProcess,
) {
  validateBranchName(branch);
  const branchRef = `refs/heads/${branch}`;
  const listed = exec('git', ['worktree', 'list', '--porcelain'], repoRoot);
  if (listed.error) {
    return { detail: `${listed.error.message}; refusing to delete branch`, ok: false };
  }
  if (listed.status !== 0) {
    const tail = (listed.stderr || listed.stdout).trim().slice(0, 400);
    return {
      detail: `${tail || 'could not inspect checked-out branches'}; refusing to delete branch`,
      ok: false,
    };
  }
  const checkedOutBranches = parseCheckedOutBranches(listed.stdout);
  if (checkedOutBranches === undefined) {
    return { detail: 'could not parse worktree list; refusing to delete branch', ok: false };
  }
  if (checkedOutBranches.has(branchRef)) {
    return { detail: 'branch is checked out in a worktree; refusing to delete it', ok: false };
  }

  const deleted = exec('git', ['update-ref', '-d', branchRef, expectedOid], repoRoot);
  if (deleted.error) {
    return { detail: `${deleted.error.message}; refusing to delete branch`, ok: false };
  }
  if (deleted.status !== 0) {
    const tail = (deleted.stderr || deleted.stdout).trim().slice(0, 400);
    return {
      detail: `${tail || 'branch changed during deletion'}; refusing to delete branch`,
      ok: false,
    };
  }
  // The checkout guard above and this deletion are separate Git processes: a
  // linked worktree can check the branch out between them, and update-ref has
  // no checkout guard of its own. Re-inspect after the deletion; if a checkout
  // appeared (or the state cannot be verified), restore the ref at the exact
  // OID and refuse, so no active checkout is ever left pointing at a deleted
  // branch.
  const recheck = exec('git', ['worktree', 'list', '--porcelain'], repoRoot);
  const rechecked =
    !recheck.error && recheck.status === 0 ? parseCheckedOutBranches(recheck.stdout) : undefined;
  if (rechecked === undefined || rechecked.has(branchRef)) {
    // Compare-and-create: expected old value = absent ref. If another actor
    // recreated the branch after our deletion, the restore must NOT overwrite
    // their ref - refuse and leave their branch untouched.
    const restore = exec('git', ['update-ref', branchRef, expectedOid, '0'.repeat(40)], repoRoot);
    if (restore.error || restore.status !== 0) {
      return {
        detail:
          'branch restore refused (recreated by another actor, or write failed); ref left untouched',
        ok: false,
      };
    }
    return {
      detail:
        rechecked === undefined
          ? 'could not verify post-deletion state; branch restored'
          : 'branch was checked out during deletion; ref restored',
      ok: false,
    };
  }

  return { detail: `deleted branch ${branch}`, ok: true };
}

export interface RemoveOptions {
  branch: string;
  /** Source checkout the worktree belongs to. Default: the repo the command runs in. */
  from?: string;
  /** Remove a dirty worktree and delete an unmerged branch (git's own
   * --force semantics for both). */
  force?: boolean;
  /** Local merge commit or ref used to prove ancestry or exact tree
   * equivalence before any removal. No fetch or remote inference occurs. */
  mergedInto?: string;
  /** Override the ~/.claude.json location (tests). */
  claudeJsonPath?: string;
}

export interface RemoveResult {
  worktreePath: string;
  branch: string;
  stages: Stage[];
  ok: boolean;
  removalProof?: RemovalProof;
  resolvedTargetOid?: string;
  claudePrune?: PruneResult;
}

/**
 * The symmetric inverse of `create` (2026-07-23 hardening decision Q7):
 * create seeds, remove unseeds. Converge-flavored like create — an
 * already-absent worktree or branch is success, not an error, so re-running
 * after a partial failure finishes the job.
 *
 *  1. read-only removal preflight: dirty check, branch/target resolution,
 *     then ancestry or exact-tree proof
 *  2. git worktree remove
 *  3. branch delete (authorized by the proof token; already-gone is ok)
 *  4. state prune: ~/.claude.json entry for the path + `git worktree prune`
 *     + empty parent dirs under .worktrees/<repo>/ for nested branch names
 */
export function removeWorktree(
  sourceRoot: string,
  options: RemoveOptions,
  exec: ProcessRunner = runProcess,
): RemoveResult {
  validateBranchName(options.branch);
  if (options.force && options.mergedInto !== undefined) {
    throw new UsageError('--merged-into and --force are mutually exclusive');
  }
  const from = mainRootOf(canonicalSource(options.from ?? sourceRoot));
  const worktreePath = worktreePathFor(from, options.branch);
  const stages: Stage[] = [];
  const stage = makeStageRunner(stages);

  const result: RemoveResult = { worktreePath, branch: options.branch, stages, ok: false };

  // An explicit target is always resolved before even the read-only worktree
  // and branch probes. Invalid/ambiguous/non-commit input is a usage error and
  // can never produce a partial cleanup.
  if (options.mergedInto !== undefined) {
    const target = resolveCommitOid(from, options.mergedInto, exec, 'merge target');
    if (!target.ok) {
      if (target.error) throw target.error;
      throw new UsageError(target.detail);
    }
    result.resolvedTargetOid = target.oid;
  }

  let authorization: RemovalAuthorization | undefined;
  const preflight = stage('removal-preflight', () => {
    const worktreePresent = fs.existsSync(worktreePath);
    const branchRef = `refs/heads/${options.branch}`;
    const branchProbe = exec('git', ['rev-parse', '--verify', '--quiet', branchRef], from);
    if (branchProbe.error) {
      return { detail: branchProbe.error.message, ok: false };
    }
    if (branchProbe.status !== 0 && branchProbe.status !== 1) {
      return {
        detail: (branchProbe.stderr || branchProbe.stdout).trim() || 'could not inspect branch',
        ok: false,
      };
    }
    const branchPresent = branchProbe.status === 0;

    let worktreeBranch: string | undefined;
    let worktreeHeadOid: string | undefined;

    if (worktreePresent) {
      const head = inspectWorktreeHead(worktreePath, exec);
      if (!head.ok) return { detail: head.detail, ok: false };
      worktreeBranch = head.branch;
      worktreeHeadOid = head.oid;
      if (worktreeBranch !== undefined && worktreeBranch !== branchRef) {
        return {
          detail: `worktree is on a different branch (${worktreeBranch}); refusing to remove it as ${branchRef}`,
          ok: false,
        };
      }

      const dirty = exec('git', ['status', '--porcelain'], worktreePath);
      if (dirty.error) return { detail: dirty.error.message, ok: false };
      if (dirty.status !== 0) {
        return {
          detail: (dirty.stderr || dirty.stdout).trim() || 'could not inspect worktree state',
          ok: false,
        };
      }
      if (dirty.stdout.length > 0 && !options.force) {
        return {
          detail: `worktree is dirty; commit or stash changes, or re-run with --force`,
          ok: false,
        };
      }
    }

    if (!worktreePresent && !branchPresent) {
      authorization = {
        proof: 'not-needed',
        worktreePresent,
        ...(result.resolvedTargetOid === undefined
          ? {}
          : { resolvedTargetOid: result.resolvedTargetOid }),
      };
      return {
        detail: `proof not needed; worktree and branch are already absent${
          result.resolvedTargetOid ? ` · target ${result.resolvedTargetOid}` : ''
        }`,
        ok: true,
      };
    }

    if (options.force) {
      let branchOid: string | undefined;
      if (branchPresent) {
        const branch = resolveCommitOid(from, branchRef, exec, 'branch');
        if (!branch.ok) return { detail: branch.detail, ok: false };
        branchOid = branch.oid;
      }
      authorization = {
        proof: 'forced',
        worktreePresent,
        ...(branchOid === undefined ? {} : { branchOid }),
        ...(worktreeBranch === undefined ? {} : { worktreeBranch }),
        ...(worktreeHeadOid === undefined ? {} : { worktreeHeadOid }),
      };
      return {
        detail:
          worktreeBranch === undefined && worktreeHeadOid !== undefined
            ? `proof forced by --force · warning: forced; detached HEAD ${worktreeHeadOid} carries no merge proof`
            : 'proof forced by --force',
        ok: true,
      };
    }

    // A clean worktree can outlive an already-removed branch. There is no
    // branch history left to prove or delete, so authorize only the path and
    // state convergence.
    if (!branchPresent) {
      if (worktreeBranch === undefined && worktreeHeadOid !== undefined) {
        let targetOid = result.resolvedTargetOid;
        if (targetOid === undefined) {
          const target = resolveCommitOid(from, 'HEAD', exec, 'source HEAD');
          if (!target.ok) return { detail: target.detail, ok: false };
          targetOid = target.oid;
          result.resolvedTargetOid = targetOid;
        }
        const containment = checkAncestor(from, worktreeHeadOid, targetOid, exec);
        if (!containment.ok) return { detail: containment.detail, ok: false };
        if (!containment.isAncestor) {
          return {
            detail: `detached HEAD ${worktreeHeadOid} has unproven commits; refusing to remove it`,
            ok: false,
          };
        }
      }
      authorization = {
        proof: 'not-needed',
        worktreePresent,
        ...(result.resolvedTargetOid === undefined
          ? {}
          : { resolvedTargetOid: result.resolvedTargetOid }),
        ...(worktreeBranch === undefined ? {} : { worktreeBranch }),
        ...(worktreeHeadOid === undefined ? {} : { worktreeHeadOid }),
      };
      return { detail: 'proof not needed; branch is already absent', ok: true };
    }

    const branch = resolveCommitOid(from, branchRef, exec, 'branch');
    if (!branch.ok) return { detail: branch.detail, ok: false };

    let targetOid = result.resolvedTargetOid;
    if (targetOid === undefined) {
      const target = resolveCommitOid(from, 'HEAD', exec, 'source HEAD');
      if (!target.ok) return { detail: target.detail, ok: false };
      targetOid = target.oid;
      result.resolvedTargetOid = targetOid;
    }

    if (worktreeBranch === undefined && worktreeHeadOid !== undefined) {
      const containment = checkAncestor(from, worktreeHeadOid, targetOid, exec);
      if (!containment.ok) return { detail: containment.detail, ok: false };
      if (!containment.isAncestor) {
        return {
          detail: `detached HEAD ${worktreeHeadOid} has unproven commits; refusing to remove it`,
          ok: false,
        };
      }
    }

    const ancestry = checkAncestor(from, branch.oid, targetOid, exec);
    if (!ancestry.ok) return { detail: ancestry.detail, ok: false };
    if (ancestry.isAncestor) {
      authorization = {
        proof: 'ancestry',
        branchOid: branch.oid,
        resolvedTargetOid: targetOid,
        ...(worktreeBranch === undefined ? {} : { worktreeBranch }),
        ...(worktreeHeadOid === undefined ? {} : { worktreeHeadOid }),
        worktreePresent,
      };
      return { detail: `proof ancestry · target ${targetOid}`, ok: true };
    }

    if (options.mergedInto === undefined) {
      return {
        detail:
          'branch is not an ancestor of source HEAD; pass --merged-into <exact-merge-commit> for a squash merge or --force',
        ok: false,
      };
    }

    const branchTree = resolveTreeOid(from, branch.oid, exec);
    if (!branchTree.ok) return { detail: branchTree.detail, ok: false };
    const targetTree = resolveTreeOid(from, targetOid, exec);
    if (!targetTree.ok) return { detail: targetTree.detail, ok: false };
    if (branchTree.oid !== targetTree.oid) {
      return {
        detail: `branch is neither an ancestor nor tree-equivalent to target ${targetOid}`,
        ok: false,
      };
    }

    authorization = {
      proof: 'tree-equivalent',
      branchOid: branch.oid,
      resolvedTargetOid: targetOid,
      ...(worktreeBranch === undefined ? {} : { worktreeBranch }),
      ...(worktreeHeadOid === undefined ? {} : { worktreeHeadOid }),
      worktreePresent,
    };
    return { detail: `proof tree-equivalent · target ${targetOid}`, ok: true };
  });
  if (!preflight || authorization === undefined) return result;
  const authorized = authorization;
  result.removalProof = authorized.proof;

  const removed = stage('git-worktree-remove', () => {
    if (!fs.existsSync(worktreePath)) {
      return { detail: 'already absent', ok: true };
    }
    if (!authorized.worktreePresent) {
      return { detail: 'worktree appeared after preflight; refusing to remove it', ok: false };
    }
    const head = inspectWorktreeHead(worktreePath, exec);
    if (!head.ok) return { detail: head.detail, ok: false };
    if (head.branch !== authorized.worktreeBranch) {
      return { detail: 'worktree branch moved after preflight; refusing to remove it', ok: false };
    }
    if (head.oid !== authorized.worktreeHeadOid) {
      return { detail: 'worktree HEAD moved after preflight; refusing to remove it', ok: false };
    }
    const args = ['worktree', 'remove'];
    if (authorized.proof === 'forced') args.push('--force');
    args.push(worktreePath);
    const r = exec('git', args, from);
    if (r.error) return { detail: String(r.error.message), ok: false };
    if (r.status !== 0) {
      const tail = (r.stderr || r.stdout).trim().slice(0, 400);
      return {
        detail: `${tail}${options.force ? '' : ' (re-run with --force to remove a dirty worktree)'}`,
        ok: false,
      };
    }
    return { detail: `removed ${worktreePath}`, ok: true };
  });
  if (!removed) return result;

  const branchDeleted = stage('branch-delete', () => {
    const branchProbe = exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`],
      from,
    );
    if (branchProbe.error) return { detail: branchProbe.error.message, ok: false };
    if (branchProbe.status !== 0 && branchProbe.status !== 1) {
      return {
        detail: (branchProbe.stderr || branchProbe.stdout).trim() || 'could not inspect branch',
        ok: false,
      };
    }
    const exists = branchProbe.status === 0;
    if (!exists) return { detail: 'already absent', ok: true };
    if (authorized.proof === 'not-needed' || authorized.branchOid === undefined) {
      return { detail: 'branch appeared after preflight; refusing to delete it', ok: false };
    }
    const current = resolveCommitOid(from, `refs/heads/${options.branch}`, exec, 'branch');
    if (!current.ok) return { detail: current.detail, ok: false };
    if (current.oid !== authorized.branchOid) {
      return { detail: 'branch moved after preflight; refusing to delete it', ok: false };
    }

    return deleteBranchAtomically(from, options.branch, current.oid, exec);
  });
  if (!branchDeleted) return result;

  stage('state-prune', () => {
    result.claudePrune = pruneClaudeProjectEntry(worktreePath, options.claudeJsonPath);
    exec('git', ['worktree', 'prune'], from);
    // Nested branch names (feat/x) leave empty parent dirs behind — sweep
    // them up to (but not including) .worktrees/<repo>. rmdirSync only ever
    // removes EMPTY directories, so this can't eat a sibling worktree.
    const stopAt = path.dirname(worktreePathFor(from, 'x'));
    let dir = path.dirname(worktreePath);
    while (dir.startsWith(stopAt) && dir !== stopAt) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break; // not empty (or gone) — done sweeping
      }
      dir = path.dirname(dir);
    }
    return {
      detail: `~/.claude.json: ${result.claudePrune.action} (${result.claudePrune.detail}) · git worktree prune ok`,
      ok: true,
    };
  });

  result.ok = stages.every((s) => s.ok);
  return result;
}

export function formatRemoveReport(result: RemoveResult): string {
  return formatStageReport(`removed ${result.branch} (${result.worktreePath})`, result);
}
