import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RushRepo } from './types.js';

// Deliberately mirrors @butshouldwe/sbom-rush's rushRepo/jsonc modules rather
// than importing them: the extraction contract for both plugins is zero
// workspace imports, and a shared scaffolding package is premature until a
// third plugin proves the abstraction (RUSH-PLUGINS-PRD §1).

const rushJsonSchema = z.object({
  projects: z.array(z.object({ packageName: z.string(), projectFolder: z.string() })),
});

/** Minimal JSONC → JSON for Rush config files (comments + trailing commas).
 * Tolerates a leading UTF-8 BOM, which Rush's own config loader accepts. */
export function parseJsonc<T = unknown>(text: string): T {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Strip trailing commas string-aware: a comma inside a string value followed
  // by } or ] (e.g. "a,}") must never be mistaken for a trailing comma.
  return JSON.parse(stripTrailingCommas(out)) as T;
}

/** Remove trailing commas (`,]` / `,}`) from comment-free JSON text, skipping
 * string literals so their contents are never altered. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) {
          out += text[i + 1];
          i += 1;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j += 1;
      if (text[j] === '}' || text[j] === ']') continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

export function findRushRepo(startDir: string): RushRepo {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'rush.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw = parseJsonc(fs.readFileSync(candidate, 'utf8'));
        const parsed = rushJsonSchema.parse(raw);
        return { rushJsonFolder: dir, projects: parsed.projects };
      } catch (err) {
        throw new Error(
          `Could not read "${candidate}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find rush.json in "${startDir}" or any parent folder.`);
    }
    dir = parent;
  }
}
