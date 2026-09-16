/** Exercise a live mesh from one node: queue two fresh players, wait for the
 *  bucket to close, and print the pair every node should agree on.
 *    node tools/mesh-check.mjs [nodeUrl] [rulesetId]
 *  Compare the printed matchId/host on another machine at
 *    http://<other-node>/match?playerId=<p1>  — they must be identical. */
import { generateKeypair, seal } from '../protocol/keys.js';
import { QUEUE_TAG, bucketOf, BUCKET_MS } from '../protocol/pairing.js';

const nodeUrl = (process.argv[2] ?? 'http://127.0.0.1:7801').replace(/\/+$/, '');
const rulesetId = process.argv[3] ?? 'agent-fighter.v1';
const get = async (p) => (await fetch(`${nodeUrl}${p}`)).json();

const health = await get('/health');
const snap = await get('/snapshot');
console.log(`node ${health.operator} · bonded ${health.bonded} · staking ${snap.staking} · ${snap.peers.length} bonded peers · root ${snap.root.slice(0, 12)}`);
for (const p of snap.peers) console.log(`  ${p.operator.slice(0, 12)}… ${p.nodeId.slice(0, 12)} ${p.region} roles=${p.roles.join(',')} standing=${p.standing}`);
if (!snap.manifests[rulesetId]) { console.error(`no manifest for ${rulesetId} in the snapshot`); process.exit(1); }

const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
const bucket = bucketOf(Date.now());
const entry = (kp, region) => seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId, tokenId: '1', mode: 'ranked', bucket, region }, kp);
for (const [kp, region] of [[p1, 'lan'], [p2, 'lan']]) {
  const r = await fetch(`${nodeUrl}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await entry(kp, region)) });
  console.log(`queue ${kp.publicKey.slice(0, 12)} → ${r.status}`);
}
console.log(`bucket ${bucket} closes in ~${2 * BUCKET_MS / 1000}s, then the chain beacon for it must be seen…`);
const t0 = Date.now();
let m = null;
while (Date.now() - t0 < 30_000) {
  const r = await get(`/match?playerId=${p1.publicKey}`);
  if (r.matches?.length) { m = r.matches[0]; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!m) { console.error('no pair after 30 s'); process.exit(1); }
console.log(JSON.stringify({
  matchId: m.matchId, beaconSource: m.beaconSource, bucket: m.bucket,
  host: m.host?.slice(0, 12), witness: m.witness?.slice(0, 12), order: m.order.map((n) => n.slice(0, 12)),
  pairedAfterMs: Date.now() - t0, snapshotRoot: m.snapshotRoot.slice(0, 12),
}, null, 1));
console.log(`\ncompare on another machine:\n  http://<other-node>:7801/match?playerId=${p1.publicKey}`);
