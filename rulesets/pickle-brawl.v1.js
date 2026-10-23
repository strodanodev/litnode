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
var eloLeaderboard = ({ k = 24 } = {}) => ({ kind: "elo", k });
var winnerTakesCredits = ({ pot = 10, currency = "credits" } = {}) => ({ kind: "pot", pot, currency });

// titles/pickle-brawl.adapter.js
var RULESET_ID = "pickle-brawl.v1";
var GAME_TO = 11;
var validateReport = (r) => {
  if (!r || typeof r !== "object") return "report missing";
  if (typeof r.matchId !== "string" || !r.matchId) return "matchId";
  if (r.mode !== "singles" && r.mode !== "doubles") return "mode must be singles|doubles";
  const a = r.scoreA, b = r.scoreB;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return "scores must be non-negative integers";
  if (r.winnerTeam !== 0 && r.winnerTeam !== 1 && r.winnerTeam !== null) return "winnerTeam must be 0, 1 or null";
  if (r.forfeitTeam !== void 0) {
    if (r.forfeitTeam !== 0 && r.forfeitTeam !== 1) return "forfeitTeam must be 0 or 1 when present";
    if (r.winnerTeam !== 1 - r.forfeitTeam) return "a forfeit is won by the side that did not quit";
  } else if (r.winnerTeam !== null) {
    const [w, l] = r.winnerTeam === 0 ? [a, b] : [b, a];
    if (w <= l) return "winner must have the higher score";
    if (w < GAME_TO) return `a won game reaches at least ${GAME_TO}`;
    if (w - l < 2) return "win by two";
  }
  if (!Array.isArray(r.claims)) return "claims must be an array";
  const perTeam = r.mode === "singles" ? 1 : 2;
  if (r.claims.length !== perTeam * 2) return `expected ${perTeam * 2} seats for ${r.mode}`;
  for (const c of r.claims) if (typeof c?.sub !== "string" || c.team !== 0 && c.team !== 1) return "each claim needs sub and team";
  return null;
};
var pickle_brawl_adapter_default = defineAttestedTitle({
  rulesetId: RULESET_ID,
  modes: ["ranked", "casual"],
  participants: [2, 4],
  teams: 2,
  equipment: "studio",
  hostPolicy: { affinity: "operator", publisherNodes: [] },
  // the studio's courts host; open fallback stays
  // Settlement v4: the studio court's key, pinned by this ruleset's hash, so every node accepts it with no COURTS entry
  // (COURTS stays an operator override). The private key lives only in the studio's managed env.
  attestors: ["09b2b84947a10dcee1bc2f05deda59c6f4b98dc6f3c6d193071fd7c82d097e23"],
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: "pickles" }),
    // Settlement v4: what the court observes per player, as report.stats (names proposed for the PB session's hand-back;
    // the node keeps only these names, as non-negative integers).
    stats: { track: ["matches", "wins", "ticks"], schema: { pointsWon: "sum", aces: "sum", winners: "sum", unforcedErrors: "sum", smashes: "sum", dinks: "sum", longestRally: "max", matchesMvp: "sum" } }
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
  }
});
var seats = (report) => {
  const claims = [...report.claims].sort((x, y) => x.team - y.team || (x.slot ?? 0) - (y.slot ?? 0));
  const id = (c) => /^[0-9a-f]{64}$/.test(c.sub) ? c.sub : `pb:${c.sub}`;
  const teams = [claims.filter((c) => c.team === 0).map(id), claims.filter((c) => c.team === 1).map(id)];
  return { participants: [...teams[0], ...teams[1]], teams };
};
export {
  RULESET_ID,
  pickle_brawl_adapter_default as default,
  seats,
  validateReport
};
