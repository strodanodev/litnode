# Arcade Node — build spec

BUILD-SPEC v0.3 · 21 September 2026 · working document

Scope: the V1 Arcade — one open-source product that hosts our in-house titles
first and is composable for any title that enters the litVM ecosystem. Where
the litVM Games whitepaper describes an end state, this describes what is
built, what is specified, and what reports zero. Every "built" claim names
the test that exercises it; anything without a test is specified, not built.

Companion documents: the litVM Games whitepaper (litvm.games/whitepaper) is
the charter; the litVM chain docs (docs.litvm.com) fix the chain facts; the
client spec v0.6 is the longer-range architecture; this is the build.

**What changed in v0.3.** The 21 Sep 2026 capability audit (`audit/`) found
that the v0.2 settlement model does not survive its own targets: deltas were
*advertised* over gossip, never replicated, so every node's ladder was a fold
over the matches *it* hosted and the hosted cabinet showed whichever seed
answered; the gossip payload grew with every delta ever settled and hit the
4 MB body limit within hours at 10,000 players; every witness replayed every
match; and the keys that mattered — slasher, release, publisher, deployer —
were each one wallet. v0.3 replaces that model with **the chain as the
index** (§6, §11): every ranked match is committed, settled and attested on
litVM by transaction; ladders fold over finalized on-chain events, so any
node, or the cabinet from RPC alone, derives the same tables; and no single
key holds authority (§2.3). Node hosting is opened to anyone whose stake is
locked (§2.2). Sequencing is in §17.

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
| On-chain discovery: `NodeDirectory` (announce with a delegated announcer key; zero-dep EVM signer in `protocol/evm.js` proven against ethers), nodes bootstrap from chain, the hosted arcade reads through the freshest seed | **Built, undeployed** | `demo/evm.test.mjs`, `demo/directory.test.mjs` |
| Wallet-bound player profile (soulbound ERC-721, `ownerOfKey` read like `standingOf`), node badge NFT: contracts compile, node reads/refuses/folds by owner, cabinet signs in | **Built, undeployed** | `demo/profile.test.mjs`, `demo/cabinet.test.mjs`; `docs/WALLET-IDENTITY.md` build order step 4 |
| Peer-to-peer gameplay transport | Specified | — |
| SDK extraction, title template, conformance suite | Specified | — |
| **Settlement v1.0 — phase 1: no single key.** `NodeStake` v3 (locked term, witness eligibility age, delegated hot key, adjudicator contracts instead of a slasher wallet, `admin` meant for a multisig behind a timelock); `ReleaseRegistry` (a release is a build hash registered on chain and active only after a delay; the node refuses any other) | **Built, undeployed** | `demo/contracts.test.mjs` (compile + ABI), `demo/release-registry.test.mjs`, `demo/update.test.mjs` |
| **Titles as ERC-721s** (21 Sep 2026): `TitleRegistry` — one token per `rulesetId`, the holder is the publisher (EOA or multisig, hand-over = transfer, no admin); the holder registers build hashes (first active at once, retunes after a delay, revoke immediate); a node loads a peer's build when the chain says so instead of from a static `TRUSTED_PUBLISHERS` list; the arcade lists a title only while its holder runs a bonded host (`/titles.published`) | **Built, undeployed** | `demo/title-registry.test.mjs` (in-process EVM + a host, three witnesses and a hand-over), `docs/PUBLISHER-BONDS.md` |
| **Settlement v1.0 — phase 2: `MatchBook`.** The contract (`commit` → `settle` → `attest` ×3 → `finalize` → `escalate`/`resolve` with a nine-seat stake-weighted panel and slashing through NodeStake v3), `protocol/matchbook.js` (calldata, reads, event decoding, and the fold over the log into official / pending ladders in block order) | **Contract and protocol built and behaviour-tested on an in-process EVM, undeployed; node not yet sending** | `demo/matchbook-vm.test.mjs` (every branch executed: lock, top-up age, adjudicator-only slash, commit refusals, windows, happy path, liveness extension, escalation against and for the host with slashes accounted to the treasury, void on too few nodes, expiry, the two attacks), `demo/matchbook.test.mjs`, `demo/contracts.test.mjs` |
| **Phase 2, node side** (`node/matchbook.js`): the drawn host commits before play and settles from its delegated key; the three drawn seats read the log, fetch the ledger from the host, check its sha256 against the chain, replay and attest what they reached; the host finalizes, feeds an escalation with the ledger it keeps, resolves; `/leaderboard` folds the chain log (`source: chain`, `scope=official|pending`); gossip carries no delta advertisements; placed players leave the queue; `/match/:id/chain`; `/health.matchBook` | **Built, undeployed** — five litnodes bonded and delegated on the real contracts over an in-process RPC (`demo/lib/rpc-evm.mjs`) run the whole lifecycle | `demo/matchbook-node.test.mjs` |
| **EpochAnchor v3 + automatic proposal.** Delegate or operator proposes; support is bonded stake; a root finalizes at `quorumBps` of the active stake; the tree is over the hour's chain-finalized set (`protocol/matchbook.js chainEpoch`), so every node computes the same root and the settler proposes it itself after the freeze; `/epoch` and `/proof` serve it; the proof verifies on chain | **Built, undeployed** | `demo/matchbook-vm.test.mjs` (stake-weighted quorum; two 1-token nodes cannot outvote a 3-token one), `demo/matchbook-node.test.mjs` (a witness computes the host's root; the settler's proposal finalizes; the node's proof verifies on chain) |
| **The migration, dry-run.** `tools/deploy-contracts.mjs --fresh` executed unchanged against the in-process chain over HTTP: refuses an unbonding period shorter than MatchBook's windows before sending anything, deploys the whole set, names MatchBook an adjudicator, bonds the local node, is idempotent on re-run, and a node boots on the written file | **Built** | `demo/deploy.test.mjs` |
| Phase 2, still open: the cabinet showing `pending` beside `official`, the relay-attested (Agent Fighter) path onto MatchBook, a sandbox worker pool, append-only ledger storage | Specified | — |
| **Settlement v1.0 — phase 3: open hosting.** Anyone bonds and hosts; per-match fee split to host and attesting witnesses; obligatory custody by the drawn witnesses with on-chain custody challenges | Specified | — |

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
| R4 | **Every ranked match provable on chain**, by transaction, not by an off-chain proof against a root someone may or may not have anchored | `MatchBook`: commit, settle, attest ×3, dispute, finality — one event log any reader folds (§6, §11) |
| R5 | **Anyone can run a node and help secure the network**, and no few operators or single key can compromise it | Locked stake as the insurance (§2.2); no single key with authority (§2.3); k=3 stake-weighted witness draw; contract-driven slashing (§11) |

Plus the constraint the product exists for: **peer-to-peer node infrastructure
is not optional.** Gameplay runs between players, nodes verify and settle, and
a node going dark costs latency to settlement, never a match.

The lesson R5 is written against is Ronin (March 2022): the bridge was not
lost because it had few nodes but because five keys controlled the thing
that moved value, four sat with one company, nothing on chain could catch a
bad withdrawal, and one social-engineered laptop was enough. Node count is
the symptom; key concentration and unverifiable authority are the disease.
Every authority in this design is therefore either a contract rule, a
multisig behind a timelock, or a bonded key whose misuse costs its bond.

**Non-goals for V1.** A reserve or token economics beyond the per-match fee
split (§11.4), TEE agent inference, persistent worlds, on-chain registry
writes from the node, Wasm rulesets, an on-chain rating. Each is a seam
(§1.3) with a stated reference behaviour.

---

## 1. Shape

### 1.1 One repo, four packages, one deployable

```
protocol/   pure, isomorphic, versioned by RFC — the thing everyone agrees on
node/       the daemon anyone runs: identity, gossip, verify, settle, serve
sdk/        defineTitle, defineBalance, services helpers, the ruleset bundler
arcade/     the static lobby: list titles, queue, launch, show ladders
titles/     in-house titles as the first contributions, not special cases
contracts/  ERC6699Registry, NodeStake v3, ReleaseRegistry, MatchBook (spec), EpochAnchor, NodeDirectory, PlayerProfile, NodeBadge, TestLITVM
demo/       the test suites; all must pass before anything is called shipped
```

### 1.2 Three planes

```
BROWSER · any origin, no backend of its own
  presentation, input sampling, placement recomputation, ledger signing
        │  HTTPS: snapshot, queue, match        WebRTC: inputs ↔ peer (V1 target)
        │                                       WSS: relay fallback via a node
        ▼
NODE PLANE · one daemon per operator, bonded on chain (locked term)
  gossip · placement · signalling · relay fallback · witness replay · settlement
        │  eth_call: NodeStake, ReleaseRegistry, ERC6699Registry, MatchBook, beacon blocks
        │  tx from the node's DELEGATED hot key (gas only, never the bond):
        │    commit · settle · attest · dispute · claim — per ranked match
        │  tx from the operator's cold key: stake · unstake · setDelegate
        ▼
litVM LITEFORGE · chain 4441 · zkLTC gas · Arbitrum Orbit
  MatchBook event log = THE delta set. Ladders fold over it; anyone can.

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
| Standing | NodeStake v3 locked bond (§2.2) | Attestation record + bond |
| Ruleset runtime | Single-file ES module, hash-pinned, `--permission` sandbox | Wasm with pinned runtime |
| Artifact transfer | Fetch by hash from any peer | Obligatory custody by the drawn witnesses, custody challenges on chain (§11.5) |
| Studio store | memory / Supabase / Firebase drivers | anything with get/set/list |
| Delta set | **`MatchBook` events on litVM, in block order** (§6, §11) | same interface; blobs / calldata for ledgers on dispute |
| Settlement | Per-match `commit` / `settle` / `attest` txs; hourly root over the finalized set | verifiable-VM replay for dispute resolution |
| Dispute resolution | Stake-weighted majority of drawn witnesses, escalation panel (§11.3) | on-chain replay |

### 1.4 Roles

One daemon, one config. There is no "desktop node" or "client node" as a
separate program: every node runs the same code and its roles are set in
`node.env`. What differs in production is who runs it and why:

| Node | Bond | Roles | Where | Why |
|---|---|---|---|---|
| Operator (publisher) | own wallet, locked | mesh, host, witness, settler | a desktop or VPS that stays up | seeds the mesh, keeps every ledger and build it touched, settles on chain |
| Anyone | own wallet, locked | mesh, witness (+ host) | anyone's machine | drawn to attest other operators' matches and earns the attest share; hosts when drawn. **This is the row R5 is for.** |
| Relay / court | via its operator | host | beside a game's own server | Agent Fighter relay, Pickle Brawl court |
| Player | none | — | the browser | not a node: signs queue entries and ledgers, reaches nodes over HTTPS/WSS |

Two builds ship from `npm run pack`: `litnode-portable` (any node) and
`litnode-operator` (the same daemon plus a no-prompt `node.env`, a Windows
scheduled-task installer, and the chain tooling). A witness must be bonded
from a different wallet than the host it witnesses, and its bond must be
older than `eligibilityAge` (§2.2) before it can be drawn.

Set in config, additive. A node may not witness a match it hosted or relayed.

| Role | What it does |
|---|---|
| `mesh` | Serves rulesets and ledgers by hash, gossips heartbeats and the open queue bucket, signals WebRTC, directory for browsers |
| `relay` | WebSocket fallback for players who cannot connect directly; holds the live ledger |
| `witness` | When drawn (§5): verifies the ledger, re-hydrates from the registry, replays, sends `attest` (or `dispute`) from its delegated key; keeps the ledger in custody for the season |
| `settler` | Sends `commit` before play and `settle` after; builds the hour's tree over the finalized set and proposes the root |
| `agent` | Not implemented. Reports zero. |

**Keys a node holds** (§2.3): its ed25519 node key (identity, never on chain
as a signer) and one **delegated EVM hot key** funded with gas only, which
NodeStake v3 records as the key allowed to act for that node key. The bond
sits with the operator's cold wallet, which the node never sees. A stolen hot
key can post wrong attestations — and lose the bond for it — which is
exactly what the bond is for. It cannot move the bond.

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

### 2.2 Staking LITVM to host a node — NodeStake v3, built, undeployed

To host, witness or settle, an operator bonds LITVM (the `TestLITVM` mock on
Liteforge until the token exists there) in `contracts/NodeStake.sol` behind
the node's key. **Trust is insured by the stake**: a node is allowed to do
exactly what its locked bond can pay for if it lies. `standingOf(nodeKey)`
still returns `(operator, amount, active)` — every v2 reader keeps working —
and v3 adds `bondedSince`, `delegateOf` and `witnessEligible`.

What the bond does:

- **Eligibility.** A node whose key is not bonded at or above `minStake`, or
  is unbonding, is not eligible for placement. Nothing in its heartbeat can
  change that.
- **Locked term.** `stake()` starts a lock of `lockTerm` (a top-up does not
  restart it; the first bond sets `bondedSince`). `unstake()` reverts before
  `bondedSince + lockTerm`. A bond that can leave the moment a bad result
  finalizes is not a bond; the term is what makes the stake insurance rather
  than a deposit.
- **Witness eligibility age.** `witnessEligible(nodeKey)` is `active &&
  now ≥ lastStakedAt + eligibilityAge`. A freshly bonded node can host casual
  matches and serve the cabinet at once; it cannot be *drawn to attest* a
  ranked result until its bond has history. Fifty sybils bonded this morning
  cannot be a panel this afternoon. **A top-up restarts the age** (not the
  lock): a whale cannot add stake the morning of an escalation to outweigh
  it. A bond withdrawn and re-staked starts a new lock — unbond-and-rebond
  does not skip it (found and fixed in the 22 Sep review).
- **Unbonding outlasts adjudication.** `unbondingPeriod` must exceed the
  longest `MatchBook` dispute window plus escalation (§11.3), so every match
  a node touched can still be adjudicated against its stake. The deploy tool
  refuses parameters where that is not true.
- **Operator identity.** The operator *is* the staking address. A witness
  "under a different operator" means a different staking address. Two keys
  bonded from one wallet cannot host and witness the same match — asserted in
  `demo/staking.test.mjs`.
- **Delegated hot key.** `setDelegate(nodeKey, addr)` by the operator names
  the EVM address the node process runs with. `MatchBook` accepts
  `commit`/`settle`/`attest`/`dispute` for a node key only from its delegate
  (or its operator); `NodeDirectory` accepts `announce` the same way (its own
  delegation is folded into this one). The delegate holds gas, never the
  bond. Rotating a leaked hot key is one operator transaction; the bond, the
  node key and its history stay.
- **Standing.** The bonded amount, in whole tokens, is the standing a manifest
  can set a floor against. The witness draw (§5) is weighted by it.
- **Slashing, by contract, not by a wallet, as a fraction of the bond.**
  There is no `slasher` address. `slash(nodeKey, bps, reason)` is callable
  only by an address in `adjudicators` — contracts, set by `admin`:
  `MatchBook` (a finalized result the node attested against, or a settle it
  lost), the custody challenger (§11.5). The cut is `bps` of the bond as it
  stands, so lying costs a whale proportionally what it costs a minnow. The
  evidence is the calling contract's own state, so every slash is
  reproducible from chain data alone. Slashed funds go to `treasury`, which
  is meant to be the fee pool (§11.4).
- **Bounded admin.** No term or period may exceed `MAX_TERM` (365 days), so
  an admin — even a compromised one — cannot trap bonds forever.

What the bond does **not** do: pay anyone for holding it. The whitepaper
(§5.4) is explicit that operators earn for serving, not for holding a token.
Nodes earn the per-match fee split for hosting and attesting (§11.4); the
bond is the cost of doing that wrong.

Node-side: `protocol/staking.js` builds the `eth_call`s, decodes the answers,
and `applyStakes` drops unbonded peers and **replaces** their operator and
standing with chain values before placement sees them; `witnessEligible` is
read alongside `standingOf` and gates the witness draw.

**Testnet parameters** (`contracts/deploy.testnet.json`), set to the minimum
that proves the mechanism and nothing more: `minStake = 1 tLITVM`,
`lockTerm = 10 min`, `eligibilityAge = 2 min`, `unbondingPeriod = 15 min`
(> the testnet dispute window + escalation), `admin` and `treasury` = the
deployer *until the multisig exists* (§2.3). One faucet pull (1,000 tLITVM)
funds a thousand bonds. **Proposed mainnet parameters**, to be argued in the
RFC and not before: `lockTerm = 30 days`, `eligibilityAge = 7 days`,
`unbondingPeriod = 14 days`, `minStake` sized so that a witness slot costs
more than the largest pot it could steal.

Open until deploy: the real LITVM address on Liteforge; the multisig.

### 2.3 No single key — the authority map

Every key that could, alone, change a result, ship code to every node, or
move a bond, and what replaces it:

| Authority | v0.2 | v0.3 |
|---|---|---|
| Slash a bond | one `slasher` wallet (the exposed deployer) | `adjudicators` = contracts only; no wallet may slash |
| Change stake parameters, quorum, adjudicators | `slasher` / `admin` EOA | `admin` = a **multisig behind a timelock** (Safe + a 48 h `TimelockController`, or the equivalent on litVM). The contract only knows an address; the deploy tool prints a loud warning and `/health` reports `admin: eoa` until it is a contract |
| Ship a release to every node | `RELEASE_PUBKEY`, one ed25519 key, auto-checked hourly | the signature stays; **plus** the release's zip hash must be registered in `ReleaseRegistry` by `admin` with `activatesAt ≥ now + activationDelay` (24 h mainnet, 60 s testnet). A node applies only a release that is signed **and** registered **and** active. Anyone watching the registry has a day to read the diff before any node runs it. (§2.4) |
| Admit a title build to the mesh | `trustedPublishers` = the same release key | unchanged for now — the sandbox is the boundary (§4); a build cannot touch the bond. Moves to a publisher stake in phase 3 |
| Finalize an epoch root | `quorum` = a constant count of operators | quorum = a **fraction of active bonded stake**, and the root is over the *finalized* MatchBook set, so proposing a wrong root is a slashable claim (§11.6) |
| Post on chain for a node | the operator's cold key in a shell | the delegated hot key (§2.2); the cold key only stakes, unstakes and delegates |
| The deployer key | exposed in a transcript | rotated to W2 on 19 Sep 2026 (`contracts/MIGRATION.md` v1 → v2; the exposed address holds nothing). W2 is still one wallet holding `admin` everywhere; it hands over to the multisig in the v3 migration |

The rule: an authority is a contract rule, a multisig behind a timelock, or a
bonded key whose misuse costs the bond. Nothing else.

### 2.4 ReleaseRegistry — built, undeployed

`contracts/ReleaseRegistry.sol`. `register(bytes32 zipHash, string version,
bytes32 protocol, uint64 activatesAt)` by `admin`, `activatesAt ≥ now +
activationDelay`; `revoke(zipHash)` by `admin` at any time (a bad release is
pulled faster than it is shipped; revocation needs no delay). `statusOf(
zipHash)` returns `(registered, active, revoked, version, activatesAt)`.

Node-side (`protocol/release.js`, `node/update.js`): `check()` verifies the
manifest signature as before, then reads `statusOf(zipHash)` for the zip it
would download. `apply()` refuses a release that is unregistered, revoked or
not yet active, and says which. With no chain configured the node keeps the
v0.2 behaviour and `/health.update.registry` says `unset` — the same honest
label pattern as staking and profiles. The self-repair path (an install
missing `sdk/`) obeys the same gate.

---

## 3. Registry and snapshot

Signed heartbeats gossiped between peers (`protocol/snapshot.js`), overlaid
with NodeStake reads. A heartbeat whose signer is not its `nodeId` is
discarded. Epochs are 2 s; a peer is fresh while `epoch >= now - 2`.

**What gossip carries (v0.3):** heartbeats, the open and just-closed queue
buckets, and placement descriptors — everything bounded by *who is online
now*. It no longer carries delta advertisements: the chain is the index a
witness reads (§11), so the payload cannot grow with history. The v0.2
payload advertised every delta ever settled on every tick and would have
crossed the 4 MB body limit within hours at target load.

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

**Custody.** Builds are never evicted (§16). Ledgers: the host and the three
drawn witnesses are the match's named custodians in its `settle` event and
must serve it for the season, on pain of a custody challenge (§11.5). Before
phase 3 lands, custody is opportunistic and labelled so.

**Runtime.** Title code runs only in a separate `--permission` process with
no filesystem, network or child-process access, an empty environment, a
memory cap and a deadline (`node/sandbox.js`). That is the boundary that
lets a permissionless node load a build it did not author. Wasm with a
pinned runtime remains the stronger answer and the seam is kept.

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

**Witness panel (v0.3, phase 2).** Ranked matches draw **k = 3** witnesses,
not one: walk the seeded order, weighting each node's draw by its bonded
amount (`H(seed ‖ nodeId)` scaled by `stake / totalStake`, so a node with
twice the bond is drawn about twice as often — the cost of a panel seat
scales with the stake behind it), skipping nodes that are not
`witnessEligible` (§2.2), share the host's staking address, or already sit
on the panel. Two of three agreeing on the same `resultHash` finalizes the
match; the third, if it attested differently, is slashed. The panel is
recorded in the `commit` event, so "who was supposed to attest" is on chain
before the match is played. Fewer than three eligible nodes: the match is
placed casual-only and the cabinet says why.

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
COMMIT    (ranked) The drawn host's delegate sends
            MatchBook.commit(matchId, descriptorHash, hostKey, panel[3])
          BEFORE play. The chain now holds who plays, which build, which
          host, which panel — bound to the beacon block. A ranked match
          with no commit is unplaceable; the client refuses to launch it.
HYDRATE   Each side reads the ERC-6699 tokens at the commit's block, applies
          the title's balance mapping, builds the hydrationManifest (§8).
PLAY      V1 reference: both clients connect to the drawn relay node, which
          holds a first-write-wins ledger. V1 target: WebRTC peer to peer,
          both clients hold the ledger, the node only signals.
          Every tick is appended to a hash chain: H('tick', prev, {k, inputs}).
SIGN      At match end each player signs {matchId, ticks, head, buildHash,
          hydrationHash} once. A player who disagrees with the log does not
          sign; the delta settles labelled and never becomes official.
DELTA     { matchId, rulesetId, buildHash, seed, participants, mode,
            hydrationManifest, ticks, head, signatures, finalStateRoot,
            scores, hostId, hostSig, resultHash }      (protocol/result.js)
SETTLE    The host replays in the sandbox, computes resultHash, and its
          delegate sends
            MatchBook.settle(matchId, resultHash, ledgerHash, participants,
                             scores, custodians)
          within settleWindow blocks of the commit. The event IS the delta
          record: a reader needs no node to learn the result. The ladder
          shows it at once, labelled `pending` (§9).
ATTEST    Each panel witness reads the Settled event, fetches the ledger from
          a custodian, verifies both signatures, walks the chain, rebuilds
          hydration from the registry at the commit block, replays in the
          pinned build, and sends attest(matchId, resultHash) for the hash IT
          reached. A different hash is a dispute(matchId, myResultHash) —
          the same transaction shape, a different value.
FINAL     After attestWindow blocks, the contract finalizes the resultHash
          with 2-of-3 panel agreement (stake-weighted on a tie of counts).
          A panel member who attested another hash is slashed; a host whose
          settle lost is slashed and the match is void. No agreement, or a
          dispute inside the window: ESCALATE (§11.3).
EPOCH     Anyone proposes the hour's root over the FINALIZED set (§11.6).
```

Casual matches skip COMMIT/ATTEST/FINAL: the host settles locally as in
v0.2, the delta is served from the host and labelled `casual`, never
official. Attested titles (§7) commit and settle the same way with the
court's report hash as `ledgerHash`; the panel re-checks the court signature
and the rulebook, not a replay, and the event says `verifiable: false`.

**Transactions per ranked match:** commit, settle, three attests — five, plus
a dispute and escalation when something is wrong. Every one of them is a
claim with stake behind it. Heartbeats, queue entries and gossip stay off
chain: they secure nothing and would only raise the cost of the ones that do.

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
the delta set**, idempotent by matchId, so two readers holding the same set
produce the same digest. The fold itself does not change in v0.3; **what
changes is the set and its order**:

- **The set is the `MatchBook` event log** (§11), read by every node — and by
  the cabinet straight from RPC when no node answers — never a node's local
  files. v0.2's ladders were each node's own hosted matches; the hosted
  cabinet showed whichever seed answered. That is gone.
- **Order is block order** (`blockNumber`, `logIndex`), which every reader
  already agrees on. The epoch-hour-then-matchId sort remains for casual
  and off-chain sets.
- **Official = finalized.** The official ladder folds `Finalized` results
  only. A `Settled` result not yet finalized is folded into a second,
  `pending` view the cabinet shows beside the official one with the label —
  a player sees their rating move at settle and sees it become official
  when the window closes, and can re-queue at once. A finalized void (host
  slashed) is a no-op in the fold; nothing is ever un-folded.
- **Elo stays off chain.** The contract holds results, not ratings. An
  on-chain `ratingOf` would make the fold depend on finalization order and
  need rollback logic for reversals; a reproducible fold with its digest
  anchored per epoch (§11.6) is as provable and simpler. This is a decision,
  not a deferral.
- **Incremental.** A node keeps a cursor `(block, logIndex)` and folds new
  events as they arrive; `/leaderboard` is a read of the current tables, not
  a recomputation. A restart replays from the last anchored epoch.

**Per-title ladders are the truth.** Elo does not transfer between games. The
universal layer is the reputation ledger: finalized ranked match counts,
distinct opponents, win rates by title, seasons aligned to epoch roots — no
merged rating. Eligibility is enforced in the fold: ranked only, finalized
only, stasis excluded, distinct-opponent minimums, diminishing returns per
opponent. Player keys register against PlayerProfile / AIR identities, and
the fold counts identities, not keys (`applyProfiles`). The reputation
ledger is specified, not built.

Reads: `GET /leaderboard`, `/credits`, `/stats`, each carrying the derivation
version, the cursor they were folded to and `scope` (`official` | `pending`
| `all`), so a ladder is `(event log to cursor, version) → tables`.

---

## 10. Studio plane

Unchanged from v0.1: `node/store.js` is `get/set/list` behind memory,
Supabase and Firebase drivers. Nothing the studio plane holds may sit on the
match critical path. Convention today; the SDK build step makes it an error
(§17).

---

## 11. Settlement — the chain as the index

### 11.1 Why per-match, on chain

Two requirements decide it (§0.1 R4, R5). A result is *provable* when a
third party can find it without asking a node that might be gone or lying;
a network is *secured* by transactions when each transaction puts stake
behind a claim that a contract can later hold it to. An hourly root over a
set only one node holds meets neither. So the unit of settlement is the
ranked match, the record is an event on litVM, and the epoch root becomes a
checkpoint over what the chain already finalized.

### 11.2 `MatchBook` — specified (phase 2)

```solidity
struct Match {
  bytes32 descriptorHash; bytes32 hostKey; bytes32[3] panel;
  uint64  committedAt;    // block
  bytes32 resultHash;     bytes32 ledgerHash;
  uint64  settledAt;      uint8 attests; uint8 disputes;
  bytes32 finalHash;      uint8 status; // 0 committed 1 settled 2 final 3 void 4 escalated
}
function commit (bytes32 matchId, bytes32 descriptorHash, bytes32 hostKey, bytes32[3] panel) external;
   // by hostKey's delegate/operator; panel keys witnessEligible, distinct operators, ≠ host's
function settle (bytes32 matchId, bytes32 resultHash, bytes32 ledgerHash,
                 bytes32[] participants, int64[] scores, bytes32[] custodians) external;
   // by the committed host, within settleWindow of committedAt; emits Settled with every field
function attest (bytes32 matchId, bytes32 witnessKey, bytes32 resultHash) external;
   // by a panel member's delegate, once, within attestWindow of settledAt
function dispute(bytes32 matchId, bytes32 witnessKey, bytes32 altHash) external; // = attest with ≠ hash
function finalize(bytes32 matchId) external;   // anyone, after attestWindow; applies §11.3
function escalate(bytes32 matchId, bytes calldata ledger) external; // anyone; see §11.3
event Committed(bytes32 indexed matchId, bytes32 indexed hostKey, bytes32 descriptorHash, bytes32[3] panel);
event Settled  (bytes32 indexed matchId, bytes32 indexed rulesetId, bytes32 resultHash, bytes32 ledgerHash,
                bytes32[] participants, int64[] scores, bytes32 buildHash, bytes32[] custodians);
event Attested (bytes32 indexed matchId, bytes32 indexed witnessKey, bytes32 resultHash, bool agrees);
event Finalized(bytes32 indexed matchId, bytes32 finalHash, uint8 status);
```

`MatchBook` is an `adjudicator` in NodeStake v3: it slashes directly, from
its own state, with the matchId as `reason`: the host `hostSlashBps` (10 %
testnet) when the escalation majority rejects its result, a panel key
`witnessSlashBps` (5 %) when it voted against the majority. Windows are
seconds, parameters set by `admin` (multisig): testnet `settleWindow = 60`,
`attestWindow = 120`, `escalationWindow = 300`, `drawDelay = 2` blocks;
mainnet proposals in the RFC. `expire(matchId)` — anyone — voids a commit
never settled or an escalation nobody fed within its window: no state is
forever. NodeStake's `unbondingPeriod` must exceed `totalWindow()` =
settle + 2 × attest (one liveness extension) + 2 × escalation (feeding the
ledger, then the nine); the deploy tool refuses otherwise.

`resultHash` is exactly `protocol/result.js`'s commitment — the same bytes a
v0.2 witness co-signed — so the node code that computes it does not change;
what changes is where the signature goes. `descriptorHash` is
`node/settle.js`'s, over the frozen placement.

### 11.3 Finality and disputes — no human in the loop

At `finalize`:

| Panel outcome | Result |
|---|---|
| ≥ 2 attests on the host's `resultHash` and **no dissent** (the third agreed or never answered) | **final**. Nobody slashed: an absent witness forfeits its attest share (§11.4), nothing more. |
| any attest on another hash — one dissenter is enough | **escalated**, whatever the count. Two panel seats plus the host are not asked to outvote a third on their own word; the nine decide, and the losing side of *either* panel pays. |
| fewer than 2 attested and no dissent | the attest window is **extended once** (witness liveness is not a dispute); still fewer than 2 afterwards → **escalated**. |

The contract does not adjudicate 2-against-1 by itself in either direction:
a host with two friendly seats would otherwise finalize over an honest
third, and two colluding seats would otherwise void an honest host. Every
disagreement goes to a fresh, larger, random panel.

Escalation is where a contract that cannot replay Agent Fighter gets an
answer anyway. `finalize()` names a **future block** (`drawDelay` ahead) as
the seed; once it exists, `escalate(matchId, ledger)` — anyone, typically a
custodian — posts the full ledger to calldata (its sha256 must be the
committed `ledgerHash`, so it can no longer be withheld or swapped; ~40 KB
for a three-minute Agent Fighter match) and the contract draws a **panel of
nine** from the enrolled pool, seeded by that block's hash, stake-weighted,
one seat per operator, excluding the original panel, the host and their
operators, and **snapshots each seat's weight at the draw**. The nine attest
within `escalationWindow`; the **stake-weighted strict majority of the
snapshot** decides; every key on either panel that attested against the
majority is slashed; a host whose result the majority rejected is slashed
and the match voided. Fewer than nine eligible nodes: the match is voided
and nobody slashed — the honest answer when the network is too small to
adjudicate. Two attacks the 22 Sep review found are closed by construction
and exercised in `demo/matchbook-vm.test.mjs`: a top-up after the draw does
not move the tally (the snapshot), and the caller of `escalate()` cannot
choose the seed (the block is named before anyone can act).

What this does and does not protect against, stated: a colluding host plus
two panel seats can pass a false result only if they also win a random
nine-seat panel of stake; the cost is the stake behind twelve seats against
a pot of ten credits. An adversary holding a majority of *all* bonded stake
can rewrite results — that is true of any stake-secured system and is what
`minStake` and `lockTerm` are priced against. Sequencer influence over the
beacon (§5.2) remains the stated gap.

### 11.4 Who pays, who earns

The node's delegated hot key pays gas for commit, settle, attest, dispute
and claims. Per ranked match a fee `matchFee` (parameter; source: the
title's pot, or a per-match charge on the players' proxy wallets, to be
decided per title) accrues in `MatchBook` and is split at finality: host
share, one attest share per agreeing panel member, the remainder to
`treasury`. `claim(nodeKey)` pays a node's accrued shares in one
transaction whenever its operator likes. No paymaster: a treasury that pays
everyone's gas is a softer single point of failure — when it runs dry,
settlement stops. Operators fund their own hot key and earn it back by
serving. This is the loop that makes "anyone can run a node" true rather
than charitable, and it is phase 3.

### 11.5 Custody

The `Settled` event names the custodians: the host and the panel. Each must
serve `GET /ledger/:matchId` for the season. A custody challenge is cheap
because a ledger commits to its ticks: `challenge(matchId, custodianKey,
tick)` on chain; within `custodyWindow` the custodian answers
`respond(matchId, tick, entry, proof)` and the contract checks the entry
against the committed `ledgerHash`. Whether `ledgerHash` stays the hash
chain head (then the proof is the run of heads from `tick` to the end,
O(ticks) calldata) or becomes a Merkle root over the entries (O(log ticks))
is the one open question for the RFC; the Merkle form is the expected
answer. A missed response is slashed `custodySlash`. Phase 3.

### 11.6 Epoch root — `EpochAnchor` v3, checkpoint over the finalized set

`protocol/matchbook.js chainLeaf`: `leaf = H('leaf3', {matchId, rulesetKey,
buildHash, resultHash, ledgerHash, participants, scores, hostKey, finalHash,
status})` — every field from the `Settled` and `Finalized` events, so every
reader of the log builds the same leaf; a voided match is a leaf too, with
its status. `chainEpoch`: the sha256 binary tree (`protocol/epoch.js`) over
the sorted, deduplicated leaves of every match whose `Finalized` event sits
in a block of that hour; inclusion paths. Since every leaf is already an
on-chain event, the root is a checkpoint — cheap for a third party to verify
one match against without an archive node — not the source of truth.

`EpochAnchor` v3: `propose(epoch, root, nodeKey)` by the key's delegate or
operator; support is the sum of the proposing nodes' bonded amounts; the
root finalizes when its support reaches `quorumBps` of `NodeStake.
totalActive` (v2's count of operators, which one entity funding N stakes
could manufacture, is retired). One proposal per node key per epoch. The
settler proposes each frozen hour it holds finalized matches for, from its
delegate, on its own (`node/matchbook.js propose`); `tools/anchor-epoch.mjs`
is the manual path and the finality check. Slashing a contradicting root is
NOT built: a contract cannot enumerate the hour's finalized set to prove a
root wrong, so `EpochAnchor` is not an adjudicator. A wrong proposal from
a minority of stake simply never finalizes.

### 11.7 Load, stated

Target: 10,000 active players across ten titles, ~4-minute matches — roughly
10–35k ranked matches an hour. Five transactions per match is ~14–50 tx/s
sustained, plus ~40 KB of calldata per escalation. **This number has not been
checked against Liteforge**, whose gas cap is 32M per block on demand at
~250 ms; the on-chain `Settled` event with participants and scores is
~1–2 KB of log data. The fallback if the chain cannot take it: keep
`commit` per match (the security-bearing one that must precede play) and
batch `settle`/`attest` as per-minute Merkle roots — still provable per match
by proof, ~10× fewer transactions. The question to Caldera is item 1c of §17
and blocks phase 2 parameters, not phase 2 code.

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
| POST | `/gossip` | Merge heartbeats, queue, match descriptors (deltas until phase 2 lands; then never) |
| POST | `/queue` | Signed queue entry |
| GET | `/match?playerId=` | The pair a player belongs to, with placement |
| GET | `/ruleset/:rulesetId` | Ruleset source, verified by hash |
| POST | `/signal` | WebRTC offer/answer/candidates between the two players |
| WS | `/relay?matchId=` | Fallback relay |
| GET | `/ledger/:matchId` | Chained log + signatures |
| GET | `/delta/:matchId` | Delta and co-signatures |
| POST | `/cosign` | Witness signature |
| GET | `/leaderboard`, `/credits`, `/stats` | Derived tables + derivation version, cursor, `scope=official|pending|all` |
| GET | `/epoch?epoch=` | Leaf set over the finalized hour, root, proposal calldata |
| GET | `/match/:matchId/chain` | the match's `MatchBook` status, panel and events, as this node read them from the log |
| GET | `/health` | Identity, bond status (`bondedSince`, `witnessEligible`, delegate), release registry status, peers, rulesets, chain |

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
release_registry = "0x…"                    # ReleaseRegistry; unset = signature-only updates, reported
match_book   = "0x…"                        # (phase 2) MatchBook; unset = local settlement, never official
delegate     = "<dataDir>/delegate.json"    # the hot EVM key; gas only. Operator runs `npm run delegate -- <nodeId> <addr>`
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
| `demo/contracts.test.mjs` | Every contract compiles; NodeStake v3 keeps the v2 `standingOf` shape every reader declares, has no slasher, and its hand-encoded selectors (`protocol/staking.js`, `protocol/release.js`) match solc's | 4 |
| `demo/release-registry.test.mjs` | Registry calldata and decoders round-trip against ethers; the updater refuses a signed release that is unregistered, pending, revoked or unreadable, re-asks the chain at apply time, applies an active one, and says `unset` with no registry | 4 |
| `demo/matchbook.test.mjs` | MatchBook selectors and event topics match solc; every delegate-sent calldata (commit, settle with dynamic arrays and int64 scores, attest, finalize, escalate with the ledger bytes, resolve, enroll) equals ethers' encoding; reads decode; ethers-emitted logs decode; the fold gives official and pending ladders with the same digest in any log order and drops voids | 4 |
| `demo/matchbook-vm.test.mjs` | The contracts EXECUTED (`@ethereumjs/vm`, `demo/lib/evm.mjs`): NodeStake v3 lock, top-up age, re-stake lock, delegate powers, adjudicator-only slash, bounded params; MatchBook commit refusals, settle window and expiry, happy path, one-witness extension then escalation then expiry, a dissent → nine seats → majority against the host (host 10 %, lie-voters 5 %, dissenter untouched, whale top-up after the draw counts for nothing and costs 5 % of the larger bond, treasury delta = sum of cuts), majority for the host, too few nodes → void with no slash, and the protocol fold over the real log | 6 |
| `demo/matchbook-node.test.mjs` | Five litnodes on the real NodeStake v3 + MatchBook over an in-process RPC (`demo/lib/rpc-evm.mjs`: eth_call, raw transactions from the nodes' delegate keys, receipts, logs, blocks): two players placed, the host commits before play with the panel the mesh drew, players play TUG and sign, the host settles (result commitment and ledger sha256 on chain), exactly the three panel nodes attest from their own delegates, the host finalizes, all five nodes serve the same chain-folded ladder digest, gossip carries no deltas | 1 |
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
- **Until phase 2 lands, delta gossip is by advertisement, not
  replication, and every node's ladder is a fold over the matches IT
  hosted.** A witness fetches from the host's address; if the host is gone
  before a witness saw it, the delta has one signature; the hosted cabinet
  shows the ladder of whichever seed answered. The gossip payload carries
  every delta ever settled on every tick. This is the v0.2 model and it is
  wrong at any real scale (§0, "what changed"); it is replaced by §6/§11,
  not patched.
- **Nothing of Settlement v1.0 is deployed.** Phase 1 (keys, locked stake,
  release registry) and phase 2 (`MatchBook`, the panel, escalation, the
  node sending and attesting, the chain-folded ladder) are built and
  executed only on an in-process EVM; Liteforge has the v2 contracts. Fees
  and custody challenges (phase 3) are specified, not built. Automatic epoch
  proposal waits on EpochAnchor v3. The cabinet does not yet show the
  `pending` ladder. `TitleRegistry` (publisher rules and auth, a separate
  workstream) is deployed by the same tool and is not part of this spec.
- **Ranked play through the mesh is still Agent Fighter through its relay,
  which settles `relay`-attested and never reaches MatchBook.** The end to
  end test plays TUG through the SDK client with both players signing;
  Agent Fighter's client does not sign yet (roadmap 1b).
- **Liteforge throughput at target load is unverified** (§11.7). The design
  has a stated fallback; the parameters wait on Caldera's answer.
- **`admin` is an EOA until the multisig exists.** The contracts only know
  an address. Until a multisig behind a timelock holds `admin`, the
  authority map (§2.3) is a plan and `/health` says `admin: eoa`.
- **Anchoring is manual on Liteforge today** (v2 contracts, each node's
  tree over its own hosted matches). The v3 node proposes automatically over
  the chain-finalized set; it is built and undeployed.
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
- **The deployed v2 contracts have a single slasher key held by the
  deployer wallet, which was exposed during setup.** NodeStake v3 removes
  the slasher role entirely (§2.2); until v3 is deployed and the multisig
  takes `admin`, the exposed key can still slash on testnet. TestLITVM is a
  faucet mock, not the token. Nothing is audited.
- **Beacon is not secure against the sequencer.** By the chain's own docs.
- **Custody is opportunistic** until phase 3.
- **Rulesets run in a `--permission` sandbox process, not Wasm.** The
  sandbox is the boundary for permissionless nodes; a runtime escape in
  Node's permission model is a risk this design accepts and states.
- **One witness and no disagreement path** until phase 2. Differing roots
  are logged and filed as signed disputes; nothing adjudicates them.
- **No economics** until phase 3. Credits reconcile against no reserve;
  nothing is paid; the fee split is specified.
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
1c. **Settlement v1.0, phase 1 — no single key (built 21 Sep 2026,
   deploy next).** `NodeStake` v3 with the locked term, eligibility age,
   delegated hot key and adjudicator-only slashing; `ReleaseRegistry` and
   the node's update gate; deploy tool refuses `unbondingPeriod ≤` the
   dispute windows and warns on an EOA `admin`; `contracts/MIGRATION.md`
   v2 → v3 (re-bond every node from its operator wallet — the lock starts
   then; set delegates; hand `admin` to the multisig). **In parallel: ask
   Caldera for Liteforge's sustained tx/s and log-data cost at the §11.7
   profile.** Exit: every bond on the testnet is locked and delegated,
   `/health` reports `witnessEligible`, `admin` is a multisig or the zero
   is written down.
1d. **Phase 2 — `MatchBook` (weeks 2–5).** The contract (§11.2–11.3, no
   fees yet), the k=3 stake-weighted panel in `protocol/placement.js`, the
   node sending commit/settle/attest from its delegate, `witnessOne` becomes
   "am I on this panel?", `derive` over the event log with a cursor, the
   cabinet reading `pending` and `official`, the settler proposing epoch
   roots automatically, delta advertisements removed from gossip, a sandbox
   worker pool (one long-lived child per build; the fork was the cost, not
   the replay), append-only ledger storage. Exit: a ranked match from *Find
   match* is committed before launch, settled, attested by three operators
   and finalized on Liteforge, and the same ladder row appears on every
   node and on the cabinet reading RPC alone.
1e. **Phase 3 — open hosting (weeks 6–8).** Fee split and `claim`, custody
   challenges, escalation panel exercised with a deliberately wrong host on
   testnet, a one-command "bond and run" for a stranger's machine, the
   reputation ledger fold. Exit: a node bonded by someone outside the team,
   drawn to a panel, paid for it.
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
6. On-chain registry reads · Wasm rulesets · audit the v3 contracts and
   `MatchBook` before mainnet · VRF or commit-reveal beacon · verifiable-VM
   replay for escalation · SDK availability guard · agent role, committed
   mode first.

**Rules that keep it composable.** Every seam is an interface, a reference
and a conformance test. The protocol package changes by RFC only, with a
version in every signed body. Titles are certified by suite, not review.
Every release ships its honest zeroes.
