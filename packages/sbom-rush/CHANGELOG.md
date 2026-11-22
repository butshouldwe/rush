# Change Log - @butshouldwe/sbom-rush

This log was last generated on Sun, 22 Nov 2026 18:27:27 GMT and should not be manually modified.

## 0.1.2
Sun, 22 Nov 2026 18:27:27 GMT

### Patches

- Publish from GitHub Actions through npm trusted publishing, with provenance. No code changes.

## 0.1.1
Sat, 21 Nov 2026 00:13:23 GMT

### Patches

- Prepare public npm metadata and configurable registry routing.
- Refuse symlink components of the implicit SBOM output directory before generation or publication; preserve explicitly selected output paths.
- Include the Apache-2.0 licence and JSF attribution with the vendored schemas.
- Bind workspace-fallback dependency versions and shipped-project splits to the selected deployment.
- Harden sbom-rush execution trust and deployment containment
- Validate NTIA completeness across nested components, reject empty supplier and author identities, and report malformed JSON document shapes without aborting.
- Bind generated SBOMs to complete deployed inventories and make lock, hash, scenario, and output publication collision-safe.

