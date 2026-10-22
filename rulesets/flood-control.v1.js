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

// titles/flood-control.adapter.js
var RULESET_ID = "flood-control.v1";
var STORMS = 5;
var STATS = Object.freeze({ points: "max", stars: "sum", rescued: "sum", casualties: "sum", bestChain: "max", keptDry: "sum", stormsSurvived: "sum" });
var isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const leap = y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 2026 && m >= 1 && m <= 12 && d >= 1 && d <= days;
};
var nat = (n) => Number.isInteger(n) && n >= 0;
var statsProblem = (r, line) => {
  if (!line || typeof line !== "object") return "stats: one line per participant";
  for (const k of Object.keys(line)) if (!(k in STATS)) return `stats: ${k} is not a FLOOD CONTROL stat`;
  for (const k of ["points", "stars", "rescued", "casualties", "bestChain"]) if (k in line && line[k] !== r[k]) return `stats: ${k} disagrees with the report`;
  if ("stormsSurvived" in line && line.stormsSurvived !== (r.survived ? 1 : 0)) return "stats: stormsSurvived disagrees with the report";
  if ("keptDry" in line && (!nat(line.keptDry) || line.keptDry > 100)) return "stats: keptDry is a whole percent, 0..100";
  return null;
};
var validateReport = (r) => {
  if (!r || typeof r !== "object") return "report missing";
  if (typeof r.matchId !== "string" || !r.matchId) return "matchId";
  if (r.replayVerified !== true) return "only replay-verified runs settle";
  if (!isDate(r.date)) return "date must be a real YYYY-MM-DD";
  if (typeof r.levelId !== "string" || !/^[a-z0-9-]{1,32}$/.test(r.levelId)) return "levelId";
  if (!Number.isInteger(r.stormIndex) || r.stormIndex < 0 || r.stormIndex >= STORMS) return `stormIndex must be 0..${STORMS - 1}`;
  if (typeof r.mutatorId !== "string" || !r.mutatorId) return "mutatorId";
  if (!Number.isInteger(r.stars) || r.stars < 0 || r.stars > 5) return "stars must be 0..5";
  if (!nat(r.points)) return "points must be a non-negative integer";
  if (typeof r.survived !== "boolean") return "survived must be a boolean";
  if (!nat(r.rescued) || !nat(r.casualties) || !nat(r.bestChain)) return "rescued, casualties and bestChain must be non-negative integers";
  if (!r.survived && r.stars > 0) return "a lost storm earns no stars";
  if (!nat(r.ticks) || r.ticks === 0) return "ticks";
  if (r.commitments != null && r.commitments.logFormat !== "arc-runlog@1") return "commitments.logFormat must be arc-runlog@1";
  if (r.stats != null) {
    if (typeof r.stats !== "object" || Array.isArray(r.stats)) return "stats";
    for (const line of Object.values(r.stats)) {
      const p = statsProblem(r, line);
      if (p) return p;
    }
  }
  return null;
};
var flood_control_adapter_default = defineAttestedTitle({
  rulesetId: RULESET_ID,
  modes: ["casual"],
  participants: [1],
  teams: 1,
  equipment: "studio",
  display: {
    title: "FLOOD CONTROL",
    url: "https://play.bagyo.app",
    description: "Storm of the Day: hold the city against one seeded typhoon. Every run is replayed by the game before it settles."
  },
  // the board's court (scripts/arc/board/litnode.ts, its key in the game's managed env, never in a repo): every node
  // accepts its reports with no COURTS entry
  attestors: ["f82a5ef3e118426850dafe84e0e8f9509a08e9837babb4db6a33633e28a7da87"],
  // one seat: no Elo between players, no pot; the mesh keeps match stats, the game keeps its own board
  services: { stats: { track: ["matches", "wins", "ticks"], schema: STATS } },
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
  }
});
export {
  RULESET_ID,
  STATS,
  flood_control_adapter_default as default,
  validateReport
};
