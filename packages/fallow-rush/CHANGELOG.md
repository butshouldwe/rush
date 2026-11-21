# Change Log - @butshouldwe/fallow-rush

This log was last generated on Sat, 21 Nov 2026 00:13:23 GMT and should not be manually modified.

## 0.1.1
Sat, 21 Nov 2026 00:13:23 GMT

### Patches

- Prepare public npm metadata and configurable registry routing.
- Refuse symlink components in the default fallow report directory before scanning or writing, and use the validated normalized path for every write; preserve explicitly selected output paths.
- Render repository text literally in Markdown reports. Preserve exact code text when table syntax permits it.
- Harden report integrity with safe writes, ownership and containment guards, serialized output, safe rendering, collision checks, and complete Fallow findings gating.

