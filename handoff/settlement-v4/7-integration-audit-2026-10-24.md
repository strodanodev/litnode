# Integration audit: the settlement v4 sprints, five products on litnode (24 Oct 2026)

Read-only. Nothing in any repo was modified. Phase 5 stops for approval.

## 0. Baseline, products, window

**Spec baseline.** `docs/SETTLEMENT-STANDARD.md` at litnode `3482ee0` (the canonical settlement v4 contract, protocol 4) for settlement, identity, commitments, verifiers and roots; `BUILD-SPEC.md` v0.3 (21 Sep 2026) for roles, placement, epochs and custody. The "client spec v0.6" the prompt names is not on disk: BUILD-SPEC cites it only as "the longer-range architecture", so invariants 8 to 10 (title lifecycle, metering, inference modes) have no code or doc to check against in this repo. `SPEC.md` is marked historical.

**Products as found (confirm or edit).**

| # | Product | Path | Repo / branch / HEAD | Pushed? | Uncommitted |
| --- | --- | --- | --- | --- | --- |
| 1 | litnode | `E:\NPC\AGENT 24 NODE` | strodanodev/litnode `master` @ `3482ee0` = `v0.12.1` | yes, = origin | none in code; untracked graphify files, `handoff/` |
| 2 | Arcade (cabinet) | `E:\NPC\AGENT 24 NODE\cabinet` | inside litnode; Vercel team NPC, project `cabinet` | deployed: live serves 0.12.1, `rpcFallback`, `explorer` | — |
| 3 | LitForge (forge.litvm.games) | **not found** | no repo on E:\NPC, no reference in any of the five codebases; "LiteForge" is the Caldera testnet name (RPC, explorer, hub) | — | — |
| 4 | Agent Fighter | `E:\NPC\AGENT FIGHTER\agent-fighter` | strodanodev/agent-fighter `master` @ `9c1ca39` | yes, = origin | none |
| 5 | Pickle Brawl | `E:\NPC\PICKLEBRAWLv2\PickleBrawl` (+ runtime copy `pb-runtime` @ `b6192ca`) | notsedano/PickleBrawl `master` @ `b6192ca` | **38 commits ahead of origin** | `src/player/PlayerPawnPB.ts` (court-keeping moved into the movement step) |
| 5b | FLOOD CONTROL / The Arc | `E:\NPC\06 AERIS GAME\bagyogame` | strodanodev/bagyogame `master` @ `c718883` | remote answers 404 (renamed or private?); local = last known origin | none |
| 5c | AFC / Robot Fighting Championship | `E:\NPC\AGENT 21\AFC` | notsedano/afc `cel-rebuild` @ `4dc1f8b` | not pushed | textures, a Blender script, 6 untracked character folders, `.agents/` |
| — | Control Plane (Codex-owned, inventory only) | `E:\NPC\LIT\website` | notsedano/litgaming-website `control-plane-phase1` @ `0ec673b`, 4 ahead of `main` | not pushed | zips, logos, video (untracked) |

The sprint set that actually ran is the one in `handoff/settlement-v4/`: litnode, Agent Fighter, Pickle Brawl, AFC, FLOOD CONTROL. Robot Fighting Championship is AFC, not Pickle Brawl. LitForge is treated as out of scope until you say otherwise.

**Window.** litnode `v0.11.29` (20 Oct 22:32Z) → `3482ee0`; the title repos from 21 Oct (hand-off prompts were written against `84c6fb0`, the 0.12.0 candidate). The Control Plane's last commits (21 Oct) are inside the window but outside the sprint.

**Target split (the user, 24 Oct):** litnode carries multiplayer, matchmaking, match resolution and per-match stats; Neon or Supabase carries inventory, credits and studio-side stats. Railway is deprecated across the stack. Per-match counters that witnesses recompute belong in the node (committed and anchored); counters the studio changes without a new build belong in the database.

**Expected stack vs found.** Agent Fighter: Vercel client + Supabase + relay task on the publisher's litnode + gauntlet server bundle on the node. Pickle Brawl: Vercel web + API (Postgres migrations under `services/api`), matchmaker and court as node-spawned processes from a checkout. FLOOD CONTROL: Vercel board/court + Neon; the node only settles. AFC: Vercel client + Railway host + Supabase; not on the mesh. Nobody uses Supabase through the node.

**Symptoms, inferred from commits and logs** (S1–S17 are referenced throughout):

- S1 Caldera `/http` RPC out of bandwidth / 429 on 23 Oct: arcade, Agent Fighter client, courts.
- S2 First live Pickle Brawl v4 match refused: `a won game reaches at least 11` (a forfeit), 23 Oct 12:11Z.
- S3 Pickle Brawl results settle `attested`, not `checkable` (live match `7ebcf551…` 15:46Z names verifier `11203288…`, which is not registered).
- S4 Control Plane 0.1.15 starts its bundled 0.11.29 node on :7801; the task node exits code 74 three times (23 Oct 18:49–18:51).
- S5 An elevated task node survives `schtasks /End` and `taskkill` and keeps the port.
- S6 Agent Fighter "SERVER OFFLINE" with the relay up (23 Oct): node.env's `AIR_PARTNER_ID` inherited by the relay; and the client's relay cache going null after two minutes.
- S7 `litnode-watch` task would loop on a missing script after the relay glue was removed.
- S8 `hydration.test.mjs` flaking "match not finished" (about 3 in 7 under v4).
- S9 Server and verifier hashes not reproducible across machines (esbuild path comments; git commit inside the hashed manifest).
- S10 litVM 429s from FLOOD CONTROL's per-run settler discovery.
- S11 Gauntlet children inheriting the operator's whole environment (AIR_* etc.).
- S12 Ranked ledgers refused "no placement descriptor" after a rival placement, the 15-minute TTL or a host restart.
- S13 C: full on 23 Oct: `refs/heads/master` zeroed, test runs crashing.
- S14 Court stdout/stderr lost (the node keeps one line).
- S15 Quick-tunnel latency: p99 400–700 ms; ingress location changes per restart.
- S16 Relay-hosted `LIT-` rooms silently settling casual when no gauntlet host was found.
- S17 Off-chain results never co-signed: custody draw needs fresh peers; the live mesh has one fresh node.

Live state used as evidence (read-only, 24 Oct 19:50 local): desktop node `5b703f12…` on **0.12.1**, protocol 4, bonded, enrolled, serving `agent-fighter.v1 7414ddf3`, `pickle-brawl.v1 866bb9eb`, `flood-control.v1 b16bc0a2`, plus a third party's `rapture-chess.v1 cf604358` hydrated from a peer. Peers: m16 standby `50bb1da9…` and `rapture-ch` `a0b440f4…`, both 0.12.1, both **not fresh**. Primary RPC answering 429, fallback "fetch failed" at 19:49Z. The arcade serves 0.12.1 with `rpcFallback` and `explorer`. `pb-runtime` runs game build `0bb00f76…` whose court names verifier `11203288…`. Seven settlement suites run here: 44/44 pass (`demo/settlement-v4`, `attested`, `court`, `binding`, `gauntlet`, `hardening`, `gen4-vm`). The litnode session reported the full suite 262/262 on `364435f`.

---

## Phase 1. Inventory

Flags: **PIN** litnode version/SDK import · **WIRE** message/RPC/API shape · **DB** Supabase/Postgres schema · **INFRA** Vercel/env/serverless · **CHAIN** contracts/ABI/chain id/RPC/mint · **HASH** ruleset/artifact version or content hash.

### 1.1 litnode (`v0.11.29..3482ee0`, 28 commits, all SEDANONPC)

| Hash | Date | Message (short) | Files of note | Flags |
| --- | --- | --- | --- | --- |
| `6cfff2b` | 21 Oct | Arcade download → Control Plane 0.1.15 | `cabinet/download.js` | PIN |
| `4840ffe` | 21 Oct | 0.11.30 hardening (six audit highs) | `node/litnode.js`, `node/settle.js`, `node/sandbox.js`, `cabinet/app.js`, `audit/*` | WIRE (`/queue` typing, `/ledger` 429) |
| `31ddd3f` | 21 Oct | 0.11.31 placement binding | `node/settle.js bind`, `node/chain.js standingAt`, `sdk/client.js` (`descriptor`), `cabinet/app.js` | WIRE (`GET /match.envelope`, submission `descriptor`) |
| `9ec4cc8` | 21 Oct | 0.11.32 whole zips, unelevated task, hermetic tests | `tools/pack.mjs`, `tools/lib/pack-plan.mjs`, `portable/install-task.cmd` | INFRA |
| `2b96e8f`, `efd1e4a`, `dec26bb`, `0386657`, `b52e97e` | 21–22 Oct | `sdk/court` (zero-dep court client), bridge on it | `sdk/court/*`, `sdk/bridge/*` | PIN, WIRE (`existing: true`) |
| `8d830dc` | 21 Oct | `Ed25519.sol` RFC 8032 on the EVM | `contracts/Ed25519.sol` | CHAIN |
| `b4bf6b4` | 22 Oct | Settlement v4 core: proof levels, commitments, logs, verifiers, stats, paired root | `protocol/{result,epoch,derive,progression,stats,version}.js`, `node/{settle,litnode,matchbook,server-bundle}.js`, `titles/title.js`, `cabinet/protocol/*` | WIRE (protocol 3→4; `GET /log`, `/proof/stats`, `/health.settlement`), HASH (`DERIVE_VERSION` 3, `PROGRESSION_VERSION` 2, result commitment adds `proof`, `stats`, `statsSchema`) |
| `c3a0fd5`, `70c63ee`, `995eef0`, `19f0ea6` | 22 Oct | Generation-4 contracts + callers (not deployed) | `contracts/{NodeStake,NodeDirectory,MatchBook,EpochAnchor}.sol`, `protocol/{staking,directory,keys}.js`, `node/{chain,matchbook,proxy}.js`, `cabinet/{nodeops,seeds}.js`, `tools/{bond-node,deploy-contracts,params}.mjs` | CHAIN (`bond(key, amount, sig)`, `keysPage`, `maxPool`, `EpochNotOver`, `version()`), WIRE (`GET /bond-proof`) |
| `a7ea7da` | 22 Oct | Titles adopt v4 stats; PB court in manifest; proof badges | `titles/{flood-control,pickle-brawl}.adapter.js`, `rulesets/*`, `cabinet/{app,config,style}` | HASH (PB `d7233fa3`, FC `e0d71ba1`) |
| `caaee80`, `e6c18de`, `3f4288b`, `f8fe52e` | 22 Oct | host harness: gen-4 bond proof, v4 doctor, cloudflared check, disk floor | `sdk/host/*` | INFRA |
| `3e97c50`, `72ae648` | 22 Oct | Skills run as written; docs for v4 | `.claude/skills/*`, `docs/*`, `tools/sync-skills.mjs` | — |
| `84c6fb0` | 22 Oct | v0.12.0 RC | `package.json`, `cabinet/version.js`, CHANGELOG | PIN |
| `967f6e0` | 22 Oct | Merge 0.11.31 | — | — |
| `7b752dd` | 23 Oct | Integrate AF, PB, FC hand-backs | `titles/*.adapter.js`, `rulesets/*`, `node/{litnode,gauntlet}.js` (`INHERITED_ENV`, `/delta?chain=1`, `/deltas?player=`, `key` on direct seats), `sdk/court` (cached settler, `oversizeLog`, `signRun`), `tools/bundle-server.mjs` (`absWorkingDir`, commit out of the manifest), `cabinet/{app,contracts}` (`explorer`, `cabinet:sign-run`), `gauntlets/pickle-brawl.json` (`inheritEnv`) | WIRE, HASH (AF `290200cf`, PB `98d23e4e`, FC `b16bc0a2`), INFRA |
| `bea6429`, `0e9e948` | 23 Oct | AF ruleset on af-core-9 from deployed `29d4400`, release-signed | `rulesets/agent-fighter.v1.*`, standard §14 | HASH (`7414ddf3`) |
| `8936bff` | 23 Oct | Remove AF relay glue (af-watch, import, bridge adapter, checkout gauntlet) | `tools/af-*.mjs` (D), `sdk/bridge/adapters/agent-fighter.mjs` (D), `gauntlets/agent-fighter.json` (D), `portable/*`, `node/{cli,update}.js`, docs | INFRA (`litnode-watch` task gone) |
| `032fe10`, `bcf679a` | 23 Oct | Arcade: per-title v4 stats; phone podium | `cabinet/{app,style}` | — |
| `43ddd2e` | 23 Oct | Retire `litnode-watch` on update; relay-ledger leftovers | `node/update.js`, `portable/{install-task,run-af-watch}.cmd`, `tools/lib/pack-plan.mjs` | INFRA |
| `26c2643` | 23 Oct | `POST /restart` | `node/litnode.js`, `portable/restart-node.cmd` | WIRE |
| `364435f` | 23 Oct | `rpcFallback` in the deploy record, cabinet `rpcCall`, sdk/court discovery | `contracts/deployed.testnet.json`, `cabinet/{chain,config,contracts,nodeops,seeds,wallet}.js`, `sdk/court/index.js` | CHAIN (RPC endpoints), INFRA |
| `ebb9aff` | 23 Oct | PB forfeits settle (`forfeitTeam`) | `titles/pickle-brawl.adapter.js`, `rulesets/pickle-brawl.v1.*` | HASH (`866bb9eb`), WIRE (report field) |
| `3482ee0` | 23 Oct | Release 0.12.1 | `package.json`, `cabinet/version.js`, CHANGELOG, OPERATORS | PIN |

Branches and worktrees: `claude/epic-herschel-df93d5` holds `cb06644` + `c44b3b1` (20 Oct, Nodes-page/Cards/top-bar), pre-rebase duplicates of `07dc727` which is in master; the top-bar fix `c44b3b1` is **not** in master (unmerged). `lite-guardian` (`E:\NPC\litnode-guardian`, 26 Sep, 84 behind) and `origin/title/flood-control` (merged) are stale. Four other worktrees are at or behind master with nothing uncommitted.

### 1.2 Agent Fighter (13 commits, 22–23 Oct)

| Hash | Message | Files of note | Flags |
| --- | --- | --- | --- |
| `29ca1a2` | af-core-9: integer match stats in GameState, pins per state | `packages/core/src/{state,sim,stats,data,ai,index}.ts`, golden hashes | HASH (engine `af-core-9`) |
| `28ad373` | Gauntlet is the only ranked intake; ships as a litnode server bundle | `packages/server/src/{server,protocol,agent-session}.ts`, ADR 0014, `server-bundle.test.ts` | WIRE (`pin.intake`, `SMatch.placed`) |
| `de472ab` | Relay records a player key only after it signed the log | `packages/server/src/mesh-ledger.ts` (`verifyLedgerSig`), `protocol.ts` | WIRE (`CSign.matchId/buildHash`) |
| `491ba78` | Contract set only from the arcade; proof level + links | `packages/client/src/{mesh,proof,main}.ts`, `tools/check-contracts.mjs` | CHAIN (no address literals; reads `contracts.json`), PIN |
| `3d4d1d6`, `8aaa934`, `65ad821`, `f8c1d94`, `3590946` | hand-back docs | `docs/LITNODE-V4-HANDBACK.md`, ADR 0013 | — |
| `d70eea5` | Ledgers carry the placement descriptor; proof reads 0.12.0 routes | client `{main,mesh,net,proof}.ts`, server `{agent-session,mesh-ledger,protocol,server}.ts` | WIRE (`CSign.descriptor`; `GET /delta?chain=1`, `/deltas?player=`) |
| `29d4400` | Deploy: Vercel from push, relay = `litnode-relay` task; Railway removed | `tools/{deploy,ship-assets}.mjs`, `railway.json` (D), docs | INFRA |
| `b7d0923` | Relay discovery falls back across RPC endpoints | `packages/client/src/mesh.ts` | CHAIN (RPC list) |
| `f10ccf6` | Relay: arcade matches only on the gauntlet; publisher-only relay discovery | server `{server,protocol,mesh-ledger,agent-session}.ts`, client `{main,mesh,net}.ts`, `tools/{deploy,tunnel}.mjs` | WIRE (`LIT-` rooms refused; `CSign` loses `matchId/buildHash`) |
| `66c0005` | AIR partner allowlist (`AIR_PARTNER_IDS`) | `packages/server/src/airjwt.ts`, `.env.example`, `docs/deploy.md` | INFRA (env) |
| `9c1ca39` | Keep the last relay address; re-read in the background | `packages/client/src/mesh.ts`, `mesh.test.ts` | — |

Supabase: no migration in the window (last `0032_pet_roll_tickets.sql`, 12 Sep). `vercel.json` unchanged. Deployed: www.agentfighter.wtf serves af-core-9 from `b7d0923`; relay restarted on `8aaa934`.

### 1.3 Pickle Brawl (9 commits + 1 dirty, 22–23 Oct)

| Hash | Message | Files of note | Flags |
| --- | --- | --- | --- |
| `21ea654` | Court reports carry player keys, stats, log commitment | `services/court/src/{court,ledger,litnode-report}.ts`, vendored `sdk/court` @ `84c6fb0`, matchmaker `{playerKey,keccak,lobby,tickets}.ts`, game `{matchStats,matchRandom,joinTicket}.ts`, `web/arcadeIdentity.ts` | PIN (vendored), WIRE (`claims.sub` = key; ticket `key`), CHAIN (PlayerProfile `ownerOfKey` reads) |
| `f799521` | The verifier: headless replay from the input log (phase C) | `services/court/verifier/*`, `src/{sim,stateHash,verifier-hash}.ts`, `scripts/build-game-bundle.mjs`, game `PlayerPawnPB.ts`, `PickleBrawlGameMode.ts` | HASH (game `6be50a41`, verifier `58e4f0b6`) |
| `56d4f59` | Court names verifier `58e4f0b6` | `verifier-hash.ts` | HASH |
| `fd13679` | After 7b752dd: verifier `e4cb7337`, re-vendor, court carries placement | vendored `sdk/court` @ `7b752dd`, `src/placement.ts`, `litnode-report.ts` (`signSubmission` adds `descriptor`) | PIN, HASH, WIRE (`GAUNTLET_NODE_URL` fetch of `/match`) |
| `16b2a7b` | Forfeits: court reports `forfeitTeam`; litnode adapter patch | `court.ts`, `litnode-report.ts`, `docs/litnode-patches/pickle-brawl-forfeit.patch` | WIRE (report field), HASH (→ `866bb9eb`) |
| `88a705b` | hand-back §9 | docs | — |
| `c60d823` | Opponent faces the net | `src/player/PlayerPawnPB.ts` | HASH (game build changes) |
| `992fe40` | Follow-up for LITNODE | `docs/LITNODE-FOLLOWUP-2026-10-23.md` | — |
| `b6192ca` | Game build `0bb00f76`, verifier `11203288`, tamper test | `verifier-hash.ts`, fixtures | HASH |
| dirty | `PlayerPawnPB.ts`: court-keeping moved into the movement step (47+/20−) | game code | HASH (next build) |

Postgres: `services/api/migrations/001…009` unchanged in the window. Vercel: `dist-web/vercel.json` unchanged.

### 1.4 FLOOD CONTROL (4 litnode-related commits of ~16, 21–23 Oct)

| Hash | Message | Files of note | Flags |
| --- | --- | --- | --- |
| `eb4b50e` | Commit the run log, stats, verifier bundle (attested → checkable) | `scripts/arc/board/{handler,litnode,verify,replay,vercel,levelFiles}.ts`, vendored `sdk/court` @ `b52e97e`, `scripts/arc/verifier/*`, `src/sim/save/BoardLog.ts`, `src/platform/{arcade,board}.ts`, `docs/litnode/flood-control.adapter.js`, fixtures | PIN, WIRE (`arc-runlog@1`, `arc-final@1`, `cabinet:sign-run`), INFRA (verifier hash compiled into the Vercel function), HASH (ruleset `b16bc0a2`, verifier `56cfff04`) |
| `530ac43` | hand-back; CRLF-stable hash | docs | — |
| `bd00c9d` | Merge `litnode-settlement-v4` | — | — |
| `b8f76eb` | After 7b752dd: re-vendor, `verifyRun`, `oversizeLog: 'skip'` | vendored `sdk/court` @ `7b752dd`, `litnode.ts`, `verify.ts` | PIN |

The other 12 commits (guides, barriers, GPU rain, music, routes) are game-only. `d1178ac` (barriers) touches `src/sim/infra` before the merge, and `56cfff04` is the hash FC re-confirmed after the merge, so it includes that change. Neon schema: no change seen. Deployment: not verified (play.bagyo.app answers 200; the board API was not probed).

### 1.5 AFC (2 litnode commits of 9, 20–22 Oct)

| Hash | Message | Files of note | Flags |
| --- | --- | --- | --- |
| `fe15803` | afc.v1 court bridge, bout stats, verifier entry, arcade handshake | `packages/server/src/litnode/{bridge,court,identity,report}.ts`, vendored `sdk/court` + `keccak` @ `84c6fb0`, `api.ts`, `auth.ts` (`AIR_PARTNER_IDS`), `payout.ts`, `cli.ts`, `packages/core/src/{boutStats,verifier}.ts`, `packages/client/src/{arcade,session}.ts`, `docs/litnode/afc.adapter.js`, **`supabase/migrations/20261022000000_litnode_settlements.sql`** | PIN, WIRE (`hmc-match@2` as log), **DB** (`match_settlements`, RLS select-all), INFRA (`LITNODE_*` env), CHAIN (PlayerProfile binding) |
| `4dc1f8b` | hand-back, L3 scoping, verifier hash | `docs/LITNODE-V4-HANDBACK.md`, `docs/LITNODE-L3.md`, `verifiers/afc.v1.verifier.json` | HASH (`c7d885c3`, built with the pre-7b752dd packer) |

The remaining commits are art (cel rebuilds, voice, fonts). Nothing of AFC's hand-back is in litnode: no `titles/afc.adapter.js`, roster still `status: 'external'`, court pubkey still `__AFC_COURT_PUBKEY__`.

### 1.6 Control Plane (inventory only)

`control-plane-phase1` @ `0ec673b` (21 Oct) embeds litnode **0.11.29** (`desktop/bundle/litnode-bundle.json`); 0.1.15 MSI published. Four commits unpushed; untracked first-run zips and assets.

---

## Phase 2. Classification

| Change | Tag | Note |
| --- | --- | --- |
| litnode `4840ffe`, `31ddd3f`, `9ec4cc8`, `b4bf6b4`, `7b752dd` (node/protocol parts), `ebb9aff`, `26c2643`, `43ddd2e`, `8936bff` (node/tools parts) | PROTOCOL-CORE | |
| litnode `2b96e8f…b52e97e`, `7b752dd` sdk/court, `364435f` sdk/court | PROTOCOL-CORE (SDK surface) | the court client is part of the contract the titles vendor |
| litnode `c3a0fd5`, `70c63ee`, `19f0ea6`, `8d830dc`, `995eef0` | CHAIN | gen-4 source, undeployed; callers detect `version()` |
| litnode `364435f` (`deployed.testnet.json`, cabinet `rpcCall`), `cabinet/contracts.json` `explorer` | CONFIG/INFRA + CHAIN | RPC endpoint list in the deploy record |
| litnode cabinet `a7ea7da`, `032fe10`, `bcf679a`, `4840ffe` (cabinet), `6cfff2b` | PRODUCT-LOCAL (arcade) | |
| litnode `7b752dd` `cabinet:sign-run` / `cabinet:run-signed` | PROTOCOL-CORE | a shell↔game wire message |
| litnode `sdk/host/*`, `tools/pack.mjs`, `portable/*`, `install-task.cmd` | CONFIG/INFRA | |
| litnode `bea6429`, `0e9e948`, `rulesets/*`, `servers/*` | CHAIN (registration inputs) | hashes registered on TitleRegistry |
| AF `29ca1a2` (engine), `28ad373`, `de472ab`, `f10ccf6`, `9c1ca39` | PRODUCT-LOCAL | `29ca1a2` is consensus-relevant for the mesh (new buildHash) |
| AF `d70eea5` (descriptor, `?chain=1`, `?player=`), `491ba78` (contract set, proof links) | PRODUCT-LOCAL, adopting PROTOCOL-CORE | |
| AF `b7d0923` client RPC fallback | PROTOCOL-WORKAROUND | compensated for litnode not publishing `rpcFallback` yet (now published; AF still keeps its own `DEFAULT_RPCS`) |
| AF `66c0005` `AIR_PARTNER_IDS` | PROTOCOL-WORKAROUND + CONFIG/INFRA | the cause is litnode's `portable/run-af-relay.cmd` loading `node.env` wholesale |
| AF `29d4400` deploy tooling | CONFIG/INFRA | |
| PB `21ea654`, `f799521`, `56d4f59`, `c60d823`, `b6192ca`, dirty `PlayerPawnPB.ts` | PRODUCT-LOCAL | the court's log/verifier is product code; the adapter patch is PROTOCOL-CORE (applied as `ebb9aff`) |
| PB `fd13679` `signSubmission` adding `descriptor` after `attest()` | PROTOCOL-WORKAROUND | `sdk/court envelope()` drops `descriptor` |
| PB `fd13679` court fetches the descriptor from `GAUNTLET_NODE_URL/match` | PRODUCT-LOCAL | a legitimate alternative to `cabinet:init.match.descriptor` |
| PB `16b2a7b` court `forfeitTeam` | PRODUCT-LOCAL (+ litnode `ebb9aff`) | |
| FC `eb4b50e`, `b8f76eb` | PRODUCT-LOCAL; vendored `sdk/court` = PROTOCOL-CORE copy | own tar builder matching litnode's layout: UNCLEAR (see 4.2) |
| FC verifier hash compiled into the Vercel function (`vercel.ts`, `build-web.mjs`) | CONFIG/INFRA | |
| AFC `fe15803` bridge, identity, report, verifier | PRODUCT-LOCAL | `identity.ts` re-implements PlayerProfile binding: UNCLEAR whether it should be `sdk/court` |
| AFC `supabase/migrations/20261022000000_litnode_settlements.sql` | CONFIG/INFRA (DB) | |
| AFC `verifiers/afc.v1.verifier.json` `c7d885c3` | CHAIN input, **stale** | packed with the commit in the manifest |
| Control Plane 0.1.15 embedding 0.11.29 | CONFIG/INFRA | now incompatible with the mesh (protocol 3) |

---

## Phase 3. Spec conformance

### 3.1 The ten invariants

1. **Roles opt-in and composable.** PASS. No change adds a mandatory role: custody (`custodians()`), log fetch and `/proof/stats` run only with `witness`/`settler`; courts (FC, AFC, PB) need no node of their own. Note: Agent Fighter's client pins the publisher's two node keys as the only relays (`packages/client/src/mesh.ts` `PREFERRED_RELAYS`, `f10ccf6`). That is a product dependency on specific nodes, not a role; it is what makes R3 fail for AF (below).
2. **Placement deterministic, coordinator-free.** PASS, strengthened. `protocol/placement.js` is untouched in the window. `31ddd3f` lets a ledger bind to the signed envelope the client was served, with two new checks on both paths: the id must equal `matchIdFor(ruleset, a, b, beacon)` and the beacon must be this node's own for the bucket (`node/settle.js bind`, `node/litnode.js verifyDescriptor`). Pickle Brawl's court takes the envelope from its host node's `GET /match` (`services/court/src/placement.ts`) and the node re-verifies it. No central placement authority appears anywhere; `sdk/court findSettler` discovers settlers from NodeDirectory + NodeStake, not from a service.
3. **Input logs hash-chained and replayable by witnesses.** PASS for L3 (ledger body `{matchId, ticks, head, buildHash}` unchanged; AF gauntlet refuses to post ranked without both signatures, `28ad373`). Attested titles commit the exact log bytes by sha256 (`commitmentsOf`, `holdLog`), content-addressed, fetched and held by the custody set (`witnessOne`), which is what L2 promises. No fix bypasses logging: `oversizeLog: 'skip'` keeps the commitment and the node labels the result `attested`, never `checkable`; the proof level is derived from evidence (`proofOf`) and never taken from the submitter. Watch item: Pickle Brawl's court has a `COURT_LEDGER=0` switch; it is not in `inheritEnv`, so an operator cannot flip it from the node's environment. Keep it that way.
4. **Hourly epoch roots anchor to LitVM correctly.** PASS on correctness, with three caveats. The anchored root is now `pairHash(resultsRoot, statsRoot)` (`protocol/epoch.js anchorRoot`, `node/matchbook.js epoch`); the gen-3 `EpochAnchor` deployed at `0x919e…` verifies inclusion by positional pairs, so proofs gain one step and verify unchanged (`demo/gen4-vm.test.mjs`, `settlement-v4.test.mjs` pass here). Caveats: (a) **liveness**: a settler proposes only once it has resolved stats for every FINAL match of the hour by fetching a delta whose recomputed `resultHash` equals the chain's from the host, a custodian or a panel seat (`resolveStatsUpTo`); if none answers, it logs "waiting for the stats" and never proposes, and quorum is 50 % of active stake. (b) L1/L2 results and their stats are **not anchored** in v4.0 (standard §15 item 4), so FLOOD CONTROL, Pickle Brawl and AFC stats roots exist only locally. (c) **Unexercised live**: the desktop log shows no `propose` since the 22 Sep ranked finals (`497226` reverted on `eth_estimateGas`, `497229` sent); every hour since has `count: 0` on the chain tree, so the paired root has never reached the contract.
5. **Artifacts content-addressed, deterministic replica sets, custody proofs, ruleset versioning.** PASS with gaps. Rulesets, server bundles and verifier bundles are each `sha256(kind NUL tar)` in separate hash domains (`node/server-bundle.js`); since `7b752dd` the packer uses `absWorkingDir` and keeps the git commit out of the hashed manifest, so hashes reproduce across machines (PB and FC confirmed). Every consensus change rolled a hash (`af-core-9` → `7414ddf3`, forfeit → `866bb9eb`, FC attestors → `b16bc0a2`). Custody: k = 3 by `h('custody', matchId, nodeId)`, co-signatures are the proof. Gaps: verifier **bytes do not travel** (`GET /verifier/<id>?build=` is designed, not built), so the replica set for verifiers is "release assets"; the esbuild version is not in the manifest (FC writes `source.esbuild`, litnode's packer does not), so a toolchain bump changes a hash silently (AFC Q4); AFC's `c7d885c3` was packed with the old manifest layout and no longer reproduces.
6. **Browsers recompute placement from signed snapshots.** PASS. `cabinet/protocol/` is byte-identical to `protocol/` (18 files, `tools/vendor-cabinet.mjs --check`), version 4; the cabinet still rebuilds the snapshot from signed heartbeats and refuses an unproduced host; `0.11.30` validates every peer-supplied `display` field before it enters `GAMES`; `GET /match` now includes each placement's signed envelope and the shell forwards it as `cabinet:init.match.descriptor`.
7. **Origin is not authorization.** PASS with one exception to fix. `/restart` uses Origin only to **deny** (loopback plus no foreign Origin): fine. Courts and games never trust a bare `cabinet:init` id: FC requires `cabinet:sign-run` (ed25519 over `run`), PB and AFC bind the key through PlayerProfile `ownerOfKey` for both the key and `airKey(sub)`; AF's relay now records a key only after its ledger signature verifies. The AF relay's `AIR_PARTNER_IDS` is a token-issuer allowlist, not an origin check. **Exception**: `GET /bond-proof` (`70c63ee`) signs a generation-4 bond proof for any page whose `Origin` is `https://arcade.litvm.games` (loopback only). Origin is an allow condition for a privileged signature there: a compromised arcade deploy, open in the operator's browser, could obtain a proof naming its own wallet and bind the node key first. Low likelihood (needs the operator's browser on the page and minStake tokens), but it is the one place in the window that trusts a frontend domain. Gen-4 is not deployed, so nothing is live yet.
8. **Live/Perpetual/Stasis transitions.** UNKNOWN (not implemented). litnode has no title lifecycle; the cabinet's `status: live | attested | external | mesh` is presentation only; the only "stasis" in BUILD-SPEC is the agent-NFT `status()` (§3). Nothing in the window touches it.
9. **Metering (shard-hours, relayed GB).** UNKNOWN (not implemented). The graph and the docs have no metering concept; `/fleet` telemetry counts bytes and the rewards POINTS tool counts matches. No change in the window adds, double-counts or skips a meter because there is none.
10. **agent:tee vs agent:committed.** N/A. No inference modes exist in litnode; the "agent" vocabulary here is the ERC-6699 hydration and the house bot. Nothing to mix.

### 3.2 R1–R4 per product

| | R1 self-host backend via the node | R2 other nodes hydrate | R3 survives publisher node off | R4 casual, no node, any frontend |
| --- | --- | --- | --- | --- |
| **Agent Fighter** | PASS: gauntlet server bundle `e8d8f22b` served from the publisher's node; relay as a node task; economy in Supabase | PASS (tested): `demo/server-bundle.test.mjs` "real server" fetches by hash on a second node; live: a third operator (`rapture-ch`) hosted a placed match at 19:30 local today, outcome not in `/deltas` yet | **FAIL by design** (ADR 0014 update, `f10ccf6`): relay = account API + matchmaker pinned to `PREFERRED_RELAYS` (desktop, m16); `LIT-` rooms refused on the relay; ranked needs a gauntlet host, and only the desktop serves one | PASS with a caveat: the client's contract set comes from `cabinet:init.chain` or the hard-coded `https://arcade.litvm.games/contracts.json`; another frontend must pass `cabinet:init.chain` |
| **Pickle Brawl** | PASS: court and matchmaker spawned by the publisher's node (`gauntlets/pickle-brawl.json`) | **FAIL**: the court runs from a machine-specific checkout (`cwd: E:/NPC/PICKLEBRAWLv2/pb-runtime`, `COURT_IDENTITY` path); no server bundle; `hostPolicy.affinity: 'operator'` | **FAIL** (follows from R2) | PASS: matchmaker-formed casual matches, keys bound by PlayerProfile, `pb:` otherwise |
| **FLOOD CONTROL** | PARTIAL: the backend is Vercel + Neon; the node only settles | PASS: ruleset `b16bc0a2` hydrated by the desktop; nothing else to host | PASS: single-player; settlement finds any bonded settler (cached, with fall-through) | PASS: play.bagyo.app answers; no node needed |
| **AFC** | FAIL / not on the mesh: Railway host, `LITNODE_ENABLED=0`, adapter not in litnode | FAIL: no `titles/afc.adapter.js` | N/A | PASS as a hosted game, not via the mesh |
| **Arcade** | — | — | serves `contracts.json` + `rpcFallback` + `explorer`; seeds from NodeDirectory with paged reads | PASS |

Live mesh caveat for every PASS in R2/R3: of three 0.12.1 nodes, one is fresh. The custody draw therefore seats nobody (`cosigners: 0` on the live PB match), and nothing off-chain has been co-signed since v4 went live.

---

## Phase 4. Cross-product analysis

### 4.1 Conflicts (same litnode file/function/message changed differently)

None divergent. Each hand-back was applied verbatim: AF's adapter patch (`7b752dd` = AF hand-back §3), FC's `docs/litnode/flood-control.adapter.js` (copied; builds to `b16bc0a2`), PB's `docs/litnode-patches/pickle-brawl-forfeit.patch` (`ebb9aff`; byte-equal hunks). Two near-conflicts to settle by decision:

- **The attested envelope's `descriptor`.** PB adds it after `attest()` (`services/court/src/litnode-report.ts signSubmission`, `fd13679`); litnode's `sdk/court` `envelope()` still drops it (no `descriptor` in `sdk/court/index.js` or `index.d.ts` at `3482ee0`). The node accepts it from both paths (`settle.js intake` reads `sub.descriptor`). One owner is needed: the SDK.
- **Verifier manifest layout.** FC builds its own tar (`scripts/arc/verifier/build.ts`, esbuild 0.28.2, `source.esbuild` recorded); PB and AFC call litnode's `tools/bundle-server.mjs` (esbuild 0.24.2, no esbuild version in the manifest). Same layout today, two implementations.

### 4.2 Duplicates (one root issue, several fixes)

- **RPC endpoint fallback, four times**: `node/chain.js rpcEndpoints` (pre-existing), `cabinet/chain.js rpcCall` (`364435f`), `sdk/court rpcList` + `DEFAULT_RPCS` (`364435f`), AF `packages/client/src/mesh.ts rpcCall` + `DEFAULT_RPCS` + benching (`b7d0923`, `9c1ca39`). The endpoint pair is hard-coded in three of them. Root cause S1 is one gateway and fan-out; the fixes mask the first and reduce the second (paged directory, cached settler, `PREFERRED_RELAYS`).
- **PlayerProfile key binding, three times**: PB `services/matchmaker/src/lib/playerKey.ts` (+ its own `keccak.ts`), AFC `packages/server/src/litnode/identity.ts` (+ vendored keccak), litnode `node/proxy.js`/`protocol/profile.js`. AFC asked for an `sdk/court` helper (Q6).
- **Arcade frame handshake, three times**: FC `src/platform/arcade.ts`, AFC `packages/client/src/arcade.ts`, PB `web/arcadeIdentity.ts`. Each re-derives the allowed arcade origins and the `cabinet:hello/init` dance.
- **Descriptor carriage, two ways**: AF carries the client's copy (`CSign.descriptor`, `d70eea5`); PB fetches the host's copy (`placement.ts`). Both valid; the standard should name both.

### 4.3 Workarounds that belong upstream

| Product workaround | Commit / file | litnode cause | Upstream fix |
| --- | --- | --- | --- |
| AF `AIR_PARTNER_IDS` wins over an inherited `AIR_PARTNER_ID`; the relay's `.env` blanks it | AF `66c0005` `packages/server/src/airjwt.ts`, `docs/deploy.md` | `portable/run-af-relay.cmd` line 9 loads **every** `node.env` variable into the relay (same class as S11, fixed for gauntlets by `INHERITED_ENV` in `7b752dd`, not for the relay task) | the relay task gets an allowlist (`PORT` from `RELAY_PORT`, `AF_ROOT`, OS basics), nothing else from `node.env` |
| PB adds `descriptor` after `attest()` | PB `fd13679` `litnode-report.ts` | `sdk/court envelope()` fixed field list | optional `descriptor` in `envelope()`, `attest()`, `index.d.ts`; re-vendor |
| AF client-side participant filter on `/deltas` | AF `d70eea5` `proof.ts` | nodes before 0.12.0 lacked `?player=` | delete: every live node is 0.12.1 |
| AF own `DEFAULT_RPCS` | AF `b7d0923` `mesh.ts` | `contracts.json` had no `rpcFallback` | now published by the arcade; keep only as last resort or drop |
| PB `services/court/verifier/bundle.mjs` reaches into the litnode checkout for `tools/bundle-server.mjs`; FC re-implements the tar | PB `f799521`, FC `eb4b50e` | the packer is a repo tool, not an SDK module | publish it as `sdk/bundle` (or document the vendoring path) and record `source.esbuild` |
| AFC hand-rolled PlayerProfile binding + vendored keccak | AFC `fe15803` `identity.ts` | no helper in `sdk/court` | `sdk/court boundKey(sub, key)` (two `eth_call`s) |

### 4.4 Drift

- **litnode version**: all three live nodes 0.12.1, protocol 4. The Control Plane embeds 0.11.29 (protocol 3): any operator who installed 0.1.15 and opens it gets an excluded node that also takes :7801 (S4).
- **SDK copies**: AF built against `84c6fb0`/`7b752dd` (no vendoring); PB and FC vendor `sdk/court` @ `7b752dd` (sha `e69849b3…`), two lines behind master (`364435f`: reads `rpcFallback` from `contracts.json`; `DEFAULT_RPCS` already names the same second endpoint, so no behavior gap today); AFC vendors `84c6fb0` (missing the cached settler, `oversizeLog`, `signRun`, `rpcFallback`): switching `LITNODE_ENABLED=1` on Railway would reproduce S10.
- **Ruleset / verifier hashes vs registration** (TitleRegistry state as of the 23 Oct hand-backs; not re-read on chain today because the gateway is rate-limited):
  - AF ruleset `7414ddf3` registered and served; server bundle `e8d8f22b` registered; the cabinet roster still says `buildHash: '859e7215…'` (af-core-8), display only (`cabinet/config.js:41`, the "On the mesh" panel).
  - PB ruleset `866bb9eb` registered 13:37Z and served; roster says `d7233fa3…` (never registered); verifier **registered `e4cb7337`** (game `6be50a41`) while **`pb-runtime` runs game `0bb00f76` whose court names `11203288`** (unregistered) → every live PB result is `attested` (S3). Standard §14 still lists `98d23e4e` / `e4cb7337`.
  - FC ruleset `b16bc0a2` served locally by the desktop (`origin: local`) but, per the 23 Oct hand-back, **not registered** on TitleRegistry; verifier `56cfff04` not registered; FC not in the cabinet roster (listed only through the desktop's `display`).
  - AFC: nothing registered; `c7d885c3` must be repacked.
- **Contracts**: deployed generation 3 everywhere (`contracts.json`, arcade, `sdk/court DEFAULT_CONTRACTS`); gen-4 is source only. Callers probe `version()` and fall back, so no drift, but `DEFAULT_CONTRACTS` in `sdk/court` hard-codes gen-3 addresses as the last resort.
- **Docs**: `SETTLEMENT-STANDARD.md §14` hash table is one PB release behind; `cabinet/config.js` roster hashes are two releases behind.

### 4.5 Breaking changes

- Protocol 3 → 4 (`b4bf6b4`): intended; every 0.11.x node is excluded. Live: none left except the Control Plane's bundled one.
- Gauntlet env allowlist (`7b752dd`): any court or server reading an operator variable not in `inheritEnv` breaks. PB listed its three; AF's gauntlet needs none. The relay task is not covered (S6).
- AF relay refuses `LIT-` rooms (`f10ccf6`): a player on any arcade whose placement names a host without `GAUNTLET_SERVERS=agent-fighter.v1` gets "launch again" instead of a casual fallback. Accepted by ADR 0014; it is the R3 failure.
- AF client links require `explorer` in `contracts.json` (`d70eea5`): satisfied by the arcade deploy.
- AF `CSign` lost `matchId/buildHash` (`f10ccf6`) after gaining them (`de472ab`): harmless, the only reader (relay key check) is gone.
- `exclusive` removed from the AF adapter: harmless, nothing read it.
- AF `e8d8f22b` no longer reproduces from AF `master` (`f10ccf6` changed `server.ts`, `protocol.ts`, `mesh-ledger.ts`): the registered bundle stays correct, but the next rebuild needs a new `set-build`; record `b7d0923` as the source commit.

### 4.6 Regressions

- **PB L2 → L1 live** (S3): `verifier-hash.ts` ties the verifier to one game build, and the facing fix (`c60d823`) plus the runtime promotion (`pb-runtime` @ `b6192ca`) ran ahead of registration. The uncommitted `PlayerPawnPB.ts` change will roll the build again.
- **AFC verifier `c7d885c3` unreproducible** under the current packer (manifest layout changed in `7b752dd`).
- **Roster and standard hashes stale** (4.4): the arcade shows the wrong build in "On the mesh".
- **`c44b3b1` (top bar 761–1279 px)** sits unmerged on `claude/epic-herschel-df93d5`; its sibling `cb06644` was rebased in as `07dc727`.
- **Availability**: AF's relay fallback removal; PB's checkout-bound court. Both pre-existing in substance, now explicit.
- No safeguard from 0.11.30/0.11.31 was removed by later commits: `readText` cap, `peerOrigin`, unsigned-ledger budget, sandbox ceiling, descriptor checks and pinned-block standing are all present at `3482ee0` and covered by `demo/hardening.test.mjs` and `demo/binding.test.mjs` (pass here).

---

## Phase 5. Root causes and the consolidation plan (stop here for approval)

### 5.1 Symptoms → root cause

| # | Root cause | Evidence | Confidence | Current fixes |
| --- | --- | --- | --- | --- |
| S1 RPC 429 / bandwidth | one public gateway, plus fan-out: per-run `findSettler` (FC), 2×N directory reads (arcade), per-node chain calls (AF) | `/health.chain` shows primary 429 and fallback `fetch failed` at 19:49Z today; AF `b7d0923`, litnode `364435f`, FC hand-back note 2 | high | fallback **masks**; cached settler, paged directory and `PREFERRED_RELAYS` **address** the fan-out. Still one provider family (both URLs are Caldera). |
| S2 forfeit refused | the adapter had no forfeit rule; the court reported a sub-11 winner | PB hand-back §9; `ebb9aff` | high | solved (`866bb9eb` registered, served). `scores()` inflates the stayer's score to rank the match; `stats.pointsWon` now disagrees with `scores` by design. Document it. |
| S3 PB `attested`, not `checkable` | verifier hash bound to the game build; registration lags each game change; `pb-runtime` promoted before `set-build` | live delta `7ebcf551` `ver: 11203288`, `pb-runtime/.dist/game.js` = `0bb00f76`, registered = `e4cb7337` | high | **not solved**: a user step (register `11203288`) and a process rule (register before promote, or keep two verifiers active). |
| S4 Control Plane takes :7801 | CP starts its own bundled node regardless of the task node; bundle is 0.11.29 | PB follow-up item 5 (PID 5148 path), website `litnode-bundle.json` | high | **masked**: `/restart` eases recovery. Fix is in the Codex repo: ship 0.12.x, defer to a running task node, stop children on quit. |
| S5 elevated node unkillable | task registered `-RunLevel Highest` (0.11.29) | audit §4.4.2; `26c2643` | high | solved for nodes that re-ran `install-task.cmd` on 0.11.32+; `POST /restart` covers the rest. |
| S6 AF SERVER OFFLINE | (a) `run-af-relay.cmd` loads all of `node.env` into the relay; (b) `cachedRelay()` null after 2 min | AF `66c0005`, `9c1ca39`; litnode `portable/run-af-relay.cmd:9` | high | (a) **worked around** in AF; the litnode script is the cause. (b) solved. |
| S7 af-watch loop | `run-af-watch.cmd` was outside CODE, survived the update | `43ddd2e`, hand-back 6 | high | solved; operators must re-run `install-task.cmd` once. |
| S8 hydration flake | mock chain minted a block per `eth_getBlockByNumber` | `31ddd3f`, CHANGELOG 0.12.0 tests | high | solved (10/10 green reported). |
| S9 non-reproducible hashes | esbuild cwd-relative comments; commit in the hashed manifest | AF Q1, FC note 3, PB §8.1; `7b752dd` `absWorkingDir` | high | solved; residue: AFC `c7d885c3`, AF `101661fb` stale; esbuild version still unpinned in the manifest. |
| S10 FC 429s | full discovery per settle | FC hand-back note 2; `7b752dd` `cacheMs`/`fallbacks` | high | solved for FC/PB; AFC still on `84c6fb0`. |
| S11 env leak to gauntlets | denylist of four keys | AF Q5; `7b752dd` `INHERITED_ENV` | high | solved for gauntlets; not for the relay task (S6a). |
| S12 "no placement descriptor" | host bound only to its in-memory book | audit §4.1.5; `31ddd3f`; AF `d70eea5`; PB `fd13679` | high | solved; SDK gap (`descriptor` dropped by `sdk/court`). |
| S13 ref zeroed, tests crash | C: 100 % full | PB follow-up; today C: 95 %, E: 94 % | high | recovered; nothing prevents a repeat. |
| S14 court logs lost | `node/gauntlet.js:155` keeps one line | code | high | open. |
| S15 tunnel latency | quick tunnels: one connector, random ingress | PB follow-up measurements | medium | open; proposal only. |
| S16 silent casual fallback | relay could host a placed room | ADR 0014 | high | solved by removal; costs R3. |
| S17 nothing co-signed | custody needs fresh peers holding the title; one fresh node | `/peers` (two stale), live delta `cos: 0` | high | not a code defect; a fleet-size fact. The Monday operator test is the fix. |

### 5.2 litnode changes to keep, merge or upstream (in order)

1. **Keep master as is through `3482ee0` (0.12.1).** Every PROTOCOL-CORE change in the window is consistent with the standard and with each other; the seven settlement suites pass here (44/44) and the full suite passed for the litnode session (262/262 on `364435f`). No protocol change is pending.
2. **U1 `sdk/court`: `descriptor` in `envelope()` / `attest()` / `index.d.ts`** (outside the signed body, as PB does). Then PB, FC and AFC re-vendor at that commit. Small, no hash impact.
3. **U2 relay task env allowlist**: `portable/run-af-relay.cmd` (and the `install-task.cmd` relay registration) pass only `PORT`←`RELAY_PORT`, `AF_ROOT` and the OS basics from `node.env`; everything else the relay needs comes from `AF_ROOT\.env`. Same rule as `INHERITED_ENV`. Closes S6a at its source.
4. **U3 court logs**: `node/gauntlet.js` writes each child's stdout/stderr to `<dataDir>/gauntlet-logs/<rulesetId>/<matchId>.log` with a size cap and rotation; `lastLine` stays for the error message. Closes S14.
5. **U4 AFC integration: moved to the fork session** (`local_89665a1c…`, 24 Oct, by the user). Railway is deprecated stack-wide, so the AFC host and its court key need a home other than the Railway named below. As first written: `titles/afc.adapter.js` with the real court pubkey (user supplies it from Railway), `npm run conformance`, `npm run bundle:title`, roster entry (`rulesetId: 'afc.v1'`, `kind: 'attested'`, `status: 'attested'`, `login: 'arcade'`), standard §14 row. AFC repacks its verifier with the current packer and re-vendors `sdk/court` after U1. Registration and Railway env are user steps.
6. **U5 verifier bytes by hash**: `GET /verifier/<rulesetId>?build=<hash>` + `VERIFIER_BUNDLES=<id>=<path>` on the publisher's node, fetched and held by custodians like server bundles (standard §11 phase 2's prerequisite; no runner yet). Until it lands, `tools/release.mjs` attaches the registered verifier `.tgz` + sidecar as release assets.
7. **U6 packer provenance**: `tools/bundle-server.mjs` records `source.esbuild` (version) in the hashed manifest, as FC already does; expose the packer as `sdk/bundle` so PB/FC/AFC stop reaching into the checkout. New packs only; registered hashes are untouched.
8. **U7 disk and temp**: tests and `sdk/host` take `TMPDIR`/`LITNODE_TMP`; `/health.disk` reports free space and a write probe of `dataDir`, red below `LITNODE_MIN_FREE_MB` (already a doctor floor since `f8fe52e`). Closes S13's silent half.
9. **U8 truth in docs and roster**: `SETTLEMENT-STANDARD.md §14` → PB `866bb9eb` / `11203288`, FC registration status, AFC row; `cabinet/config.js` roster `buildHash` either generated by `tools/vendor-cabinet.mjs` from `rulesets/*.json` or removed (the node's `/health.rulesets` is the truth the page already shows). Merge or drop `c44b3b1`.
10. **U9 design notes, no code yet**: (a) `/bond-proof` replaces the arcade-origin allow with a nonce the Nodes page must have obtained from the node's own origin (invariant 7); (b) EpochAnchor liveness: a proposer that cannot resolve a final match's stats after N polls asks any fresh peer's `/delta/<id>` (not only host, custodians, panel) and, failing that, reports `statsMissing` on `/health` so the fleet sees a stalled hour; (c) tunnel: `TUNNEL_REGION` for named tunnels, or a start-up probe that re-rolls a quick tunnel until p50 < 30 ms (S15); (d) `sdk/court boundKey()` and a shared shell handshake in `sdk/client.js` (4.2 duplicates).

### 5.3 Product workarounds to delete once the upstream lands

| After | Delete |
| --- | --- |
| U1 | PB `signSubmission` descriptor splice (`services/court/src/litnode-report.ts`); FC/AFC need nothing |
| U2 | AF: keep `AIR_PARTNER_IDS` as a feature; drop the "blank `AIR_PARTNER_ID` in `.env`" instruction and the inheritance paragraph in `docs/deploy.md` |
| now (fleet is 0.12.1) | AF client-side participant filter in `packages/client/src/proof.ts` |
| arcade serving `rpcFallback` (done) | AF `DEFAULT_RPCS` can shrink to one last-resort entry; PB/FC re-vendor picks up `rpcFallback` |
| U6 | FC's own tar builder (`scripts/arc/verifier/build.ts`) can call the SDK packer; PB's path-based wrapper likewise |
| U9d | AFC `identity.ts` + vendored keccak; PB `playerKey.ts` keccak copy |

### 5.4 Reverts

None recommended. Considered and rejected:

- **ADR 0014's relay retirement**: keep. Restoring a relay-signed ranked path would reopen S16; the R3 cost is real but should be paid with more gauntlet operators, not with the relay.
- **PB `scores()` forfeit inflation (`ebb9aff`)**: keep; `866bb9eb` is registered and served. A cleaner rule (rank by `winnerTeam`, not by inflated points) is a future ruleset, not a revert.
- **PB uncommitted `PlayerPawnPB.ts`**: not a revert, a hold. It changes game code, so it rolls the game build and the verifier again. Commit it only together with the next verifier pack and registration, after `11203288` is active, or there will be three verifier hashes in flight for one title.
- **`c44b3b1`**: merge, do not drop.

### 5.5 Target version

**litnode 0.12.1, protocol 4, settlement standard v4 at `3482ee0`** for every product today; generation-3 contracts stay. The next cut is **0.12.2 = U1–U3 (+U4 if the AFC key arrives)**, no protocol change, and the three courts re-vendor `sdk/court` at that tag. Gen-4 deploy is a separate decision (it changes every operator's bond flow).

### 5.6 User steps this audit surfaces (not for me)

1. Register PB verifier `11203288…` (publisher wallet) so live results become `checkable`; decide the "register before promote" rule.
2. Register FC ruleset `b16bc0a2…` and verifier `56cfff04…` (this picks the owner wallet), then drop the desktop's flood-control `COURTS` entry if any remains.
3. Push Pickle Brawl `master` (38 commits); decide the fate of `PlayerPawnPB.ts`.
4. Control Plane: ship a 0.12.x runtime that defers to the task node (Codex); until then, do not open it on a publisher machine.
5. Operators on an elevated task: re-run `install-task.cmd` once; everyone: update to 0.12.1 (m16 and rapture-ch are stale peers).
6. Free space on C: (95 %) and E: (94 %).
7. Confirm whether LitForge is a sixth product with a repo I should include.
