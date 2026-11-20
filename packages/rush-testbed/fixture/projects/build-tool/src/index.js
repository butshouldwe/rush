// Dev-only tooling project: web-app depends on it via devDependencies.
// Plant #4: it must NEVER appear in `rush sbom` output (rush deploy does not
// ship devDependencies), even though pnpm's workspace filter traverses it.
import pc from 'picocolors';

export function banner(text) {
  return pc.bold(text);
}
