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
function defineTitle({
  rulesetId,
  tickRate,
  maxTicks,
  modes = ["ranked", "casual"],
  participants = 2,
  inputSchema = "bitfield-per-tick",
  hiddenInfo = false,
  balance: balance2,
  hostPolicy = { affinity: "open" },
  replicas = 3,
  standingFloor = 0,
  exclusive = false,
  init,
  step,
  done,
  scores,
  serialize,
  view,
  services = {},
  // How the arcade lists the title: { title, url, description?, cover?, accent? }.
  // url is where the game runs; the cabinet launches it with cabinet:init.
  display = null
}) {
  for (const [name, fn] of Object.entries({ init, step, done, scores, serialize, view }))
    if (typeof fn !== "function") throw new Error(`defineTitle: ${name} is required`);
  return {
    manifest: {
      kind: "replayable",
      rulesetId,
      tickRate,
      maxTicks,
      modes,
      participants,
      inputSchema,
      hiddenInfo,
      replicas,
      standingFloor,
      hostPolicy,
      exclusive,
      display,
      balanceVersion: balance2?.version ?? null,
      services: {
        leaderboard: services.leaderboard ?? null,
        credits: services.credits ?? null,
        stats: services.stats ?? null
      }
    },
    balance: balance2,
    init,
    step,
    done,
    scores,
    // The runtime hashes this, so it must contain every field the sim reads and
    // nothing that differs between two honest hosts.
    serialize,
    // harness.observe() in Article VII step 5: what may cross to a client.
    view
  };
}
var eloLeaderboard = ({ k = 24 } = {}) => ({ kind: "elo", k });
var winnerTakesCredits = ({ pot = 10, currency = "credits" } = {}) => ({ kind: "pot", pot, currency });

// sdk/index.js
var lerp = (a, b, t) => a + (b - a) * t;
function defineBalance(map) {
  const source = Object.entries(map).map(([k, fn]) => `${k}=${fn.toString()}`).join("\n");
  let hsh = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hsh ^= source.charCodeAt(i);
    hsh = Math.imul(hsh, 16777619) >>> 0;
  }
  const version = `bal-${hsh.toString(16).padStart(8, "0")}`;
  return { version, apply: (stats) => Object.fromEntries(Object.entries(map).map(([k, fn]) => [k, fn(stats ?? {})])), map };
}
function seededRandom(seedHex) {
  let s = 0;
  for (let i = 0; i < seedHex.length; i++) s = Math.imul(s, 31) + seedHex.charCodeAt(i) >>> 0;
  if (s === 0) s = 2654435769;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

// titles/tug.v1.mjs
var TICK_RATE = 20;
var MAX_TICKS = TICK_RATE * 60;
var LIMIT = 1e3;
var balance = defineBalance({
  // uint16 [0, 65535] → a bounded per-tick pull. A 3× spread, on purpose.
  pull: (s) => Math.round(lerp(4, 12, (s.strength ?? 32768) / 65535)),
  brace: (s) => Math.round(lerp(2, 6, (s.resilience ?? 32768) / 65535))
});
var tug_v1_default = defineTitle({
  rulesetId: "tug.v1",
  tickRate: TICK_RATE,
  maxTicks: MAX_TICKS,
  participants: 2,
  inputSchema: "bitfield:pull=1,brace=2",
  modes: ["ranked", "casual"],
  balance,
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: "credits" }),
    stats: { track: ["matches", "wins", "ticks"] }
  },
  display: {
    title: "TUG",
    url: "https://example.com/tug.v1/",
    // where the game runs; the arcade launches it here
    description: "Two players, one rope. Pull, brace, win."
  },
  /** seed: hex from H(beacon, matchId). participants: [playerId, playerId]. ctx.agents: hydrated ERC-6699 tokens. */
  init(seed, participants, ctx) {
    const rnd = seededRandom(seed);
    const [a, b] = participants;
    const stat = (p) => balance.apply(ctx?.agents?.[p]?.stats);
    return {
      participants: [a, b],
      rope: 0,
      // + toward a, − toward b
      pull: { [a]: stat(a).pull, [b]: stat(b).pull },
      brace: { [a]: stat(a).brace, [b]: stat(b).brace },
      gust: rnd() % 7 - 3,
      // a seeded, replayable wind — never Math.random
      tick: 0,
      over: false
    };
  },
  /** inputs: { [playerId]: bitfield }. Must be deterministic; must not mutate `inputs`. */
  step(state, inputs) {
    if (state.over) return state;
    const [a, b] = state.participants;
    const ia = inputs[a] | 0, ib = inputs[b] | 0;
    let rope = state.rope;
    if (ia & 1) rope += ib & 2 ? Math.max(0, state.pull[a] - state.brace[b]) : state.pull[a];
    if (ib & 1) rope -= ia & 2 ? Math.max(0, state.pull[b] - state.brace[a]) : state.pull[b];
    rope += state.gust;
    const tick = state.tick + 1;
    const over = rope >= LIMIT || rope <= -LIMIT || tick >= MAX_TICKS;
    return { ...state, rope, tick, over };
  },
  done: (s) => s.over,
  /** What the root commits to: every field the sim reads, nothing a host could vary. */
  serialize: (s) => ({ participants: s.participants, rope: s.rope, tick: s.tick, over: s.over, gust: s.gust }),
  /** What a client may see. Nothing hidden in TUG, but never just return the state. */
  view: (s) => ({ rope: s.rope, tick: s.tick, over: s.over }),
  scores(s) {
    const [a, b] = s.participants;
    if (s.rope >= LIMIT) return { [a]: 1, [b]: 0 };
    if (s.rope <= -LIMIT) return { [a]: 0, [b]: 1 };
    return s.rope > 0 ? { [a]: 1, [b]: 0 } : s.rope < 0 ? { [a]: 0, [b]: 1 } : { [a]: 0, [b]: 0 };
  }
});
export {
  balance,
  tug_v1_default as default
};
