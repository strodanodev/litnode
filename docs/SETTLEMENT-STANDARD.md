# The settlement standard (v4)

What every title on the litVM Games mesh must do to have a match settled,
and what the mesh promises back. This file is the **canonical settlement v4
contract**: where it differs from the shared contract handed to the title
sessions (`handoff/settlement-v4/00-shared-contract.md`), this file wins,
and §15 lists every difference. It describes what the code enforces at
protocol 4 (litnode 0.12.0).

Enforced by: `node/settle.js` (intake, logs, proof, witness),
`protocol/result.js` (the result commitment, proof rule, official rule),
`protocol/stats.js` (stat schema, values, folds, leaves), `titles/title.js`
(the title contract), `node/litnode.js` (custody draw, `/log`, `/proof/stats`),
`node/matchbook.js` + `contracts/MatchBook.sol` (chain lifecycle, anchored
root), `sdk/conformance.mjs` (admission), `sdk/court` (the court client).
Tests: `demo/settlement-v4.test.mjs`, `demo/settle.test.mjs`,
`demo/attested.test.mjs`, `demo/court.test.mjs`,
`demo/matchbook-node.test.mjs`, `demo/publisher-offline.test.mjs`.

## 1. One pipeline, four proof levels

Every title goes through the same pipeline: PLAY → REPORT → VERIFY → RESULT
HASH → RECORD. What differs is the proof level, which the node derives from
what it can check itself, commits in the result hash, and never upgrades.

| Level | `proof` | What backs it | Official ladder |
| --- | --- | --- | --- |
| L3 | `verified` | a replayable input log both players signed (`attestation: 'players'`); witnesses replay it | yes, once ranked, placed and witnessed |
| L2 | `checkable` | a log an authorized key vouched for and the mesh holds, re-runnable by anyone: an attested report whose log this node holds (sha256 = `commitments.inputsHash`) and whose verifier bundle is registered and active; or a relay-signed replayable log | no (prize-eligible once the challenge path, §11, ships) |
| L1 | `attested` | an authorized court signed a report the node checked against the title's rules | no |
| L0 | `host` | one node's word (an unsigned casual submission) | no |

`isOfficial` is unchanged: `attestation === 'players'`, verification
`verified` (an independent witness reached the same commitment and no
dispute outweighs it), ranked and placed.

## 2. One envelope

A match reaches a node as one body on `POST /ledger`, in one of two shapes.
Bridges (`sdk/bridge`), courts (`sdk/court`), gauntlet servers, the arcade
client (`sdk/client.js`) and import tools all produce one of these.

**Replayable** — the node re-runs it:

```json
{ "matchId": "<id>", "rulesetId": "<id>.v1", "buildHash": "<64 hex>",
  "mode": "ranked" | "casual",
  "participants": ["<player key>", "<player key>"],
  "entries": [ { "k": 0, "inputs": [<p0>, <p1>] }, ... ],
  "signatures": { "<player key>": "<sig over the ledger body>" },
  "relay": { "id": "<relay key>", "sig": "..." },
  "descriptor": { "...the placement envelope GET /match served..." },
  "hydration": { ... }, "expected": { "hash": "...", "endTick": 0 } }
```

The ledger body a player signs is `{ matchId, ticks, head, buildHash }`
under the `ledger` tag (in the arcade the shell signs it, `cabinet:sign`).

**Attested** — the node checks it against the rules:

```jsonc
{ "kind": "attested", "matchId": "<id>", "rulesetId": "<id>.v1",
  "mode": "ranked" | "casual",
  "participants": ["<player key>", ...], "teams": [["..."], ["..."]],
  "report": {
    // ...what the title's validate() reads...
    "commitments": {                       // v4, optional; inside the signed report
      "logFormat":    "arc-runlog@1",      // ≤ 64 chars
      "inputsHash":   "<64 hex>",          // sha256 of the EXACT log bytes, or null
      "finalHash":    "<≤ 128 chars>",     // the title's own end-state hash, or null
      "verifierHash": "<64 hex>"           // sha256('verifier' NUL tar), or null
    },
    "stats": { "<participant>": { "<name>": <non-negative integer> } }   // v4, optional
  },
  "attestor": { "id": "<court key>", "sig": "<ed25519 over 'attest' NUL canonical({matchId, rulesetId, report})>" },
  "log": "<base64 of the exact log bytes>"   // v4 nodes only (GET /health → protocol >= 4); ≤ 512 KiB decoded
}
```

- `commitments` and `stats` live inside `report`, so the court's signature
  covers them and a v3 node simply ignores them. A v4 node checks
  `commitments` (types and lengths above, else `400`) and lifts it into the
  delta as `commitments`.
- `log` is accepted only with a `commitments.inputsHash`, only as canonical
  base64, only up to `MAX_LOG_BYTES` (512 KiB), and only if
  `sha256(decoded) === inputsHash`; otherwise `400`. The bytes are kept at
  `<dataDir>/logs/<inputsHash>` and never inside the stored ledger.
- An id already settled answers `200` with the existing delta and
  `existing: true` (`sdk/court` reports it as `already`).
- Unsigned submissions (no players, no relay, no court) are budgeted per
  remote address (10 a minute, 0.11.30); a court's envelope is signed and
  not budgeted. Request bodies are capped at 4 MB.

`sdk/court` builds, checks, signs and settles the attested envelope; it
attaches `log` only when the node says `protocol >= 4`.

## 3. One identity

A participant is the player's ed25519 key (64 hex) whenever the game runs
inside the arcade (`cabinet:init` / the join ticket's `sub`, signing via
`cabinet:sign`), bound to a wallet or AIR account by `PlayerProfile`.

- **Ranked requires keys** (`ranked: participants must be player keys`).
- **A prefixed id** (`pb:`, `fc:`, `afc:`, `af:`) is allowed for casual
  play only; it never binds to a profile and never counts for rewards.

## 4. One result

Every settled match becomes a delta whose `resultHash`
(`protocol/result.js resultFields`) commits to everything a ranking or a
settlement consumes. The field set is **versioned by the delta's own
`protocol`**:

- protocol ≤ 3: protocol, matchId, rulesetId, buildHash, kind, mode,
  descriptorHash, participants, teams, seed, ticks, head, finalStateRoot,
  engineHash, hydrationHash, hydrationSource, scores, attestation, attestor,
  relay, hostId, epoch.
- protocol 4 adds: **`proof`**, **`stats`** (the cleaned per-match values,
  §9) and **`statsSchema`** (the build's `services.stats.schema`, so a
  season fold needs nothing but the deltas).

A v4 node recomputes an old delta with the old set, so custody of history
never breaks. A delta also carries `commitments` (attested, from the
report) — committed through `finalStateRoot = H('attested', { rulesetId,
report })` — and, for replayable titles, `commitments: null`.

A witness recomputes every field itself, including `proof` and `stats`,
and signs only `{ matchId, resultHash }`; a different commitment is a
signed dispute naming the fields that differ.

## 5. Deriving the proof level

`protocol/result.js proofOf()` decides, at settlement, from evidence the
node holds:

```
replayable:  attestation players → verified · relay → checkable · host → host
attested:    inputsHash && verifierHash && this node holds the log
             && the verifier is registered and active for the title  → checkable
             otherwise                                                  → attested
```

"Registered and active" is TitleRegistry's build status for
`(rulesetId, verifierHash)` (the same `setBuild` a ruleset uses), or an
operator override `VERIFIERS=<rulesetId>:<hash>[,<hash>];…`. A witness
applies the same rule with its own holdings: a custodian that could not
fetch the log computes `attested` and disputes a host that claimed
`checkable`. The level is never taken from a submitter and never upgraded
after settlement; a later registration does not relabel old results.

## 6. Placement binds a ranked match

Ranked requires a placement the mesh computed from the chain beacon: the
participants, ruleset, build, mode, seed `H(beacon, matchId)` and host are
fixed before play, signed in a descriptor, and the submission must match it
(`placed: true`, `descriptorHash` in the commitment). An unplaced submission
settles casual, `placed: false`, and never reaches official standings.

What the host binds to (0.11.31): the placement in its own book, or — once
an earlier rival for the same players replaced it, its 15 minutes ran out,
or the node restarted — the signed descriptor the client carries back from
`GET /match` (`envelope`) as the submission's `descriptor`, verified as a
witness verifies it: signature, protocol, the placing key bonded in the
live stake table or at the descriptor's pinned block, the beacon this node
holds for the bucket, and an id the beacon derives for the two players.
Where the result then goes is the chain's call: a commit under the ledger's
id is settled on chain; none, and the result stays on the host; a commit
under another id for the same players (a placement replaced after a client
had fetched it) is never settled and expires on its own after the settle
window. The book is not persisted: the ledger is the proof of placement,
the chain is the record of the commit.

Only a host with three drawn witnesses under other operators commits on
chain.

## 7. The chain lifecycle (ranked L3)

For a placed ranked match, each step from the node's delegated key:

1. `commit(matchId, descriptorHash, rulesetId, hostKey, panel[3])` before play;
2. `settle(matchId, resultHash, ledgerHash, buildHash, participants, scores, custodians)`;
3. `attest(matchId, witnessKey, resultHash)` from each seat after replaying;
4. `finalize(matchId)` (host, or a seat as the liveness backstop);
5. on a dissent, `escalate` → nine-seat draw → `resolve`; slashing through NodeStake;
6. `GasRefund.claim` by the host and the agreeing seats;
7. the hour's anchored root (§9.4) proposed to `EpochAnchor` by the settler,
   final at stake quorum.

Nothing per match is minted. XP, level, Elo, credits and stats are folds
every node reaches identically (`protocol/derive.js`,
`protocol/progression.js`, `protocol/stats.js`), served by `/leaderboard`,
`/stats`, `/progress` and `/proof/stats`.

## 8. Logs and custody

- **Held** content-addressed at `<dataDir>/logs/<inputsHash>`, only after the
  bytes hash to the committed value; **served** at `GET /log/<inputsHash>`
  (`application/octet-stream`, immutable; `404` when not held).
- **Custody of off-chain results.** A result that never reaches MatchBook
  (casual, attested, unplaced) is advertised on the gossip — bounded: the
  64 newest settled in the last day that hold fewer than 3 co-signatures.
  Its custody set is the **k = 3** nodes whose `h('custody', matchId,
  nodeId)` sorts lowest among fresh peers that run the title, excluding the
  host and its operator's other keys. Every node computes the same set from
  its own snapshot. A custodian fetches the delta, the ledger and the log
  (with timeouts), recomputes the result and co-signs or disputes.
- **Pruned** with the ledger policy: an unsigned, unplaced `host` delta is
  dropped after a day with its ledger and, if nothing else names it, its
  log. Everything else is kept for custody. `npm run host -- doctor`
  reports held logs and free disk; `/health.settlement.logs` reports count
  and bytes.

## 9. Stats

### 9.1 The schema

```js
services: { stats: { track: ['matches', 'wins', 'ticks'], schema: { rescued: 'sum', bestChain: 'max', fastestKo: 'min' } } }
```

Ops: `sum | max | min | last` (`min` skips a missing value; `last` keeps the
latest match in fold order). Names match `[a-zA-Z][a-zA-Z0-9]{0,31}`, at
most 32, and never `matches`, `wins` or `ticks` (the built-in line).
Values are non-negative safe integers. `defineTitle` /
`defineAttestedTitle` refuse a bad schema; conformance checks it.

### 9.2 Where the numbers come from

- **Replayable:** `stats(state, participants)`, run in the sandbox on the
  final state, so every witness gets the same numbers. Keep the counters in
  the state and in `serialize()`. A schema without `stats()` is refused.
- **Attested:** `stats(report, participants)`; `defineAttestedTitle`
  supplies one returning `report.stats`. A build made before `stats()`
  existed falls back to `report.stats`.
- The node keeps only the schema's names (`cleanStats`); a non-integer,
  a negative value or a stat for a non-participant refuses the submission.
  **A title with no schema lifts no stats** (§15).

### 9.3 Folds

`/stats` and `/leaderboard` fold each match's committed `stats` into the
player's line by op (`DERIVE_VERSION` 3); `/progress` lines carry `stats`
too (`PROGRESSION_VERSION` 2).

### 9.4 The hourly roots

**Anchored (with MatchBook).** For hour *h* the node anchors

```
root(h) = sha256(hex(resultsRoot) ‖ hex(statsRoot))      (results LEFT)
resultsRoot = the hour's FINAL MatchBook set, from chain events alone (unchanged)
statsRoot   = tree over leaves H('stat', { v: 1, rulesetId, player, stats, through: h })
              — each player's season line through h, folded over every FINAL
              match decided by the end of h, in Settled order, by the
              schema each delta commits
```

The `Settled` event carries no stats, so a node recovers a final match's
`stats` and `statsSchema` from a delta whose **recomputed `resultHash`
equals the chain's** (the host's, a custodian's or a panel seat's copy) and
caches it (`matchbook-stats.json`). A protocol-3 delta contributes no stats.
A node **does not propose** an hour until every final match through it is
accounted for, so every proposer folds the same set.

Proofs: a results leaf proves with its path plus `{ hash: statsRoot, left:
false }`; a stats leaf with its path plus `{ hash: resultsRoot, left: true
}`. `EpochAnchor.verifyInclusion` checks either, unchanged.

**Local (every node).** `GET /epoch` without MatchBook, and `scope=local`,
pair the node's own results tree with a season fold over its own protocol-4
results above `host` (`protocol/stats.js localSeason`). Attested and
checkable titles live here until §12 lands.

`GET /proof/stats?ruleset=<id>&player=<p>[&epoch=<h>][&scope=chain|local]`
returns `{ stats, through, leaf, path, statsRoot, resultsRoot, root }`.

## 10. Court keys

A title's court keys go in its adapter manifest's `attestors` (ed25519
pubkey hex). The array is pinned by the ruleset hash registered on
TitleRegistry, so **every node accepts the court with no `COURTS` entry**
(tested in `demo/settlement-v4.test.mjs`). `COURTS` stays an operator
override, added to the manifest's list. A valid signature from any other
key is refused (`is not an authorized court`). Court private keys live only
in the studio's managed env.

## 11. Verifier bundles, and the challenge path (phase 2, designed)

A **verifier** is a title's third hashed artifact: the headless replay its
court ran, packed like a server bundle (`node/server-bundle.js`,
`npm run bundle:verifier -- <spec.json>`): one deterministic tar,
`manifest.json` `{ kind: 'verifier', rulesetId, entry, exports: ['verify'],
logFormat, runtime, source }`, entry exporting `verify(logBytes, spec) →
{ finalHash, result }`; no env, ports or timings.
`verifierHash = sha256('verifier' NUL tar)` — the kind is in the hash
domain, so it never verifies as a ruleset or a server. Registered with
the existing `setBuild` (`npm run publish:title -- set-build
verifiers/<id>.verifier.json`). **In v4 the node only checks the hash is
registered and active; it does not run it.**

The verifier contract, settled with the Pickle Brawl and FLOOD CONTROL
hand-backs (22 Oct 2026):

- **`verify` may be async** (FLOOD CONTROL unpacks its level grid with
  `DecompressionStream`). It resolves `{ finalHash, result }`.
- **A log that does not replay throws** (`refused: <reason>`). A challenge
  runner counts a throw as "does not reproduce the committed `finalHash`",
  the same as a different hash: the court committed a log its own verifier
  refuses.
- **Manifest fields.** Required: `kind`, `rulesetId`, `entry`, `exports`,
  `logFormat`, `runtime`, `source`. Standard optional: `finalFormat` (the
  name of the `finalHash` preimage, e.g. `arc-final@1`), `levels` (data the
  bundle embeds), `source.esbuild`. Anything else is ignored. **No commit
  and no time inside the hashed manifest**; the sidecar carries both, so the
  commit that records a hash does not change it (`tools/bundle-server.mjs`
  since 0.12.0, which also bundles from the checkout's own directory so a
  hash is the same on every machine).
- **`runtime`** is `{ node, memoryMb?, timeoutS? }`. The phase-2 runner
  gives every `verify()` call **its own process** (an engine may boot one
  session per process: Pickle Brawl's does), honours the manifest up to the
  ceilings **`memoryMb ≤ 2048`, `timeoutS ≤ 900`**, and refuses a bundle
  that asks for more. Pickle Brawl declares `{ node: ">=22", memoryMb: 1024,
  timeoutS: 600 }`; FLOOD CONTROL `{ node: ">=20" }`.
- **How the bytes travel:** like server bundles. A node that holds a
  verifier serves it by hash (`GET /verifier/<rulesetId>?build=<hash>`,
  advertised in the heartbeat), the publisher's node first, and a
  challenge seat fetches it from any peer and checks the hash before it runs
  anything. The route and `VERIFIER_BUNDLES=<rulesetId>=<file.tgz>` land with
  the phase-2 runner. Until then the publisher keeps the `.tgz` and its
  sidecar beside the registration (for example, release assets).
- **Committing before registering.** A court may name `verifierHash` from
  its first deploy. Results settled before the hash is registered and
  active settle `attested` and stay so; results after it are `checkable`. A
  verifier is a `setBuild` like any other, so the title's
  `activationDelay` applies to it.

Phase 2 (not built): a challenge.

1. Anyone posts `challenge(matchKey, verifierHash)` with a bond against an
   L2 result inside its window (a new MatchBook-like contract, or a MatchBook
   extension for off-chain results anchored per §12).
2. The escalation panel's seats fetch the verifier by hash and the log by
   `inputsHash` from the custody set, run `verify` in a separate process
   **outside the sandbox budget** (a verifier may need WASM, more memory and
   minutes, e.g. AFC's Rapier), with its own limits per manifest `runtime`.
3. Each seat attests `finalHash` and `result`; disagreement with the court's
   `commitments.finalHash` slashes the court's publisher bond
   (docs/PUBLISHER-BONDS.md §5) and voids the result; agreement forfeits the
   challenger's bond. Only then is L2 prize-eligible.

## 12. Anchoring L1/L2 results (phase 2, designed)

v4.0 anchors only what every node can compute from chain data: the L3
results and their stats (§9.4). Off-chain results are custodied (§8) and
committed in each node's local root, but two nodes may hold different
sets, so they cannot share a stake-quorum root. The design for generation 4
contracts: each host posts one `commitHostRoot(epoch, root, nodeKey)` per
hour over its own off-chain results (one transaction per host per hour, no
per-match record), and the anchored stats root folds every committed host
root's results — deterministic from chain events again. Until then,
FLOOD CONTROL, Pickle Brawl and AFC stats are provable against a node's
local root, not against EpochAnchor.

## 13. The title's side

A title ships, pinned by hash on its `TitleRegistry` token:

- **a ruleset** — one import-free module: `defineTitle({...})` (replayable)
  or `defineAttestedTitle({...})` (attested), with `services.stats.schema`
  and `stats()` when it keeps stats, `attestors` when it has a court;
  `npm run conformance`, `npm run bundle:title`;
- **a server bundle** when its match server is a process
  (`npm run bundle:server`, `GAUNTLET_SERVERS`; a trusted process, admitted
  by registration plus the operator's opt-in);
- **a verifier bundle** when its court replays (`npm run bundle:verifier`).

A consensus-relevant change (sim, adapter, validator, stat derivation) is a
new build hash. Old results are never relabelled.

## 14. Conformance of the titles (0.12.0, after the 22 Oct hand-backs)

| | Agent Fighter | Pickle Brawl | FLOOD CONTROL |
| --- | --- | --- | --- |
| Kind / level | replayable, L3 | attested; L2 once its verifier is registered | attested; L2 once its verifier is registered |
| Build | `859e7215…76da` (af-core-8, signed); af-core-9 builds to `290200cf…7691` | `98d23e4e…90d1` | `b16bc0a2…1977` |
| Identity | keys. The relay is casual-only and records a key only after its ledger signature verifies | keys for arcade-placed matches, and for matchmaker matches whose AIR profile holds the key; `pb:` otherwise | the arcade key when the shell signs the run (`cabinet:sign-run`); `fc:` otherwise |
| `attestors` | — | court `09b2b849…7e23` | court `f82a5ef3…da87` |
| Stats schema | kos, roundsWon, perfectRounds, damageDealt, supersLanded, throwTechs (sum); maxCombo (max); fastestKo (min, absent without a KO) | pointsWon, aces, winners, unforcedErrors, smashes, dinks, matchesMvp (sum); longestRally (max) | points, bestChain (max); stars, rescued, casualties, keptDry (whole percent), stormsSurvived (sum) |
| Commitments / log | n/a (the ledger is the log) | `pb-court-inputs@1`, `pbstate1:` finalHash, verifier `pickle-brawl.v1` | `arc-runlog@1`, `arc-final@1` finalHash, verifier `56cfff04…0a57` |
| Server bundle | gauntlet, `npm run bundle:server -- gauntlets/agent-fighter.server.json` | court (`gauntlets/pickle-brawl.json`, checkout) | none (Vercel board) |
| Chain lifecycle | ranked through the gauntlet only | not yet | casual only |

AFC joins later: attested, `hmc-match@2` log, L2 planned (§13 applies
unchanged).

**Hashes that move with this release.** Pickle Brawl's verifier was packed
before `bundle-server.mjs` dropped the commit from the hashed manifest, so
its court must repack (`node services/court/verifier/bundle.mjs`) and name
the new hash before anyone registers `58e4f0b6…`. FLOOD CONTROL builds its
own tar without a commit, so `56cfff04…` stands. Agent Fighter's registered
server bundle `00f7319c…` is superseded by the af-core-9 server; rebuild it
here.

## 15. Deviations from the shared contract (for the title sessions)

1. **`statsSchema` is committed** beside `stats` in a protocol-4 result, so
   a season fold needs only deltas. Courts send nothing new for it.
2. **Stats are lifted only for a title with a schema.** Without
   `services.stats.schema`, `report.stats` is ignored (no ops to fold by).
3. **Stats leaves are season lines**, `H('stat', { v, rulesetId, player,
   stats, through })`, cumulative through the hour, in one flat tree (not a
   tree per title); `rulesetId` is in the leaf.
4. **The anchored root covers L3 only in v4.0** (§9.4, §12). L1/L2 stats are
   proven against a node's local root until gen-4's host roots.
5. **Commitment field rules:** `logFormat` ≤ 64 chars, `finalHash` a string
   ≤ 128 chars, `inputsHash` / `verifierHash` 64 lowercase hex or null.
6. **A relay-signed replayable result is `checkable`**, not `verified`.
7. **`existing: true`** marks the answer to an id already settled.
8. **FLOOD CONTROL's adapter derives stats** from the report's own integers
   when `report.stats` is absent, so today's runs fold before the court
   upgrades.
9. **No log, no `commitments`.** `logFormat` must be a string, so a court
   with nothing recorded omits `commitments` entirely; there is no all-null
   form (Pickle Brawl's pattern).
10. **Prefixed seats keep stats lines**, e.g. under `fc:<handle>`, on the
    title's own ladder. They are casual, never bind to a profile and never
    count for rewards (§3).
11. **A single-player run seats the arcade key** through the shell's
    `cabinet:sign-run { body: { rulesetId, inputsHash } }` →
    `cabinet:run-signed { inputsHash, player, sig }`, with
    `sig = sign('run', { rulesetId, inputsHash })`. The shell signs only
    under the launched title's `rulesetId`. The court checks it with
    `sdk/court verifyRun` before it names the key as the seat.
12. **`sdk/court` additions (0.12.0):**
    - `settle(…, { oversizeLog: 'skip' })` settles without a log past
      512 KiB (`logSkipped: 'oversize'`), keeping the commitment, so the
      result is `attested`.
    - With `node: 'auto'`, `settle` reuses the last settler for `cacheMs`
      (default 5 min) and tries up to `fallbacks` (default 2) other
      candidates when one is unreachable or has no settling role.
    - `signRun` and `verifyRun`.
    - `Fetch` accepts the global `fetch` without a cast.
    - Re-vendor at release.
13. **A publisher's matchmaker may pass a proven `key` per seat** to
    `POST /gauntlet/direct`. It reaches `LITNODE_SEATS` and the seat's
    ticket.
14. **A title's process inherits an allowlist of the node's environment**
    (OS and runtime basics only). Anything else goes in its gauntlet config
    `env`, or by name in `inheritEnv`.
15. **`GET /delta/<id>?chain=1` carries `chain` and `official`** like `/deltas` (witnesses read the bare delta), and
    **`GET /deltas?player=<id>`** keeps one player's results. The arcade's
    `contracts.json` names the `explorer`.

## 16. Upgrading from protocol 3

Protocol 4 nodes and protocol 3 nodes exclude each other (they would
compute different result hashes). The rollout:

1. Publish and register the 0.12.0 release (`npm run release`, then
   `npm run release:registry -- register dist/release.json`); register the
   rebuilt Pickle Brawl and FLOOD CONTROL rulesets
   (`npm run publish:title -- set-build rulesets/<id>.v1.js`) in the same
   window, or sign them (`npm run sign:build`).
2. Every operator applies it within the same hour (the Nodes page, `u` in
   the dashboard, or `npm run update`): a node left on 0.11 is alone on its
   own protocol until it updates. Ranked play pauses while fewer than four
   operators are on 4.
3. Courts keep posting v3-shaped reports (they settle at `attested`); they
   add `commitments`, `stats` and `log` through `sdk/court`, which reads
   `/health.protocol`.
4. Redeploy the arcade after the desktop node runs 0.12.0.

## 17. Change control

The protocol version (`protocol/version.js`, 4) is in every signed body and
in the result commitment. A change to any shape above, to the result fields,
to the proof or provenance rules, to the official rule, or to the anchored
root is a protocol bump, noted in CHANGELOG under the release that ships it.
A rename in this file is announced to the title sessions. Titles are
certified by the conformance suite, not by review.
