/** The key-proof test vectors other verifiers rely on (demo/fixtures/key-proof-vectors.json, tools/key-proof-vectors.mjs):
 *  the file matches what this repo's code signs today, and each vector verifies, or fails, as it says.
 *    node --test demo/key-proof-vectors.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical } from '../protocol/canonical.js';
import { verifyKeyProof } from '../protocol/challenge.js';
import { vectors } from '../tools/key-proof-vectors.mjs';

const file = JSON.parse(readFileSync(new URL('./fixtures/key-proof-vectors.json', import.meta.url), 'utf8'));

test('key-proof vectors: the committed file is what the code produces now', async () => {
  assert.deepEqual(file, JSON.parse(JSON.stringify(await vectors())), 'stale: node tools/key-proof-vectors.mjs');
});

test('key-proof vectors: each verifies or fails as labelled; canonical JSON matches', async () => {
  for (const v of file.proofs) assert.equal(await verifyKeyProof(v.claim, v.sig), v.valid, v.why ?? v.canonical);
  for (const c of file.canonical) assert.equal(canonical(c.value), c.canonical);
});
