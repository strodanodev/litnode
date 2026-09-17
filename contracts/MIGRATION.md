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

## Procedure (a user action — needs a NEW funded wallet)

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
| — | v2 deployment | — | not done yet: needs W2 |

Old anchors: scanning `rootOf()` for every hour from 11 Sep to 17 Sep 2026
finds exactly one v1 anchor — epoch **497006** (2026-09-12 14:00 UTC), root
`0x6726c997056cf6cb6cc9c48e834bcaf75554e2e93ea1130d1b7eca7a2516bfee`,
written by the deployer at 14:51:51 UTC during the first settlement test. It
is a protocol-1 batch (leaves per the v1 `leafOf`, no `resultHash`, no
`verified` flag) and stays where it is as history; v2 does not carry it
over and nothing official derives from it. Deltas settled under protocol 1
have no `resultHash`, are not placed under a protocol-2 descriptor, and are
excluded from official standings by construction.
