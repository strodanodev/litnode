/** Can the mesh this node hears put a ranked match of `rulesetId` on chain? (0.12.2; handoff/mesh-gaps/REPORT.md gap 1)
 *
 *  The same rule as protocol/placement.js and MatchBook.commit: a fresh, bonded node with the host role and the
 *  title, and three fresh, bonded, witness-eligible nodes with the witness role and the title, under four DIFFERENT
 *  staking wallets — commit() reverts BadPanel on a seat sharing the host's or another seat's operator. Only nodes on
 *  this node's protocol count: another protocol is excluded from its placements.
 *
 *  The wallet is the chain's word (GET /peers `wallet`, 0.12.2). The heartbeat's `operator` is a label each node
 *  chooses for itself, so counting labels said "four operators online" for four nodes under one wallet, and the
 *  match then went casual-only. A node that predates `wallet` gives labels only; they are counted then, as before.
 *
 *  Pure: peers in, verdict out. */
export function rankedCapacity(peers, rulesetId, { protocol = null } = {}) {
  const live = (peers ?? []).filter((p) => p.fresh && p.bonded && (p.rulesets ?? []).includes(rulesetId) && (protocol == null || (p.protocol ?? 1) === protocol));
  const by = live.some((p) => p.wallet) ? 'wallet' : 'label';
  const who = (p) => (by === 'wallet' ? (p.wallet ? String(p.wallet).toLowerCase() : null) : p.operator ?? null);
  const hosts = live.filter((p) => (p.roles ?? []).includes('host') && who(p));
  const seats = live.filter((p) => (p.roles ?? []).includes('witness') && p.witnessEligible !== false && who(p));
  // the best host: the one with the most distinct seat wallets other than its own
  let best = 0;
  for (const h of hosts) best = Math.max(best, new Set(seats.filter((s) => s.nodeId !== h.nodeId && who(s) !== who(h)).map(who)).size);
  return { ok: hosts.length > 0 && best >= 3, operators: new Set(live.map(who).filter(Boolean)).size, seats: Math.min(best, 3), hosts: hosts.length, by };
}
