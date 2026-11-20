import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/hook.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  // Suppress the benign 'TS7 API is experimental' notice so builds are
  // warning-free and therefore Rush-build-cacheable (real warnings still fail
  // via tsdown's default --fail-on-warn).
  logLevel: 'error',
});
