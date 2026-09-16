// pickle-brawl.v1 · built by tools/bundle-ruleset.mjs

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

// titles/title.js
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
  equipment = "studio"
}) {
  for (const [name, fn] of Object.entries({ validate, scores }))
    if (typeof fn !== "function") throw new Error(`defineAttestedTitle: ${name} is required`);
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
      balanceVersion: balance?.version ?? null,
      services: {
        leaderboard: services.leaderboard ?? null,
        credits: services.credits ?? null,
        stats: services.stats ?? null
      }
    },
    balance,
    validate,
    scores
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
  if (r.winnerTeam !== null) {
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
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: "pickles" }),
    stats: { track: ["matches", "wins", "ticks"] }
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
  }
});
var seats = (report) => {
  const claims = [...report.claims].sort((x, y) => x.team - y.team || (x.slot ?? 0) - (y.slot ?? 0));
  const id = (c) => `pb:${c.sub}`;
  const teams = [claims.filter((c) => c.team === 0).map(id), claims.filter((c) => c.team === 1).map(id)];
  return { participants: [...teams[0], ...teams[1]], teams };
};
export {
  RULESET_ID,
  pickle_brawl_adapter_default as default,
  seats,
  validateReport
};
