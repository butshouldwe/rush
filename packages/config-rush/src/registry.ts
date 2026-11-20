import path from 'node:path';
import { ReadContext, liveReads } from './read-context.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertSchemaPosture, recordSchemaBases } from './schema-posture.js';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { Predicate } from 'effect';
import { pathRuleSchema } from './paths.js';
import { contained, fail, readJson } from './json.js';
import {
  ConfigurationError,
  type Domain,
  type Envelope,
  type Project,
  type Registry,
  type VersionContract,
} from './types.js';

const numericVersion = '(?:0|[1-9][0-9]*)';
const prereleaseIdentifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*)';
const version = `^${numericVersion}\\.${numericVersion}\\.${numericVersion}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*)?(?![\\s\\S])`;
const text = { type: 'string', minLength: 1 };
const contractSchema = {
  type: 'object',
  required: ['schema'],
  additionalProperties: false,
  properties: {
    schema: text,
    fragmentSchema: text,
    resources: { type: 'array', items: text, uniqueItems: true },
    merge: { type: 'object', additionalProperties: { enum: ['replace', 'merge', 'append'] } },
    paths: { type: 'object', additionalProperties: pathRuleSchema },
    projectOwned: { type: 'array', items: text, uniqueItems: true },
    validators: { type: 'array', items: text, uniqueItems: true },
  },
};
const registrySchema = {
  type: 'object',
  required: ['formatVersion', 'domains'],
  additionalProperties: false,
  properties: {
    $schema: text,
    formatVersion: { const: 1 },
    packages: { type: 'object', additionalProperties: { type: 'string', pattern: version } },
    validators: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['module', 'export', 'scope', 'inputs'],
        additionalProperties: false,
        properties: {
          module: { type: 'string', pattern: '^package:.+' },
          export: text,
          scope: { const: 'project' },
          inputs: {
            type: 'object',
            additionalProperties: {
              ...pathRuleSchema,
              required: [...pathRuleSchema.required, 'path'],
              properties: { ...pathRuleSchema.properties, path: text },
            },
          },
        },
      },
    },
    domains: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'projectFile', 'versions'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
          projectFile: text,
          required: { type: 'boolean' },
          versions: {
            type: 'object',
            minProperties: 1,
            patternProperties: { [version]: contractSchema },
            additionalProperties: false,
          },
        },
      },
    },
  },
};
const envelopeSchema = {
  type: 'object',
  required: ['formatVersion', 'domain', 'contractVersion'],
  additionalProperties: false,
  properties: {
    $schema: text,
    formatVersion: { const: 1 },
    domain: text,
    contractVersion: { type: 'string', pattern: version },
    extends: text,
    suppress: { type: 'array', items: text, uniqueItems: true },
    values: { type: 'object' },
  },
};
const meta = new Ajv2020({ allErrors: true, strict: true });
const checkRegistry = meta.compile<Registry>(registrySchema);
const checkEnvelope = meta.compile<Envelope>(envelopeSchema);
const checkRush = meta.compile<{ projects: Project[] }>({
  type: 'object',
  required: ['projects'],
  properties: {
    projects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['packageName', 'projectFolder'],
        properties: { packageName: text, projectFolder: text },
      },
    },
  },
});

export const registryFile = 'common/config/rush-plugins/config-rush-plugin.json';
export function checked<T>(validator: ValidateFunction<T>, input: unknown, file: string): T {
  if (validator(input)) return input;
  throw new ConfigurationError(
    (validator.errors ?? []).map((error) => {
      let message = error.message ?? 'Schema validation failed';
      if (typeof error.params.missingProperty === 'string')
        message = `Missing required property ${error.params.missingProperty}`;
      if (typeof error.params.additionalProperty === 'string')
        message = `Unknown property ${error.params.additionalProperty}`;
      return { code: 'SCHEMA_INVALID', message, file, pointer: error.instancePath };
    }),
  );
}
export function readRegistry(root: string, reads: ReadContext = liveReads): Registry {
  const file = contained(root, registryFile, reads);
  const registry = checked(checkRegistry, readJson(file, reads), file);
  const names = new Set<string>();
  for (const domain of registry.domains) {
    if (names.has(domain.name)) fail('DUPLICATE_DOMAIN', `Duplicate domain ${domain.name}`, file);
    names.add(domain.name);
    for (const contract of Object.values(domain.versions)) {
      for (const id of contract.validators ?? []) {
        if (!registry.validators || !Object.hasOwn(registry.validators, id))
          fail('VALIDATOR_NOT_ADMITTED', `Validator ${id} is not explicitly admitted`, file);
      }
    }
    const rel = path.normalize(domain.projectFile);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`))
      fail('PATH_ESCAPE', 'Domain file must be project-relative', file);
  }
  return registry;
}

/** Reads Rush's registered metadata without installing or shipping another Rush engine. */
export function readProjects(root: string, reads: ReadContext = liveReads): Project[] {
  const file = contained(root, 'rush.json', reads);
  const { projects } = checked(checkRush, readJson(file, reads), file);
  const names = new Set<string>();
  const folders = new Set<string>();
  for (const project of projects) {
    if (names.has(project.packageName))
      fail('DUPLICATE_PROJECT', `Duplicate project ${project.packageName}`, file);
    names.add(project.packageName);
    const folder = contained(root, project.projectFolder, reads);
    if (folders.has(folder)) fail('DUPLICATE_PROJECT', 'Project folders must be unique', file);
    folders.add(folder);
    const pkg = readJson(contained(folder, 'package.json', reads), reads);
    if (!Predicate.isObject(pkg) || pkg.name !== project.packageName)
      fail('PROJECT_NAME_MISMATCH', `Package name does not match ${project.packageName}`, file);
  }
  return projects;
}
export function envelope(file: string, reads: ReadContext = liveReads): Envelope {
  return checked(checkEnvelope, readJson(file, reads), file);
}

export interface Resource {
  file: string;
  boundary: string;
}
export function packageReferenceName(ref: string): string | undefined {
  if (!ref.startsWith('package:')) return undefined;
  const parts = ref.slice('package:'.length).split('/');
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
export function resource(
  root: string,
  registry: Registry,
  ref: string,
  base = root,
  boundary = root,
  reads: ReadContext = liveReads,
): Resource {
  if (/^https?:/iu.test(ref) || path.isAbsolute(ref))
    return fail(
      'RESOURCE_REF_INVALID',
      'Use a local relative resource or an admitted package: reference',
    );
  if (!ref.startsWith('package:'))
    return {
      file: contained(boundary, path.relative(boundary, path.resolve(base, ref)), reads),
      boundary,
    };
  const specifier = ref.slice('package:'.length);
  const name = packageReferenceName(ref);
  if (!name || !registry.packages?.[name])
    return fail('PACKAGE_NOT_ADMITTED', `Package ${name ?? ''} is not pinned in registration`);
  reads.observePackageSearch(path.join(root, 'common/autoinstallers/rush-plugins'), name);
  const require = createRequire(path.join(root, 'common/autoinstallers/rush-plugins/package.json'));
  let pkgFile: string;
  try {
    pkgFile = require.resolve(`${name}/package.json`);
  } catch {
    return fail(
      'PACKAGE_UNAVAILABLE',
      `Admitted package ${name} must export package.json and be installed in the rush-plugins autoinstaller`,
    );
  }
  const pkg = readJson(pkgFile, reads);
  if (!Predicate.isObject(pkg) || pkg.name !== name)
    return fail(
      'PACKAGE_IDENTITY_MISMATCH',
      `Installed package must identify itself as ${name}`,
      pkgFile,
    );
  if (!Predicate.isObject(pkg) || pkg.version !== registry.packages[name])
    return fail(
      'PACKAGE_VERSION_MISMATCH',
      `Installed package ${name} does not match its admitted version`,
      pkgFile,
    );
  const packageRoot = reads.realpath(path.dirname(pkgFile));
  const subpath = specifier.slice(name.length + 1);
  if (!subpath) return fail('RESOURCE_REF_INVALID', 'Package resource must name a data file');
  return { file: contained(packageRoot, subpath, reads), boundary: packageRoot };
}
export function validators(
  root: string,
  registry: Registry,
  contract: VersionContract,
  reads: ReadContext = liveReads,
): { effective: ValidateFunction; fragment?: ValidateFunction } {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    allowUnionTypes: true,
    validateFormats: false,
    ownProperties: true,
  });
  const bases = new WeakMap<object, string>();
  for (const ref of contract.resources ?? []) {
    const location = resource(root, registry, ref, root, root, reads).file;
    const uri = pathToFileURL(location).href;
    const data = readJson(location, reads);
    if (!Predicate.isObject(data)) fail('SCHEMA_INVALID', 'Schema resource must be an object');
    recordSchemaBases(data, uri, bases);
    ajv.addSchema(data, uri);
  }
  function compile(ref: string): ValidateFunction {
    const file = resource(root, registry, ref, root, root, reads).file;
    const data = readJson(file, reads);
    if (!Predicate.isObject(data) && typeof data !== 'boolean')
      return fail('SCHEMA_INVALID', 'Expected a JSON Schema', file);
    try {
      const uri = pathToFileURL(file).href;
      recordSchemaBases(data, uri, bases);
      if (!ajv.getSchema(uri)) ajv.addSchema(data, uri);
      const compiled = ajv.getSchema(uri);
      if (!compiled || '$async' in compiled)
        return fail('SCHEMA_INVALID', 'Structural schemas must compile synchronously', file);
      assertSchemaPosture(data, uri, ajv, bases, file);
      return compiled;
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      return fail(
        'SCHEMA_INVALID',
        error instanceof Error ? error.message : 'Invalid schema',
        file,
      );
    }
  }
  return {
    effective: compile(contract.schema),
    ...(contract.fragmentSchema ? { fragment: compile(contract.fragmentSchema) } : {}),
  };
}
export function domainNamed(registry: Registry, name: string): Domain {
  const domain = registry.domains.find((d) => d.name === name);
  if (!domain)
    return fail('UNKNOWN_DOMAIN', `Unknown domain ${name}; use discover to list exact names`);
  return domain;
}
