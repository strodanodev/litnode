// protocol/canonical.js
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);

// protocol/stats.js
var STAT_OPS = Object.freeze(["sum", "max", "min", "last"]);
var NAME_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
var MAX_STATS = 32;
var RESERVED = Object.freeze(["matches", "wins", "ticks"]);
function schemaProblem(schema) {
  if (schema == null) return null;
  if (typeof schema !== "object" || Array.isArray(schema)) return "stats.schema must be an object { name: op }";
  const names = Object.keys(schema);
  if (names.length > MAX_STATS) return `stats.schema has ${names.length} names; at most ${MAX_STATS}`;
  for (const n of names) {
    if (!NAME_RE.test(n)) return `stat name ${JSON.stringify(n)} must match ${NAME_RE}`;
    if (RESERVED.includes(n)) return `stat name ${n} is reserved for the built-in line`;
    if (!STAT_OPS.includes(schema[n])) return `stat ${n}: op must be one of ${STAT_OPS.join("|")} (got ${JSON.stringify(schema[n])})`;
  }
  return null;
}

// titles/title.js
var checkSchema = (services, who) => {
  const p = schemaProblem(services?.stats?.schema ?? null);
  if (p) throw new Error(`${who}: ${p}`);
};
function defineAttestedTitle({
  rulesetId,
  modes = ["ranked", "casual"],
  participants = [2],
  teams = 2,
  balance = null,
  hostPolicy = { affinity: "open" },
  standingFloor = 0,
  services = {},
  validate,
  scores,
  stats = null,
  equipment = "studio",
  display = null,
  // Which courts may sign reports for this title (ed25519 pubkeys, hex). A
  // node ALSO accepts courts its operator configures (COURTS); a report
  // from any other key is refused however valid its signature.
  attestors = []
}) {
  for (const [name, fn] of Object.entries({ validate, scores }))
    if (typeof fn !== "function") throw new Error(`defineAttestedTitle: ${name} is required`);
  checkSchema(services, "defineAttestedTitle");
  return {
    manifest: {
      kind: "attested",
      rulesetId,
      modes,
      participants,
      teams,
      standingFloor,
      hostPolicy,
      equipment,
      display,
      attestors,
      balanceVersion: balance?.version ?? null,
      services: {
        leaderboard: services.leaderboard ?? null,
        credits: services.credits ?? null,
        stats: services.stats ?? null
      }
    },
    balance,
    validate,
    scores,
    // (report, participants) → { participant: { name: value } }; the node keeps only the schema's names.
    stats: typeof stats === "function" ? stats : (report) => report?.stats ?? null
  };
}

// titles/afc.adapter.js
var RULESET_ID = "afc.v1";
var ROUND_TICKS = 1350;
var ROUNDS = 3;
var ROUNDS_TO_WIN = 2;
var BREAK_TICKS = 150;
var MAX_TICKS = ROUND_TICKS * ROUNDS + BREAK_TICKS * (ROUNDS - 1);
var HP_MAX = 200;
var DAMAGE_MAX = HP_MAX * ROUNDS;
var PILOTS = ["player", "easy", "medium", "hard"];
var LOG_FORMAT = "hmc-match@2";
var SCHEMA = { kos: "sum", roundsWon: "sum", damageDealt: "sum", hits: "sum", maxCombo: "max", parries: "sum", fastestKoTicks: "min" };
var nat = (n) => Number.isInteger(n) && n >= 0;
var hex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var KEY_RE = /^[0-9a-f]{64}$/;
var PREFIXED_RE = /^afc:[A-Za-z0-9-]{1,64}$/;
var slotOf = (report, p) => report.seats[0].participant === p ? 0 : report.seats[1].participant === p ? 1 : -1;
var checkCommitments = (c) => {
  if (!isObj(c)) return "commitments required: AFC always has a match file";
  if (c.logFormat !== LOG_FORMAT) return `commitments.logFormat must be ${LOG_FORMAT}`;
  if (!hex(c.inputsHash, 64)) return "commitments.inputsHash: sha256 of the exact match-file bytes (64 hex)";
  if (!hex(c.finalHash, 16)) return "commitments.finalHash: the StreamHash finalHash (16 hex)";
  if (c.verifierHash !== null && !hex(c.verifierHash, 64)) return "commitments.verifierHash: 64 hex or null";
  return null;
};
var checkStats = (r) => {
  if (r.stats === void 0) return null;
  if (!isObj(r.stats)) return "stats must be an object";
  for (const [p, row] of Object.entries(r.stats)) {
    const slot = slotOf(r, p);
    if (slot < 0) return `stats.${p}: not a seat`;
    if (!isObj(row)) return `stats.${p}: an object of counters`;
    for (const [name, v] of Object.entries(row)) {
      if (!(name in SCHEMA)) return `stats.${p}.${name}: not in the schema`;
      if (!nat(v)) return `stats.${p}.${name}: a non-negative integer`;
    }
    const ko = r.reason === "ko" && r.winner === slot;
    if (row.kos !== void 0 && row.kos !== (ko ? 1 : 0)) return `stats.${p}.kos disagrees with the result`;
    if (row.roundsWon !== void 0 && row.roundsWon !== r.rounds.won[slot]) return `stats.${p}.roundsWon disagrees with rounds.won`;
    if (row.fastestKoTicks !== void 0 && (!ko || row.fastestKoTicks !== r.ticks)) return `stats.${p}.fastestKoTicks only for a KO win, equal to ticks`;
    if (row.damageDealt !== void 0 && row.damageDealt > DAMAGE_MAX) return `stats.${p}.damageDealt past ${DAMAGE_MAX}`;
    if (row.hits !== void 0 && row.hits > r.ticks) return `stats.${p}.hits past ticks`;
    if (row.parries !== void 0 && row.parries > r.ticks) return `stats.${p}.parries past ticks`;
    if (row.maxCombo !== void 0 && row.maxCombo > r.ticks) return `stats.${p}.maxCombo past ticks`;
  }
  return null;
};
var validateReport = (r) => {
  if (!isObj(r)) return "report missing";
  if (typeof r.matchId !== "string" || !r.matchId || r.matchId.length > 128) return "matchId";
  if (r.replayVerified !== true) return "only replay-verified bouts settle";
  if (r.winner !== 0 && r.winner !== 1 && r.winner !== null) return "winner must be 0, 1 or null (a draw)";
  if (r.reason !== "ko" && r.reason !== "decision") return "reason must be ko or decision";
  if (!nat(r.ticks) || r.ticks === 0 || r.ticks > MAX_TICKS) return `ticks must be 1..${MAX_TICKS}`;
  const rd = r.rounds;
  if (!isObj(rd) || !Array.isArray(rd.won) || rd.won.length !== 2 || !rd.won.every(nat)) return "rounds.won: two non-negative integers";
  if (!Number.isInteger(rd.played) || rd.played < 1 || rd.played > ROUNDS) return `rounds.played must be 1..${ROUNDS}`;
  if (rd.won[0] > ROUNDS_TO_WIN || rd.won[1] > ROUNDS_TO_WIN || rd.won[0] + rd.won[1] > rd.played) return "rounds.won exceeds the rounds played";
  if (r.ticks > rd.played * ROUND_TICKS + (rd.played - 1) * BREAK_TICKS) return "ticks exceed the rounds played";
  if (rd.played > 1 && r.ticks <= (rd.played - 1) * ROUND_TICKS) return "too few ticks for the rounds played";
  if (!Array.isArray(r.hp) || r.hp.length !== 2 || !r.hp.every((x) => nat(x) && x <= HP_MAX)) return `hp: two integers 0..${HP_MAX}`;
  if (r.reason === "ko") {
    if (r.winner === null ? r.hp[0] !== 0 || r.hp[1] !== 0 : r.hp[1 - r.winner] !== 0) return "a KO leaves the loser at 0 hp";
    if (r.winner !== null && r.hp[r.winner] === 0) return "a KO winner is still standing";
  } else {
    if (r.hp[0] === 0 || r.hp[1] === 0) return "a decision with a corner at 0 hp is a KO";
    if (rd.played < ROUNDS && Math.max(rd.won[0], rd.won[1]) < ROUNDS_TO_WIN) return "a decision before the last round needs a corner at two rounds";
    if (r.winner !== null && rd.won[r.winner] < rd.won[1 - r.winner]) return "the decision went to the corner with fewer rounds";
  }
  if (!Array.isArray(r.seats) || r.seats.length !== 2) return "seats: one per slot";
  for (const s of r.seats) {
    if (!isObj(s)) return "seats: objects";
    if (s.participant !== null && (typeof s.participant !== "string" || !(KEY_RE.test(s.participant) || PREFIXED_RE.test(s.participant)))) return "seats[].participant: a player key (64 hex), afc:<id>, or null for the house bot";
    if (!PILOTS.includes(s.pilot)) return `seats[].pilot must be one of ${PILOTS.join("|")}`;
    if (s.participant === null === (s.pilot === "player")) return "a player seat has a participant; a bot seat has none";
    if (!hex(s.loadoutHash, 64)) return "seats[].loadoutHash: sha256 of the resolved robot (64 hex)";
  }
  if (r.seats[0].participant === null && r.seats[1].participant === null) return "at least one seat is a player";
  if (r.seats[0].participant !== null && r.seats[0].participant === r.seats[1].participant) return "one participant per seat";
  return checkCommitments(r.commitments) ?? checkStats(r);
};
var afc_adapter_default = defineAttestedTitle({
  rulesetId: RULESET_ID,
  modes: ["casual"],
  participants: [1, 2],
  teams: 2,
  equipment: "studio",
  display: {
    title: "AFC",
    url: "https://afc-pi-seven.vercel.app",
    description: "Robot Fighting Championship: humanoid mechs, three 45-second rounds. Every bout is re-simulated by the AFC host before it settles."
  },
  // AFC court: a dedicated ed25519 key, not the host's hmc-attestation key. Pinned by this ruleset's hash, so every
  // node accepts it with no COURTS entry. The private key lives only in the AFC Vercel project's managed env
  // (LITNODE_COURT_IDENTITY), where the court's function signs (24 Oct 2026).
  attestors: ["040bc3d9de3530ae955f410b4c78bc503ca3644ab50278ea376523238ae6c5b5"],
  services: { stats: { track: ["matches", "wins", "ticks"], schema: SCHEMA } },
  validate: validateReport,
  /** A win is 1, anything else 0, to whichever participant holds the seat. */
  scores(report, participants) {
    return Object.fromEntries(participants.map((p) => [p, report.winner !== null && slotOf(report, p) === report.winner ? 1 : 0]));
  },
  /** The court's counters for the seats that are participants (validate() has checked them against the result). */
  stats(report, participants) {
    if (!report.stats) return null;
    return Object.fromEntries(participants.filter((p) => report.stats[p]).map((p) => [p, report.stats[p]]));
  }
});
export {
  RULESET_ID,
  afc_adapter_default as default,
  validateReport
};
