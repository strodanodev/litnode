# SPEC — litnode + cabinet

> **Historical (17 Sep 2026).** This is the as-built spec of the v0.2 build. The
> current design and the state of every claim is `BUILD-SPEC.md` (v0.3, with the
> test behind each "built"); the chain-as-index settlement it describes replaced
> §2's local deltas on 21 Sep 2026. Kept for the record; not maintained.

As-built technical spec for what's in this repo: the litnode daemon
(`node/`, `protocol/`, `rulesets/`, `titles/`, `tools/`) and the LIT GAMES
cabinet frontend (`cabinet/`). This is ground truth for what exists today,
not a design proposal. `BUILD-SPEC.md` is the plan and names the test behind
every "built" claim; `docs/NODE-CABINET-SYNC.md` is the contract between the
two sides and what is still open between them.

## 1. System overview

```
 player (browser, ed25519 key in localStorage)
   |
   |  1. sign a queue entry, POST /queue          (cabinet: Find match)
   |  1b. GET /match, GET /snapshot, recompute placement, accept or refuse the host
   |  2. play a live match on the drawn host's relay (wsAddr; Agent Fighter's server)
   |  3. the relay's ledger reaches a node: POST /ledger (tools/af-watch.mjs today)
   v
 litnode  (node/litnode.js -- one process, node:http + WebCrypto, zero deps)
   |  gossip gossip gossip (2s heartbeat epochs) --+
   |  replay the ledger against the pinned         |
   |  ruleset build -> signed delta                v
   |  witness co-signs independently          other litnodes
   |  derive leaderboard/credits/stats from
   |  the settled delta set
   v
 cabinet  (cabinet/ -- static PWA, no build step; every node serves it at /)
   reads /health /peers /snapshot /leaderboard /stats /deltas
   reads litVM (NodeStake, TestLITVM) directly via eth_call
   shows: profile, rating chart, game library, leaderboards,
          characters/inventory (sample data), node uptime + mesh work
   FIND MATCH signs a queue entry, verifies the placement, launches the
   title against the drawn host's relay with the descriptor in cabinet:init
   PLAY opens each title in an iframe (agentfighter.wtf, picklebrawl.live,
   afc-pi-seven.vercel.app); a title that ignores cabinet:init plays
   off-mesh and its matches never reach a node
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
`Access-Control-Allow-Private-Network: true` (on the `OPTIONS` preflight too)
so an https cabinet can read a loopback node. `GET /` and the cabinet's own
files (`/app.js`, `/style.css`, `/sw.js`, `/covers/…`) are served from
`cabinet/` after every API route has been tried; `/protocol/*` serves the
node's own protocol modules.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | identity, roles, region, addr, `protocol`, epoch, peer count, `incompatible` count, ruleset build hashes, `refused` count, `bonded`, chain status, `sandbox` (limits, runs, kills), `trust` (policy, publishers, relay keys, courts), `registry`, `startedAt` + `uptimeMs` |
| GET | `/whoami?nonce=` | proof of possession: `{nodeId, nonce, addr, at, sig}` signed by the node key — what a directory reader checks before it treats a URL as this node |
| GET | `/snapshot[?envelopes=1]` | bonded, fresh, protocol-compatible peers + one resolved manifest per ruleset + root over the registry view; with `envelopes=1` also the signed heartbeats it was built from, so a client re-verifies and recomputes — **cabinet reads this** |
| GET | `/peers` | everyone heard from (bonded or not), with `fresh`, `clockSkewS`, `protocol`; plus `incompatible[]` (heard on another protocol version, excluded) |
| GET | `/titles` | every title this node or a fresh peer hosts, from gossiped manifests (`display`, `publisher`, hosts, bonded hosts) |
| GET | `/ruleset/:rulesetId[?build=]` | the ruleset source (current, or a specific held build by hash); headers `x-build-hash`, and `x-build-publisher` / `x-build-sig` when the build carries a publisher attestation |
| POST | `/gossip` | peer-to-peer heartbeat + queue + delta-advert exchange |
| POST | `/queue` | signed queue entry `{playerId, rulesetId, mode, bucket, tokenId?, region?}` |
| GET | `/match[?playerId=]` | frozen placement descriptors: computed once per match, sealed by the computing node, gossiped; a peer that drew differently is recorded in `disputes[]` rather than flipping the host |
| POST | `/ledger` | submit a finished match (replayable ledger or attested report). Bound to the mesh's placement descriptor; ranked requires it, a finished log, and player signatures or an authenticated relay. Returns the signed delta with `resultHash`, `verification`, `official` |
| GET | `/ledger/:matchId` | the raw submission a delta was settled from, plus the placement `descriptor` envelope |
| GET | `/delta/:matchId` | one settled delta, decorated with `verification` (verified / disputed / unverified) and `official` |
| GET | `/deltas[?ruleset=&scope=official]` | every settled delta (labelled), or official only — **cabinet reads this** |
| POST | `/cosign` | witness co-signature over `{matchId, resultHash}` — the whole result, not one hash inside it |
| POST | `/dispute` | a witness that recomputed a different result files it, signed; the delta is `disputed` until agreement outnumbers disputes |
| GET | `/leaderboard?ruleset=[&scope=all]` | Elo ladder over OFFICIAL results by default (ranked, placed, verified, undisputed); `scope=all` folds every settled delta — **cabinet reads this** |
| GET | `/credits?ruleset=[&currency=&player=&scope=]` | derived credit balances |
| GET | `/stats?ruleset=[&player=&scope=]` | matches/wins/ticks per player — **cabinet reads this** |
| GET | `/epoch[?epoch=]` | the hour's batch: `open` (live) or `finalized` (frozen 15 min after the hour), leaves with `verified` and cosigners-at-freeze, root, EpochAnchor v2 `propose` calldata |
| GET | `/proof/:matchId` | inclusion proof for one match with `status` (finalized / open), `verified`, `cosignersAtFreeze` vs `cosignersNow` — inclusion and verification are distinct claims |
| GET/POST | `/update` | release status; POST (loopback only) applies, or `{rollback:true}` restores `.previous/` |

**Title code never runs in the node process.** `node/sandbox.js` runs every
replay, manifest read and report validation in a separate `node --permission`
process with an empty environment, a heap ceiling (`SANDBOX_MEMORY_MB`) and a
deadline (`SANDBOX_TIMEOUT_MS`); inside it a V8 context with ECMAScript
intrinsics only (no `Date`, `Intl`, `Math.random`, `process`, `fetch`,
`require`; code generation from strings off; JSON-only data transfer).
A title that spins is killed at the deadline; one that allocates without
bound aborts; neither touches the daemon. A V8 escape is out of scope, which
is why peer builds load only with a publisher attestation under the default
`TITLE_TRUST=trusted`.

**Settlement binds to the placement.** `POST /ledger` for a ranked match must
name a `matchId` the mesh placed (the sealed descriptor: participants,
ruleset, build, mode, host, beacon and its block, protocol version); the seed
is `H(beacon, matchId)`; this node must be the descriptor's host. Unplaced
casual submissions settle labelled `placed:false` and are never official.
`resultHash` (`protocol/result.js`) commits to every field a ranking or a
settlement consumes; a witness recomputes all of them — descriptor binding,
its own registry reads at the pinned block, its own sandboxed replay, player
or relay signatures — and signs `{matchId, resultHash}` only when its
commitment is byte-identical, else it files a signed dispute.

**Provenance labels** on a delta's `attestation`: `players` (both keys signed
the chain head over the build and hydration; re-verified by every witness),
`relay` (a relay key in the host's `RELAY_KEYS`, advertised in its heartbeat,
signed the log head; its `expected` record matched the replay), `host` (only
this node's word; casual only), `attested` (an authorized court — the title
manifest's `attestors` or the node's `COURTS` — signed the report). Official
standings take `players` / `attested` results that are ranked, placed,
witnessed by at least one independent node and not disputed.

**litnode does not implement netcode, and does not need to.** The `relay`
role is the title's own match server, advertised by the node that fronts it
(`WS_ADDR` → `wsAddr` in its heartbeat): Agent Fighter's WebSocket relay with
its first-write-wins ledger is that role today. Placement draws a host; the
cabinet launches the title against that host's `wsAddr`; the finished ledger
comes back to a node with a settling role (`host`, `settler` or `relay`) over
`POST /ledger` — via `tools/af-watch.mjs` polling the studio database until
the relay posts directly. The decision not to port the relay into the node
is recorded in `BUILD-SPEC.md` §17; peer-to-peer WebRTC with nodes as
signalling is the V1 target (roadmap item 3).

### 2.2 Ruleset title interface (`rulesets/*.v1.js`)

A ruleset is a single bundled ESM file with no imports; `buildHash =
H('ruleset', source bytes)`. It is admitted only after `sdk/conformance.mjs`:
a STATIC stage (executes nothing — artifact shape and a purity lint) and a
SANDBOX stage (manifest, contract functions, two replays from scratch to the
same root, `view()`; attested titles: `validate({})` rejects). A build from a
peer also needs `sig = sign('build', {rulesetId, buildHash}, publisherKey)`
under a key in `TRUSTED_PUBLISHERS` (`tools/sign-build.mjs`; default: the
litVM release key) unless `TITLE_TRUST=open`. Two shapes:

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
envelopes; refuses to run outside a secure context and says why), `keccak.js`
(selectors, for staking calls), `staking.js` (NodeStake read helpers),
`pairing.js`, `placement.js`, `beacon.js`, `log.js` (hash-chained ledger),
`epoch.js` (Merkle tree), `derive.js` (Elo/credits/stats fold; `applyDelta`
is the exported per-delta step the cabinet walks for its rating chart),
`erc6699.js` / `hydration.js` / `registry.js` (character hydration: the
proposed ERC-6699 shape, and block-pinned reads of ERC6699Registry v2 with
the owner/controller check `mayPlay`), `snapshot.js`, `result.js` (the result
commitment and the verified / disputed / unverified policy), `challenge.js`
(proof of possession), `version.js` (`PROTOCOL_VERSION`, carried in every
heartbeat and descriptor; peers on another version are excluded).

`cabinet/protocol/` is a **generated** copy of the eight modules the cabinet
runs (`npm run vendor:cabinet`), pinned by sha256 in
`cabinet/protocol/MANIFEST.json`; `demo/cabinet.test.mjs` fails on drift.

### 2.4 Chain (litVM LiteForge testnet, chainId 4441)

RPC `https://liteforge.rpc.caldera.xyz/http`, CORS `*`. Contracts in
`contracts/deployed.testnet.json`: `NodeStake` (bond/standing), `TestLITVM`
(the test token), `ERC6699Registry`, `EpochAnchor`, `PlayerProfile`,
`NodeBadge`, `NodeDirectory`. The node only ever reads (standings, profiles,
directory, and — with `ERC6699` set — characters at a pinned block); the only
chain key a node holds is the delegated announcer for NodeDirectory.

**Deployed: the v2 set, 19 Sep 2026** (`contracts/deployed.testnet.json`),
from a wallet whose key has never left the operator's machine:
`EpochAnchor` v2 (propose by bonded operators only, finalized at a quorum of
2 distinct operators), `ERC6699Registry` v2 (minter/progressor roles, stats
nonce, config hash, item ownership on equip), `NodeStake` with
`transferOperator`, and fresh `NodeDirectory`, `NodeBadge`, `PlayerProfile`,
`TestLITVM`. The 12–17 Sep v1 set is archived beside it and nothing reads
it. `npm run authority` (block 52410944): the exposed deployer address holds
nothing on the live set. Still to do on this set: bond the laptop keys, name
a minter and a progressor, and set `ERC6699` on nodes so ranked hydration
reads the registry (no character has been forged yet). Record:
`contracts/MIGRATION.md`.

"ERC-6699" here is this project's PROPOSED interface (whitepaper Article
VI). No such number appears in the official ERC index at the time of
writing; nothing in this repo should be read as an adopted standard.

## 3. Cabinet (`cabinet/`)

Static site, zero dependencies, zero build step. Every node serves it at
`/`; `node cabinet/serve.mjs` serves it alone (→ `http://127.0.0.1:5180/`);
and the folder deploys as-is to any static host — currently Vercel at
https://arcade.litvm.games. Origin is not authorization
(BUILD-SPEC §12): the same page from any of those origins holds the same
kind of key and gets the same answers from a node.

### 3.1 Files

| File | Role |
|---|---|
| `config.js` | `NODE_URL` default, the `GAMES` roster, `CHAIN` addresses — the file to edit for content changes |
| `client.js` | the isomorphic client: player key under `litnode.player`, signed queue entries, `/match` polling, `verifyPlacement` (recompute from a snapshot the page can hash; refuse any other host); the same file drives `demo/client.test.mjs` |
| `roster.js` | Agent Fighter fighter/item/pet reference data + `INVENTORY_SAMPLE` (placeholder until account sync) |
| `app.js` | router (`#/`, `#/games`, `#/game/:id`, `#/leaderboards`, `#/characters`, `#/inventory`, `#/node`), node polling, derived profile (level/XP, rating curve via `applyDelta`), the Find-match panel, play overlay |
| `chain.js` | read-only litVM: `NodeStake.standingOf`, `TestLITVM.balanceOf` |
| `uptime.js` | client-observed node uptime (localStorage, 10-min slots, 7-day window) + ring/strip/heatmap renderers |
| `avatar.js` | identicon from the player's public key; photo upload resize |
| `bg.js` | procedural sky + wireframe backdrop (swap in `bg.jpg` for real key art) |
| `sdk-client.js` | the postMessage SDK a game imports (see 3.3) |
| `protocol/` | generated copies of eight protocol modules + `MANIFEST.json` — `npm run vendor:cabinet`; never edited by hand |
| `sw.js` | service worker, network-first, never caches API responses |
| `serve.mjs` | dependency-free dev static server |

### 3.2 What's real vs. placeholder

| Real (from the node) | Placeholder (until account sync) |
|---|---|
| Node online/offline, peers, epoch | Which fighters are unlocked / equipped |
| Leaderboard, per-player stats | Items, pets, tickets (`roster.js INVENTORY_SAMPLE`, tagged "sample" in the UI) |
| Match history + rating curve (`/deltas` walked with `protocol/derive.js applyDelta`) | — |
| Bond amount, operator wallet balance (litVM, read-only) | — |
| Mesh work — matches settled as host, witness co-signatures — counted from deltas | — |
| Node process uptime (`/health.uptimeMs`) + client-observed uptime history (labelled as observed by this dashboard) | — |

There is no reward figure. There is no rewards contract, and a number
nothing can pay is a claim; the bond is a cost of misbehaviour, not a yield
(whitepaper §5.4, BUILD-SPEC §2.2).

### 3.3 Cabinet <-> game contract (postMessage, version 1)

```
shell -> game   { type:'cabinet:init', version:1,
                  player:{id, guest, name}, node:{url, online},
                  game:{id, title},
                  match?:{matchId, host, witness, wsAddr, beacon, participants} }
game -> shell   { type:'cabinet:hello' }              ask for init again
                { type:'cabinet:exit' }                back to the cabinet
```

`player.id` is the ed25519 public key under `litnode.player` — the exact
`playerId` a node sees in queue entries and settles ledgers against. `match`
is present only when the player queued through the cabinet and the cabinet
verified the drawn host against the placement rule; for Agent Fighter the
relay is also passed as `?ws=` on the iframe URL. **No title consumes
`match` yet** — that is roadmap sprint 1 (`docs/NODE-CABINET-SYNC.md` §2).

### 3.4 Roster (as of this version)

| Title | URL | On the mesh? | Playable in cabinet |
|---|---|---|---|
| Agent Fighter | `agentfighter.wtf` | `agent-fighter.v1` | Yes (iframe) |
| Pickle Brawl | `picklebrawl.live` | `pickle-brawl.v1` | Yes (iframe) |
| Robot Fighting Championship (AFC) | `afc-pi-seven.vercel.app` | not yet | Yes (iframe) |

None of the three games read or write litnode state today; PLAY only opens
the game's existing hosted build in an iframe.

## 4. Known gaps and honest zeroes

One list, kept here. BUILD-SPEC §16 has the reasoning behind each.

- **Agent Fighter joins the placed match under the placed key** (room +
  `?player=`, AF `b362c87`), and its ledgers settle under the mesh match
  id and the keys — but the client does not yet sign the chain head, so
  the attestation is `relay`, not `players` (SYNC §3.2 step 3). Not yet
  exercised live: AF must be redeployed first.
- **Relay matches settle `relay`, not `players`**, until the client signs
  the chain head. The witness path for player-signed ledgers is exercised
  in tests only.
- **The relay bridge is a laptop process.** `tools/af-watch.mjs` moves
  ledgers from the studio database to a node, now signing each with its
  relay key (`RELAY_KEYS` on the node); it should become the `relay` role's
  own intake. Its results are `relay`-attested — authenticated, not
  player-verified, and therefore not official until the AF client signs.
- **One gameplay relay, one operator.** A second independently operated
  relay, and a demonstration of play continuing with the publisher's relay
  and services down, have not been done. `tools/custody.mjs` and
  `demo/custody.test.mjs` cover records surviving a host shutdown; they do
  not cover gameplay.
- **No peer-to-peer transport.** Play goes through the title's relay; nodes
  place, verify and settle. WebRTC with nodes as signalling is roadmap item 3
  and the gate on retiring Railway.
- **AFC has no ruleset.** Roadmap item 2.
- **Pickle Brawl results are attested, not verified**, and no live court has
  reported yet.
- **No rewards, no economics.** Credits reconcile against nothing.
- **No publisher on chain.** Any bonded node may host any title; a publisher owns nothing, stakes nothing, grants nothing and has no seat in a dispute. Spec: docs/PUBLISHER-BONDS.md.
- **Delta gossip is by advertisement, not replication.** A host gone before
  a witness saw its delta leaves one signature; no obligatory custody.
- **Disagreement is recorded, not adjudicated.** A witness that recomputes a
  different result files a signed dispute; the delta is `disputed` and off
  the official ladder while disputes ≥ agreeing co-signatures. Nothing
  slashes anyone yet; the slasher key is the exposed deployer's.
- **Official standings need an independent witness.** A single-operator
  mesh produces no official result by construction.
- **The title sandbox is a process boundary, not a formal jail.** Permission
  model + scrubbed V8 context + JSON-only transfer + limits; a V8 bug is out
  of scope. Hence `TITLE_TRUST=trusted` by default: peer builds need a
  trusted publisher's signature. Permissionless title intake stays gated on
  a track record of the sandbox (and ideally Wasm with a pinned runtime).
- **The beacon is not secure against the sequencer**, by litVM's own docs.
- **Contracts are unaudited testnet code.** The v2 set is live and every
  authority on it is the rotated wallet (`npm run authority` → 0 holdings by
  the exposed key), but no third party has reviewed the Solidity.
- **Registry hydration reads nothing yet.** ERC6699Registry v2 is deployed
  but has no minter, no progressor and no characters, and nodes do not set
  `ERC6699` until it does; until then every hydration is labelled
  `fixture`/`external` and a ranked result is verified only in the sense
  "both nodes replayed the same claimed characters".
- **Discovery is on chain** (`NodeDirectory`, deployed 17 Sep). Readers now
  check proof of possession (`/whoami`) before treating a URL as the node it
  claims. The bonded set a browser folds into placement is still the node's
  read of NodeStake (`stakesFrom: 'node'`).
- **Player identity is a browser key**, bindable to a wallet-owned
  `PlayerProfile` (deployed; no registrations yet).
- **A hosted cabinet cannot read a LAN node** (`https` → `http://192.168…`
  is blocked mixed content); loopback works with Chrome's one-time prompt.
  Production reaches a public https seed.
- **Clock skew is real.** A node more than ~4 s behind is stale to everyone;
  `/peers` shows each peer's skew.
