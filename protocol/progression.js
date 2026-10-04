/** Player progression as a pure fold over settled results: XP, level, rating, record and streak.
 *
 *  The serverless north star: a player's progress must not live in a publisher's database. It is a
 *  function of the results the chain finalized, so every node (and the arcade, reading RPC alone)
 *  computes the same numbers, and nothing is lost when the publisher is offline. Which results count
 *  is the caller's choice; the node folds ranked results FINAL on chain (decided 5 Oct 2026: casual
 *  results live only on their host and cost nothing to farm).
 *
 *  Rules come from the title's manifest `services.progression`, else DEFAULT_PROGRESSION, which is
 *  Agent Fighter's live curve (supabase record_match, PvP): win 60 XP, draw 30, loss 20; the next
 *  level needs 80 + 45 × level XP; levels stop at 40 and XP keeps counting. Rating is the title's
 *  own leaderboard Elo (`services.leaderboard`), walked with derive.js applyDelta so /progress and
 *  /leaderboard can never disagree.
 *
 *  Order is derive.js sortDeltas (epoch, then matchId): the same set gives byte-identical output in any
 *  arrival order, and `digest` is a claim two nodes can compare. */
import { canonical, h } from './canonical.js';
import { sortDeltas, applyDelta } from './derive.js';

export const PROGRESSION_VERSION = 1;
export const DEFAULT_PROGRESSION = Object.freeze({ xpWin: 60, xpDraw: 30, xpLoss: 20, levelBase: 80, levelStep: 45, maxLevel: 40 });

const rulesOf = (manifest) => ({ ...DEFAULT_PROGRESSION, ...(manifest?.services?.progression ?? {}) });

/** XP needed to go from `level` to the next one. */
export const xpForNext = (level, rules = DEFAULT_PROGRESSION) => rules.levelBase + rules.levelStep * level;

/** Level and XP into it from a lifetime XP total. Level 1 at 0 XP; at the cap, XP keeps counting. */
export function levelOf(xpTotal, rules = DEFAULT_PROGRESSION) {
  let level = 1, xp = Math.max(0, Math.floor(xpTotal));
  while (level < rules.maxLevel && xp >= xpForNext(level, rules)) { xp -= xpForNext(level, rules); level++; }
  return { level, xp, xpForNext: level < rules.maxLevel ? xpForNext(level, rules) : null };
}

const blank = () => ({ matches: 0, wins: 0, losses: 0, draws: 0, xpTotal: 0, streak: 0, bestStreak: 0, lastMatchId: null });

/** @param deltas   results for ONE title: { matchId, epoch, participants, scores, teams? } (chain deltas or local ones)
 *  @param manifest the title's manifest (services.leaderboard, services.progression)
 *  @returns { players: { key: line }, ranking: [line…], rules, version, digest } */
export function progression(deltas, manifest = {}) {
  const rules = rulesOf(manifest);
  const svc = { leaderboard: manifest?.services?.leaderboard ?? { kind: 'elo', k: 24 } };
  const tables = { rating: {}, credits: {}, stats: {} };
  const lines = {};
  for (const d of sortDeltas(deltas)) {
    const { teams: [A, B], sa } = applyDelta(tables, d, svc);
    for (const [team, score] of [[A, sa], [B, 1 - sa]])
      for (const p of team) {
        const l = lines[p] ?? (lines[p] = blank());
        l.matches++;
        l.lastMatchId = d.matchId;
        if (score === 1) { l.wins++; l.xpTotal += rules.xpWin; l.streak++; l.bestStreak = Math.max(l.bestStreak, l.streak); }
        else if (score === 0) { l.losses++; l.xpTotal += rules.xpLoss; l.streak = 0; }
        else { l.draws++; l.xpTotal += rules.xpDraw; l.streak = 0; }
      }
  }
  const players = {};
  for (const [p, l] of Object.entries(lines)) players[p] = { player: p, ...l, ...levelOf(l.xpTotal, rules), rating: tables.rating[p] ?? 1200 };
  // The board a title shows: level, then XP into it, then wins (Agent Fighter's own order), then the key.
  const ranking = Object.values(players)
    .sort((a, b) => b.level - a.level || b.xp - a.xp || b.wins - a.wins || (a.player < b.player ? -1 : 1))
    .map((x, i) => ({ rank: i + 1, ...x }));
  return { players, ranking, rules, version: PROGRESSION_VERSION, digest: h('progression', canonical({ v: PROGRESSION_VERSION, rules, players })) };
}

/** One player's line, or the line of a player with no counted results yet. */
export function progressOf(fold, player) {
  return fold.players[player] ?? { player, ...blank(), ...levelOf(0, fold.rules), rating: 1200 };
}
