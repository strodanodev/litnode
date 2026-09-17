/** Sign a ruleset build as its publisher.
 *
 *    node tools/sign-build.mjs rulesets/my-title.v1.js [--key ~/.litnode/publisher-key.json]
 *
 *  Writes `publisher` and `sig` into the sidecar rulesets/<id>.json:
 *  sig = sign('build', { rulesetId, buildHash }, publisherKey). A node with
 *  TITLE_TRUST=trusted (the default) loads a build from a PEER only when
 *  this signature verifies under a key in its TRUSTED_PUBLISHERS (default:
 *  the litVM release key). The operator's own RULESETS load regardless.
 *
 *  Why a signature and not just the hash: the hash pins bytes; the
 *  signature says who vouches for them. Until the sandbox has a track
 *  record, a build that nobody trusted vouches for is a build no node
 *  fetches (audit finding 1). The key never leaves this machine and is
 *  never printed. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sign } from '../protocol/keys.js';
import { h } from '../protocol/canonical.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const keyFile = args.includes('--key') ? args[args.indexOf('--key') + 1] : (process.env.PUBLISHER_KEY_FILE ?? process.env.RELEASE_KEY_FILE ?? join(homedir(), '.litnode', 'release-key.json'));
if (!file) { console.error('usage: node tools/sign-build.mjs rulesets/<id>.js [--key file]'); process.exit(2); }
if (!existsSync(keyFile)) { console.error(`no key at ${keyFile}`); process.exit(1); }
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
const source = readFileSync(file, 'utf8');
const buildHash = h('ruleset', source);
const side = file.replace(/\.js$/, '.json');
const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
const rulesetId = meta.rulesetId ?? /rulesetId:\s*["']([^"']+)["']/.exec(source)?.[1];
if (!rulesetId) { console.error('cannot determine rulesetId (no sidecar .json and none in source)'); process.exit(1); }
if (meta.buildHash && meta.buildHash !== buildHash) console.error(`note: sidecar buildHash ${meta.buildHash.slice(0, 12)} ≠ file ${buildHash.slice(0, 12)}; updating`);
const sig = await sign('build', { rulesetId, buildHash }, key.privateKey);
writeFileSync(side, JSON.stringify({ ...meta, rulesetId, buildHash, publisher: key.publicKey, sig, signedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`${side}: ${rulesetId} @ ${buildHash.slice(0, 12)}… signed by ${key.publicKey.slice(0, 12)}…`);
