export interface Diagnostic {
  kind?: 'execution' | 'validation';
  code: string;
  severity?: 'error' | 'warning' | 'skipped';
  validator?: string;
  contractVersion?: string;
  nextAction?: string;
  message: string;
  file?: string;
  pointer?: string;
  offset?: number;
  relatedOffset?: number;
  project?: string;
  domain?: string;
}

export class ConfigurationError extends Error {
  readonly _tag = 'ConfigurationError';
  constructor(
    readonly diagnostics: readonly Diagnostic[],
    readonly checks: readonly ValidatorCheck[] = [],
  ) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
    this.name = 'ConfigurationError';
  }
}

export interface Query {
  project: string;
  domain: string;
  optional?: boolean;
}
export interface Origin {
  authoredLocally: boolean;
  source: string;
  contractVersion: string;
}
export interface ResolvedConfiguration {
  project: string;
  domain: string;
  contractVersion: string;
  absent: boolean;
  values: Record<string, unknown> | null;
  sources: string[];
  provenance: Record<string, Origin>;
  suppressed: Record<string, Origin>;
  paths?: Record<string, ResolvedPath>;
  checks?: readonly ValidatorCheck[];
  diagnostics?: readonly Diagnostic[];
}
export interface ValidatorCheck {
  validator: string;
  project: string;
  domain: string;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
}
export interface Explanation {
  evaluated: { project: string; domain: string }[];
  project: string;
  domain: string;
  valid: boolean;
  result: ResolvedConfiguration | null;
  checks?: readonly ValidatorCheck[];
  sources: string[];
  diagnostics: readonly Diagnostic[];
}
export interface ValidationResult {
  valid: boolean;
  checks?: readonly ValidatorCheck[];
  evaluated: { project: string; domain: string }[];
  diagnostics: readonly Diagnostic[];
}
export type PathBase = 'project' | 'repository' | 'source';
export interface PathRoot {
  base: PathBase;
  path: string;
}
export interface PathRule {
  base: PathBase;
  allowedRoots: PathRoot[];
  mustExist: boolean;
  symlinks: 'reject' | 'within-roots';
}
export interface ResolvedPath {
  authored: string;
  resolved: string;
  base: PathBase;
  source: string;
  exists: boolean;
  kind: 'file' | 'directory' | 'other' | 'missing';
}
export interface VersionContract {
  schema: string;
  fragmentSchema?: string;
  resources?: string[];
  paths?: Record<string, PathRule>;
  projectOwned?: string[];
  validators?: string[];
  merge?: Record<string, 'replace' | 'merge' | 'append'>;
}
export interface Domain {
  name: string;
  projectFile: string;
  required?: boolean;
  versions: Record<string, VersionContract>;
}
export interface ValidatorAdmission {
  module: string;
  export: string;
  scope: 'project';
  inputs: Record<string, PathRule & { path: string }>;
}
export interface ValidatorContext {
  readonly values: Readonly<Record<string, unknown>>;
  readonly project: Readonly<{ name: string; folder: string }>;
  readonly repository: string;
  readonly domain: string;
  readonly contractVersion: string;
  readonly paths: Readonly<Record<string, ResolvedPath>>;
  inspect(name: string): Readonly<ResolvedPath>;
}
export interface ValidatorDiagnostic {
  code: string;
  message: string;
  pointer?: string;
  severity?: 'warning' | 'error';
  nextAction?: string;
}
export type SemanticValidator = (
  context: ValidatorContext,
) => readonly ValidatorDiagnostic[] | Promise<readonly ValidatorDiagnostic[]>;
export interface Registry {
  formatVersion: 1;
  packages?: Record<string, string>;
  validators?: Record<string, ValidatorAdmission>;
  domains: Domain[];
}
export interface Project {
  packageName: string;
  projectFolder: string;
}
export interface Envelope {
  formatVersion: 1;
  domain: string;
  contractVersion: string;
  extends?: string;
  suppress?: string[];
  values?: Record<string, unknown>;
}
