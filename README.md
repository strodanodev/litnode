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

**What this is today:** a testnet arcade-node prototype with chain-based
discovery, signed updates, sandboxed title execution and replayable,
witness-verified match records, working toward community hosting and
portable game characters. Its contracts (the v2 set, deployed 19 Sep 2026
from a wallet that has never left the operator's machine) are unaudited
testnet code. It is not a production service, pays no rewards, and its
publisher-independence claim is not yet demonstrated — see
[SPEC.md §4](SPEC.md#4-known-gaps-and-honest-zeroes) and
[audit/remediation.md](audit/remediation.md).

**Operating it without a terminal** is the next piece of work: bonding,
announcer delegation, badges and operator transfer as MetaMask
confirmations on the cabinet's Nodes page, and a first-run setup page —
the same wallet flow the cabinet already uses for player sign-in
([docs/RUNBOOK.md](docs/RUNBOOK.md) is the terminal version of every step).

- [BUILD-SPEC.md](BUILD-SPEC.md) — the build plan: what is built, what is
  specified, what reports zero, and the test that proves each claim
- [SPEC.md](SPEC.md) — as-built reference: node API, ruleset interface,
  cabinet architecture, known gaps
- [docs/NODE-CABINET-SYNC.md](docs/NODE-CABINET-SYNC.md) — the contract
  between the cabinet and the node, and what is still open between them
- [docs/WALLET-IDENTITY.md](docs/WALLET-IDENTITY.md) — sign in with a
  wallet: one transaction binds the player key to a litVM profile
- [docs/HOST-YOUR-TITLE.md](docs/HOST-YOUR-TITLE.md) — put your own game on
  the mesh: the SDK, the conformance suite, and the rules of recognition
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — operator runbook: configuration,
  disputes, evidence custody, staged releases and rollback, rotating every key
- [contracts/MIGRATION.md](contracts/MIGRATION.md) — the testnet v1 → v2
  contract migration (the exposed deployer key, quorum anchoring, registry roles)
- [audit/litnode-build-review.md](audit/litnode-build-review.md) — the 17 Sep
  build audit, and [audit/remediation.md](audit/remediation.md) — what changed
  for it, what passed, what is deployed, what remains
- [CHANGELOG.md](CHANGELOG.md)

Live cabinet: **https://arcade.litvm.games**

## Layout

```
protocol/   pure, isomorphic, dependency-free — hashing, keys, log, placement,
            pairing, beacon, snapshot, epoch tree, derive, staking reads
node/       the daemon: identity, gossip, snapshot, fetch-by-hash, pairing,
            placement, settlement, witness, epoch, and it serves cabinet/ at /;
            sandbox.js + sandbox-child.mjs — where title code runs, never here
cabinet/    the frontend (static, no build step); cabinet/protocol/ is a
            generated copy of the modules it runs — npm run vendor:cabinet
sdk/        what a game developer imports: defineTitle, defineBalance,
            seededRandom; the conformance suite; the template title
titles/     defineTitle / defineAttestedTitle and the in-house adapters
rulesets/   bundled single-file rulesets, pinned by buildHash
contracts/  NodeStake, TestLITVM, ERC6699Registry, EpochAnchor + testnet addresses
tools/      create-title, bundle-title, pack, vendor, bond, release, announcer, anchor
portable/   what goes in the zips: start-node.cmd, node.env, operator README
demo/       the test suites — npm test must be green before anything ships
```

## Run

```bash
npm install            # only for the chain tools (ethers, solc); the node itself has no deps
npm test               # 19 suites, files run one at a time on purpose (~4 min; every replay is a sandbox process)
npm run node           # one node on :7801 with its dashboard; cabinet at http://localhost:7801/
LITNODE_PLAIN=1 npm run node   # one line per event instead of the dashboard (what litnode.log gets)
```

Configure with environment variables: `OPERATOR`, `PORT`, `HOST`,
`PUBLIC_ADDR`, `SEEDS` (comma list), `ROLES` (`mesh,host,witness,settler`),
`RULESETS`, `REGION`, `WS_ADDR` (the relay this node fronts), `RPC`,
`NODE_STAKE`, `OFFLINE=1` (local beacon, no stake reads). Defaults for the
chain come from `contracts/deployed.testnet.json`. Trust and limits:
`TITLE_TRUST` (`trusted` — peer builds need a signature by a key in
`TRUSTED_PUBLISHERS`; or `open`), `SANDBOX_TIMEOUT_MS` / `SANDBOX_MEMORY_MB`,
`RELAY_KEYS`, `COURTS`, `ERC6699`, `RELEASE_CHANNEL` — all in
[docs/RUNBOOK.md](docs/RUNBOOK.md).

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

**Updating a node.** Every node checks the latest signed release hourly
(`/health.update`); apply with the dashboard's `u`, the cabinet's Nodes
page (from the node's own machine), or `update.cmd`. To cut a release:
`npm run release` — packs, signs `release.json` with the release key in
`~/.litnode/release-key.json` (its public half is pinned in
`node/update.js`; a manifest signed by anything else is refused), and
publishes to GitHub Releases.

Chain tools read the signing key from the environment and nowhere else:

```
set DEPLOYER_KEY=0x...                          (or OPERATOR_KEY for anchoring)
npm run authority                               read-only: who holds what on chain, and what the exposed key still holds
npm run bond -- <nodeId>                        bond another machine's node
npm run import:af -- <matchId> --post http://127.0.0.1:7801
npm run watch:af                                settle new Agent Fighter ledgers as they land (signs with its relay key)
npm run anchor -- http://127.0.0.1:7801 <hour>  propose a FROZEN hour's root to EpochAnchor v2; final at quorum
npm run custody -- export data/<op> out.tar     builds + ledgers + deltas + frozen epochs, verifiable anywhere
npm run sign:build -- rulesets/<id>.js          vouch for a build as its publisher
```

## Titles

| Title | Kind | Ruleset | State |
|---|---|---|---|
| Agent Fighter | replayable (`@af/core` af-core-8, bundled) | `agent-fighter.v1` | real relay matches settled and co-signed (relay-attested: not official until the client signs); one anchor on the retired v1 EpochAnchor (12 Sep) |
| Pickle Brawl | attested (court-signed report) | `pickle-brawl.v1` | adapter built; no authorized court configured, none has reported |
| TUG (sample) | replayable (the SDK template) | `tug.v1` | the harness's worked example; not hosted on the desktop |
| Robot Fighting Championship (AFC) | — | — | in the cabinet; ruleset is roadmap item 2 |

## Endpoints

```
GET  /               the cabinet            GET  /snapshot[?envelopes=1]  peers, manifests, root (+ signed heartbeats)
GET  /health         identity, bond, chain, GET  /peers        everyone heard, freshness, skew, incompatible
                     sandbox, trust         GET  /whoami?nonce= proof of possession of the node key
POST /queue          signed queue entry     GET  /match        frozen placement descriptors (protocol, build, beacon block)
POST /gossip         peer exchange          GET  /ruleset/:id[?build=] · /titles
POST /ledger         settle a placed match  GET  /ledger/:id · /delta/:id · /deltas[?scope=official]
POST /cosign         witness signature      POST /dispute      witness disagreement, signed
GET  /leaderboard    OFFICIAL ladder        GET  /credits · /stats     (&scope=all for everything, labelled)
GET  /epoch[?epoch=] open or frozen batch   GET  /proof/:matchId  status finalized/open, verified, cosigners at freeze
```

## Honest zeroes

Kept in one place: [SPEC.md §4](SPEC.md#4-known-gaps-and-honest-zeroes).
Every release ships its list.
