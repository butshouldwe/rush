import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../packages/config-rush/package.json', import.meta.url), 'utf8'),
);
assert.equal(manifest.dependencies.effect, '4.0.6', 'config-rush must pin Effect exactly');
console.log('config-rush pins effect 4.0.6');
