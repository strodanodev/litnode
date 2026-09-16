# litnode + LIT GAMES cabinet

**litnode** is a portable, dependency-free node for the LIT GAMES arcade mesh:
signed gossip, deterministic matchmaking and placement, hash-pinned rulesets,
ledger replay, witness co-signing, derived leaderboards, hourly settlement
roots anchored on litVM. **The cabinet** is the frontend every node serves at
`/` and that also deploys to any static host: profile, ladders, match
history, node status, and — the point — a *Find match* flow that signs a
queue entry, recomputes placement itself and refuses a host the rule did not
produce.

This is the source repository. The portable zips an operator unzips are
built from it (`npm run pack`); nothing ships that is not here.

- [BUILD-SPEC.md](BUILD-SPEC.md) — the build plan: what is built, what is
  specified, what reports zero, and the test that proves each claim
- [SPEC.md](SPEC.md) — as-built reference: node API, ruleset interface,
  cabinet architecture, known gaps
- [docs/NODE-CABINET-SYNC.md](docs/NODE-CABINET-SYNC.md) — the contract
  between the cabinet and the node, and what is still open between them
- [docs/WALLET-IDENTITY.md](docs/WALLET-IDENTITY.md) — sign in with a
  wallet: one transaction binds the player key to a litVM profile
- [CHANGELOG.md](CHANGELOG.md)

Live cabinet: **https://lit-games-cabinet.vercel.app**

## Layout

```
protocol/   pure, isomorphic, dependency-free — hashing, keys, log, placement,
            pairing, beacon, snapshot, epoch tree, derive, staking reads
node/       the daemon: identity, gossip, snapshot, fetch-by-hash, pairing,
            placement, settlement, witness, epoch, and it serves cabinet/ at /
cabinet/    the frontend (static, no build step); cabinet/protocol/ is a
            generated copy of the modules it runs — npm run vendor:cabinet
titles/     defineTitle / defineAttestedTitle and the in-house adapters
rulesets/   bundled single-file rulesets, pinned by buildHash
contracts/  NodeStake, TestLITVM, ERC6699Registry, EpochAnchor + testnet addresses
tools/      bundle, pack, vendor, bond, import/watch Agent Fighter ledgers, anchor
portable/   what goes in the zips: start-node.cmd, node.env, operator README
demo/       the test suites — npm test must be green before anything ships
```

## Run

```bash
npm install            # only for the chain tools (ethers, solc); the node itself has no deps
npm test               # 30 assertions across 8 suites, ~25 s
npm run node           # one node on :7801 with its dashboard; cabinet at http://localhost:7801/
LITNODE_PLAIN=1 npm run node   # one line per event instead of the dashboard (what litnode.log gets)
```

Configure with environment variables: `OPERATOR`, `PORT`, `HOST`,
`PUBLIC_ADDR`, `SEEDS` (comma list), `ROLES` (`mesh,host,witness,settler`),
`RULESETS`, `REGION`, `WS_ADDR` (the relay this node fronts), `RPC`,
`NODE_STAKE`, `OFFLINE=1` (local beacon, no stake reads). Defaults for the
chain come from `contracts/deployed.testnet.json`.

A mesh is more of the same, pointed at each other; only the first node is
given the ruleset file, the others fetch it by hash:

```bash
PORT=7801 OPERATOR=publisher RULESETS=./rulesets/agent-fighter.v1.js npm run node
PORT=7802 OPERATOR=guild-a   SEEDS=http://127.0.0.1:7801 RULESETS= npm run node
```

The cabinet alone, against any node: `npm run cabinet` → http://127.0.0.1:5180/
(node URL in the footer, persisted in the browser).

## Operate

`npm run pack` writes `dist/litnode-portable-<date>.zip` (any node) and
`dist/litnode-operator-<date>.zip` (adds `node.env`, a Windows scheduled
task, the chain tools). `npm run pack -- --runtime` also vendors the
official Node.js win-x64 runtime (checksum-verified against nodejs.org)
into `runtime/`, producing `-win-x64` zips that run on a machine with
nothing installed — the standalone Windows download. [portable/README-OPERATOR.md](portable/README-OPERATOR.md)
is the operator's runbook: bonding a key, public reachability, clocks,
seeds. A node that is not bonded gossips and hydrates rulesets but is
excluded from placement and cannot co-sign; `/health` says `bonded: false`.

Chain tools read the signing key from the environment and nowhere else:

```
set DEPLOYER_KEY=0x...
npm run bond -- <nodeId>                        bond another machine's node
npm run import:af -- <matchId> --post http://127.0.0.1:7801
npm run watch:af                                settle new Agent Fighter ledgers as they land
npm run anchor -- http://127.0.0.1:7801         broadcast this hour's root, verify one proof on chain
```

## Titles

| Title | Kind | Ruleset | State |
|---|---|---|---|
| Agent Fighter | replayable (`@af/core` af-core-8, bundled) | `agent-fighter.v1` | real matches settled, co-signed, anchored |
| Pickle Brawl | attested (court-signed report) | `pickle-brawl.v1` | adapter built; no live court has reported yet |
| Robot Fighting Championship (AFC) | — | — | in the cabinet; ruleset is roadmap item 2 |

## Endpoints

```
GET  /               the cabinet            GET  /snapshot     bonded fresh peers, manifests, root
GET  /health         identity, bond, chain  GET  /peers        everyone heard, freshness, clock skew
POST /queue          signed queue entry     GET  /match        frozen placement descriptors
POST /gossip         peer exchange          GET  /ruleset/:id[?build=]
POST /ledger         settle a match         GET  /ledger/:id · /delta/:id · /deltas
POST /cosign         witness signature      GET  /leaderboard · /credits · /stats
GET  /epoch[?epoch=] hour's tree + calldata GET  /proof/:matchId
```

## Honest zeroes

Kept in one place: [SPEC.md §4](SPEC.md#4-known-gaps-and-honest-zeroes).
Every release ships its list.
