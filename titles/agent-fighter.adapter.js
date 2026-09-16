import { defineTitle, eloLeaderboard, winnerTakesCredits } from './title.js';
import { defineBalance, lerp } from '../protocol/erc6699.js';
import { canonical, h } from '../protocol/canonical.js';
import * as core from '@af/core';

/** Agent Fighter — strodanodev/agent-fighter, written against @af/core as it
 *  actually exports (af-core-8), not the shape the previous adapter assumed.
 *
 *  What the engine really gives us:
 *    createGameState(seed: int32, bounds?)   — not createState(hex)
 *    step(state, [frameA, frameB]): void     — mutates in place, inputs are
 *                                              bitfields by SIDE, not by player
 *    Phase.MatchOver                          — not isOver()
 *    serialize(state): Int32Array, stateHash(): 32-bit FNV
 *    setCharacters / setMatchPets / setMatchItems — MODULE-LEVEL pins that
 *      must be installed before createGameState on every simulating peer
 *
 *  There is no fallback sim. This file is bundled together with @af/core into
 *  one import-free artifact by tools/bundle-ruleset.mjs, so buildHash pins the
 *  engine and the adapter as one thing. If the engine is absent the build
 *  fails; nothing silently runs a stub in its place.
 *
 *  LIMIT (stated, not hidden): the engine's pins are process globals, so one
 *  process may simulate ONE match at a time. The node must run each match in
 *  its own worker until @af/core moves pins into GameState. `exclusive` below
 *  is the flag the runtime should honour. */

export const exclusive = true;

const ENGINE = core.ENGINE_VERSION;

/** ERC-6699 core stats → the engine's bounded per-mille aura lines
 *  (AURA_MAX = 80 = +8%). This is the ranked-fairness decision: a maxed stat
 *  is worth at most 8% on one line, so two honest characters are always
 *  within a competitive band. Equipment, drinks and pets are the casual-only
 *  layer on top and are stripped in ranked by the hydration manifest. */
export const balance = defineBalance({
  atk:         (s) => Math.round(lerp(0, core.AURA_MAX, s.strength / 65535)),
  def:         (s) => Math.round(lerp(0, core.AURA_MAX, s.resilience / 65535)),
  crit:        (s) => Math.round(lerp(0, core.AURA_MAX, s.agility / 65535)),
  energyRegen: (s) => Math.round(lerp(0, core.AURA_MAX, s.intelligence / 65535)),
});

const bundleHash = (b) => h('bundle', canonical(b)).slice(0, 16);

/** A token's characterConfigURI names a character bundle. ctx.bundles maps
 *  URI → CharacterBundle; a token without one fights as the built-in ANALOG
 *  and the pin records that, so the witness installs the same thing. */
const resolveBundle = (agent, ctx) => {
  const uri = agent?.manifest?.characterConfigURI ?? null;
  const b = (uri && ctx.bundles?.[uri]) || core.ANALOG;
  return { uri: b === core.ANALOG ? 'builtin:analog' : uri, bundle: b, hash: b.versionHash ?? bundleHash(b) };
};

/** Platform-independent hex of the engine's Int32Array state. */
const hexI32 = (arr) => {
  let out = '';
  for (let i = 0; i < arr.length; i++) out += (arr[i] >>> 0).toString(16).padStart(8, '0');
  return out;
};

/** InputFrame from whatever the client sent: a raw bitfield, or {k: bits}. */
const frame = (v) => {
  const n = typeof v === 'number' ? v : typeof v?.k === 'number' ? v.k : 0;
  return (n | 0) & 0x1fff; // Btn.Left .. Btn.Item3
};

const MAX_TICKS =
  (core.TUNING.preRoundTicks + core.ROUND_SECONDS * core.TICKS_PER_SEC + core.TUNING.roundOverTicks)
    * (2 * core.TUNING.roundsToWin - 1) + 120;

export default defineTitle({
  rulesetId: 'agent-fighter.v1',
  tickRate: core.TICKS_PER_SEC,
  maxTicks: MAX_TICKS,
  modes: ['ranked', 'casual'],
  balance,
  hostPolicy: { affinity: 'open' },
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: 'credits' }),
    stats: { track: ['matches', 'wins', 'ticks'] },
  },

  /** seed: hex string from H(beacon, matchId). participants: [playerId, playerId]
   *  in side order. ctx.agents: playerId → hydrated ERC-6699 agent.
   *  ctx.bundles: characterConfigURI → CharacterBundle. ctx.bounds: stage
   *  playfield bounds (optional; default = full stage). */
  init(seed, participants, ctx) {
    if (participants.length !== 2) throw new Error('agent-fighter: exactly two participants');

    // Two hydration sources, both committed into the state root:
    //  - ERC-6699 (ctx.agents): stats → auras, bundle from characterConfigURI
    //  - the Agent Fighter relay's own pin (ctx.pin): the exact setup the
    //    match server recorded — seed, bounds, character ids, drinks, pets.
    //    This is how a match played through the existing relay settles on a
    //    node without the players holding litnode keys yet.
    let sides, seedInt, bounds, pinHash = null;
    if (ctx.pin) {
      const pin = ctx.pin;
      sides = participants.map((p, i) => {
        const id = pin.chars?.[i];
        const bundle = ctx.bundles?.[id];
        if (!bundle) throw new Error(`agent-fighter: pin names character "${id}" but no bundle was supplied`);
        return {
          player: p, uri: `af:${id}`, bundle, hash: bundle.versionHash ?? bundleHash(bundle),
          aura: core.clampAura(pin.pets?.[i]?.aura ?? null),
          items: (pin.items?.[i] ?? []).map((x) => x.effect),
        };
      });
      seedInt = pin.seed | 0;
      bounds = pin.bounds ?? undefined;
      pinHash = h('af-pin', pin);
    } else {
      sides = participants.map((p) => {
        const agent = ctx.agents?.[p];
        if (!agent) throw new Error(`agent-fighter: no hydrated agent for ${p}`);
        return { player: p, ...resolveBundle(agent, ctx), aura: balance.apply(agent.stats), items: [] };
      });
      seedInt = parseInt(String(seed).slice(0, 8), 16) | 0;
      bounds = ctx.bounds ?? undefined;
    }

    // The engine's process-global pins. Every simulating peer — host, witness,
    // rollback client — installs exactly these before createGameState.
    core.setCharacters(core.loadCharacter(sides[0].bundle), core.loadCharacter(sides[1].bundle));
    core.setMatchPets(sides[0].aura, sides[1].aura);
    core.setMatchItems(sides[0].items, sides[1].items);

    const state = core.createGameState(seedInt, bounds);
    // Everything the state root must commit to beyond the engine's own bytes.
    // Two honest hosts with different engines or bundles reach different roots.
    state.pins = {
      engine: ENGINE,
      seed: seedInt,
      bounds: bounds ?? null,
      participants: [sides[0].player, sides[1].player],
      bundles: sides.map((s) => ({ uri: s.uri, hash: s.hash })),
      auras: sides.map((s) => s.aura),
      items: sides.map((s) => s.items),
      pinHash,
    };
    return state;
  },

  step(state, inputs) {
    const [a, b] = state.pins.participants;
    core.step(state, [frame(inputs?.[a]), frame(inputs?.[b])]);
    return state;
  },

  done: (s) => s.phase === core.Phase.MatchOver || s.tick >= MAX_TICKS,

  serialize: (s) => canonical({ engine: ENGINE, pins: s.pins, state: hexI32(core.serialize(s)) }),

  // The fighter has no hidden information, so the client may see the whole
  // state; the renderer is a pure function of it.
  view: (s) => core.snapshot(s),

  scores(s) {
    const [a, b] = s.pins.participants;
    return { [a]: s.roundsWon0, [b]: s.roundsWon1 };
  },
});

/** Engine surface the node, tests and the (future) agent role need:
 *  the built-in AI to drive headless matches, the input bit layout, and
 *  the version string for the hydration manifest. */
export const engine = {
  ENGINE_VERSION: ENGINE,
  TICKS_PER_SEC: core.TICKS_PER_SEC,
  Btn: core.Btn,
  Phase: core.Phase,
  createAi: core.createAi,
  aiPoll: core.aiPoll,
  stateHash: core.stateHash,
  loadCharacter: core.loadCharacter,
  // The relay's ledger codec, so a stored Agent Fighter ledger can be turned
  // into litnode entries by anyone holding this artifact.
  decodeLedger: core.decodeLedger,
  encodeLedger: core.encodeLedger,
  canonicalJson: core.canonicalJson,
};
