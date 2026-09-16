# SPEC — litnode + cabinet

As-built technical spec for what's in this repo: the litnode settlement
daemon (`node/`, `protocol/`, `rulesets/`, `tools/`) and the LIT GAMES
arcade cabinet frontend (`cabinet/`). This is ground truth for what exists
today, not a design proposal — see `docs/NODE-CABINET-SYNC.md` for the gap
list and what the node side still needs to build.

## 1. System overview

```
 player (browser, ed25519 key in localStorage)
   |
   |  1. sign a queue entry, POST /queue          (not yet wired from any game)
   |  2. play a live match                        (transport: none in litnode -- external)
   |  3. sign the finished input ledger, POST /ledger
   v
 litnode  (node/litnode.js -- one process, node:http + WebCrypto, zero deps)
   |  gossip gossip gossip (2s heartbeat epochs) --+
   |  replay the ledger against the pinned         |
   |  ruleset build -> signed delta                v
   |  witness co-signs independently          other litnodes
   |  derive leaderboard/credits/stats from
   |  the settled delta set
   v
 cabinet  (cabinet/ -- static PWA, no build step)
   reads /health /peers /leaderboard /stats /deltas
   reads litVM (NodeStake, TestLITVM) directly via eth_call
   shows: profile, rating chart, game library, leaderboards,
          characters/inventory (sample data), node uptime + reward projection
   PLAY opens each title in an iframe (agentfighter.wtf, picklebrawl.live,
   afc-pi-seven.vercel.app) -- games are NOT wired to litnode yet
```

## 2. litnode

One process = one node. `node node/cli.mjs`, configured via env vars
(`OPERATOR`, `PORT`, `SEEDS`, `ROLES`, `RULESETS`, `RPC`, `OFFLINE`, ...),
data under `DATA_DIR` (default `./data/<operator>/`): `identity.json`
(ed25519 keypair — the private key IS the node's credential, never commit
it), `rulesets/*.mjs` (cached ruleset builds by hash), `ledgers/*.json`,
`deltas/*.json`.

### 2.1 HTTP API (`node/litnode.js`)

All responses `application/json`, CORS `Access-Control-Allow-Origin: *` and
(as of this repo) `Access-Control-Allow-Private-Network: true` so an https
cabinet can read a loopback node.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | identity, roles, region, addr, epoch, peer count, ruleset build hashes, `bonded`, chain status, `startedAt` + `uptimeMs` (process uptime) |
| GET | `/snapshot` | full bonded/fresh peer set + resolved manifests + snapshot root |
| GET | `/peers` | everyone heard from (bonded or not), with `fresh` and `clockSkewS` — used to onboard a new machine |
| GET | `/ruleset/:rulesetId[?build=]` | the ruleset source (current, or a specific held build by hash) |
| POST | `/gossip` | peer-to-peer heartbeat + queue + delta-advert exchange |
| POST | `/queue` | signed queue entry `{playerId, rulesetId, mode, bucket, tokenId?, region?}` |
| GET | `/match[?playerId=]` | deterministic pairs for closed buckets, with placement (host/witness/order) |
| POST | `/ledger` | submit a finished match (replayable ledger or attested report) → settles, returns the signed delta |
| GET | `/ledger/:matchId` | the raw submission a delta was settled from |
| GET | `/delta/:matchId` | one settled delta |
| GET | `/deltas[?ruleset=]` | every settled delta, optionally filtered — **cabinet reads this** |
| POST | `/cosign` | witness co-signature on a delta |
| GET | `/leaderboard?ruleset=` | Elo-derived leaderboard — **cabinet reads this** |
| GET | `/credits?ruleset=[&currency=&player=]` | derived credit balances |
| GET | `/stats?ruleset=[&player=]` | matches/wins/ticks per player — **cabinet reads this** |
| GET | `/epoch[?epoch=]` | hourly Merkle tree over settled deltas + `anchorEpoch` calldata |
| GET | `/proof/:matchId` | inclusion proof for one match in its epoch tree |

**litnode does not host live matches.** There is no WebSocket, no input
relay, no game loop. `roles: ['host', ...]` means *settlement* host — the
node that replays the ledger and produces the delta, not a game server.
Live transport is external (today: each game's own hosting).

### 2.2 Ruleset title interface (`rulesets/*.v1.js`)

A ruleset is a single bundled ESM file with no imports; `buildHash =
sha256(source bytes)`. Two shapes:

- **`defineTitle({...})`** (replayable) — `init(seed, participants, ctx)`,
  `step(state, inputs)`, `done(state)`, `serialize(state)`, `view(state)`,
  `scores(state)`. The node replays tick-by-tick from a signed, hash-chained
  input log and compares the resulting state root.
- **`defineAttestedTitle({...})`** (attested) — `validate(report)`,
  `scores(report, participants, teams)`. No replay; the node checks an
  attestor's signature over the report and the rules, nothing more.

Currently bundled: `agent-fighter.v1` (replayable, `af-core-8` engine),
`pickle-brawl.v1` (attested).

### 2.3 Protocol layer (`protocol/`)

Dependency-free, browser-safe (WebCrypto + `TextEncoder` only) — the exact
reason `cabinet/protocol/` can vendor four of these files and run identical
signing/verification client-side:

`canonical.js` (stable JSON + sha256), `keys.js` (ed25519 identity, sealed
envelopes), `keccak.js` (selectors, for staking calls), `staking.js`
(NodeStake read helpers), `pairing.js`, `placement.js`, `beacon.js`,
`log.js` (hash-chained ledger), `epoch.js` (Merkle tree), `derive.js`
(Elo/credits/stats fold), `erc6699.js` / `hydration.js` (agent stat
hydration), `snapshot.js`.

### 2.4 Chain (litVM LiteForge testnet, chainId 4441)

RPC `https://liteforge.rpc.caldera.xyz/http`, CORS `*`. Contracts in
`contracts/deployed.testnet.json`: `NodeStake` (bond/standing), `TestLITVM`
(the test token), `ERC6699Registry`, `EpochAnchor` (hourly root anchor —
the node prepares calldata via `/epoch`; nothing sends the transaction
automatically). The node only ever reads; nothing here signs a chain tx
except `tools/bond-node.mjs`, run manually by the deployer.

## 3. Cabinet (`cabinet/`)

Static site, zero dependencies, zero build step. Serve locally with
`node cabinet/serve.mjs` (→ `http://127.0.0.1:5180/`) or deploy as-is to
any static host — currently Vercel at
https://lit-games-cabinet.vercel.app.

### 3.1 Files

| File | Role |
|---|---|
| `config.js` | `NODE_URL` default, the `GAMES` roster, `CHAIN` addresses, `REWARDS` rate card — the file to edit for content changes |
| `roster.js` | Agent Fighter fighter/item/pet reference data + `INVENTORY_SAMPLE` (placeholder until account sync) |
| `app.js` | router (`#/`, `#/games`, `#/game/:id`, `#/leaderboards`, `#/characters`, `#/inventory`, `#/node`), node polling, derived profile (level/XP, rating curve), play overlay |
| `chain.js` | read-only litVM: `NodeStake.standingOf`, `TestLITVM.balanceOf` |
| `uptime.js` | client-observed node uptime (localStorage, 10-min slots, 7-day window) + ring/strip/heatmap renderers |
| `avatar.js` | identicon from the player's public key; photo upload resize |
| `bg.js` | procedural sky + wireframe backdrop (swap in `bg.jpg` for real key art) |
| `sdk-client.js` | the postMessage SDK a game imports (see 3.3) |
| `protocol/` | vendored copies of `canonical.js` `keys.js` `keccak.js` `staking.js` from the node — **re-sync manually if the node's protocol changes** |
| `sw.js` | service worker, network-first, never caches API responses |
| `serve.mjs` | dependency-free dev static server |

### 3.2 What's real vs. placeholder

| Real (from the node) | Placeholder (until account sync) |
|---|---|
| Node online/offline, peers, epoch | Which fighters are unlocked / equipped |
| Leaderboard, per-player stats | Items, pets, tickets (`roster.js INVENTORY_SAMPLE`, tagged "sample" in the UI) |
| Match history + rating curve (Elo replayed client-side from `/deltas`, same fold as `protocol/derive.js`) | $litVM rewards (`config.js REWARDS` — **no rewards contract exists**; labelled "projected") |
| Bond amount, operator wallet balance (litVM, read-only) | — |
| Node process uptime (`/health.uptimeMs`) + client-observed uptime history | — |

### 3.3 Cabinet <-> game contract (postMessage, version 1)

```
shell -> game   { type:'cabinet:init', version:1,
                  player:{id, guest, name}, node:{url, online},
                  game:{id, title} }
game -> shell   { type:'cabinet:hello' }              ask for init again
                { type:'cabinet:exit' }                back to the cabinet
```

`player.id` is the ed25519 public key from `cabinet/protocol/keys.js` — the
exact `playerId` a node will see once a game signs and submits through it.
**No game currently sends or receives anything beyond this handshake.**
Queueing, ledger submission, and settlement are not wired — see
`docs/NODE-CABINET-SYNC.md`.

### 3.4 Roster (as of this version)

| Title | URL | On the mesh? | Playable in cabinet |
|---|---|---|---|
| Agent Fighter | `agentfighter.wtf` | `agent-fighter.v1` | Yes (iframe) |
| Pickle Brawl | `picklebrawl.live` | `pickle-brawl.v1` | Yes (iframe) |
| Robot Fighting Championship (AFC) | `afc-pi-seven.vercel.app` | not yet | Yes (iframe) |

None of the three games read or write litnode state today; PLAY only opens
the game's existing hosted build in an iframe.

## 4. Known gaps (see `docs/NODE-CABINET-SYNC.md` for detail)

- No game queues, plays, or settles through litnode — every match today is
  invisible to the mesh.
- No live-match transport in litnode (no WebSocket/host loop) — a `host`
  role only replays finished ledgers.
- No rewards contract; `$litVM` figures in the cabinet are a labelled
  projection.
- NAT: a witness *pulls* `/delta` + `/ledger` from the host's advertised
  address — a host behind a home router can't be witnessed without
  push-to-seed or UPnP.
- Ruleset execution is unsandboxed `import()` of mesh-delivered JS — fine
  for operator-run nodes today, not for strangers running nodes.
