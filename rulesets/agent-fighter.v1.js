// agent-fighter.v1 · engine af-core-8 · af-core 67d734a · built by tools/bundle-ruleset.mjs

// protocol/canonical.js
var canonical = (value) => JSON.stringify(value, (_k, v) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== void 0 && typeof v[k] !== "function") out[k] = v[k];
    return out;
  }
  return v;
});
var h = (tag, ...parts) => sha256Hex(`${tag}\0${parts.map((p) => typeof p === "string" ? p : canonical(p)).join("\0")}`);
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
var rotr = (x, n) => x >>> n | x << 32 - n;
function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const H2 = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  const len = bytes.length;
  const padLen = len + 9 + 63 >> 6 << 6;
  const p = new Uint8Array(padLen);
  p.set(bytes);
  p[len] = 128;
  const dv = new DataView(p.buffer);
  dv.setUint32(padLen - 8, Math.floor(len * 8 / 2 ** 32));
  dv.setUint32(padLen - 4, len * 8 >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = H2;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = hh + S1 + ch + K[i] + w[i] >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H2[0] = H2[0] + a >>> 0;
    H2[1] = H2[1] + b >>> 0;
    H2[2] = H2[2] + c >>> 0;
    H2[3] = H2[3] + d >>> 0;
    H2[4] = H2[4] + e >>> 0;
    H2[5] = H2[5] + f >>> 0;
    H2[6] = H2[6] + g >>> 0;
    H2[7] = H2[7] + hh >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += H2[i].toString(16).padStart(8, "0");
  return out;
}

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
  exclusive: exclusive2 = false,
  init,
  step: step2,
  done,
  scores,
  serialize: serialize2,
  view,
  services = {}
}) {
  for (const [name, fn] of Object.entries({ init, step: step2, done, scores, serialize: serialize2, view }))
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
      exclusive: exclusive2,
      balanceVersion: balance2?.version ?? null,
      services: {
        leaderboard: services.leaderboard ?? null,
        credits: services.credits ?? null,
        stats: services.stats ?? null
      }
    },
    balance: balance2,
    init,
    step: step2,
    done,
    scores,
    // The runtime hashes this, so it must contain every field the sim reads and
    // nothing that differs between two honest hosts.
    serialize: serialize2,
    // harness.observe() in Article VII step 5: what may cross to a client.
    view
  };
}
var eloLeaderboard = ({ k = 24 } = {}) => ({ kind: "elo", k });
var winnerTakesCredits = ({ pot = 10, currency = "credits" } = {}) => ({ kind: "pot", pot, currency });

// protocol/keccak.js
var M64 = (1n << 64n) - 1n;

// protocol/erc6699.js
var lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
function defineBalance(map) {
  return {
    map,
    version: h("balance", canonical(Object.keys(map).sort())),
    apply(stats) {
      const out = {};
      for (const [k, fn] of Object.entries(map)) out[k] = fn(stats);
      return out;
    }
  };
}

// ../AGENT FIGHTER/agent-fighter/packages/core/src/fp.ts
var FP = 256;
var fp = (px) => Math.trunc(px * FP);
var fpToPx = (v) => Math.trunc(v / FP);
var clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
var nextRand = (seed) => {
  let t = seed + 1831565813 | 0;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t = t + Math.imul(t ^ t >>> 7, t | 61) | 0;
  return (t ^ t >>> 14) >>> 0;
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/input.ts
var Btn = /* @__PURE__ */ ((Btn2) => {
  Btn2[Btn2["Left"] = 1] = "Left";
  Btn2[Btn2["Right"] = 2] = "Right";
  Btn2[Btn2["Up"] = 4] = "Up";
  Btn2[Btn2["Down"] = 8] = "Down";
  Btn2[Btn2["LP"] = 16] = "LP";
  Btn2[Btn2["MP"] = 32] = "MP";
  Btn2[Btn2["HP"] = 64] = "HP";
  Btn2[Btn2["LK"] = 128] = "LK";
  Btn2[Btn2["MK"] = 256] = "MK";
  Btn2[Btn2["HK"] = 512] = "HK";
  Btn2[Btn2["Item"] = 1024] = "Item";
  Btn2[Btn2["Item2"] = 2048] = "Item2";
  Btn2[Btn2["Item3"] = 4096] = "Item3";
  return Btn2;
})(Btn || {});
var ITEM_BITS = [1024 /* Item */, 2048 /* Item2 */, 4096 /* Item3 */];
var PUNCH_MASK = 16 /* LP */ | 32 /* MP */ | 64 /* HP */;
var KICK_MASK = 128 /* LK */ | 256 /* MK */ | 512 /* HK */;
var ATTACK_MASK = PUNCH_MASK | KICK_MASK;
var DIR_MASK = 1 /* Left */ | 2 /* Right */ | 4 /* Up */ | 8 /* Down */;
var held = (f, b) => (f & b) !== 0;
var pressedAttacks = (now, prev) => now & ~prev & ATTACK_MASK;
var countBits = (v) => {
  let n = 0;
  while (v !== 0) {
    n += v & 1;
    v >>>= 1;
  }
  return n;
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/data.ts
var CHAR_TUNING_KEYS = [
  "jumpSquatTicks",
  "knockdownTicks",
  "getupTicks",
  "grabTicks"
];
var BUTTON_BITS = {
  LP: 16 /* LP */,
  MP: 32 /* MP */,
  HP: 64 /* HP */,
  LK: 128 /* LK */,
  MK: 256 /* MK */,
  HK: 512 /* HK */
};
var BUTTON_PRIORITY = ["HP", "HK", "MP", "MK", "LP", "LK"];
var STANCE_IDX = { stand: 0, crouch: 1, air: 2 };
var bitPos = (bit) => {
  let p = 0;
  while ((bit >>= 1) !== 0) p++;
  return p;
};
var loadCharacter = (b) => {
  const n = b.moves.length;
  const moveIdxById = {};
  b.moves.forEach((m, i) => {
    if (moveIdxById[m.id] !== void 0) throw new Error(`duplicate move id: ${m.id}`);
    if (m.steps.length === 0) throw new Error(`move ${m.id} has no steps`);
    for (const st of m.steps) {
      if (!Number.isInteger(st.frames) || st.frames <= 0) {
        throw new Error(`move ${m.id}: step frames must be positive integers`);
      }
    }
    moveIdxById[m.id] = i;
  });
  const num = (v, what) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${b.name}: ${what} must be a finite number (got ${v})`);
    return v;
  };
  if (num(b.maxHealth, "maxHealth") <= 0) throw new Error(`${b.name}: maxHealth must be > 0 (got ${b.maxHealth})`);
  if (num(b.gravity, "gravity") <= 0) throw new Error(`${b.name}: gravity must be > 0 or fighters never fall (got ${b.gravity})`);
  if (num(b.throwTossVelY, "throwTossVelY") >= 0) throw new Error(`${b.name}: throwTossVelY must be < 0 (upward); a non-upward toss strands the victim in AirHitstun (got ${b.throwTossVelY})`);
  const checkHit = (h2, where) => {
    num(h2.damage, `${where} damage`);
    if (num(h2.chip, `${where} chip`) < 0) throw new Error(`${b.name}: ${where} chip must be >= 0; negative chip heals (got ${h2.chip})`);
    if (num(h2.juggleCost, `${where} juggleCost`) < 0) throw new Error(`${b.name}: ${where} juggleCost must be >= 0; negative enables infinite combos (got ${h2.juggleCost})`);
    if (h2.launchVelY !== void 0 && num(h2.launchVelY, `${where} launchVelY`) >= 0) throw new Error(`${b.name}: ${where} launchVelY must be < 0 (upward); a non-upward launch strands the victim in AirHitstun (got ${h2.launchVelY})`);
    if (h2.airPopVelY !== void 0) num(h2.airPopVelY, `${where} airPopVelY`);
  };
  b.moves.forEach((m) => {
    if (m.meterCost !== void 0 && num(m.meterCost, `${m.id} meterCost`) < 0) throw new Error(`${b.name}: ${m.id} meterCost must be >= 0; negative mints meter (got ${m.meterCost})`);
    for (const st of m.steps) for (const h2 of st.hitboxes ?? []) checkHit(h2, m.id);
    if (m.projectile) checkHit(m.projectile.hit, `${m.id} projectile`);
  });
  if (b.tuning) {
    for (const k of Object.keys(b.tuning)) {
      if (!CHAR_TUNING_KEYS.includes(k)) {
        throw new Error(`${b.name}: unknown tuning override "${k}" (allowed: ${CHAR_TUNING_KEYS.join(", ")})`);
      }
      const v = b.tuning[k];
      if (!Number.isInteger(v) || v < 1) throw new Error(`${b.name}: tuning.${k} must be an integer >= 1 (got ${v})`);
    }
  }
  const normals = [new Int32Array(10).fill(-1), new Int32Array(10).fill(-1), new Int32Array(10).fill(-1)];
  const specials = [];
  let superIdx = -1;
  const totalFrames = new Int32Array(n);
  const firstActiveStep = new Int32Array(n).fill(-1);
  b.moves.forEach((m, i) => {
    totalFrames[i] = m.steps.reduce((acc, s) => acc + s.frames, 0);
    const act = m.steps.findIndex((s) => s.phase === "active");
    firstActiveStep[i] = act;
    if (m.type === "normal") {
      if (!m.button) throw new Error(`normal ${m.id} missing button`);
      normals[STANCE_IDX[m.stance]][bitPos(BUTTON_BITS[m.button])] = i;
    } else if (m.type === "special") {
      if (!m.motion || !m.buttons || m.buttons === "PP") throw new Error(`special ${m.id} needs motion + P/K`);
      specials.push({ motion: m.motion, kind: m.buttons, idx: i });
    } else if (m.type === "super") {
      if (!m.motion || m.buttons !== "PP") throw new Error(`super ${m.id} needs motion + PP`);
      if (m.meterCost === void 0) throw new Error(`super ${m.id} missing meterCost`);
      superIdx = i;
    }
  });
  const cancelHit = new Uint8Array(n * n);
  const cancelBlock = new Uint8Array(n * n);
  for (const edge of b.cancels) {
    const from = moveIdxById[edge.from];
    if (from === void 0) throw new Error(`cancel edge from unknown move: ${edge.from}`);
    for (const toId of edge.to) {
      const to = moveIdxById[toId];
      if (to === void 0) throw new Error(`cancel edge to unknown move: ${toId}`);
      if (edge.on.includes("hit")) cancelHit[from * n + to] = 1;
      if (edge.on.includes("block")) cancelBlock[from * n + to] = 1;
    }
  }
  return { b, moveIdxById, normals, specials, superIdx, totalFrames, firstActiveStep, cancelHit, cancelBlock };
};
var STAGE = {
  widthPx: 1600,
  // ~2.5 viewport-widths of 960 minus margins; camera scrolls
  floorYPx: 460,
  wallPad: 24,
  viewportW: 960,
  viewportH: 540
};
var TICKS_PER_SEC = 60;
var ROUND_SECONDS = 99;
var ENGINE_VERSION = "af-core-8";
var TUNING_INIT = {
  roundsToWin: 2,
  // best of 3
  preRoundTicks: 60,
  roundOverTicks: 120,
  meterMax: 3e3,
  // 3 bars
  meterBar: 1e3,
  superFlashTicks: 28,
  inputBufferTicks: 8,
  motionWindowTicks: 14,
  doubleTapWindowTicks: 11,
  superJumpDownWindow: 10,
  // ticks between down-tap and up for super jump
  jumpSquatTicks: 4,
  landingRecovers: true,
  juggleBudget: 8,
  scalingStart: 1e3,
  // per-mille
  scalingMult: 900,
  // compounding ×0.9 per hit
  scalingFloor: 200,
  // 20% floor
  minHitstun: 8,
  hitstunDecayShift: 1,
  // effective stun = base - (comboHits >> shift)
  knockdownTicks: 36,
  getupTicks: 14,
  grabTicks: 18,
  // throw connects at end unless teched
  throwTechWindow: 10,
  pushblockSelfVel: 12,
  // px/tick the blocker slides back (must clearly beat heavy pushbackBlock)
  pushblockAttackerVel: 7,
  // applied to attacker when blocker is cornered
  victimMeterDivisor: 20,
  // victim gains damage/20 meter
  blockMeterGain: 10,
  friction: 0.5,
  // px/tick² ground slide decel
  cornerThresholdPx: 26,
  // "at the wall" for pushback transfer
  throwStartsComboScaling: true
};
var TUNING = { ...TUNING_INIT };
var TUNING_DEFAULTS = Object.freeze({ ...TUNING_INIT });

// ../AGENT FIGHTER/agent-fighter/packages/core/src/motion.ts
var HIST_LEN = 16;
var numpadDir = (input, facing) => {
  const rawX = (held(input, 2 /* Right */) ? 1 : 0) - (held(input, 1 /* Left */) ? 1 : 0);
  const fx = rawX * facing;
  const base = held(input, 4 /* Up */) ? 8 : held(input, 8 /* Down */) ? 2 : 5;
  return base + fx;
};
var matchesPattern = (hist, histIdx, window, pattern) => {
  let p = 0;
  for (let k = window - 1; k >= 0 && p < pattern.length; k--) {
    const dir = hist[(histIdx - k + HIST_LEN * 2) % HIST_LEN];
    if ((pattern[p] & 1 << dir) !== 0) p++;
  }
  return p === pattern.length;
};
var D = (...dirs) => dirs.reduce((m, d) => m | 1 << d, 0);
var PAT_623 = [D(6), D(2, 1), D(3)];
var PAT_236 = [D(2), D(3, 6)];
var PAT_236_STRICT_END = [D(2), D(6)];
var PAT_214 = [D(2), D(1, 4)];
var PAT_214_STRICT_END = [D(2), D(4)];
var detectMotion = (hist, histIdx) => {
  const w = TUNING.motionWindowTicks;
  if (matchesPattern(hist, histIdx, w, PAT_623)) return 623;
  if (matchesPattern(hist, histIdx, w, PAT_236) || matchesPattern(hist, histIdx, w, PAT_236_STRICT_END)) return 236;
  if (matchesPattern(hist, histIdx, w, PAT_214) || matchesPattern(hist, histIdx, w, PAT_214_STRICT_END)) return 214;
  return 0;
};
var downTappedRecently = (hist, histIdx) => {
  for (let k = 1; k <= TUNING.superJumpDownWindow; k++) {
    const dir = hist[(histIdx - k + HIST_LEN * 2) % HIST_LEN];
    if (dir >= 1 && dir <= 3) return true;
  }
  return false;
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/characters/analog.ts
var STAND = { x: -26, y: -108, w: 52, h: 108 };
var CROUCH = { x: -26, y: -80, w: 52, h: 80 };
var AIR = { x: -26, y: -98, w: 52, h: 88 };
var mkStrike = (id, stance, button, sp) => {
  const base = stance === "crouch" ? CROUCH : stance === "air" ? AIR : STAND;
  const activeHurt = sp.extendHurt ? [base, { x: sp.rect.x, y: sp.rect.y, w: sp.rect.w, h: sp.rect.h }] : [base];
  const hit = {
    rect: sp.rect,
    damage: sp.damage,
    chip: sp.chip ?? 0,
    hitstun: sp.hitstun,
    blockstun: sp.blockstun,
    hitstopFrames: sp.hitstop,
    pushbackHit: sp.pushHit,
    pushbackBlock: sp.pushBlock,
    guard: sp.guard ?? "mid",
    juggleCost: sp.juggleCost ?? 1,
    launcher: sp.launcher,
    launchVelY: sp.launchVelY,
    knockdown: sp.knockdown
  };
  return {
    id,
    type: "normal",
    stance,
    button,
    steps: [
      { frames: sp.startup, phase: "startup", hurtboxes: [base] },
      { frames: sp.active, phase: "active", hurtboxes: activeHurt, hitboxes: [hit] },
      { frames: sp.recovery, phase: "recovery", hurtboxes: [base] }
    ],
    meterGainWhiff: sp.meterWhiff ?? 5,
    meterGainHit: sp.meterHit ?? 40
  };
};
var MOVES = [
  // -------------------------------------------------- standing normals
  mkStrike("5LP", "stand", "LP", {
    startup: 3,
    active: 3,
    recovery: 6,
    rect: { x: 22, y: -96, w: 44, h: 22 },
    damage: 300,
    hitstun: 14,
    blockstun: 10,
    hitstop: 5,
    pushHit: 4.5,
    pushBlock: 5,
    meterWhiff: 5,
    meterHit: 40,
    extendHurt: 1
  }),
  mkStrike("5MP", "stand", "MP", {
    startup: 6,
    active: 4,
    recovery: 10,
    rect: { x: 24, y: -100, w: 52, h: 28 },
    damage: 550,
    hitstun: 17,
    blockstun: 13,
    hitstop: 6,
    pushHit: 5.5,
    pushBlock: 6.5,
    meterWhiff: 8,
    meterHit: 70,
    extendHurt: 1
  }),
  mkStrike("5HP", "stand", "HP", {
    startup: 9,
    active: 4,
    recovery: 16,
    rect: { x: 26, y: -104, w: 60, h: 34 },
    damage: 800,
    hitstun: 21,
    blockstun: 16,
    hitstop: 8,
    pushHit: 6.5,
    pushBlock: 8,
    meterWhiff: 12,
    meterHit: 100,
    extendHurt: 1
  }),
  mkStrike("5LK", "stand", "LK", {
    startup: 4,
    active: 3,
    recovery: 8,
    rect: { x: 20, y: -60, w: 46, h: 24 },
    damage: 320,
    hitstun: 14,
    blockstun: 10,
    hitstop: 5,
    pushHit: 4.5,
    pushBlock: 5,
    meterWhiff: 5,
    meterHit: 40,
    extendHurt: 1
  }),
  mkStrike("5MK", "stand", "MK", {
    startup: 7,
    active: 4,
    recovery: 12,
    rect: { x: 24, y: -74, w: 54, h: 26 },
    damage: 570,
    hitstun: 17,
    blockstun: 13,
    hitstop: 6,
    pushHit: 5.5,
    pushBlock: 6.5,
    meterWhiff: 8,
    meterHit: 70,
    extendHurt: 1
  }),
  mkStrike("5HK", "stand", "HK", {
    startup: 10,
    active: 5,
    recovery: 18,
    rect: { x: 26, y: -92, w: 62, h: 40 },
    damage: 830,
    hitstun: 22,
    blockstun: 17,
    hitstop: 8,
    pushHit: 7,
    pushBlock: 8.5,
    meterWhiff: 12,
    meterHit: 100,
    extendHurt: 1
  }),
  // -------------------------------------------------- crouching normals
  mkStrike("2LP", "crouch", "LP", {
    startup: 3,
    active: 3,
    recovery: 6,
    rect: { x: 20, y: -66, w: 42, h: 20 },
    damage: 280,
    hitstun: 14,
    blockstun: 10,
    hitstop: 5,
    pushHit: 4.5,
    pushBlock: 5,
    meterWhiff: 5,
    meterHit: 40,
    extendHurt: 1
  }),
  mkStrike("2MP", "crouch", "MP", {
    startup: 6,
    active: 4,
    recovery: 11,
    rect: { x: 20, y: -84, w: 48, h: 30 },
    damage: 520,
    hitstun: 17,
    blockstun: 13,
    hitstop: 6,
    pushHit: 5.5,
    pushBlock: 6.5,
    meterWhiff: 8,
    meterHit: 70,
    extendHurt: 1
  }),
  // THE launcher. Pops up for super-jump air combos (magic series apex).
  mkStrike("2HP", "crouch", "HP", {
    startup: 10,
    active: 4,
    recovery: 20,
    rect: { x: 14, y: -120, w: 44, h: 70 },
    damage: 750,
    hitstun: 90,
    blockstun: 16,
    hitstop: 9,
    pushHit: 2,
    pushBlock: 8,
    launcher: true,
    launchVelY: -17,
    knockdown: true,
    juggleCost: 1,
    meterWhiff: 12,
    meterHit: 100,
    extendHurt: 1
  }),
  mkStrike("2LK", "crouch", "LK", {
    startup: 4,
    active: 3,
    recovery: 7,
    rect: { x: 18, y: -26, w: 44, h: 22 },
    damage: 260,
    hitstun: 13,
    blockstun: 10,
    hitstop: 5,
    pushHit: 4,
    pushBlock: 4.5,
    guard: "low",
    meterWhiff: 5,
    meterHit: 40,
    extendHurt: 1
  }),
  mkStrike("2MK", "crouch", "MK", {
    startup: 7,
    active: 4,
    recovery: 13,
    rect: { x: 22, y: -28, w: 56, h: 24 },
    damage: 500,
    hitstun: 16,
    blockstun: 13,
    hitstop: 6,
    pushHit: 5.5,
    pushBlock: 6.5,
    guard: "low",
    meterWhiff: 8,
    meterHit: 70,
    extendHurt: 1
  }),
  // Sweep: low + knockdown.
  mkStrike("2HK", "crouch", "HK", {
    startup: 11,
    active: 5,
    recovery: 22,
    rect: { x: 20, y: -24, w: 66, h: 22 },
    damage: 780,
    hitstun: 30,
    blockstun: 17,
    hitstop: 8,
    pushHit: 5,
    pushBlock: 8,
    guard: "low",
    knockdown: true,
    meterWhiff: 12,
    meterHit: 100,
    extendHurt: 1
  }),
  // -------------------------------------------------- air normals (overheads)
  mkStrike("j.LP", "air", "LP", {
    startup: 3,
    active: 8,
    recovery: 4,
    rect: { x: 16, y: -86, w: 42, h: 26 },
    damage: 300,
    hitstun: 15,
    blockstun: 11,
    hitstop: 5,
    pushHit: 4,
    pushBlock: 4.5,
    guard: "overhead",
    meterWhiff: 5,
    meterHit: 40
  }),
  mkStrike("j.MP", "air", "MP", {
    startup: 5,
    active: 6,
    recovery: 6,
    rect: { x: 18, y: -92, w: 50, h: 30 },
    damage: 540,
    hitstun: 18,
    blockstun: 13,
    hitstop: 6,
    pushHit: 5,
    pushBlock: 5.5,
    guard: "overhead",
    meterWhiff: 8,
    meterHit: 70
  }),
  // Air finisher: knocks down out of air combos.
  mkStrike("j.HP", "air", "HP", {
    startup: 7,
    active: 6,
    recovery: 8,
    rect: { x: 18, y: -96, w: 56, h: 38 },
    damage: 820,
    hitstun: 24,
    blockstun: 16,
    hitstop: 8,
    pushHit: 6.5,
    pushBlock: 7,
    guard: "overhead",
    knockdown: true,
    juggleCost: 2,
    meterWhiff: 12,
    meterHit: 100
  }),
  mkStrike("j.LK", "air", "LK", {
    startup: 4,
    active: 8,
    recovery: 4,
    rect: { x: 14, y: -60, w: 44, h: 26 },
    damage: 310,
    hitstun: 15,
    blockstun: 11,
    hitstop: 5,
    pushHit: 4,
    pushBlock: 4.5,
    guard: "overhead",
    meterWhiff: 5,
    meterHit: 40
  }),
  mkStrike("j.MK", "air", "MK", {
    startup: 6,
    active: 7,
    recovery: 6,
    rect: { x: 16, y: -66, w: 52, h: 30 },
    damage: 560,
    hitstun: 18,
    blockstun: 13,
    hitstop: 6,
    pushHit: 5,
    pushBlock: 5.5,
    guard: "overhead",
    meterWhiff: 8,
    meterHit: 70
  }),
  mkStrike("j.HK", "air", "HK", {
    startup: 8,
    active: 6,
    recovery: 8,
    rect: { x: 20, y: -80, w: 60, h: 42 },
    damage: 850,
    hitstun: 24,
    blockstun: 16,
    hitstop: 8,
    pushHit: 6.5,
    pushBlock: 7,
    guard: "overhead",
    knockdown: true,
    juggleCost: 2,
    meterWhiff: 12,
    meterHit: 100
  }),
  // -------------------------------------------------- specials
  // 236P — Analog Wave (fireball). Projectile spawns at first active frame.
  {
    id: "236P",
    type: "special",
    stance: "stand",
    motion: 236,
    buttons: "P",
    steps: [
      { frames: 12, phase: "startup", hurtboxes: [STAND] },
      { frames: 2, phase: "active", hurtboxes: [STAND] },
      { frames: 18, phase: "recovery", hurtboxes: [STAND] }
    ],
    projectile: {
      spawnX: 50,
      spawnY: -78,
      velX: 8,
      lifetime: 90,
      rect: { x: -18, y: -14, w: 36, h: 28 },
      hit: {
        rect: { x: -18, y: -14, w: 36, h: 28 },
        damage: 700,
        chip: 90,
        hitstun: 20,
        blockstun: 15,
        hitstopFrames: 6,
        pushbackHit: 6,
        pushbackBlock: 7,
        guard: "mid",
        juggleCost: 2,
        airPopVelY: -6
      }
    },
    meterGainWhiff: 20,
    meterGainHit: 120
  },
  // 623P — Rising Glitch (dragon punch). Self-launches, knocks down.
  {
    id: "623P",
    type: "special",
    stance: "stand",
    motion: 623,
    buttons: "P",
    steps: [
      { frames: 4, phase: "startup", hurtboxes: [STAND] },
      {
        frames: 10,
        phase: "active",
        velX: 3.5,
        velY: -13,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 6, y: -128, w: 46, h: 92 },
          damage: 900,
          chip: 110,
          hitstun: 40,
          blockstun: 18,
          hitstopFrames: 9,
          pushbackHit: 3,
          pushbackBlock: 8,
          guard: "mid",
          juggleCost: 3,
          launcher: true,
          launchVelY: -14,
          knockdown: true
        }]
      },
      { frames: 14, phase: "recovery", hurtboxes: [STAND] }
    ],
    meterGainWhiff: 20,
    meterGainHit: 140
  },
  // 214K — Scanline Sweep (advancing two-hit kick).
  {
    id: "214K",
    type: "special",
    stance: "stand",
    motion: 214,
    buttons: "K",
    steps: [
      { frames: 8, phase: "startup", hurtboxes: [STAND] },
      {
        frames: 8,
        phase: "active",
        velX: 6,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 16, y: -84, w: 52, h: 40 },
          damage: 400,
          chip: 50,
          hitstun: 18,
          blockstun: 13,
          hitstopFrames: 6,
          pushbackHit: 3,
          pushbackBlock: 5,
          guard: "mid",
          juggleCost: 2,
          airPopVelY: -7
        }]
      },
      {
        frames: 8,
        phase: "active",
        velX: 6,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 16, y: -84, w: 52, h: 40 },
          damage: 420,
          chip: 50,
          hitstun: 24,
          blockstun: 14,
          hitstopFrames: 7,
          pushbackHit: 6,
          pushbackBlock: 7,
          guard: "mid",
          juggleCost: 2,
          knockdown: true,
          airPopVelY: -6
        }]
      },
      { frames: 16, phase: "recovery", velX: 0, hurtboxes: [STAND] }
    ],
    meterGainWhiff: 20,
    meterGainHit: 130
  },
  // -------------------------------------------------- super
  // 236PP — SYSTEM CRASH. 5-hit rushing super, 1 bar, super-flash freeze.
  {
    id: "236PP",
    type: "super",
    stance: "stand",
    motion: 236,
    buttons: "PP",
    meterCost: 1e3,
    steps: [
      { frames: 6, phase: "startup", hurtboxes: [STAND] },
      ...Array.from({ length: 4 }, (_, k) => ({
        frames: 4,
        phase: "active",
        velX: 7,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 14, y: -104, w: 62, h: 74 },
          damage: 500,
          chip: 70,
          hitstun: 22,
          blockstun: 14,
          hitstopFrames: 5,
          pushbackHit: 1.5,
          pushbackBlock: 4,
          guard: "mid",
          juggleCost: 0,
          airPopVelY: -6
        }]
      })),
      {
        frames: 5,
        phase: "active",
        velX: 4,
        hurtboxes: [STAND],
        hitboxes: [{
          rect: { x: 14, y: -110, w: 70, h: 84 },
          damage: 1e3,
          chip: 120,
          hitstun: 30,
          blockstun: 18,
          hitstopFrames: 10,
          pushbackHit: 9,
          pushbackBlock: 10,
          guard: "mid",
          juggleCost: 0,
          launcher: true,
          launchVelY: -12,
          knockdown: true
        }]
      },
      { frames: 24, phase: "recovery", velX: 0, hurtboxes: [STAND] }
    ],
    meterGainWhiff: 0,
    meterGainHit: 0
  }
];
var L = ["5LP", "5LK", "2LP", "2LK"];
var M = ["5MP", "5MK", "2MP", "2MK"];
var H = ["5HP", "5HK", "2HK"];
var LAUNCHER = ["2HP"];
var SPECIALS = ["236P", "623P", "214K"];
var SUPER = ["236PP"];
var AIR_L = ["j.LP", "j.LK"];
var AIR_M = ["j.MP", "j.MK"];
var AIR_H = ["j.HP", "j.HK"];
var edges = (from, to, on) => from.map((f) => ({ from: f, to, on }));
var CANCELS = [
  // Ground magic series: L → (other Ls) → M → H → launcher, on hit or block.
  ...edges(L, [...L, ...M, ...H, ...LAUNCHER], ["hit", "block"]),
  ...edges(M, [...H, ...LAUNCHER], ["hit", "block"]),
  ...edges(H, LAUNCHER, ["hit", "block"]),
  // Any ground normal cancels into specials and super.
  ...edges([...L, ...M, ...H, ...LAUNCHER], [...SPECIALS, ...SUPER], ["hit", "block"]),
  // Specials cancel into super.
  ...edges(SPECIALS, SUPER, ["hit", "block"]),
  // Air series: L → M → H (finisher ends the combo).
  ...edges(AIR_L, [...AIR_M, ...AIR_H], ["hit", "block"]),
  ...edges(AIR_M, AIR_H, ["hit", "block"])
];
var ANALOG = {
  name: "Analog",
  maxHealth: 1e4,
  walkFSpeed: 4.2,
  walkBSpeed: 3.2,
  dashFSpeed: 9,
  dashFTicks: 14,
  dashBSpeed: 7.5,
  dashBTicks: 12,
  jumpVelY: -14,
  superJumpVelY: -19.5,
  jumpVelX: 5,
  gravity: 0.8,
  doubleJump: true,
  airDash: true,
  airDashSpeed: 8.5,
  airDashTicks: 12,
  bodyWidth: 52,
  standHurtbox: STAND,
  crouchHurtbox: CROUCH,
  airHurtbox: AIR,
  throwRange: 72,
  throwDamage: 1e3,
  throwTossVelX: 9,
  throwTossVelY: -8,
  moves: MOVES,
  cancels: CANCELS
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/pets.ts
var AURA_MAX = 80;
var PET_REGEN_PERIOD_TICKS = 3600;
var PET_CRIT_BONUS = 500;
var PET_CRIT_FLASH_TICKS = 24;
var NO_AURA = Object.freeze({
  atk: 0,
  def: 0,
  hpRegen: 0,
  crit: 0,
  energyRegen: 0
});
var clampLine = (v) => {
  const n = Math.trunc(Number(v) || 0);
  return n <= 0 ? 0 : n > AURA_MAX ? AURA_MAX : n;
};
var clampAura = (a) => ({
  atk: clampLine(a?.atk),
  def: clampLine(a?.def),
  hpRegen: clampLine(a?.hpRegen),
  crit: clampLine(a?.crit),
  energyRegen: clampLine(a?.energyRegen)
});

// ../AGENT FIGHTER/agent-fighter/packages/core/src/state.ts
var Phase = /* @__PURE__ */ ((Phase2) => {
  Phase2[Phase2["PreRound"] = 0] = "PreRound";
  Phase2[Phase2["Fighting"] = 1] = "Fighting";
  Phase2[Phase2["RoundOver"] = 2] = "RoundOver";
  Phase2[Phase2["MatchOver"] = 3] = "MatchOver";
  return Phase2;
})(Phase || {});
var PROJECTILE_SLOTS = 4;
var characters = [
  loadCharacter(ANALOG),
  loadCharacter(ANALOG)
];
var setCharacters = (c0, c1) => {
  characters[0] = c0;
  characters[1] = c1;
};
var ITEM_SLOTS = 3;
var matchItems = [[], []];
var setMatchItems = (i0, i1) => {
  const clampSide = (side) => (side ?? []).slice(0, ITEM_SLOTS).map((e) => ({
    kind: e.kind,
    amount: Math.max(0, Math.min(500, Math.trunc(e.amount))),
    durationTicks: Math.max(0, Math.min(7200, Math.trunc(e.durationTicks)))
  }));
  matchItems[0] = clampSide(i0);
  matchItems[1] = clampSide(i1);
};
var matchAuras = [{ ...NO_AURA }, { ...NO_AURA }];
var setMatchPets = (a0, a1) => {
  matchAuras[0] = clampAura(a0);
  matchAuras[1] = clampAura(a1);
};
var ITEM_KIND_CODE = {
  heal: 1,
  damageMult: 2,
  defenseMult: 3,
  meterGain: 4
};
var carriedItem = (i, s) => {
  const e = matchItems[i][s];
  return e ? { kind: ITEM_KIND_CODE[e.kind], amount: e.amount, dur: e.durationTicks } : { kind: 0, amount: 0, dur: 0 };
};
var SPAWN_OFFSET = 180;
var spawnFighter = (x, facing, ch, _side) => ({
  x: fp(x),
  y: fp(STAGE.floorYPx),
  velX: 0,
  velY: 0,
  facing,
  health: ch.b.maxHealth,
  // drinks are drunk mid-match now (Phase 3), not at spawn
  meter: 0,
  action: 0 /* Idle */,
  actionFrame: 0,
  moveIdx: -1,
  attackConnected: 0,
  hitConsumedStep: -1,
  hitstunLeft: 0,
  blockstunLeft: 0,
  knockdownOnLand: 0,
  jumpsLeft: 0,
  airdashLeft: 0,
  superJumped: 0,
  airLocked: 0,
  juggleBudget: 0,
  comboHits: 0,
  comboScaling: TUNING.scalingStart,
  bufMotion: 0,
  bufButtons: 0,
  bufLeft: 0,
  tapDir: 0,
  tapTimer: 0,
  dashBuf: 0,
  dashBufLeft: 0,
  pushblocked: 0,
  techLeft: 0,
  throwBack: 0,
  launchJC: 0,
  wantThrow: 0,
  histIdx: 0,
  prevInput: 0,
  // Carried drinks + active buffs are set by the callers (match start loads
  // from the pinned loadout; round reset carries the slots over like meter).
  // Defaulting to empty here keeps spawnFighter side-effect-free.
  itemKind0: 0,
  itemAmount0: 0,
  itemDur0: 0,
  itemKind1: 0,
  itemAmount1: 0,
  itemDur1: 0,
  itemKind2: 0,
  itemAmount2: 0,
  itemDur2: 0,
  itemDmg: 0,
  itemDmgLeft: 0,
  itemDef: 0,
  itemDefLeft: 0,
  // The pet aura is installed by the callers from the pinned loadout (match
  // start AND every round reset — unlike a drink it is never spent), so
  // spawnFighter stays side-effect-free.
  auraAtk: 0,
  auraDef: 0,
  auraCrit: 0,
  auraHpRegen: 0,
  auraEnergyRegen: 0,
  auraHpAcc: 0,
  auraMeterAcc: 0,
  critFlash: 0,
  dirHist: new Array(HIST_LEN).fill(5)
});
var emptyProjectile = () => ({
  active: 0,
  owner: 0,
  moveIdx: -1,
  x: 0,
  y: 0,
  velX: 0,
  life: 0,
  hasHit: 0
});
var DEFAULT_BOUNDS = { left: 0, right: STAGE.widthPx };
var wallLFp = (b) => fp(b.left + STAGE.wallPad);
var wallRFp = (b) => fp(b.right - STAGE.wallPad);
var centerPx = (wallL, wallR) => fpToPx(Math.trunc((wallL + wallR) / 2));
var spawnOffsetFor = (wallL, wallR) => {
  const halfGap = fpToPx((wallR - wallL) / 2);
  return Math.max(0, Math.min(SPAWN_OFFSET, halfGap - 20));
};
var createGameState = (seed, bounds = DEFAULT_BOUNDS) => {
  const wallL = wallLFp(bounds);
  const wallR = wallRFp(bounds);
  const cx = centerPx(wallL, wallR);
  const off = spawnOffsetFor(wallL, wallR);
  return {
    tick: 0,
    rngSeed: seed | 0,
    phase: 0 /* PreRound */,
    winner: -1,
    roundWinner: -1,
    roundsWon0: 0,
    roundsWon1: 0,
    roundNum: 0,
    timerTicks: ROUND_SECONDS * TICKS_PER_SEC,
    phaseTimer: TUNING.preRoundTicks,
    hitstopLeft: 0,
    superFlashLeft: 0,
    wallL,
    wallR,
    fighters: [
      spawnItemFighter(0, cx, off),
      spawnItemFighter(1, cx, off)
    ],
    projectiles: Array.from({ length: PROJECTILE_SLOTS }, emptyProjectile)
  };
};
var spawnItemFighter = (i, cx, off) => {
  const f = spawnFighter(
    cx + (i === 0 ? -off : off),
    i === 0 ? 1 : -1,
    characters[i],
    i
  );
  loadCarriedSlots(f, i);
  installAura(f, i);
  return f;
};
var installAura = (f, i) => {
  const a = matchAuras[i];
  f.auraAtk = a.atk;
  f.auraDef = a.def;
  f.auraCrit = a.crit;
  f.auraHpRegen = a.hpRegen;
  f.auraEnergyRegen = a.energyRegen;
  f.auraHpAcc = 0;
  f.auraMeterAcc = 0;
  f.critFlash = 0;
};
var loadCarriedSlots = (f, i) => {
  const s0 = carriedItem(i, 0);
  const s1 = carriedItem(i, 1);
  const s2 = carriedItem(i, 2);
  f.itemKind0 = s0.kind;
  f.itemAmount0 = s0.amount;
  f.itemDur0 = s0.dur;
  f.itemKind1 = s1.kind;
  f.itemAmount1 = s1.amount;
  f.itemDur1 = s1.dur;
  f.itemKind2 = s2.kind;
  f.itemAmount2 = s2.amount;
  f.itemDur2 = s2.dur;
};
var resetRound = (s) => {
  const cx = centerPx(s.wallL, s.wallR);
  const off = spawnOffsetFor(s.wallL, s.wallR);
  for (const i of [0, 1]) {
    const prev = s.fighters[i];
    const fresh = spawnFighter(
      cx + (i === 0 ? -off : off),
      i === 0 ? 1 : -1,
      characters[i],
      i
    );
    fresh.meter = prev.meter;
    fresh.itemKind0 = prev.itemKind0;
    fresh.itemAmount0 = prev.itemAmount0;
    fresh.itemDur0 = prev.itemDur0;
    fresh.itemKind1 = prev.itemKind1;
    fresh.itemAmount1 = prev.itemAmount1;
    fresh.itemDur1 = prev.itemDur1;
    fresh.itemKind2 = prev.itemKind2;
    fresh.itemAmount2 = prev.itemAmount2;
    fresh.itemDur2 = prev.itemDur2;
    fresh.auraAtk = prev.auraAtk;
    fresh.auraDef = prev.auraDef;
    fresh.auraCrit = prev.auraCrit;
    fresh.auraHpRegen = prev.auraHpRegen;
    fresh.auraEnergyRegen = prev.auraEnergyRegen;
    s.fighters[i] = fresh;
  }
  for (let i = 0; i < PROJECTILE_SLOTS; i++) s.projectiles[i] = emptyProjectile();
  s.timerTicks = ROUND_SECONDS * TICKS_PER_SEC;
  s.phase = 0 /* PreRound */;
  s.phaseTimer = TUNING.preRoundTicks;
  s.hitstopLeft = 0;
  s.superFlashLeft = 0;
  s.roundNum++;
};
var snapshot = (s) => ({
  ...s,
  fighters: [
    { ...s.fighters[0], dirHist: s.fighters[0].dirHist.slice() },
    { ...s.fighters[1], dirHist: s.fighters[1].dirHist.slice() }
  ],
  projectiles: s.projectiles.map((p) => ({ ...p }))
});
var FIGHTER_FIELDS = [
  "x",
  "y",
  "velX",
  "velY",
  "facing",
  "health",
  "meter",
  "action",
  "actionFrame",
  "moveIdx",
  "attackConnected",
  "hitConsumedStep",
  "hitstunLeft",
  "blockstunLeft",
  "knockdownOnLand",
  "jumpsLeft",
  "airdashLeft",
  "superJumped",
  "airLocked",
  "juggleBudget",
  "comboHits",
  "comboScaling",
  "bufMotion",
  "bufButtons",
  "bufLeft",
  "tapDir",
  "tapTimer",
  "dashBuf",
  "dashBufLeft",
  "pushblocked",
  "techLeft",
  "throwBack",
  "launchJC",
  "wantThrow",
  "histIdx",
  "prevInput",
  "itemKind0",
  "itemAmount0",
  "itemDur0",
  "itemKind1",
  "itemAmount1",
  "itemDur1",
  "itemKind2",
  "itemAmount2",
  "itemDur2",
  "itemDmg",
  "itemDmgLeft",
  "itemDef",
  "itemDefLeft",
  "auraAtk",
  "auraDef",
  "auraCrit",
  "auraHpRegen",
  "auraEnergyRegen",
  "auraHpAcc",
  "auraMeterAcc",
  "critFlash"
];
var PROJECTILE_FIELDS = [
  "active",
  "owner",
  "moveIdx",
  "x",
  "y",
  "velX",
  "life",
  "hasHit"
];
var GLOBAL_FIELDS = [
  "tick",
  "rngSeed",
  "phase",
  "winner",
  "roundWinner",
  "roundsWon0",
  "roundsWon1",
  "roundNum",
  "timerTicks",
  "phaseTimer",
  "hitstopLeft",
  "superFlashLeft",
  // Appended (protocol = field order): per-match walls. Constant during a match,
  // but serialized so a bounds mismatch surfaces as a desync hash divergence.
  "wallL",
  "wallR"
];
var serialize = (s) => {
  const size = GLOBAL_FIELDS.length + (FIGHTER_FIELDS.length + HIST_LEN) * 2 + PROJECTILE_FIELDS.length * PROJECTILE_SLOTS;
  const out = new Int32Array(size);
  let i = 0;
  for (const k of GLOBAL_FIELDS) out[i++] = s[k];
  for (const f of s.fighters) {
    for (const k of FIGHTER_FIELDS) out[i++] = f[k];
    for (let h2 = 0; h2 < HIST_LEN; h2++) out[i++] = f.dirHist[h2];
  }
  for (const p of s.projectiles) {
    for (const k of PROJECTILE_FIELDS) out[i++] = p[k];
  }
  return out;
};
var stateHash = (s) => {
  const data = serialize(s);
  let h2 = 2166136261;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    h2 ^= v & 255;
    h2 = Math.imul(h2, 16777619);
    h2 ^= v >>> 8 & 255;
    h2 = Math.imul(h2, 16777619);
    h2 ^= v >>> 16 & 255;
    h2 = Math.imul(h2, 16777619);
    h2 ^= v >>> 24 & 255;
    h2 = Math.imul(h2, 16777619);
  }
  return h2 >>> 0;
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/sim.ts
var FLOOR = fp(STAGE.floorYPx);
var WALL_L = fp(STAGE.wallPad);
var WALL_R = fp(STAGE.widthPx - STAGE.wallPad);
var FRICTION = fp(TUNING.friction);
var CORNER = fp(TUNING.cornerThresholdPx);
var worldRect = (x, y, facing, rc) => {
  const rx = fp(rc.x);
  const rw = fp(rc.w);
  const l = facing === 1 ? x + rx : x - rx - rw;
  return { l, t: y + fp(rc.y), r: l + rw, b: y + fp(rc.y) + fp(rc.h) };
};
var overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
var grounded = (f) => f.y >= FLOOR;
var setAction = (f, a) => {
  f.action = a;
  f.actionFrame = 0;
};
var currentMove = (f, ch) => f.action === 9 /* Attack */ && f.moveIdx >= 0 ? ch.b.moves[f.moveIdx] : null;
var stepIndexAt = (move, frame2) => {
  let acc = 0;
  for (let i = 0; i < move.steps.length; i++) {
    acc += move.steps[i].frames;
    if (frame2 < acc) return i;
  }
  return -1;
};
var hurtboxesOf = (f, ch) => {
  switch (f.action) {
    case 19 /* KO */:
    case 15 /* Knockdown */:
    case 16 /* Getup */:
    case 18 /* Thrown */:
      return [];
    // invulnerable
    case 9 /* Attack */: {
      const move = currentMove(f, ch);
      const si = stepIndexAt(move, f.actionFrame);
      return si >= 0 ? move.steps[si].hurtboxes : [ch.b.standHurtbox];
    }
    case 3 /* Crouch */:
    case 13 /* BlockCrouch */:
      return [ch.b.crouchHurtbox];
    case 5 /* Air */:
    case 8 /* AirDash */:
    case 11 /* AirHitstun */:
    case 14 /* BlockAir */:
      return [ch.b.airHurtbox];
    default:
      return [ch.b.standHurtbox];
  }
};
var gatherInputs = (f, input) => {
  const prev = f.prevInput;
  const upEdge = held(input, 4 /* Up */) && !held(prev, 4 /* Up */);
  let itemEdges = 0;
  for (let s = 0; s < ITEM_BITS.length; s++) {
    if (held(input, ITEM_BITS[s]) && !held(prev, ITEM_BITS[s])) itemEdges |= 1 << s;
  }
  f.histIdx = (f.histIdx + 1) % 16;
  f.dirHist[f.histIdx] = numpadDir(input, f.facing);
  const edges2 = pressedAttacks(input, prev);
  if (edges2 !== 0) {
    f.bufButtons = f.bufLeft > 0 ? f.bufButtons | edges2 : edges2;
    f.bufMotion = detectMotion(f.dirHist, f.histIdx);
    f.bufLeft = TUNING.inputBufferTicks;
  }
  const tapL = held(input, 1 /* Left */) && !held(prev, 1 /* Left */);
  const tapR = held(input, 2 /* Right */) && !held(prev, 2 /* Right */);
  if (tapL || tapR) {
    const dir = tapR ? 1 : -1;
    if (f.tapDir === dir && f.tapTimer > 0) {
      f.dashBuf = dir;
      f.dashBufLeft = 4;
      f.tapDir = 0;
      f.tapTimer = 0;
    } else {
      f.tapDir = dir;
      f.tapTimer = TUNING.doubleTapWindowTicks;
    }
  }
  if (f.tapTimer > 0) f.tapTimer--;
  if (f.dashBufLeft > 0 && --f.dashBufLeft === 0) f.dashBuf = 0;
  f.prevInput = input;
  return { input, edges: edges2, upEdge, itemEdges };
};
var startMove = (s, f, ch, idx) => {
  const move = ch.b.moves[idx];
  f.moveIdx = idx;
  f.attackConnected = 0;
  f.hitConsumedStep = -1;
  setAction(f, 9 /* Attack */);
  if (move.stance !== "air") f.velX = 0;
  const s0 = move.steps[0];
  if (s0.velX !== void 0) f.velX = f.facing * fp(s0.velX);
  if (s0.velY !== void 0) f.velY = fp(s0.velY);
  f.meter = clamp(f.meter + move.meterGainWhiff - (move.meterCost ?? 0), 0, TUNING.meterMax);
  if (move.type === "super") s.superFlashLeft = TUNING.superFlashTicks;
  f.bufButtons = 0;
  f.bufMotion = 0;
  f.bufLeft = 0;
  f.launchJC = 0;
};
var tryStartAttack = (s, f, ch, io, cancelFromIdx, connected) => {
  if (f.bufLeft <= 0 || f.bufButtons === 0) return false;
  const isAir = !grounded(f);
  const stance = isAir ? 2 : held(io.input, 8 /* Down */) ? 1 : 0;
  const n = ch.b.moves.length;
  const canCancel = (to) => {
    if (cancelFromIdx < 0) return true;
    const m = connected === 2 ? ch.cancelBlock : ch.cancelHit;
    return m[cancelFromIdx * n + to] === 1;
  };
  if (ch.superIdx >= 0) {
    const sup = ch.b.moves[ch.superIdx];
    if (!isAir && f.bufMotion === sup.motion && countBits(f.bufButtons & PUNCH_MASK) >= 2 && f.meter >= (sup.meterCost ?? 0) && canCancel(ch.superIdx)) {
      startMove(s, f, ch, ch.superIdx);
      return true;
    }
  }
  if (f.bufMotion !== 0) {
    for (const sp of ch.specials) {
      const move = ch.b.moves[sp.idx];
      const stanceOk = move.stance === "air" ? isAir : !isAir;
      const mask = sp.kind === "P" ? PUNCH_MASK : KICK_MASK;
      if (sp.motion === f.bufMotion && stanceOk && (f.bufButtons & mask) !== 0 && canCancel(sp.idx)) {
        startMove(s, f, ch, sp.idx);
        return true;
      }
    }
  }
  for (const name of BUTTON_PRIORITY) {
    const bit = BUTTON_BITS[name];
    if ((f.bufButtons & bit) === 0) continue;
    let pos = 0;
    let b = bit;
    while ((b >>= 1) !== 0) pos++;
    const idx = ch.normals[stance][pos];
    if (idx >= 0 && canCancel(idx)) {
      startMove(s, f, ch, idx);
      return true;
    }
  }
  return false;
};
var startJump = (f, superJump) => {
  setAction(f, 4 /* JumpSquat */);
  f.superJumped = superJump ? 1 : 0;
  f.velX = 0;
};
var updateFighter = (s, f, other, ch, io) => {
  if (f.bufLeft > 0 && --f.bufLeft === 0) {
    f.bufButtons = 0;
    f.bufMotion = 0;
  }
  switch (f.action) {
    case 19 /* KO */:
      break;
    // physics only
    case 15 /* Knockdown */:
      f.actionFrame++;
      if (f.actionFrame >= (ch.b.tuning?.knockdownTicks ?? TUNING.knockdownTicks)) setAction(f, 16 /* Getup */);
      break;
    case 16 /* Getup */:
      f.actionFrame++;
      if (f.actionFrame >= (ch.b.tuning?.getupTicks ?? TUNING.getupTicks)) setAction(f, 0 /* Idle */);
      break;
    case 18 /* Thrown */:
      if (f.techLeft > 0) {
        f.techLeft--;
        if ((io.edges & 64 /* HP */) !== 0) f.techLeft = -1;
      }
      break;
    case 17 /* Grab */:
      f.actionFrame++;
      break;
    case 10 /* Hitstun */:
      f.hitstunLeft--;
      if (f.hitstunLeft <= 0) setAction(f, 0 /* Idle */);
      break;
    case 11 /* AirHitstun */:
      if (f.hitstunLeft > 0) f.hitstunLeft--;
      if (f.hitstunLeft <= 0 && !f.knockdownOnLand) {
        setAction(f, 5 /* Air */);
        f.airLocked = 0;
      }
      break;
    case 12 /* BlockStand */:
    case 13 /* BlockCrouch */:
    case 14 /* BlockAir */: {
      f.blockstunLeft--;
      const pbButtons = io.edges | (f.bufLeft > 0 ? f.bufButtons : 0);
      if (!f.pushblocked && countBits(pbButtons & PUNCH_MASK) >= 2) {
        f.bufButtons = 0;
        f.bufMotion = 0;
        f.bufLeft = 0;
        f.pushblocked = 1;
        f.velX = -f.facing * fp(TUNING.pushblockSelfVel);
        const atWall = f.x <= WALL_L + CORNER || f.x >= WALL_R - CORNER;
        if (atWall && grounded(other)) {
          other.velX = (other.x >= f.x ? 1 : -1) * fp(TUNING.pushblockAttackerVel);
        }
      }
      if (f.blockstunLeft <= 0) {
        setAction(f, f.action === 13 /* BlockCrouch */ ? 3 /* Crouch */ : f.action === 14 /* BlockAir */ ? 5 /* Air */ : 0 /* Idle */);
      }
      break;
    }
    case 4 /* JumpSquat */:
      f.actionFrame++;
      if (f.actionFrame >= (ch.b.tuning?.jumpSquatTicks ?? TUNING.jumpSquatTicks)) {
        setAction(f, 5 /* Air */);
        f.velY = fp(f.superJumped ? ch.b.superJumpVelY : ch.b.jumpVelY);
        const dir = (held(io.input, 2 /* Right */) ? 1 : 0) - (held(io.input, 1 /* Left */) ? 1 : 0);
        f.velX = dir * fp(ch.b.jumpVelX);
        f.jumpsLeft = ch.b.doubleJump ? 1 : 0;
        f.airdashLeft = ch.b.airDash ? 1 : 0;
      }
      break;
    case 6 /* DashF */:
      f.actionFrame++;
      f.velX = f.facing * fp(ch.b.dashFSpeed);
      if (tryStartAttack(s, f, ch, io, -1, 0)) break;
      if (f.actionFrame >= ch.b.dashFTicks) {
        f.velX = 0;
        setAction(f, 0 /* Idle */);
      }
      break;
    case 7 /* DashB */:
      f.actionFrame++;
      f.velX = -f.facing * fp(ch.b.dashBSpeed);
      if (f.actionFrame >= ch.b.dashBTicks) {
        f.velX = 0;
        setAction(f, 0 /* Idle */);
      }
      break;
    case 8 /* AirDash */:
      f.actionFrame++;
      if (tryStartAttack(s, f, ch, io, -1, 0)) break;
      if (f.actionFrame >= ch.b.airDashTicks) setAction(f, 5 /* Air */);
      break;
    case 9 /* Attack */: {
      const move = currentMove(f, ch);
      const prevStep = stepIndexAt(move, f.actionFrame);
      f.actionFrame++;
      if (f.launchJC > 0) f.launchJC--;
      const total = ch.totalFrames[f.moveIdx];
      if (f.actionFrame >= total) {
        f.moveIdx = -1;
        if (grounded(f)) {
          f.velX = 0;
          setAction(f, 0 /* Idle */);
        } else {
          setAction(f, 5 /* Air */);
          if (move.type !== "normal") f.airLocked = 1;
        }
        break;
      }
      const si = stepIndexAt(move, f.actionFrame);
      if (si !== prevStep && si >= 0) {
        const st = move.steps[si];
        if (st.velX !== void 0) f.velX = f.facing * fp(st.velX);
        if (st.velY !== void 0) f.velY = fp(st.velY);
      }
      if (move.stance === "air" && grounded(f) && f.velY >= 0) {
        f.moveIdx = -1;
        f.velX = 0;
        setAction(f, 0 /* Idle */);
        break;
      }
      if (f.attackConnected === 1 && f.launchJC > 0 && grounded(f) && held(io.input, 4 /* Up */)) {
        f.moveIdx = -1;
        startJump(f, true);
        break;
      }
      if (f.attackConnected !== 0) {
        tryStartAttack(s, f, ch, io, f.moveIdx, f.attackConnected);
      }
      break;
    }
    case 5 /* Air */: {
      if (f.airLocked) break;
      if (tryStartAttack(s, f, ch, io, -1, 0)) break;
      if (io.upEdge && f.jumpsLeft > 0) {
        f.jumpsLeft--;
        f.velY = fp(ch.b.jumpVelY);
        const dir = (held(io.input, 2 /* Right */) ? 1 : 0) - (held(io.input, 1 /* Left */) ? 1 : 0);
        f.velX = dir * fp(ch.b.jumpVelX);
        break;
      }
      if (f.dashBuf !== 0 && f.airdashLeft > 0) {
        f.airdashLeft--;
        f.velX = f.dashBuf * fp(ch.b.airDashSpeed);
        f.velY = 0;
        f.dashBuf = 0;
        setAction(f, 8 /* AirDash */);
      }
      break;
    }
    case 0 /* Idle */:
    case 1 /* WalkF */:
    case 2 /* WalkB */:
    case 3 /* Crouch */: {
      const holdF = held(io.input, f.facing === 1 ? 2 /* Right */ : 1 /* Left */);
      const holdB = held(io.input, f.facing === 1 ? 1 /* Left */ : 2 /* Right */);
      if ((io.edges & 64 /* HP */) !== 0 && (holdF || holdB) && grounded(f) && !held(io.input, 8 /* Down */)) {
        const dx = other.x - f.x;
        const dist = dx < 0 ? -dx : dx;
        const throwable = grounded(other) && (other.action === 0 /* Idle */ || other.action === 1 /* WalkF */ || other.action === 2 /* WalkB */ || other.action === 3 /* Crouch */ || other.action === 9 /* Attack */ || other.action === 6 /* DashF */ || other.action === 7 /* DashB */);
        if (dist <= fp(ch.b.throwRange) && throwable) {
          f.wantThrow = holdB ? 2 : 1;
          f.bufButtons &= ~64 /* HP */;
          break;
        }
      }
      if (tryStartAttack(s, f, ch, io, -1, 0)) break;
      if (f.dashBuf !== 0 && grounded(f)) {
        const fwd2 = f.dashBuf === f.facing;
        f.dashBuf = 0;
        setAction(f, fwd2 ? 6 /* DashF */ : 7 /* DashB */);
        break;
      }
      if (held(io.input, 4 /* Up */) && grounded(f)) {
        startJump(f, downTappedRecently(f.dirHist, f.histIdx));
        break;
      }
      if (held(io.input, 8 /* Down */)) {
        f.velX = 0;
        if (f.action !== 3 /* Crouch */) setAction(f, 3 /* Crouch */);
        else f.actionFrame++;
        break;
      }
      const dir = (held(io.input, 2 /* Right */) ? 1 : 0) - (held(io.input, 1 /* Left */) ? 1 : 0);
      const fwd = dir === f.facing;
      f.velX = dir === 0 ? 0 : dir * fp(fwd ? ch.b.walkFSpeed : ch.b.walkBSpeed);
      const next = dir === 0 ? 0 /* Idle */ : fwd ? 1 /* WalkF */ : 2 /* WalkB */;
      if (f.action !== next) setAction(f, next);
      else f.actionFrame++;
      break;
    }
  }
  const skipPhysics = f.action === 18 /* Thrown */ || f.action === 17 /* Grab */ || f.action === 8 /* AirDash */ || f.action === 4 /* JumpSquat */;
  if (!skipPhysics) {
    if (!grounded(f) || f.velY < 0) f.velY += fp(ch.b.gravity);
    f.x += f.velX;
    f.y += f.velY;
    if (f.y >= FLOOR && f.velY >= 0) {
      const wasAirborne = f.y - f.velY < FLOOR || f.velY > 0;
      f.y = FLOOR;
      f.velY = 0;
      if (wasAirborne) landFighter(f);
    }
  } else if (f.action === 8 /* AirDash */) {
    f.x += f.velX;
  }
  f.x = clamp(f.x, WALL_L, WALL_R);
  if (grounded(f) && (f.action === 10 /* Hitstun */ || f.action === 19 /* KO */ || f.action === 15 /* Knockdown */ || f.action === 16 /* Getup */ || f.action === 12 /* BlockStand */ || f.action === 13 /* BlockCrouch */)) {
    if (f.velX > 0) f.velX = Math.max(0, f.velX - FRICTION);
    else if (f.velX < 0) f.velX = Math.min(0, f.velX + FRICTION);
  }
};
var landFighter = (f) => {
  switch (f.action) {
    case 5 /* Air */:
    case 14 /* BlockAir */:
      f.velX = 0;
      f.superJumped = 0;
      f.airLocked = 0;
      setAction(f, 0 /* Idle */);
      break;
    case 11 /* AirHitstun */:
      f.velX = 0;
      f.superJumped = 0;
      f.airLocked = 0;
      f.hitstunLeft = 0;
      f.knockdownOnLand = 0;
      setAction(f, 15 /* Knockdown */);
      break;
    case 19 /* KO */:
      f.velY = 0;
      break;
    default:
      break;
  }
};
var canBlock = (vic, threatX, guard) => {
  if (guard === "unblockable") return false;
  const a = vic.action;
  const blockableState = a === 0 /* Idle */ || a === 2 /* WalkB */ || a === 3 /* Crouch */ || a === 12 /* BlockStand */ || a === 13 /* BlockCrouch */ || a === 14 /* BlockAir */ || a === 5 /* Air */ && !vic.airLocked;
  if (!blockableState) return false;
  const backBtn = threatX >= vic.x ? 1 /* Left */ : 2 /* Right */;
  if (!held(vic.prevInput, backBtn)) return false;
  if (!grounded(vic)) return guard !== "low";
  const crouching = held(vic.prevInput, 8 /* Down */);
  if (guard === "low") return crouching;
  if (guard === "overhead") return !crouching;
  return true;
};
var slotOf = (f, s) => s === 0 ? { kind: f.itemKind0, amount: f.itemAmount0, dur: f.itemDur0 } : s === 1 ? { kind: f.itemKind1, amount: f.itemAmount1, dur: f.itemDur1 } : { kind: f.itemKind2, amount: f.itemAmount2, dur: f.itemDur2 };
var clearSlot = (f, s) => {
  if (s === 0) {
    f.itemKind0 = 0;
    f.itemAmount0 = 0;
    f.itemDur0 = 0;
  } else if (s === 1) {
    f.itemKind1 = 0;
    f.itemAmount1 = 0;
    f.itemDur1 = 0;
  } else {
    f.itemKind2 = 0;
    f.itemAmount2 = 0;
    f.itemDur2 = 0;
  }
};
var useItem = (f, ch, s) => {
  const it = slotOf(f, s);
  if (it.kind === 0) return;
  const free = f.action === 0 /* Idle */ || f.action === 1 /* WalkF */ || f.action === 2 /* WalkB */ || f.action === 3 /* Crouch */;
  if (!free) return;
  switch (it.kind) {
    case 1:
      f.health = Math.min(
        ch.b.maxHealth,
        f.health + Math.trunc(ch.b.maxHealth * it.amount / 1e3)
      );
      break;
    case 2:
      f.itemDmg = it.amount;
      f.itemDmgLeft = it.dur;
      break;
    case 3:
      f.itemDef = it.amount;
      f.itemDefLeft = it.dur;
      break;
    case 4:
      f.meter = Math.min(TUNING.meterMax, f.meter + it.amount);
      break;
    default:
      break;
  }
  clearSlot(f, s);
};
var AURA_ACC_FULL = 1e3 * PET_REGEN_PERIOD_TICKS;
var auraRegen = (f, ch) => {
  if (f.auraHpRegen > 0 && f.health > 0 && f.health < ch.b.maxHealth) {
    f.auraHpAcc += ch.b.maxHealth * f.auraHpRegen;
    if (f.auraHpAcc >= AURA_ACC_FULL) {
      const gain = Math.trunc(f.auraHpAcc / AURA_ACC_FULL);
      f.auraHpAcc -= gain * AURA_ACC_FULL;
      f.health = Math.min(ch.b.maxHealth, f.health + gain);
    }
  }
  if (f.auraEnergyRegen > 0 && f.health > 0 && f.meter < TUNING.meterMax) {
    f.auraMeterAcc += TUNING.meterMax * f.auraEnergyRegen;
    if (f.auraMeterAcc >= AURA_ACC_FULL) {
      const gain = Math.trunc(f.auraMeterAcc / AURA_ACC_FULL);
      f.auraMeterAcc -= gain * AURA_ACC_FULL;
      f.meter = Math.min(TUNING.meterMax, f.meter + gain);
    }
  }
};
var buffScaled = (dmg, src, vic, floor) => {
  let d = dmg;
  if (src.buff.auraAtk > 0) {
    d = Math.trunc(d * (1e3 + src.buff.auraAtk) / 1e3);
  }
  if (src.buff.itemDmgLeft > 0 && src.buff.itemDmg > 0) {
    d = Math.trunc(d * (1e3 + src.buff.itemDmg) / 1e3);
  }
  if (vic.auraDef > 0) {
    d = Math.trunc(d * (1e3 - vic.auraDef) / 1e3);
  }
  if (vic.itemDefLeft > 0 && vic.itemDef > 0) {
    d = Math.trunc(d * (1e3 - vic.itemDef) / 1e3);
  }
  return Math.max(floor, d);
};
var critScaled = (dmg, s, src) => {
  const chance2 = src.buff.auraCrit;
  if (chance2 <= 0) return dmg;
  s.rngSeed = nextRand(s.rngSeed);
  if (s.rngSeed % 1e3 >= chance2) return dmg;
  src.buff.critFlash = PET_CRIT_FLASH_TICKS;
  return Math.max(1, Math.trunc(dmg * (1e3 + PET_CRIT_BONUS) / 1e3));
};
var strike = (s, src, vic, hb) => {
  if (vic.action === 19 /* KO */ || vic.action === 15 /* Knockdown */ || vic.action === 16 /* Getup */ || vic.action === 18 /* Thrown */ || vic.action === 17 /* Grab */) return 0;
  const vicAir = !grounded(vic);
  const inCombo = vic.action === 10 /* Hitstun */ || vic.action === 11 /* AirHitstun */;
  if (vicAir && inCombo && hb.juggleCost > vic.juggleBudget) return 0;
  const dir = src.facing;
  if (canBlock(vic, src.x, hb.guard)) {
    vic.health = Math.max(0, vic.health - (hb.chip > 0 ? buffScaled(hb.chip, src, vic, 0) : 0));
    vic.blockstunLeft = hb.blockstun;
    vic.velX = dir * fp(hb.pushbackBlock);
    vic.pushblocked = 0;
    setAction(vic, vicAir ? 14 /* BlockAir */ : held(vic.prevInput, 8 /* Down */) ? 13 /* BlockCrouch */ : 12 /* BlockStand */);
    cornerTransfer(vic, src, hb.pushbackBlock, dir);
    s.hitstopLeft = Math.max(s.hitstopLeft, hb.hitstopFrames);
    if (src.attacker) {
      src.attacker.meter = clamp(src.attacker.meter + (src.move.meterGainHit >> 1), 0, TUNING.meterMax);
    }
    vic.meter = clamp(vic.meter + TUNING.blockMeterGain, 0, TUNING.meterMax);
    if (vic.health <= 0) koFighter(vic, dir);
    return 2;
  }
  if (!inCombo) {
    vic.comboHits = 0;
    vic.comboScaling = TUNING.scalingStart;
    vic.juggleBudget = TUNING.juggleBudget;
  }
  vic.comboHits++;
  const dmg = critScaled(buffScaled(
    Math.max(
      Math.trunc(hb.damage * Math.max(vic.comboScaling, TUNING.scalingFloor) / 1e3),
      1
    ),
    src,
    vic,
    1
  ), s, src);
  vic.comboScaling = Math.max(
    Math.trunc(vic.comboScaling * TUNING.scalingMult / 1e3),
    TUNING.scalingFloor
  );
  if (vicAir) vic.juggleBudget -= hb.juggleCost;
  vic.health = Math.max(0, vic.health - dmg);
  const stun = Math.max(
    hb.hitstun - (vic.comboHits >> TUNING.hitstunDecayShift),
    TUNING.minHitstun
  );
  vic.moveIdx = -1;
  if (hb.launcher) {
    vic.velY = fp(hb.launchVelY ?? -16);
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = Math.max(stun, 60);
    vic.knockdownOnLand = 1;
    setAction(vic, 11 /* AirHitstun */);
  } else if (vicAir) {
    vic.velY = fp(hb.airPopVelY ?? -7);
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = stun;
    if (hb.knockdown) vic.knockdownOnLand = 1;
    setAction(vic, 11 /* AirHitstun */);
  } else if (hb.knockdown) {
    vic.velY = fp(-6);
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = stun;
    vic.knockdownOnLand = 1;
    setAction(vic, 11 /* AirHitstun */);
  } else {
    vic.velX = dir * fp(hb.pushbackHit);
    vic.hitstunLeft = stun;
    setAction(vic, 10 /* Hitstun */);
  }
  cornerTransfer(vic, src, hb.pushbackHit, dir);
  s.hitstopLeft = Math.max(s.hitstopLeft, hb.hitstopFrames);
  if (src.attacker) {
    src.attacker.meter = clamp(src.attacker.meter + src.move.meterGainHit, 0, TUNING.meterMax);
    if (hb.launcher) src.attacker.launchJC = 24;
  }
  vic.meter = clamp(vic.meter + Math.trunc(dmg / TUNING.victimMeterDivisor), 0, TUNING.meterMax);
  if (vic.health <= 0) koFighter(vic, dir);
  return 1;
};
var cornerTransfer = (vic, src, push, dir) => {
  const atWall = dir < 0 && vic.x <= WALL_L + CORNER || dir > 0 && vic.x >= WALL_R - CORNER;
  if (atWall && src.attacker && grounded(src.attacker)) {
    src.attacker.velX = -dir * fp(push);
  }
};
var koFighter = (f, dir) => {
  f.velY = fp(-8);
  f.velX = dir * fp(4);
  setAction(f, 19 /* KO */);
};
var spawnProjectile = (s, owner, f, moveIdx) => {
  const move = characters[owner].b.moves[moveIdx];
  const pd = move.projectile;
  for (const p of s.projectiles) if (p.active && p.owner === owner) return;
  for (const p of s.projectiles) {
    if (!p.active) {
      p.active = 1;
      p.owner = owner;
      p.moveIdx = moveIdx;
      p.x = f.x + f.facing * fp(pd.spawnX);
      p.y = f.y + fp(pd.spawnY);
      p.velX = f.facing * fp(pd.velX);
      p.life = pd.lifetime;
      p.hasHit = 0;
      return;
    }
  }
};
var projectileRect = (p) => {
  const pd = characters[p.owner].b.moves[p.moveIdx].projectile;
  const facing = p.velX >= 0 ? 1 : -1;
  return worldRect(p.x, p.y, facing, pd.rect);
};
var updateProjectiles = (s) => {
  for (const p of s.projectiles) {
    if (!p.active) continue;
    p.x += p.velX;
    if (--p.life <= 0 || p.x < WALL_L - fp(60) || p.x > WALL_R + fp(60)) p.active = 0;
  }
  for (let i = 0; i < PROJECTILE_SLOTS; i++) {
    const a = s.projectiles[i];
    if (!a.active) continue;
    for (let j = i + 1; j < PROJECTILE_SLOTS; j++) {
      const b = s.projectiles[j];
      if (!b.active || a.owner === b.owner) continue;
      if (overlaps(projectileRect(a), projectileRect(b))) {
        a.active = 0;
        b.active = 0;
      }
    }
  }
};
var resolveThrows = (s) => {
  const [f0, f1] = s.fighters;
  const w0 = f0.wantThrow;
  const w1 = f1.wantThrow;
  f0.wantThrow = 0;
  f1.wantThrow = 0;
  if (w0 && w1) {
    f0.velX = -f0.facing * fp(6);
    f1.velX = -f1.facing * fp(6);
    setAction(f0, 0 /* Idle */);
    setAction(f1, 0 /* Idle */);
    return;
  }
  const att = w0 ? f0 : w1 ? f1 : null;
  if (!att) return;
  const vic = att === f0 ? f1 : f0;
  att.throwBack = (w0 || w1) === 2 ? 1 : 0;
  att.velX = 0;
  setAction(att, 17 /* Grab */);
  vic.velX = 0;
  vic.velY = 0;
  vic.moveIdx = -1;
  vic.techLeft = TUNING.throwTechWindow;
  setAction(vic, 18 /* Thrown */);
};
var resolveGrabs = (s) => {
  for (const i of [0, 1]) {
    const att = s.fighters[i];
    if (att.action !== 17 /* Grab */) continue;
    const vic = s.fighters[1 - i];
    const ch = characters[i];
    if (vic.techLeft === -1) {
      vic.techLeft = 0;
      att.velX = -att.facing * fp(7);
      vic.velX = -vic.facing * fp(7);
      setAction(att, 0 /* Idle */);
      setAction(vic, 0 /* Idle */);
      continue;
    }
    if (att.actionFrame >= (ch.b.tuning?.grabTicks ?? TUNING.grabTicks)) {
      const dir = att.throwBack ? -att.facing : att.facing;
      vic.techLeft = 0;
      vic.comboHits = 1;
      vic.comboScaling = Math.max(
        Math.trunc(TUNING.scalingStart * TUNING.scalingMult / 1e3),
        TUNING.scalingFloor
      );
      vic.juggleBudget = TUNING.juggleBudget;
      vic.health = Math.max(0, vic.health - ch.b.throwDamage);
      vic.velX = dir * fp(ch.b.throwTossVelX);
      vic.velY = fp(ch.b.throwTossVelY);
      vic.hitstunLeft = 60;
      vic.knockdownOnLand = 1;
      setAction(vic, vic.health <= 0 ? 19 /* KO */ : 11 /* AirHitstun */);
      vic.meter = clamp(vic.meter + Math.trunc(ch.b.throwDamage / TUNING.victimMeterDivisor), 0, TUNING.meterMax);
      setAction(att, 0 /* Idle */);
    }
  }
};
var step = (s, inputs) => {
  WALL_L = s.wallL;
  WALL_R = s.wallR;
  s.tick++;
  const [f0, f1] = s.fighters;
  const [c0, c1] = characters;
  const io0 = gatherInputs(f0, inputs[0]);
  const io1 = gatherInputs(f1, inputs[1]);
  if (s.phase === 3 /* MatchOver */) return;
  if (s.phase === 0 /* PreRound */) {
    if (--s.phaseTimer <= 0) s.phase = 1 /* Fighting */;
    autoFace(f0, f1);
    return;
  }
  if (s.phase === 2 /* RoundOver */) {
    settlePhysics(f0, c0);
    settlePhysics(f1, c1);
    if (--s.phaseTimer <= 0) {
      if (s.roundsWon0 >= TUNING.roundsToWin || s.roundsWon1 >= TUNING.roundsToWin) {
        s.phase = 3 /* MatchOver */;
        s.winner = s.roundsWon0 >= TUNING.roundsToWin && s.roundsWon1 >= TUNING.roundsToWin ? 2 : s.roundsWon0 >= TUNING.roundsToWin ? 0 : 1;
      } else {
        resetRound(s);
      }
    }
    return;
  }
  if (s.superFlashLeft > 0) {
    s.superFlashLeft--;
    return;
  }
  if (s.hitstopLeft > 0) {
    s.hitstopLeft--;
    return;
  }
  autoFace(f0, f1);
  for (let sl = 0; sl < 3; sl++) {
    if (io0.itemEdges & 1 << sl) useItem(f0, c0, sl);
    if (io1.itemEdges & 1 << sl) useItem(f1, c1, sl);
  }
  if (f0.itemDmgLeft > 0) f0.itemDmgLeft--;
  if (f0.itemDefLeft > 0) f0.itemDefLeft--;
  if (f1.itemDmgLeft > 0) f1.itemDmgLeft--;
  if (f1.itemDefLeft > 0) f1.itemDefLeft--;
  auraRegen(f0, c0);
  auraRegen(f1, c1);
  if (f0.critFlash > 0) f0.critFlash--;
  if (f1.critFlash > 0) f1.critFlash--;
  updateFighter(s, f0, f1, c0, io0);
  updateFighter(s, f1, f0, c1, io1);
  resolveThrows(s);
  resolveGrabs(s);
  bodyPush(f0, f1, c0, c1);
  for (const [i, f, ch] of [[0, f0, c0], [1, f1, c1]]) {
    const move = currentMove(f, ch);
    if (move?.projectile) {
      const si = stepIndexAt(move, f.actionFrame);
      if (si === ch.firstActiveStep[f.moveIdx] && stepStartFrame(move, si) === f.actionFrame) {
        spawnProjectile(s, i, f, f.moveIdx);
      }
    }
  }
  updateProjectiles(s);
  const hitPlan = [];
  for (const [f, other, ch, otherCh] of [[f0, f1, c0, c1], [f1, f0, c1, c0]]) {
    const move = currentMove(f, ch);
    if (!move) continue;
    const si = stepIndexAt(move, f.actionFrame);
    if (si < 0 || si <= f.hitConsumedStep) continue;
    const st = move.steps[si];
    if (!st.hitboxes) continue;
    const vicBoxes = hurtboxesOf(other, otherCh);
    outer:
      for (const hb of st.hitboxes) {
        const hbw = worldRect(f.x, f.y, f.facing, hb.rect);
        for (const vb of vicBoxes) {
          if (overlaps(hbw, worldRect(other.x, other.y, other.facing, vb))) {
            hitPlan.push({ src: { facing: f.facing, x: f.x, attacker: f, buff: f, move }, vic: other, hb, stepIdx: si });
            break outer;
          }
        }
      }
  }
  for (const plan of hitPlan) {
    const result = strike(s, plan.src, plan.vic, plan.hb);
    if (result !== 0) {
      plan.src.attacker.hitConsumedStep = plan.stepIdx;
      plan.src.attacker.attackConnected = result;
    }
  }
  for (const p of s.projectiles) {
    if (!p.active || p.hasHit) continue;
    const vic = s.fighters[1 - p.owner];
    const vicCh = characters[1 - p.owner];
    const move = characters[p.owner].b.moves[p.moveIdx];
    const pd = move.projectile;
    const rectW = projectileRect(p);
    for (const vb of hurtboxesOf(vic, vicCh)) {
      if (overlaps(rectW, worldRect(vic.x, vic.y, vic.facing, vb))) {
        const owner = s.fighters[p.owner];
        const result = strike(s, { facing: p.velX >= 0 ? 1 : -1, x: p.x, attacker: null, buff: owner, move }, vic, pd.hit);
        if (result !== 0) {
          p.hasHit = 1;
          p.active = 0;
          owner.meter = clamp(
            owner.meter + (result === 1 ? move.meterGainHit : move.meterGainHit >> 1),
            0,
            TUNING.meterMax
          );
        }
        break;
      }
    }
  }
  s.timerTicks--;
  const dead0 = f0.health <= 0;
  const dead1 = f1.health <= 0;
  if (dead0 || dead1) {
    endRound(s, dead0 && dead1 ? 2 : dead0 ? 1 : 0);
  } else if (s.timerTicks <= 0) {
    endRound(s, f0.health === f1.health ? 2 : f0.health > f1.health ? 0 : 1);
  }
};
var stepStartFrame = (move, stepIdx) => {
  let acc = 0;
  for (let i = 0; i < stepIdx; i++) acc += move.steps[i].frames;
  return acc;
};
var autoFace = (f0, f1) => {
  for (const [me, other] of [[f0, f1], [f1, f0]]) {
    const a = me.action;
    if ((a === 0 /* Idle */ || a === 1 /* WalkF */ || a === 2 /* WalkB */ || a === 3 /* Crouch */) && grounded(me)) {
      const newFacing = other.x >= me.x ? 1 : -1;
      if (newFacing !== me.facing) {
        me.facing = newFacing;
        if (a === 1 /* WalkF */ || a === 2 /* WalkB */) setAction(me, 0 /* Idle */);
      }
    }
  }
};
var bodyPush = (f0, f1, c0, c1) => {
  const noBody = (f) => f.action === 19 /* KO */ || f.action === 15 /* Knockdown */ || f.action === 16 /* Getup */ || f.action === 18 /* Thrown */;
  if (noBody(f0) || noBody(f1)) return;
  const halfBodies = fp((c0.b.bodyWidth + c1.b.bodyWidth) / 2);
  const dx = f1.x - f0.x;
  const absDx = dx < 0 ? -dx : dx;
  if (absDx < halfBodies && Math.abs(fpToPx(f0.y - f1.y)) < 100) {
    const pushAmt = Math.trunc((halfBodies - absDx) / 2);
    const sign = dx === 0 ? f0.facing : dx > 0 ? 1 : -1;
    f0.x = clamp(f0.x - sign * pushAmt, WALL_L, WALL_R);
    f1.x = clamp(f1.x + sign * pushAmt, WALL_L, WALL_R);
  }
};
var settlePhysics = (f, ch) => {
  if (!grounded(f) || f.velY < 0) f.velY += fp(ch.b.gravity);
  f.x += f.velX;
  f.y += f.velY;
  if (f.y >= FLOOR && f.velY >= 0) {
    f.y = FLOOR;
    f.velY = 0;
    if (f.action === 11 /* AirHitstun */) setAction(f, 15 /* Knockdown */);
  }
  f.x = clamp(f.x, WALL_L, WALL_R);
  if (grounded(f)) {
    if (f.velX > 0) f.velX = Math.max(0, f.velX - FRICTION);
    else if (f.velX < 0) f.velX = Math.min(0, f.velX + FRICTION);
  }
};
var endRound = (s, winner) => {
  s.roundWinner = winner;
  if (winner === 0 || winner === 2) s.roundsWon0++;
  if (winner === 1 || winner === 2) s.roundsWon1++;
  s.phase = 2 /* RoundOver */;
  s.phaseTimer = TUNING.roundOverTicks;
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/anim.ts
var VEL_EPS = fp(2);

// ../AGENT FIGHTER/agent-fighter/packages/core/src/ai.ts
var rnd = (ai, n) => {
  ai.rng = nextRand(ai.rng);
  return ai.rng % n;
};
var chance = (ai, p) => rnd(ai, 255) < p;
var lerp2 = (ai, at0, at100) => at0 + Math.trunc((at100 - at0) * ai.skill / 100);
var lerpSq = (ai, at0, at100) => at0 + Math.trunc((at100 - at0) * ai.skill * ai.skill / 1e4);
var skillRamp = (ai, floor) => {
  if (ai.skill <= floor) return 0;
  const t = Math.trunc((ai.skill - floor) * 100 / (100 - floor));
  return Math.trunc(t * t / 100);
};
var pxDist = (a, b) => Math.abs(fpToPx(a.x - b.x));
var aiGrounded = (f) => f.y >= fp(STAGE.floorYPx);
var actionable = (f) => f.action === 0 /* Idle */ || f.action === 1 /* WalkF */ || f.action === 2 /* WalkB */ || f.action === 3 /* Crouch */;
var moveHasGuard = (mv, kind) => {
  if (!mv) return false;
  for (const step2 of mv.steps) {
    if (!step2.hitboxes) continue;
    for (const hb of step2.hitboxes) if (hb.guard === kind) return true;
  }
  return false;
};
var SUPER_SKILL_FLOOR = 30;
var canSuper = (ai, ch, me) => ai.idxSuper >= 0 && me.meter >= (ch.b.moves[ai.idxSuper]?.meterCost ?? 9999);
var superOdds = (ai, me, op, dist, comboEnder) => {
  const r = skillRamp(ai, SUPER_SKILL_FLOOR);
  if (r === 0) return 0;
  let odds = Math.trunc((comboEnder ? 195 : 105) * r / 100);
  const oppMax = characters[ai.side === 0 ? 1 : 0]?.b.maxHealth ?? 1e4;
  if (op.health <= Math.trunc(oppMax / 4)) odds += Math.trunc(115 * r / 100);
  if (me.meter >= TUNING.meterMax) odds += Math.trunc(60 * r / 100);
  if (dist > 300) odds -= 70;
  return Math.max(0, Math.min(255, odds));
};
var AI_PERSONALITY_RANGES = {
  aggression: [90, 220],
  jumpiness: [40, 190],
  zoner: [40, 210],
  throwHappy: [30, 150],
  pushblocker: [60, 220],
  patience: [60, 200],
  thirst: [0, 255]
};
var THIRST_DEFAULT = 128;
var createAi = (side, skill, seed, personality) => {
  const ai = {
    side,
    skill: Math.max(0, Math.min(100, skill)),
    rng: (seed | 0) ^ 85905893,
    p: { aggression: 0, jumpiness: 0, zoner: 0, throwHappy: 0, pushblocker: 0, patience: 0, thirst: THIRST_DEFAULT },
    intent: 0 /* Observe */,
    intentUntil: 0,
    queue: [],
    qTicks: 0,
    oppAction: -1,
    oppActionAt: 0,
    reacted: 1,
    moveDir: 0,
    moveTicks: 0,
    eatJump: 0,
    eatLow: 0,
    eatThrow: 0,
    eatProj: 0,
    lastHealth: -1,
    airAttackDone: 0,
    bookGround: [],
    bookLauncher: -1,
    bookAir: [],
    idxFireball: -1,
    idxDp: -1,
    idxSweep: -1,
    idxLow: -1,
    idxSpecialK: -1,
    idxSuper: -1,
    nextSuperAt: 0,
    bookBuilt: 0
  };
  ai.p.aggression = 90 + rnd(ai, 130);
  ai.p.jumpiness = 40 + rnd(ai, 150);
  ai.p.zoner = 40 + rnd(ai, 170);
  ai.p.throwHappy = 30 + rnd(ai, 120);
  ai.p.pushblocker = 60 + rnd(ai, 160);
  ai.p.patience = 60 + rnd(ai, 140);
  if (personality) {
    for (const k of Object.keys(AI_PERSONALITY_RANGES)) {
      const v = personality[k];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const [lo, hi] = AI_PERSONALITY_RANGES[k];
      ai.p[k] = Math.max(lo, Math.min(hi, v | 0));
    }
  }
  return ai;
};
var buildBook = (ai, ch) => {
  const id = (s) => ch.moveIdxById[s] ?? -1;
  ai.bookGround = ["5LP", "5MP", "5HP"].map(id).filter((i) => i >= 0);
  ai.bookLauncher = id("2HP");
  ai.bookAir = ["j.LP", "j.MP", "j.HP"].map(id).filter((i) => i >= 0);
  ai.idxFireball = id("236P");
  ai.idxDp = id("623P");
  ai.idxSweep = id("2HK");
  ai.idxLow = id("2LK");
  ai.idxSpecialK = id("214K");
  ai.idxSuper = ch.superIdx;
  ai.bookBuilt = 1;
};
var BUTTON_OF = {
  LP: 16 /* LP */,
  MP: 32 /* MP */,
  HP: 64 /* HP */,
  LK: 128 /* LK */,
  MK: 256 /* MK */,
  HK: 512 /* HK */
};
var buttonOfMove = (ch, idx) => {
  const b = ch.b.moves[idx]?.button;
  return b ? BUTTON_OF[b] : 16 /* LP */;
};
var q = (ai, step2) => {
  ai.queue.push(step2);
};
var qTapButton = (ai, buttons, down = 0) => {
  q(ai, { buttons, down, ticks: 2 });
  q(ai, { down, ticks: 1 });
};
var qFireball = (ai, buttons) => {
  const sloppy = !chance(ai, lerp2(ai, 140, 250));
  q(ai, { down: 1, ticks: 3 });
  q(ai, { down: 1, fwd: 1, ticks: 2 });
  if (sloppy) {
    q(ai, { buttons, ticks: 2 });
  } else {
    q(ai, { fwd: 1, ticks: 2 });
    q(ai, { fwd: 1, buttons, ticks: 2 });
  }
  q(ai, { ticks: 2 });
};
var q214 = (ai, buttons) => {
  const sloppy = !chance(ai, lerp2(ai, 140, 250));
  q(ai, { down: 1, ticks: 3 });
  q(ai, { down: 1, back: 1, ticks: 2 });
  if (sloppy) {
    q(ai, { buttons, ticks: 2 });
  } else {
    q(ai, { back: 1, ticks: 2 });
    q(ai, { back: 1, buttons, ticks: 2 });
  }
  q(ai, { ticks: 2 });
};
var qDp = (ai, buttons) => {
  q(ai, { fwd: 1, ticks: 2 });
  q(ai, { down: 1, ticks: 2 });
  q(ai, { down: 1, fwd: 1, buttons, ticks: 3 });
  q(ai, { ticks: 2 });
};
var qDash = (ai, dir) => {
  const d = dir === "fwd" ? { fwd: 1 } : { back: 1 };
  q(ai, { ...d, ticks: 2 });
  q(ai, { ticks: 2 });
  q(ai, { ...d, ticks: 3 });
};
var emit = (me, step2, moveDir, crouch) => {
  let f = 0;
  const fwdBit = me.facing === 1 ? 2 /* Right */ : 1 /* Left */;
  const backBit = me.facing === 1 ? 1 /* Left */ : 2 /* Right */;
  if (step2) {
    if (step2.fwd) f |= fwdBit;
    if (step2.back) f |= backBit;
    if (step2.up) f |= 4 /* Up */;
    if (step2.down) f |= 8 /* Down */;
    if (step2.buttons) f |= step2.buttons;
    return f;
  }
  if (moveDir === 1) f |= fwdBit;
  else if (moveDir === -1) f |= backBit;
  if (crouch) f |= 8 /* Down */;
  return f;
};
var drinkSlot = (me, op, maxHealth, tick, dist, t) => {
  const free = me.action === 0 /* Idle */ || me.action === 1 /* WalkF */ || me.action === 2 /* WalkB */ || me.action === 3 /* Crouch */;
  if (!free) return -1;
  const kinds = [me.itemKind0, me.itemKind1, me.itemKind2];
  const slot = (k) => kinds.indexOf(k);
  if (slot(1) >= 0 && me.health * 1e3 < maxHealth * (222 + t)) return slot(1);
  if (slot(3) >= 0 && me.itemDefLeft === 0 && me.health < op.health && me.health * 1e3 < maxHealth * (472 + t)) return slot(3);
  if (slot(2) >= 0 && me.itemDmgLeft === 0 && (op.action === 15 /* Knockdown */ || op.action === 16 /* Getup */)) return slot(2);
  if (slot(4) >= 0 && tick > 90 && me.meter * 1e3 < TUNING.meterMax * (372 + t) && dist > 308 - t) return slot(4);
  return -1;
};
var aiPoll = (ai, g) => {
  const me = g.fighters[ai.side];
  const op = g.fighters[1 - ai.side];
  const ch = characters[ai.side];
  if (!ai.bookBuilt) buildBook(ai, ch);
  if (ai.lastHealth < 0) ai.lastHealth = me.health;
  if (g.phase !== 1 /* Fighting */) {
    ai.queue = [];
    ai.qTicks = 0;
    ai.intent = 0 /* Observe */;
    ai.lastHealth = me.health;
    return 0;
  }
  const dist = pxDist(me, op);
  const reaction = lerp2(ai, 22, 7) + rnd(ai, lerp2(ai, 8, 3));
  const seen = (sinceTick) => g.tick - sinceTick >= reaction;
  if (op.action !== ai.oppAction) {
    ai.oppAction = op.action;
    ai.oppActionAt = g.tick;
    ai.reacted = 0;
  }
  if (me.health < ai.lastHealth) {
    if (!aiGrounded(op)) ai.eatJump = Math.min(9, ai.eatJump + 1);
    else if (op.action === 17 /* Grab */ || me.action === 18 /* Thrown */) ai.eatThrow = Math.min(9, ai.eatThrow + 1);
    else if (op.action === 3 /* Crouch */ || op.action === 9 /* Attack */) {
      const opCh = characters[1 - ai.side];
      const mv = op.moveIdx >= 0 ? opCh.b.moves[op.moveIdx] : null;
      if (moveHasGuard(mv, "low") || mv?.stance === "crouch") ai.eatLow = Math.min(9, ai.eatLow + 1);
    }
    ai.lastHealth = me.health;
  } else if (me.health > ai.lastHealth) {
    ai.lastHealth = me.health;
  }
  if (ai.queue.length > 0) {
    const step2 = ai.queue[0];
    const frame2 = emit(me, step2, 0, false);
    if (++ai.qTicks >= step2.ticks) {
      ai.queue.shift();
      ai.qTicks = 0;
    }
    return frame2;
  }
  const sip = drinkSlot(me, op, ch.b.maxHealth, g.tick, dist, ai.p.thirst);
  if (sip >= 0) return ITEM_BITS[sip];
  switch (me.action) {
    case 18 /* Thrown */: {
      if (g.tick - ai.oppActionAt >= Math.max(3, reaction - 4) && chance(ai, lerp2(ai, 40, 215))) {
        qTapButton(ai, 64 /* HP */);
      }
      return emit(me, null, 0, false);
    }
    case 12 /* BlockStand */:
    case 13 /* BlockCrouch */: {
      if (chance(ai, Math.trunc(ai.p.pushblocker * lerp2(ai, 20, 110) / 255))) {
        qTapButton(ai, 16 /* LP */ | 32 /* MP */, me.action === 13 /* BlockCrouch */ ? 1 : 0);
      }
      return emit(me, null, -1, me.action === 13 /* BlockCrouch */);
    }
    case 10 /* Hitstun */:
    case 11 /* AirHitstun */:
      ai.intent = 7 /* Defend */;
      ai.intentUntil = g.tick + 30;
      return 0;
    case 15 /* Knockdown */:
    case 16 /* Getup */:
      return emit(me, null, -1, true);
    case 5 /* Air */: {
      if (!ai.airAttackDone && ai.bookAir.length > 0) {
        const closing = dist < lerp2(ai, 150, 190) && me.velY > fp(-6);
        if (closing) {
          ai.airAttackDone = 1;
          const pick = ai.bookAir[rnd(ai, ai.bookAir.length)];
          qTapButton(ai, buttonOfMove(ch, pick));
        }
      }
      return emit(me, null, 1, false);
    }
    case 9 /* Attack */: {
      if (me.attackConnected === 1) {
        const next = comboNext(ai, ch, me, op, dist);
        if (next) return emit(me, null, 0, false);
      } else if (me.attackConnected === 2 && chance(ai, lerp2(ai, 90, 30))) {
        const gi = ai.bookGround.indexOf(me.moveIdx);
        if (gi >= 0 && gi + 1 < ai.bookGround.length) {
          qTapButton(ai, buttonOfMove(ch, ai.bookGround[gi + 1]));
        }
      }
      return emit(me, null, 0, false);
    }
    default:
      break;
  }
  if (aiGrounded(me)) ai.airAttackDone = 0;
  if (!actionable(me)) return emit(me, null, 0, false);
  if (!ai.reacted && seen(ai.oppActionAt)) {
    const oppAirborne = ai.oppAction === 5 /* Air */ || ai.oppAction === 8 /* AirDash */;
    if (oppAirborne && !aiGrounded(op) && dist < 240) {
      const aaOdds = Math.min(240, lerp2(ai, 30, 190) + ai.eatJump * 12);
      if (chance(ai, aaOdds)) {
        ai.reacted = 1;
        if (ai.idxDp >= 0 && chance(ai, 170)) qDp(ai, 64 /* HP */);
        else if (ai.bookLauncher >= 0) qTapButton(ai, 64 /* HP */, 1);
        return emit(me, null, 0, false);
      }
    }
    if (ai.oppAction === 9 /* Attack */ && dist < 200) {
      ai.reacted = 1;
      if (chance(ai, lerp2(ai, 120, 235))) {
        ai.intent = 7 /* Defend */;
        ai.intentUntil = g.tick + 26 + rnd(ai, 30);
      }
    }
    if (ai.oppAction === 15 /* Knockdown */ && dist < 320 && chance(ai, ai.p.aggression)) {
      ai.reacted = 1;
      ai.intent = 8 /* Oki */;
      ai.intentUntil = g.tick + 70;
    }
  }
  for (const pr of g.projectiles) {
    if (!pr.active || pr.owner === ai.side) continue;
    const towardMe = pr.velX > 0 === me.x > pr.x;
    const pdist = Math.abs(fpToPx(pr.x - me.x));
    if (towardMe && pdist < lerp2(ai, 120, 260) && pdist > 40) {
      if (chance(ai, Math.min(220, ai.p.jumpiness + ai.eatProj * 20))) {
        q(ai, { up: 1, fwd: 1, ticks: 3 });
        ai.eatProj = Math.max(0, ai.eatProj - 1);
      } else {
        ai.intent = 7 /* Defend */;
        ai.intentUntil = g.tick + 24;
        if (me.health > 0 && chance(ai, 30)) ai.eatProj = Math.min(9, ai.eatProj + 1);
      }
      break;
    }
  }
  if (op.action === 9 /* Attack */ && op.attackConnected === 0 && seen(ai.oppActionAt) && dist < 170 && chance(ai, lerp2(ai, 40, 200))) {
    if (canSuper(ai, ch, me) && ai.queue.length === 0 && g.tick >= ai.nextSuperAt && chance(ai, superOdds(ai, me, op, dist, true))) {
      qFireball(ai, 16 /* LP */ | 32 /* MP */);
      ai.nextSuperAt = g.tick + 90;
      return emit(me, null, 0, false);
    }
    ai.intent = 6 /* Punish */;
    ai.intentUntil = g.tick + 40;
  }
  if (canSuper(ai, ch, me) && ai.queue.length === 0 && g.tick >= ai.nextSuperAt && dist < 260 && aiGrounded(op)) {
    const oppMax = characters[ai.side === 0 ? 1 : 0]?.b.maxHealth ?? 1e4;
    const finisher = op.health <= Math.trunc(oppMax / 4);
    const overflowing = me.meter >= TUNING.meterMax;
    if ((finisher || overflowing) && chance(ai, superOdds(ai, me, op, dist, false))) {
      qFireball(ai, 16 /* LP */ | 32 /* MP */);
      ai.nextSuperAt = g.tick + 150;
      return emit(me, null, 0, false);
    }
  }
  if (g.tick >= ai.intentUntil) pickIntent(ai, g, me, op, dist);
  return actIntent(ai, g, me, op, ch, dist);
};
var pickIntent = (ai, g, me, op, dist) => {
  const w = [];
  const losing = me.health < op.health - 1500;
  if (dist < 110) {
    w.push([3 /* Pressure */, ai.p.aggression + (losing ? 40 : 0)]);
    w.push([0 /* Observe */, 60]);
    w.push([2 /* Retreat */, 70 - Math.trunc(ai.p.aggression / 4)]);
    w.push([7 /* Defend */, 50 + ai.eatThrow * 10 + ai.eatLow * 8]);
  } else if (dist < 260) {
    w.push([1 /* Approach */, ai.p.aggression]);
    w.push([0 /* Observe */, ai.p.patience]);
    w.push([5 /* JumpIn */, Math.trunc(ai.p.jumpiness / 2)]);
    w.push([2 /* Retreat */, 45]);
    if (ai.idxFireball >= 0) w.push([4 /* Zone */, Math.trunc(ai.p.zoner / 3)]);
  } else {
    w.push([1 /* Approach */, ai.p.aggression]);
    if (ai.idxFireball >= 0) w.push([4 /* Zone */, ai.p.zoner + (losing ? -30 : 20)]);
    w.push([5 /* JumpIn */, ai.p.jumpiness]);
    w.push([0 /* Observe */, Math.trunc(ai.p.patience / 2)]);
  }
  let total = 0;
  for (const [, wt] of w) total += Math.max(1, wt);
  let roll = rnd(ai, total);
  let picked = w[0][0];
  for (const [intent, wt] of w) {
    roll -= Math.max(1, wt);
    if (roll < 0) {
      picked = intent;
      break;
    }
  }
  ai.intent = picked;
  ai.intentUntil = g.tick + 14 + rnd(ai, 30 + Math.trunc(ai.p.patience / 4));
  ai.moveTicks = 0;
};
var actIntent = (ai, g, me, op, ch, dist) => {
  switch (ai.intent) {
    case 0 /* Observe */: {
      if (--ai.moveTicks <= 0) {
        ai.moveDir = [1, 0, -1, 0][rnd(ai, 4)];
        ai.moveTicks = 8 + rnd(ai, 18);
      }
      return emit(me, null, ai.moveDir, chance(ai, 6));
    }
    case 1 /* Approach */: {
      if (chance(ai, lerp2(ai, 2, 14))) qDash(ai, "fwd");
      if (dist < 100) {
        ai.intent = 3 /* Pressure */;
        ai.intentUntil = g.tick + 40;
      }
      return emit(me, null, 1, false);
    }
    case 2 /* Retreat */:
      return emit(me, null, -1, chance(ai, 30));
    case 4 /* Zone */: {
      if (ai.queue.length === 0 && dist > 180) qFireball(ai, 16 /* LP */);
      ai.intent = 0 /* Observe */;
      ai.intentUntil = g.tick + 20 + rnd(ai, 26);
      return emit(me, null, 0, false);
    }
    case 5 /* JumpIn */: {
      q(ai, { up: 1, fwd: 1, ticks: 4 });
      ai.intent = 1 /* Approach */;
      ai.intentUntil = g.tick + 50;
      return emit(me, null, 1, false);
    }
    case 6 /* Punish */:
    case 3 /* Pressure */: {
      if (dist > 140) {
        return emit(me, null, 1, false);
      }
      openString(ai, ch, dist);
      ai.intent = 0 /* Observe */;
      ai.intentUntil = g.tick + 16 + rnd(ai, 20);
      return emit(me, null, 0, false);
    }
    case 7 /* Defend */: {
      const standGuard = !aiGrounded(op) && chance(ai, 200);
      return emit(me, null, -1, !standGuard);
    }
    case 8 /* Oki */: {
      if (dist > 90) return emit(me, null, 1, false);
      if (op.action !== 15 /* Knockdown */ && op.action !== 16 /* Getup */) {
        ai.intent = 3 /* Pressure */;
        ai.intentUntil = g.tick + 30;
        return emit(me, null, 0, false);
      }
      if (op.action === 16 /* Getup */ && ch.b.moves && ai.queue.length === 0) {
        if (chance(ai, ai.p.throwHappy)) q(ai, { fwd: 1, buttons: 64 /* HP */, ticks: 2 });
        else if (ai.idxLow >= 0) qTapButton(ai, 128 /* LK */, 1);
      }
      return emit(me, null, 0, chance(ai, 128));
    }
    default:
      return emit(me, null, 0, false);
  }
};
var openString = (ai, ch, dist) => {
  const roll = rnd(ai, 255);
  if (dist < 70 && roll < ai.p.throwHappy) {
    q(ai, { fwd: 1, buttons: 64 /* HP */, ticks: 2 });
    return;
  }
  if (roll < 100 && ai.idxLow >= 0) {
    qTapButton(ai, 128 /* LK */, 1);
    return;
  }
  if (roll < 140 && ai.idxSweep >= 0 && chance(ai, 90)) {
    qTapButton(ai, 512 /* HK */, 1);
    return;
  }
  qTapButton(ai, 16 /* LP */);
};
var comboNext = (ai, ch, me, op, dist) => {
  const flub = !chance(ai, lerp2(ai, 150, 246));
  const delay = flub ? 3 + rnd(ai, 5) : 0;
  const gi = ai.bookGround.indexOf(me.moveIdx);
  if (gi >= 0) {
    if (gi + 1 < ai.bookGround.length) {
      if (delay) q(ai, { ticks: delay });
      qTapButton(ai, buttonOfMove(ch, ai.bookGround[gi + 1]));
      return true;
    }
    if (canSuper(ai, ch, me) && chance(ai, superOdds(ai, me, op, dist, true))) {
      qFireball(ai, 16 /* LP */ | 32 /* MP */);
      return true;
    }
    if (ai.bookLauncher >= 0 && ai.skill >= 40 && chance(ai, lerp2(ai, 60, 210))) {
      if (delay) q(ai, { ticks: delay });
      qTapButton(ai, 64 /* HP */, 1);
      return true;
    }
    if (ai.idxFireball >= 0 && chance(ai, ai.p.zoner)) {
      qFireball(ai, 16 /* LP */);
      return true;
    }
    if (ai.idxSpecialK >= 0 && dist < 150 && chance(ai, lerpSq(ai, 20, 150))) {
      q214(ai, 128 /* LK */);
      return true;
    }
    return false;
  }
  if (me.moveIdx === ai.bookLauncher && ai.skill >= 45) {
    q(ai, { up: 1, fwd: 1, ticks: 6 });
    let t = 4 + rnd(ai, 3);
    for (const idx of ai.bookAir) {
      if (!chance(ai, lerp2(ai, 130, 240))) break;
      q(ai, { ticks: t });
      qTapButton(ai, buttonOfMove(ch, idx));
      t = 4 + rnd(ai, 4);
    }
    return true;
  }
  return false;
};

// ../AGENT FIGHTER/agent-fighter/packages/core/src/arcade-map.ts
var BOARD_W = 32;
var BOARD_H = 32;

// ../AGENT FIGHTER/agent-fighter/packages/core/src/arcade-board.ts
var SPINE_KINDS = ["fight", "fight", "gate", "fight", "gate", "fight", "boss"];
var RUNGS = SPINE_KINDS.length;
var SPINE_X = Math.floor(BOARD_W / 2);
var START_Y = BOARD_H - 1;

// ../AGENT FIGHTER/agent-fighter/packages/core/src/replay.ts
var REPLAY_CODEC_VERSION = 1;
var MAX_TICKS = 108e3;
var putVarint = (out, value) => {
  let v = Math.trunc(value);
  if (v < 0) v = 0;
  while (v >= 128) {
    out.push(v & 127 | 128);
    v = Math.floor(v / 128);
  }
  out.push(v & 127);
};
var getVarint = (r) => {
  let result = 0;
  let scale = 1;
  for (; ; ) {
    if (r.at >= r.bytes.length) throw new Error("replay: truncated varint");
    const b = r.bytes[r.at++];
    result += (b & 127) * scale;
    if ((b & 128) === 0) return result;
    scale *= 128;
    if (scale > 2 ** 53) throw new Error("replay: varint overflow");
  }
};
var encodeInputTrack = (inputs) => {
  const out = [];
  const n = Math.min(inputs.length, MAX_TICKS);
  putVarint(out, n);
  let i = 0;
  while (i < n) {
    const value = inputs[i] === void 0 ? 0 : Math.trunc(inputs[i]) | 0;
    let run = 1;
    while (i + run < n) {
      const next = inputs[i + run] === void 0 ? 0 : Math.trunc(inputs[i + run]) | 0;
      if (next !== value) break;
      run++;
    }
    putVarint(out, value < 0 ? 0 : value);
    putVarint(out, run);
    i += run;
  }
  return Uint8Array.from(out);
};
var decodeInputTrack = (bytes) => {
  const r = { bytes, at: 0 };
  const n = getVarint(r);
  if (n > MAX_TICKS) throw new Error(`replay: track too long (${n})`);
  const out = [];
  while (out.length < n) {
    const value = getVarint(r);
    const run = getVarint(r);
    if (run <= 0) throw new Error("replay: zero-length run");
    if (out.length + run > n) throw new Error("replay: run overflows track");
    for (let k = 0; k < run; k++) out.push(value);
  }
  return out;
};
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var bytesToBase64Url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    s += B64[b0 >> 2];
    s += B64[(b0 & 3) << 4 | (b1 < 0 ? 0 : b1 >> 4)];
    if (b1 < 0) break;
    s += B64[(b1 & 15) << 2 | (b2 < 0 ? 0 : b2 >> 6)];
    if (b2 < 0) break;
    s += B64[b2 & 63];
  }
  return s;
};
var B64_INV = {};
for (let i = 0; i < B64.length; i++) B64_INV[B64[i]] = i;
var base64UrlToBytes = (s) => {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=" || c === "\n" || c === "\r") continue;
    const v = B64_INV[c === "+" ? "-" : c === "/" ? "_" : c];
    if (v === void 0) throw new Error(`replay: bad base64url char ${JSON.stringify(c)}`);
    acc = acc << 6 | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
    }
  }
  return Uint8Array.from(out);
};
var canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
};
var encodeLedger = (tracks) => {
  const parts = [
    encodeInputTrack(tracks[0]),
    encodeInputTrack(tracks[1])
  ];
  const out = [];
  putVarint(out, REPLAY_CODEC_VERSION);
  putVarint(out, parts.length);
  for (const p of parts) {
    putVarint(out, p.length);
    for (let i = 0; i < p.length; i++) out.push(p[i]);
  }
  return bytesToBase64Url(Uint8Array.from(out));
};
var decodeLedger = (encoded) => {
  const r = { bytes: base64UrlToBytes(encoded), at: 0 };
  const version = getVarint(r);
  if (version !== REPLAY_CODEC_VERSION) {
    throw new Error(`replay: unsupported codec version ${version}`);
  }
  const count = getVarint(r);
  if (count < 2) throw new Error(`replay: expected 2 tracks, got ${count}`);
  const tracks = [];
  for (let i = 0; i < count; i++) {
    const len = getVarint(r);
    if (r.at + len > r.bytes.length) throw new Error("replay: truncated track");
    const slice = r.bytes.subarray(r.at, r.at + len);
    r.at += len;
    if (i < 2) tracks.push(decodeInputTrack(slice));
  }
  return [tracks[0], tracks[1]];
};

// titles/agent-fighter.adapter.js
var exclusive = true;
var ENGINE = ENGINE_VERSION;
var balance = defineBalance({
  atk: (s) => Math.round(lerp(0, AURA_MAX, s.strength / 65535)),
  def: (s) => Math.round(lerp(0, AURA_MAX, s.resilience / 65535)),
  crit: (s) => Math.round(lerp(0, AURA_MAX, s.agility / 65535)),
  energyRegen: (s) => Math.round(lerp(0, AURA_MAX, s.intelligence / 65535))
});
var bundleHash = (b) => h("bundle", canonical(b)).slice(0, 16);
var resolveBundle = (agent, ctx) => {
  const uri = agent?.manifest?.characterConfigURI ?? null;
  const b = uri && ctx.bundles?.[uri] || ANALOG;
  return { uri: b === ANALOG ? "builtin:analog" : uri, bundle: b, hash: b.versionHash ?? bundleHash(b) };
};
var hexI32 = (arr) => {
  let out = "";
  for (let i = 0; i < arr.length; i++) out += (arr[i] >>> 0).toString(16).padStart(8, "0");
  return out;
};
var frame = (v) => {
  const n = typeof v === "number" ? v : typeof v?.k === "number" ? v.k : 0;
  return (n | 0) & 8191;
};
var MAX_TICKS2 = (TUNING.preRoundTicks + ROUND_SECONDS * TICKS_PER_SEC + TUNING.roundOverTicks) * (2 * TUNING.roundsToWin - 1) + 120;
var agent_fighter_adapter_default = defineTitle({
  rulesetId: "agent-fighter.v1",
  tickRate: TICKS_PER_SEC,
  maxTicks: MAX_TICKS2,
  modes: ["ranked", "casual"],
  balance,
  hostPolicy: { affinity: "open" },
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: "credits" }),
    stats: { track: ["matches", "wins", "ticks"] }
  },
  /** seed: hex string from H(beacon, matchId). participants: [playerId, playerId]
   *  in side order. ctx.agents: playerId → hydrated ERC-6699 agent.
   *  ctx.bundles: characterConfigURI → CharacterBundle. ctx.bounds: stage
   *  playfield bounds (optional; default = full stage). */
  init(seed, participants, ctx) {
    if (participants.length !== 2) throw new Error("agent-fighter: exactly two participants");
    let sides, seedInt, bounds, pinHash = null;
    if (ctx.pin) {
      const pin = ctx.pin;
      sides = participants.map((p, i) => {
        const id = pin.chars?.[i];
        const bundle = ctx.bundles?.[id];
        if (!bundle) throw new Error(`agent-fighter: pin names character "${id}" but no bundle was supplied`);
        return {
          player: p,
          uri: `af:${id}`,
          bundle,
          hash: bundle.versionHash ?? bundleHash(bundle),
          aura: clampAura(pin.pets?.[i]?.aura ?? null),
          items: (pin.items?.[i] ?? []).map((x) => x.effect)
        };
      });
      seedInt = pin.seed | 0;
      bounds = pin.bounds ?? void 0;
      pinHash = h("af-pin", pin);
    } else {
      sides = participants.map((p) => {
        const agent = ctx.agents?.[p];
        if (!agent) throw new Error(`agent-fighter: no hydrated agent for ${p}`);
        return { player: p, ...resolveBundle(agent, ctx), aura: balance.apply(agent.stats), items: [] };
      });
      seedInt = parseInt(String(seed).slice(0, 8), 16) | 0;
      bounds = ctx.bounds ?? void 0;
    }
    setCharacters(loadCharacter(sides[0].bundle), loadCharacter(sides[1].bundle));
    setMatchPets(sides[0].aura, sides[1].aura);
    setMatchItems(sides[0].items, sides[1].items);
    const state = createGameState(seedInt, bounds);
    state.pins = {
      engine: ENGINE,
      seed: seedInt,
      bounds: bounds ?? null,
      participants: [sides[0].player, sides[1].player],
      bundles: sides.map((s) => ({ uri: s.uri, hash: s.hash })),
      auras: sides.map((s) => s.aura),
      items: sides.map((s) => s.items),
      pinHash
    };
    return state;
  },
  step(state, inputs) {
    const [a, b] = state.pins.participants;
    step(state, [frame(inputs?.[a]), frame(inputs?.[b])]);
    return state;
  },
  done: (s) => s.phase === 3 /* MatchOver */ || s.tick >= MAX_TICKS2,
  serialize: (s) => canonical({ engine: ENGINE, pins: s.pins, state: hexI32(serialize(s)) }),
  // The fighter has no hidden information, so the client may see the whole
  // state; the renderer is a pure function of it.
  view: (s) => snapshot(s),
  scores(s) {
    const [a, b] = s.pins.participants;
    return { [a]: s.roundsWon0, [b]: s.roundsWon1 };
  }
});
var engine = {
  ENGINE_VERSION: ENGINE,
  TICKS_PER_SEC,
  Btn,
  Phase,
  createAi,
  aiPoll,
  stateHash,
  loadCharacter,
  // The relay's ledger codec, so a stored Agent Fighter ledger can be turned
  // into litnode entries by anyone holding this artifact.
  decodeLedger,
  encodeLedger,
  canonicalJson
};
export {
  balance,
  agent_fighter_adapter_default as default,
  engine,
  exclusive
};
