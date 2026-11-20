import { packAllPlugins } from './lib.js';

/**
 * Runs once before any `*.integration.test.ts` file, instead of being
 * repeated in each file's own `beforeAll` (the previous shape: three files ×
 * pack-both-plugins + reset-autoinstaller against the one shared fixture
 * tree). `fileParallelism: false` in `vitest.config.ts` is load-bearing for
 * this to be safe — see the comment there.
 *
 * Each integration file still owns its own `rush update-autoinstaller`/
 * `rush update`/`rush deploy` calls in its own `beforeAll` — those are
 * per-file state (some files skip `rush update`, relying on an earlier
 * file having already run it under `fileParallelism: false`), not shared
 * setup, and stay put.
 */
export function setup(): void {
  packAllPlugins();
}
