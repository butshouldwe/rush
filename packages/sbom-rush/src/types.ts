/** A CycloneDX JSON document. Only the fields sbom-rush reads/writes are typed. */
export interface CdxComponent {
  type: string;
  name: string;
  version?: string;
  purl?: string;
  'bom-ref'?: string;
  description?: string;
  properties?: Array<{ name: string; value: string }>;
  [key: string]: unknown;
}

export interface CdxDependency {
  ref: string;
  dependsOn?: string[];
}

/** Legacy CycloneDX metadata.tools array entry (the pre-1.5 `tool` shape —
 * its schema forbids component fields like `type`). */
export interface CdxTool {
  vendor?: string;
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface CdxBom {
  $schema?: string;
  bomFormat: string;
  specVersion: string;
  serialNumber?: string;
  version: number;
  metadata?: {
    timestamp?: string;
    tools?: { components?: CdxComponent[] } | CdxTool[];
    component?: CdxComponent;
    properties?: Array<{ name: string; value: string }>;
    [key: string]: unknown;
  };
  components?: CdxComponent[];
  dependencies?: CdxDependency[];
  [key: string]: unknown;
}

/** A Rush project as declared in rush.json. */
export interface RushProject {
  packageName: string;
  projectFolder: string;
}

/** The parts of rush.json sbom-rush needs. */
export interface RushRepo {
  /** Absolute path to the folder containing rush.json. */
  rushJsonFolder: string;
  pnpmVersion?: string;
  npmVersion?: string;
  yarnVersion?: string;
  projects: RushProject[];
}

/** One rush deploy scenario (deploy-<name>.json). */
export interface DeployScenario {
  name: string;
  /** Absolute path to the scenario config file. */
  configPath: string;
  deploymentProjectNames: string[];
  includeDevDependencies: boolean;
  /** Absolute path to the deploy output folder, once resolved. */
  targetFolder?: string;
}

/** rush deploy's extractor-metadata.json — ground truth for what shipped. */
export interface ExtractorMetadata {
  mainProjectName: string;
  projects: Array<{ projectName: string; path: string }>;
  links?: Array<{ kind: string; linkPath: string; targetPath: string }>;
  files?: string[];
}

export type LadderRung = 1 | 2 | 3;

export interface RungAttempt {
  rung: LadderRung;
  method: string;
  outcome: 'succeeded' | 'failed' | 'unavailable';
  detail: string;
}

export interface ScenarioResult {
  scenario: string;
  mainProject: string;
  attempts: RungAttempt[];
  /** Set when a rung succeeded. */
  bom?: CdxBom;
  outFile?: string;
  sha256?: string;
  componentCount?: number;
  valid?: boolean;
  validationErrors?: string[];
  ntia?: NtiaReport;
  error?: string;
}

export interface NtiaField {
  field: string;
  present: boolean;
  detail: string;
}

export interface NtiaReport {
  fields: NtiaField[];
  satisfied: boolean;
}
