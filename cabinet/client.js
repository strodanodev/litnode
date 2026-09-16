/** The arcade client, isomorphic: the same file drives the lobby page in a
 *  browser and the client test in Node. It owns the player identity, signs
 *  queue entries, polls for a pair, and — the point of the design — recomputes
 *  placement from a snapshot it can hash and refuses a host the rule did not
 *  produce. A node is a directory, never an authority. */
import { generateKeypair, seal } from './protocol/keys.js';
import { placement } from './protocol/placement.js';
import { QUEUE_TAG, bucketOf } from './protocol/pairing.js';
import { snapshotRoot } from './protocol/snapshot.js';

export const IDENTITY_KEY = 'litnode.player';

/** Load or create the player keypair. `storage` is localStorage-shaped. */
export async function loadPlayer(storage) {
  try {
    const raw = storage?.getItem(IDENTITY_KEY);
    if (raw) { const kp = JSON.parse(raw); if (kp.publicKey && kp.privateKey) return kp; }
  } catch {}
  const kp = await generateKeypair();
  try { storage?.setItem(IDENTITY_KEY, JSON.stringify(kp)); } catch {}
  return kp;
}

export function createClient({ nodeUrl, player, fetchImpl = globalThis.fetch }) {
  const base = nodeUrl.replace(/\/+$/, '');
  const get = async (p) => { const r = await fetchImpl(`${base}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };

  const snapshot = () => get('/snapshot');
  const health = () => get('/health');
  const leaderboard = (rulesetId) => get(`/leaderboard?ruleset=${encodeURIComponent(rulesetId)}`);
  const stats = (rulesetId) => get(`/stats?ruleset=${encodeURIComponent(rulesetId)}&player=${player.publicKey}`);
  const deltas = (rulesetId) => get(`/deltas${rulesetId ? `?ruleset=${encodeURIComponent(rulesetId)}` : ''}`);
  const epoch = () => get('/epoch');

  /** Sign and submit a queue entry. The node cannot enqueue anyone else. */
  const queue = async ({ rulesetId, mode = 'ranked', tokenId = '1', region = null }) => {
    const body = { playerId: player.publicKey, rulesetId, tokenId, mode, bucket: bucketOf(Date.now()), region };
    const env = await seal(QUEUE_TAG, body, player);
    const r = await fetchImpl(`${base}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `queue: ${r.status}`);
    return { bucket: body.bucket };
  };

  /** The node's descriptor for my LATEST match, if any. Frozen descriptors
   *  live for a while, so an older pairing must not shadow a new queue. */
  const match = async ({ sinceBucket = 0 } = {}) => {
    const ms = (await get(`/match?playerId=${player.publicKey}`)).matches.filter((m) => m.bucket >= sinceBucket);
    return ms.sort((a, b) => b.bucket - a.bucket)[0] ?? null;
  };

  /** Recompute placement from a snapshot and compare with what the node
   *  says. Returns { ok, host, witness, nodeHost, reason }. */
  const verifyPlacement = (m, s) => {
    const manifest = s.manifests[m.rulesetId];
    if (!manifest) return { ok: false, reason: 'ruleset not in snapshot' };
    const mine = placement({ nodes: s.peers, manifest, rulesetId: m.rulesetId, matchId: m.matchId, beacon: m.beacon, regions: m.regions ?? [] });
    const host = mine.host?.nodeId ?? null;
    const sameSnapshot = snapshotRoot(s) === m.snapshotRoot;
    if (host === m.host) return { ok: true, host, witness: mine.witness?.nodeId ?? null, nodeHost: m.host, sameSnapshot };
    return { ok: false, host, witness: mine.witness?.nodeId ?? null, nodeHost: m.host, sameSnapshot,
      reason: sameSnapshot ? 'node named a host the rule did not produce' : 'computed against a different snapshot (eligible set moved)' };
  };

  /** Poll until paired (or timeout), then verify. */
  const waitForMatch = async ({ timeoutMs = 30_000, intervalMs = 500, sinceBucket = 0, onTick } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = await match({ sinceBucket });
      onTick?.(m);
      if (m) { const s = await snapshot(); return { match: m, check: verifyPlacement(m, s), snapshot: s, waitedMs: Date.now() - t0 }; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  };

  return { base, player, snapshot, health, leaderboard, stats, deltas, epoch, queue, match, verifyPlacement, waitForMatch };
}
