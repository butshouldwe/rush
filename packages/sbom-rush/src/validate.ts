import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import addFormatsExport from 'ajv-formats';

// ajv-formats is CJS; under NodeNext its callable lives on .default at runtime.
type AddFormats = (ajv: Ajv) => Ajv;
const addFormats: AddFormats =
  (addFormatsExport as unknown as { default?: AddFormats }).default ??
  (addFormatsExport as unknown as AddFormats);
import type { NtiaReport } from './types.js';

const schemasDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

let compiled: ReturnType<Ajv['compile']> | undefined;

function loadSchema(file: string): object {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, file), 'utf8')) as object;
}

/**
 * The hard gate: the vendored official CycloneDX 1.6 JSON schema, compiled
 * once. The bom schema $refs its spdx and jsf companions by their SNAPSHOT
 * filenames; those resolve against the bom schema's canonical $id base, so
 * the companions are registered under the resolved URIs.
 */
export function validateCycloneDx(bom: unknown): { valid: boolean; errors: string[] } {
  // The official schema leaves specVersion an open string (the schema file
  // itself implies the version), so pin it explicitly: this gate means
  // "valid CycloneDX 1.6", not "valid against whichever spec you meant".
  const bomRecord = asRecord(bom);
  if (bomRecord && bomRecord.specVersion !== '1.6') {
    return {
      valid: false,
      errors: [
        `/specVersion is "${String(bomRecord.specVersion)}" but this gate validates CycloneDX 1.6`,
      ],
    };
  }
  if (!compiled) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    // The 1.6 schema uses draft-07 formats plus iri-reference/idn-email.
    addFormats(ajv);
    for (const format of ['iri-reference', 'idn-email']) {
      if (!ajv.formats[format]) ajv.addFormat(format, true);
    }
    ajv.addSchema(
      loadSchema('spdx.schema.json'),
      'http://cyclonedx.org/schema/spdx.SNAPSHOT.schema.json',
    );
    ajv.addSchema(
      loadSchema('jsf-0.82.schema.json'),
      'http://cyclonedx.org/schema/jsf-0.82.SNAPSHOT.schema.json',
    );
    compiled = ajv.compile(loadSchema('bom-1.6.schema.json'));
  }
  const valid = compiled(bom) as boolean;
  const errors = (compiled.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
  );
  return { valid, errors };
}

/**
 * NTIA minimum elements, informational only (§2: schema = gate, NTIA =
 * report). Checks the seven minimum elements as far as they are expressible
 * in a CycloneDX document.
 */
export function ntiaMinimumElements(bom: unknown): NtiaReport {
  const bomRecord = asRecord(bom);
  const metadata = asRecord(bomRecord?.metadata);

  // The root component (the artifact this SBOM is about) counts too — a
  // version-less or purl-less root is an NTIA gap like any other.
  const components = collectComponents(metadata?.component, bomRecord?.components);
  const withVersion = components.filter((component) => {
    const record = asRecord(component);
    return typeof record?.version === 'string' && record.version.length > 0;
  });
  const withIds = components.filter((component) => {
    const record = asRecord(component);
    return Boolean(
      record?.purl ||
      record?.cpe ||
      (Array.isArray(record?.externalReferences) && record.externalReferences.length > 0),
    );
  });
  const tools = metadata?.tools;
  const toolsRecord = asRecord(tools);
  const toolEntries = Array.isArray(tools)
    ? tools
    : Array.isArray(toolsRecord?.components)
      ? toolsRecord.components
      : [];
  const authors = Array.isArray(metadata?.authors) ? metadata.authors : [];
  const allNamed = components.every((component) => {
    const name = asRecord(component)?.name;
    return typeof name === 'string' && name.length > 0;
  });

  const supplierPresent =
    hasSupplierName(metadata?.supplier) ||
    components.some((component) => hasSupplierName(asRecord(component)?.supplier));
  const authorPresent =
    toolEntries.some(hasToolIdentity) || authors.some(hasOrganizationalContactIdentity);
  const dependencyCount = Array.isArray(bomRecord?.dependencies)
    ? bomRecord.dependencies.length
    : 0;

  const fields = [
    {
      field: 'Supplier name',
      present: supplierPresent,
      detail: supplierPresent
        ? 'supplier present on metadata or components'
        : 'no supplier on metadata.component or any component (pnpm sbom does not emit suppliers; pass --sbom-supplier upstream or accept the gap)',
    },
    {
      // c.name is typed as required, but a malformed/partial component from
      // an untrusted or third-party generator (e.g. a cdxgen rung-3 root)
      // can arrive without one at runtime — tolerate that as an NTIA gap
      // rather than letting it throw (finding #18).
      field: 'Component name',
      present: components.length > 0 && allNamed,
      detail: `${components.length} components, all named: ${allNamed}`,
    },
    {
      field: 'Component version',
      present: components.length > 0 && withVersion.length === components.length,
      detail: `${withVersion.length}/${components.length} components carry a version`,
    },
    {
      field: 'Other unique identifiers',
      present: components.length > 0 && withIds.length === components.length,
      detail: `${withIds.length}/${components.length} components carry purl/cpe/external references`,
    },
    {
      field: 'Dependency relationships',
      present: dependencyCount > 0,
      detail: `${dependencyCount} dependency graph entries`,
    },
    {
      field: 'Author of SBOM data',
      present: authorPresent,
      detail: `metadata.tools has ${toolEntries.length} entries; metadata.authors has ${authors.length} entries`,
    },
    {
      field: 'Timestamp',
      present: typeof metadata?.timestamp === 'string',
      detail: metadata?.timestamp
        ? `timestamp ${metadata.timestamp}`
        : 'metadata.timestamp missing',
    },
  ];

  return { fields, satisfied: fields.every((f) => f.present) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSupplierName(value: unknown): boolean {
  return hasNonEmptyText(asRecord(value)?.name);
}

function hasOrganizationalContactIdentity(value: unknown): boolean {
  const contact = asRecord(value);
  return [contact?.name, contact?.email, contact?.phone].some(hasNonEmptyText);
}

function hasToolIdentity(value: unknown): boolean {
  const tool = asRecord(value);
  return [tool?.name, tool?.vendor].some(hasNonEmptyText);
}

function collectComponents(root: unknown, topLevel: unknown): unknown[] {
  const pending = [root, ...(Array.isArray(topLevel) ? topLevel : [])].filter(
    (component) => component !== undefined,
  );
  const components: unknown[] = [];
  const seen = new Set<object>();

  for (let index = 0; index < pending.length; index += 1) {
    const component = pending[index];
    const record = asRecord(component);
    if (record) {
      if (seen.has(record)) continue;
      seen.add(record);
    }
    components.push(component);
    if (Array.isArray(record?.components)) pending.push(...record.components);
  }

  return components;
}
