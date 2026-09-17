# Operator runbook

What an operator does to run a litnode in the controlled multi-operator
testnet pilot, and what to do when something has to change. Everything here
is a command that exists in this repo; nothing here asks you to paste a
private key anywhere but the shell that runs one command.

## 0. Ground rules

- **Keys live in the shell, never in a file in the repo.** `DEPLOYER_KEY`,
  `OPERATOR_KEY` are read from the environment of the one command that needs
  them. The node itself holds only its ed25519 identity (`data/…/identity.json`)
  and, if delegated, an announcer key for NodeDirectory. The release key
  (`~/.litnode/release-key.json`) and the relay key
  (`~/.litnode/relay-key.json`) live outside the repo.
- **A key that was ever pasted into a chat, a ticket or a log is exposed.**
  Treat everything it controls as untrusted until rotated (§5). `npm run
  authority` tells you what that is.
- **Every node runs the same code on the same protocol version.** A peer
  on another `PROTOCOL_VERSION` is heard and listed as incompatible; it is
  never placed and never witnesses. Upgrade the fleet together (§4).

## 1. Configure (`node.env`)

| Key | What |
|---|---|
| `OPERATOR`, `ROLES`, `REGION`, `PORT`, `HOST`, `PUBLIC_ADDR` | identity and reachability (README) |
| `RULESETS` | the builds this node hosts (local files: always loaded, this is your choice) |
| `TITLE_TRUST` | `trusted` (default): builds from peers load only with a signature by a key in `TRUSTED_PUBLISHERS`; `open`: any conformant build (the sandbox is the only boundary) |
| `TRUSTED_PUBLISHERS` | comma list of publisher ed25519 keys (default: the litVM release key). Sign your own builds with `npm run sign:build -- rulesets/<id>.js` |
| `SANDBOX_TIMEOUT_MS`, `SANDBOX_MEMORY_MB` | the title sandbox's deadline (default 10 s) and heap ceiling (default 256 MB). `/health.sandbox` reports runs, kills and failures |
| `RELAY_KEYS` | relay keys whose signed submissions this host settles as `relay` provenance. `tools/af-watch.mjs` prints its key at start |
| `COURTS` | `rulesetId:key[,key];rulesetId:key` — courts this operator authorizes for attested titles |
| `ERC6699` | ERC6699Registry **v2** address; ranked characters are read from it at the placement's block. Unset until v2 is deployed |
| `RELEASE_CHANNEL` | `stable` (default) or `canary` (§4) |
| `TUNNEL`, `RELAY_PORT`, `UPNP`, `NODE_DIRECTORY`, `ANNOUNCE` | reachability and discovery (README) |

## 2. Run and watch

```bash
npm run node                     # dashboard; q quit · g gossip · l log · p peers · u update
```

`GET /health` says: `protocol`, `bonded`, `sandbox`, `trust`, `registry`,
`incompatible` (peers on another protocol), `refused` (builds refused).
`GET /peers` lists the incompatible peers by version. `GET /titles` is what
the mesh hosts. `GET /leaderboard?ruleset=` is the OFFICIAL ladder (ranked,
placed, player-signed or court-attested, independently witnessed, undisputed);
add `&scope=all` to see everything, labelled.

A **dispute** (`DISPUTED <matchId> by <witness>` in the log, `verification:
disputed` on the delta) means an independent node replayed the same ledger
and reached a different commitment. Nothing is adjudicated automatically:
the delta stays off the official ladder while disputes ≥ agreeing
co-signatures. Compare `GET /delta/<id>` on both nodes (`fields` in the
witness log names what differed), check both hold the same build hash and
the same registry block, and if the host is wrong, the host's operator is
the one to answer for it — the slashing path is designed, not automated.

## 3. Evidence

```bash
npm run custody -- export data/<operator> out.tar     # builds, ledgers (+ descriptor envelopes), deltas, frozen epochs
npm run custody -- verify data/<operator>              # every commitment recomputes; every frozen leaf matches its batch
```

Give the archive to anyone: a node started on it alone serves the deltas,
ledgers and finalized proofs (`demo/custody.test.mjs`). Epochs freeze 15
minutes after the hour; a proof reports `status: finalized` and the witness
set as of the freeze. Late co-signatures land on the delta, never on the leaf.

To anchor a frozen hour on chain (EpochAnchor v2 only):

```bash
OPERATOR_KEY=… node tools/anchor-epoch.mjs http://127.0.0.1:7801 <epochHour>
```

The root finalizes on chain when `quorum` distinct bonded operators propose
the same one; the tool reports support and refuses an open (unfrozen) hour.

## 4. Releases: staged rollout, rollback

- Publish a canary first: `npm run release -- --channel canary` publishes a
  GitHub PRERELEASE carrying `release-canary.json`; only nodes with
  `RELEASE_CHANNEL=canary` see it (they find the newest prerelease through
  the releases API; GitHub's `latest` never points at a prerelease, so
  stable nodes cannot even fetch it). Run at least one canary node per operator for a full epoch
  (an hour) and watch `/health.incompatible` on stable nodes — a protocol
  bump shows up there immediately.
- Then `npm run release` (stable). Nodes check hourly and apply on request
  (`u`, the cabinet's Nodes page from localhost, or `update.cmd`).
- A manifest names its `protocol`; a node refuses a release that would drop
  it to an older protocol.
- **Rollback:** `update.cmd --rollback` (or `POST /update {"rollback":true}`
  from localhost) restores the previous CODE from `.previous/` — one step,
  no network — and restarts. `data/`, `node.env` and logs are never touched
  by either direction.

## 5. Rotating authority

### 5.1 Release key

Generate the next key (`npm run keygen` writes a keypair; move it to
`~/.litnode/release-key.next.json`), then publish ONE release signed by the
current key that carries the rotation:

```bash
npm run release -- --rotate-to <next public key>
```

Every node that takes that manifest persists the new key
(`data/…/release-keys.json`). Swap the files, and on the following release
retire the old one: `npm run release -- --retire <old public key>`. A
manifest signed by a retired key is refused everywhere; a manifest that tries
to rotate from an unaccepted key is ignored (`demo/update.test.mjs`).

### 5.2 Operator wallet (the exposed deployer)

What it still holds: `npm run authority` (read-only; writes
`audit/authority-<block>.json`). As of block 51790431 that is NodeStake's
`slasher` and `treasury` and the operator binding of the desktop node key,
plus everything v1 EpochAnchor / ERC6699Registry leave open to anyone.

NodeStake v1 binds a node key to its first operator forever, so the clean
rotation is a **fresh v2 deployment from a new wallet** (`contracts/MIGRATION.md`):

```bash
# new wallet W2 funded with zkLTC; DEPLOYER_KEY = W2, in this shell only
npm run deploy:testnet -- --fresh --quorum 2     # v2 set; old addresses archived
npm run bond -- <nodeId>                          # every node key, from W2
npm run announcer -- <nodeId> <announcerAddr>     # re-delegate each node's announcer
```

then copy the new addresses into `cabinet/config.js` `CHAIN`, redeploy the
cabinet, restart nodes (they read `contracts/deployed.testnet.json`), and run
`npm run authority` again: the exposed address should hold nothing. With v2
in place a future rotation is one call per node
(`NodeStake.transferOperator`) and one `setParams` — no redeploy.

### 5.3 Relay key, courts, publisher keys

Generate a new key, add its public half to `RELAY_KEYS` / `COURTS` /
`TRUSTED_PUBLISHERS` on every node that should accept it, restart, then
remove the old one. Results already settled keep the key they were settled
with in `relay.id` / `attestor`; nothing is rewritten.

## 6. Bringing up a second operator

1. Install from a release zip on a machine with its own line (not the
   publisher's LAN), `ROLES=mesh,host,witness,settler`, its own `OPERATOR`.
2. Bond its key from **that operator's own wallet** (`npm run bond` with
   their key in their shell). Two nodes bonded by the same wallet cannot
   witness each other.
3. If it should be a seed, `TUNNEL=quick` or a real address, and a delegated
   announcer. Readers will challenge `/whoami` before using it.
4. Run a title relay on it if it should host gameplay (Agent Fighter:
   `run-af-relay.cmd`), `RELAY_PORT` so its `wsAddr` is advertised, and
   `RELAY_KEYS` for its watcher.
5. Check from the first operator's node: `/peers` shows it fresh, bonded,
   protocol-compatible; a placed match draws it; its co-signatures arrive.

Until step 4 exists on a second operator, the mesh has one gameplay relay
and the publisher-independence claim is not demonstrated (SPEC §4).
