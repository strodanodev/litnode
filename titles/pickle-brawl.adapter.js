import { defineAttestedTitle, eloLeaderboard, winnerTakesCredits } from './title.js';

/** Pickle Brawl — E:\NPC\PICKLEBRAWLv2\PickleBrawl, an ATTESTED title.
 *
 *  Why not replayable: the game runs on the Genesys engine with floating-point
 *  three.js ballistics (drag + Magnus, integrated per step), a fixed 60 Hz
 *  combat clock with catch-up, engine-replicated state rather than an input
 *  log, and Math.random in the game mode. A node cannot re-simulate it
 *  bit-exactly from anything the court records today. Pretending otherwise
 *  would make every witness a liar.
 *
 *  What is real instead: the studio's own dedicated court process
 *  (services/court) is the authority — "the rules run on our machine, which is
 *  what makes a human-vs-human result an observation rather than a claim".
 *  That court holds a litnode identity and signs an outcome report at
 *  GameEnd. The node validates the report against the rulebook it can check
 *  (win by 2, to 11, side-out scoring makes ties impossible), settles it, and
 *  the delta says `attestation: 'attested'`, `verifiable: false`.
 *
 *  Path to replayable, if the studio wants it: an input ledger of player
 *  intents per combat frame, a seeded PRNG in the game mode, and a headless
 *  replay of the court process pinned to the engine build. The bones exist
 *  (fixed clock, pure shot solver, pure ballistics); the ledger does not.
 *
 *  Equipment: paddles, cosmetics and the gacha stay in the studio plane. The
 *  court reports the outcome; what the players carried is not the node's
 *  business in V1. Ranked sterility is the court's rule to enforce. */

export const RULESET_ID = 'pickle-brawl.v1';

/** USA Pickleball Official Rulebook (2025) §4: games to 11, win by 2. The
 *  court's `winnerTeam: null` means abandoned/forfeited — no winner is
 *  derived, and no ladder movement is derived either. */
const GAME_TO = 11;

export const validateReport = (r) => {
  if (!r || typeof r !== 'object') return 'report missing';
  if (typeof r.matchId !== 'string' || !r.matchId) return 'matchId';
  if (r.mode !== 'singles' && r.mode !== 'doubles') return 'mode must be singles|doubles';
  const a = r.scoreA, b = r.scoreB;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return 'scores must be non-negative integers';
  if (r.winnerTeam !== 0 && r.winnerTeam !== 1 && r.winnerTeam !== null) return 'winnerTeam must be 0, 1 or null';
  if (r.winnerTeam !== null) {
    const [w, l] = r.winnerTeam === 0 ? [a, b] : [b, a];
    if (w <= l) return 'winner must have the higher score';
    if (w < GAME_TO) return `a won game reaches at least ${GAME_TO}`;
    if (w - l < 2) return 'win by two';
  }
  if (!Array.isArray(r.claims)) return 'claims must be an array';
  const perTeam = r.mode === 'singles' ? 1 : 2;
  if (r.claims.length !== perTeam * 2) return `expected ${perTeam * 2} seats for ${r.mode}`;
  for (const c of r.claims) if (typeof c?.sub !== 'string' || (c.team !== 0 && c.team !== 1)) return 'each claim needs sub and team';
  return null;
};

export default defineAttestedTitle({
  rulesetId: RULESET_ID,
  modes: ['ranked', 'casual'],
  participants: [2, 4],
  teams: 2,
  equipment: 'studio',
  hostPolicy: { affinity: 'operator', publisherNodes: [] }, // the studio's courts host; open fallback stays
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: 'pickles' }),
    stats: { track: ['matches', 'wins', 'ticks'] },
  },
  validate: validateReport,

  /** Team score to every member. Abandoned games score 0–0 so nothing moves. */
  scores(report, participants, teams) {
    const out = {};
    const [A, B] = teams;
    const won = report.winnerTeam;
    for (const p of A) out[p] = won === null ? 0 : report.scoreA;
    for (const p of B) out[p] = won === null ? 0 : report.scoreB;
    return out;
  },
});

/** Participants and teams from a court report: `pb:<AIR sub>`, team A first,
 *  by slot. Stable, so the same report always yields the same ordering. */
export const seats = (report) => {
  const claims = [...report.claims].sort((x, y) => x.team - y.team || (x.slot ?? 0) - (y.slot ?? 0));
  const id = (c) => `pb:${c.sub}`;
  const teams = [claims.filter((c) => c.team === 0).map(id), claims.filter((c) => c.team === 1).map(id)];
  return { participants: [...teams[0], ...teams[1]], teams };
};
