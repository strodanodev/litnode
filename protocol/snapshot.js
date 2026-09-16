/** Registry snapshot from signed heartbeats. BUILD-SPEC §3, pure given `now`.
 *
 *  A heartbeat body: { nodeId, operator, roles, region, addr, wsAddr, standing,
 *  buildHashes: {rulesetId: buildHash}, manifests: {rulesetId: manifest}, epoch }.
 *  Signed by nodeId under HEARTBEAT_TAG; a heartbeat whose signer ≠ nodeId is
 *  discarded, so a node cannot advertise on another's behalf.
 *
 *  Manifest resolution: where operators advertise different builds of the
 *  same ruleset, the build held by the most nodes wins, ties lexicographic —
 *  one operator cannot fork a title by advertising alone. */
import { canonical, h } from './canonical.js';
import { opened } from './keys.js';

export const HEARTBEAT_TAG = 'heartbeat';
export const EPOCH_MS = 2000;
export const epochOf = (ms) => Math.floor(ms / EPOCH_MS);
export const isFresh = (hb, nowMs) => hb.epoch >= epochOf(nowMs) - 2;

/** Verify a batch of heartbeat envelopes; returns the valid bodies. */
export async function verifyHeartbeats(envelopes) {
  const out = [];
  for (const env of envelopes)
    if (env?.body?.nodeId === env?.signer && await opened(HEARTBEAT_TAG, env)) out.push(env.body);
  return out;
}

/** Latest heartbeat per node, fresh only. */
export function freshPeers(bodies, nowMs) {
  const latest = new Map();
  for (const b of bodies) {
    if (!isFresh(b, nowMs)) continue;
    const cur = latest.get(b.nodeId);
    if (!cur || b.epoch > cur.epoch) latest.set(b.nodeId, b);
  }
  return [...latest.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

/** One manifest per rulesetId by majority buildHash, lexicographic tiebreak. */
export function resolveManifests(peers) {
  const votes = new Map(); // rulesetId → Map(buildHash → {count, manifest})
  for (const p of peers)
    for (const [rid, bh] of Object.entries(p.buildHashes ?? {})) {
      const m = p.manifests?.[rid];
      if (!m || m.buildHash !== bh) continue;
      const per = votes.get(rid) ?? votes.set(rid, new Map()).get(rid);
      const v = per.get(bh) ?? per.set(bh, { count: 0, manifest: m }).get(bh);
      v.count++;
    }
  const out = {};
  for (const [rid, per] of votes) {
    const best = [...per.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))[0];
    out[rid] = best[1].manifest;
  }
  return out;
}

export function snapshot(bodies, nowMs) {
  const peers = freshPeers(bodies, nowMs);
  const manifests = resolveManifests(peers);
  const epoch = epochOf(nowMs);
  return { epoch, peers, manifests, root: h('snapshot', { epoch, peers, manifests }) };
}

export const snapshotRoot = (s) => h('snapshot', { epoch: s.epoch, peers: s.peers, manifests: s.manifests });
