# Amendment 1 to the settlement architecture: one title contract

**Status: approved 28 Oct 2026, folded into
[SETTLEMENT-ARCHITECTURE.md](SETTLEMENT-ARCHITECTURE.md) (rev 2)** in §0,
§4, §8, §9, §12, §14, §17 (rows 6, 8, 10–12, 15, new row 16), §18 and §19.
This file keeps the reasoning and the per-title check. The open items (A8)
stay open in rev 2 §19. Nothing here is built.

## A0. Why

The goal is the user's rule: **every title on litnode settles its
matches whether or not the host's or the publisher's PC is online.**

Rev 2 gets most of the way there. It replays every result on the mesh and
lets any bonded operator host. But it still hands a title up to four
artifacts (ruleset, verifier, server bundle, attestor set), several paths
through them, and one gap it doesn't close: **the evidence lives on the
host until the match settles.** The match server records the seats' heads
(§8), and custodians fetch the log from the host after settlement (§4). If
the host's machine dies mid-match, or after the match but before it
settles, the evidence goes with it.

This amendment reduces rev 2 to one contract every title meets, adds the
two pieces that close that gap, and adds a gate that proves it per title.

## A1. The title contract

A title settles without its publisher **if and only if** it meets all six.
`npm run title:release` (A5) refuses a release that doesn't.

| # | The title must | Why |
|---|---|---|
| C1 | Ship **one judging interface**, `verify(log) → { result, stats, finalHash }`, hash-pinned on TitleRegistry | any node can judge any match without asking anyone |
| C2 | Have its seats **sign rolling input heads in the arcade shell** (`{ matchId, seat, ticks, head }`, at most every 30 s and at the end) | the evidence exists without any server vouching for it, and the title can't skip it |
| C3 | **Stream its evidence to the custodians while the match runs**: log chunks and the latest heads | the host dying no longer loses the match |
| C4 | Run on **commodity transport**: a server bundle any opted-in node runs, or the browser, never a machine of the publisher's | nothing to fail over to |
| C5 | Reach the mesh as **one envelope** (`POST /ledger`), from **anyone holding the signed evidence** | no special submitter |
| C6 | Pass the **release gate**: bit-exact replay on two machines and the generic publisher-offline drill | the guarantee is checked before release, not hoped for after |

What stays outside the contract, by the stack split (litnode =
multiplayer, matchmaking, resolution, match stats; the studio database =
the rest): sign-in, lobbies, inventory, credits, the economy. Those are the
studio's and may go down with the studio.

## A2. What changes in rev 2

**Kept as is.** TitleRegistry and hash-pinned artifacts; players sign;
any bonded operator hosts (§3); the replay is the judge (§4) with k = 3
witnesses or custodians and `VERIFY_BUDGET_MIN`; one envelope; the
secrets rule (§11); the Rapture gate (§6); fair hosting (§14.1); matchmaking
split (§7); one contract generation (gen-5).

**Changed.**

| Rev 2 | Amendment 1 |
|---|---|
| A sandbox ruleset **or** a verifier bundle judges | **One judging interface (C1), two packagings.** A light title's ruleset is its verifier and runs in the per-step sandbox. A heavy title ships a verifier bundle that runs out of process under the manifest's runtime. The node calls the same `verify` either way |
| The match server records seats' heads (§8) | The **shell** also sends each head straight to the match's custodians (C3). The server's copy is no longer the only one |
| Custodians fetch the log from the host **after** settlement (§4) | Custodians receive **log chunks during** the match (C3). After-settlement fetch stays as a fallback |
| The placed host commits and settles a ranked match | If the host hasn't settled within `settleGraceS` of the match's end, **the first custodian in hash order settles it** from the streamed evidence (C5). Needs MatchBook gen-5, which rev 2 already deploys |
| `title:release` rebuilds artifacts and prints one signer batch (§9) | It also runs the **release gate** (C6) and refuses on failure |

**Dropped from the default path.**

- **Attestor sets and studio courts** become the labelled exception for a
  title that can't ship a verifier. Its results stay L1 `attested` or L2
  `checkable`. They're never described as surviving the publisher.
- **Match orders keep their attestor set** (§7), since an order key is
  how a studio lobby starts a match. That's the only remaining use.

**Deferred.** A generic input relay built into litnode. AF ranked
already has its server bundle, and AF casual is covered by the relay split
(row 9). Revisit it when a third-party lockstep title arrives without a
server.

## A3. Evidence custody during play (C3)

Who streams depends on who holds the full log.

| Title shape | Holds the full log | Streams log chunks | Streams heads |
|---|---|---|---|
| Lockstep (AF, AFC 1v1) | every client | each seat's shell | each seat's shell |
| Server-authoritative (PB) | the match server | the match server | each seat's shell |
| Single-player (FLOOD CONTROL) | the client | the shell, at the end (a run is short) | the shell |

**Mechanics.**

- The custodians are known at placement: `custodians(matchId, rulesetId,
  hostId)` already exists in `node/litnode.js` and is deterministic, so the
  shell computes the same three.
- A chunk is `{ matchId, from, to, bytes, chunkHash }`; each head commits
  to the running log hash, so a chunk is checked against the last head
  before it's kept.
- A custodian keeps chunks under its existing log budget (`MAX_LOG_BYTES`)
  and drops them when the match settles or expires.
- Bandwidth is one small POST per seat per head interval. The exact cost
  per title is an open item (A8).

**What each failure does.**

| Goes down | Before this amendment | With it |
|---|---|---|
| Publisher PC, before the match | settles if the title already meets rev 2 | settles |
| Host node, mid-match | match lost; players re-queue | settles from the last head every seat signed (§14.1, forfeit rule); the title's rules decide |
| Host node, after the match, before settle | match lost | the first custodian settles after `settleGraceS` |
| One custodian | nothing | the other two hold the evidence; `k` widens to 5 when a seat skips (§4) |
| Every node you own | down | **down.** Only independent operators fix this (A7) |

## A4. Where each title stands against the contract

Checked against litnode 0.12.3 (`d8582be`) on 28 Oct 2026.

| Title | C1 | C2 | C3 | C4 | C5 | C6 | Main blocker |
|---|---|---|---|---|---|---|---|
| Agent Fighter, ranked | yes (sandbox ruleset) | partial (whole-ledger signature at the end) | no | yes (server bundle) | yes | partial (AF-only drill) | C3, plus nodes that opt in to the bundle |
| Agent Fighter, casual | n/a (studio-only, ADR 0014) | — | — | no (relay holds `SUPABASE_SERVICE_KEY`) | — | — | relay split (row 9) |
| FLOOD CONTROL | registered, not run by nodes | yes (`cabinet:sign-run`) | n/a (single-player) | yes (browser) | yes | no | nodes running its verifier |
| AFC | not yet | no | no | yes (`gauntlet.ts` bundle) | yes | no | verifier, heads; determinism unproven |
| Pickle Brawl | no (engine can't run in the sandbox) | no | no | no (court and matchmaker on the desktop) | yes | no | the pure-JS sim extraction (20–32 days est.) |

## A5. The release gate (C6)

`npm run title:release -- <spec>` runs, in order, and stops at the first
failure:

1. Rebuild every artifact twice from clean commits; refuse on any hash
   mismatch (rev 2 §9).
2. Conformance (`sdk/conformance.mjs`).
3. **Determinism:** replay the title's fixture logs on two machines (or two
   runtimes from the manifest's floor) and compare `finalHash`.
4. **The publisher-offline drill:** the generic form of
   `demo/publisher-offline.test.mjs`. Five in-process nodes, the
   publisher's node holds the title, then stops. The title's own bots play
   a match on a non-publisher node, the host is killed halfway, and the
   match must settle from custody and be replayed by the panel. The title
   supplies `bots` in its release spec; nothing else is title-specific.
5. Print one signer batch (rev 2 §9).

A title that passes is listed in the arcade as **survives publisher
offline**; one that doesn't stays playable and is labelled with its proof
level.

## A6. Build order (litnode)

| Step | What | Release | Unblocks |
|---|---|---|---|
| B1 | **Verifier runner**: witnesses and custodians run `verify` (rev 2 §14 item 1) | 0.13.0 | FLOOD CONTROL, then AFC and PB |
| B2 | **Shell heads to custodians** and **log chunks** (C2, C3) | 0.13.0 (protocol 5) | host death mid-match |
| B3 | **Custodian settle after `settleGraceS`** (C5) | 0.13.0 + MatchBook gen-5 | host death after the match |
| B4 | **Generic drill + gate** (C6) | node-only, any release | per-title proof |
| B5 | Generic input relay | deferred | third-party lockstep titles |

B1–B3 ride the 0.13.0 bump rev 2 already plans, so operators see one
migration window, not two.

**Title order:** AF ranked (closest; mostly ops), FLOOD CONTROL (cheapest
replay, no live play, proves B1 on a real title), AFC, then Pickle Brawl
once its sim is extracted. Until then PB stays attested and labelled L1.

## A7. What this does not fix

- **Independent operators.** Every bonded operator today is the user's.
  A three-seat panel of one person's nodes is that person agreeing with
  themselves. The contract makes settlement possible without the
  publisher; it doesn't make it trustless without independent operators.
- **Reachability.** Hosts behind quick tunnels change hostnames on
  restart; one public Liteforge RPC rate-limits.
- **Non-deterministic titles.** No contract judges a game whose replay
  differs between machines. They make a deterministic core or stay
  attested.
- **Live hidden information.** Replay works after the match; hiding state
  during it needs commit-reveal or a dealer, per genre.

## A8. Open items

1. The head interval: rev 2 says ≤ 30 s. Is 30 s of lost play on a host
   death acceptable for AF, or should lockstep titles sign every 10 s?
2. `settleGraceS`: long enough for a slow host, short enough that players
   see a result. Proposed 120 s.
3. Gas for a custodian settle: does GasRefund pay the custodian as it pays
   the host?
4. Per-title stream bandwidth, measured on AF and PB before B2 ships.
5. AF casual: wait for the relay split, or bring B5 forward?

## A9. Effect on the migration table (rev 2 §17)

- Rows 6 and 12 (litnode and contracts, protocol 5 and gen-5) gain B1–B3.
- Rows 8 (PB), 10 (AFC, FC) gain C3 streaming and must pass C6 as their gate.
- Row 11 (AFC ranked) needs C6 green before ranked switches on.
- Row 15 (arcade) gains the shell's streaming and the "survives publisher
  offline" label.
- New row 16 (litnode): the release gate, node-only.
- No row is removed.
