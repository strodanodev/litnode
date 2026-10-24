# Settlement architecture: one flow for every title (design rev 2, 24 Oct 2026)

**Status: design for approval. Nothing here is built.** It extends
`docs/SETTLEMENT-STANDARD.md` (the v4 contract, protocol 4), which stays
canonical. §16 lists every amendment that standard would take. The facts
come from `handoff/settlement-v4/7-integration-audit-2026-10-24.md`, the
title repos as of 24 Oct, and litnode `caad4c6`.

**Rev 2** folds in the user's answers of 24 Oct:

| # | Question | Answer | Where it lands |
|---|---|---|---|
| 1 | Who may run a title's matches and judge them | **any bonded operator** | §3, §4 |
| 2 | Steps | **fewer**; prefer simplicity and composability | §5, §9, §18 |
| 3 | Matchmaking | **split** (ranked on the mesh; lobbies in the studio database) | §7 |
| 4 | Which titles settle on the mesh | **every litvm.games title, in-house and third-party**, plug and play; AFC ranked is WIP and must switch on without breaking anything | §9 |
| 5 | Sign-in | **one AIR sign-in** across arcade.litvm.games and litnode; the NODE web app is gated by the **Rapture NFT** (litVM testnet); only holders bond nodes for rewards and points | §6 |
| 6 | Secrets | **no service key or sensitive env in litnode code or data before production**; production = the testnet arcade going live as **Season 0** | §11 |

## 0. The target in one paragraph

**Play anywhere, sign at the seat, replay on the mesh, settle once.**

- A title is up to four **hashed artifacts on TitleRegistry**: a ruleset,
  a verifier, a server bundle (real-time titles), and an attestor set
  (only for a title that keeps a studio court). A node loads them by hash;
  no title needs a litnode release.
- **Players sign their own inputs** through the arcade shell. A host can't
  invent or drop a seat's inputs without the signatures showing it.
- **Any bonded operator** that opts in hosts the match. It holds no
  publisher key and is not trusted for the outcome.
- **The mesh replays every result** with the title's verifier: the three
  witnesses for a ranked match, the three custodians for everything else.
  Agreement co-signs, a mismatch disputes.
- **Credentials never reach a node.** A player signs in once, with AIR, at
  the arcade. Tokens, payments and the economy go to the studio API
  (Vercel, Neon or Supabase). Nodes see signatures, never tokens.
- **litnode holds one secret**: the node's own key. Season 0 doesn't launch
  until that is true.
- Everything reaches the mesh as **one envelope on one call**
  (`POST /ledger`, protocol ≥ 4).

```
 player browser ──(AIR sign-in, payments)──► arcade + studio APIs (Vercel) ── Neon / Supabase
      │  arcade shell: player key; signs seats, input heads, runs              │
      │                                                                     │ match order (lobbies)
      ▼                                                                     ▼
 any bonded operator node ── placement (mesh pairing) or match order ──► server bundle (keyless)
      │                                                                     │ log + seat-signed heads
      │ POST /ledger (one envelope, host's node key)  ◄──────────────────────┘
      ▼
 witnesses (ranked) / custodians (casual): fetch the verifier by hash, replay, co-sign or dispute
```

What changed from rev 1: rev 1 judged every attested title at a **studio
court** on Vercel and sampled 1 in 20 results for a challenge. Rev 2 makes
the **replay itself the judge**. That removes the court from the critical
path for Pickle Brawl and AFC, removes every per-machine court key, and
answers "can it settle with the publisher offline on free Vercel" with
"Vercel isn't on the settlement path at all".

## 1. Where each title lands

| Title | Evidence | Match loop | Judged by | Matchmaking | Pinned to |
|---|---|---|---|---|---|
| Agent Fighter, ranked | players sign the whole log (unchanged) | server bundle `agent-fighter.v1` | witnesses replay the sandbox ruleset (unchanged) | mesh pairing | nobody |
| Agent Fighter, casual | none (studio-only, ADR 0014) | rooms relay, secret-free (§11) | — | AF lobbies in Supabase | nobody |
| Pickle Brawl | **seat-signed input heads** | **court loop as a server bundle**, any opted-in node | **witnesses or custodians run PB's verifier** | mesh pairing for ranked (2v2, §7); lobbies, friends and Open Play in PB's database, started by match orders | nobody |
| FLOOD CONTROL | the player signs the run (`cabinet:sign-run`, already built) | none (single-player, in the browser) | custodians run FC's verifier; the Vercel board court becomes optional | none | nobody |
| AFC | seat-signed input heads | `gauntlet.ts` as a server bundle (built in `d4ddf43`) | witnesses or custodians run AFC's verifier; `/court/bout` becomes optional | mesh pairing | nobody |
| A third-party title | either shape | its own server bundle, or none | its verifier, or its studio court (L1/L2) if it can't ship one | either | nobody |

## 2. Decision 1: one intake contract, three producers

There is one envelope and one call: `POST /ledger`, protocol ≥ 4. A title
uses the producers it needs.

| Producer | Holds | Produces |
|---|---|---|
| **Players** (through the shell) | their arcade keys | the signed ledger (AF), signed input heads (real-time attested titles), or a signed run (single-player) |
| **Host node** (any bonded operator) | its own node key; a per-match secret it mints in memory | runs the server bundle, posts the envelope signed by its node key: log, heads, placement `descriptor` or `order` |
| **Studio court** (optional) | a court key in managed env | a signed report, for titles whose outcome can't be replayed from player inputs |

Rules:

1. **A match server is always a hashed server bundle.** `GAUNTLETS=` with a
   checkout stays as a development path; a node refuses it for a ruleset
   whose registered build names a bundle.
2. **A match server never signs a result.** The host's node key only says
   "I hosted this". Trust comes from the players' signatures and the replay.
3. **One SDK owns the envelope**: `sdk/court` for courts, `sdk/client` for
   players, the node itself for hosts.

**Alternatives considered.**

- *Studio court for every attested title (rev 1).* It works, but every
  match then depends on Vercel. A 60-second PB replay needs Pro or a
  day-late async queue on Hobby, and the court key is a single point of
  forgery. Kept only as the fallback producer.
- *A court key per operator node.* Every operator could sign any outcome.
  Rejected; with replay the host needs no court key at all.

## 3. Decision 2: any bonded operator hosts. Is it safe?

**Yes**, because the operator isn't trusted with the outcome, only with
availability. Here is what a malicious host can and can't do:

| Attack | Possible? | Why, and how it's contained |
|---|---|---|
| Forge the winner or the score | **No** | the result is whatever the verifier computes from the players' signed inputs; three nodes under other operators replay it |
| Inject or drop a seat's inputs | **No, detectably** | each seat signs a hash-chain head over `(tick, input)` at least every 30 s and at the end; a log that doesn't match every head is refused |
| Delay a seat's inputs (a lag switch on the player's behalf) | **Bounded** | the log records the client tick and the applied tick; the verifier refuses a delay over the title's `maxInputDelayMs` (e.g. 250 ms). Inside that bound it's indistinguishable from network lag |
| Abort the match, refuse to post it | **Yes** | it's a void, not a forgery. The seats hold their own heads; a seat may post the partial envelope to any node, which settles a forfeit by the title's rules. Repeated voids show in `/fleet` and lower the node's placement weight |
| See the players' IP addresses | **Yes** | as any host does today. Contained by the Rapture gate and the bond: operators are known, bonded wallets |
| Collude with custodians | **Hard** | the custody set and the witness panel are drawn by hash, exclude the host's operator, and (protocol 5) count only bonded Rapture holders. Owning three of them for one match means owning a large share of the mesh |
| Sybil many nodes | **Costly** | one Rapture NFT per bonded node (§6) plus the stake |
| Run the verifier dishonestly as a custodian | **Outvoted** | it's one of three; a dissent on a ranked match escalates (13 operators needed, §14); off chain, a single dispute marks the result disputed, not relabelled |

What operators take on in return: they run **publisher code**.

- A **verifier** runs in the existing title sandbox (`node/sandbox.js`:
  `--permission`, empty env, no network globals), with the manifest's
  `memoryMb` ≤ 2048 and `timeoutS` ≤ 900. The verifier contract already
  forbids env, ports and timing (standard §11), so it fits.
- A **server bundle** is a trusted process with a port and the network
  (`node/server-bundle.js`). An operator opts in per title
  (`GAUNTLET_SERVERS`), and a peer's bundle loads only when TitleRegistry
  says the title's holder registered that hash. For Season 0, the arcade
  recommends opting in to in-house titles; isolating bundles further (a
  separate OS user or container) is an open item (§19).

**What the studio keeps.** The publisher still owns the title NFT, the
registered artifacts and the economy. It no longer runs, or needs, any
machine on the settlement path.

## 4. Decision 3: judging by replay

**One rule: a title is replayable if it ships a sandbox ruleset or a
verifier.** Both feed the same machinery.

- **Ranked (on chain).** The MatchBook path is unchanged: commit, settle,
  three witnesses attest after replaying, finalize. A witness replays with
  the sandbox ruleset (AF) or the verifier (PB, AFC). A heavy verifier runs
  in its own process, outside the per-step sandbox budget, under the
  manifest's runtime.
- **Everything else (off chain).** The k = 3 custodians (standard §8)
  already fetch the delta, the ledger and the log. They now **run the
  verifier** and compare `finalHash` and the result. Agreement co-signs.
  A mismatch, or a throw, files a **signed dispute** with reason `verifier`.
  This replaces rev 1's sampled challenge runner: every result is replayed,
  and the work is spread by the custody draw.
- **Proof levels.** Seat-signed heads and signed runs count as
  `attestation: 'players'`, like AF's ledger. So PB, AFC and FC reach
  **L3 `verified`** once a replay agrees. **L2 `checkable`** and **L1
  `attested`** remain for studio-court results. Old results keep their
  level; nothing is relabelled.

**Who computes what** (the user's question 5):

| Work | Today | Target |
|---|---|---|
| The match loop | clients, host bundles, your machines (PB), browsers | clients, host bundles on any opted-in node, browsers |
| Judging attested titles | Vercel courts (FC, AFC), your machines (PB) | the replay; studio courts only for titles without a verifier |
| Intake checks | the host node, cheap | the same |
| Full replay | 3 witnesses, AF ranked only | 3 witnesses (ranked) or 3 custodians (everything else), every title |
| Elo, XP, stats | every node, identically (cheap, replicated on purpose) | the same |

**Load.** Each result is replayed three times. With N verifying operators,
each one replays about 3/N of all results. A 15-minute PB match costs about
45–60 CPU-seconds and 1 GB per replay; a FLOOD CONTROL run costs well under
a second.

- With 4 operators, each one replays about three quarters of all matches.
  With 20, about one in seven.
- **Budget, not sampling.** A node declares `VERIFY_BUDGET_MIN` (CPU
  minutes per day, default 60) and runs one heavy verifier at a time. When
  it's over budget, it skips (no co-sign) rather than guessing. The result
  stays unverified, never wrong, and the next custodian in hash order takes
  the slot (`k` widens to 5 when a seat skips).
- **Reward it.** Replays are counted in the Season Zero rewards points
  (`protocol/rewards.js`), so verifying is paid work, gated like bonding by
  Rapture (§6).

**Alternatives considered.**

- *Sampled challenge runner, 1 in 20 (rev 1).* Cheaper, but a forged result
  passes 19 times in 20, and it needs a trusted court to sample against.
- *Optimistic: replay only on a challenge.* That needs the gen-4 challenge
  contract and bonds before anything is checked. It stays the path for
  studio-court L2 results.

## 5. Decision 4: attestor sets, for studio courts only

A title that keeps a studio court (a third-party title with hidden server
state, or a title that hasn't shipped a verifier yet) lists its court keys
in a **registered attestor set**:

```jsonc
// attestors/<rulesetId>.attestors.json, hashed as sha256('attestors' NUL canonical(doc))
{ "kind": "attestors", "v": 1, "rulesetId": "…",
  "keys": [ { "key": "<ed25519 hex>", "label": "vercel-prod", "roles": ["court", "orders"] } ] }
```

- It's registered with the existing `setBuild`, so TitleRegistry needs no
  contract change. `activationDelay` applies, and `revokeBuild` withdraws
  it.
- The court sends it with the envelope as `attestorSet`; peers serve it at
  `GET /attestors/<rulesetId>?set=<hash>`.
- New rulesets declare `courts: 'registry'` and list no keys, so **a key
  rotation never needs a new build**.
- The `orders` role signs match orders (§7).
- Each deployment generates its own key in its managed env. Nothing is
  copied.

**Fewer steps.** No title gets per-machine court keys any more. PB's
desktop court keeps its current key until its bundle and verifier path
replaces it (§18 phase 2), then the key is revoked with the old build. The
user never registers a key list for PB at all.

## 6. Decision 5: one sign-in, and the Rapture gate

**One identity, three uses.**

| Who | Signs in where | What reaches a node |
|---|---|---|
| A player | AIR, **at arcade.litvm.games only**. Framed first-party titles borrow it (`cabinet:air`, built) and send it only to their studio API | the player's arcade key signatures: seats, heads, runs, the ledger. Never the AIR token |
| An operator | AIR, at the NODE web app (the arcade's Nodes pages and the node's own console) | the operator's own signature, from the operator's own browser, for their own node |
| A publisher | AIR or a wallet, at the arcade's publisher pages | registry transactions, from their own wallet |

**What changes in litnode.** Today a node with universal login on
(`node/air.js`, `node/proxy.js`):

- accepts any player's AIR JWT (`/air/session`, `/air/publish`,
  `/air/bond`);
- **creates and keeps a litVM proxy wallet key for every AIR user** under
  `<dataDir>/proxies/`. That key owns the user's PlayerProfile and, for an
  AIR publisher, the title NFT. Gas comes from the node's announcer key.

That's a player credential on an operator node, so it can't stay once any
bonded operator can run a node.

- **The proxy custodian moves to the arcade API** (Vercel). Proxy keys are
  derived on demand (`HKDF(PROXY_ROOT, sub)`, with the root in Vercel env),
  so nothing is stored per user and nothing is copied. Gas comes from a
  sponsor key in the same env.
- `/air/session`, `/air/publish` and `/air/resolve` move to the arcade
  API. `/air/bond` becomes: the operator signs in at the arcade, the
  arcade's proxy for that operator sends the bond, and the node supplies its
  bond proof (it signs `bondMessage` with its node key, as today).
- **Existing proxies** on the desktop node hand over without copying a key:
  each proxy signs one call that moves its profile, or title NFT, to the
  arcade-derived address. Whether PlayerProfile supports an owner handover
  must be checked (§19); if it doesn't, the arcade's proxy binds the same
  player key to a new profile and the old one is left idle.
- After that, a node accepts **no** AIR token. Its console proves the
  operator by a wallet signature (or by being on loopback).

**The Rapture gate** (user's answers 5 and of 25 Oct). **Only Rapture
holders may bond at all.** One NFT covers one bonded node: an operator with
three nodes needs three NFTs.

"May not bond at all" has to be enforced **in NodeStake**, not only by the
nodes:
- NodeStake v4 has no gate hook. `bond()` checks only the stake and the
  node key's signature.
- TestLITVM has an open faucet, so today anyone can bond.
- EpochAnchor counts quorum against NodeStake's `totalActive`. An ungated
  bond is therefore more than a reward question: a stranger with faucet
  tokens can dilute or reach the anchor quorum. Off-chain rules can't
  stop that.

So:

- **NodeStake generation 5 (phase 2).** It is v4 plus a gate:
  - `IERC721 public immutable gate` (Rapture Cards).
  - `bond()` and `transferOperator()` require
    `gate.balanceOf(operator) > bondedCount[operator]`.
  - `sync(nodeKey)` may be called by anyone. It ends the bond's activity
    when its operator no longer holds enough NFTs, the same pattern as
    `NodeBadge.sync`. A sold card therefore takes its node out of
    `totalActive`, witness eligibility and draws. The stake unbonds
    normally; nothing is slashed.
  - Everything else is unchanged, so `protocol/staking.js` keeps one ABI.
- **The redeploy is one migration.** NodeDirectory, EpochAnchor, MatchBook,
  NodeBadge and GasRefund are bound to NodeStake by address, so they
  redeploy with it. That is the existing `npm run deploy:testnet -- --fresh`
  path (`contracts/MIGRATION.md`). Every operator re-bonds once, inside the
  protocol 5 update window they already have.
- **Nodes check it too, as defence in depth.** In protocol 5 a node ignores
  a bond whose operator falls short at the epoch's pinned block, even
  before someone calls `sync`. This rule decides rewards, draws and ranked
  hosting.
- **The NODE web app** checks `balanceOf` before offering to bond. That is
  UX, not the gate.

## 7. Decision 6: matchmaking (split, approved)

| What | Owner | State | Survives a node restart |
|---|---|---|---|
| **Ranked**, every title | the mesh (`protocol/pairing.js`), placed from the beacon | gossiped queue, then the signed descriptor | yes; an in-flight match is lost and the players re-queue |
| **Lobbies, friends' matches, Open Play, parties** | the studio | the studio database through its Vercel API | yes; at start the API signs a **match order** to any node that serves the bundle |
| **Casual quick-play** | either | the studio's queue, or the mesh queue with `mode: casual` | yes |

The mesh pairing gains **team sizes** (`seats: 2 | 4`) and an optional
**band** in protocol 5.

A **match order** is `{ kind: 'match-order', v: 1, rulesetId, orderId,
mode, seats[], notAfter }`, signed by an `orders` key in the title's
attestor set and sent to `POST /gauntlet/order`. It's single use per node
and ≤ 10 minutes. Each seat still proves its own key. Order-started
matches are unplaced and never official, but they're replayed like any
other result. This is the only reason PB or AF needs an attestor set once
their courts are gone.

## 8. Decision 7: seat identity and signed heads

- **Inside the arcade the seat is the arcade key, always.** A prefixed id
  (`pb:`, `fc:`, `afc:`, `af:`) means "launched outside the arcade:
  casual, unbound, never ranked or rewarded".
- **The client** uses `init.player` for every seat proof once
  `cabinet:init` arrives, and waits instead of falling back.
- **The shell** signs only for the launched title's `rulesetId` (built).
- **The match server** admits a seat only by a node-minted ticket or an
  order's join ticket. It records each seat's **signed head**
  (`cabinet:sign`, `ledger` tag over `{ matchId, seat, ticks, head }`) at
  least every 30 s and at the end.
- **The node** refuses an arcade-sourced envelope whose participants are
  not all keys, and a log that doesn't match every seat's last head. A
  seat's inputs after its last head count as empty (a disconnect).
- `sdk/court` and `sdk/client` gain `signHead`, `verifyHead` and
  `boundKey`, so PB's and AFC's own PlayerProfile and keccak copies go.

**Cost:** one shell signature per 30 s per seat, invisible to the player.

## 9. Decision 8: plug and play titles

Every litvm.games title, in-house or third-party, settles on the mesh.

**What already works.** A node loads a ruleset **by hash** from its peers
(`hydrateMissing`, `node/litnode.js`) once TitleRegistry says the title's
holder registered it. Server bundles travel the same way. So a new title
needs no litnode release; `titles/*.adapter.js` in this repo is only where
the in-house adapters were written. Rev 2 adds verifiers and attestor sets
to that same path (`GET /verifier/<id>?build=`, `GET /attestors/<id>?set=`).

**One release command per title**: `npm run title:release -- <spec>`.

1. It rebuilds every artifact the title has (ruleset, verifier, server
   bundle, attestor set) twice from clean commits, and refuses on any hash
   mismatch.
2. It writes `releases/<rulesetId>/<version>.json` with the hashes and the
   source commits.
3. It prints **one** batch of registration calls for the signer page
   (`tools/signer`), new builds first, revokes after activation. It never
   sends them. One signing session per release is the user's only step.
4. A court or client reads its verifier hash from the release file or env,
   never from a compile-time define (FLOOD CONTROL's `__FC_VERIFIER_HASH__`
   goes).

**Modes, without breaking a WIP.** A ruleset declares `modes`. At intake, a
`ranked` envelope for a title that doesn't declare ranked **settles as
casual** (`placed: false`): the same rule the standard already applies to an
unplaced ranked submission (§6). Nothing is refused, and AFC keeps playing
while ranked is built.

**Ranked switches on when its prerequisites hold.** `npm run host --
doctor` and `/health.titles[]` report each title's readiness:

| Check | Ready when |
|---|---|
| `ranked.declared` | the active ruleset lists `ranked` |
| `ranked.keys` | the last results seat only arcade keys |
| `ranked.replay` | a sandbox ruleset or an active verifier exists |
| `ranked.bundle` | real-time titles: an active server bundle, and ≥ 1 opted-in node besides the publisher's |
| `ranked.heads` | real-time attested titles: every recent log carries signed heads |

A title turns ranked on by releasing a ruleset that declares it, once the
other checks are green. The other doctor checks from rev 1 stay
(`title.build`, `title.verifier`, `title.attestors`, `title.server`,
`title.proof`).

## 10. Decision 9: stats (unchanged from rev 1)

- No stat may repeat a report field. `report.stats` carries only per-seat
  values the body lacks. FLOOD CONTROL moves `keptDry` into the body and
  stops sending the duplicates.
- litnode keeps per-match counters that a replay recomputes, plus the
  season folds. The studio database keeps the counters it may change
  without a build (Elo variants, dailies, achievements, AF's season board),
  labelled as the studio's.

## 11. Decision 10: no secrets in litnode (the Season 0 gate)

**The standard.** A litnode install, its code, its data directory, the
processes it spawns, and the zip it ships hold **exactly one stored secret:
the node's own key** (`identity.json`, and the announcer key derived for
it). Per-run secrets it mints in memory (gauntlet ticket secrets,
`LITNODE_GAUNTLET_TOKEN`) are allowed because they never touch disk and die
with the run.

**Where it's broken today:**

| Where | What | Fix |
|---|---|---|
| `node/publisher-services.js` `envFiles` | reads publisher `.env` files and hands them to the services it spawns (PB matchmaker and court, AF relay) | remove `envFiles`; a service that needs a secret runs on Vercel |
| `node/publisher-services.js:138` | services inherit the node's **whole** environment | the same name allowlist gauntlets got in 0.12.0 |
| `node/proxy.js` | a proxy wallet key per AIR user in `<dataDir>/proxies/` | custody moves to the arcade API (§6) |
| `node/air.js` routes | the node accepts players' AIR tokens | the routes move to the arcade API (§6) |
| desktop `services/*/.env`, m16 copies | PB court key, PB `.env`, AF `SUPABASE_SERVICE_KEY` | phase 1 deletes the copies; phase 2 retires the services |

**Enforcement**, so it stays true:

1. **Startup guard.** A node refuses to start a service or gauntlet whose
   env would contain a secret-shaped name (`*_SECRET`, `*_SERVICE_KEY`,
   `*PRIVATE_KEY`, `SUPABASE_*`, `DATABASE_URL`, `*_TOKEN` other than its
   own per-run tokens). In Season 0 it refuses to start at all.
2. **Doctor check `secrets`.** It scans `<dataDir>` and the node's env for
   secret-shaped names and key-like files other than its own.
3. **Release check.** `npm run release` scans the packaged zip (a
   gitleaks-style pattern list) and refuses on a hit.
4. **Code review rule** in the standard: litnode code never reads a
   publisher or studio secret.

**Cost.** PB's matchmaker and AF's relay can't run under litnode until
they're secret-free. That moves those two pieces from rev 1's "phase 3
someday" to **before Season 0**.

## 12. Resilience

### Today

| Title | Desktop down | Desktop + m16 down | Publisher offline | Vercel down |
|---|---|---|---|---|
| AF ranked | mostly **down** (no other node reliably runs the bundle) | **down** | **down** | **down** for new players |
| AF casual | m16 relay (copied `.env`) | **down** | **down** | site **down** |
| Pickle Brawl | m16 (copied court key) if its web build lists it | **down** | **down** | **down** |
| FLOOD CONTROL | any settler | runs unsettled if no settler | **up** | **down** |
| AFC | not live | | | |

### Target (Season 0)

| Title | Desktop down | Desktop + m16 down | Publisher offline | Vercel down |
|---|---|---|---|---|
| AF ranked | **up** | **up** if ≥ 1 node opts in; official needs 4 operators | **up** | **up** for loaded clients |
| AF casual | **up** (secret-free relay on any node + Vercel API) | **up** | **up** | lobbies **down** |
| Pickle Brawl | **up** | **up** if ≥ 1 node opts in | **up** | ranked **up** and settles (no studio on the path); lobbies and sign-in **down** |
| FLOOD CONTROL | **up** | **up** | **up** | the site is down; runs already loaded still settle on the mesh |
| AFC | **up** | **up** | **up** | ranked **up**; lobbies **down** |

Vercel is no longer on any settlement path. What it still carries is
sign-in, lobbies and the economy, and those belong to the studio by the
stack split.

## 13. Ops

**Guardian version skew.** Guardian reports gain `protocol` and `impl`. A
node counts a report whose `protocol` is below the delta's as `stale`,
never `inconsistent`. Reports without the field are protocol 3. This is
node-only, with no bump.

**Epoch anchoring.** A proposer that can't resolve a final match's stats
asks a fresh peer, then reports `statsMissing`. An empty hour is logged as
"nothing to anchor". Quorum stays a stake fraction.

**Minimum operators for each guarantee** (Rapture-holding, bonded):

| Guarantee | Operators |
|---|---|
| A match is hosted | 1 |
| Every result replayed three times by others | 4 |
| Ranked commits on chain | 4 |
| A dissent escalates instead of voiding | 13 |
| An epoch root means something | ≥ 3 independent stakers |
| Publisher-offline play | 1 non-publisher operator per title |

## 14. Protocol 5 (litnode 0.13.0): everything in one bump

1. **Verifier replay**: witnesses and custodians run verifiers; seat-signed
   heads and signed runs count as `attestation: 'players'`;
   `GET /verifier`, `VERIFY_BUDGET_MIN`, disputes with reason `verifier`.
2. **Seat rules**: arcade-sourced seats must be keys; logs must match the
   seats' heads; `maxInputDelayMs`.
3. **Modes**: a ranked envelope for a title that doesn't declare ranked
   settles as casual.
4. **Attestor sets** (studio courts and order keys) and **match orders**
   (`POST /gauntlet/order`; `orderHash` in the result commitment).
5. **Team-size and band pairing.**
6. **The Rapture rule** for rewards, custody, witness draws and ranked
   hosting, against **NodeStake generation 5** (gated `bond`, `sync`) and
   its redeployed dependents (§6).
7. **AIR off the node** (§6) and the secrets guard (§11) in Season 0 mode.

Node-only, no bump: the guardian `protocol` field, doctor checks,
`title:release`, the services env allowlist, the release scan.

## 15. Rapture and rewards detail

- `protocol/rewards.js` adds a holder check per bonded node at the
  epoch's pinned block, and counts replays (§4) beside hosting.
- The check reads `balanceOf(operator)` and requires
  `balance ≥ bondedNodesOf(operator)`, so one NFT covers one node.
- **The collection:** Rapture Cards (`RAPTURE`), ERC-721 at
  `0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721` on litVM testnet (chain
  4441). Checked on chain 25 Oct:
  - it supports ERC-721 but not Enumerable, so the rule uses
    `balanceOf` only;
  - total supply is 1855;
  - the admin `0x04bE` holds 20.

  The address goes into `contracts/deployed.testnet.json` and the cabinet's
  `CHAIN` config like the other contracts. It's an external contract that
  litnode reads and never deploys.

## 16. Amendments to `docs/SETTLEMENT-STANDARD.md`

| # | Section | Amendment | Phase |
|---|---|---|---|
| A1 | §1, §5 Proof levels | seat-signed heads and signed runs are `attestation: 'players'`; a verifier is a replay like the sandbox ruleset | 2 |
| A2 | §8 Custody | custodians run the verifier; `VERIFY_BUDGET_MIN`; `k` widens on a skip | 2 |
| A3 | §3 Identity | arcade-sourced seats are keys; heads every 30 s; `maxInputDelayMs` | 2 |
| A4 | §6 Placement | team sizes, band; order-started matches unplaced; ranked without `ranked` in `modes` settles casual | 2 |
| A5 | §10 Court keys | attestor sets for studio courts and order keys; manifest `attestors` becomes legacy | 2 |
| A6 | §11 Verifiers | the node runs verifiers; register-before-promote | 1 (rule), 2 |
| A7 | §9 Stats | no stat repeats a report field | 1 |
| A8 | new | secrets: one stored secret per node; the guard, doctor and release checks | 1 (rule), 2 |
| A9 | new | the Rapture rule | 2 |
| A10 | §17 Change control | protocol 5 | 2 |

## 17. Per-title migration table

Each title keeps its current path until the replacement settles a real
match. The old build or key is revoked only after that.

| # | Phase | Title | Work | User steps | Gate |
|---|---|---|---|---|---|
| 1 | 1 | **PB** | m16 stops its PB court and matchmaker; the web build stops sending AIR tokens to the matchmaker (10-minute API ticket, `friends:read` only); a court without a per-match secret refuses every join | delete m16's copied PB key and `.env` files; deploy the PB API and web | PB still settles from the desktop |
| 2 | 1 | **AF** | docs only: the relay runs on the desktop only | m16 stops its AF relay and deletes the copied `.env` | AF ranked unaffected |
| 3 | 1 | **FC** | stats from the body (`keptDry` in the body); verifier hash from env | one signer batch (ruleset + verifier); set the env; deploy | a run settles `checkable` |
| 4 | 1 | **AFC** | adapter keeps `modes: ['casual']`; `pvpEnvelope` sends `casual` until ranked is ready; re-vendor `sdk/court` | one signer batch; deploy | a bout settles |
| 5 | 1 | **litnode** | services env allowlist; doctor `secrets`; release scan; the A6–A8 rules | — | suite green |
| 6 | 2 | **litnode** | protocol 5 (§14); AIR off the node; Rapture rule; **NodeStake gen-5** with the gate, and its dependents redeployed | deploy generation 5 (`deploy:testnet --fresh`); release + register 0.13.0; one operator window: update, then re-bond with a Rapture card per node | 4 Rapture-holding operators bonded on gen-5 |
| 7 | 2 | **arcade** | AIR proxy custody and `/air/*` in the arcade API; Rapture gate on the Nodes pages | set `PROXY_ROOT` and the sponsor key in Vercel env; deploy; run the proxy handover | sign-in works with no node involved |
| 8 | 2 | **PB** | court loop as a server bundle that records heads; verifier as the judge; lobbies in PB's database with match orders; matchmaker retired; `boundKey` | one signer batch (ruleset, bundle, verifier, orders set); deploy | PB plays and settles with desktop and m16 off |
| 9 | 2 | **AF** | relay split: account API → Vercel; rooms relay secret-free | deploy; remove the AF `.env` from the desktop | AF casual plays with the desktop off |
| 10 | 2 | **AFC, FC** | heads (AFC); courts become optional; custodians replay | one signer batch each | a result verified by replay |
| 11 | 3 | **AFC** | ranked on: release a ruleset with `ranked` once doctor is green | one signer batch | `ranked.*` green |

## 18. Phased plan

### Phase 1: stop the copying, now (no protocol change)

**Scope:** rows 1–5. It's mostly deletions, and it needs **no new PB
build and no PB registration**: PB keeps its current ruleset, and the court
key exists again on one machine only. The new litnode pieces are node-only
(the services allowlist, doctor `secrets`, the release scan).

**Tests.** litnode suite plus a services env test (a secret-shaped name
is refused); PB court and matchmaker suites with a test that a raw AIR JWT
is refused; FC verifier reproducibility (two packs, two folders) and a run
against a local node; AFC's own suites.

**Rollback.** Nothing is revoked in phase 1. FC's and AFC's previous
builds stay active until the new ones settle.

**User steps.** On m16, stop the PB court, matchmaker and AF relay, and
delete the copied PB key, PB `.env` files and AF `.env`; deploy the PB API
and web; one signer batch each for FC and AFC, then their env and deploy.

### Phase 2: protocol 5 and the Season 0 gate (litnode 0.13.0)

**Scope:** rows 6–10. Season 0 launches at the end of phase 2.

**Tests.**

- `demo/verify-replay.test.mjs`: custodians replay a PB-shaped verifier
  log; a tampered log disputes; a log that misses a seat's head is refused;
  the budget skips and `k` widens.
- `demo/heads.test.mjs`: heads, disconnects, `maxInputDelayMs`.
- `demo/order.test.mjs`, `demo/attestors.test.mjs`, pairing for 4 seats
  and bands, a stale guardian ignored.
- `demo/rapture.test.mjs`, covering the gen-5 contract in the local VM and
  the node rule:
  - a non-holder can't bond;
  - one card covers one node;
  - `sync` deactivates a node whose card was sold;
  - a node ignores a short bond before `sync`;
  - `demo/deploy.test.mjs` dry-runs the generation-5 deploy order.
- `demo/secrets.test.mjs`: the guard refuses a secret-shaped env in
  Season 0 mode.
- A five-node in-process mesh with PB, AF and FC, and the §12 target
  matrix drilled once and written down.

**Rollback.** Protocol 5 excludes protocol 4 peers, so rollback is
fleet-wide (`npm run update -- --to 0.12.1`). Each title keeps its
protocol 4 builds active until its protocol 5 builds have run for a week.

**User steps.** Release and register 0.13.0; one operator update window;
the arcade env and deploy; one signer batch per title; remove services and
`.env` files from the desktop once each title runs without them; revoke
`866bb9eb` and PB's old court key with it.

### Phase 3: after Season 0 opens

AFC ranked (row 11), the gen-4 challenge contract for studio-court L2 results, and
stronger server-bundle isolation.

### Follow-up prompts (paste after approval)

- `handoff/settlement-v4/followup/9-unify-pickle-brawl.md`
- `handoff/settlement-v4/followup/9-unify-agent-fighter.md`
- `handoff/settlement-v4/followup/9-unify-flood-control.md`
- `handoff/settlement-v4/followup/9-unify-afc.md`

litnode's own phase 1 (row 5 and the rules) and phase 2 are done in this
checkout once the plan is approved.

## 19. Open items

Decisions that are the user's:

1. **Season 0 date.** Phase 2 is the largest piece: protocol 5, the arcade
   AIR move, PB's bundle, and AF's relay split. The date decides whether
   any of it is cut or Season 0 moves.
2. **Rapture: decided 25 Oct.** The collection is Rapture Cards,
   `0x138F…2721` (§15). Only holders may bond at all, one card per node.
   NodeStake generation 5 enforces it, in phase 2 (§6).

Facts to check during the build (not decisions):

3. Whether PlayerProfile supports an owner handover for the existing proxy
   wallets (§6).
4. How far server bundles can be isolated on Windows operators without a
   container (§3).
5. PB's verifier runtime under the sandbox permission flags (it unpacks its
   own engine), and AFC's Rapier WASM under them.
