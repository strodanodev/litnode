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
 *  court, sign this report. The node checks the bounds it can check and settles
 *  it `attested`, never official.
 *
 *  Single player: one seat, `fc:<random player handle>` (no accounts, no
 *  wallets), a team of one against nobody; the score is the run's points. */

export const RULESET_ID = 'flood-control.v1';

/** The game's Storm of the Day: one storm of the city's five-storm season (0-based). */
const STORMS = 5;

/** A real calendar day from 2026 on (no clock in a ruleset: plain arithmetic). */
const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 2026 && m >= 1 && m <= 12 && d >= 1 && d <= days;
};
const nat = (n) => Number.isInteger(n) && n >= 0;

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
  // one seat: no Elo between players, no pot; the mesh keeps match stats, the game keeps its own board
  services: { stats: { track: ['matches', 'wins', 'ticks'] } },
  validate: validateReport,

  /** The run's points to its one player. */
  scores(report, participants) {
    return Object.fromEntries(participants.map((p) => [p, report.points]));
  },
});
