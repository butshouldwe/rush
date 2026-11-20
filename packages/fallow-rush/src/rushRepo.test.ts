import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRushRepo, parseJsonc } from './rushRepo.js';

describe('parseJsonc', () => {
  it('strips // and /* */ comments and trailing commas', () => {
    const parsed = parseJsonc<{ a: number; b: number }>(
      `{
        // leading comment
        "a": 1, /* inline */
        "b": 2,
      }`,
    );
    expect(parsed).toEqual({ a: 1, b: 2 });
  });

  it('preserves comment markers and escaped quotes inside string literals', () => {
    expect(parseJsonc<{ url: string }>('{ "url": "https://x/y" }').url).toBe('https://x/y');
    expect(parseJsonc<{ s: string }>('{ "s": "a \\" // not a comment" }').s).toBe(
      'a " // not a comment',
    );
  });

  it('does not strip a comma inside a string value that precedes } or ]', () => {
    // Regression: the trailing-comma remover must be string-aware.
    expect(parseJsonc<{ s: string }>('{ "s": "a,}" }').s).toBe('a,}');
    expect(parseJsonc<{ xs: string[] }>('{ "xs": ["a,]", "b,}"] }').xs).toEqual(['a,]', 'b,}']);
  });
});

describe('findRushRepo', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-rush-repo-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('walks up from a nested dir to the folder holding rush.json', () => {
    fs.writeFileSync(
      path.join(tmp, 'rush.json'),
      JSON.stringify({ projects: [{ packageName: 'web-app', projectFolder: 'projects/web-app' }] }),
    );
    const nested = path.join(tmp, 'projects', 'web-app', 'src');
    fs.mkdirSync(nested, { recursive: true });
    const repo = findRushRepo(nested);
    expect(repo.rushJsonFolder).toBe(path.resolve(tmp));
    expect(repo.projects).toEqual([{ packageName: 'web-app', projectFolder: 'projects/web-app' }]);
  });

  it('throws with guidance when no rush.json exists in any parent', () => {
    expect(() => findRushRepo(tmp)).toThrow(/Could not find rush\.json/);
  });
});

describe('parseJsonc BOM + error naming', () => {
  it('tolerates a UTF-8 BOM (Rush itself accepts BOM-saved configs)', () => {
    expect(parseJsonc('﻿{"a": 1, /* c */ }')).toEqual({ a: 1 });
  });
});
