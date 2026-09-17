/** Test helpers for the placed-match flow: queue two keys on a node, wait for
 *  the mesh to pair and place them, and build a player-signed submission the
 *  way a client would — seed from the descriptor's beacon, ledger head
 *  signed by both keys over the build and hydration it was pinned to. */
import { seal } from '../../protocol/keys.js';
import { QUEUE_TAG, bucketOf } from '../../protocol/pairing.js';
import { createLog, ledgerBody, signLedger } from '../../protocol/log.js';
import { hydrationManifest, agent } from '../../protocol/erc6699.js';
import { h } from '../../protocol/canonical.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (pred, ms = 15_000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); } return null; };

/** Queue both keys at `nodeUrl` every bucket until a descriptor names them. Returns the descriptor. */
export async function placeMatch(nodeUrl, kps, { rulesetId, mode = 'ranked', timeoutMs = 20_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let lastBucket = -1;
  while (Date.now() < end) {
    const bucket = bucketOf(Date.now());
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      for (const kp of kps) {
        const env = await seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId, mode, bucket, tokenId: null }, kp);
        const r = await fetch(`${nodeUrl}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
        if (!r.ok) throw new Error(`queue: ${(await r.json()).error}`);
      }
    }
    const { matches } = await (await fetch(`${nodeUrl}/match?playerId=${kps[0].publicKey}`)).json();
    const m = matches.find((x) => x.participants.includes(kps[1].publicKey) && x.host);
    if (m) return m;
    await sleep(250);
  }
  throw new Error('not placed in time');
}

/** Play `title` with the engine AIs from the descriptor's seed; sign the head with both keys. */
export async function playPlaced(descriptor, kps, { title, engine, manifest, balance, agents: agentsIn = null, mode = descriptor.mode ?? 'ranked' }) {
  const P = descriptor.participants;
  const byKey = Object.fromEntries(kps.map((k) => [k.publicKey, k]));
  const agents = agentsIn ?? {
    [P[0]]: agent({ tokenId: 1, stats: { strength: 30000, agility: 58000, resilience: 20000, intelligence: 40000 }, manifest: { soulManifestHash: 'aa' } }),
    [P[1]]: agent({ tokenId: 2, stats: { strength: 65535, agility: 5000, resilience: 60000, intelligence: 1000 }, manifest: { soulManifestHash: 'bb' } }),
  };
  const seed = h('seed', descriptor.beacon, descriptor.matchId);
  const s = title.init(seed, P, { agents });
  const ai = [engine.createAi(0, 60, 11), engine.createAi(1, 60, 99)];
  const log = createLog();
  while (!title.done(s)) { const fr = [engine.aiPoll(ai[0], s), engine.aiPoll(ai[1], s)]; log.append(fr); title.step(s, { [P[0]]: fr[0], [P[1]]: fr[1] }); }
  const hm = hydrationManifest({ agents: [agents[P[0]], agents[P[1]]], mode, balanceVersion: balance.version });
  const body = ledgerBody({ matchId: descriptor.matchId, ticks: log.length, head: log.head, buildHash: manifest.buildHash, hydrationHash: hm.manifestHash });
  const signatures = Object.fromEntries(await Promise.all(P.map(async (p) => [p, await signLedger(body, byKey[p])])));
  return { matchId: descriptor.matchId, rulesetId: descriptor.rulesetId, buildHash: manifest.buildHash, mode, participants: P, entries: log.entries(), signatures, hydration: { agents } };
}
