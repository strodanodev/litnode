# Contract migration: testnet v2 → v3 (Settlement v1.0, phase 1 — no single key)

BUILD-SPEC v0.3 §2.2–2.4. Prepared 21 Sep 2026; **not yet executed**.

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
8. `cabinet/config.js` `CHAIN`: new addresses; redeploy the cabinet.
9. Enrol each node in the MatchBook witness pool from its delegate (a tool for this is not written yet: `enroll(nodeKey)` via `protocol/matchbook.js enrollCalldata`), then restart nodes. `/health` shows `bond.eligible` flipping to true after `eligibilityAge`, `matchBook.delegated`, `update.registry`, and `admin`. A ranked match from *Find match* then appears as `/match/:id/chain` → committed, settled, attested, final.
10. `npm run authority` again; record both snapshots below.
11. When the multisig exists: `setParams(...)` on NodeStake and `setParams(admin, delay)` on ReleaseRegistry from W2, handing `admin` over; `transferAdmin` on ERC6699Registry and EpochAnchor. Then W2 holds nothing but node bonds.

## Records (v3)

| when | what | block | file |
|---|---|---|---|
| 2026-09-21 | v3 contracts written and compile-tested; not deployed | — | `demo/contracts.test.mjs` |

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
