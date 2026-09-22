# Changelog

All notable changes to litnode and the LIT GAMES cabinet. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [0.11.14] — 2026-09-22 — a placed match always has a relay

### Fixed
- **"SERVER OFFLINE" on every Agent Fighter launch the desktop did not host.** The
  cabinet passed `?ws=` only when the drawn host advertised a relay; m16 and the
  Ally front none, so the title fell back to its own on-chain discovery — which
  still read the generation-2 NodeDirectory, where the desktop's last entry is a
  quick-tunnel hostname from 20 Sep. Two fixes: the cabinet now launches on the
  same fallback relay on both screens (the lowest-keyed bonded peer in the
  verified snapshot that carries the title and advertises `wsAddr`), and the
  Agent Fighter client (87722a0) reads the generation-3 contracts.

## [0.11.13] — 2026-09-22 — pilot cut: one-way links, the purse priced from the head, attestWindow 300 in the config

The release behind the MVP pilot: 0.11.12 plus the three things the first live hours
with `/fleet` showed. Type-2 transactions are proven on Liteforge (the desktop's
announce after the 0.11.12 restart: type 0x2, effective price 357M wei — five times
yesterday's base fee, well under the 5 gwei ceiling).

### Changed
- **The purse prices "matches left" from the head's base fee** until this key has sent
  something (`purse.priceSource`: send | head | default). It read ~211 matches at
  yesterday's 68M wei while the chain charged 357M — the honest figure was ~40.
- **`attestWindowS` 120 → 300** in `contracts/deploy.testnet.json` (the Ally answered the
  second final match at ~116 s, four seconds inside the window). Applied to the live
  MatchBook by `npm run params` (admin); nodes pick the new window up from `params()`
  within the hour. `demo/deploy.test.mjs` reads the value from the config.
- **The cabinet closes a title that reports its placed match played** (`cabinet:played`,
  sent by agent-fighter after 21 Sep 2026): the next ranked match is placed by the cabinet,
  never re-queued inside the title (where it became an unplaced wager room).
- **A one-way link is a live link.** A peer we cannot push to (m16 and the Ally sit on
  another subnet and reach the desktop through its tunnel) graded D with 100% loss
  while pushing to us every second. `link.direction` is now `both | outbound |
  inbound | none`, `link.inboundMs` is the peer's own measurement of reaching us,
  and an inbound-only peer grades on that (−5 for the missing direction).

## [0.11.12] — 2026-09-22 — the demo sub-patch: telemetry for the operator's dashboard, type-2 fees, one answer per screen

The "0.11.11.a" round: the weaknesses and quick fixes from the 22 Sep build report
that fit before a production demo of a mesh of fewer than ten nodes. (Versions
are three numbers — `newer()` in node/update.js and npm both say so — so the
sub-patch is 0.11.12.)

### Added
- **`GET /fleet` — the operator's dashboard in one signed document**
  (docs/FLEET-TELEMETRY.md). Per peer: the round trip **measured on the gossip
  push every node already makes each second** (last, moving average, loss over
  the last 20), a quality grade A–F from freshness + loss + rtt, bonded /
  eligible / version. The mesh: active (fresh + self), known, bonded, version
  histogram, real gossip bytes in/out per minute. A **graph** — every node's
  heartbeat now carries `links` (who it reached in the last 10 s, and how fast)
  so any one node can draw all the edges, for the exe's 3D view. Rooms
  (`LIT-<matchId>`, state from the chain: placed → committing → committed →
  settled → final | void), the queue, titles, the last 20 finals, the last 50
  node events. The hot key's **purse**: balance, ~matches left as host, `low`
  under 25 (logged once, `gas-low` event). RPC round trip and head lag. With
  `?nonce=` the node key signs nonce + digest of the body (`answerChallenge`
  grew an optional `digest`; `/whoami` is unchanged), so LITNODE-CONTROL shows
  what this node said, now — never a proxy's or a replay. From memory, no RPC.
  `demo/fleet.test.mjs`.
- **`npm run fleet`** — the reference reader: verifies the proof, draws the table
  (peers, rtt, loss, grade, rooms, events). **`npm run fleet -- spawn --count N`**
  puts N more nodes on this machine, seeded from the watched one, for the
  fewer-than-ten demo.
- **`npm run prune:dist`** — dry run by default; keeps the current and last two
  versions' packs (4.4 GB → ~0.4 GB here).
- **`cabinet/version.js`** — the cabinet knows its release; `/health.cabinet.version`
  says which copy the node serves; the Node page shows both and flags a copy
  that is not the node's (the Vercel copy was 11 h behind and nothing said so).
  `npm version` keeps it equal (`tools/sync-version.mjs`); the cabinet test asserts it.

### Changed
- **Transactions are type 2 (EIP-1559) with a ceiling, not legacy at ×1.2.**
  `node/fees.js`: maxFee = 2 × base + tip, capped at `MAX_FEE_GWEI` (default 5
  gwei ≈ 70× Liteforge today; above it the send is refused rather than the key
  drained). The chain charges base at inclusion, so a spike between estimate
  and send (10M → 68M wei in a day) no longer rejects a settle. Legacy stays
  where a block carries no base fee. `signTransaction2` checked byte for byte
  against ethers; the in-process chain now reports a base fee so the end-to-end
  test signs type 2 too. Both senders (MatchBook, announce) use it.
- **One answer per screen.** With MatchBook, `/deltas` carries `chain` (the log's
  word) and derives `official`/`verification` from it: a chain-final match no
  longer reads `official: false` locally. The cabinet's history tags say
  "final on chain" / "voided" / "on chain · settled" ahead of the v0.2 witness path.
- `chain.status()` reports `rpcMs rpcLastMs rpcCalls rpcFailures headTs lagS`;
  `matchBook.status()` reports `purse`.
- **What a node holds, it passes on.** Gossip hints now carry the transactions of
  every match whose events this node holds (newest 50), not only the ones it
  sent — a restarted peer, or one that joined late, learns the day's matches
  from anyone. After 0.11.10 every node had restarted and nobody could tell
  anyone about the two finals; they were handed back by hand.

## [0.11.11] — 2026-09-22 — a restart keeps the ladder

### Fixed
- **A restart lost every match the node had seen.** The scan cursor was
  persisted; the events were not. When all four nodes restarted for 0.11.10 the
  first final match vanished from every ladder (the scan never re-reads, and
  hints only carry what peers touched in the last day — and their memory went
  with them). Every decoded event is appended to `matchbook-events.jsonl` and
  replayed at start, before the persisted duties; the end-to-end test restarts
  a witness with no peers and finds the match final, the ladder digest
  unchanged. (The file grows with history; compaction is a later item.)
- **A host retried a reverted commit twice a second for twenty minutes.** Its own
  copy of the placement expired by TTL (15 min), a peer's gossip delivered the
  descriptor again, and the fresh entry — no `commitTx` — committed a match the
  chain already had (1,005 reverted `estimateGas` calls, 21 Sep 2026 21:10–21:28).
  A descriptor older than the TTL is never adopted; a placement the chain
  already knows is never committed again; a reverted commit backs off a minute.

## [0.11.10] — 2026-09-22 — one beacon per bucket on every node; the host commits once

### Fixed
- **Three commits for one match, two seconds apart.** The beacon was "the
  first block at or after the bucket end *that this node sampled*". Liteforge
  makes a block every 0.25 s and a node samples the head every ~2 s, so each
  node's window held a different "first" block, named a different beacon for
  the same bucket and players, and minted a different match id; the host
  committed its own, then each earlier-looking one a peer sent
  (`f7ce7dea…`, `6ad06824…`, `5be1af4a…` on 21 Sep 2026 20:55). `chain.js`
  now finds THE first block after the bucket end by number (a short binary
  search between the sampled blocks that bracket it, cached) before a bucket
  is pinned; until then the bucket waits a tick rather than guess.
  `demo/beacon.test.mjs`: two nodes that sampled different blocks name the
  same beacon.
- **The host waits one gossip round (3 s) before committing**, so a peer's
  earlier placement for the same players can arrive first, and a placement
  that is on chain is never replaced. A ledger that settles within seconds
  of placement waits for the pending commit instead of settling locally only.
- **The cabinet client confirms a ranked placement with the host** — the
  entry the host lists for these players WITH a commit transaction is the
  match it launches (`confirmWithHost`); it used to launch on whichever
  placement the node it polled showed first.

### Noted
- A match played through Agent Fighter's own wager matchmaking after a
  cabinet launch (`wager · fee 10` in the relay log, room `mmu9ze8aw9438-7`
  rather than `LIT-…`) carries no mesh ledger and settles `relay · unplaced`:
  nothing reaches MatchBook. The AF client's binding to the launched room is
  the open item, in the AF repo.

## [0.11.9] — 2026-09-22 — quick-tunnel names resolve through Cloudflare, not the machine

### Fixed
- **No public URL for 38 minutes, and two peers blind for half an hour.**
  A `*.trycloudflare.com` name exists the moment cloudflared prints it and
  reaches DNS a little later; a resolver asked in between answers NXDOMAIN
  and caches it for the zone's SOA minimum — **1800 s, thirty minutes**.
  0.11.7 verified a new name before announcing it, but the very first probe
  poisoned this machine's resolver, so every probe for three minutes failed,
  the name was rotated, and the next one met the same fate: seven hostnames
  in a row on the desktop (21 Sep 2026, 19:36–20:14), and the laptop and
  the Ally — which read the announced name from NodeDirectory a second
  before their own resolvers had it — cut off for the same half hour.
  `node/dns.js`: `dns.lookup`, the function Node's fetch resolves with, now
  asks Cloudflare's DNS-over-HTTPS (authoritative for the zone; 1.1.1.1,
  then cloudflare-dns.com) for every trycloudflare name — a positive answer
  cached for its TTL, a negative one not cached at all, the system resolver
  only if DoH is unreachable; every other name is untouched. Verification
  gives a name five minutes now. `demo/dns.test.mjs`.
- **A 0.11.8 node re-learned every dead peer from a 0.11.7 peer's forwarded
  envelopes and forgot them again every second** (five `peer.forgotten`
  events a second on a node beside the desktop). A heartbeat older than the
  forget floor is neither learned nor forwarded.

## [0.11.8] — 2026-09-22 — a match reaches its end without its host; one commit per match

### Added
- **The liveness backstop.** Every window call on MatchBook (`finalize`,
  `expire`, `escalate`, `resolve`) is permissionless, but only the host's
  process made them, from memory: a host that restarted or vanished between
  `settle` and `finalize` stranded the match in `Settled` for ever. Now
  every node keeps a duty list — the matches it hosts and the panels it
  sits on, persisted in `matchbook-duties.json` — and drives each through
  its windows: the host first, each seat one stagger (20 s) later if the
  chain still shows the match where the host should have moved it. A seat
  feeds an escalation with the ledger it verified when it attested,
  staggered in blocks (the seed is `blockhash(drawBlock)`, gone 256 blocks
  later — 64 s on Liteforge). A lost race costs one `eth_estimateGas`, no
  transaction. `/health.matchBook` shows `hosting`, `seated` and the
  `windows`; a seat's action is the `backstop` event.
  `demo/backstop.test.mjs`: a host that settles and then does nothing —
  a seat finalizes; a commit never settled — a seat expires it.
- **The windows come from the contract.** `params()` is read at start and
  hourly; the deployment file was stale the moment `npm run params` ran.

### Fixed
- **One match, four commits.** The client posts a queue entry per bucket
  until it sees its placement, and every one of those entries became a
  fresh placement — and a fresh commit the host paid for — a bucket later;
  a peer that paired a later bucket before the placement reached it made
  another. A placement now spends the player's entries up to the bucket
  after the one it was computed in; one placement per pair stands on every
  node (the earliest bucket, then the smaller id); a rematch pairs at once.
  The end-to-end test asserts exactly one `Committed` for one match.
- **Both live nodes' log cursors were 35 minutes behind the head and
  falling further.** Liteforge's `eth_getLogs` cost is not linear in the
  range: measured today, ≤20 blocks answer in 1–3 s and 25+ blocks take
  10–16 s. The fixed 40-block range sat past that knee, so the scan
  advanced ~0.6 blocks/s against a chain making 4, and — worse — it ran
  INSIDE the live poll, so a 16 s scan sat between a `Settled` receipt
  and the attest it called for. The range now adapts to the answer
  (4–32 blocks, grows under 1 s, halves over 3 s) and the scan runs beside
  the poll, never in it; `/health.matchBook` shows `scanRange` and
  `scanMs`. Nothing live waited on the scan by design (receipts and hints
  carry the live events); now nothing live waits behind it either.
- **Every node ever heard of stayed in every peer's gossip until a
  restart.** Four dead test nodes from the day before were still travelling
  the mesh in every heartbeat payload. A heartbeat nobody renewed for ten
  minutes is forgotten: from the table, from the envelopes a node forwards,
  from `/peers`, from the incompatible list (`peer.forgotten` event;
  `demo/forget.test.mjs`). A payload that grows with churn is exactly what
  "anyone can run a node" produces.
- **A witness that could not reach a settled match's host retried every two
  seconds forever.** It now stops once the contract would no longer count
  the answer: two attest windows (one extension) or the escalation window,
  plus a minute.
- **A peer's gossip hints could make a node read any number of receipts.**
  Hints are unverified hashes; one envelope may now enqueue at most 20,
  200 may wait at once, and a poll reads 10 — this node's own transactions
  first. A host's hint list is the newest 50 matches, not its whole day.
- **A restarted settler re-proposed hours whose root was already final** and
  reported the contract's refusal as an error. `rootOf(hour)` is read first;
  a finalized hour needs nothing from us.
- `demo/deploy.test.mjs` derived nothing: it hard-coded the window sum
  from before `settleWindow` went to 30 minutes and failed. It now
  computes the tool's own formula over the config it feeds the tool.

### Changed
- `BUILD-SPEC.md` §0 and §16 say what is live (generation 3, the first
  final match, what Liteforge measured) instead of "built, undeployed".

## [0.11.7] — 2026-09-22 — a tunnel URL is verified before anyone hears it

### Fixed
- **The desktop announced a hostname nobody could resolve.** A quick
  tunnel's name exists before Cloudflare's DNS has published it; advertised
  and announced at once, it was looked up at once — by the laptop, the Ally
  and this very machine — and their resolvers cached the NXDOMAIN for
  minutes. The laptop and the Ally did the right thing (read the directory,
  tried `/whoami`, ignored the seed) and stayed cut off for 20 minutes
  while the desktop's relay tunnel, looked up a moment later, was fine.
  A node now reaches ITSELF through a new tunnel URL (`/whoami` from the
  outside) before advertising or announcing it, and rotates a hostname
  that never becomes reachable within three minutes (`tunnel.rotate()`).
  `/health.tunnel` and the `tunnel` event carry `verifying` |
  `up` | `unreachable`. `demo/tunnel.test.mjs`: advertised only once
  the probe answers; rotated when it never does.

## [0.11.6] — 2026-09-22 — a restarted witness advertises what it holds

### Fixed
- **A witness that restarted advertised no builds.** Its cached builds were
  re-checked at boot as held-not-current, and `hydrateMissing` then tried
  to re-FETCH them from peers (LAN addresses it could not reach, a tunnel
  hostname mid-rotation) before making them current — advertising nothing
  meanwhile, so the mesh's panel draw left it out and every ranked
  placement seated two. A held build is made current from disk, no
  network. `demo/held-build.test.mjs`.
- **The host commits an ADOPTED placement too.** A placement descriptor a
  node adopted from a bonded peer's gossip never reached `commit`; and a
  peer's draw can seat fewer than three (it saw fewer fresh peers) — the
  host now redraws from its own snapshot when the adopted panel is short,
  since the host is the one the chain holds to the panel.

## [0.11.5] — 2026-09-22 — the first ranked match on chain, and what it taught

### Fixed
- **Events from receipts, not from a log scan.** Liteforge's public gateway
  serves `eth_getLogs` at ~100 ms per block (100 blocks: 12 s; 500: timed
  out) — slower than the chain makes blocks — so the reader never got past
  the deploy block and no witness ever saw a Settled event. Every
  transaction a node sends is now read back from its RECEIPT (~2 s), and the
  hashes travel to peers as a gossip hint bounded to the last day
  (`hints`), so a witness learns of a settle in one receipt read and
  verifies it from the chain, never from the host's word. The log scan
  stays for the ladder, 40 blocks per poll from a persisted cursor that
  starts a little behind the head; a failing scan no longer aborts the
  poll (it was also stopping the host's finalize timer).
  `demo/matchbook-node.test.mjs` now runs with `eth_getLogs` unavailable.
- **The settle window was 60 s** — commit happens at placement and a human
  match lasts minutes. `contracts/deploy.testnet.json`: settleWindow 1800,
  unbondingPeriod 3600 (> the new total window); `npm run params` applies
  the config to the live MatchBook and NodeStake as admin (`--show`,
  `--calldata` for a multisig) and refuses a set that breaks the invariant.
- The first ranked match on generation 3 (21 Sep 2026, match
  `d1fdb409…`, commit tx `0x43c0fc6a…`): committed with a full panel
  (witness-2, Ally, m16), played, both players signed, settled on the host
  and on chain; no attest reached the chain because of the log scan above.
  A test player pair hydrated with registry tokens that do not exist on the
  live registry was refused, correctly: guests are external agents.

### Fixed
- **A peer that stopped answering triggers a NodeDirectory re-read at once.**
  When the desktop restarted for an update its quick-tunnel hostname
  rotated; the laptop and the Ally kept pushing gossip to the dead URL for
  36 minutes (21 Sep 2026) although the new one was on chain, because a node
  re-read the directory only when it had NO fresh peers (they had each
  other) or on the ten-minute cycle. Now a known peer URL that has not
  answered for 30 s prompts a re-read (rate-limited to one a minute), and a
  URL dead for ten minutes is forgotten. `demo/directory.test.mjs`: a seed
  restarted on a new port is found again within a minute.

## [0.11.4] — 2026-09-21 — wallet fees

### Fixed
- **"max fee per gas less than block base fee" on Bond this node.** The
  cabinet handed transactions to MetaMask without fee fields, and its
  estimate on a custom network landed 0.01 % under Liteforge's base fee,
  which moves every block. The cabinet now suggests fees itself — twice
  the current base fee as the cap, a tenth as the tip (the chain charges the
  base fee, not the cap) — for operator actions and the profile mint.

## [0.11.3] — 2026-09-21 — RPC budget

### Fixed
- **A node read every peer's standing every second** (two eth_calls per
  peer with `witnessEligible`): two nodes on one machine were ~25 requests/s
  to Caldera's gateway, which answered 429 to everything — the operator's
  tools included, so registering 0.11.2 stalled after one zip. Standings are
  now read every 15 s, at once for a peer whose key is new. The chain tools
  read one value at a time and keep polling for a receipt through a 429
  storm for two minutes instead of giving up on a transaction already sent.

## [0.11.2] — 2026-09-21 — cabinet parse fix

### Fixed
- **The cabinet was blank on every 0.11.1 node.** A stray apostrophe in the
  Nodes page's new delegate row (`the node's hot key`) broke `cabinet/app.js`
  at parse time, so the page rendered its chrome and nothing else and the
  header said NODE OFFLINE. `demo/cabinet.test.mjs` now runs `node --check`
  on every script the page loads; the test only checked they were served.

## [0.11.1] — 2026-09-21 — one-click bonding

### Added
- **One-click bonding, no keys typed.** The cabinet's *Bond this node* now
  approves, stakes and sets the node's hot key as its NodeStake v3 delegate
  (three wallet prompts); a *Set hot key* button covers a node bonded
  before. A delegated, funded witness ENROLS ITSELF in the MatchBook pool
  (`node/matchbook.js` autoEnrol; `/health.matchBook.enrolled`). The
  operator's whole lifecycle is: open the cabinet, connect the wallet, one
  click. `tools/enroll.mjs` stays as the manual path.
- **`npm run release` refuses to republish an existing tag.** A release is
  keyed on chain by its zips' sha256; replacing assets under the same tag
  (which v0.11.0 suffered on 21 Sep — the automation was committed without
  a version bump) orphans the registrations. Bump the version; `--replace`
  only for a tag never registered.

## [0.11.0] — 2026-09-22 — settlement v1.0: every ranked match on chain

### Added
- **docs/PUBLISHER-BONDS.md** — spec for publisher bonds: a title the
  publisher owns (ERC-721, vault flag for later tokenisation), host grants
  with expiry requested by nodes and signed through AIR, five flat hosting
  settings, a 10× publisher stake tier on NodeStake, a three-tier escalation
  ladder with every ruling hashed on chain, revenue share as an unwired
  field. Nothing built.

### Changed
- **Cabinet prompts and loading.** Display name, mint-profile name, node
  URL and operator transfer use an in-page dialog (validated, Enter/Esc)
  instead of `window.prompt`, which PWA windows show badly. Busy lines get a
  spinner and a fixed "working" pill follows the player while AIR sign-in,
  the node's profile setup, a wallet transaction or an operator action runs.
- **Sign-in is asked for when it matters, once.** The header chip reads
  "· SIGN IN" and opens AIR; Find match signs in first and goes straight to
  the queue (a closed dialog queues as a guest); a launched title gets a
  single-sign-on URL (`goToPartner`) so it opens already signed in — its own
  AIR dialog cannot show inside the cabinet's frame anyway; `cabinet:init`
  carries `air:{id,email,address,tokenId,name}`. Binding your own wallet is
  folded under "advanced". A remembered identity is dropped when AIR says
  the session ended.

### Added
- **Settlement v1.0, phase 1 — no single key** (BUILD-SPEC v0.3 §2.2–2.4;
  contracts written, compile-tested, NOT deployed — `contracts/MIGRATION.md`
  v2 → v3). `NodeStake` v3: a bond is LOCKED for `lockTerm` before
  `unstake()`; a key can be drawn to attest only once its bond is older than
  `eligibilityAge` (`witnessEligible`); `setDelegate` names the hot EVM key
  the node runs with (gas only, never the bond); `slash()` is callable only by
  adjudicator CONTRACTS named by `admin` — the slasher wallet is gone;
  `adminIsContract()` so `/health` can say whether `admin` is a multisig
  behind a timelock (`admin: contract`) or a wallet (`admin: eoa`).
  `standingOf` is unchanged, so every reader keeps working. `ReleaseRegistry`:
  a release zip's sha256 must be registered by `admin` and be ACTIVE
  (`activationDelay` after registration, revocable at once) before a node
  applies it; `node/update.js` asks the chain at check AND at apply, refuses
  unregistered / pending / revoked / unreadable, and reports
  `update.registry` (`unset` with no registry). `protocol/release.js`,
  `protocol/staking.js` (v3 reads and `setDelegate`), `node/chain.js`
  (`nodeInfo`, `releaseStatus`, `stakeAdminIsContract`), `/health.bond`
  (`eligible`, `delegate`, `bondedSince`), `RELEASE_REGISTRY` in
  `node.env`. Tools: `npm run delegate`, `npm run release:registry`;
  `deploy:testnet` deploys v3 + the registry, refuses an `unbondingPeriod`
  that does not exceed the MatchBook windows, and warns on an EOA admin.
  Tests: `demo/contracts.test.mjs` (every .sol compiles; hand-encoded
  selectors match solc), `demo/release-registry.test.mjs`.
- **Settlement v1.0, phase 2 — `MatchBook` contract and protocol** (BUILD-SPEC
  v0.3 §11.2–11.3; compile-tested, NOT deployed; the node does not send yet).
  `contracts/MatchBook.sol`: `commit` (host's delegate, before play; three
  panel keys must be `witnessEligible`, distinct, under operators other than
  the host's and each other's) → `settle` (result commitment, ledger sha256,
  build, participants, scores, custodians — all in the event) → `attest` by
  panel keys (a different hash is a dispute) → `finalize` (≥2 agree and no
  dissent → final; any dissent or <2 → escalated) → `escalate` (anyone posts
  the ledger bytes, sha256 must match; nine drawn from the enrolled pool,
  stake-weighted, one seat per operator, excluding both panels' operators;
  too few → void, nobody slashed) → `resolve` (stake-weighted strict majority
  of the nine; every key on either panel that voted against it and a host the
  majority rejected are slashed through NodeStake v3 — MatchBook has no
  slash of its own). `protocol/matchbook.js`: identifier→bytes32 mapping in
  one place, calldata for every call, reads, `eth_getLogs` filter and log
  decoders, and `chainDeltas`/`foldChain` — the ladder as a fold over the
  event log in block order with `official` (finalized) and `pending` views.
  Deploy tool deploys it and names it an adjudicator; `deploy.testnet.json`
  carries the windows and slash sizes. Tests: `demo/matchbook.test.mjs`.
  **22 Sep review and fixes**: the escalation tally now uses weights
  SNAPSHOTTED at the draw (a top-up after the draw bought a majority); the
  seed is the hash of a block `finalize()` names `drawDelay` ahead, so the
  caller of `escalate()` cannot grind it; `expire()` voids a commit never
  settled or an escalation nobody fed (two states were forever); one
  agreeing witness with no dissent extends the window once instead of
  seating nine; the draw reads each candidate's operator once (was
  O(pool × 9) external calls, over the block cap at ~1,000 nodes); slashes
  are basis points of the bond (`hostSlashBps`, `witnessSlashBps`), not
  flat wei; `matchOf()` replaces the auto-getter (stack too deep);
  `Escalating`/`Extended` are their own events. NodeStake v3: re-stake
  after withdraw starts a NEW lock (was skipping it); a top-up restarts the
  eligibility age; `slash(key, bps, reason)`; `MAX_TERM` bounds every term.
  **The contracts are now EXECUTED in `npm test`**: `demo/lib/evm.mjs`
  (`@ethereumjs/vm`, dev-dependency) and `demo/matchbook-vm.test.mjs` run
  every branch including both attacks; before this they were only
  compile-checked.
- **Settlement v1.0, phase 2 — the node side** (`node/matchbook.js`,
  `MATCH_BOOK` in `node.env`, from `deployed.MatchBook`). The drawn host
  COMMITS a ranked placement on chain before play (the descriptor now carries
  `panel`, three seats drawn stake-weighted by `protocol/placement.js`
  `drawPanel` — build holders above the standing floor, witness role,
  `witnessEligible` on chain, distinct staking addresses) and SETTLES from its
  delegated key when the ledger settles (`settle.js` `onSettled`); custodians
  = host + panel; `ledgerHash` = sha256 of the ledger `GET /ledger/:id`
  serves. Panel nodes watch the log with a cursor (never advanced past a
  gap), fetch delta + ledger from the host, refuse a ledger whose hash is not
  the committed one, recompute through `settlement.cosign` and ATTEST the
  hash they reached — agreement or dispute is the same call. The host
  FINALIZES (as soon as all three answered, else after the window), feeds an
  escalation with its custody copy once the seed block exists, resolves after
  the escalation window. `/leaderboard` folds the chain (`source: chain`,
  `cursor`, `counts`, `scope=official|pending`; `all` stays local);
  `/match/:id/chain`; `/health.matchBook` (delegate, delegated, funded,
  cursor, sends, hosting, attested). Gossip carries no delta advertisements
  and gossip-driven witnessing is off once MatchBook is configured. Placed
  players leave the queue (their per-bucket entries paired again as each
  bucket closed — three commits for one match). One transaction at a time
  per delegate key. `chain.js`: `witnessEligible` read beside `standingOf`
  (v3 detected once), `getLogs`, `blockNumber`. Tests:
  `demo/lib/rpc-evm.mjs` (a JSON-RPC over the in-process EVM: raw
  transactions, receipts, logs, blocks), `demo/matchbook-node.test.mjs`.
- **EpochAnchor v3 and automatic proposal.** The delegate (or operator)
  proposes; support is bonded stake; a root finalizes at `quorumBps` of
  `NodeStake.totalActive` — v2's operator count, which one wallet funding N
  stakes could manufacture, is gone. The tree is over the hour's
  CHAIN-FINALIZED set (`protocol/matchbook.js chainLeaf`/`chainEpoch`, leaves
  from the `Settled` + `Finalized` events, voids included with their
  status), so every node computes the same root; the settler proposes each
  frozen hour by itself (`node/matchbook.js propose`), `/epoch` and
  `/proof` serve the chain tree (`source: chain`), `tools/anchor-epoch.mjs`
  speaks v3 (`standing(epoch, root)`), `deploy:testnet --quorum` is basis
  points (default 5000). `ERC6699Registry` and `EpochAnchor` now take
  `admin` rather than the deployer. Tests: VM (two 1-token nodes cannot
  outvote a 3-token one), node e2e (a witness computes the host's root, the
  proposal finalizes, the node's proof verifies on chain).
- **The migration, dry-run** (`demo/deploy.test.mjs`): the deploy tool runs
  unchanged against the in-process chain served over HTTP (`rpc-evm.mjs
  listen()`): refuses windows the bond cannot cover BEFORE sending anything
  (the check moved ahead of the first deploy), deploys the whole set, names
  MatchBook an adjudicator, bonds the local node, is idempotent on a plain
  re-run, and a node boots on the written file reporting `admin: eoa`,
  `bond.eligible: false`, `update.registry: unchecked` (new label:
  configured, nothing looked at yet). `DEPLOY_CONFIG`/`DEPLOY_OUT` override
  the tool's paths.
- **BUILD-SPEC v0.3**: the chain as the index. Per ranked match `commit` →
  `settle` → `attest` ×3 → `dispute`/escalation on a `MatchBook` contract
  (specified, phase 2); ladders fold over finalized on-chain events in block
  order so every node and the cabinet from RPC alone derive the same tables;
  operators pay gas from a delegated hot key and earn a per-match fee split
  (phase 3); Elo stays off chain. The v0.2 model (delta advertisements over
  gossip, each node's ladder = its own hosted matches, one slasher/release/
  publisher key) is documented as wrong at scale and replaced, not patched.
  Decisions and sequencing in §0, §2.3, §6, §9, §11, §17.
- **Two publisher paths** (docs/PUBLISHERS.md). *Bring your backend*:
  `npm run bridge` (`sdk/bridge/`) settles matches from a game that
  already runs elsewhere — `assess` picks replayable vs attested, `key`
  makes the relay/court identity and prints the `RELAY_KEYS`/`COURTS`
  line, `serve` is an authenticated webhook the publisher's server posts
  to, `watch`/`backfill` follow a source through an adapter (`jsonl`,
  `http`, `agent-fighter`, or the publisher's own), `submit` and `check`
  do one match and read back what the mesh made of it. *Build from
  scratch*: `sdk/client.js` — `parseLaunch`, `connectShell` (the
  cabinet's `cabinet:init`/`cabinet:sign` protocol), `createSim`,
  `createRecorder`, `externalAgents`, `settle`. Skills `migrate-a-title`
  and `build-a-title`; docs/BRING-YOUR-BACKEND.md, docs/BUILD-FROM-SCRATCH.md,
  docs/WEBSITE-COPY.md (site and litepaper copy against the code).
  `demo/publisher.test.mjs` runs both paths against live nodes.
- **Gauntlet loops** (`node/gauntlet.js`): the node runs a title's headless
  match server for every match it hosts, spawned per placement with a
  per-match seat secret and the seats in its environment, one HMAC join
  ticket per placed player (Pickle Brawl's ticket format), tickets served
  and WebSocket rooms proxied on `RELAY_PORT` behind the relay tunnel
  (`wss://<wsAddr>/<room>`), unknown rooms forwarded to `GAUNTLET_UPSTREAM`,
  the process ended a few seconds after the match settles or at its TTL.
  `GAUNTLETS=<rulesetId>=<json>` in `node.env`; `/health.gauntlet`;
  `gauntlets/pickle-brawl.json`; `demo/gauntlet.test.mjs` (a real placement,
  court, tickets, proxy, attested report, process gone; plus crash,
  never-listens and TTL cases). Nothing of a title's backend has to be
  hosted anywhere else.
- **`npm run bridge -- resolve` and `--node auto`**: find the live node for a
  title through NodeDirectory on chain (bonded, fresh, proves its key,
  hosts the ruleset, settles), so a publisher's server is never pinned
  to a rotating tunnel hostname. Pickle Brawl's court is migrated on it
  (docs/BRING-YOUR-BACKEND.md, worked example).
- **Cabinet launches every placed title the same way** (`?ws&room&player&match&build`,
  previously Agent Fighter only), passes `hostAddr`, `mode`, `buildHash`
  and `rulesetId` in `cabinet:init.match`, and no longer refuses to launch
  a placed title whose host fronts no relay.
- **`npm run host` — the node-hosting harness** (`sdk/host/`, docs/HOST-A-NODE.md,
  the `host-a-node` skill). `init` writes `node.env` and the identity;
  `doctor` preflights runtime, port, files, RPC, seeds and clock; `start
  --detach` runs the node under a cross-platform supervisor (relaunch on
  crash, at once after a signed update); `status`/`next`/`verify` read
  the node and the chain and name the one next command — configure →
  identity → running → current → hosting → connected → reachable → bonded →
  announced → service; `bond`, `announce` and `publish` wrap the chain
  tools with the key from the shell only; `install-service` registers a
  scheduled task, a `systemd --user` unit or a LaunchAgent for this
  install and refuses to touch one that belongs to another. Every command
  is non-interactive, idempotent, takes `--json`, and exits 0/1/2/3.
  `demo/host.test.mjs` covers it, including the CLI end to end.

### Fixed
- **`npm run node` with `HOST=0.0.0.0` advertised `http://0.0.0.0:<port>`**
  in its heartbeat; it now advertises the LAN IPv4, as `start-node.cmd`
  already computed for the zips.
- `node.env` at the repository root is ignored by git.

## [0.10.0] — 2026-09-21 — universal login

Protocol 3, unchanged. Node + cabinet.

### Added
- **Sign in with AIR (universal login) — docs/UNIVERSAL-LOGIN.md.** The
  cabinet loads AIR Kit (vendored `cabinet/vendor/airkit.esm.js`, Apache-2.0)
  and posts the session token to its node. The node verifies it against AIR's
  JWKS (`node/air.js`, ported from Agent Fighter's relay), keeps a **litVM
  proxy wallet** for the AIR account (`node/proxy.js`, `<dataDir>/proxies/`),
  sponsors it from the announcer key, mints the account's PlayerProfile with
  the AIR user id bound as `airKey(sub)` (`protocol/air.js`), and binds the
  browser's player key to it. Any node resolves an AIR id to its wallet with
  one `ownerOfKey`; only the node holding the key signs for it (`custody`).
  Endpoints `GET /air`, `POST /air/session`, `POST /air/revoke`,
  `GET /air/resolve`. node.env: `AIR_PARTNER_ID` (pin tokens to our partner
  app), `AIR_JWKS_URL`, `AIR=0`. `demo/air.test.mjs` covers the verifier and
  the whole first-sign-in flow against a mocked chain.
- **Operator actions on the Nodes page** (`cabinet/nodeops.js`): connect the
  operator's wallet and bond this node (approve + stake at the contract
  minimum), take testnet tLITVM from the faucet, delegate and fund the
  announcer, transfer the node to another operator. Calldata from
  `protocol/staking.js` (new `stakeCalldata`, `transferOperatorCalldata`,
  `unstakeCalldata`, `withdrawCalldata`, `approveCalldata`, `faucetCalldata`,
  `minStakeCall`, `balanceOfCall`) and `protocol/directory.js`; the wallet signs.

### Fixed
- **A BigInt anywhere in a JSON reply killed the response after its headers
  went out** (the client saw "other side closed"). Replies stringify BigInts.
- **The cabinet re-reads NodeDirectory every 15 s while its node is
  unreachable** (once a minute while one answers). A seed behind a quick
  tunnel announces its new hostname within seconds of a restart; visitors
  used to wait up to a minute on NODE OFFLINE.

## [0.9.1] — 2026-09-20 — phantom placements

Protocol 3, unchanged. A node fix; update every node.

### Fixed
- **A stale queue pair placed a new match every second.** Two players who
  queued once and left stayed in the queue for ever (nothing pruned it), and
  the beacon for their bucket was "the first block in the node's rolling
  600-block window at or after the bucket end" — so once the window rolled
  past that block, every poll picked a later one, minted a new match id for
  the same pair, and placed it: 16,000 phantom placements in an evening on
  the publisher node, all gossiped. Now (a) `beaconFromBlocks` answers null
  unless the window also holds a block from *before* the bucket end, so a
  late or rolled window never guesses; (b) the chain pins a bucket's beacon
  the first time it is known; (c) a queue entry is dropped one minute after
  its bucket closed (`QUEUE_TTL_MS`), on every node alike, so the gossiped
  queue converges to empty. `demo/beacon.test.mjs` covers the pin.
- **The dashboard's `u` key checks for a release before applying.** It used to
  apply the version from the last hourly check, so pressing it right after a
  release installed the previous one.
- **Release zips are named by version, not date.** Two releases cut on one
  day shared asset names, and a CDN edge still holding the earlier zip under
  that name failed a node's sha256 check on the later one (`updated failed
  sha256 mismatch`). `litnode-<kind>-v<version>[-win-x64].zip` from here on;
  `npm run release` picks up only the current version's zips.
- **LAN-only nodes no longer try to announce.** A node without a public
  https address (no tunnel, no domain) logged `announce: not-delegated`
  every cycle. Nothing to announce, so it stays quiet.

## [0.9.0] — 2026-09-20 — players sign

Protocol **3**. Nodes on protocol 2 are heard, listed as incompatible, and
excluded from placement and witnessing — update every node together.

### Changed
- **The player-signed ledger body is `{matchId, ticks, head, buildHash}`.**
  The hydration hash is gone from it: a player can neither verify nor
  influence hydration (the node and the witness compute it themselves,
  bound to the placement's registry block), and for a relay match it
  depends on the relay's own pin, which no client can know at match end —
  so requiring it made player signatures impossible in practice. A
  submitted stats claim that disagrees with the registry is now simply
  ignored (registry wins) instead of failing the signature check.

### Added
- **Cabinet signs for the title.** A title running in the cabinet posts
  `cabinet:sign {matchId, ticks, head, buildHash}` to the shell; the shell
  signs only the match and build it launched and answers `cabinet:signed`.
  The player key never leaves the cabinet origin. The launch URL now also
  carries `?match=` and `?build=`.
- **Agent Fighter relay + client (strodanodev/agent-fighter):** a mesh-placed
  match's `result` names the ledger commitment (`ledger.head`, `ticks`,
  computed exactly as the node rebuilds it); the client asks the shell to
  sign and forwards `CSign` to the relay; archival waits 3 s so the pin
  carries `signatures`; the watcher passes them on. With both, a relay
  match settles as `players` provenance — placed, signed, witnessed:
  official.

### Fixed
- **A placed relay match settles in the mode the mesh placed it in.** The
  watcher forced `ranked` whenever a placement existed; the node refuses a
  mode that differs from its descriptor.

## [0.8.3] — 2026-09-20 — stay up

Protocol **2** (unchanged). Every restart of a quick-tunnel node rotates
its hostnames and blinds its peers for a directory cycle, so not dying is
the availability feature. Seen live twice on 20 Sep: a handler wrote a
response, threw, and the catch block's second write escaped as an unhandled
rejection (`ERR_HTTP_HEADERS_SENT`) that ended the process.

### Fixed
- **The node never exits on a handler error or an unhandled rejection.**
  `json()` is a no-op once headers are sent; `cli.mjs` logs unhandled
  rejections and uncaught exceptions and keeps running (the relay's policy).
- **An announce waits for both tunnels.** Node and relay tunnels come up a
  second apart; an announce between them published the node URL with no
  relay, and the rate limit held that for minutes ("server offline"). Sends
  are debounced 4 s so one transaction carries both.
- **The node's own RPC calls retry transient gateway answers** (5xx, HTML
  instead of JSON, timeouts) with a growing pause — the tools got this
  earlier today; the node's announcer and stake reads now have it too.
- **A node that loses every fresh peer re-reads NodeDirectory at once**
  (rate-limited to once a minute) instead of on the 10-minute cycle. Seen
  live: the seed restarted on a new quick-tunnel hostname and its two peers
  stayed blind to it for the rest of the cycle.

## [0.8.2] — 2026-09-20 — survive an update by an older updater

Protocol **2** (unchanged). **Every node still on 0.6.x should update by
unzipping this release over its folder rather than through `/update`**:
their updater's copy list predates `sdk/`, so a self-update lands on 0.8.x
without it. 0.8.1 crashed at import on every relaunch in that state (seen on
the desktop: `ERR_MODULE_NOT_FOUND sdk/conformance.mjs`, fixed by hand).

### Fixed
- **A node missing `sdk/` starts, reports `repair` on `/health`, refuses to
  verify any build, re-applies its own release (`apply({force})`) and
  restarts on the completed install.** The SDK import is dynamic.
- **An update installs every top-level directory the zip ships**, not only
  a fixed list (`data/`, `runtime/`, `node_modules/`, `node.env` and logs
  stay protected). Rollback restores exactly what was recorded
  (`.previous/ITEMS.json`). A future release can add a folder without
  stranding installs whose updater predates it.

## [0.8.1] — 2026-09-20 — ship the live contract set

Protocol **2** (unchanged). Canary.

### Fixed
- **The release carries the v2 contract addresses.** 0.8.0 was cut on 17 Sep,
  two days before the v2 set was deployed (19 Sep), so its zips ship the
  retired v1 addresses in `contracts/deployed.testnet.json` — and an update
  replaces `contracts/` as code. A node updated to 0.8.0 would have read the
  old NodeStake and announced on the old NodeDirectory. 0.8.1 is the same
  code with the live addresses (`contracts/MIGRATION.md`). Nodes on 0.8.0
  should update before bonding or announcing anything.

- **An update or rollback never replaces a newer contract set.** After code
  is copied, the `contracts/deployed.testnet.json` with the later
  `deployedAt` on the same chain wins (`keepNewerContracts`, reported in
  `changed`). This is the guard against the 0.8.0 class of accident: a
  release cut before a deployment can no longer drag an install back.

### Added
- **`restart-node.cmd` / `stop-node.cmd`** for task installs. The node
  records its PID in `data/<operator>/node.pid`; `schtasks /End` only ends
  the wrapper, so until now restarting the desktop meant finding the
  process by hand. Both need an admin prompt when the task runs elevated.

### Docs
- README, SPEC, remediation, RUNBOOK and HOST-YOUR-TITLE record the live v2
  set and what is still pending on it (laptop bonds, minter/progressor,
  `ERC6699`).

## [0.8.0] — 2026-09-17 — the build-audit remediation

Protocol version **2**. Nodes on 0.7.x and earlier are heard, listed as
incompatible, and excluded from placement and witnessing; update every node.

### Security
- **Title code never runs in the node process.** `node/sandbox.js` +
  `node/sandbox-child.mjs`: every manifest read, conformance replay,
  settlement replay, witness replay and attested-report validation runs in
  a separate `node --permission` process with an empty environment, a heap
  ceiling and a deadline, inside a V8 context with ECMAScript intrinsics
  only (no `Date`, `Intl`, `WeakRef`, `Math.random`, `process`, `fetch`,
  `require`; code generation from strings off; JSON-only data transfer).
  A spinning title is killed at the deadline; a hungry one aborts.
- **Conformance is two-staged**: STATIC (executes nothing; the purity regex
  is a lint, not the boundary) then SANDBOX. `installRuleset` refuses
  statically before handing bytes to any runtime, remembers refusals, and
  under `TITLE_TRUST=trusted` (default) loads a peer's build only with a
  publisher attestation (`tools/sign-build.mjs`, `TRUSTED_PUBLISHERS`).
  The audit's bracket-access bypass and pre-rejection execution are
  regressions in `demo/audit.test.mjs`.
- **Results are bound and committed.** A ranked submission must name a
  placement the mesh signed (participants, ruleset, build, mode, host,
  beacon + block, protocol); seed = `H(beacon, matchId)`; the log must be
  finished; provenance must be both players' signatures or an
  authenticated relay key (`RELAY_KEYS`). Every delta carries `resultHash`
  over the complete outcome; a witness recomputes every field itself and
  co-signs `{matchId, resultHash}` only on a byte-identical commitment —
  otherwise it files a signed dispute (`POST /dispute`). Attested titles
  require an authorized court (`attestors` in the manifest or `COURTS`).
- **Official standings** (default `/leaderboard`, `/deltas?scope=official`)
  take ranked, placed, player-signed or court-attested, independently
  witnessed, undisputed results. Everything else still settles, labelled
  (`verification`: verified / disputed / unverified; `official`).
- **Hydration reads the registry**, not the submission, when `ERC6699` is
  set: ERC6699Registry v2 at the placement's block, and the player key's
  profile owner must own or control the token. Submitted stats are
  labelled `fixture` and refused in ranked.
- **Epochs freeze** 15 minutes after the hour (`data/epochs`); leaves commit
  to `resultHash`, the witness set as of the freeze and `verified`; proofs
  report `finalized`/`open`. Inclusion and verification are distinct claims.
- **Discovery proves possession**: `GET /whoami?nonce=` signs the reader's
  nonce; nodes and the hosted cabinet admit a directory URL only after it
  proves the key its entry names. `GET /snapshot?envelopes=1` lets the
  client re-verify every heartbeat and recompute the root; the client also
  checks a chain beacon against the block the descriptor names.
- **Releases**: channels (`RELEASE_CHANNEL=canary` → `release-canary.json`),
  a protocol floor, one-step rollback (`update.cmd --rollback`,
  `POST /update {rollback}`), release-key rotation carried in a signed
  manifest (`--rotate-to`, `--retire`; persisted per node).

### Contracts (source; NOT deployed — `contracts/MIGRATION.md`)
- `EpochAnchor` v2: `propose(epoch, root, nodeKey)` by the operator of a
  bonded node only; final at `quorum` distinct operators; conflicts visible.
- `ERC6699Registry` v2: minter/progressor roles, `statsNonce`,
  `characterConfigHash`, `manifestNonce`, item ownership on `equip`,
  explicit ownership. Described as this project's PROPOSED interface.
- `NodeStake`: `transferOperator`.

### Tools
- `npm run authority` — read-only snapshot of every on-chain authority and
  what the exposed deployer address still holds (`audit/authority-<block>.json`).
- `npm run deploy:testnet -- --fresh --quorum 2` — the v2 set from a new wallet.
- `npm run anchor` proposes frozen batches to v2 only.
- `npm run custody -- export|import|verify` — durable match evidence.
- `tools/af-watch.mjs` signs each submission with its relay key.

### Tests
- New: `audit`, `hydration`, `discovery`, `custody` suites; `settle` rebuilt
  around the placed flow with every audit probe as a refusal or a dispute;
  `update` covers channels, protocol floor, rotation, rollback.
- `stop()` closes keep-alive connections, so the runner no longer hangs.

### Docs
- `docs/RUNBOOK.md`, `contracts/MIGRATION.md`, `audit/remediation.md`;
  SPEC/README/HOST-YOUR-TITLE reconciled with what is built, deployed and
  demonstrated.

## [0.7.0] — 2026-09-17

### Added
- **The harness: any open-source game can host itself on the mesh.**
  `sdk/index.js` is the one import (`defineTitle`, `defineAttestedTitle`,
  `defineBalance`, `seededRandom`, `lerp`, `clamp`, ladders);
  `npm run create-title -- name.v1 "Name"` scaffolds a complete replayable
  sample (TUG) from `sdk/template/title.mjs`; `npm run conformance` runs
  the suite (bundling in memory when the source still imports the SDK);
  `npm run bundle:title` inlines, checks and writes `rulesets/<id>.js` +
  `.json { buildHash }`. esbuild is now a devDependency.
- **Conformance is the gate, not a courtesy.** `installRuleset` runs the
  same suite over every build before loading it — configured, cached, or
  fetched from a peer — and refuses one that imports, reads the clock or
  randomness, or replays to two different roots (`ruleset-refused` event).
  Nodes on this build will not host what a developer's terminal would not
  pass. `demo/conformance.test.mjs` proves the pipeline and the refusal.
- **`GET /titles`** lists every title this node or any fresh peer hosts,
  from the manifests they gossip, with the new manifest `display` block
  (`{ title, url, description, cover?, accent?, controls? }`). The cabinet
  appends any mesh title not in its curated config, tagged *Mesh*, so a
  third-party title needs no entry in `config.js` to appear in the arcade.
- `docs/HOST-YOUR-TITLE.md` — the rules of recognition in the litVM Games
  ecosystem (conformance, hash pinning, bonded host, EpochAnchor
  settlement, ERC-6699 agents, PlayerProfile keys), what is yours and what
  is shared, and what is not built yet (no fees or micro-transactions).
  A Claude Code skill, `.claude/skills/host-a-title`, walks the procedure.
- `sdk/` and `titles/` ship in releases and packs.

## [0.6.5] — 2026-09-17

### Changed
- **Placement prefers hosts that front a relay.** Seen live: the draw
  picked a laptop with no relay while the desktop had one — placed, not
  playable. Hosts advertising `wsAddr` now form the outermost stable
  partition (after region and publisher affinity), so the seeded order
  still decides among relay hosts and the open fallback stays when nobody
  has one. Same code in node and browser; nodes and cabinets on older
  builds will disagree with this one until updated (the cabinet then says
  so and refuses to launch), so update all nodes together.

## [0.6.4] — 2026-09-17

### Fixed
- **Tasks run headless and self-heal.** Seen live: the three tasks ran as
  console windows, one was closed by accident, and Task Scheduler did not
  restart them (its restart-on-failure covers a failure to launch, not a
  process that exits). Now: S4U logon (session 0 — no window to close, no
  password), hidden, triggers at logon and at boot, and every wrapper
  loops so a crash or an update restart is back in 5 s.

## [0.6.3] — 2026-09-17

### Added
- **Everything production runs as a scheduled task.** With `AF_ROOT` in
  `node.env`, `install-task.cmd` registers `litnode-relay` (the Agent
  Fighter match server, `.env` loaded, fronted by the node's `RELAY_PORT`
  tunnel) and `litnode-watch` (`tools/af-watch.mjs`) beside `litnode`,
  each restarting if it dies. The wrappers replace an orphaned earlier
  instance instead of failing on the port. The operator zip ships
  `af-watch.mjs`, `set-announcer.mjs` and the wrappers.

## [0.6.2] — 2026-09-17

Live: the desktop delegated its announcer, announced its tunnel URL on
NodeDirectory (tx `0x18f38c91…`), and `arcade.litvm.games` — in a browser
with no node — read the chain, found it, and reached it.

### Fixed
- An address change that arrives while an announce is in flight (two
  tunnels up in the same second) is retried in 2.5 min instead of waiting
  for the 10-minute cycle.
- `set-announcer` uses the protocol's own signer with single, retried
  JSON-RPC calls (Liteforge's gateway 502s intermittently and a batching
  client quits on the first); accepts the key with or without `0x`.
- Profile reads skip `af:<name>` participants.

## [0.6.1] — 2026-09-17

Deployed to Liteforge (chain 4441): PlayerProfile `0x790824e6ea7aF658742bcefEe915Ca40CA210886`, NodeBadge `0xDAdd39D3fA134d0A30770356D47d733fF0Fc9A21`,
NodeDirectory `0xf63AA4590fDCa66fD9FA3005C588E9deb09767b4`. Addresses in `contracts/deployed.testnet.json`
(nodes) and `cabinet/config.js` (the arcade page).

## [0.6.0] — 2026-09-17

The decentralized bootstrap: the seed list lives on the chain.

### Added
- **`contracts/NodeDirectory.sol`** — a bonded node announces how to reach
  it (`announce(nodeKey, url, wsAddr)`); anyone reads `keys()` + `entryOf`.
  Writes are allowed to the node's operator wallet or to an **announcer**
  address the operator delegated for that one node key, so the node holds
  only a key that can misdirect its own discovery and nothing else. Readers
  keep only actively bonded, recently announced entries.
- **`protocol/evm.js`** — the smallest EVM signer a node needs, with zero
  dependencies: secp256k1, RFC 6979 nonces, addresses, RLP, EIP-155 legacy
  transactions. `demo/evm.test.mjs` checks every output byte for byte
  against ethers. `protocol/abi.js` (browser-safe) and `protocol/directory.js`.
- **The node announces itself.** `node/announce.js` generates
  `<dataDir>/announcer.json` on first run and shows its address on
  `/health.directory.announcer`; once delegated (`npm run announcer --
  <nodeId> <address> --fund 0.02`, operator key in the shell only) and
  holding a little gas, every tunnel change is published on chain within
  a tick, an unchanged entry is refreshed every 3 days, and nothing is
  ever sent twice. It says exactly what is missing until then.
- **Bootstrap from chain.** Every node reads NodeDirectory on boot and
  every 10 min and merges the live seeds into its peer set — a fresh
  install needs no `SEEDS=`. `GET /seeds`.
- **The hosted arcade page finds the mesh with no node.** `cabinet/seeds.js`
  reads NodeDirectory from the browser, tries the freshest https seed, and
  reads the mesh through it; the header says SEED instead of NODE; the
  Nodes page lists the seeds on chain.
- `NodeDirectory` in `tools/deploy-contracts.mjs`; `tools/set-announcer.mjs`.

Not yet deployed: `npm run deploy:testnet` (deploys PlayerProfile,
NodeBadge and NodeDirectory), then the addresses into `cabinet/config.js`.

## [0.5.2] — 2026-09-17

### Added
- **UPnP** (`UPNP=1`): the node asks the router to forward its port (and
  `RELAY_PORT`) and advertises the public IP — what a torrent client does,
  no third party. `/health.upnp` reports the gateway, the public IP, what
  was mapped, and **`cgnat: true`** when the router's WAN address is in
  100.64/10: the ISP shares its public IP, so no mapping can make the node
  reachable and only an outbound tunnel can. Found live on the desktop's
  line (hop 2 = 100.86.0.1, no IPv6). `demo/upnp.test.mjs` against a fake
  gateway.
- The hosted cabinet is a front door: an https page may talk to
  `http://localhost`, so `arcade.litvm.games` reads the mesh through the
  visitor's own node; with no node it links the signed release. The
  cabinet refuses to queue, with the reason, when its node's clock is off
  the mesh or it has no peers.

## [0.5.1] — 2026-09-17

### Added
- **The node owns its tunnel.** `TUNNEL=quick` (no account) or
  `TUNNEL=named` (+ `TUNNEL_NAME`, `TUNNEL_HOST`; stable hostname after a
  one-time `cloudflared tunnel login / create / route dns`) makes the node
  spawn cloudflared for its own port, learn the public URL, restart it if
  it dies, and advertise it in its heartbeat — gossip is the broadcast, no
  config edits anywhere. `RELAY_PORT=8477` fronts a title's relay on the
  same machine through a second tunnel and advertises it as `wsAddr`
  (`WS_ADDR` set by hand still wins). `/health.tunnel`, the dashboard
  header and the cabinet's Nodes page show both. When a tunnel drops the
  node falls back to its LAN address until it returns. `demo/tunnel.test.mjs`
  (a stand-in cloudflared). Live on the desktop 17 Sep: node and relay
  tunnels up in one second, reachable from the internet, in every peer's
  snapshot.
- A tunnel that fails to start no longer leaves a half-started node listening.

## [0.5.0] — 2026-09-17

The node updates itself, and the first release nodes can update from.

### Added
- **Self-update.** A release is an artifact like a ruleset — fetched,
  sha256-checked, refused unless it verifies — plus a signature, because
  "which build is latest" is a claim only the publisher may make. The
  release public key is pinned in `node/update.js`; `npm run release`
  packs every zip, signs `release.json` with the private half (kept in
  `~/.litnode/`, never in the repo) and publishes to GitHub Releases. Nodes
  check hourly and report on `/health.update`, in the dashboard header
  (`u` applies), and on the cabinet's Nodes page (**Update node**, only
  when the page is on the node's own machine — `POST /update` is
  loopback-only). `update.cmd` / `npm run update` do the same from a shell.
  Code is replaced; `data/`, `node.env` and the log are never touched; a
  new vendored runtime lands in `runtime.new/` and `start-node.cmd` swaps
  it on relaunch (exit code 75). `demo/update.test.mjs`.
- Heartbeats carry `version`; `/peers` shows each peer's.

### Fixed
- **CORS preflight**: a POST from another origin (the cabinet on
  `localhost` talking to `127.0.0.1`) failed with `net::ERR_FAILED` —
  "queue: failed to fetch" — because `OPTIONS` named no methods or headers.
  Reads worked, every write failed. The cabinet now also talks to the
  origin that served it.
- **Matchmaking across seconds**: a queue entry lives in one 2 s bucket,
  so two players only paired if they clicked within the same two seconds.
  The client re-enters every bucket while waiting (up to 5 min).
- **Open in tab** kept the launched URL (`?ws= ?room= ?player=`) instead
  of the bare title URL, which had sent the game to a relay that no longer
  exists.
- Plain log: `stakes` only on change, no per-block lines.

## [0.4.0] — 2026-09-17

Consolidation. One repository, one frontend, one node, one packing step.

### Added
- **Play through the cabinet, steps 1–2.** *Find match* on Agent Fighter now
  launches the title with `?ws=`, `?room=LIT-<32 hex of the mesh matchId>`
  (`protocol/pairing.js roomCodeFor`) and `?player=<key>`; AF's friendly-room
  rendezvous pairs the two placed players, its relay pins the room and the
  keys into the archived ledger, and `tools/af-watch.mjs` / `af-import`
  (shared `tools/lib/af-submission.mjs`) settle it under the mesh match id
  and the placed keys. The delta lands on the cabinet's ladder under the
  key that queued. Attestation stays `relay` until the client signs the
  chain head (SYNC §3.2 step 3). Needs AF `b362c87` deployed.
- **Wallet-bound player profiles, built.** `contracts/PlayerProfile.sol`
  (soulbound ERC-721: `register(key, name)` mints and binds in one
  transaction; `bindKey` / `revokeKey` / `rename`; `ownerOfKey` is the read)
  and `contracts/NodeBadge.sol` (`claim(nodeKey)` for an active bond,
  `sync` burns when the bond lapses). `protocol/profile.js`: calls,
  decoders, the calldata a wallet signs, and `applyProfiles` — the fold by
  owner. Node: a profile cache read every tick like stakes, `/profile?player=`,
  `/health.profiles`, `/leaderboard|stats|credits?by=owner`, and a revoked
  key is refused at `/queue` (403). Cabinet: `wallet.js` + *Sign in with
  wallet* on the profile card (MetaMask; no wallet library — the calldata
  is the protocol's own). `demo/profile.test.mjs`. Not deployed: needs
  `npm run deploy:testnet` and the address in `cabinet/config.js`.
- **The daemon has a face.** `node/tui.js`: a zero-dependency ANSI
  dashboard — identity, bond, chain head, hour root, reachability, a peer
  constellation, mesh and titles panels, a gossip sparkline, a "wire" line
  with the newest real envelope signature each way, and a feed of queue
  entries, placements, settlements, co-signatures, witness verdicts, blocks.
  Every hash shown is real. Keys `q g l p`; `LITNODE_ASCII=1` for 7-bit
  terminals. Under a scheduled task or pipe (`LITNODE_PLAIN=1`) the node
  prints one line per event instead.
- `createNode({ onEvent })` — every observable step emits an event;
  `/health.inbound {peers, lastAt, reachable}` says whether any peer has
  pushed gossip to this node in the last 30 s.
- **Standalone Windows download.** `npm run pack -- --runtime` vendors the
  official Node.js win-x64 runtime (checksum-verified against nodejs.org
  `SHASUMS256.txt`) into `runtime/`; the `-win-x64` zips run with nothing
  installed. `start-node.cmd` prefers `runtime\node.exe`.
- `allow-firewall.cmd`: one UAC click adds a *program* rule for this
  folder's runtime on private/domain networks — only for nodes peers must
  reach (seed, LAN host, relay); a witness behind NAT needs no rule. The
  READMEs say who needs it and why the first start must be interactive.
- **Source repository.** The full tree (protocol, node, titles, contracts,
  tools, eight test suites, BUILD-SPEC) is now the git history; the 0.3.0
  commit is merged in as an ancestor. The portable zips are built from it
  (`npm run pack`) and ship `cabinet/`.
- **Find match in the cabinet.** Each mesh title has a *Find match* action:
  sign a queue entry, wait for the pair, recompute placement from a snapshot
  the page can hash, refuse a host the rule did not produce, launch the
  title against the drawn host's relay with the descriptor in
  `cabinet:init.match` (and `?ws=` for Agent Fighter). `cabinet/client.js`
  is the former arcade lobby's client; `demo/client.test.mjs` drives it.
- **Every node serves the cabinet at `/`.** The cabinet's files resolve at
  the root after every API route; `/protocol/*` stays the node's modules.
- **`demo/cabinet.test.mjs`** asserts by name and type every field the
  deployed cabinet reads from `/health /peers /snapshot /leaderboard /stats
  /deltas`, the CORS + Private-Network headers on the preflight, that the
  cabinet is served at `/`, that `cabinet/protocol/` matches source, and
  that the client-side rating trajectory ends where `/leaderboard` says.
- **`tools/vendor-cabinet.mjs`** generates `cabinet/protocol/` (eight
  modules) with a sha256 `MANIFEST.json`; `--check` fails on drift.
- `protocol/derive.js` exports `applyDelta`, the per-delta fold step;
  `derive()` loops over it. Output and `DERIVE_VERSION` unchanged.
- `docs/WALLET-IDENTITY.md` — sign in with a wallet: one transaction mints
  a soulbound litVM Games profile and binds the browser key to it; nodes
  read `ownerOfKey` the way they read `standingOf`; a node badge NFT for
  operators. Specified, not built.
- `.gitattributes` pins LF everywhere (rulesets are hash-pinned bytes).

### Changed
- Node code in the public repo was the 12 Sep portable snapshot. It is
  replaced by the source tree, which carries the 13 Sep fixes: placements
  computed once, sealed and gossiped with disputes recorded; stake reads
  merged rather than replaced; `/gossip` replies carrying deltas and
  descriptors so a node behind NAT can witness; snapshot root over the
  registry view; `WS_ADDR`; WebCrypto secure-context guard.
- `/health` reports `startedAt` and `uptimeMs`; every response including
  the `OPTIONS` preflight sends `Access-Control-Allow-Private-Network: true`
  (both ported from 0.3.0).
- One player key: `localStorage['litnode.player']`, migrated once from
  `cabinet.identity`.
- The cabinet's rating chart walks `applyDelta` instead of a hand copy of
  the Elo fold.
- SPEC.md rewritten where it described the snapshot: the node advertises a
  relay (`wsAddr`) rather than lacking transport; known gaps and honest
  zeroes are one list (§4). `docs/NODE-CABINET-SYNC.md` is now the contract
  plus what is still open.
- `contracts/deployed.testnet.json` is committed (public addresses) without
  the local data path. Package renamed `litnode`.

### Removed
- **The rewards projection** (decision 17 Sep). There is no rewards
  contract and a figure nothing can pay is a claim. Work counters (settled
  as host, witnessed) stay: they are counted from deltas any node can
  reproduce. Bond and wallet reads stay.
- `arcade/` (merged into the cabinet), the root `start-node.cmd`
  (`portable/` owns it), `config.js REWARDS`.

## [0.3.0] — 2026-09-17

Cabinet launch. First public frontend for litnode.

### Added
- **cabinet/** — a static, dependency-free PWA dashboard in front of a
  litnode: profile card (avatar, level/XP on Agent Fighter's real curve,
  global rank, win rate), a rating-curve chart replayed client-side from
  `/deltas`, game library, leaderboards (top-3 rank cards + full table with
  search), a fighter roster / inventory view (sample data, clearly
  labelled), and a Nodes page.
- **Node uptime + $litVM rewards panel** — 24h ring, 10-min resolution
  strip, 7-day heatmap (client-observed, localStorage); a rate-card-driven
  reward *projection* clearly labelled "projected" since no rewards
  contract exists yet; live bond amount + operator wallet balance read
  directly from litVM (`cabinet/chain.js`, read-only `eth_call`).
- **Three playable titles** — Agent Fighter, Pickle Brawl, and Robot
  Fighting Championship (AFC) each open in the cabinet's iframe on PLAY,
  with real title-screen cover art (captured from each game) and a
  postMessage handshake (`cabinet/sdk-client.js`).
- **Cabinet ↔ litnode API surface**: `/health`, `/peers`, `/leaderboard`,
  `/stats`, `/deltas` — read-only, polled every 5s.
- Deployed to Vercel: https://lit-games-cabinet.vercel.app.
- `docs/NODE-CABINET-SYNC.md` — handoff report of what the node side needs
  to build to actually connect the cabinet to live matches.
- `SPEC.md` — as-built system spec.

### Changed
- `node/litnode.js`: `/health` now reports `startedAt` and `uptimeMs`
  (process uptime), additive, no existing field changed.
- `node/litnode.js`: `/health` (and every JSON response) now also sends
  `Access-Control-Allow-Private-Network: true`, so an https-hosted cabinet
  can reach a loopback node under Chrome's Private Network Access checks.
- `package.json`: version 0.2.0 → 0.3.0, added `npm run cabinet`
  (`node cabinet/serve.mjs`).

### Known limitations (see SPEC.md §4)
- No game queues, plays, or settles through litnode yet — the mesh cannot
  see matches played in any of the three titles today.
- litnode has no live-match transport (no WebSocket/host loop); a `host`
  role only ever replays a *finished* signed ledger.
- AIR/Moca sign-in inside the framed games is blocked by their own
  `frame-ancestors` CSP until the cabinet's origin is added to that
  allowlist. Gameplay itself is unaffected.

## [0.2.0] — 2026-09-12

Portable node build (pre-cabinet). Settlement daemon, gossip mesh,
deterministic pairing/placement, hash-chained ledger replay, witness
co-signing, Elo/credits/stats derivation, hourly Merkle epoch tree.
Bundled rulesets: `agent-fighter.v1`, `pickle-brawl.v1`. litVM LiteForge
testnet contracts deployed (`NodeStake`, `TestLITVM`, `ERC6699Registry`,
`EpochAnchor`).
