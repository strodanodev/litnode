/** Placement: a pure function of state everybody already has. Runs unchanged
 *  in the node and the browser. BUILD-SPEC §5, with the review fixes:
 *
 *   - publisher affinity keys on publisher NODE KEYS in the manifest, not on a
 *     self-asserted operator string;
 *   - region-aware: nodes in a participant's region come first (stable), so a
 *     reproducible draw is also a playable one;
 *   - witness must be under a different operator AND a different node key.
 *
 *  Standing and operator are still self-asserted in this build (§16) — that
 *  is what "known operators only" means until the registry is on chain. */
import { h } from './canonical.js';

export const seedFor = (beacon, matchId) => h('seed', beacon, matchId);

const eligible = (nodes, rulesetId, manifest) =>
  nodes.filter((n) =>
    n.roles?.includes('host')
    && n.buildHashes?.[rulesetId] === manifest.buildHash
    && (n.standing ?? 0) >= (manifest.standingFloor ?? 0));

/** @param {object} args
 *  @param {Array} args.nodes      fresh registry entries {nodeId, operator, roles, region, buildHashes, standing}
 *  @param {object} args.manifest  ruleset manifest {buildHash, standingFloor, hostPolicy}
 *  @param {string} args.rulesetId
 *  @param {string} args.matchId
 *  @param {string} args.beacon
 *  @param {string[]} [args.regions]  participants' regions, for affinity
 *  @returns {{seed, host, witness, order}} host/witness are nodes or null */
export function placement({ nodes, manifest, rulesetId, matchId, beacon, regions = [] }) {
  const seed = seedFor(beacon, matchId);
  const ranked = eligible(nodes, rulesetId, manifest)
    .map((n) => ({ n, r: h('order', seed, n.nodeId) }))
    .sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0))
    .map((x) => x.n);

  // Stable partitions, applied innermost first so the outer one wins.
  let order = ranked;
  const wanted = new Set(regions.filter(Boolean));
  if (wanted.size) order = [...order.filter((n) => wanted.has(n.region)), ...order.filter((n) => !wanted.has(n.region))];
  const pub = new Set(manifest.hostPolicy?.affinity === 'operator' ? manifest.hostPolicy.publisherNodes ?? [] : []);
  if (pub.size) order = [...order.filter((n) => pub.has(n.nodeId)), ...order.filter((n) => !pub.has(n.nodeId))];

  const host = order[0] ?? null;
  // The witness draw is seeded too: the first entry in ranked order that holds
  // the same build, carries the witness role, and sits under a different
  // operator AND a different node key than the host.
  const witness = host
    ? ranked.find((n) => n.nodeId !== host.nodeId && n.operator !== host.operator && n.roles?.includes('witness')) ?? null
    : null;

  return { seed, host, witness, order };
}

/** A client that was told "connect to X" checks X against the rule. */
export const acceptsHost = (args, nodeId) => placement(args).host?.nodeId === nodeId;
