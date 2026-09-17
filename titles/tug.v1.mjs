/** TUG — a litVM Games title. One file, five functions, a manifest.
 *
 *  Start here:  npm run create-title -- tug.v1   (made this file)
 *  Check it:    node sdk/conformance.mjs titles/tug.v1.mjs
 *  Bundle it:   node tools/bundle-title.mjs titles/tug.v1.mjs   → rulesets/tug.v1.js (+ .json with the buildHash)
 *  Host it:     RULESETS=./rulesets/tug.v1.js npm run node       → any bonded node can now fetch it by hash
 *
 *  The rules of the road (docs/HOST-YOUR-TITLE.md):
 *   - step() is the ONLY way state changes, and it must be deterministic:
 *     integers, the seed, seededRandom() — never Math.random, Date, or the
 *     network. A witness on another machine re-runs your log and must reach
 *     the same serialize() root, or your match does not settle.
 *   - inputs are per-player frames per tick (here: a bitfield); the node
 *     hash-chains them and each player signs the head once at match end.
 *   - view() is what a client may see; serialize() is what the root commits
 *     to. If your game has hidden information, filter it in view().
 *   - characters are ERC-6699 agents: ctx.agents[playerId].stats holds four
 *     uint16s (strength, agility, resilience, intelligence). Map them into
 *     your numbers with defineBalance, keep the ranges bounded, and ranked
 *     play gets the mapping without equipment — that is what makes a
 *     ladder mean something across titles.
 *
 *  This template is a complete, playable, replayable game: TUG. Two players,
 *  each tick you may PULL (bit 0) or BRACE (bit 1); pulling moves the rope
 *  toward you by your strength unless the other braces; the rope reaching
 *  ±LIMIT ends the match. Replace it with yours. */
import { defineTitle, defineBalance, eloLeaderboard, winnerTakesCredits, lerp, seededRandom } from '../sdk/index.js';

const TICK_RATE = 20;
const MAX_TICKS = TICK_RATE * 60;  // one minute
const LIMIT = 1000;

export const balance = defineBalance({
  // uint16 [0, 65535] → a bounded per-tick pull. A 3× spread, on purpose.
  pull: (s) => Math.round(lerp(4, 12, (s.strength ?? 32768) / 65535)),
  brace: (s) => Math.round(lerp(2, 6, (s.resilience ?? 32768) / 65535)),
});

export default defineTitle({
  rulesetId: 'tug.v1',
  tickRate: TICK_RATE,
  maxTicks: MAX_TICKS,
  participants: 2,
  inputSchema: 'bitfield:pull=1,brace=2',
  modes: ['ranked', 'casual'],
  balance,
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: 'credits' }),
    stats: { track: ['matches', 'wins', 'ticks'] },
  },
  display: {
    title: 'TUG',
    url: 'https://example.com/tug.v1/',      // where the game runs; the arcade launches it here
    description: 'Two players, one rope. Pull, brace, win.',
  },

  /** seed: hex from H(beacon, matchId). participants: [playerId, playerId]. ctx.agents: hydrated ERC-6699 tokens. */
  init(seed, participants, ctx) {
    const rnd = seededRandom(seed);
    const [a, b] = participants;
    const stat = (p) => balance.apply(ctx?.agents?.[p]?.stats);
    return {
      participants: [a, b],
      rope: 0,                       // + toward a, − toward b
      pull: { [a]: stat(a).pull, [b]: stat(b).pull },
      brace: { [a]: stat(a).brace, [b]: stat(b).brace },
      gust: (rnd() % 7) - 3,         // a seeded, replayable wind — never Math.random
      tick: 0,
      over: false,
    };
  },

  /** inputs: { [playerId]: bitfield }. Must be deterministic; must not mutate `inputs`. */
  step(state, inputs) {
    if (state.over) return state;
    const [a, b] = state.participants;
    const ia = inputs[a] | 0, ib = inputs[b] | 0;
    let rope = state.rope;
    if (ia & 1) rope += (ib & 2) ? Math.max(0, state.pull[a] - state.brace[b]) : state.pull[a];
    if (ib & 1) rope -= (ia & 2) ? Math.max(0, state.pull[b] - state.brace[a]) : state.pull[b];
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
  },
});
