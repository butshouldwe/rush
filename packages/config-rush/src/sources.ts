import path from 'node:path';
import { RigConfig } from '@rushstack/rig-package';
import { contained } from './json.js';
import { resource, type Resource } from './registry.js';
import type { Registry } from './types.js';
import { ReadContext, liveReads } from './read-context.js';

/** Source selection is shared by value resolution and authoring relationship checks. */
export function discoverSource(
  root: string,
  folder: string,
  projectFile: string,
  reads: ReadContext = liveReads,
) {
  const local = path.resolve(folder, projectFile);
  const present = reads.exists(local);
  const localIdentity = present ? reads.realpath(local) : undefined;
  let start: Resource | undefined;
  if (present) start = { file: contained(folder, projectFile, reads), boundary: root };
  else {
    reads.observePath(path.join(folder, 'config/rig.json'));
    const rig = RigConfig.loadForProjectFolder({ projectFolderPath: folder, bypassCache: true });
    if (rig.rigFound) {
      reads.observePackageSearch(folder, rig.rigPackageName);
      const profile = rig.getResolvedProfileFolder();
      reads.observePath(path.resolve(profile, '../../package.json'));
      if (reads.exists(path.resolve(profile, projectFile)))
        start = {
          file: contained(profile, projectFile, reads),
          boundary: reads.realpath(path.resolve(profile, '../..')),
        };
    }
  }
  return { local, localIdentity, start };
}

/** Both consumers use identical explicit inheritance and admitted-resource boundaries. */
export function sourceParent(
  root: string,
  registry: Registry,
  current: Resource,
  reference: string | undefined,
  reads: ReadContext = liveReads,
): Resource | undefined {
  return reference === undefined
    ? undefined
    : resource(root, registry, reference, path.dirname(current.file), current.boundary, reads);
}
