export {
  createWorktree,
  formatReport,
  type CreateOptions,
  type CreateResult,
  type Stage,
  type ProcessRunner,
} from './worktree.js';
export {
  removeWorktree,
  formatRemoveReport,
  type RemoveOptions,
  type RemovalProof,
  type RemoveResult,
} from './remove.js';
export {
  seedClaudeProjectEntry,
  pruneClaudeProjectEntry,
  copySettingsLocal,
  defaultClaudeJsonPath,
  type SeedResult,
  type PruneResult,
  type CopyResult,
} from './claudeState.js';
export { worktreePathFor, validateBranchName } from './gitWorktree.js';
export { findRepoRoot, type RepoRoot } from './rushRepo.js';
