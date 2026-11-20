/**
 * THE RUSH-NATIVE CHANGE-DETECTION SEAM (documented stub — RUSH-PLUGINS-PRD §6).
 *
 * v1 changed-scoping passes `--changed-since <ref>` straight through to
 * fallow, which does its own `git diff`-based file discovery. That is correct
 * but ignorant of Rush's richer model: `rush.json` project boundaries,
 * `incrementalBuildIgnoredGlobs`, changed-projects analysis
 * (`rush list --json` + the same machinery `rush build --impacted-by` uses),
 * and CI conventions like merge-base against the target branch.
 *
 * The intended v2 contract:
 *
 *   1. Ask Rush which projects changed relative to `ref`
 *      (`@microsoft/rush-lib`'s ProjectChangeAnalyzer, or
 *      `rush list --json --changed-projects-only` in newer Rush releases —
 *      pick against the real CI, not here).
 *   2. Expand to impacted consumers via the project graph when the CI policy
 *      wants "changed + downstream".
 *   3. Feed the resulting project set into the per-project pass and fallow's
 *      `--workspace` scoping for the root pass, instead of (or in addition
 *      to) the raw git ref.
 *
 * This cannot be designed honestly against the synthetic testbed: the
 * decisions that matter (merge-base policy, ignored globs, downstream
 * expansion) belong to the real monorepo's CI. The seam exists so v2 slots in
 * without touching the scan orchestration: implement this function and pass
 * its result as ScanOptions.projects.
 */
export function rushChangedProjects(_repo: { rushJsonFolder: string }, _ref: string): string[] {
  throw new Error(
    'rushChangedProjects is a documented seam, not yet implemented. v1 uses `--changed-since` passthrough. See changeDetection.ts for the v2 contract.',
  );
}
