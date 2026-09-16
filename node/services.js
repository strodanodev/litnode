import { canonical, h } from '../protocol/canonical.js';

/** Leaderboards, credits and stats, derived from settled deltas.
 *
 *  This is the part a developer would otherwise build a backend for. They do
 *  not write it here either: they declare how a delta becomes a rating, a
 *  credit award and a stat line, and the network derives the rest.
 *
 *  Crucially these are DERIVED, not stored truth. Any node with the delta set
 *  rebuilds identical tables, so a leaderboard cannot be quietly edited and
 *  does not die with the node that happened to be serving it. */
export function createServices({ store }) {
  const applied = new Set();

  async function apply(delta, manifest) {
    if (applied.has(delta.matchId)) return;   // deltas are idempotent by matchId
    applied.add(delta.matchId);
    const svc = manifest.services ?? {};
    const ns = manifest.rulesetId;

    if (svc.leaderboard?.kind === 'elo') {
      const scores = svc.leaderboard.rate(delta);
      const [a, b] = delta.participants;
      const ra = await store.get(ns, 'rating', a) ?? 1200;
      const rb = await store.get(ns, 'rating', b) ?? 1200;
      const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
      const k = svc.leaderboard.k;
      await store.set(ns, 'rating', a, Math.round(ra + k * (scores[a] - ea)));
      await store.set(ns, 'rating', b, Math.round(rb + k * (scores[b] - (1 - ea))));
    }

    if (svc.credits?.kind === 'pot') {
      const award = svc.credits.award(delta);
      for (const [player, amount] of Object.entries(award)) {
        const cur = await store.get(ns, `credits:${svc.credits.currency}`, player) ?? 0;
        await store.set(ns, `credits:${svc.credits.currency}`, player, cur + amount);
      }
    }

    if (svc.stats) {
      for (const player of delta.participants) {
        const line = await store.get(ns, 'stats', player) ?? { matches: 0, wins: 0, ticks: 0 };
        const other = delta.participants.find((p) => p !== player);
        line.matches += 1;
        line.wins += delta.scores[player] > delta.scores[other] ? 1 : 0;
        line.ticks += delta.ticks ?? 0;
        await store.set(ns, 'stats', player, line);
      }
    }
  }

  const leaderboard = async (rulesetId, limit = 20) =>
    (await store.list(rulesetId, 'rating'))
      .sort((x, y) => y.value - x.value).slice(0, limit)
      .map((r, i) => ({ rank: i + 1, player: r.key, rating: r.value }));

  const credits = (rulesetId, currency, player) => store.get(rulesetId, `credits:${currency}`, player);
  const stats = (rulesetId, player) => store.get(rulesetId, 'stats', player);

  /** Anyone with the delta set can rebuild every table above and compare this
   *  hash. A leaderboard nobody can independently reproduce is just a claim. */
  const digest = async (rulesetId) =>
    h('services', canonical(await store.list(rulesetId, 'rating')));

  return { apply, leaderboard, credits, stats, digest };
}
