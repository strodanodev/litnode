# Arcade Node — prototype

A node client, a deterministic test title, and a static web client that gets its
multiplayer from the node network and has no backend of its own.

Built for two cases and honest about everything outside them.

| Case | What it means | Where it is proved |
|---|---|---|
| **1. Local publisher** | One node on the publisher's own machine. Their deployed page gets match-server features from it. | `demo/smoke.js` case 1 |
| **2. Several nodes, third-party players** | Multiple operators behind one deployment, including operators nobody sent a copy of the game to. | `demo/smoke.js` case 2 |

## Run it

```bash
npm install
npm run demo          # 17 assertions across three cases, ~40s
```

Play it in a browser:

```bash
npm run node                       # one node on :7801
npx serve .                        # or deploy this repo to Vercel as-is
```

Open the page in two windows, give each a name, hold the space bar. Each window
generates its own keypair, so the two are genuinely different players.

For a mesh, start more nodes and point them at each other. Note that only the
first one is given the game:

```bash
PORT=7801 OPERATOR=publisher SEEDS=http://127.0.0.1:7802 npm run node
PORT=7802 OPERATOR=guild-a   SEEDS=http://127.0.0.1:7801 RULESETS= npm run node
PORT=7803 OPERATOR=guild-b   SEEDS=http://127.0.0.1:7801 RULESETS= npm run node
```

The other two pull it, check it against the pinned hash, and start hosting.
Nothing about the browser client changes.

## The one idea

`protocol/placement.js` is a pure function of registry state. It runs unchanged
in the node and in the browser, so:

- the client computes which node should host, and refuses any other;
- with one node in the registry the sort returns that node and the match runs;
- with fifty it returns a draw, and the code path is identical;
- nobody schedules anything, so there is nothing to capture and nothing to bribe.

Case 1 and case 2 are not two modes. They are the same function over a registry
with one entry and a registry with several.

## What each case demonstrates

**Case 1.** A publisher hosts their own title on one machine. The match runs, the
delta is signed, and the witness field is reported as absent rather than faked.
Queueing under someone else's name is rejected, because a player is a keypair and
the playerId is the public key.

**Case 2.** Two nodes start with no copy of the game. They see it advertised in
the registry, fetch the source from a peer, refuse it unless the bytes hash to
the pinned `buildHash`, and become eligible to host. Two players then enter at
*different* nodes and are paired anyway, because pairing is a deterministic
function of the gossiped queue rather than a decision some node makes. Both
clients independently compute the same host. A node under a different operator
replays the log, reproduces the state root, and co-signs. Then the publisher's
node is stopped, its heartbeat lapses, the draw falls through to the remaining
operators, and the title keeps taking matches.

**Case 3.** A node is restarted. Its identity and its settled deltas survive.

## Trust, such as it is

- A player is an ed25519 keypair. `playerId` is the public key.
- Queue entries are signed, so you cannot enter as someone else.
- Every input is signed per tick against the match id, so a host cannot forge
  inputs into the log it later publishes.
- The witness re-verifies every signature during replay, not just the final root.
- Rulesets are pinned by the hash of their own source, so a host and a witness
  that disagree on the bytes cannot accidentally agree on a root.
- A Gauntlet Loop has no imports at all: integer state, seeded PRNG, no clock, no
  network. That is what makes it shippable by hash and replayable byte-identically,
  and it is the shape that compiles to Wasm without an argument.

## Reaching a node from a browser

This is the part that decides how far each case goes, so it is written down
rather than assumed.

**Case 1, localhost.** A page served over https may talk to `http://127.0.0.1`
because browsers treat loopback as trustworthy — but Chrome additionally requires
Private Network Access headers on the preflight. The node sends them. Without
them this fails with no useful error, which is worth knowing before you spend an
afternoon on it. Safari is the least reliable of the three here.

**Case 2, over the internet.** A public node needs a reachable address and a
certificate. Set `PUBLIC_ADDR=https://node.example.com` and put Caddy or nginx in
front; the node advertises that address in its registry entry and the client uses
it. Residential operators cannot do this, which is what WebRTC is for: the host
becomes the answerer, needs no certificate and no inbound port, and only the
signalling relay needs a public address. That replaces `connect()` in
`client/client.js` and the `WebSocketServer` in `node/litnode.js`. Nothing above
the transport changes.

## Layout

```
protocol/     placement, canonical JSON, hashing, keys, hash-chained log
              — shared verbatim between node and browser
rulesets/     tug.v1.js — a Gauntlet Loop with no dependencies
node/         litnode.js (registry, gossip, pairing, host, witness) + runtime
client/       isomorphic: identity, queue, snapshot, recompute placement, play
web/          static page, deployable anywhere; vendor/ holds the two crypto deps
scripts/      vendor.js — re-run after a dependency bump
demo/         smoke.js
data/         per-node identity, hydrated rulesets, settled matches
```

## Seams left open on purpose

Each is a swap, not a rewrite. That is what composable has to mean to be worth
saying.

- **Transport** — WebSocket now, WebRTC later. See above.
- **Registry** — signed heartbeats gossiped between peers, with a snapshot root.
  Swap the source for the on-chain registry and `placement()` is untouched.
- **Beacon** — a wall-clock epoch string stands in for a block hash. One line.
- **Ruleset** — five exported functions. A real title drops in. Compiling to Wasm
  changes how `buildHash` is computed and nothing else.
- **Artifact transfer** — source fetched over HTTP and checked against the pinned
  hash. Content-addressed shards with a deterministic replica set go behind the
  same call.
- **Settlement** — deltas are written to disk and served over HTTP. An epoch tree
  and a chain anchor go behind the same interface.

## Honest zeroes

- **Rulesets are imported as ES modules, not sandboxed.** Fetch-by-hash is safe
  among known operators and is *not* safe the day registration is permissionless.
  Wasm in a sandbox is the fix, and it is not optional at that point.
- No NAT traversal, so a host node must be reachable. See the browser section.
- No replication policy. A ruleset spreads because nodes pull it, not because any
  number of copies is guaranteed.
- No metering and no economics. Nothing is paid for.
- No TEE, no agent inference, no ERC-6699 hydration, no AirKit.
- No mid-match host failover. A dead host between matches is handled; a dead host
  during one ends it. Resume needs the log in shared custody, which needs
  replication first.
- Registry convergence is time-bucketed heartbeats with a two-epoch freshness
  window, so it is eventual and a node under heavy clock skew can compute a
  different draw. An on-chain registry is the fix, not a longer timeout.
- One witness and no disagreement path. Two nodes reaching different roots is
  logged and goes no further.

---

# Build 2 — ERC-6699, backend services, litVM testnet

```bash
npm run demo:all      # both suites
```

## What a game developer actually writes

One file. Five functions and a manifest, via `defineTitle`. Everything else —
placement, hosting, witness replay, leaderboards, credits, stats, epoch
settlement — is derived or handled.

```js
import { defineTitle, defineBalance, lerp, eloLeaderboard, winnerTakesCredits } from '@litvm/sdk';

export const balance = defineBalance({
  startupFrames: (s) => Math.round(lerp(14, 6, s.agility / 65535)),
  health:        (s) => Math.round(lerp(1800, 12000, s.resilience / 65535)),
});

export default defineTitle({
  rulesetId: 'your-title.v1', tickRate: 60, maxTicks: 60 * 99, balance,
  services: {
    leaderboard: eloLeaderboard({ k: 24 }),
    credits: winnerTakesCredits({ pot: 10, currency: 'credits' }),
    stats: { track: ['matches', 'wins', 'ticks'] },
  },
  init(seed, participants, ctx) { /* ctx.agents holds the hydrated ERC-6699 tokens */ },
  step(state, inputs) { /* authoritative, integer, seeded */ },
  done: (s) => /* ... */,
  serialize: (s) => /* what the state root commits to */,
  view: (s) => /* what may cross to a client — hidden state filtered node-side */,
  scores: (s) => /* ... */,
});
```

## Titles

| Title | Adapter | Notes |
|---|---|---|
| Agent Fighter | `titles/agent-fighter.adapter.js` | `@af/core` is already a Gauntlet Loop: pure TS, no DOM, no `Date`, no `Math.random`, 24.8 fixed point, `step(state, inputs)` as the only mutation, `stateHash()` for desync. Wiring is an import. A local fallback sim runs when `@af/core` is absent. |
| Pickle Brawl | `titles/pickle-brawl.adapter.js` | Gacha shop and cosmetic wardrobe stay in the studio DB. Rally outcome, ladder and PICKLE balance settle. |
| AFC | `titles/afc.adapter.js` | No human inputs at all, so a bout is a pure function of two manifests and a beacon. Spectators verify rather than trust. |
| Annorak | `titles/annorak.NOTES.md` | Deliberately not adapted. A world that never rolls back is not a match that ends. Reasons in the file. |

## Backend services, derived not stored

A publisher runs one node and gets a match server, a ladder, credits and stats
without writing a backend. These are **derived from settled deltas**, so any
node holding the delta set rebuilds identical tables and `/leaderboard` cannot
be quietly edited. `services.digest()` hashes them so the claim is checkable.

```
GET /leaderboard?ruleset=agent-fighter.v1
GET /credits?ruleset=…&currency=credits&player=…
GET /stats?ruleset=…&player=…
GET /epoch?epoch=…
```

Every title keeps its own database. `node/store.js` has `memoryStore`,
`supabaseStore` (one `arcade_kv` table over PostgREST) and `firebaseStore`.
Point the node at the studio's existing project; sovereignty is not the price
of joining.

## ERC-6699

Stats are `uint16` in `[0, 65535]` and each title declares its own mapping, so
one character reads three ways without re-minting at the border:

```
HERMES    agility 58000
  Agent Fighter   startupFrames 7
  Pickle Brawl    paddleSpeed 74
  AFC             servoSpeed 83
```

Ranked sterility is mechanical rather than promised. The delta carries a
`hydrationManifest` with equipment stripped in ranked; the witness replays from
that manifest, so a host that hydrates banned gear reaches a different state
root — the same event as any other bad root, needing no separate machinery.

`contracts/ERC6699Registry.sol` is the deploy target. `node/registry6699.js`
reads it by `eth_call` when an address is configured and falls back to local
fixtures when it is not, reporting which path it used.

## Settlement

litVM Liteforge testnet, chain **4441**, native **zkLTC**, RPC
`https://liteforge.rpc.caldera.xyz/http`, explorer
`https://liteforge.explorer.caldera.xyz`.

One hourly root, leaf set published, inclusion proofs verified on chain by
`contracts/EpochAnchor.sol`. The node **prepares** anchor calldata and never
holds a key — the operator broadcasts with their own.

## Honest zeroes, build 2

- The liteforge RPC is unreachable from the sandbox this was built in, so the
  live beacon and registry paths are written but unexercised. Offline nodes
  report `local`, failures report `local-fallback` with the error. Neither
  implies a chain read that did not happen.
- `soulManifestHash` uses sha256 here; the registry commits with keccak256.
  They must be made to agree before deploy.
- Three of the four title repos are private, so Pickle Brawl, AFC and the
  Agent Fighter fallback are adapters written to the documented shape rather
  than against the real engines. Agent Fighter's real path is one import.
- Neither contract is deployed or audited.
- Credits reconcile against nothing. There is no reserve in this build.
- Annorak is not supported and is not pretending to be.
