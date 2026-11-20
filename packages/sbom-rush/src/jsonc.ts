/**
 * Minimal JSONC reader for Rush config files (rush.json, deploy-*.json),
 * which allow // and /* *\/ comments. Strips comments outside string
 * literals, then JSON.parses. Tolerates a leading UTF-8 BOM, which Rush's
 * own config loader (jju) accepts.
 */
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
      if (ch === '\\') {
        // copy the escaped character verbatim
        if (i + 1 < n) {
          out += text[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
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

  // JSON.parse rejects trailing commas, which Rush config files may contain.
  // Strip them string-aware: a comma inside a string value that happens to be
  // followed by } or ] (e.g. "a,}") must never be mistaken for a trailing comma.
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
