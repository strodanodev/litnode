# Changelog

All notable changes to litnode and the LIT GAMES cabinet. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] — 2026-09-17

Consolidation. One repository, one frontend, one node, one packing step.

### Added
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
