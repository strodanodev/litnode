# Arcade Node — build spec

BUILD-SPEC v0.2 · 12 September 2026 · working document

Scope: the V1 Arcade — one open-source product that hosts our in-house titles
first and is composable for any title that enters the litVM ecosystem. Where
the litVM Games whitepaper describes an end state, this describes what is
built, what is specified, and what reports zero. Every "built" claim names
the test that exercises it; anything without a test is specified, not built.

Companion documents: the litVM Games whitepaper (litvm.games/whitepaper) is
the charter; the litVM chain docs (docs.litvm.com) fix the chain facts; the
client spec v0.6 is the longer-range architecture; this is the build.

---

## 0. Status, honestly

| Layer | State | Exercised by |
|---|---|---|
| Protocol (pure): hashing, keys, log, placement, pairing, beacon, snapshot, epoch tree, derived services, hydration check, staking reads | **Built** | `demo/protocol.test.mjs`, `demo/staking.test.mjs` |
| Agent Fighter adapter + single-file ruleset artifact | **Built** | `demo/af-adapter.test.mjs` |
| Contracts: ERC6699Registry, NodeStake, TestLITVM | **Deployed to Liteforge 12 Sep 2026, unaudited** — NodeStake `0x11C984bE3ee572eb7280334501B57c82001F397F`, TestLITVM `0x697aC520dFBe1B1830Bf22A77b54564F8ee21744`, ERC6699Registry `0x66cef65F9F3774989D5F4AFa1fF6a09541835145`; first node bonded 1 tLITVM | `tools/deploy-contracts.mjs`; node health reports `staking: chain`, `bonded: true` |
| Node daemon: identity on disk, signed gossip, bonded snapshot, fetch-by-hash, signed queue, pairing + placement over HTTP, chain beacon and NodeStake reads | **Built** | `demo/mesh.test.mjs` (three nodes, publisher dies, title survives) |
| Node daemon: ledger intake, witness replay and co-sign over gossip, derived ladder/credits/stats, hourly epoch tree, inclusion proofs, anchor calldata | **Built** | `demo/settle.test.mjs` |
| Attested titles: court-signed outcome reports validated against the rulebook, settled labelled `attested`, witness co-signs `attestation-only`; team-aware Elo, pot and stats | **Built** | `demo/attested.test.mjs` |
| Pickle Brawl adapter (attested, singles and doubles) and the court-side reporter in the Pickle Brawl repo | **Built, not yet exercised with a live court** | `titles/pickle-brawl.adapter.js`, `services/court/src/litnode-report.ts` (PB repo) |
| Portable node build for a second machine, plus a bond tool for its key | **Built** | `npm run pack` → `dist/litnode-portable-<date>.zip` |
| **Relay role, end to end** (13 Sep 2026): the desktop node advertises the Agent Fighter relay; the lobby paired a player in 3.5 s, drew the desktop as host and the Ally as witness, verified placement locally and launched the game against the relay; a match was played; `tools/af-watch.mjs` settled its ledger on the node within seconds of landing in the studio database; the Ally replayed and co-signed it; the ladder updated | **Done** | match `mmtyf9tz57bbb-3`, epoch 497013 |
| **Three-machine, two-operator mesh** (desktop + laptop bonded from the deployer wallet, ROG Ally bonded from a second wallet), one snapshot root on all three, two real matches co-signed by the Ally after it fetched the exact build by hash and replayed independently | **Done 13 Sep 2026** | live run; witness `9054aac9…` on both deltas |
| A real Agent Fighter relay match (`mmtyf9tz57bbb-1`, 7,599 ticks, played 12 Sep 2026 through the tunnel) imported from the studio database and settled on the bonded node, replay reaching the relay's own recorded state hash | **Done** | `tools/af-import-ledger.mjs` + `demo/settle.test.mjs` |
| EpochAnchor contract | **Deployed** at `0x09fBf6A5026b4E02eE9f78222117F97b19eE507A`; **first root anchored** 12 Sep 2026: epoch 497006, two matches, root `6726c997…16bfee`, tx `0x04c88732…25eab3` (block 50092761), `verifyInclusion` returned true on chain for `mmtyf9tz57bbb-1` | `tools/anchor-epoch.mjs` |
| Cabinet (`cabinet/`) — the one frontend: profile, ladders, history, node panel, and *Find match* through the isomorphic client (`cabinet/client.js`): identity in browser storage, signed queue entries, poll for a pair, recompute placement from the snapshot and refuse a host the rule did not produce, launch against the drawn host's relay. Served by every node at `/`, deployed at lit-games-cabinet.vercel.app. The cabinet's read contract with the node is asserted field by field | **Built** | `demo/client.test.mjs`, `demo/cabinet.test.mjs`; live pair from the former lobby page on the three-machine mesh 13 Sep 2026 (3.0 s, chain beacon, client and node agree, witness = Ally). Merged 17 Sep 2026 |
| Wallet-bound player profile (soulbound ERC-721, `ownerOfKey` read like `standingOf`), node badge NFT: contracts compile, node reads/refuses/folds by owner, cabinet signs in | **Built, undeployed** | `demo/profile.test.mjs`, `demo/cabinet.test.mjs`; `docs/WALLET-IDENTITY.md` build order step 4 |
| Peer-to-peer gameplay transport | Specified | — |
| SDK extraction, title template, conformance suite | Specified | — |

Production today: the Agent Fighter match server on Railway, its client on
Vercel, its database on Supabase. **Railway stays until the node mesh can carry
the backend persistently with minimal downtime** (§17 item 5). The laptop
tunnel (`npm run tunnel` in the Agent Fighter repo) is the development path.

### 0.1 What V1 is for

Three requirements, in order.

| | Requirement | V1 answer |
|---|---|---|
| R1 | A publisher runs a node and gets a backend: matches settled, ladders, credits, stats | Node settles; the title's existing relay hosts until P2P lands |
| R2 | Several nodes form a mesh behind statically deployed frontends | Signed gossip, no required seed, placement is a pure function |
| R3 | ERC-6699 characters and hourly epoch roots settled on litVM Liteforge | Manifest and tree built; contracts compiled; chain writes prepared by the node, broadcast by the operator |

Plus the constraint the product exists for: **peer-to-peer node infrastructure
is not optional.** Gameplay runs between players, nodes verify and settle, and
a node going dark costs latency to settlement, never a match.

**Non-goals for V1.** A reserve or token economics, TEE agent inference,
persistent worlds, on-chain registry writes from the node, Wasm rulesets,
obligatory replica sets. Each is a seam (§1.3) with a stated reference
behaviour.

---

## 1. Shape

### 1.1 One repo, four packages, one deployable

```
protocol/   pure, isomorphic, versioned by RFC — the thing everyone agrees on
node/       the daemon anyone runs: identity, gossip, verify, settle, serve
sdk/        defineTitle, defineBalance, services helpers, the ruleset bundler
arcade/     the static lobby: list titles, queue, launch, show ladders
titles/     in-house titles as the first contributions, not special cases
contracts/  ERC6699Registry, NodeStake, TestLITVM, EpochAnchor
demo/       the test suites; all must pass before anything is called shipped
```

### 1.2 Three planes

```
BROWSER · any origin, no backend of its own
  presentation, input sampling, placement recomputation, ledger signing
        │  HTTPS: snapshot, queue, match        WebRTC: inputs ↔ peer (V1 target)
        │                                       WSS: relay fallback via a node
        ▼
NODE PLANE · one daemon per operator, bonded on chain
  gossip · placement · signalling · relay fallback · witness replay · settlement
        │  eth_call: NodeStake, ERC6699Registry, beacon blocks
        │  anchorEpoch: one root per hour, broadcast by the operator's key
        ▼
litVM LITEFORGE · chain 4441 · zkLTC gas · Arbitrum Orbit

STUDIO PLANE · the title's own database, unchanged (Supabase for Agent Fighter)
```

The studio plane is never on the path from a cold browser to a settled match.

### 1.3 Seams — what "plug and play" means

Every seam is an interface, one reference implementation, and a conformance
test. A contributor replacing the reference runs the same test.

| Seam | Reference in V1 | Later |
|---|---|---|
| Gameplay transport | WebSocket relay through a node (Agent Fighter's) | WebRTC data channels, node as signalling + TURN fallback |
| Registry source | Signed heartbeat gossip + NodeStake reads | On-chain registry reads |
| Beacon source | First litVM block after the queue bucket closes | VRF / commit-reveal |
| Standing | NodeStake bond (§2.2) | Attestation record + bond |
| Ruleset runtime | Single-file ES module, hash-pinned | Wasm with pinned runtime |
| Artifact transfer | Fetch by hash from any peer | Deterministic replica sets |
| Studio store | memory / Supabase / Firebase drivers | anything with get/set/list |
| Settlement | Hourly epoch tree, operator broadcasts | same interface, more roots |

### 1.4 Roles

One daemon, one config. There is no "desktop node" or "client node" as a
separate program: every node runs the same code and its roles are set in
`node.env`. What differs in production is who runs it and why:

| Node | Bond | Roles | Where | Why |
|---|---|---|---|---|
| Operator (publisher) | own wallet | mesh, host, witness, settler | a desktop or VPS that stays up | seeds the mesh, keeps every ledger and build, settles and anchors |
| Volunteer / guild | own wallet | mesh, witness (+ host) | anyone's machine | verifies other operators' matches; hosts when drawn |
| Relay / court | via its operator | host | beside a game's own server | Agent Fighter relay, Pickle Brawl court |
| Player | none | — | the browser | not a node: signs queue entries and ledgers, reaches nodes over HTTPS/WSS |

Two builds ship from `npm run pack`: `litnode-portable` (any node) and
`litnode-operator` (the same daemon plus a no-prompt `node.env`, a Windows
scheduled-task installer, and the chain tooling). A witness must be bonded
from a different wallet than the host it witnesses.

Set in config, additive. A node may not witness a match it hosted or relayed.

| Role | What it does |
|---|---|
| `mesh` | Serves rulesets and deltas by hash, gossips, signals WebRTC, directory for browsers |
| `relay` | WebSocket fallback for players who cannot connect directly; holds the live ledger |
| `witness` | Verifies ledgers, re-hydrates from the registry, replays, co-signs |
| `settler` | Builds the hour's tree, prepares anchor calldata |
| `agent` | Not implemented. Reports zero. |

---

## 2. Identity and staking

### 2.1 Keys

Everything is an ed25519 keypair over WebCrypto (`protocol/keys.js`), so the
same file runs in a browser and a node. Signatures are bound to a purpose
tag; a queue signature can never be replayed as a heartbeat.

| Actor | Key | Persisted |
|---|---|---|
| Node | `nodeId` = public key, also the `bytes32` staked in NodeStake | `<dataDir>/identity.json` |
| Player | `playerId` = public key, registered against the AIR account | browser storage; AIR is authoritative for progression |
| Agent | ERC-6699 `tokenId`, controller address | on chain |

### 2.2 Staking LITVM to host a node — built, undeployed

To deploy or host a node an operator bonds LITVM (the `TestLITVM` mock on
Liteforge until the token exists there) in `contracts/NodeStake.sol` behind
the node's key. `standingOf(nodeKey)` returns the operator address, the bonded
amount and `active`.

What the bond does:

- **Eligibility.** A node whose key is not bonded at or above `minStake`, or
  is unbonding, is not eligible for placement. Nothing in its heartbeat can
  change that.
- **Operator identity.** The operator *is* the staking address. A witness
  "under a different operator" means a different staking address. Two keys
  bonded from one wallet cannot host and witness the same match — asserted in
  `demo/staking.test.mjs`.
- **Standing.** The bonded amount, in whole tokens, is the standing a manifest
  can set a floor against. This retires the self-asserted standing in v0.1.
- **Slashing.** A single testnet slasher (the attestation authority) can cut
  a bond for attested misbehaviour, with the evidence hash in the event. On
  mainnet this becomes the agent-and-operator consensus the whitepaper
  describes. Unbonding takes `unbondingPeriod`, during which slashes for work
  already done still land.

What the bond does **not** do: pay anyone. The whitepaper (§5.4) is explicit
that operators earn for serving, not for holding a token. The bond is a
cost of misbehaviour, not a yield.

Node-side: `protocol/staking.js` builds the `eth_call`, decodes the answer,
and `applyStakes` drops unbonded peers and **replaces** their operator and
standing with chain values before placement sees them.

**Testnet parameters** (`contracts/deploy.testnet.json`), set to the minimum
that proves the mechanism and nothing more: `minStake = 1 tLITVM`,
`unbondingPeriod = 60 s`, slasher and treasury = the deployer. One faucet pull
(1,000 tLITVM) funds a thousand bonds. These are demonstration values; raise
them before any operator outside the team bonds a node.

Open until deploy: who holds the testnet slasher key; the real LITVM address
on Liteforge.

---

## 3. Registry and snapshot

Signed heartbeats gossiped between peers (`protocol/snapshot.js`), overlaid
with NodeStake reads. A heartbeat whose signer is not its `nodeId` is
discarded. Epochs are 2 s; a peer is fresh while `epoch >= now - 2`.

`GET /snapshot` returns fresh, bonded peers plus one manifest per `rulesetId`:
the build held by the most nodes wins, ties break lexicographically, so a
single operator cannot fork a title by advertising alone. The snapshot has a
root; a browser computes placement from a snapshot it can hash.

---

## 4. Artifacts

A ruleset is one ES module with no imports, pinned by
`buildHash = H('ruleset', source)`. For Agent Fighter, `tools/bundle-ruleset.mjs`
bundles `@af/core` and the adapter together, so the hash pins the engine and
the adapter as one thing; the manifest records the engine version and commit.

A node that sees a peer advertising a `buildHash` it lacks fetches the source,
refuses it unless the bytes hash to the pinned value, caches it, and loads it.

**Limits.** Custody is opportunistic; no replica set, no proof of custody. The
runtime is an ES module import — fine among bonded operators, not fine when
registration is permissionless; Wasm with a pinned runtime is the answer.

---

## 5. Placement, pairing, beacon — built

`protocol/placement.js` is a pure function of state everybody has and runs
unchanged in node and browser.

```
seed     = H(beacon, matchId)
eligible = bonded nodes with role, buildHashes[rulesetId] == manifest.buildHash,
           standing >= manifest.standingFloor
order    = sort(eligible, by H(seed ‖ nodeId))
order    = participants' regions first (stable), then publisher NODE KEYS first
           if manifest.hostPolicy.affinity == 'operator' (stable)
host     = order[0]
witness  = first in ranked order with role=witness under a different staking
           address and a different node key
```

- One node and fifty nodes are the same code path.
- Publisher affinity keys on node keys in the manifest, so claiming an
  operator string buys nothing. Affinity never removes the open fallback.
- Region-aware, so a reproducible draw is also a playable one.
- The client refuses a host the rule did not produce.

### 5.1 Pairing

Over the gossiped queue, closed buckets only (`bucket < now - 1`), one entry
per player per bucket, adjacent entries by `(bucket, playerId)` with matching
`rulesetId` and `mode`. `matchId = H('match', rulesetId, p1, p2, beacon)`.
Gossip order is irrelevant; a player cannot pair with a duplicate of itself.

### 5.2 Beacon

The beacon for bucket B is the hash of the first litVM block whose timestamp
is at or after B's end, chosen after every entry in B committed. Liteforge
produces blocks on demand, measured ~250 ms apart.

What litVM guarantees (docs, "EVM Differences"): `blockhash` is "NOT
cryptographically secure", `prevrandao` is the constant 1, `block.number` is
an approximate L1 number. So the honest claim: the beacon is unpredictable to
players and hosts, **not to the sequencer**. A VRF or commit-reveal is the
fix. Offline nodes substitute a labelled local string.

---

## 6. Match lifecycle and the ledger

```
QUEUE     Player signs {playerId, rulesetId, tokenId, mode, bucket, region}.
PAIR      Every node computes the same pairs once the bucket's beacon exists.
HYDRATE   Each side reads the ERC-6699 tokens, applies the title's balance
          mapping, builds the hydrationManifest (§8).
PLAY      V1 reference: both clients connect to the drawn relay node, which
          holds a first-write-wins ledger. V1 target: WebRTC peer to peer,
          both clients hold the ledger, the node only signals.
          Every tick is appended to a hash chain: H('tick', prev, {k, inputs}).
SIGN      At match end each player signs {matchId, ticks, head, buildHash,
          hydrationHash} once. A player who disagrees with the log does not
          sign; the delta settles as disputed.
DELTA     { matchId, rulesetId, buildHash, seed, participants, mode,
            hydrationManifest, ticks, head, signatures, finalStateRoot,
            scores, hostId, hostSig }
VERIFY    The witness: checks both signatures and walks the chain
          (protocol/log.js); rebuilds the hydration manifest from the
          registry and refuses a mismatch (protocol/hydration.js); replays
          in the pinned build; signs the root it reaches.
SETTLE    Derived services folded (§9); leaf added to the hour's tree (§11).
```

**Measured, not asserted** (`demo/af-adapter.test.mjs`, af-core-8):

| | |
|---|---|
| Replay a full best-of-three from its log | 3 ms |
| Verify one ed25519 signature per tick, both players | 930 ms |
| Verify one signature per player over the chain | 33 ms |

Per-tick signatures are withdrawn; the chain plus two signatures is the
design. A host or relay that edits, delays or drops one tick changes the
head both players sign.

**Disconnects.** With a relay, the relay's ledger is the record and the
absent side forfeits after grace. Peer to peer with no referee, a mid-match
disconnect settles as **no-contest**. Ranked with stakes uses the relay until
a third party can attest liveness.

---

## 7. The title contract — two kinds

`titles/title.js`. Integrating the second in-house title showed that "a
title" means two different things, and the contract now says so.

**Replayable** (`defineTitle`): a deterministic `step(state, inputs)` the
node re-runs from a signed input log. A witness reproduces the result itself.

```js
defineTitle({
  rulesetId, tickRate, maxTicks, participants, inputSchema, hiddenInfo,
  modes, balance, hostPolicy, standingFloor, exclusive,
  services: { leaderboard, credits, stats },
  init(seed, participants, ctx), step(state, inputs), done(state),
  serialize(state), view(state), scores(state),
})
```

**Attested** (`defineAttestedTitle`): a simulation the node cannot reproduce
— floating-point physics, a proprietary engine, no input log. The title's own
attested host signs an outcome report; the node validates it against the
rules it can check, settles it, and the delta says `attestation: 'attested'`,
`verifiable: false`. A witness co-signs `attestation-only`: it checked the
signature and the rulebook, not the play.

```js
defineAttestedTitle({
  rulesetId, participants: [2, 4], teams: 2, modes, services, equipment: 'studio',
  validate(report) → null | reason,
  scores(report, participants, teams) → { playerId: score },
})
```

Placement, derived services and epoch settlement are identical for both.
Derivation is team-aware (`protocol/derive.js`, version 2): Elo between
team-average ratings applied to every member, the pot to every member of the
winning team, a draw split.

### 7.1 Universality — designed, proven for two titles of two kinds

The universality suite's first leg is green in substance: one contract hosts
Agent Fighter (replayable, 2 participants, bitfield inputs) and Pickle Brawl
(attested, 2 or 4 participants in two teams). What remains: a second
*replayable* engine, and one ERC-6699 token read by both titles.

### 7.2 Titles in this build

| Title | Kind | State |
|---|---|---|
| Agent Fighter | replayable | Real engine (`@af/core` af-core-8), bundled, tested, two real matches settled and anchored. `exclusive`: one match per worker. |
| Pickle Brawl | attested | Real project (Genesys engine, three.js ballistics, dedicated court per match). The court signs a report at GameEnd (`services/court/src/litnode-report.ts`, env `LITNODE_URL` + `COURT_IDENTITY`); the node validates to-11/win-by-2/seat-count and settles singles and doubles. Not replayable today: no input ledger, unseeded randomness, float physics. Path to replayable stated in the adapter. Paddles and cosmetics stay studio-side. |
| AFC | — | Adapter to a documented shape, not a real engine. |
| Annorak | — | Not adapted, on purpose (`titles/annorak.NOTES.md`). |

---

## 8. ERC-6699 integration

Article VI of the whitepaper, "not final". The interface in
`contracts/ERC6699Registry.sol` matches it verbatim. What the node does, and
what it recommends the standard add.

**As built.** Core stats `uint16` in `[0, 65535]`; titles declare a mapping
and never read raw. `soulManifestHash = keccak256(SOUL.MD)` (`protocol/keccak.js`;
the v0.1 sha256 mismatch is closed). Slot ids are `keccak256(name)`.

**Hydration manifest** (built at match start, carried in the delta, rebuilt
by the witness): `{ mode, balanceVersion, sterile, entries: [{ tokenId, stats,
statsNonce, soulManifestHash, characterConfigURI, characterConfigHash,
equipped }], manifestHash }`. Ranked sets `sterile` and strips `equipped`
mechanically; ranked and casual hydrations of the same agents hash differently.

**Ranked fairness, decided.** Ranked installs the stat line inside a bounded
band (Agent Fighter: the engine's per-mille auras, max +8% per line) and
strips equipment, drinks and pets. Casual adds them. A mapping is only as
fair as its range; the whitepaper's illustrative 1,800–12,000 health example
is a 6.7× spread and should not be the SDK default.

**Recommended additions to the standard**, in order of what settlement needs:

1. `bytes32 characterConfigHash` in `AgentManifest` — §6.3 promises it, the
   struct lacks it; without it a hydration cannot be verified once the URI's
   content moves.
2. `uint64 statsNonce` bumped on every stat write, so a witness compares
   nonces instead of needing archive reads; and a stated write path for
   stats/level/xp (today nothing can write after `forge`).
3. `attest(tokenId, bytes32 registryEntry)` — the `Attested` event has no
   emitter; define `registryEntry` as the keccak of the AIR identity.
4. Inherit ERC-721 explicitly; §3.6 transfer lockouts need transfer hooks.
5. `status(tokenId) → (active, expiresAt)` — stasis (§3.2, §3.6) decides
   ranked eligibility and has no interface surface.
6. An item-side interface returning bounded per-mille modifiers with a
   duration, so equipment means the same thing in every title.
7. Progression scoped per title under the token; core stats move only via
   the attested settlement path with rate limits.

**Reference-implementation note.** Agent Fighter has no core stats today; its
analogs are per-mille auras and drink effects. The reference covers equipment
semantics and bundle hashing, not stats, until the engine reads all four.

---

## 9. Derived services and universal leaderboards

`protocol/derive.js`: leaderboard, credits and stats are a **pure fold over
the sorted delta set** (by epoch hour, then matchId), idempotent by matchId,
so two nodes holding the same deltas produce the same digest. Ranked deltas
without a co-signer are skipped when asked, and reported.

**Per-title ladders are the truth.** Elo does not transfer between games. The
universal layer is the reputation ledger: co-signed ranked match counts,
distinct opponents, win rates by title, seasons aligned to epoch roots — no
merged rating. Eligibility is enforced in the fold: ranked only, co-signed
only, stasis excluded, distinct-opponent minimums, diminishing returns per
opponent. Player keys register against AIR identities, and the fold counts
identities, not keys.

Reads: `GET /leaderboard`, `/credits`, `/stats`, each carrying the derivation
version so a ladder is `(delta set, version) → tables`.

---

## 10. Studio plane

Unchanged from v0.1: `node/store.js` is `get/set/list` behind memory,
Supabase and Firebase drivers. Nothing the studio plane holds may sit on the
match critical path. Convention today; the SDK build step makes it an error
(§17).

---

## 11. Settlement — protocol built, contracts undeployed

`protocol/epoch.js`: `leaf = H('leaf', {matchId, rulesetId, buildHash,
finalStateRoot, hydrationHash, scores, hostId, cosigners[]})`; sha256 binary
tree over the sorted, deduplicated leaf set; inclusion paths; calldata for
`anchorEpoch(uint64,bytes32)` with selector `0xbc978154` (derived with keccak
and asserted by test; v0.1's `0x7e8a0a8b` was wrong).

The node prepares calldata and never holds a chain key. The operator
broadcasts with their own.

| | |
|---|---|
| Network | litVM LiteForge testnet (Arbitrum Orbit) |
| Chain ID | 4441 (confirmed by `eth_chainId`) |
| Native currency | zkLTC |
| RPC | `https://liteforge.rpc.caldera.xyz/http` · `wss://liteforge.rpc.caldera.xyz/ws` |
| Explorer | `https://liteforge.explorer.caldera.xyz` |
| Faucet | `https://liteforge.hub.caldera.xyz` |
| EVM | Shanghai; effective gas cap 32M; ~250 ms on-demand blocks |

---

## 12. Transport and peer-to-peer

The order of transports, and why:

1. **Relay through a node (V1 reference).** Agent Fighter's server already is
   this: WebSocket relay, first-write-wins ledger, resume tokens, forfeit
   ladder, adaptive input delay, rollback client. It runs as the `relay` role.
2. **WebRTC peer to peer (V1 target, roadmap item 3).** Data channel between
   the two browsers; nodes do signalling and act as TURN-equivalent fallback.
   Both players hold the ledger and sign it. Verification is asynchronous by
   whichever node is up. This is what makes the mesh able to carry
   production, and it is the gate on retiring Railway.

Costs stated: TURN relay is a real service and its egress is the one line
that is not free; P2P exposes player IPs unless relayed, which is why Agent
Fighter deferred it — TURN-always for ranked is the mitigation.

**Origin is not authorization.** Settlement binds to player keys, buildHash
and the placement proof, never to the origin, so any domain serves the
client and a community can rehost a dead publisher's frontend.

---

## 13. API reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/snapshot` | Bonded fresh peers, manifests, root |
| POST | `/gossip` | Merge heartbeats, queue, match descriptors, deltas |
| POST | `/queue` | Signed queue entry |
| GET | `/match?playerId=` | The pair a player belongs to, with placement |
| GET | `/ruleset/:rulesetId` | Ruleset source, verified by hash |
| POST | `/signal` | WebRTC offer/answer/candidates between the two players |
| WS | `/relay?matchId=` | Fallback relay |
| GET | `/ledger/:matchId` | Chained log + signatures |
| GET | `/delta/:matchId` | Delta and co-signatures |
| POST | `/cosign` | Witness signature |
| GET | `/leaderboard`, `/credits`, `/stats` | Derived tables + derivation version |
| GET | `/epoch?epoch=` | Leaf set, root, anchor calldata |
| GET | `/health` | Identity, bond status, peers, rulesets, chain |

---

## 14. Configuration

```toml
identity     = "<dataDir>/identity.json"   # generated on first run
roles        = ["mesh", "relay", "witness", "settler"]
region       = "ap-southeast"
port         = 7801
seeds        = []                           # empty is a valid mesh
rulesets     = ["./rulesets/agent-fighter.v1.js"]
rpc          = "https://liteforge.rpc.caldera.xyz/http"
node_stake   = "0x…"                        # NodeStake address; unset = unbonded dev mesh, reported
registry6699 = "0x…"                        # unset = fixtures, reported
```

```bash
npm test                          # protocol + staking + adapter suites
node tools/bundle-ruleset.mjs     # rebuild the Agent Fighter artifact
```

---

## 15. Verification

| Suite | Covers | Checks |
|---|---|---|
| `demo/protocol.test.mjs` | keccak vectors, selector derivation, keys and tags, chained log and two-signature settlement, placement eligibility/affinity/region, closed-bucket pairing, beacon selection, signed snapshot, epoch proofs, order-independent derivation, witness re-hydration | 13 |
| `demo/staking.test.mjs` | `standingOf` encoding and decoding, chain standing replacing self-asserted values, same-wallet witness exclusion | 3 |
| `demo/af-adapter.test.mjs` | Real engine through the adapter, artifact self-contained and hash-pinned, replay to same root, hydration changes root, ranked/casual manifests differ, cost measurements | 7 |
| `demo/settle.test.mjs` | Two nodes: a player-signed ledger settles on the host with attestation `players`; the witness under another operator fetches ledger and delta over gossip, replays independently and co-signs; ladder, stats and credits derive with a version; the hour's tree carries the leaf and its proof verifies; a tampered ledger is refused on signatures before replay; a host cannot co-sign itself; an unsigned ledger settles labelled `host`. Second test: every imported real relay ledger on the current engine reproduces the relay's recorded hash and end tick (`relay` attestation) | 2 |
| `demo/arcade.test.mjs` | Node serves the lobby and protocol modules (no path escape); player identity persists in storage; two clients queue at different nodes, are paired identically, and each recomputes placement and accepts the node's host; a descriptor naming another host is refused with "the rule did not produce" | 1 |
| `demo/attested.test.mjs` | Pickle Brawl rulebook validation (to 11, win by 2, seat count by mode, abandoned games); a court-signed doubles report settles `attested`/`verifiable: false`; the witness co-signs attestation-only over gossip; team Elo, pot and stats derive; refusals for a rulebook violation, a missing signature and a wrong key | 2 |
| `demo/mesh.test.mjs` | Three in-process nodes: gossip converges, snapshot roots agree, ruleset spreads by hash to operators never given it, tampered bytes refused, forged queue entry refused, players queued at different nodes paired identically with the same host and witness, publisher stops and ages out in ~6 s, the draw falls through and the title keeps taking matches | 1 (multi-assertion, ~14 s) |

**Universality suite (specified).** One token hydrated by two real titles
reaching two different, bounded readings; one delta set deriving two ladders
with matching digests on two nodes; one artifact contract hosting two real
engines. Green means the "universal" claims are true.

**Conformance suite for titles (specified).** Determinism, replay-to-same-root,
manifest completeness, bounded ranked mapping. A title that passes is listed.

---

## 16. Honest zeroes

- **Relay-match identity is the display name.** Imported Agent Fighter
  ledgers name players `af:<name>`; the first three settled deltas carried a
  side suffix, so one person appears twice on the ladder until those roll
  out of season. Player keys bound to AIR accounts replace names.
- **Relay matches settle with `relay` attestation, not `players`.** Agent
  Fighter players do not hold litnode keys yet, so an imported ledger is
  backed by the relay's recorded result matching our replay, and by the
  bonded settler's signature. Player-signed ledgers are exercised in tests
  only until the client signs them.
- **Delta gossip is by advertisement, not replication.** A witness fetches
  from the host's address; if the host is gone before a witness saw it, the
  delta has one signature. No obligatory custody yet.
- **The lobby places matches; it cannot yet play them.** A host advertises no
  relay (`wsAddr` is null) until the relay role runs on the mesh (roadmap
  item 3), and the page says so instead of launching. No P2P transport yet.
- **The lobby needs a secure context.** Browsers withhold WebCrypto over
  plain http from a network address, so `http://<lan-ip>/` can hold no player
  key. Localhost works; production reaches nodes over https. The page
  detects the case and says exactly that rather than failing silently.
- **Snapshot roots commit to the registry view, not to epochs**, so a client
  can tell "the node named a host the rule did not produce" from "the
  eligible set moved between the node's draw and my check".
- **Contracts are deployed but unaudited, with a single testnet slasher key
  held by the deployer wallet.** The deployer key was exposed during setup;
  it controls only testnet tokens and should be rotated before anything of
  value touches these contracts.
- **Contracts compile, are undeployed and unaudited.** NodeStake's slasher is
  a single testnet key. TestLITVM is a faucet mock, not the token.
- **Beacon is not secure against the sequencer.** By the chain's own docs.
- **Custody is opportunistic.** No replica set, no proof of custody.
- **Rulesets are ES modules, not sandboxed.** Bonded operators only.
- **One witness, no disagreement path.** Differing roots are logged.
- **No economics.** Credits reconcile against no reserve; nothing is paid.
- **No agent role.**
- **Peer-to-peer disconnects settle as no-contest.** No referee, no forfeit.
- **Pickle Brawl results are attested, not verified.** The node checks the
  court's signature and the rulebook; it cannot replay the match. A studio
  court that lies about a score is caught only by the players' own record,
  which is not collected yet.
- **The Pickle Brawl court hook is unexercised.** It compiles; no live court
  has reported to a node. The court loads `.dist/game.js`, which must be
  rebuilt through the Genesys build for the new `getAllClaims` accessor to
  exist at runtime; until then a report carries no seats and is refused.
- **Universality is proven for two titles of two kinds.** AFC remains an
  adapter to a documented shape; no second replayable engine yet.
- **Agent Fighter has no core stats.** The reference implementation covers
  equipment semantics and bundle hashing.
- **Clock skew is real, not theoretical.** The second real machine (a
  handheld) arrived 82 s behind and was silently stale to everyone else while
  seeing everyone itself. `/peers` now reports each peer's skew; the fix was
  a clock resync. On-chain registry reads retire the failure mode; a wider
  window would only hide it.
- **Networks are one-way more often than not.** The laptop and handheld could
  reach the desktop; the desktop could not reach them. Gossip therefore
  answers with everything it pushes, deltas included, so a peer behind NAT
  can still learn what to witness. A node that only pushes is a node nobody
  behind a router can witness for.
- **Placement is frozen at first computation, and nodes can disagree.** On
  the live mesh the same match drew a different host seconds apart because
  a peer was momentarily absent from the bonded set (one transient stake
  read). A node now computes a placement once, signs the descriptor, gossips
  it, and records a dispute when a bonded peer computed differently rather
  than flipping. The browser's own computation is the authority; a disputed
  match is visible as such. On-chain registry reads shrink the window; they
  do not remove the need to freeze.
- **Builds are never evicted.** A delta names the build it was settled in. A
  title update made two settled matches unverifiable until nodes kept every
  build by hash and witnesses fetched the named build from the host
  (`/ruleset/:id?build=`). Custody of old builds is part of settlement, not
  housekeeping.

---

## 17. Roadmap — V1 to open source

**Decision.** litnode is the placement, verification and settlement layer
around the titles' own gameplay; it does not re-implement netcode. Agent
Fighter's server becomes the `relay` role. Railway stays until item 3 lands.

**Consolidated 17 Sep 2026** after the cabinet (`strodanodev/litnode`)
shipped on the 12 Sep portable snapshot: the source tree is the git history,
the cabinet is the one frontend and every node serves it, the read contract
between them is a test, and the portable zips are packed from source. The
frontend track below runs beside the node track; week numbers are relative
to that consolidation.

0. **Consolidate — done 17 Sep 2026.** Git history, cabinet merged, arcade
   lobby folded into it, `demo/cabinet.test.mjs`, `tools/vendor-cabinet.mjs`,
   rewards projection removed, docs made to agree. Remaining: a public https
   seed as the cabinet's default `NODE_URL` (a tunnel in front of the
   desktop's 7801 with `PUBLIC_ADDR` set).
0c. **Standalone Windows build — done 17 Sep 2026.** `pack --runtime`
   vendors the checksum-verified official Node runtime; `allow-firewall.cmd`
   adds a program rule with one UAC click; `/health.inbound.reachable`
   replaces guessing. Deferred to item 4: a single signed `.exe` (Node SEA
   with a CJS bundle — spike needed for `import()` of rulesets from disk),
   an Inno Setup installer, and code signing (Azure Trusted Signing) —
   SmartScreen, not the firewall, is the barrier a stranger hits first.
1. **Node daemon — done 13 Sep 2026 on three machines.** Identity, gossip,
   snapshot, fetch-by-hash, NodeStake reads, ledger intake from the relay,
   witness verify across machines and operators, epoch tree, and the first
   root anchored on Liteforge with an inclusion proof verified on chain.
   Remaining from this item: the latency and reconnect numbers in §15, which
   need the gameplay path (item 3) to exist on the mesh first.
1b. **Play through the cabinet (weeks 1–2).** Close the gap between mesh
   placement and the relay's own matchmaking from both ends: Agent Fighter's
   client consumes `cabinet:init.match` and joins the drawn relay under the
   cabinet's player key; the relay (or `af-watch` as its intake) submits
   ledgers keyed by player keys, and the client signs the chain head so
   deltas settle `players`. Beside it, the wallet-bound profile
   (`docs/WALLET-IDENTITY.md`): one transaction, soulbound ERC-721, nodes
   read `ownerOfKey`, ladders fold by owner on request. Exit: a match
   started with *Find match* appears in that player's record, co-signed by
   another operator.
2. **Second in-house title (weeks 3–5).** AFC: its engine is deterministic
   and re-simulating, the `defineTitle` shape; bundle it. Pickle Brawl
   online as an attested report from its server. Manifest declares
   participants, input schema, hidden info. Universality suite green or the
   claim is reworded.
3. **Peer-to-peer gameplay (weeks 6–10).** WebRTC in `cabinet/client.js`,
   nodes as signalling (`POST /signal`) and TURN fallback, both players sign
   the ledger, asynchronous verification. Gate on retiring Railway.
4. **Open-source launch (weeks 11–14).** Apache-2.0 for protocol, node, SDK.
   The cabinet is the reference frontend; `sdk-client.js` + `client.js` are
   the SDK; AFC's bundling recipe is the title template. Conformance suite,
   one-command node install, protocol RFC process, honest zeroes (SPEC §4)
   as a release artifact.
5. **Retire Railway** when the mesh has carried production traffic through
   item 3 with measured downtime the team accepts.
6. On-chain registry reads · obligatory replica sets · Wasm rulesets · deploy
   and audit contracts after a cross-language keccak test · SDK availability
   guard · agent role, committed mode first.

**Rules that keep it composable.** Every seam is an interface, a reference
and a conformance test. The protocol package changes by RFC only, with a
version in every signed body. Titles are certified by suite, not review.
Every release ships its honest zeroes.
