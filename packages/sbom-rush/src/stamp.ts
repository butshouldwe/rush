import { randomUUID } from 'node:crypto';
import type { CdxBom, CdxComponent } from './types.js';

export interface StampInfo {
  scenario: string;
  mainProject: string;
  gitSha: string;
  rung: number;
  method: string;
  toolVersion: string;
}

/**
 * §5.3: an SBOM you can trust starts with an SBOM that says how it was made.
 * Adds sbom-rush to metadata.tools, records scenario/project/SHA/rung as
 * metadata.properties, and gives the merged document a fresh serial number.
 */
export function stampBom(bom: CdxBom, info: StampInfo): CdxBom {
  const metadata = { ...bom.metadata };

  const toolComponent: CdxComponent = {
    type: 'application',
    name: '@butshouldwe/sbom-rush',
    version: info.toolVersion,
  };
  const tools = metadata.tools;
  if (Array.isArray(tools)) {
    // Legacy tools-array form: its `tool` schema forbids extra fields like
    // `type`, so append a legacy-shaped entry — a component-shaped one would
    // make the stamped document schema-invalid.
    metadata.tools = [
      ...tools,
      { vendor: 'butshouldwe', name: '@butshouldwe/sbom-rush', version: info.toolVersion },
    ];
  } else {
    metadata.tools = {
      ...tools,
      components: [...(tools?.components ?? []), toolComponent],
    };
  }

  metadata.timestamp = new Date().toISOString();
  metadata.properties = [
    ...(metadata.properties ?? []),
    { name: 'sbom-rush:scenario', value: info.scenario },
    { name: 'sbom-rush:main-project', value: info.mainProject },
    { name: 'sbom-rush:git-sha', value: info.gitSha },
    { name: 'sbom-rush:ladder-rung', value: String(info.rung) },
    { name: 'sbom-rush:generator', value: info.method },
  ];

  return {
    ...bom,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata,
  };
}
