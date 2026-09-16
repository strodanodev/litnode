# Node ↔ Cabinet sync report

**Audience:** the agent working in the original litnode project (the full
source repo, currently on a different machine at `E:\NPC\AGENT 24 NODE`,
with `BUILD-SPEC.md`, `tools/bundle-ruleset.mjs`, and the test suite this
portable build doesn't have). **Purpose:** this cabinet frontend
(`strodanodev/litnode`, `cabinet/`) is finished and deployed. This report
is the complete list of what the node backend needs to implement, and
exactly how the cabinet already expects to talk to it, so the two sides
converge without another round trip.

Read `SPEC.md` first for the as-built architecture. This file is the gap
list only.

- Frontend source: `https://github.com/strodanodev/litnode` (this repo),
  `cabinet/`
- Frontend live: `https://lit-games-cabinet.vercel.app`
- Node source referenced here: `node/litnode.js`, `node/settle.js`,
  `protocol/*.js` in this same repo (portable subset — the full BUILD-SPEC
  repo is authoritative if it disagrees with anything below)

---

## 1. What the cabinet already assumes about the node

These are load-bearing — changing them breaks the deployed frontend
without a cabinet redeploy:

1. **Base URL** is whatever the user has in `localStorage['cabinet.nodeUrl']`,
   defaulting to `config.js NODE_URL` (`http://127.0.0.1:7801` right now).
   **Action:** once a public seed exists, tell us its https URL so we can
   change the default — see §5.
2. **CORS**: every response needs `Access-Control-Allow-Origin: *`
   (already true). Since the cabinet is https and a local node is
   `http://127.0.0.1`, also send
   `Access-Control-Allow-Private-Network: true` (added in this repo,
   `node/litnode.js`) — needed for Chrome's Private Network Access check
   when an https page fetches a loopback origin.
3. **Endpoints polled every 5s, read-only, no auth**:
   `GET /health`, `GET /peers`, `GET /leaderboard?ruleset=<id>`,
   `GET /stats?ruleset=<id>`, `GET /deltas?ruleset=<id>`. Response shapes
   must stay backward compatible — the cabinet reads fields by name
   (`nodeId`, `operator`, `roles`, `peers`, `epoch`, `bonded`,
   `chain.offline`, `chain.head`, `chain.rpc`, `chain.lastError`,
   `startedAt`, `uptimeMs`, `rulesets{ruleset: buildHash}`, `buildsHeld`;
   `leaderboard[].{rank,player,rating}`; `stats{playerId: {matches, wins,
   ticks}}`; `deltas[].{matchId, rulesetId, buildHash, mode, participants,
   teams?, scores, ticks, hostId, cosigners, settledAt, epoch}`).
4. **Player identity**: an ed25519 keypair generated client-side with
   `cabinet/protocol/keys.js` (a vendored copy of `protocol/keys.js`),
   kept in the browser's `localStorage`. The public key is used verbatim
   as `playerId` everywhere the cabinet reads `/stats`, `/leaderboard`,
   `/deltas`. **Nothing server-side needs to allocate player ids** — a
   fresh browser generates its own and that's what shows up once it plays.
5. **Ruleset identifiers already in the cabinet** (`cabinet/config.js`):

   | title | `rulesetId` | `buildHash` |
   |---|---|---|
   | Agent Fighter | `agent-fighter.v1` | `859e7215418db6473f0ceb1a88a1f51dc279db1974636c2262f547fcafca76da` |
   | Pickle Brawl | `pickle-brawl.v1` | `db035b782d23e85d4dcfdab0b2364f9e4f1c828b3dd8b2217c25b62cf0e1cb2e` |
   | Robot Fighting Championship (AFC) | *(none yet)* | *(none yet)* |

   If a ruleset build changes, its `buildHash` changes — update
   `cabinet/config.js` to match whatever the node currently advertises in
   `/health.rulesets`, or the cabinet's "on the mesh" panel will show a
   stale hash (cosmetic only; it doesn't affect settlement, which always
   pins by hash independently).

## 2. What is NOT wired yet — the actual gap

**No game currently queues, plays, or settles through litnode.** PLAY in
the cabinet just opens the game's existing hosted build
(`agentfighter.wtf`, `picklebrawl.live`, `afc-pi-seven.vercel.app`) in an
iframe. The postMessage handshake (`cabinet/sdk-client.js`) only passes
`{player, node, game}` on load and lets the game ask to exit — nothing
about matches crosses that boundary today.

To close this, in priority order:

### 2.1 Agent Fighter → litnode (highest value — real game, real ruleset)

Agent Fighter's match server (Railway, see its own repo) needs to, per
finished match:

1. Build the entries array + `matchId` the way `protocol/log.js`
   (`chainHead`) expects: `{k: tick, inputs: [frameA, frameB]}`, `k`
   exactly `0..n-1`.
2. Have both players sign the ledger body
   (`protocol/log.js ledgerBody` + `LEDGER_TAG`) with their session keys —
   **or** fall back to `expected: {hash, endTick}` from its own replay,
   which settles as `attestation: 'relay'` instead of `'players'`.
3. `POST /ledger` to a bonded node with
   `{matchId, rulesetId: 'agent-fighter.v1', buildHash, mode, participants,
   entries, signatures?, expected?}`.
4. The manual bridge for this already exists and works today:
   `npm run import:af -- <matchId> --post http://127.0.0.1:7801` (see this
   repo's top-level README). **The task is to call the equivalent of that
   importer automatically at match end**, not to invent new protocol.

Acceptance: after a real Agent Fighter match, `GET /deltas?ruleset=agent-fighter.v1`
on a bonded node includes it, and the cabinet's leaderboard/stats/rating
chart pick it up on the next poll with no cabinet changes.

### 2.2 Pickle Brawl → litnode (attested, no replay needed)

Pickle Brawl already has a documented attested path
(`LITNODE_URL` / `COURT_IDENTITY` env vars on the court process, see
top-level README's "Pickle Brawl (attested)" section) for *physical*
matches. The *online* Pickle Brawl at `picklebrawl.live` is a different
surface (Managers Cup, single/open play) and has no settlement path yet —
decide whether online matches should also submit attested reports (one
signed report from the server, no replay) or become a `defineTitle`
replayable ruleset like Agent Fighter. Attested is far less work if the
online match state is already server-authoritative.

### 2.3 AFC (Robot Fighting Championship) → litnode

No ruleset exists on the mesh for AFC at all. Its own site describes it as
"deterministic, verifiable robot fighting — every match re-simulates to
the same hash," which is exactly the `defineTitle` shape
(`init/step/done/serialize/view/scores`) — this should be the easiest of
the three to onboard *if* AFC's sim can be extracted into a single
dependency-free ESM bundle the way `rulesets/agent-fighter.v1.js` was
(see `tools/bundle-ruleset.mjs` in the full BUILD-SPEC repo). Until then,
`cabinet/config.js` has no `rulesetId` for it and its detail page correctly
shows "not on the mesh yet."

### 2.4 Live match transport — the structural gap

litnode has **no WebSocket, no input relay, no game loop** — see
`SPEC.md §2.1`. All three games currently host their own live matches
elsewhere (Railway for Agent Fighter, each game's own backend for the
others). Wiring §2.1–2.3 above does **not** require litnode to host live
play — only to receive the *finished* ledger/report. If "sync backend with
frontend" is meant to include litnode itself hosting live matches
(WebSocket relay, matchmaking via `/queue` + `/match`), that is a much
larger build — port the relay/ledger/pace-check logic out of Agent
Fighter's `packages/server/src/server.ts` into a new `node/host.js`. Flag
this back to the user before starting it; it wasn't asked for by name in
this handoff, only inferred as a possible reading of "sync the backend."

## 3. Cabinet SDK — how a game reports a match once wired

`cabinet/sdk-client.js` (game side) currently exposes only `onInit`,
`ready`-less handshake, and `exit`. To let a game report match results
back to the cabinet for **local** display (optimistic UI; the mesh is
still the source of truth once §2 lands), extend the contract in
`SPEC.md §3.3` with a new message, e.g.:

```
game -> shell   { type:'cabinet:score', score, label? }
```

This is a **cabinet-side change**, not a node change — noted here only so
the node-side agent knows not to invent its own version of it.

## 4. Rewards — do not build against `cabinet/config.js REWARDS` as if it were real

`cabinet/config.js REWARDS` (`perHourOnline`, `perSettled`, `perCosign`)
is a **cabinet-only display projection**. There is no rewards contract on
litVM and nothing accrues anywhere. If/when a rewards mechanism is
designed on the node/chain side, the cabinet should be pointed at the real
numbers (a new `/rewards?nodeId=` endpoint, or a contract read via
`chain.js`) — don't treat the current rate card as a spec to implement
against.

## 5. When a public seed node exists

Tell us (or update `cabinet/config.js NODE_URL` directly and redeploy):

- its https URL
- confirm it sends the two CORS headers in §1.2
- confirm `ROLES` includes `host,witness,settler` and it's bonded

The cabinet will then show real mesh data to every visitor by default
instead of only to someone running `127.0.0.1:7801` locally.

## 6. Known non-blocking issues to be aware of

- **NAT**: a witness *pulls* `/delta` + `/ledger` from the host's
  advertised `addr`. A host behind a home router can't be witnessed
  without push-to-seed or UPnP. Doesn't block §2.1–2.3 as long as the
  settling node itself has a public address (a seed does).
- **Ruleset sandboxing**: the node `import()`s ruleset JS with full
  process access. Fine while only you run nodes; revisit before
  encouraging strangers to run one.
- **AIR/Moca sign-in inside the cabinet's iframe** is blocked by each
  game's own `frame-ancestors` CSP (unrelated to litnode — front-end/auth
  issue only). Add `https://lit-games-cabinet.vercel.app` to the AIR
  partner allowlist to fix; not a node concern.
