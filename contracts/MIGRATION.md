# Generation 4: testnet generation 3 → 4 (the 21 Oct 2026 audit's contract findings)

Source written and tested 21–22 Oct 2026 (`demo/ed25519-vm.test.mjs`, `demo/gen4-vm.test.mjs`); **not deployed**.
Generation 3 stays live until the steps below run; the node, the tools and the cabinet work against both
(they ask `version()`: generation 4 answers `4`, generation 3 has no such function and the call reverts).

## Why — and what changed

`audit/audit-2026-10-21.md` §4.2 lists five contract findings; §7 item 3 asks for generation 4 before an external audit.

| contract | finding (audit §4.2) | generation 4 |
|---|---|---|
| `NodeStake` | **1, medium.** `stake(nodeKey, amount)` takes no proof that the caller holds the ed25519 key and any amount above zero; the first caller is operator forever (`withdraw` never clears it). A node key is public in gossip before it bonds, so one wei of faucet token squats it and the real operator must rotate identity. | **`bond(bytes32 nodeKey, uint256 amount, bytes sig)`** is the only first binding: `amount ≥ minStake`, and `sig` is the node key's ed25519 signature over `"litnode-bond-v1" ‖ 0x00 ‖ abi.encodePacked(uint256 block.chainid, address(this), address msg.sender)` — 88 bytes, `bondMessage(operator)` returns them. Verified on chain by `contracts/Ed25519.sol` (RFC 8032; SHA-512, strict decoding, S < L, small-order keys refused; about 404k gas for the verification, about 565k for the whole `bond` transaction). The proof names chain, contract and operator, so it replays for nobody else. `stake()` now only tops up a key that is already bound (`NotBound` otherwise; `NotOperator` from another wallet). A withdrawn bond keeps its operator, who re-bonds with `stake()`. New: `Bound` event, errors `NotBound`, `AlreadyBound(operator)`, `BadProof`, `BelowMinimum(minStake)`, `version()`. |
| `NodeDirectory` | **2, medium.** Announcing needs only operator standing (one wei); `_keys` is append-only and `keys()` returns it whole; every bootstrap and arcade seed search does two `eth_call`s per key against a gateway that 429s at ~25 req/s, and the arcade fails closed. | `announce` requires the key ACTIVE with `amount ≥ NodeStake.minStake()` (`NotBonded`); **`keysPage(uint256 offset, uint256 limit)`** + `count()` page the list. `keys()` is **kept**: readers already in the field (publishers' `sdk/bridge` `resolveNode`, `tools/authority.mjs`, node releases ≤ 0.11.x) call it on whatever address `contracts.json` names and would lose discovery at the flip. New readers page through `protocol/directory.js readDirectoryKeys` (falls back to `keys()` on generation 3) and read entries through a bounded pool (`mapLimit`, `READ_CONCURRENCY`). |
| `MatchBook` | **3, medium.** `enroll` needs only `mayActFor`; `escalate()` walks the whole pool with external calls; a few thousand junk enrolments push it past the block gas cap and every dispute dies by expiry. **5, low:** no exit from `Escalated` if `resolve` reverts. | `enroll` requires `witnessEligible(key)` NOW and `poolSize() < maxPool` (`NotEligible`, `PoolFull(maxPool)`); `maxPool` is an admin parameter (default 256, `setMaxPool`, at most `MAX_POOL_CAP` = 1024). Permissionless **`prune(nodeKey)`** drops an enrolled key that is no longer ACTIVE (unbonding, withdrawn, below `minStake`); a key inside its eligibility age after a top-up stays (`StillActive`) — pruning it would let anyone evict an operator for adding stake, and the draw skips it anyway. **`expire` has an `Escalated` branch:** after `escalatedAt + 2 × escalationWindow` anyone voids a seated escalation nobody resolved (a `resolve` that reverts — a stake token whose transfer fails — no longer pins a match). `totalWindow()` = settle + 2 × attest + **3** × escalation accordingly. A full pool of 256 keys escalates in about 2.5M gas (measured in `demo/gen4-vm.test.mjs`). The two September attacks `demo/matchbook-vm.test.mjs` executes stay closed. |
| `EpochAnchor` | **4, medium.** `propose` accepts future epochs and a finalized anchor is immutable; quorum stake could pre-finalize garbage for every future hour. | `propose` reverts `EpochNotOver(epoch)` for `epoch ≥ block.timestamp / 3600`. Nothing else: the node anchors `pairHash(resultsRoot, statsRoot)` with the existing positional `_pair`, which `verifyInclusion` already walks. |
| `NodeBadge`, `GasRefund` | — | unchanged source; redeployed against the generation-4 NodeStake / MatchBook (their reader interfaces are unchanged). |
| `PlayerProfile`, `ERC6699Registry`, `ReleaseRegistry`, `TitleRegistry`, `TestLITVM` | — | unchanged; redeployed with `--fresh` so one `deployed.testnet.json` describes one coherent set (titles re-minted, profiles re-registered — testnet). |

### Honest zeroes that generation 4 does NOT fix

- **`GasRefund.withdraw(to, amount)` lets its admin drain the treasury.** On testnet that admin is the deployer EOA
  `0x04bE…a378` (it is also admin of every other contract). Until a multisig behind a timelock holds `admin`, one
  key can empty the refund treasury, change every parameter, name adjudicators (who can slash) and register
  releases. BUILD-SPEC §16 must say so (audit §7 item 3).
- **The anchor is a quorum-majority statement.** A finalized EpochAnchor root proves that nodes holding
  `quorumBps` of the active stake committed to it — not that it is correct; that quorum can still finalize a
  wrong root for an hour that HAS ended.
- **Pool capacity is first-come.** `maxPool` keys at `minStake` each fill the escalation pool; the admin can raise
  the cap (to 1024) and `prune` clears inactive keys, but a well-funded squatter that stays bonded holds its seats.
  The draw still seats one key per operator.
- **A small-order or non-canonical key cannot bond, a mixed-order one can** — harmless for possession (its
  holder signed), noted for completeness.

## Deploy order (`npm run deploy:testnet -- --fresh`; the tool's `GENERATION` is now 4)

1. `npm test` green, including `demo/ed25519-vm.test.mjs` and `demo/gen4-vm.test.mjs`. `npm run authority` → snapshot of generation 3.
2. Check `contracts/deploy.testnet.json`: `NodeStake.unbondingPeriod` must exceed `MatchBook.settleWindowS + 2 × attestWindowS + 3 × escalationWindowS` (live values 1800 + 600 + 900 = 3300 < 3600 ✓). Optional `MatchBook.maxPool` (the tool calls `setMaxPool` when admin is the deployer).
3. `DEPLOYER_KEY=<admin> npm run deploy:testnet -- --fresh --quorum 5000` archives the generation-3 file as `deployed.testnet.<timestamp>.json` and deploys, in order: TestLITVM → **NodeStake v4** (with `Ed25519.sol` compiled in; no library to link) → ERC6699Registry → **EpochAnchor v4** → PlayerProfile → NodeBadge → **NodeDirectory v4** → ReleaseRegistry → TitleRegistry → **MatchBook v4** → GasRefund; names MatchBook an adjudicator on NodeStake; bonds the local node with `bond()` — the tool reads the node identity it already uses (`$LITNODE_DATA` or `data/node-1`, `identity.json`) and signs the proof itself. Records `generation: 4` and `version: 4` on the four changed contracts. (Dry run of exactly this: `demo/deploy.test.mjs`.)
4. Fund GasRefund from the treasury (plain transfer), as for generation 3.
5. Register the current release (`npm run release:registry -- register …`), `node tools/vendor-cabinet.mjs`, `npm run release` + register, redeploy the cabinet — the generation checklist below applies unchanged.

## What every operator must redo

Bonds do not migrate (generation 4 is a new NodeStake). **Every node re-bonds with a proof**:

- **The node's own machine holds the key, so it makes the proof:** `node tools/bond-node.mjs --sign <operator wallet>` prints the 64-byte proof (and the 88-byte message) — the key never leaves the machine. Then from the operator's wallet: `DEPLOYER_KEY=… node tools/bond-node.mjs <nodeId> --proof <sig>`; on a machine that holds both, `node tools/bond-node.mjs <nodeId>` signs from the local identity directly.
- **AIR operators** (`/air/bond`): unchanged for them — the node signs the proof for its proxy wallet itself (`node/proxy.js`).
- **MetaMask from the Nodes page:** needs the node's proof (see "cabinet" below); until the node route exists, use `--sign` + `--proof` as above.
- Then, as for generation 3: delegate the hot key (`npm run delegate`), re-delegate the announcer on NodeDirectory, and let the node enrol itself — on generation 4 the node waits until the key is witness-eligible (`eligibilityAge` after the bond) before it sends `enroll`, since an ineligible enrol reverts.
- Escalation-pool seats are capped (`maxPool`); a node that finds the pool full stays out until someone `prune`s an inactive key or the admin raises the cap.

## What the node, tools and cabinet need

| part | change (this commit) | still needed |
|---|---|---|
| `protocol/staking.js` | `BOND`, `VERSION`, `BOND_TAG`, `bondMessage(chainId, contract, operator)`, `bondProof(privateKey, …)`, `bondCalldata(nodeKey, amount, sig)`, `versionCall`, `decodeVersion`; vendored to the cabinet | — |
| `protocol/keys.js` | `signRaw(bytes, privateKey)`, `verifyRaw(bytes, sig, publicKey)` (WebCrypto; raw bytes for messages that carry their own domain tag) | — |
| `protocol/directory.js` | `KEYS_PAGE`, `COUNT`, `keysPageCall`, `countCall`, `readDirectoryKeys` (pages, falls back to `keys()`), `mapLimit`, `READ_CONCURRENCY` | — |
| `node/chain.js` | the directory reader pages | — |
| `node/matchbook.js` | auto-enrol waits for `witnessEligible` | — |
| `node/proxy.js` | `/air/bond` bonds with `bond()` + the node's own proof on generation 4 (`signBond` option, or the node's `identity.json` for its `nodeId`), `stake()` on generation 3 | `node/litnode.js` may pass `signBond` explicitly |
| `tools/deploy-contracts.mjs` | `GENERATION = 4`, compiles `Ed25519.sol`, bonds with a proof, 3 × escalation in the window check, `maxPool`, `--only` works beside any generation | — |
| `tools/bond-node.mjs` | `--sign`, `--proof`, `--identity`; detects the generation | — |
| `tools/params.mjs` | `totalWindow` with 3 × escalation on generation 4 | `setMaxPool` is not in it yet |
| `cabinet/seeds.js` | pages the directory; per-key reads bounded (2 keys = 4 calls in flight); one failed key no longer empties the list | — |
| `cabinet/nodeops.js` | `stakeGeneration()`, `bondProofMessage(from)`, `bond(…, { proof })` sends `bond()` on generation 4 and refuses without a proof | **TODO(gen-4 bond proof):** a loopback-only route on `node/litnode.js` that signs `bondMessage(chainId, NodeStake, operator)` with the node key, and the Nodes page fetching it before `bond()` |
| `sdk/bridge` `resolveNode` | pages the directory | — |
| `node/litnode.js`, `node/settle.js` | none in this change | the proof route above; `/health` may report `version()` |

# Contract migration: testnet v2 → v3 (Settlement v1.0, phase 1 — no single key)

BUILD-SPEC v0.3 §2.2–2.4. Prepared 21 Sep 2026; executed 22 Sep 2026 (records below).

## Why

| contract | v2 problem | v3 change |
|---|---|---|
| `NodeStake` `0x53822d9a…` | a bond can leave the moment a bad result finalizes (`unstake()` any time); a key bonded a minute ago can witness; one `slasher` WALLET (W2) can cut any bond; the node has no on-chain key of its own, so per-match settlement transactions (phase 2) have nowhere to come from | `lockTerm` (unstake refused before `bondedSince + lockTerm`); `eligibilityAge` and `witnessEligible()`; `setDelegate()` — the hot key the node runs with, gas only; `slash()` only by `adjudicators` (contracts named by `admin`), no slasher address; `admin` meant for a multisig behind a timelock, `adminIsContract()` reported on `/health`; `nodeOf()`; `totalActive` for stake-weighted quorum. `standingOf` unchanged. |
| (new) `ReleaseRegistry` | one release key ships code to every node within the hour | a release zip's sha256 must be registered by `admin` and be active (`activationDelay` after registration) before a node applies it; `revoke()` is immediate. Node gate in `node/update.js`. |
| `EpochAnchor` `0x87d9fB5F…` | a COUNT of distinct operators finalizes a root (one entity funding N stakes manufactures it); only the operator's cold key may propose; each node's tree is over its own hosted matches, so roots never agree | v3: the delegate proposes; support is bonded stake; finalizes at `quorumBps` of `totalActive`; the tree is over the chain-finalized MatchBook set so every node's root agrees; the settler proposes by itself. `--quorum` is now basis points (default 5000). |
| (new) `MatchBook` | — | every ranked match on chain: commit → settle → attest ×3 → finalize, escalation to nine, slashing through NodeStake (BUILD-SPEC §11). Named an adjudicator by the deploy tool when the deployer is admin. |
| `NodeDirectory`, `NodeBadge` | bound to NodeStake by address | redeployed against NodeStake v3 (their reader interface is unchanged; `demo/contracts.test.mjs` asserts it). |
| `TitleRegistry` | — | publisher rules and auth — a separate workstream; deployed by the same tool. |
| `PlayerProfile`, `ERC6699Registry`, `TestLITVM` | no change | redeployed only so one `deployed.testnet.json` describes one coherent set (`--fresh`). Profiles registered on the v2 PlayerProfile must be re-registered — testnet only. |

Bonds do not migrate: v3 starts every lock from the new `stake()`. Every node
re-bonds from its operator wallet, which is the point — the lock is the bond's
history on the contract that enforces it.

## Procedure

1. `npm test` green, including `demo/contracts.test.mjs`.
2. `npm run authority` → `audit/authority-<block>.json` (who holds what on v2).
3. Decide `admin`. With a multisig behind a timelock: put its address in `contracts/deploy.testnet.json` `admin`. Without one: leave `null`; the deploy tool warns, `/health` says `admin: eoa`, and this is written down in §16 until it changes.
4. `DEPLOYER_KEY=<W2> npm run deploy:testnet -- --fresh --quorum 5000` (dry-run of exactly this command: `demo/deploy.test.mjs`)
   - refuses if `NodeStake.unbondingPeriod ≤ MatchBook.settleWindowS + attestWindowS + escalationWindowS` (the windows in the config are phase 2's plan; the invariant holds from today),
   - deploys TestLITVM, NodeStake v3, ERC6699Registry, EpochAnchor v3, PlayerProfile, NodeBadge, NodeDirectory, ReleaseRegistry, TitleRegistry, MatchBook (named an adjudicator),
   - bonds the local node key from W2 (the lock starts now),
   - writes `deployed.testnet.json` with `NodeStake.version: 3`, `lockTerm`, `eligibilityAge`, `admin`, `ReleaseRegistry`.
5. Bond every other node from its operator's wallet (`npm run bond -- <nodeId>`).
6. Delegate each node's hot key: `npm run delegate -- <nodeId> <announcerAddress> --fund 0.005` (the announcer key the node already holds is the natural delegate; NodeDirectory's own `setAnnouncer` is still needed until phase 2 folds it into the delegate).
7. Register the current release: `npm run release:registry -- register <release.json>` (or `--calldata` for the multisig). Nodes on this build will refuse the NEXT release until it is registered and active.
8. `node tools/vendor-cabinet.mjs` (regenerates `cabinet/contracts.js` + `contracts.json` from `deployed.testnet.json` — `config.js` has no addresses of its own; the cabinet test fails until this is run), then `npm run release` + register, then redeploy the cabinet (`vercel deploy --prod --yes` in `cabinet/`). **Every reader follows from those three:** nodes serve `/cabinet/contracts.json`, the arcade serves `https://arcade.litvm.games/contracts.json`, the cabinet hands the set to every launched title in `cabinet:init.chain`, and Agent Fighter's client reads it at boot (its baked pair is the last resort; its CI, `tools/check-contracts.mjs`, goes red until the pair is bumped). Then `npm run fleet -- relay --arcade`: the client's whole path — set → directory → bonded relay → WebSocket — must print "a title finds the mesh". What this replaces: on 21 Sep the generation-3 deploy left the client's hand-copied v2 pair in place, and every launch the desktop did not host said SERVER OFFLINE for a day.
9. Enrol each node in the MatchBook witness pool from its delegate (a tool for this is not written yet: `enroll(nodeKey)` via `protocol/matchbook.js enrollCalldata`), then restart nodes. `/health` shows `bond.eligible` flipping to true after `eligibilityAge`, `matchBook.delegated`, `update.registry`, and `admin`. A ranked match from *Find match* then appears as `/match/:id/chain` → committed, settled, attested, final.
10. `npm run authority` again; record both snapshots below.
11. When the multisig exists: `setParams(...)` on NodeStake and `setParams(admin, delay)` on ReleaseRegistry from W2, handing `admin` over; `transferAdmin` on ERC6699Registry and EpochAnchor. Then W2 holds nothing but node bonds.

## Generation checklist — what must move together

A generation flip touches one file (`deployed.testnet.json`, written by the deploy tool); everything else is
derived or checked. If any of these is skipped, some reader keeps the OLD addresses and resolves entries nobody
updates any more:

| reader | how it gets the set | what catches drift |
|---|---|---|
| node (`node/cli.mjs`) | reads `contracts/deployed.testnet.json` at start | the release zip carries the file; `deploy.test.mjs` |
| cabinet (`config.js CHAIN`) | `cabinet/contracts.js`, generated by `tools/vendor-cabinet.mjs` | `demo/cabinet.test.mjs`: every address equals the deployed one; `config.js` carries no literal |
| standalone titles (Agent Fighter's `mesh.ts`) | `cabinet:init.chain` when launched from the cabinet; else `https://arcade.litvm.games/contracts.json`; else its baked pair | AF CI `tools/check-contracts.mjs` vs litnode master; `npm run fleet -- relay --arcade` |
| a node's relay entry on NodeDirectory | announced only after a WebSocket opened through the tunnel; withdrawn when it stops (`/health.relay`) | `demo/tunnel.test.mjs`; `npm run fleet` shows `relay … UP` |
| docs, skills, memory | by hand | `grep -rn 0x… docs/` after a flip |

## Records (v3)

| when | what | block | file |
|---|---|---|---|
| 2026-09-21 | v3 contracts written and compile-tested; not deployed | — | `demo/contracts.test.mjs` |
| 2026-09-22 | first `--fresh` run RESUMED the v2 set (the old resume test was "file carries `migratedFrom`", which the v1→v2 move had left): ReleaseRegistry `0xF2dbcdc6…` and MatchBook `0xAbA3A0e2…` deployed against NodeStake **v2** — abandoned, unusable. Tool fixed: generations are explicit (`generation: 3`), a v2 file is archived. | — | `deployed.testnet.2026-09-19T08-19-23-550Z.json` (the archived v2 set, carrying the two strays) |
| 2026-09-22 | **generation 3 deployed** from wallet `0x04bE2b954346324Ee54c4B4c0189DF5bb577a378` (admin + treasury of every contract; an EOA — `/health` says `admin: eoa`): TestLITVM `0x263dc221445901a4954e879AaAf18cfc547cc330`, NodeStake v3 `0x3CFe2D006d946A1E0E5Cf6B3E0958aFc3fF73717`, ERC6699Registry `0x38DF2543e039E775D3f674f7414df43e4eF2f883`, EpochAnchor v3 `0x919e9500785ab077d2058490a465F05bD8238a64` (quorum 5000 bps), PlayerProfile `0xe2cf46ab11eAfB18c1933409E35ae68CEce88882`, NodeBadge `0x6129faE9c919dbDEC778b127DB3b12002D0d9a3a`, NodeDirectory `0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df`, ReleaseRegistry `0x1a647C99625F3D6576657854E4a52507Db759555` (delay 60 s), TitleRegistry `0x4A0de8EB216CC4445A767ed25c4f154d0f904489` (publisher-auth workstream), MatchBook `0x90D642d1f1Cb00EBFeB2268dd13Dee32A2852e5b` (named an adjudicator) | 52951358 ± | `deployed.testnet.json` (current) |
| 2026-09-22 | desktop node `5b703f12…` bonded 1 tLITVM on NodeStake v3 from `0x04bE…a378` — locked until 2026-09-20T22:44:02Z, witness-eligible from 22:36:02Z. Its v2 bond (from W2 `0x7cE7…D27`) stays on the archived set. | — | — |
| 2026-09-22 | desktop node `5b703f12…`: delegate `0x7467246301DF4e45c446a98AcB037c85315b560d` set on NodeStake v3 and funded, re-delegated as announcer on NodeDirectory v3, enrolled in the MatchBook pool (1 enrolled). Authority snapshot after: no wallet can slash; every admin = `0x04bE…a378` (EOA) | 52967595 | `audit/authority-52967595.json` |
| 2026-09-22 | TitleRegistry moved with the set (`0x4496…64DB` on v2 → `0x4A0d…4489` on generation 3). Titles minted on the v2 registry are not carried over: re-mint with the publisher tool. | — | — |
| 2026-09-22 | **First ranked match FINAL on Liteforge.** Match `118c53a280ca…`, host desktop `5b703f12…`, panel Ally `9054aac9…` + witness-2 `2c58bb97…` + m16 `3b358f54…` (four staking addresses). Committed tx `0x3c3132408830d4bd1793904e5605cafcc6195b4759aca722fff6028d8f21a100` 18:49:55Z → settled on chain 18:50 → three attests, each from another machine's delegate, all agreeing → Finalized 18:51:19Z. resultHash `c65bd3ba8320…`. Both local nodes fold the same chain ladder (digest `6e7f8bb5c053`). Nodes on 0.11.6/0.11.7. | — | `/match/118c53a2…/chain` on any node |
| 2026-09-21 19:15Z | **First automatic anchor.** Epoch 497226 (the hour of the match above) froze at 19:15:00Z; the desktop settler proposed its root 23 s later with no operator step (tx `0xaa2b2ded7649d55d0a9856e2ebd235379b5cd5f1b69e08051eba8fc1a8eae803`, block 53247698) and `rootOf(497226)` on EpochAnchor v3 `0x919e…8a64` reads `0x103ad9c6228f31d0b9ccf62b1090758e7411118cc76a539be3745dcc24d5434c` — finalized. The node's `/proof/118c53a2…` names the same root (a one-leaf tree: leaf = root). |
| 2026-09-22 | cabinet/config.js `CHAIN` → generation 3 (NodeStake, TestLITVM, EpochAnchor, MatchBook, PlayerProfile, NodeBadge, NodeDirectory). Not yet redeployed to Vercel. | — | — |

---

# Contract migration: testnet v1 → v2

## Why

The 17 Sep 2026 build audit found, on the deployed v1 set (Liteforge, chain 4441):

| contract | v1 problem | v2 change |
|---|---|---|
| `EpochAnchor` `0x09fBf6A5…` | any address may write the first non-zero root of any epoch; no quorum, no finalization rule | `propose(epoch, root, nodeKey)` only by the operator of an actively bonded node key; one proposal per operator per epoch; finalizes when `quorum` distinct operators proposed the same root; conflicting roots visible via `support()`; `admin` sets quorum |
| `ERC6699Registry` `0x66cef65F…` | anyone may `forge` any unused id with arbitrary stats; `equip` checks control of the character, not ownership of the item; no config hash, no nonces, no progression path | `forge` by MINTER only; `progress(tokenId, stats, expectedNonce)` by PROGRESSOR only, bumping `statsNonce`; `characterConfigHash` + `manifestNonce` in the manifest, changed only by the controller; `equip` requires the character's owner to own the item on its collection; explicit `ownerOf` / `balanceOf` / `transferFrom` |
| `NodeStake` `0x11C984bE…` | the first staker is a key's operator forever; slasher/treasury are the exposed deployer | `transferOperator(nodeKey, to)`; slasher/treasury set to the new wallet at deploy |
| `NodeDirectory`, `NodeBadge` | bound to NodeStake by address | redeployed against the new NodeStake |
| `PlayerProfile`, `TestLITVM` | no privileged role; no change | redeployed only so one `deployed.testnet.json` describes one coherent set |

And the deployer key that holds NodeStake's slasher/treasury and the desktop
node's operator binding was exposed in a chat transcript. v1 NodeStake cannot
move an operator binding, so the rotation IS the redeploy.

## Procedure (executed 19 Sep 2026 — steps 1–3, 5 and 7 done for the desktop; 4 (laptops), 6 (cabinet redeploy, after 0.8.0), 8 (re-run authority: done, 0 holdings), 9 (roles) pending)

1. Snapshot who holds what now: `npm run authority` → `audit/authority-<block>.json`.
2. Create wallet W2; fund it with zkLTC (faucet). Never paste its key anywhere but the shell.
3. `DEPLOYER_KEY=<W2> npm run deploy:testnet -- --fresh --quorum 2`
   - archives the current file as `contracts/deployed.testnet.<timestamp>.json` (the migration record),
   - deploys TestLITVM, NodeStake(v2 code), ERC6699Registry v2 (admin W2), EpochAnchor v2 (stake, quorum 2, admin W2), PlayerProfile, NodeBadge, NodeDirectory,
   - bonds the local node key from W2,
   - writes `deployed.testnet.json` with `version: 2` markers, `deployer`, `migratedFrom`.
4. Bond every other node key from W2 (`npm run bond -- <nodeId>`), or from each operator's own wallet for a real second operator.
5. Re-delegate announcers (`npm run announcer -- <nodeId> <announcerAddr> --fund 0.005`); nodes re-announce on restart.
6. `cabinet/config.js` `CHAIN`: new NodeStake, NodeDirectory, PlayerProfile, NodeBadge addresses; redeploy the cabinet.
7. Restart nodes; set `ERC6699=<new registry>` in `node.env` (or rely on `deployed.ERC6699RegistryV2`).
8. `npm run authority` again: the exposed address must hold nothing. Record both snapshots here.
9. Name a MINTER and a PROGRESSOR on the registry (`setMinter`, `setProgressor` from W2) — the progressor is the settlement pipeline's key when authorized progression is built; until then nothing progresses.

## Records

| when | what | block | file |
|---|---|---|---|
| 2026-09-12 | v1 TestLITVM, NodeStake, ERC6699Registry, EpochAnchor deployed | 50088907–50091691 | `deployed.testnet.json` (current) |
| 2026-09-17 | v1 PlayerProfile, NodeBadge, NodeDirectory deployed | 51608640–51608717 | `deployed.testnet.json` (current) |
| 2026-09-17 | authority snapshot before migration | 51790431 | `audit/authority-51790431.json` |
| 2026-09-19 | v2 TestLITVM `0x85D309Fe638B639Ae8c9889A5199Fce55B5dBd41` | 52403165 | tx `0x16f7615690910afb35d54b84da465d29d7b8fd12c952e9b17cd581b63c9bb733` |
| 2026-09-19 | v2 NodeStake `0x53822d9a334082e88AB70103F58AD65eBEF73801` | 52403667 | tx `0xf1b3435f663e87ab3107d29a6f758928e4af3b554152217ca2fd0ad68552aa0e` |
| 2026-09-19 | v2 ERC6699Registry `0x4062626DB36CE24752ED7a3e8c5FD7fE2ceFaB02` | 52403694 | tx `0x72a40670defcb1366b32f0f799d5c2de6018c678c02a86cd07cdaf7978d0411f` |
| 2026-09-19 | v2 EpochAnchor `0x87d9fB5FC60140B3e7A63FC657c1969baAf7d6eD` | 52403774 | tx `0xebf797f793e64b75cd2a3ced1730d02627f3dcab6744d7d2b5bfe1c24773ad98` |
| 2026-09-19 | v2 PlayerProfile `0xCdB1901aA9f4bc5dfd7F62c68B9d06247229B112` | 52403825 | tx `0xb1dd3e842a73e3b8068bcc5803d2769e19aff6ea50f1d95c53fedd042a7ca554` |
| 2026-09-19 | v2 NodeBadge `0x036f11E25d2A352f1B2DDc621c64aa22276D5f6e` | 52403893 | tx `0x32be3630ea137b579225f094f5e03bdd232a33c54d9565d9c5c508307ae5c4f5` |
| 2026-09-19 | v2 NodeDirectory `0x278e4550F8a45B5D7d630a606d577F9Fb6cBE4c1` | 52403947 | tx `0x8354c19f221c5fbf92e03dcb39b2008876d53f4ddd887c4a3bd74174fe6e72ea` |
| 2026-09-19 | desktop node `5b703f12…` bonded 1 tLITVM from W2 `0x7cE7E7c8A4615ba16201971a26f1D0F496c87D27` (admin of EpochAnchor v2 quorum 2, ERC6699Registry v2; NodeStake slasher/treasury) | — | `deployed.testnet.json` |
| 2026-09-19 | authority snapshot after migration: **0 holdings by the exposed address** | 52404437 | `audit/authority-52404437.json` |
| 2026-09-19 | announcer `0x74672463…` re-delegated for the desktop key on NodeDirectory v2 (tx `0xd624639f346debe9cab4364f07119c84ce34ff8a8582c0f148426f6164e96f9c`), funded 0.005 zkLTC (tx `0x9ab55e036e359a181639607bc46d07122f13beee5ffc74e5251fd4659cdf72ee`) | — | — |
| 2026-09-19 | desktop node restarted against the v2 set (bonded on NodeStake v2), announced its tunnel on NodeDirectory v2 (tx `0xaae6f77ba1e5ea65affffa70b6f7a6f10bcc3fba40c8974cfc0d6f1164a3e391`) | — | — |

Old anchors: scanning `rootOf()` for every hour from 11 Sep to 17 Sep 2026
finds exactly one v1 anchor — epoch **497006** (2026-09-12 14:00 UTC), root
`0x6726c997056cf6cb6cc9c48e834bcaf75554e2e93ea1130d1b7eca7a2516bfee`,
written by the deployer at 14:51:51 UTC during the first settlement test. It
is a protocol-1 batch (leaves per the v1 `leafOf`, no `resultHash`, no
`verified` flag) and stays where it is as history; v2 does not carry it
over and nothing official derives from it. Deltas settled under protocol 1
have no `resultHash`, are not placed under a protocol-2 descriptor, and are
excluded from official standings by construction.
