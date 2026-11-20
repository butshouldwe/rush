import { describe, expect, it } from 'vitest';
import { validateCycloneDx, ntiaMinimumElements } from './validate.js';
import { stampBom } from './stamp.js';
import type { CdxBom } from './types.js';

function minimalBom(): CdxBom {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: '2026-07-11T00:00:00.000Z',
      tools: { components: [{ type: 'application', name: 'pnpm', version: '11.11.0' }] },
      // the root carries a purl: NTIA identifier checks include it now
      component: {
        type: 'application',
        name: 'web-app',
        version: '1.0.0',
        purl: 'pkg:npm/web-app@1.0.0',
        'bom-ref': 'pkg:npm/web-app@1.0.0',
      },
    },
    components: [
      {
        type: 'library',
        name: 'ms',
        version: '2.1.3',
        purl: 'pkg:npm/ms@2.1.3',
        'bom-ref': 'pkg:npm/ms@2.1.3',
      },
    ],
    dependencies: [
      { ref: 'pkg:npm/web-app@1.0.0', dependsOn: ['pkg:npm/ms@2.1.3'] },
      { ref: 'pkg:npm/ms@2.1.3', dependsOn: [] },
    ],
  };
}

describe('validateCycloneDx (ajv hard gate, official 1.6 schema)', () => {
  it('accepts a well-formed document', () => {
    const { valid, errors } = validateCycloneDx(minimalBom());
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('accepts a stamped document (stamping must never break validity)', () => {
    const stamped = stampBom(minimalBom(), {
      scenario: 'web',
      mainProject: 'web-app',
      gitSha: 'deadbeef',
      rung: 2,
      method: 'pnpm-sbom-workspace-split-merge',
      toolVersion: '0.1.0',
    });
    const { valid, errors } = validateCycloneDx(stamped);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a wrong specVersion', () => {
    const bom = { ...minimalBom(), specVersion: 'not-a-version' };
    expect(validateCycloneDx(bom).valid).toBe(false);
  });

  it('rejects a component with an invalid type', () => {
    const bom = minimalBom();
    bom.components![0]!.type = 'flying-saucer';
    const { valid, errors } = validateCycloneDx(bom);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing bomFormat', () => {
    const bom = minimalBom() as Record<string, unknown>;
    delete bom.bomFormat;
    expect(validateCycloneDx(bom as unknown as CdxBom).valid).toBe(false);
  });
});

describe('ntiaMinimumElements (informational, never a gate)', () => {
  it('reports the pnpm supplier gap honestly', () => {
    const report = ntiaMinimumElements(minimalBom());
    const supplier = report.fields.find((f) => f.field === 'Supplier name');
    expect(supplier?.present).toBe(false);
    expect(report.satisfied).toBe(false);
  });

  it('passes the other six elements on a complete document', () => {
    const report = ntiaMinimumElements(minimalBom());
    const failing = report.fields.filter((f) => !f.present).map((f) => f.field);
    expect(failing).toEqual(['Supplier name']);
  });

  it('flags missing dependency relationships', () => {
    const bom = minimalBom();
    delete bom.dependencies;
    const report = ntiaMinimumElements(bom);
    expect(report.fields.find((f) => f.field === 'Dependency relationships')?.present).toBe(false);
  });

  it('flags components without versions', () => {
    const bom = minimalBom();
    delete bom.components![0]!.version;
    const report = ntiaMinimumElements(bom);
    expect(report.fields.find((f) => f.field === 'Component version')?.present).toBe(false);
  });

  it('includes descendants of metadata.component in the complete component inventory', () => {
    const bom = minimalBom();
    bom.components = [];
    bom.metadata!.supplier = { name: 'Example Supplier' };
    (bom.metadata!.component as Record<string, unknown>).components = [
      {
        type: 'library',
        name: 'nested-library',
        version: '1.0.0',
        purl: 'pkg:npm/nested-library@1.0.0',
        components: [
          {
            type: 'library',
            name: 'nested-grandchild',
            version: '2.0.0',
            purl: 'pkg:npm/nested-grandchild@2.0.0',
          },
        ],
      },
    ];

    const report = ntiaMinimumElements(bom);
    expect(report.satisfied).toBe(true);
    expect(report.fields.find((f) => f.field === 'Component version')?.detail).toBe(
      '3/3 components carry a version',
    );
  });

  it('reports missing requirements on descendants of top-level components', () => {
    const bom = minimalBom();
    (bom.components![0] as Record<string, unknown>).components = [
      { type: 'library', name: 'nested-library' },
    ];

    const report = ntiaMinimumElements(bom);
    expect(report.fields.find((f) => f.field === 'Component version')?.present).toBe(false);
    expect(report.fields.find((f) => f.field === 'Other unique identifiers')?.present).toBe(false);
  });

  it('requires a non-empty supplier name after trimming whitespace', () => {
    const bom = minimalBom();
    bom.metadata!.supplier = { name: ' \t ' };

    const report = ntiaMinimumElements(bom);
    expect(report.fields.find((f) => f.field === 'Supplier name')?.present).toBe(false);
  });

  it('requires a non-empty author or tool identity after trimming whitespace', () => {
    const bom = minimalBom();
    bom.metadata!.tools = {
      components: [{ type: 'application', name: '  ', version: '1.0.0' }],
    };
    bom.metadata!.authors = [{ name: ' ', email: '\t', phone: '' }];

    const report = ntiaMinimumElements(bom);
    expect(report.fields.find((f) => f.field === 'Author of SBOM data')?.present).toBe(false);
  });

  it('accepts non-empty supplier and author contact identities', () => {
    const bom = minimalBom();
    bom.metadata!.supplier = { name: ' Example Supplier ' };
    bom.metadata!.tools = { components: [] };
    bom.metadata!.authors = [{ email: ' sbom@example.com ' }];

    const report = ntiaMinimumElements(bom);
    expect(report.fields.find((f) => f.field === 'Supplier name')?.present).toBe(true);
    expect(report.fields.find((f) => f.field === 'Author of SBOM data')?.present).toBe(true);
  });

  it('does not throw on a component missing `name` (e.g. a cdxgen rung-3 root) — reports a gap instead (finding #18)', () => {
    const bom = minimalBom();
    // Simulate a malformed/partial component the way a real generator can
    // hand us one: no `name` at all, despite the type saying it's required.
    delete (bom.components![0] as { name?: string }).name;
    expect(() => ntiaMinimumElements(bom)).not.toThrow();
    const report = ntiaMinimumElements(bom);
    const field = report.fields.find((f) => f.field === 'Component name');
    expect(field?.present).toBe(false);
    expect(field?.detail).toContain('all named: false');
  });
});

describe('stamping legacy metadata.tools arrays (audit N2)', () => {
  it('keeps a legacy tools-array document schema-valid after stamping', () => {
    const bom = minimalBom();
    bom.metadata!.tools = [{ vendor: 'pnpm', name: 'pnpm', version: '11.11.0' }] as never;
    expect(validateCycloneDx(bom).valid).toBe(true);
    const stamped = stampBom(bom, {
      scenario: 'web',
      mainProject: 'web-app',
      gitSha: 'a'.repeat(40),
      rung: 3,
      method: 'cdxgen-deploy-folder',
      toolVersion: '0.1.0',
    });
    const { valid, errors } = validateCycloneDx(stamped);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(Array.isArray(stamped.metadata?.tools)).toBe(true);
  });
});
