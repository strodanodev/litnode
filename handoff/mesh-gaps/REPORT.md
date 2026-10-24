# Mesh gaps: diagnosis, repros and fix designs (24 Oct 2026)

Branch `claude/mesh-gaps-2accd3`, cut from litnode `master` @ `caad4c6` (0.12.1, protocol 4). Diagnose, reproduce, design: **nothing consensus-relevant is implemented.** The only code on this branch is three characterization tests and their entry in `npm test`.

Live reads were made on 24 Oct 2026, 10:00–11:30Z. Sources: the desktop node's read-only API (`/health`, `/peers`, `/snapshot`, `/fleet`, `/deltas`), and about 70 `eth_call`s through `infra-partner-http`, paced at 350 ms (NodeDirectory, NodeStake, MatchBook, TitleRegistry). No transaction was sent, no live process was touched and no `.env` value was read. The Agent Fighter (AF) and Pickle Brawl (PB) repos were read only.

## Summary

| # | Gap | Verdict | Severity | Recommended fix | Consensus impact | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Operator quorum is the single point of failure | **Confirmed.** 1 of 4 needed operators online; escalation can never seat; EpochAnchor can never reach quorum | Critical | Recruit witness-only nodes: NAT is fine, no tunnel needed (proven). Ship a protocol-4 Control Plane. Unbond the 10 dormant Termux bonds. Fix the arcade's operator count | none: user/ops steps + arcade release | S code, ops-heavy |
| 2 | Aborting a hosted match is free; a player's own node can host | **Confirmed, and wider.** Also: one dissenting seat voids any match below 13 operators; a losing player can refuse to sign | High | Chain-derived host and seat reliability record that demotes in the draw. Participant exclusion only as hygiene | **protocol bump (5)**; counters on MatchBook = **new contract generation (5)** | M |
| 3 | The panel can only get the ledger from the host | **Confirmed, and wider.** An unfed escalation is never expired by the mesh; real AF ledgers (108–211 KB) may not fit `escalate()` | High | Custody before settle (seats pull and sign a receipt, host settles after 2), any-holder fetch, seats expire unfed escalations | **node release** | S–M |
| 4 | Casual matchmaking uses publisher-picked lists | **Confirmed** | Medium | AF/PB casual queue on the mesh from any node, own key when unframed; publisher relay only for the account API and wagers | node: none (litnode already places casual); title releases | M (title repos) |
| 5 | Attested titles are judged by the publisher's court | **Partly.** Verifiers are now registered (PB `11203288`, FLOOD CONTROL `56cfff04`; FLOOD CONTROL live results are `checkable`); the challenge path and host roots are unbuilt; the publisher bond does not exist | Medium (first party), High (third party) | §12 host roots first, then the §11 ChallengeBook with a title bond | **new contract generation (5)** + protocol bump for the anchored root | L |
| 6 | The database must only trust final results | **Confirmed.** Every AF credit comes from the relay's word; PB pays on the court's signature and on client POSTs; nothing in any title waits for finality | High (once value is real) | A Vercel crediting function: `MatchBook.statusOf` = Final plus a delta that recomputes to the chain's hash, idempotent per match id | none (studio repos + Vercel) | M |

**Order of work.**

1. **Operators (gap 1, user/ops):** a protocol-4 Control Plane, unbonding the dormant Termux stake, and three NAT'd witness operators. Without these nothing ranked happens, every dispute voids and no hourly root finalizes.
2. **litnode 0.12.2, node release, no protocol change:** gap 3 (a) custody before settle, (b) any-holder fetch, (e) seats expire unfed escalations; and gap 1's `rankedShortfall()` counting staking wallets.
3. **Protocol 5 + contract generation 5, one migration:** gap 2 (reliability counters + participant exclusion) together with gap 5 §12 host roots. Bundle it with the pending gen-4 deploy, so operators re-bond and re-enrol once.

**Before the economy carries real value:** gap 6's crediting cron (studio repos, no litnode change). After that: gap 4 (title releases) and gap 5 §11 (L).

Repro tests on this branch (they assert TODAY's behaviour, so the suite stays green and a fix flips them):

| File | Asserts | Result |
| --- | --- | --- |
| `demo/gap-1-witness-behind-nat.test.mjs` | three witnesses nobody can reach inbound seat, attest and finalize | pass, 16 s |
| `demo/gap-2-free-abort.test.mjs` | a participant's node is drawn as host/seat; an abandoned commit voids unslashed; one dissent voids below 13 operators | pass ×3, 5 s |
| `demo/gap-3-ledger-host-only.test.mjs` | the host stops after settle → no attest → extended → escalating → unfed and never expired → Void, host unslashed | pass, 111 s |

Full suite with the three files added to `npm test`: **271/271 pass, 0 skipped** (764 s; `publisher-offline` ran against the AF checkout).

---

## Gap 1: operator quorum is the real single point of failure

### Evidence: the numbers (24 Oct, ~11:00Z)

The deployed contracts are **generation 3** (`contracts/deployed.testnet.json`: NodeStake `0x3CFe…3717`, MatchBook `0x90D6…2e5b`). Generation 4 is source only.

| | Count | Detail |
| --- | --- | --- |
| NodeDirectory entries | 17 | `keys()` |
| Distinct active operators on NodeStake | **16** | `standingOf` per key, plus pool-only keys; `totalActive()` = **21 LITVM** |
| … of which the Termux test fleet (5 Oct) | 10 keys / 10 operators (8 hold nothing else) | `agent0…9-termux.example.com`: unreachable by construction, never online, not in the pool. `agent0`/`agent1`'s wallets (`0xa246`, `0xd82c`) also bonded the pool keys `3a7f6e4d`/`10a06539`, offline since 5 Oct |
| Online and on protocol 4 | **1** | the desktop `5b703f12` (0.12.1); `/peers` lists only itself; `/health.inbound.peers = 0` |
| Online but incompatible | 1 | `18d67ecd` (operator `0xb04f…`), 0.11.26, protocol 3; directory updated 11:04Z today. An un-updated install, i.e. the same outcome a Control Plane 0.1.15 install (bundled 0.11.29) produces |
| Recently online, now unreachable | 3 | m16 `50bb1da9` (`0x8697…`, last announce 08:33Z, then HTML/"fetch failed"); rapture-ch `a0b440f4` (`0x729a…`); `f0fb2ab8` (`0xb236…`, since 17 Oct) |
| Runs the AF server bundle | 1 | desktop (`/health.gauntletServers`: `e8d8f22b…`; heartbeat `gauntlets: [agent-fighter.v1, pickle-brawl.v1]`) |
| Witness role, online | 1 | desktop |
| Escalation pool (`MatchBook.pool()`) | 9 keys / **7 operators** | `0x04be` (desktop), `0x8697` ×2, `0xb236` ×2, `0xea09` (the rewards treasury wallet), `0xb04f`, `0xa246`, `0xd82c` |
| MatchBook windows | settle 1800 s, attest 300 s, escalation 300 s, drawDelay 2 | `params()` |

What each threshold needs, against what exists:

- **Ranked commit** needs a host plus three seats under four distinct staking wallets, all fresh (`protocol/placement.js:77-86`, `contracts/MatchBook.sol:198-216`). Online: 1. **Short by 3.**
- **Escalation** seats nine from the pool, excluding the host's and the three seats' operators: 13 distinct operators (`MatchBook.sol:378-390`, `:290`). The pool holds 7 even if everyone were online. **Every dispute voids** (gap 2.3).
- **EpochAnchor** finalizes at `quorumBps` 5000 of `totalActive` (`contracts/EpochAnchor.sol:99-100`), so it needs 11 of 21 LITVM. Online: 1. The dormant Termux fleet alone holds ~10. **No hourly root can finalize**, even with every non-Termux key online and agreeing (11 is the exact ceiling). This also blocks the `/proof/stats`-against-EpochAnchor route of gap 6.
- **Who these wallets are.** By the project's own notes, m16, the Termux fleet and the codex-* nodes are the user's machines; only rapture-ch looks third party. A four-operator panel today would be four wallets of one person. That is a fact about recruitment, not a code defect, but it bounds what "independent witnesses" means right now.

### Can a witness-only node run behind NAT with no tunnel? **Yes.** Reproduced.

- **Gossip** is push-only, and each push's reply carries everything the receiver would push back: heartbeats, queue, delta adverts, MatchBook hints, placements (`node/litnode.js:1486-1503`). A node that can only dial out still learns placements and Committed/Settled hints.
- **The panel draw** reads role, build, eligibility, stake and operator. It never reads reachability (`protocol/placement.js:67-68, 77-86`).
- **Inbound is not needed** for any of: the ledger fetch from the host (`node/matchbook.js:488-491`), build hydration by hash (`node/litnode.js:946-956`), or `attest` / `finalize` / `expire` / `escalate`, which all go out over RPC from the hot key.
- **The code already says so:** "fine for a witness, not for a seed or a LAN host" (`node/litnode.js:599-602`), and `docs/HOST-A-NODE.md:118`.
- **`demo/gap-1-witness-behind-nat.test.mjs`** runs three witnesses that advertise an address that refuses every connection and seed only from the host. All three are drawn, fetch the build outbound, attest from their own keys, and the match goes Final (16 s).
- **One caveat (U9b, already open):** a proposer resolving a final match's stats fetches `/delta` from host/custodians/panel by address (`node/matchbook.js:337-341`). A NAT'd seat cannot be that source. It does not block attesting.

### Minimum viable operator profile

- **A witness-only node:** roles `mesh,witness`; litnode 0.12.1 (protocol 4); no tunnel, NAT or CGNAT fine; any always-on box.
- **Bond:** minStake **1 tLITVM** on NodeStake v3. Witness-eligible after `eligibilityAge` 120 s; the unbonding period is 3600 s.
- **A delegated hot key funded with zkLTC.** One attest is ~75k gas (`node/matchbook.js:110-114`). At the live base fee (68M–357M wei) that is ~5–27 µzkLTC per attest; a faucet drip lasts thousands of matches.
- **Online at match time:** a heartbeat inside 2 epochs, i.e. ~4–6 s (`protocol/snapshot.js:17`, `EPOCH_MS` 2000).
- **The rest is automatic:** the build hydrates by hash, and the node joins the escalation pool on its own once delegated and funded (`node/matchbook.js:184-200`).
- **Per title, one reachable host is also needed:** for AF, a node with `GAUNTLET_SERVERS=agent-fighter.v1` and a public URL (today only the desktop).
- **Quorum for AF ranked, then:** 1 reachable gauntlet host + 3 NAT'd witnesses under 3 other wallets.

### What blocks recruiting it

1. **The one-click installer makes an excluded node.** Control Plane 0.1.15 embeds 0.11.29 (protocol 3). `18d67ecd`, still on 0.11.26 and excluded, shows how that looks from the mesh. *(Codex/website repo; user step.)*
2. **Dormant bonds count against quorum.** The 10 Termux keys hold ~half of `totalActive`, so EpochAnchor can never finalize. They also make the directory look populated while nothing answers. *(User step: unbond them, or run them.)*
3. **The arcade's quorum warning counts the wrong thing.** `rankedShortfall()` (`cabinet/app.js:719-723`) counts distinct `operator` values from `/peers`. Those are the heartbeat's self-asserted label (`node/litnode.js:1455-1458`, e.g. `"publisher"`), not the staking wallet the draw uses (`protocol/staking.js:68`). One wallet running four nodes with four labels shows "enough", while the draw seats fewer than three and the match silently plays casual. Two wallets sharing a default label show a false alarm. The comment's "never a false alarm" does not hold. *Fix:* `/peers` adds `stakeOperator` (`stakes[id].operator`) and `eligible`; the warning counts staking wallets, requires the witness role and eligibility for three of them, and names the missing gauntlet host for gauntlet titles. *(Node + arcade release, no protocol change.)*
4. **No reason to stay online.** GasRefund pays back 80% of gas, and rewards POINTS start only at 10+ active operator wallets. Recruitment has to come first.
5. **Escalation needs 13 operators** before any dispute is decided rather than voided (gap 2.3).

### Recommendation and user steps

1. **User:** unbond the Termux fleet (or bring it online as witnesses). Ship a Control Plane that bundles 0.12.1 (Codex). Bring m16 back (it is in `PREFERRED_RELAYS` and the pool).
2. **Recruit operators:** publish the witness-only profile above in `docs/OPERATORS.md` as the default ask ("no tunnel, no port forward").
3. **litnode 0.12.2 (node + arcade, no protocol change):** `/peers.stakeOperator`, and `rankedShortfall()` on staking wallets. **User:** release, register on ReleaseRegistry, redeploy the arcade.

---

## Gap 2: aborting a hosted match is free, and a player's own node can host

### Evidence

- **Placement takes no participant input.** `placement({ nodes, manifest, rulesetId, matchId, beacon, regions })` (`protocol/placement.js:32`). `eligible()` filters on role, build and standing (`:18-22`); `drawPanel()` on node key, the host's operator, role and eligibility (`:77-86`). The browser's `acceptsHost` runs the same function (`:89`).
- **The gauntlet partition is outermost** (`:54-55`). A node that is the only runner of a title's match server hosts every match of that title.
- **`MatchBook.commit`** checks the host's delegate and activity, panel eligibility and operator distinctness. It knows nothing of participants (`contracts/MatchBook.sol:198-216`; it sees only `descriptorHash`).
- **`node/matchbook.js:203-211`** (commit) and **`node/gauntlet.js:391`** (start a server for any placement naming this node) add no check either.
- **Participants are player keys**, bound to wallets only by `PlayerProfile.bindKey` (`contracts/PlayerProfile.sol:60-64`) and readable with `ownerOfKey` (`:88-91`). Nothing in placement or settle compares that owner with a node's staking operator.
- **Free abort, host side.** A commit nobody settles is voided by `expire()` with no slash (`MatchBook.sol:334-346`), driven by the seats' backstop (`node/matchbook.js:525-527`). Void results never reach a ladder (`protocol/matchbook.js` `foldChain`).
- **Free abort, seat side (new).** A dissent forces escalation (`MatchBook.sol:260-276`). Below 13 operators `escalate()` voids for want of candidates with nobody slashed (`:290`), and an unfed escalation expires to void (`:338-341`). Already covered as honest behaviour by `demo/matchbook-vm.test.mjs:248-261`.
- **Free abort, player side (adjacent, not in the brief).** Ranked needs every participant's ledger signature (`protocol/log.js:66-75`, `node/settle.js:257`), and AF's gauntlet will not post ranked without both (agent-fighter `packages/server/src/server.ts:980-985`). A losing player who closes the tab before signing voids the match the same way.

### Repro: `demo/gap-2-free-abort.test.mjs` (3 tests, all pass)

**2.1: draw shares for a participant's own bonded node** (4,000 draws per row, from `placement()`):

| Mesh | Hosts its operator's own match | Sits on the panel when not host | In the match at all |
| --- | --- | --- | --- |
| 4 equal operators | 25.1% | 75.0% | **100%** |
| 6 equal operators | 16.5% | 50.1% | 66.6% |
| 13 equal operators | 8.1% | 22.5% | 30.6% |
| 4 operators, the player's node stakes 10× | 25.1% | 75.0% | 100% (host draw is not stake-weighted) |
| player's node is the only AF gauntlet runner | **100%** | 0% | 100% |
| player's node + one other gauntlet runner | 49.8% | 37.9% | 87.7% |

The test asserts:
- the 4-operator row (host share between 15% and 35%, and at least one panel seat);
- the sole-gauntlet row (100%);
- that adding `participants` or `owners` changes nothing: placement has no such input.

The other rows come from the same `placement()` run in a scratch script.

**2.2:** a host commits and never settles (it killed its per-match server). `expire()` gives Void; the bond and treasury are unchanged; the fold shows `{ official: 0, pending: 0 }`.

**2.3:** four operators. Seat 3 (the participant's second wallet) attests a false hash, the honest host feeds the ledger at once, and `escalate()` voids. The dissenter keeps its whole bond; the 0–3 loss is on no ladder.

**Combined effect on today's mesh size:** a player who runs **one** bonded witness node can void any ranked match they are losing, as host (don't settle) or as a seat (dissent), at no cost.

### Root cause

Placement treats "who plays" as irrelevant to "who judges". Every exit from the lifecycle short of Final is costless by design ("honest crashes happen", and a dispute the mesh cannot adjudicate voids). Nothing remembers who keeps causing voids.

### Options

**A. Participant exclusion.**
- **How:** placement gains `owners`: the `ownerOfKey` of each participant at the descriptor's `beaconBlock`, read by node and browser alike. `eligible()` and `drawPanel()` drop nodes whose staking operator is in it. The node already pins standings at that block (`chain.standingAt`); the cabinet already reads PlayerProfile.
- **What it buys:** it stops the zero-effort case (play and host from one wallet).
- **What it does not buy:** it is useless against a second wallet, which costs one more minStake bond (1 tLITVM) and 120 s of eligibility age. The host draw is not stake-weighted, so that sybil node keeps the 25% / 75% / 100% shares above. Unbound keys (`pb:`, guests) exclude nothing.
- **Security cost:** none (it only removes candidates). Small liveness cost: a 4-operator mesh with one participant-operator can no longer seat a panel, so it plays casual.

**B. A reliability record for hosts and seats, from chain events alone.**
- **Per host key:** `committed`, `settled`, `expired` (Committed → Void with no Settled), and `withheld` (Settled → Escalating → expired unfed, i.e. gap 3's ledger withholding).
- **Per seat key:** `dissentsVoided` (a dissent that ended Void without a seated escalation).
- **Placement demotes, never excludes:** within the existing partitions, a stable partition puts hosts with `expired + withheld ≥ k` over their last `n` commits after the others. `drawPanel()` divides a seat's weight key by `1 + dissentsVoided`.
- **Honest crashes** (the desktop's BSODs) cost hosting share, not stake. Demotion inside the gauntlet partition does nothing while there is one gauntlet runner; it bites from two.
- **It must be deterministic for the browser.** Two ways:
  - **B1, events:** node and browser fold MatchBook logs up to `beaconBlock`. The node has them (`matchbook-events.jsonl`). The browser would need `eth_getLogs` over a long window, which on Liteforge is 10–16 s per >20-block range and 429-prone. Not viable in a page.
  - **B2, counters on chain (recommended):** MatchBook increments `hostRecord[hostKey]` in `commit` / `settle` / `expire`, and `seatRecord[witnessKey]` in the void-on-escalate path. Placement reads them with `eth_call` at `beaconBlock`: one batched read per candidate, the same pattern as standings. Cost (estimate): pack the four `uint64` counters in one slot, so each event is one SSTORE. That is ~22k gas the first time a key gets a record and ~5k after (nonzero → nonzero): **~10k per match** (commit + settle) on a 445k-gas match.
- **Security cost:** a griefer can make an honest host look unreliable only by being its panel and forcing escalation, which already voids the match; the record makes that griefer's own seat record worse too. B2 adds no trust.

**C. Make the abort cost something** (rejected for now). Slashing on `expire()` punishes honest crashes and a host that a DoS'd player knocked offline. A small "liveness deposit" per commit, refunded on settle, is a GasRefund-shaped variant to revisit once the treasury pays real money.

**D. Player-side abort** (follow-up, separate design). Players sign rolling checkpoints, e.g. the head every N ticks. A ranked match that ends with one player's signatures stopping early settles as a forfeit from the last co-signed head, which witnesses replay. This changes settle intake (`verifyLedger`'s all-signers rule), so it is a protocol bump, plus AF client/server work.

### Recommendation

**B2 + A together**, as one placement change: exclusion for hygiene, the record for the sybil and the repeat aborter. Plus the operator count from gap 1, which is the real fix for 2.3: at ≥13 operators a dissent is adjudicated and the loser is slashed.

### Release impact

- Both change placement's output, so they are a **protocol bump (4 → 5)** under §16's pattern: nodes on 4 and 5 refuse each other's descriptors, the arcade redeploys with the vendored `cabinet/protocol/`, and every operator updates in one window.
- B2 additionally needs **a new contract generation (MatchBook gen-5)**. Every operator re-enrols, `contracts.json` changes and the arcade redeploys. Combine it with the gen-4 deploy that is already pending (it changes every operator's bond flow anyway).
- **Nothing is relabelled:** placement is not in any result hash beyond the `descriptorHash` binding, so finalized matches stay final.
- A alone (no B) could ship as protocol 5 without a contract change.

### What the user must do

Decide A/B2. Then: gen-4 + gen-5 deploy (chain transactions), the 0.13.0 release and its registration, the arcade deploy, and the coordinated operator update.

---

## Gap 3: the panel can only get the ledger from the host

### Evidence

- **`witness()` asks one address:** `hostAddr(p?.hostKey ?? s.hostKey)` and nothing else (`node/matchbook.js:485-491`). `hostAddr` is the last remembered heartbeat's `addr`, not a fresh one (`node/litnode.js:561`), so after the host dies seats keep dialling a dead URL for up to 10 min (`FORGET_AFTER_EPOCHS`, `:899`).
- **Nobody else holds it.** Off-chain custody skips ranked placed results whenever MatchBook is on (`node/litnode.js:589-590`).
- **The Settled event claims custody that does not exist yet:** `custodians = [nodeId, ...panel]` (`node/matchbook.js:222-224`) is written before any seat has fetched anything.
- **The escalation backstop needs that same ledger:** a seat feeds `escalate()` only from `ledgers` (what it verified) or its own store (`node/matchbook.js:534-536`). If it never fetched, nobody on the mesh can feed it.
- **New: an unfed escalation is never expired by the mesh.** `drive()` expires an unsettled commit (`:525-527`) but has no branch for `escalating` past `feedBy` (`:533-537`). The match stays Escalating until an outsider calls `expire()`, and the seats' duty lingers on disk (`matchbook-duties.json`) with it.
- **New: AF ledgers are large.** The two live AF ranked ledgers on the desktop (22 Sep finals `118c53a2`, `524cd42d`) are **211,255 and 107,904 bytes** canonical. That is ~3.4M and ~1.7M calldata gas, and the first is above the 128 KiB transaction-size limit that geth-derived pools enforce by default. **Unverified on Liteforge** (it would need a send), but if it holds, a long AF match cannot be escalated at all.

### Repro: `demo/gap-3-ledger-host-only.test.mjs` (pass, 111 s)

- **Setup:** four operators, real NodeStake + MatchBook (settle 60 s, attest 4 s, escalation 6 s). The host settles a ranked tug.v1 match signed by both players, and **stops the moment its settle transaction is sent** (`onEvent` `tx`/`settle`).
- **What follows:**
  - the seats see Settled from the log;
  - `witness-failed` is emitted; 0 Attested;
  - the window is **Extended** once, then the match goes **Escalating**;
  - every seat logs `holds no ledger to feed it`;
  - 30 s past `feedBy` the status is **still Escalating** (nobody expires it);
  - an outsider's `expire()` gives **Void**, and the host's bond is untouched and still active.

### Root cause

The data-availability path for ranked results is "the host serves it". MatchBook's own escape hatch, posting the ledger to escalate, needs someone else to hold it, which nothing arranges.

### Options

The on-chain `ledgerHash` makes any source safe, so every option is a liveness choice, not a trust one.

| Option | How | Covers | Security cost | Impact |
| --- | --- | --- | --- | --- |
| **(a) Custody before settle** | After the match, the host serves `/ledger/<id>` and hints "ready" in its heartbeat. Each seat (it knows it is a seat from Committed) pulls it outbound, verifies signatures and replays (the `cosign` path), and returns a signed receipt `{matchId, ledgerHash}` on its next gossip push. The host sends `settle` once 2 of 3 receipts are in, or after `T_hold` (e.g. 120 s, well inside the 1800 s settle window) | host dies after settle; NAT seats (pull, not push) | none; the host also learns its seats are alive before paying settle gas | node release |
| **(b) Any-holder fetch** | `witness()` tries the host, then the Settled event's `custodians`, then the other seats, then any fresh peer advertising the match | a host that dies after (a) delivered to 1–2 seats | none (hash-checked) | node release |
| **(c) Players push** | The AF client POSTs its signed ledger to the seats' addresses (from the commit) at match end | reachable seats only; not NAT ones | none | AF client release |
| **(d) Ledger on chain at settle** | Ledger in settle calldata | everything | none | **rejected:** 1.7–3.4M gas per AF match and likely over the tx-size limit |
| **(e) Expire unfed escalations** | `drive()`: `escalating` and `now > feedBy + margin + seat stagger` → `expire()` | the stuck state found above | none | node release |

### Recommendation

**(a) + (b) + (e) in litnode 0.12.2.**
- **None of it touches the result hash, placement, the proof rule or contracts,** so it is a **node release**. Old seats simply don't pull, and the host settles after `T_hold` as today.
- **What it leaves:** a host that withholds the ledger from its seats now simply never settles. That is gap 2.2's free expiry, which gap 2's B2 record counts.
- **Add (c)** to the AF client when convenient.
- **Separate follow-up: the ledger-size question for `escalate()`.** Options: let the nine fetch by hash from custodians (contract change), or post chunked. It matters only at ≥13 operators.

### What the user must do

Release and register litnode 0.12.2; update the desktop and m16.

---

## Gap 4: casual matchmaking still uses lists the publisher picked

### Evidence (AF: survey of `agent-fighter` @ `4fd7fa3`, spot-checked)

**Standalone agentfighter.wtf.**
- **Server choice:** `?ws=` overrides; otherwise the cached relay; otherwise a dead `wss://no-relay.invalid` (`packages/client/src/main.ts:460-466`).
- **Relay discovery** reads only `PREFERRED_RELAYS` (desktop, m16; `mesh.ts:131-134`) through NodeDirectory and NodeStake. It takes the first healthy one, else the first dead one, and never a non-publisher node, by design (`mesh.ts:125-130`, `:238-246`).
- **Both relays down:** OFFLINE, "wagers paused", a free practice run in the arcade mode (`main.ts:3591-3609`, `:479`, `:2815`).

**Arcade-launched.**
- Already mesh-placed. `?room=LIT-…`, `?match=`, `?player=`, `?build=` plus `cabinet:init.match` are parsed (`main.ts:1602-1631`).
- The seat is claimed at `?ws=` with a challenge signed by `cabinet:sign-seat` (`main.ts:512-537`), then play goes to the gauntlet ws (`main.ts:1729-1757`).
- The relay refuses `LIT-` rooms (`server.ts:2070-2073`). The client labels it "CASUAL · PLACED BY THE MESH" (`main.ts:1807-1812`).

**Matchmaking state.**
- Everything is relay memory: the wager queue, friendly rooms, live matches, arcade runs (`server.ts:723-739`); pairing is FIFO (`server.ts:1489-1548`).
- **There is no casual quick-match on the relay at all:** PvP is the paid wager queue or friendly room codes. Guests play locally only (`main.ts:3008-3010`).
- **A restart loses** the queue, rooms and runs; escrow comes back through the 30-min sweeper (`supabase/migrations/0003_escrow_sweeper.sql:19-63`).

**Identity.**
- The relay needs an AIR JWT for every online mode (`server.ts:1925-1926`, `:2039-2041`).
- The arcade's ed25519 key is "never an identity" on the relay (`net.ts:270`); on a gauntlet the seat ticket is the identity (`server.ts:1904-1915`).
- There is no PlayerProfile binding anywhere in AF.

**Gauntlet.**
- Needs no publisher secret (`gauntlet.ts:5-12`).
- **Accepts casual** (`GAUNTLET_PLACED_MODE`, `gauntlet.ts:105`; casual posts unsigned, `server.ts:980-993`).
- The env it needs is all node-supplied `GAUNTLET_*` (`gauntlet.ts:21-23, 86-107`).

**Wagers:** publisher-only by construction. They need `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (`persist.ts:1930-1941`), and every money RPC is service-role only.

### Evidence (PB: survey of `PickleBrawl` @ `35c14c3`; `pb-runtime` @ `b6192ca` has the same services code; spot-checked)

**Backend pick.**
- Mesh discovery runs only with `VITE_BACKEND=litnode`; otherwise the build uses a fixed `VITE_MATCHMAKER_URL` (`web/main.ts:426,455`).
- The allowlist is `VITE_LITNODE_NODES`, falling back to `VITE_LITNODE_NODE`, which is also `preferNode` (`web/main.ts:429-439`).
- **A node outside the list is never used, "not even when every listed one is down"** (`web/litnodeBackend.ts:28-35`).
- `followBackend` re-checks every 60 s and returns to the primary (`litnodeBackend.ts:249-263`).
- **Publisher node off:** the matchmaker URL is null, social play is off and friend lobbies are gone. Local/bot play and the Vercel API still work (`litnodeBackend.ts:187`, `src/meta/social.ts:97-99`).

**Casual formation.**
- Friend lobbies only; there is no queue (`services/matchmaker/src/server.ts:10-23`).
- The last READY calls `POST /gauntlet/start` on the matchmaker's **own** node (`LITNODE_NODE_URL` + `LITNODE_GAUNTLET_TOKEN`; `lib/gauntlet.ts:11-18, 91-143`). Nothing goes through placement.

**Lobby state.**
- Every lobby, its membership, presence, matches (with per-court secrets and reconnect tokens) and player keys are in-memory Maps (`lib/lobby.ts:240-250`).
- A restart loses all of it, including reconnects to courts still running (`lobby.ts:4-8, 103-128`).
- All clients must reach the same node (`litnodeBackend.ts:59-61`), so a failover mid-lobby loses the lobby.

**Arcade launch.**
- The placed host arrives as `?ws&room&player&match`, and the seat ticket is signed through `cabinet:sign-seat` (`src/net/litnodeLaunch.ts:4-100`).
- `cabinet:init.match.descriptor` is ignored (`web/arcadeIdentity.ts:15-17, 118-122`); the court fetches it itself from `GAUNTLET_NODE_URL` (`services/court/src/court.ts:296-313`).

**Identity.**
- Lobbies need AIR (`matchmaker/src/server.ts:11-21`).
- A seat is the AIR `sub`, upgraded to the arcade key only if `ownerOfKey` binds both to one active profile; otherwise it is `pb:<sub>`, casual-only (`lib/playerKey.ts:4-21, 47-84`).

**Wagers:** none player-vs-player. Open Play is a paid bot mode whose result is **client-reported** (`openPlay/rules.ts:10-32`, `handlers/openPlay.ts:8-11`).

**What ties court and matchmaker to the publisher's machine** (neither has a DB):
- `cwd` = `pb-runtime` on that disk (`gauntlets/pickle-brawl.json:8`);
- `COURT_IDENTITY` is a key-file path there (`:15`);
- the adapter pins one attestor key and `affinity: 'operator'` (`titles/pickle-brawl.adapter.js:72-75`);
- the API trusts only `COURT_PUBLIC_KEYS` (`services/api/src/lib/courtSignature.ts:46-49`);
- `MATCHMAKER_URL` assumes the matchmaker sits on the same node's gateway (`gauntlets/pickle-brawl.json:16`).

### Root cause

**Casual placement already exists in litnode.**
- `mode` is free-form at the queue (`node/litnode.js` `/queue`, `mergeQueue` `:918-925`).
- `pair()` matches equal modes (`protocol/pairing.js:54`); only `ranked` commits (`node/litnode.js` `commitIfHost`).
- The gauntlet starts a server for any placed match naming the node (`node/gauntlet.js:391`).
- M1 placed a casual match on m16 on 5 Oct.

**What is missing is the title side:**
1. **No player key off the arcade.** AF's seat claim needs the parent frame to sign (`main.ts:519`).
2. **No mesh queue in the standalone client.** It knows only the relay.
3. **Rooms and lobbies** live in one process's memory: AF's relay, PB's matchmaker.
4. **The account API and money** are welded to the same process (AF's relay; PB's AIR-holding matchmaker plus allowlist), so "find the publisher's server" doubles as "find a matchmaker".
5. **PB's court is checkout-bound and key-file-bound** to the desktop (no server bundle; one pinned attestor).

### Design

| Concern | Decision |
| --- | --- |
| Identity | Casual needs only a key. Unframed clients generate and keep a local ed25519 key (`sdk/client.js localSigner`; WebCrypto). Framed clients keep the arcade key. AIR is needed only for economy (wagers, items, pets): the relay. |
| Matchmaking location | The mesh queue: `POST /queue` to **any** fresh bonded node, discovered from `contracts.json` → NodeDirectory → fresh entries (the arcade's `seeds.js` logic). No preferred list. |
| Wagers | Stay publisher-only (5 Oct decision). Later: wagers on placed **ranked** matches, escrow released only on `Finalized` (gap 6). |
| Relay vs gauntlet | Casual runs on the gauntlet bundle on the drawn host: the gauntlet partition puts runners first, and casual needs **no panel**, so it survives on **one** non-publisher node that opts in to `GAUNTLET_SERVERS=agent-fighter.v1`. The relay keeps the account API, the wager queue and arcade runs. |
| Lobby state | The mesh queue is gossiped with a 60 s TTL, so a restarted node loses nothing but its in-flight matches. Friendly rooms: both players queue with `mode: 'room:<h(code)>'`. `pair()` pairs equal modes only, so a room pairs only with itself, with **no protocol change**. AF's gauntlet must pass the placed mode through instead of coercing it to `casual` (`gauntlet.ts:105`). |

### Per-repo change list

- **litnode** (none required; optional, node release):
  - `docs/` names the `room:` mode convention;
  - `sdk/client.js` exports a discovery helper (directory → fresh nodes) so titles stop re-implementing it.
- **agent-fighter:**
  - `packages/client/src/main.ts`: CASUAL = mesh queue + `claimMeshSeat`/`startOnline` with a local key when unframed;
  - `packages/client/src/mesh.ts`: `PREFERRED_RELAYS` only for the account API and paid modes; a casual node list from the directory;
  - `packages/server/src/gauntlet.ts:105`: pass `room:*` through;
  - optionally retire relay friendly rooms (`server.ts:2061-2087`).
- **picklebrawl** (casual lobbies on the mesh):
  - `services/matchmaker/src/lib/gauntlet.ts`: request a casual placement (both seats queue `mode: 'room:<h(lobbyId)>'` with their keys) instead of `/gauntlet/start` on its own node;
  - `lib/lobby.ts`: launch from the placement (host ws + per-seat signed ticket); derive `matches` from the placement so a restart keeps reconnects;
  - `web/arcadeIdentity.ts`: read `cabinet:init.match` (host + descriptor);
  - `web/litnodeBackend.ts`: matchmaking needs no allowlisted node (the API stays pinned).
- **litnode, for PB:**
  - `gauntlets/pickle-brawl.json` → a hashed server bundle (no machine paths), the same move AF made (R2/R3 in the audit);
  - `titles/pickle-brawl.adapter.js:72-75`: per-node court keys, or L2 via the registered verifier, so a non-studio host can attest. **This is a new ruleset build: register it.**
  - **The matchmaker still holds AIR secrets and stays the publisher's** (or moves to Vercel). Only the court must travel.

### What the user must do

AF and PB releases (their sessions). At least one non-publisher operator opts in to the AF server bundle.

---

## Gap 5: attested titles are judged by the publisher's court, not the nodes

### Evidence: verifier registration, read on TitleRegistry `0x4A0d…4489` today

| Title | Build | Status |
| --- | --- | --- |
| pickle-brawl.v1 | ruleset `866bb9eb` (live), `98d23e4e` | active |
| | verifier **`11203288`** (game `0bb00f76`, named by `pb-runtime` and by PB master) | **active**: the audit's mismatch is closed |
| | verifier `e4cb7337` | active (superseded) |
| | `db035b78` | revoked |
| flood-control.v1 | ruleset `b16bc0a2`, verifier `56cfff04` | **active**: registered 23 Oct ~11:20Z, after the audit's source |
| agent-fighter.v1 | ruleset `7414ddf3`, server `e8d8f22b` active; `859e7215`, `00f7319c` revoked | — |

**Live consequence.**
- FLOOD CONTROL's run at 24 Oct 06:44Z settled **`checkable`** (verifier `56cfff04`).
- PB's last live match (`7ebcf551`, 23 Oct 15:46Z) is `attested`. I did not read the block `11203288` was registered in, so whether it was active at 15:46Z is unknown. A PB match settled now should come out `checkable` wherever the settling node holds the log.
- Every PB and FLOOD CONTROL result is casual and unplaced, with 0 co-signers.
- **Risk:** PB master `35c14c3` changed movement code ("court keeping inside each movement step") without a new verifier pack. Promoting it to `pb-runtime` would make live courts name `11203288` while running a different game. Under a challenge (§11) that is an honest court that looks wrong. Rule: **pack and register the verifier before promoting a game build.**

**What is unbuilt.**
- §11 phase 2: no challenge contract, no runner, and verifier bytes do not travel (U5, `GET /verifier/<id>`).
- §12: no host roots; L1/L2 stats prove only against a node's local root (`docs/SETTLEMENT-STANDARD.md:269-272, 351-362`).
- The publisher bond of `docs/PUBLISHER-BONDS.md` §1.3 (a title key on NodeStake) does not exist. Generation-4 `NodeStake.bond` takes an ed25519 proof from the key itself (`70c63ee`), which a `keccak256("title", rulesetId)` key cannot give.
- **PUBLISHER-BONDS §5 is an LLM-ruling ladder, not a deterministic verifier slash.** §1.3's "slashed when" table does not list "court signed a result its verifier refuses". The standard's §11 step 3 points at a slash that is not specified anywhere.

### §12 first: per-host hourly roots (the dependency)

**Contract sketch** (an `EpochAnchor` gen-5 extension, or a sibling `HostRoots`):

```solidity
mapping(uint64 => mapping(bytes32 => bytes32)) public hostRoot;   // epoch → nodeKey → root (first write wins)
event HostRoot(uint64 indexed epoch, bytes32 indexed nodeKey, bytes32 root, uint32 count);
function commitHostRoot(uint64 epoch, bytes32 root, uint32 count, bytes32 nodeKey) external {
    require(stake.mayActFor(nodeKey, msg.sender));
    (, , bool active) = stake.standingOf(nodeKey); require(active);
    require(epoch < block.timestamp / 3600 && block.timestamp / 3600 <= epoch + GRACE_EPOCHS); // ended, not stale
    require(hostRoot[epoch][nodeKey] == 0);                                                  // no equivocation
    hostRoot[epoch][nodeKey] = root; emit HostRoot(epoch, nodeKey, root, count);
}
```

**Gas** (estimate from opcode costs, not measured):
- 21,000 intrinsic + ~2,300 calldata + 22,100 cold SSTORE + ~5,000 for the two NodeStake reads + ~2,000 for the log ≈ **50–55k per host per hour**.
- At 68M–357M wei that is 3.4–19.6 µzkLTC per host-hour, about 0.0001–0.0005 zkLTC per host per day.
- Throughput at 200 hosts: 200 tx/hour (0.06 tx/s), negligible beside per-match traffic.

**Folding into EpochAnchor.**
- `hostRootsRoot(h)` is a tree over `H('hostroot', nodeKey, root)` sorted by `nodeKey`, from `HostRoot` events alone, so it is deterministic again.
- The anchored root becomes `pairHash(resultsRoot_L3, pairHash(statsRoot_L3, hostRootsRoot))`.
- An L1/L2 result then proves in three hops: leaf → host root → `hostRootsRoot` → anchored root.
- **Cross-host season stats stay out of the anchor in v1.** Folding them needs every host's deltas: one offline host would stall every hour (the U9b liveness problem, multiplied). Per-host stats lines inside each host root are provable; the cross-host season line is a database job over proofs (gap 6).

**Failure modes and answers.**

| Failure | Answer |
| --- | --- |
| A host is offline at the hour's end | It may post late within `GRACE_EPOCHS`; after that its results stay local |
| A late root changes an hour already anchored | EpochAnchor accepts proposals for hour *h* only after *h* + `GRACE_EPOCHS` (it already refuses unended hours, `freezeAt`), so every proposer folds the same root set |
| A host omits a result (censorship) | Custodians co-signed it (§8). A custodian can post a complaint naming the delta, a later record |
| A host includes fabrications | The host root is the host's word over results whose level is inside the leaf. An L1 leaf still needs a court signature to mean anything, so nothing is upgraded |
| Equivocation | First write wins |
| Spam | Bonded and active keys only |

**Release impact:** a new contract generation, and a protocol bump (the anchored root's composition changes `protocol/epoch.js anchorRoot`; nodes on 4 and 5 would propose different roots).

### §11: the challenge path

**Contract sketch: `ChallengeBook` (gen-5).**
- **Prerequisites:** TitleRegistry learns `courtKeys(titleId)` (publisher-set, `activationDelay` applies). NodeStake learns **title bonds**: `bondTitle(titleId, amount)` from `ownerOf(titleId)`, with no key proof, slashable by adjudicators.
- **The flow:**

```
challenge(titleId, report, courtSig, hostRootProof, verifierHash) payable-in-LITVM-bond
  · Ed25519.verify(courtSig, report, courtKey ∈ courtKeys(titleId))   (contracts/Ed25519.sol exists, 8d830dc)
  · the report's resultHash is included in a committed host root     (needs §12)
  · verifierHash active for titleId; inside challengeWindow of the host root's epoch
  · one open challenge per result; bond ≥ challengeBond(titleId)
  → Challenged; drawBlock = now + drawDelay
seat(matchKey)          — nine from the pool, stake-weighted, one per operator, excluding the title publisher's
                          operators and the host's (MatchBook._draw, reused)
attest(matchKey, seat, finalHash, reproduced)   — each seat ran verify(log) itself
resolve(matchKey)       — stake-weighted strict majority:
  · majority says "does not reproduce" → slash the title bond (challengeSlashBps), void the result,
    refund the challenger's bond + a cut of the slash
  · majority reproduces → the challenger's bond goes to the seats and treasury
  · no majority / too few seats → void the challenge, refund the bond, nobody slashed (same rule as MatchBook)
```

**Who can challenge, bonds, griefing.**
- **Anyone can challenge.** The bond must exceed the nine seats' cost: 9 × attest gas plus up to 9 × 15 min of compute, so price it in LITVM per title, admin-set.
- **One open challenge per result,** inside a window (e.g. 24 h after the host root).
- **Spam** costs the bond.
- **Seats that don't answer** earn nothing and get the same `dissentsVoided`-style record as gap 2.
- **A malicious challenger with nine friendly seats** must win a stake-weighted draw seeded by a future block: the same assumption MatchBook already makes.

**The runner sandbox and its limits.**
- **What it runs:** publisher code on operators' machines. Admit it the way server bundles are admitted: only hashes registered and active on TitleRegistry, fetched by hash (U5) and checked before running, and only on operators who opt in (`CHALLENGE_SEAT=1`).
- **Isolation:** one process per `verify()` call (standard §11), no env, a read-only working copy and an empty temp dir. Node's permission model (`--permission` with fs/child-process/worker restrictions); OS-level network isolation, because Node's model does not cover sockets: a per-process firewall rule on Windows, a network namespace on Linux. Ceilings `memoryMb ≤ 2048`, `timeoutS ≤ 900`, enforced by the parent (kill on breach = "does not reproduce", per §11).
- **Determinism risk:** WASM physics (AFC's Rapier) across CPUs can make honest seats disagree. The majority rule absorbs a minority of flaky seats, but a title whose verifier is not bit-stable cannot be challenged fairly. Conformance should replay each registered verifier on two machine types before activation.

**The publisher's bond.**
- **First-party titles:** today the publisher, the admin and the treasury are one person (`0x04be…`, treasury `0xeA09…`). Slashing a first-party title's bond into the first-party treasury is no deterrent. The challenge path's value is the *public record* that a court was wrong, and voiding that result.
- **Third-party titles:** it is a real economic stake.

### Effort and order

1. **§12 host roots:** contract + node posting + `protocol/epoch.js` fold + browser proof path. **M (2–3 weeks).** Gen-5 + protocol bump.
2. **U5 verifier bytes by hash** (already planned): **S**.
3. **§11:** ChallengeBook, TitleRegistry court keys, NodeStake title bonds, the runner and its sandbox, cabinet UI. **L (4–6 weeks).** Gen-5.

Ship 1 and 3 in the same generation as gap 2's B2 counters, so operators migrate once.

### What the user must do

Decide whether attested titles need prize eligibility before mainnet (that is what §11 buys). Then: contract deploys, title-bond deposits from the publisher wallet, and registrations. Process rule: **register the verifier before promoting a game build** (PB `35c14c3`).

---

## Gap 6: the database must only trust final results

### Evidence (AF, spot-checked)

**Every credit and debit runs on the relay** with `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`. **None waits for finality, and nothing reads MatchBook, `/delta` or `/proof/stats`.** Mesh data is display-only in the client (`main.ts:347-373`, `proof.ts:66,82`), and a gauntlet credits nothing (`gauntlet.ts:9-10`).

| Path | Trusts | Idempotent |
| --- | --- | --- |
| `record_match` (payout, refund, XP, W-L, Elo, ticket), from `finishMatch` (`server.ts:1161`) | the relay's own re-sim of client-sent inputs, plus its disconnect ladder (`server.ts:1017-1046`) | yes: `matches.id` PK (`0021_elo.sql:197-205`), `credit_ledger unique(profile, reason, match)` (`0002_credits.sql:28`), `tickets.match_id unique` (`0020_tickets.sql:65`) |
| Solo win (fee + 1) | a log the **client** simulated; a pace check is the only guard (`server.ts:1057-1067`) | same |
| `arcade_extract`, free drinks, deep-exit pet (`server.ts:2683-2801`) | the relay's in-memory board | run token, nonces |
| Level-up pulls, daily/referral bonuses, `record_defense`, escrow sweep | relay rows / AIR JWT / the absence of a `matches` row | nonces, unique keys |

No client-callable SECURITY DEFINER path was found: every one is revoked from public, anon and authenticated (e.g. `0021_elo.sql:368`, `0019_lock_definer_rpcs.sql:30`). **Not verified:** that production Supabase matches the migrations (no DB calls were made).

**Flag:** every AF credit is the relay's word on a result that is never final anywhere. Ranked mesh matches, the only results that *are* final, pay nothing in the economy. Wager, solo and arcade never reach MatchBook at all.

### Evidence (PB, spot-checked)

Nothing in `services/api` reads MatchBook, `Finalized`, `/delta`, `/proof/stats` or EpochAnchor.

**`POST /api/court/result`**
- **Pays on the court's word, before finality.** The only check is the court's Ed25519 signature over its own report, with the key in `COURT_PUBLIC_KEYS` (`handlers/courtResult.ts:139-144`); there is no other auth (`lib/courtSignature.ts:7-8`).
- **Amount:** uncapped XP plus 25/5 pickles under a 300/day cap (`courtResult.ts:150-187`).
- **Idempotent** per seat: nonce `court:<matchId>`, unique `(air_sub, nonce)` (`migrations/001:83`, `011:5-7`).
- **No check that the match id was ever a real placement or lobby match.**
- Arcade key seats get `unknown-player` and are **not paid** (`courtResult.ts:188-190`).
- Pairing with the client's report goes **by score within 15 min, not by match id** (`postgresStore.ts:559-584`). A client report that lands first makes the court's result pay 0.

**`POST /api/match`** (AIR bearer)
- **Credits from a client POST.** The client's own summary is sent whenever the court did not report (`src/meta/matchResult.ts:125-135`).
- Bounded by 30/h, 2000 XP/day and the pickle cap; idempotent only per a client-made nonce (`routes/match.ts:27-46, 108-112`).

**Open Play**
- **Credits from a client POST:** debit on enter, payout from the client's result (`handlers/openPlay.ts:123-195`).
- Once per run (`010:15`).

**Not match-driven** (fine as is): grants, on-chain and PayPal purchases (tx hash PK), shop debits.

**Secrets (names):** `DATABASE_URL`, `COURT_PUBLIC_KEYS`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PARTNER_JWT_PRIVATE_KEY`, `PARTNER_JWT_KID`, `OPENPLAY_ADMIN_TOKEN`, `PICKLE_WALLET`, `PICKLE_RPC_*`, `AIR_*`.

### Root cause

The economy predates the mesh. It credits where the match ran (the relay), and the mesh's Final is never consulted. The two meet nowhere.

### Design: one crediting function per studio, on Vercel

**Inputs.** The function is fed a queue of match ids, never a log scan. The studio's own servers (relay, court, matchmaker) already know every match id they served, so at match end they insert a `pending` row. Liteforge `eth_getLogs` is too slow and rate-limited for a serverless cron (720 calls an hour at 20 blocks per call); `statusOf` is one `eth_call` per pending match.

```sql
create table mesh_credits (
  match_id      text primary key check (match_id ~ '^[0-9a-f]{64}$'),  -- the MatchBook key (protocol/matchbook.js matchIdBytes32)
  ruleset_id    text not null,
  state         text not null default 'pending' check (state in ('pending','final','void','expired','credited')),
  final_hash    text, block bigint, checked_at timestamptz, credited_at timestamptz
);
-- credit rows keep the existing ledger's unique(profile, reason, match) — reason = 'mesh'
```

**The loop** (`/api/mesh-credit`, a Vercel cron every minute, authenticated by `CRON_SECRET`):

1. For each `pending` row (oldest first, ≤ 25 per run): `MatchBook.statusOf(matchId)` through the contract set's `rpc` → `rpcFallback` (from `arcade.litvm.games/contracts.json`; no secret). Back off on 429.
2. `Final` → fetch the delta from **any** node (`/delta/<id>`; the node's word is not trusted). Recompute `resultHash(delta)` (`protocol/result.js`, vendored) and require it to **equal the chain's** `resultHash`. Credit from that delta's `participants`/`scores`/`stats`, the exact check `node/matchbook.js:331-347` makes before folding stats.
3. Map each participant key to an account with `PlayerProfile.ownerOfKey(key)`; it must be `active`. The studio's account table keys on that wallet. **AF has no key→account binding today:** add `player_keys(key pk, profile_id)` bound by a signed challenge, or bind through PlayerProfile.
4. In **one transaction**: `update mesh_credits set state='credited' where match_id=$1 and state='pending' returning *`. Credit only if a row came back; the ledger's unique key is the second fence. Re-runs, two concurrent crons and a crash mid-loop all credit once.
5. `Void` → `state='void'`: release escrow back to both players, no Elo.
6. Still `Committed`/`Settled`/`Escalating` past `committedAt + totalWindow()` (3300 s live) → `expired`: refund. With gap 3's fix (e), Escalating no longer sticks.

**Secrets:** `DATABASE_URL` (Neon) or `SUPABASE_SERVICE_ROLE_KEY`, plus `CRON_SECRET`, in Vercel env only. No chain key: the function only reads.

**`/proof/stats` against EpochAnchor** works only once hourly roots finalize, which needs 50% of active stake online (gap 1). Today none do, so per-match `statusOf` is the only finality signal available. Keep `/proof/stats` for season-stat displays, not credits.

**Attested titles (PB, FLOOD CONTROL, AFC).** Their results never reach MatchBook (casual, unplaced). "Final" for them means:
- today: the court's signature (L1) or `checkable` (L2) plus ≥ 2 custody co-signatures;
- after gap 5: past the challenge window and unchallenged.

Until then the database trusts the studio's own court key. That is acceptable for a first-party economy, but it must be labelled as such, never as mesh-final.

### Per-repo change list

- **agent-fighter:**
  - `supabase/migrations/0033_mesh_credit.sql` (`mesh_credits`, `player_keys`, service-role-only `credit_mesh_match()`);
  - `api/mesh-credit.ts` (Vercel cron, the loop above);
  - the gauntlet path (`server.ts:952-1005`) enqueues the match id at post time;
  - `server.ts:1161-1256` keeps escrow and refunds, and moves XP/Elo/tickets for **mesh** matches to the cron.
  - **Product decision:** relay-only modes (wager, solo, arcade) either move onto gauntlets plus finality, or keep relay-trusted rewards, labelled.
- **picklebrawl:**
  - `services/api/migrations/012_mesh_credits.sql`: the same `mesh_credits` table; credits keyed `match:<matchId>:<sub>`;
  - `handlers/courtResult.ts`: verify the signature as today but **record pending, never pay**;
  - a new `api/mesh-credit` cron:
    - **ranked placed PB matches** (none yet: "chain lifecycle: not yet", standard §14): pay from `statusOf` = Final, as for AF;
    - **casual/attested ones:** pay from the court report only once the node's delta exists with `proof ≥ attested` and its `resultHash` recomputes. That is still the court's word, labelled; after gap 5 it is "unchallenged past the window";
  - `postgresStore.ts:532-650`: key by match id and drop score pairing;
  - `handlers/match.ts`, `handlers/openPlay.ts`: no pickle credit from client reports for human matches. Bot-only Open Play stays client-reported by product choice, capped and labelled.
  - **Mapping arcade keys to AIR subs** (`ownerOfKey` → the profile's sub) so key seats get paid instead of `unknown-player`.
- **litnode:** export `resultHash` + `matchIdBytes32` + `statusOfCall` as a small `sdk/chain` module, so studios stop vendoring `protocol/*` piecemeal (node release, optional).

### What the user must do

The Vercel env vars, the migrations, and the cron deploy (studio repos). Unbond dormant stake before relying on EpochAnchor.

---

## Could not verify

- Whether Liteforge enforces a 128 KiB transaction-size limit on `escalate()` calldata. That needs a send; it is the user's step or a future test.
- Who owns each operator wallet. The ownership notes above come from project notes, not chain data.
- That production Supabase/Postgres match the migrations read in the studio repos.
- The production values of PB's `VITE_LITNODE_NODES` / `VITE_LITNODE_NODE` and Vercel's `COURT_PUBLIC_KEYS` (env values were not read).
- Gas for `commitHostRoot` and the gap 2 B2 counters: estimated from opcode costs, not measured.
