import fs from 'node:fs';
import path from 'node:path';

/**
 * Conventional implicit common/deploy-sbom destinations reject links from the
 * Rush root through the output directory, including internal/dangling links.
 * Missing components are accepted; only ENOENT means absent. Return the lexical
 * absolute spelling for every subsequent write, never the original argument.
 * Other API destinations and explicit outputs are caller-selected. Concurrent
 * swaps are outside this static checkout-content boundary. This local copy of
 * fallow-rush's report.ts guard has its own mutation-tested filesystem suite.
 */
export function guardDefaultOutputDir(outDir: string): string {
  const resolved = path.resolve(outDir);
  const rushRoot = path.dirname(path.dirname(resolved));
  if (resolved !== path.join(rushRoot, 'common', 'deploy-sbom')) return resolved;
  let component = rushRoot;
  for (const segment of ['', 'common', 'deploy-sbom']) {
    component = path.join(component, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(component);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const quoted = JSON.stringify(component).replace(
        /[\u007f-\u009f]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      throw new Error(`refusing default SBOM path: symlink component ${quoted}`);
    }
  }
  return resolved;
}
