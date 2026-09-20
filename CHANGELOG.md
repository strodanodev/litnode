# Changelog

All notable changes to litnode and the LIT GAMES cabinet. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

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
