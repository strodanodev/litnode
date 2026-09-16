# Changelog

All notable changes to litnode and the LIT GAMES cabinet. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

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
