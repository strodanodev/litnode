import { defineAttestedTitle } from './title.js';

/** AFC — Robot Fighting Championship (humanoid mech combat, HMC), an ATTESTED title
 *  at L2 `checkable`. Lives in the litnode repo as titles/afc.adapter.js; the game
 *  repo (notsedano/afc) keeps this copy in docs/litnode/ beside the hand-back.
 *
 *  Why not replayable (L3): the sim IS deterministic — 30 Hz, sfc32 PRNG, Rapier
 *  `rapier3d-deterministic-compat` 0.20.0, a StreamHash over every tick — but it is
 *  a TypeScript package around a WASM physics engine with an async constructor,
 *  not an import-free ES module the node sandbox can run (docs/LITNODE-L3.md in the
 *  AFC repo has the path there).
 *
 *  What is real instead: the AFC match host (packages/server, POST /replay) is the
 *  court. It re-simulates every bout from its `hmc-match@2` file (seed, robots after
 *  gear, pilots, sparse commands), re-runs both declared pilots tick for tick
 *  (authorship), and only then signs this report. `commitments.inputsHash` is the
 *  sha256 of the exact match-file bytes the mesh holds; `commitments.finalHash` is
 *  the sim's StreamHash; `commitments.verifierHash` names the headless verifier
 *  bundle (`verify(matchBytes) → { finalHash, result }`) anyone can re-run.
 *
 *  Seats: slot 0 and slot 1. A bout against the house bot is one participant
 *  (teams [[p], []]); player-versus-player is two ([[a], [b]]). A participant is
 *  the arcade's ed25519 player key, or `afc:<AIR sub>` outside the arcade
 *  (casual only). A bot corner has `participant: null` and no stats. */

export const RULESET_ID = 'afc.v1';

/** packages/core/src/sim.ts — the match clock. */
const ROUND_TICKS = 1350; // DEFAULT_MAX_TICKS: 45 s at 30 Hz
const ROUNDS = 3; // ROUNDS_PER_MATCH
const ROUNDS_TO_WIN = 2;
const BREAK_TICKS = 150; // ROUND_BREAK_TICKS
const MAX_TICKS = ROUND_TICKS * ROUNDS + BREAK_TICKS * (ROUNDS - 1); // MATCH_MAX_TICKS = 4350
/** Heaviest chassis 115 hp, gear at most +10%: anything past this is not a robot. */
const HP_MAX = 200;
/** Total damage a corner can deal: every round starts with at most HP_MAX and repairs a quarter of the loss. */
const DAMAGE_MAX = HP_MAX * ROUNDS;
const PILOTS = ['player', 'easy', 'medium', 'hard'];
const LOG_FORMAT = 'hmc-match@2';

const SCHEMA = { kos: 'sum', roundsWon: 'sum', damageDealt: 'sum', hits: 'sum', maxCombo: 'max', parries: 'sum', fastestKoTicks: 'min' };

const nat = (n) => Number.isInteger(n) && n >= 0;
const hex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^[0-9a-f]{64}$/;
const PREFIXED_RE = /^afc:[A-Za-z0-9-]{1,64}$/;

/** The seat a participant holds, or -1. */
const slotOf = (report, p) => (report.seats[0].participant === p ? 0 : report.seats[1].participant === p ? 1 : -1);

const checkCommitments = (c) => {
  if (!isObj(c)) return 'commitments required: AFC always has a match file';
  if (c.logFormat !== LOG_FORMAT) return `commitments.logFormat must be ${LOG_FORMAT}`;
  if (!hex(c.inputsHash, 64)) return 'commitments.inputsHash: sha256 of the exact match-file bytes (64 hex)';
  if (!hex(c.finalHash, 16)) return 'commitments.finalHash: the StreamHash finalHash (16 hex)';
  if (c.verifierHash !== null && !hex(c.verifierHash, 64)) return 'commitments.verifierHash: 64 hex or null';
  return null;
};

const checkStats = (r) => {
  if (r.stats === undefined) return null;
  if (!isObj(r.stats)) return 'stats must be an object';
  for (const [p, row] of Object.entries(r.stats)) {
    const slot = slotOf(r, p);
    if (slot < 0) return `stats.${p}: not a seat`;
    if (!isObj(row)) return `stats.${p}: an object of counters`;
    for (const [name, v] of Object.entries(row)) {
      if (!(name in SCHEMA)) return `stats.${p}.${name}: not in the schema`;
      if (!nat(v)) return `stats.${p}.${name}: a non-negative integer`;
    }
    // what the report itself already says must agree with the counters
    const ko = r.reason === 'ko' && r.winner === slot;
    if (row.kos !== undefined && row.kos !== (ko ? 1 : 0)) return `stats.${p}.kos disagrees with the result`;
    if (row.roundsWon !== undefined && row.roundsWon !== r.rounds.won[slot]) return `stats.${p}.roundsWon disagrees with rounds.won`;
    if (row.fastestKoTicks !== undefined && (!ko || row.fastestKoTicks !== r.ticks)) return `stats.${p}.fastestKoTicks only for a KO win, equal to ticks`;
    if (row.damageDealt !== undefined && row.damageDealt > DAMAGE_MAX) return `stats.${p}.damageDealt past ${DAMAGE_MAX}`;
    if (row.hits !== undefined && row.hits > r.ticks) return `stats.${p}.hits past ticks`;
    if (row.parries !== undefined && row.parries > r.ticks) return `stats.${p}.parries past ticks`;
    if (row.maxCombo !== undefined && row.maxCombo > r.ticks) return `stats.${p}.maxCombo past ticks`;
  }
  return null;
};

export const validateReport = (r) => {
  if (!isObj(r)) return 'report missing';
  if (typeof r.matchId !== 'string' || !r.matchId || r.matchId.length > 128) return 'matchId';
  if (r.replayVerified !== true) return 'only replay-verified bouts settle';
  if (r.winner !== 0 && r.winner !== 1 && r.winner !== null) return 'winner must be 0, 1 or null (a draw)';
  if (r.reason !== 'ko' && r.reason !== 'decision') return 'reason must be ko or decision';
  if (!nat(r.ticks) || r.ticks === 0 || r.ticks > MAX_TICKS) return `ticks must be 1..${MAX_TICKS}`;
  const rd = r.rounds;
  if (!isObj(rd) || !Array.isArray(rd.won) || rd.won.length !== 2 || !rd.won.every(nat)) return 'rounds.won: two non-negative integers';
  if (!Number.isInteger(rd.played) || rd.played < 1 || rd.played > ROUNDS) return `rounds.played must be 1..${ROUNDS}`;
  if (rd.won[0] > ROUNDS_TO_WIN || rd.won[1] > ROUNDS_TO_WIN || rd.won[0] + rd.won[1] > rd.played) return 'rounds.won exceeds the rounds played';
  // a round lasts ROUND_TICKS and every round after the first follows a corner break
  if (r.ticks > rd.played * ROUND_TICKS + (rd.played - 1) * BREAK_TICKS) return 'ticks exceed the rounds played';
  if (rd.played > 1 && r.ticks <= (rd.played - 1) * ROUND_TICKS) return 'too few ticks for the rounds played';
  // hp left, rounded UP: 0 means knocked out, never a sliver
  if (!Array.isArray(r.hp) || r.hp.length !== 2 || !r.hp.every((x) => nat(x) && x <= HP_MAX)) return `hp: two integers 0..${HP_MAX}`;
  if (r.reason === 'ko') {
    if (r.winner === null ? r.hp[0] !== 0 || r.hp[1] !== 0 : r.hp[1 - r.winner] !== 0) return 'a KO leaves the loser at 0 hp';
    if (r.winner !== null && r.hp[r.winner] === 0) return 'a KO winner is still standing';
  } else {
    if (r.hp[0] === 0 || r.hp[1] === 0) return 'a decision with a corner at 0 hp is a KO';
    if (rd.played < ROUNDS && Math.max(rd.won[0], rd.won[1]) < ROUNDS_TO_WIN) return 'a decision before the last round needs a corner at two rounds';
    if (r.winner !== null && rd.won[r.winner] < rd.won[1 - r.winner]) return 'the decision went to the corner with fewer rounds';
  }
  if (!Array.isArray(r.seats) || r.seats.length !== 2) return 'seats: one per slot';
  for (const s of r.seats) {
    if (!isObj(s)) return 'seats: objects';
    if (s.participant !== null && (typeof s.participant !== 'string' || !(KEY_RE.test(s.participant) || PREFIXED_RE.test(s.participant)))) return 'seats[].participant: a player key (64 hex), afc:<id>, or null for the house bot';
    if (!PILOTS.includes(s.pilot)) return `seats[].pilot must be one of ${PILOTS.join('|')}`;
    if ((s.participant === null) === (s.pilot === 'player')) return 'a player seat has a participant; a bot seat has none';
    if (!hex(s.loadoutHash, 64)) return 'seats[].loadoutHash: sha256 of the resolved robot (64 hex)';
  }
  if (r.seats[0].participant === null && r.seats[1].participant === null) return 'at least one seat is a player';
  if (r.seats[0].participant !== null && r.seats[0].participant === r.seats[1].participant) return 'one participant per seat';
  return checkCommitments(r.commitments) ?? checkStats(r);
};

export default defineAttestedTitle({
  rulesetId: RULESET_ID,
  modes: ['casual'],
  participants: [1, 2],
  teams: 2,
  equipment: 'studio',
  display: {
    title: 'AFC',
    url: 'https://afc-pi-seven.vercel.app',
    description: 'Robot Fighting Championship: humanoid mechs, three 45-second rounds. Every bout is re-simulated by the AFC host before it settles.',
  },
  // AFC court: a dedicated ed25519 key, not the host's hmc-attestation key. Pinned by this ruleset's hash, so every
  // node accepts it with no COURTS entry. The private key lives only in the AFC Vercel project's managed env
  // (LITNODE_COURT_IDENTITY), where the court's function signs (24 Oct 2026).
  attestors: ['040bc3d9de3530ae955f410b4c78bc503ca3644ab50278ea376523238ae6c5b5'],
  services: { stats: { track: ['matches', 'wins', 'ticks'], schema: SCHEMA } },
  validate: validateReport,

  /** A win is 1, anything else 0, to whichever participant holds the seat. */
  scores(report, participants) {
    return Object.fromEntries(participants.map((p) => [p, report.winner !== null && slotOf(report, p) === report.winner ? 1 : 0]));
  },

  /** The court's counters for the seats that are participants (validate() has checked them against the result). */
  stats(report, participants) {
    if (!report.stats) return null;
    return Object.fromEntries(participants.filter((p) => report.stats[p]).map((p) => [p, report.stats[p]]));
  },
});
