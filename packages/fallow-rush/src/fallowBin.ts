import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * fallow ships as a dependency of this plugin, so the engine version is
 * pinned by the plugin's own lockstep — resolve its bins from our own
 * node_modules, never from PATH.
 */
export function fallowPackageDir(): string {
  return path.dirname(require.resolve('fallow/package.json'));
}

export function fallowBin(): string {
  const pkg = require('fallow/package.json') as { bin: Record<string, string> };
  return path.join(fallowPackageDir(), pkg.bin.fallow!);
}

export function fallowMcpBin(): string {
  const pkg = require('fallow/package.json') as { bin: Record<string, string> };
  return path.join(fallowPackageDir(), pkg.bin['fallow-mcp']!);
}

export function fallowVersion(): string {
  return (require('fallow/package.json') as { version: string }).version;
}
