/** Derived services as a pure fold. BUILD-SPEC §9: the tables are a function
 *  of the SORTED delta set, not of arrival order, so two nodes with the same
 *  deltas produce byte-identical tables and the digest is a real claim.
 *  Idempotent by matchId by construction.
 *
 *  Team-aware: a delta may carry `teams: [[p, p], [p, p]]`. Without it, each
 *  participant is a team of one. Elo is computed between team-average ratings
 *  and applied to every member; the pot goes to every member of the winning
 *  team; a draw splits it.
 *
 *  Order: by epoch hour, then by matchId. Elo is order-dependent, which is
 *  exactly why the order is fixed here rather than left to gossip. */
import { canonical, h } from './canonical.js';

export const DERIVE_VERSION = 2;

export const sortDeltas = (deltas) => {
  const byId = new Map();
  for (const d of deltas) if (!byId.has(d.matchId)) byId.set(d.matchId, d);
  return [...byId.values()].sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0) || (a.matchId < b.matchId ? -1 : 1));
};

const teamsOf = (d) => (Array.isArray(d.teams) && d.teams.length === 2 ? d.teams : d.participants.map((p) => [p]));
const teamScore = (d, team) => Math.max(...team.map((p) => d.scores?.[p] ?? 0));
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Fold ONE delta into the tables, in place. Exported so a client that wants
 *  the rating trajectory (a chart of "my rating after each match") walks the
 *  same step the node walks, instead of copying the arithmetic. */
export function applyDelta(tables, d, svc = {}) {
  const { rating, credits, stats } = tables;
  const [A, B] = teamsOf(d);
  const sa = teamScore(d, A) > teamScore(d, B) ? 1 : teamScore(d, A) < teamScore(d, B) ? 0 : 0.5;

  if (svc.leaderboard?.kind === 'elo') {
    const k = svc.leaderboard.k ?? 24;
    const ra = avg(A.map((p) => rating[p] ?? 1200)), rb = avg(B.map((p) => rating[p] ?? 1200));
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    for (const p of A) rating[p] = Math.round((rating[p] ?? 1200) + k * (sa - ea));
    for (const p of B) rating[p] = Math.round((rating[p] ?? 1200) + k * ((1 - sa) - (1 - ea)));
  }
  if (svc.credits?.kind === 'pot') {
    const cur = svc.credits.currency, pot = svc.credits.pot ?? 0;
    credits[cur] ??= {};
    const pay = (team, amt) => { for (const p of team) credits[cur][p] = (credits[cur][p] ?? 0) + amt; };
    if (sa === 1) { pay(A, pot); pay(B, 0); }
    else if (sa === 0) { pay(A, 0); pay(B, pot); }
    else { pay(A, Math.floor(pot / 2)); pay(B, Math.floor(pot / 2)); }
  }
  if (svc.stats) {
    for (const [team, won] of [[A, sa === 1], [B, sa === 0]])
      for (const p of team) {
        const line = stats[p] ?? (stats[p] = { matches: 0, wins: 0, ticks: 0 });
        line.matches += 1;
        line.wins += won ? 1 : 0;
        line.ticks += d.ticks ?? 0;
      }
  }
  return { teams: [A, B], sa };
}

/** @param deltas  settled deltas for ONE ruleset
 *  @param manifest.services  {leaderboard:{kind:'elo',k}, credits:{kind:'pot',currency,pot}, stats}
 *  @param opts.requireCosign  ranked deltas without a witness co-signature are skipped (reported) */
export function derive(deltas, manifest, { requireCosign = false } = {}) {
  const svc = manifest.services ?? {};
  const rating = {}, credits = {}, stats = {};
  const tables = { rating, credits, stats };
  const skipped = [];
  for (const d of sortDeltas(deltas)) {
    if (requireCosign && d.mode === 'ranked' && !(d.cosigners?.length > 0)) { skipped.push(d.matchId); continue; }
    applyDelta(tables, d, svc);
  }
  const leaderboard = Object.entries(rating)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .map(([player, r], i) => ({ rank: i + 1, player, rating: r }));
  return { leaderboard, ...tables, skipped, deriveVersion: DERIVE_VERSION, digest: h('services', canonical(tables)) };
}
