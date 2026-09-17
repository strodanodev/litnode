// Harmless audit probes: temporary settlement stores and in-memory markers only.
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../sdk/conformance.mjs';
import { createSettlement } from '../node/settle.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import title from '../rulesets/tug.v1.js';

const source = readFileSync(new URL('../rulesets/tug.v1.js', import.meta.url), 'utf8');
const load = (s) => import('data:text/javascript;base64,' + Buffer.from(s).toString('base64'));
const refused = await check('globalThis.__litAuditMarker = true; void Math.random();\n' + source, { load });
console.log(JSON.stringify({ probe: 'purity rejection happens after execution', rejected: !refused.ok, markerExecuted: globalThis.__litAuditMarker === true }));
delete globalThis.__litAuditMarker;
const bypass = await check("void Math['random']();\n" + source, { load });
console.log(JSON.stringify({ probe: 'bracket access to randomness passes', accepted: bypass.ok, checks: bypass.checks.length }));

const hostKey = await generateKeypair(), witnessKey = await generateKeypair();
const root = mkdtempSync(join(process.cwd(), 'audit', 'probe-data-'));
const build = { title, rulesetId: title.manifest.rulesetId, buildHash: 'audit-build' };
const loaded = new Map([[title.manifest.rulesetId, build]]), builds = new Map([['audit-build', build]]);
const host = createSettlement({ dataDir: join(root, 'host'), nodeId: hostKey.publicKey, identity: hostKey, loaded, builds });
const witness = createSettlement({ dataDir: join(root, 'witness'), nodeId: witnessKey.publicKey, identity: witnessKey, loaded, builds });
const sub = { matchId: 'audit-empty-match', rulesetId: title.manifest.rulesetId, mode: 'ranked', participants: ['audit-player-a','audit-player-b'], entries: [], expected: {} };
const delta = await host.intake(sub);
console.log(JSON.stringify({ probe: 'empty unsigned match accepted as relay', attestation: delta.attestation, ticks: delta.ticks, leaderboardRows: host.derived(title.manifest.rulesetId).leaderboard.length }));
const { hostSig, cosigners, cosigs, ...body } = delta;
const changed = { ...body, scores: { 'audit-player-a': 999999, 'audit-player-b': 0 } };
const forged = { ...changed, hostSig: await sign('delta', changed, hostKey.privateKey), cosigners: [], cosigs: {} };
const result = await witness.cosign(forged, sub);
console.log(JSON.stringify({ probe: 'witness accepts host-signed altered scores', accepted: result.ok, reason: result.reason ?? null }));
console.log(JSON.stringify({ note: 'Temporary audit identities only; no live node writes or chain transactions.' }));
