# Prompt: troubleshoot the mesh's decentralization gaps

Paste everything below the line into a fresh Claude Code session opened on
`E:\NPC\AGENT 24 NODE`.

---

You are troubleshooting six gaps between the litVM Games mesh as built and its
goal. The goal is a "serverless" decentralized gaming network. Nodes run
matches and settle match data. Vercel serves the frontends, and Neon/Supabase
hold the studio's storage: inventory, credits and economy. A game must keep
working when its publisher's machines are offline.

Your job is to **diagnose, reproduce and design**, not to ship. For each gap:
- confirm or refute it in the code, citing `file:line`;
- reproduce it with a test where you can;
- give the root cause;
- lay out fix options, each with its security cost and its consensus impact.

Then stop and report. Implement nothing consensus-relevant without the user's
go-ahead.

## Where to work

- **litnode** (this repo): `E:\NPC\AGENT 24 NODE`, branch `master`. Other
  sessions edit this checkout, so work in your own worktree:
  `git worktree add "E:/NPC/litnode-mesh-gaps" -b mesh-gaps master`. Commit
  there, locally only.
- **Read-only:**
  - Agent Fighter: `E:\NPC\AGENT FIGHTER\agent-fighter`. Its master holds
    `4fd7fa3`, an unpushed netcode fix; leave it.
  - Pickle Brawl: `E:\NPC\PICKLEBRAWLv2` (runtime worktree `pb-runtime`).

  Other sessions own these repos. Put the changes you'd make there in your
  report.
- **Start with these:** `docs/SETTLEMENT-STANDARD.md` (canonical, v4),
  `protocol/placement.js`, `contracts/MatchBook.sol`, `node/matchbook.js`,
  `demo/publisher-offline.test.mjs` (the M5 "publisher can vanish" test), and
  `handoff/settlement-v4/7-integration-audit-2026-10-24.md`. Gaps U5–U9 there
  are open; don't redo them.
- **graphify:** `graphify-out/graph.json` exists. Run `graphify query "<question>"`
  before your first grep or source read for a codebase question, and use
  `graphify path` / `graphify explain` for relationships. Put this rule in
  every subagent prompt that explores code.

## Rules (non-negotiable)

- **Commit locally on `mesh-gaps` only.** No push, release, TitleRegistry
  registration, Vercel deploy or chain transaction: those are the user's
  steps. Reading the chain is fine. The public RPC rate-limits the whole PC
  (a 429 storm on 10 Oct 2026), so keep reads few and never loop on errors.
- **Secrets stay in managed env.** Never print, copy or read the values of
  `.env` or key files. Refer to environment variables by name only.
- **Don't touch the live node.** Never stop or restart the `litnode` task
  (the `E:/NPC/LITNODE-DESKTOP` install) or the `litnode-relay` task. Don't
  edit that install or its `node.env`. Its `http://127.0.0.1:7801` API is
  fine to read.
- **Stay out of the website repo** (litgaming-website: Control Plane).
- **Don't trade away security.** No named Cloudflare tunnel; the user ruled
  it out. Railway is deprecated everywhere.
- **Consensus changes are new versions.** A change to placement, the result
  hash, the proof rule or contracts is a new build, protocol or contract
  generation. Old results are never relabelled. Say which one each fix needs.
- **Repro tests characterize today.** Write them as
  `demo/gap-<n>-<slug>.test.mjs` asserting today's (bad) behaviour, so the
  suite stays green and a fix flips the assertion. Run single files with
  `node --test demo/<file>`, and run the full suite in the background.

## What is already established (24 Oct 2026)

**Ranked lifecycle.**
- Placement is a pure function of a chain beacon, run by node and browser alike
  (`protocol/placement.js`):
  - **Host:** the first eligible node in a fixed order: gauntlet-runners,
    relay-fronting nodes, the publisher's nodes, the players' region, then a
    seeded hash. Not stake-weighted.
  - **Panel:** three witnesses, stake-weighted, under three operators other
    than the host's.
- `MatchBook` runs commit → settle → attest ×3 → finalize, with escalation
  to nine seats.
- Live windows are settle 1800 s, attest 300 s and escalation 300 s
  (`contracts/deployed.testnet.json`).
- `expire()` voids an unsettled commit with no slash
  (`contracts/MatchBook.sol:334`).

**Live state.** At 10:30Z on 24 Oct the desktop node (`0.12.1`, protocol 4)
saw **1 peer**. Ranked needs four distinct operators online, and escalation
needs 13.

**Who runs what when the publisher's desktop goes down:**
- **Stays up on Vercel:** the arcade, agentfighter.wtf, the Pickle Brawl
  (PB) web build and the PB API.
- **Survives the outage:** Agent Fighter (AF) ranked. It runs on whichever
  per-match server placement draws.
- **AF casual fails over to a fixed list:** desktop, then m16. The list is
  hardcoded as `PREFERRED_RELAYS` in AF
  `packages/client/src/mesh.ts:131`.
- **The PB matchmaker and courts fail over** through `VITE_LITNODE_NODES`.
  Their lobbies live in memory and are lost.
- `docs/STANDBY-HOST.md` still describes copying `.env` files to the standby.
  The user rejected that on 9 Oct; treat those steps as stale.

## The six gaps

### Gap 1: operator quorum is the real single point of failure
Measure the current state:
- bonded operators on NodeStake (generation 4);
- how many are online and on protocol 4;
- which run the AF server bundle and which have the witness role.

Use the node's `/health`, `npm run fleet`, NodeDirectory and NodeStake reads.

Then answer what the cheapest node profile is that still counts toward
quorum. In particular: **can a witness-only node run behind NAT with no
tunnel?** A witness fetches the ledger outbound and sends its attest over
RPC; check whether gossip needs it to be reachable inbound. Also check what
the arcade tells players when quorum is short (`rankedShortfall()` in
`cabinet/app.js`). Deliver numbers, the minimum viable operator profile, and
what blocks recruiting it.

### Gap 2: aborting a hosted match is free, and a player's own node can host
**Confirm:** check whether anything stops a node whose operator is a match
participant from being drawn as host or panel seat. Look in:
- `placement.js`: `eligible()`, `drawPanel()`;
- `MatchBook.commit` (`:198`);
- `node/matchbook.js`;
- `node/gauntlet.js`.

Participants are player keys bound to wallets by `PlayerProfile.bindKey`
(`contracts/PlayerProfile.sol:60`).

**Reproduce two things:**
- a participant-run node gets drawn as host;
- a host that kills its per-match server mid-match leaves the commit to
  expire into a void, with no Elo change and no slash.

**Design:**
- **Participant exclusion.** Say what it still buys against a player who
  bonds from a second wallet: the host draw isn't stake-weighted, so with
  four operators that's a 25% chance.
- **A liveness record for hosts.** It counts expired commits and demotes
  those hosts in the draw order, without slashing, because honest crashes
  happen. It must be derived from chain events alone, because the browser
  also computes placement (`acceptsHost`).
- **Release impact.** State whether either change needs a protocol bump or
  only a coordinated release plus an arcade redeploy.

### Gap 3: the panel can only get the ledger from the host
**Confirmed by reading:** `witness()` in `node/matchbook.js` (around
lines 477–491) fetches `/delta` and `/ledger` only from the host's address,
and needs the host's fresh heartbeat. `settle` names
`custodians = [nodeId, ...panel]` (`:223`).

**Reproduce it**, modelled on `demo/publisher-offline.test.mjs`: the host
settles, then stops before the panel fetches. Expect one window extension,
then escalation, then nobody able to post the ledger, then a void.

**Design the fix.** Since the on-chain `ledgerHash` makes any source safe,
options include:
- players' clients push the signed ledger to the panel, which is known from
  the commit before play;
- the host pushes the ledger to the panel before it calls settle;
- seats fetch from any holder.

### Gap 4: casual matchmaking still uses lists the publisher picked
AF casual on agentfighter.wtf uses the hardcoded relay order. Arcade
launches pass the drawn host as `?ws=`, and the M1 gate placed a casual match
on m16 on 5 Oct. PB uses `VITE_LITNODE_NODES` and `followBackend`.

Answer what stops casual play from always going through placement:
- identity (arcade keys vs anonymous players);
- matchmaking location;
- wagers, which stay publisher-only (decided 5 Oct);
- relay vs gauntlet;
- lobby state.

Deliver a design and the per-repo change list. Don't edit the AF or PB repos.

### Gap 5: attested titles are judged by the publisher's court, not the nodes
PB, FLOOD CONTROL and AFC settle at L1 ("attested"), or L2 ("checkable")
once a verifier is registered. Check verifier registration status; the audit
notes a PB hash mismatch (`11203288` vs `e4cb7337`) and FLOOD CONTROL
unregistered. Then scope the two phase-2 designs in `SETTLEMENT-STANDARD.md`:
- **§11, the challenge path:** bonds, who can challenge, griefing, the runner
  sandbox and its limits, and the slashing of the publisher's bond
  (`docs/PUBLISHER-BONDS.md` §5).
- **§12, per-host hourly roots:** gas per host per hour, how it folds into
  `EpochAnchor`, and failure modes.

Design only: a contract sketch, the security analysis and the effort.

### Gap 6: the database must only trust final results
Find what credits players after a match today, and what it trusts:
- AF: the Supabase credits, wager escrow and sweep in the relay;
- PB: the API on Vercel (`picklebrawl-api`) and its database.

Flag anything that credits from a host's or relay's word, or from a
non-final result. Design a Vercel function that credits only from MatchBook
`Finalized` events, or from `/proof/stats` checked against the `EpochAnchor`
root. It must be idempotent per match id, with its secrets in Vercel env.

## Order and method

1. **Gaps 3 and 2 first.** They are code-level and testable.
2. **Then gap 1**, which is measurement.
3. **Then gaps 4 and 6.** These are read-only surveys of the AF and PB repos;
   parallel subagents are fine, with the graphify rule in their prompts.
4. **Gap 5 last.** It is design only.

## Deliverable

`handoff/mesh-gaps/REPORT.md` in your worktree, committed on `mesh-gaps`,
alongside the repro tests. It opens with a summary table: gap, verdict
(confirmed / refuted / partly), severity, recommended fix, consensus impact
(none / node release / protocol bump / new contract) and effort.

Each gap then gets its own section:
- **Evidence:** `file:line`.
- **Repro:** the test file and its result.
- **Root cause.**
- **Options:** each with its security cost.
- **Recommendation.**
- **What the user must do:** releases, registrations, transactions, deploys.

End your turn with a hand-back of at most 15 lines: verdicts, the top three
fixes in order, the branch and commit, and anything you could not verify.

Out of scope:
- the desktop's crashes (BSODs: the user's machine steps);
- AF netcode (done in `4fd7fa3`);
- tunnels;
- WebRTC peer-to-peer, which is a separate proposal.
