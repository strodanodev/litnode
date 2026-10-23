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
 *  court's `winnerTeam: null` means abandoned before play (a no-contest): no
 *  winner is derived, and no ladder movement is derived either.
 *
 *  A forfeit is not a no-contest. When a side leaves after both sides had
 *  gathered and does not come back inside the court's grace window, the court
 *  ends the match against it: `forfeitTeam` names the side that quit and
 *  `winnerTeam` the other, whatever the score (a leader who quits still loses,
 *  or quitting would be the way to keep a loss off the ladder). The score is
 *  the score at the moment of the forfeit, so neither 11 nor win-by-2 holds. */
const GAME_TO = 11;

export const validateReport = (r) => {
  if (!r || typeof r !== 'object') return 'report missing';
  if (typeof r.matchId !== 'string' || !r.matchId) return 'matchId';
  if (r.mode !== 'singles' && r.mode !== 'doubles') return 'mode must be singles|doubles';
  const a = r.scoreA, b = r.scoreB;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return 'scores must be non-negative integers';
  if (r.winnerTeam !== 0 && r.winnerTeam !== 1 && r.winnerTeam !== null) return 'winnerTeam must be 0, 1 or null';
  if (r.forfeitTeam !== undefined) {
    if (r.forfeitTeam !== 0 && r.forfeitTeam !== 1) return 'forfeitTeam must be 0 or 1 when present';
    if (r.winnerTeam !== 1 - r.forfeitTeam) return 'a forfeit is won by the side that did not quit';
  } else if (r.winnerTeam !== null) {
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
  // Settlement v4: the studio court's key, pinned by this ruleset's hash, so every node accepts it with no COURTS entry
  // (COURTS stays an operator override). The private key lives only in the studio's managed env.
  attestors: ['09b2b84947a10dcee1bc2f05deda59c6f4b98dc6f3c6d193071fd7c82d097e23'],
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: 'pickles' }),
    // Settlement v4: what the court observes per player, as report.stats (names proposed for the PB session's hand-back;
    // the node keeps only these names, as non-negative integers).
    stats: { track: ['matches', 'wins', 'ticks'], schema: { pointsWon: 'sum', aces: 'sum', winners: 'sum', unforcedErrors: 'sum', smashes: 'sum', dinks: 'sum', longestRally: 'max', matchesMvp: 'sum' } },
  },
  validate: validateReport,

  /** Team score to every member. Abandoned games score 0–0 so nothing moves.
   *  The node ranks a match by these numbers (protocol/derive.js), so a
   *  forfeit's winner must come out ahead: the side that stayed keeps its
   *  points, raised to one past the quitter's when it was behind or level. */
  scores(report, participants, teams) {
    const out = {};
    const [A, B] = teams;
    const won = report.winnerTeam;
    let a = report.scoreA, b = report.scoreB;
    if (report.forfeitTeam === 1) a = Math.max(a, b + 1);
    if (report.forfeitTeam === 0) b = Math.max(b, a + 1);
    for (const p of A) out[p] = won === null ? 0 : a;
    for (const p of B) out[p] = won === null ? 0 : b;
    return out;
  },
});

/** Participants and teams from a court report: the player key, else `pb:<AIR sub>`, team A first,
 *  by slot. Stable, so the same report always yields the same ordering. */
export const seats = (report) => {
  const claims = [...report.claims].sort((x, y) => x.team - y.team || (x.slot ?? 0) - (y.slot ?? 0));
  const id = (c) => (/^[0-9a-f]{64}$/.test(c.sub) ? c.sub : `pb:${c.sub}`); // a proven arcade key is the seat; any other sub is pb:<AIR sub>
  const teams = [claims.filter((c) => c.team === 0).map(id), claims.filter((c) => c.team === 1).map(id)];
  return { participants: [...teams[0], ...teams[1]], teams };
};
