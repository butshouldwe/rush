export { scan, type ScanOptions, type ProcessRunner } from './scan.js';
export {
  aggregateFindings,
  buildRollup,
  findingsFromCheck,
  attributePath,
  RUSH_PLUMBING,
  UNATTRIBUTED,
  type BuildRollupInput,
} from './rollup.js';
export {
  writeReports,
  monorepoMarkdown,
  projectMarkdown,
  projectFileBase,
  ScopeConflictError,
  type WriteReportsOptions,
} from './report.js';
export { findRushRepo, parseJsonc } from './rushRepo.js';
export { fallowBin, fallowMcpBin, fallowVersion, fallowPackageDir } from './fallowBin.js';
// changeDetection.ts (the Rush-native change-detection seam) is deliberately
// NOT re-exported: its v2 signature isn't settled, so publishing the stub
// would turn an internal seam into breaking-change surface.
export type * from './types.js';
