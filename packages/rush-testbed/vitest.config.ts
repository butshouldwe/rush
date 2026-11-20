import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['harness/**/*.test.ts'],
    // Load-bearing: all *.integration.test.ts files share one mutable
    // fixture tree (packages/rush-testbed/fixture) — the packed autoinstaller
    // state, `rush update`'s common/temp, and each file's own deploy/report
    // output. Running files concurrently would race on that shared state;
    // isolation rests entirely on this flag plus globalSetup running once
    // before any file starts.
    fileParallelism: false,
    globalSetup: ['harness/globalSetup.ts'],
    testTimeout: 240_000,
    hookTimeout: 600_000,
  },
});
