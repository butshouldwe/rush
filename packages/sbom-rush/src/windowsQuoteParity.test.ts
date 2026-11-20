import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { windowsQuote } from './generate.js';

// Failure prevented (ADR-067 amendment 1, R2): worktree-rush's windowsQuote
// escaped embedded quotes as `\"` while this package doubles them, so the two
// packages quoted the same argument differently. Zero-workspace-imports: the
// sibling implementation is evaluated from its source text, never imported.
const QUOTE_PARITY_TABLE: Array<[string, string]> = [
  ['plain', '"plain"'],
  ['', '""'],
  ['a b', '"a b"'],
  ['say "hi"', '"say ""hi"""'],
  ['"', '""""'],
  ['a&b|c<d>e^f', '"a&b|c<d>e^f"'],
  ['%PATH%', '"%PATH%"'],
  ['C:\\Users\\John Doe', '"C:\\Users\\John Doe"'],
  ['back\\"slash', '"back\\""slash"'],
];

describe('windowsQuote parity with worktree-rush stages.ts (ADR-067 amendment 1, R2)', () => {
  const source = fs.readFileSync(
    new URL('../../worktree-rush/src/stages.ts', import.meta.url),
    'utf8',
  );
  const match = /export function windowsQuote\(value: string\): string \{([\s\S]*?)\n\}/.exec(
    source,
  );
  const sibling = new Function('value', match?.[1] ?? 'throw new Error("not found")') as (
    value: string,
  ) => string;

  it('found the sibling implementation', () => {
    expect(match).not.toBeNull();
  });

  it.each(QUOTE_PARITY_TABLE)('both quote %j as %j', (input, expected) => {
    expect(windowsQuote(input)).toBe(expected);
    expect(sibling(input)).toBe(expected);
  });
});
