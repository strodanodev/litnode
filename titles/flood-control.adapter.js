import { defineAttestedTitle } from './title.js';

/** FLOOD CONTROL by bagyo.app (play.bagyo.app), an ATTESTED title. Lives in the
 *  litnode repo as titles/flood-control.adapter.js; the game repo keeps this
 *  copy in docs/litnode/ beside the operator checklist (docs/LITNODE.md).
 *
 *  Why not replayable: the game IS deterministic (seeded sim, an input log per
 *  run), but its sim is a TypeScript game module with baked city levels, not an
 *  import-free ES module a node could bundle and replay in its sandbox.
 *
 *  What is real instead: the game's own board (a Vercel function) replays every
 *  Storm of the Day run headlessly from its command log and accepts it only when
 *  the replay reproduces the claimed result. Only then does that function, the
 *  court (its key is `attestors` below), sign this report. The node checks the
 *  bounds it can check and settles it `attested`, never official.
 *
 *  Settlement v4: the report commits the exact run log (`arc-runlog@1`), the
 *  replay's result hash (`arc-final@1`) and the verifier bundle that reproduces
 *  one from the other (the board's own replay, built by the game repo's
 *  scripts/arc/verifier). A node that holds the log and finds that verifier
 *  registered settles the run `checkable` (L2); anyone can re-run it.
 *
 *  Single player: one seat, a team of one against nobody; the score is the
 *  run's points. The seat is the arcade player's ed25519 key when the game runs
 *  inside the arcade (the key signs the run's log hash), else
 *  `fc:<random player handle>`, casual only. */

export const RULESET_ID = 'flood-control.v1';

/** The game's Storm of the Day: one storm of the city's five-storm season (0-based). */
const STORMS = 5;

/** The run's integers, per player: points (the best run), the rest summed over runs. keptDry is the share of the
 *  defendable homes kept dry, in whole percent (0..100); stormsSurvived is 1 for a weathered storm. */
export const STATS = Object.freeze({ points: 'max', stars: 'sum', rescued: 'sum', casualties: 'sum', bestChain: 'max', keptDry: 'sum', stormsSurvived: 'sum' });

/** A real calendar day from 2026 on (no clock in a ruleset: plain arithmetic). */
const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 2026 && m >= 1 && m <= 12 && d >= 1 && d <= days;
};
const nat = (n) => Number.isInteger(n) && n >= 0;

/** What a court's stats line must say about the report it sits in. */
const statsProblem = (r, line) => {
  if (!line || typeof line !== 'object') return 'stats: one line per participant';
  for (const k of Object.keys(line)) if (!(k in STATS)) return `stats: ${k} is not a FLOOD CONTROL stat`;
  for (const k of ['points', 'stars', 'rescued', 'casualties', 'bestChain']) if (k in line && line[k] !== r[k]) return `stats: ${k} disagrees with the report`;
  if ('stormsSurvived' in line && line.stormsSurvived !== (r.survived ? 1 : 0)) return 'stats: stormsSurvived disagrees with the report';
  if ('keptDry' in line && (!nat(line.keptDry) || line.keptDry > 100)) return 'stats: keptDry is a whole percent, 0..100';
  return null;
};

export const validateReport = (r) => {
  if (!r || typeof r !== 'object') return 'report missing';
  if (typeof r.matchId !== 'string' || !r.matchId) return 'matchId';
  if (r.replayVerified !== true) return 'only replay-verified runs settle';
  if (!isDate(r.date)) return 'date must be a real YYYY-MM-DD';
  if (typeof r.levelId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(r.levelId)) return 'levelId';
  if (!Number.isInteger(r.stormIndex) || r.stormIndex < 0 || r.stormIndex >= STORMS) return `stormIndex must be 0..${STORMS - 1}`;
  if (typeof r.mutatorId !== 'string' || !r.mutatorId) return 'mutatorId';
  if (!Number.isInteger(r.stars) || r.stars < 0 || r.stars > 5) return 'stars must be 0..5';
  if (!nat(r.points)) return 'points must be a non-negative integer';
  if (typeof r.survived !== 'boolean') return 'survived must be a boolean';
  if (!nat(r.rescued) || !nat(r.casualties) || !nat(r.bestChain)) return 'rescued, casualties and bestChain must be non-negative integers';
  if (!r.survived && r.stars > 0) return 'a lost storm earns no stars';
  if (!nat(r.ticks) || r.ticks === 0) return 'ticks';
  if (r.commitments != null && r.commitments.logFormat !== 'arc-runlog@1') return 'commitments.logFormat must be arc-runlog@1';
  if (r.stats != null) {
    if (typeof r.stats !== 'object' || Array.isArray(r.stats)) return 'stats';
    for (const line of Object.values(r.stats)) { const p = statsProblem(r, line); if (p) return p; }
  }
  return null;
};

export default defineAttestedTitle({
  rulesetId: RULESET_ID,
  modes: ['casual'],
  participants: [1],
  teams: 1,
  equipment: 'studio',
  display: {
    title: 'FLOOD CONTROL',
    url: 'https://play.bagyo.app',
    description: 'Storm of the Day: hold the city against one seeded typhoon. Every run is replayed by the game before it settles.',
  },
  // the board's court (scripts/arc/board/litnode.ts, its key in the game's managed env, never in a repo): every node
  // accepts its reports with no COURTS entry
  attestors: ['f82a5ef3e118426850dafe84e0e8f9509a08e9837babb4db6a33633e28a7da87'],
  // one seat: no Elo between players, no pot; the mesh keeps match stats, the game keeps its own board
  services: { stats: { track: ['matches', 'wins', 'ticks'], schema: STATS } },
  validate: validateReport,

  /** The run's stats for its one seat: the court's `report.stats`, kept to the schema's names. A report from before
   *  settlement v4 has none: its own integers stand in (no keptDry, which those reports never carried). */
  stats(report, participants) {
    const out = {};
    for (const p of participants) {
      const line = report.stats?.[p] ?? { points: report.points, stars: report.stars, rescued: report.rescued, casualties: report.casualties, bestChain: report.bestChain, stormsSurvived: report.survived ? 1 : 0 };
      out[p] = Object.fromEntries(Object.keys(STATS).filter((k) => nat(line[k])).map((k) => [k, line[k]]));
    }
    return out;
  },

  /** The run's points to its one player. */
  scores(report, participants) {
    return Object.fromEntries(participants.map((p) => [p, report.points]));
  },
});
