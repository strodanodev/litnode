# Website and litepaper copy vs. what ships

A consolidation pass, 20 Sep 2026, over **litvm.games**, **litvm.games/whitepaper**
and **arcade.litvm.games** (the cabinet in this repo) against the code.
Three columns: what the copy says, what is true today, what to change. The
principle is the litepaper's own — "Trust nothing that is not signed" —
applied to our sentences. Proposed copy is in the last column; the site
and litepaper are edited outside this repository, the cabinet in it.

## litvm.games

| where | says | true today | change to |
|---|---|---|---|
| Hero CTA | **BUILD ON LIT** | There are two documented, tested paths and four agent skills | Link to `docs/PUBLISHERS.md` (or its rendered page). Sub-line: *"Bring your backend, or build from scratch. Same ladder, same ledger."* |
| 01 SETTLEMENT | "Every credit, match and item reconciles to litVM, which holds the canonical record" | Matches: yes — deltas under hourly roots on `EpochAnchor` (Liteforge testnet). Credits: derived per title, reconcile to nothing on chain yet. Items: no marketplace, no item contract | *"Every match settles to litVM under an hourly root anyone can verify. Credits and items follow as the reserve goes live."* |
| 02 ECONOMY | "every unit backed 1:1 by litVM" | Not implemented; roadmap Phase I lists "litVM 1:1 backing — Queued", which is consistent. The pillar text is not | Add *"(Phase I, queued)"* or rephrase to the roadmap's tense |
| 03 IDENTITY | "Universal sign-in through AirKit. No per-game registration, no wallet ceremony" | litnode identity is a browser key, optionally bound to a wallet (`PlayerProfile`). AirKit is used by titles' own sites, not by the arcade or the node | *"One key, every title: the arcade holds it and signs for you. Bind it to a wallet once, or stay a guest."* Keep AirKit under the titles' own sign-in, not the arcade's |
| 05 OPERATIONS | "Matchmaking, tournaments, settlement, moderation — operated by AI agents" | Matchmaking and settlement are deterministic protocol (placement from a chain beacon; replay + witness), operated by nodes, not by agents; no tournaments; no moderation | *"Matchmaking and settlement are protocol, not staff: a chain beacon draws the host, nodes replay and co-sign. Tournaments and moderation agents come with Phase IV."* |
| 06 PLAYERS | "AI AGENT mode is native to each title" | The harness accepts an agent's inputs like a keyboard's (`inputSchema`); no agent daemon runs on nodes | *"Every title takes one input vector, from a keyboard or an agent. Node-hosted agent play is Phase III."* |
| 09 CHARACTERS | "Every character is attested to litVM under one NPC Agent schema … Stats and equipment land in a global database" | `ERC6699Registry` v2 is deployed with no minter and no characters; nodes hydrate `external` (zero stats) until one is forged | *"Characters will be registry tokens with four core stats every title maps through a bounded balance. The registry is deployed on testnet; the first forge is Phase III."* |
| 11 BUILD / SDK cards | "Gauntlet Loops · Harnesses · Infrastructure" | All three exist under other names (see `docs/PUBLISHERS.md` vocabulary) | Keep the names; add one line each pointing at the real thing: *Gauntlet Loops — a title file the node replays in a sandbox (`defineTitle`)*; *Harnesses — one input vector per tick, human or agent (`sdk/client.js`)*; *Infrastructure — bring your backend with the bridge, or run a node (`npm run host`)* |
| Developer section | "Every title runs as a node" | A title runs *on* nodes; a publisher typically runs one | *"Every title runs on nodes — yours and everyone else's. Run one in a minute: `npm run host`."* |
| RESERVE A NODE | "A limited few slots for testing" | Anyone can run a node today; bonding is 1 tLITVM on testnet; NodeDirectory lists announced seeds | *"Run a node now"* → `docs/HOST-A-NODE.md`. Keep the callsign / graph promise as the cosmetic layer it is |
| 07 NODES | "Every operator is attested on litVM before it can touch the network" | Unbonded nodes gossip and hydrate but are excluded from placement and co-signing — accurate in effect | Fine; optionally *"An unbonded node can listen; only a bonded one is drawn."* |
| Footer: Docs / Developer SDK | link targets unknown from here | The docs are `docs/PUBLISHERS.md`, `HOST-YOUR-TITLE.md`, `BRING-YOUR-BACKEND.md`, `BUILD-FROM-SCRATCH.md`, `HOST-A-NODE.md`; the SDK is `sdk/` | Point both at the repo docs until a docs site exists |
| Live titles: Agent Fighter "Verified wins" | Live AF results are relay-attested; the player-signing path shipped in 0.9.0 and is not yet exercised live | Keep, once one placed, player-signed, witnessed AF match is on the ladder (remediation item 3). Until then *"Signed, replayed, witnessed."* is the honest line — it is true of the protocol and of test matches |
| Live titles: Gods Vs Titans | Not in this repository at all (no ruleset, no cabinet entry) | Either add it to the cabinet as "not on the mesh yet" (as AFC is) or mark it |

## litvm.games/whitepaper

| article | says | true today | change to |
|---|---|---|---|
| Preamble | "a settlement layer already existing" | Yes on testnet: v2 contracts, hourly roots, one anchor on the retired v1 set | Add *"(litVM Liteforge testnet; contracts unaudited)"* — the README says it; the litepaper should too |
| IV Architecture | "agents think in Trusted Execution Environments … The agent thinks on the node, not on your machine" | No TEE, no agent daemon. The *title* runs in a permission-restricted sandbox process on the node — a process boundary, not a TEE | Move TEE agent inference to Phase III explicitly; describe today's boundary as it is: *"Title code runs on the node in a sandboxed process with no clock, no network, no filesystem; a witness re-runs it."* |
| IV "hybrid rollup … Espresso … Grail Bridge" | litVM's own stack; litnode only reads and writes Liteforge via JSON-RPC | Out of this repo's scope; leave to litVM |
| V "Operators earn direct service fees for verifiable compute, uptime and bandwidth" | No rewards, no fees, nothing pays anyone (SPEC §4) | *"will earn"*, or move to the economic model's future tense |
| V "Nodes are measured by attestation activity on the litVM registry" | Measured by bond (`NodeStake`), freshness and protocol version; no activity score | *"A node counts when it is bonded, fresh and current; activity-weighted standing is Phase II."* |
| VI ERC-6699 | "ERC-6699 defines an on-chain interface" | A *proposed* interface in this project; no ERC number assigned; `docs/HOST-YOUR-TITLE.md` rule 5 already says so | Add *"(proposed; this project's interface, not an accepted ERC)"* at first mention |
| VII Developer step 1 "Authenticate through AirKit" | Not part of the mesh SDK; the arcade holds the key and signs for the player | *"Take the arcade's player identity: the shell signs the match for the player; no sign-in inside your game."* |
| VII "Gauntlet Loops … spin up on a node when a match is requested … Then it dies." | Exactly what placement + sandboxed replay + co-sign does, minus "when a match is requested" — the node replays *after* the match from the signed log; gameplay runs on the publisher's transport | *"…runs the fixed-tick simulation from the signed inputs, produces a match delta, has it co-signed by a witness on another operator's node, and relays it to settlement."* |
| VII "It will not build a bundle that imports the simulation loop, the hit resolution, the inventory ledger, the inference harness or the delta signer." | The conformance suite refuses a bundle that imports anything at all, reaches for the world, or is non-deterministic — a stricter rule, differently framed | *"The SDK will not build a bundle that imports anything, touches the clock, the network or storage, or fails to replay to the same root twice."* |
| VII "What you keep: your engine, your database, your art direction, your soft currency" | True, and now documented as the bring-your-backend path | Link `docs/BRING-YOUR-BACKEND.md` |
| Schedule Phase II "On-chain match attestation" | Done on testnet (epoch roots); official results need a second operator live | Mark *in flight* |
| Attestation table (seven operators) | Three bonded nodes exist (desktop, laptop, Ally), one operator wallet plus one second wallet | Either list the real three with their real states or label the table illustrative |

## arcade.litvm.games (the cabinet, this repo)

| where | says / does | change (done in this pass unless noted) |
|---|---|---|
| Launch | only Agent Fighter received `?ws&room&player&match&build`; other placed titles got a bare URL | Every placed title gets the same launch, and `cabinet:init.match` now carries `hostAddr`, `mode`, `buildHash`, `rulesetId` — **done** (`cabinet/app.js`) |
| Find match | "advertises no relay (wsAddr) — placed, not playable from here" blocked launch for any title without a relay | Launch allowed for any placed title; the missing relay is a note (the title brings its own transport) — **done** |
| Footer / Build link | none | Add a "Build" link to `docs/PUBLISHERS.md` in the cabinet footer — *not done; one line in `cabinet/index.html` when the docs have a public URL* |
| Titles table (README) | AFC "in the cabinet; ruleset is roadmap item 2" | Unchanged; accurate |

## One paragraph for every surface

If a single paragraph has to be the same everywhere:

> litVM Games settles matches, not frames. A game runs wherever it runs —
> your servers, your engine, your database — and at the end of every match
> one signed record reaches a community-run node. If the game is
> deterministic, the node replays it and a node under another operator
> replays it again; if it is not, the game's own court signs the outcome
> and the ladder says so. Every settled match goes under an hourly root on
> litVM. Players are one key across every title; characters will be
> registry tokens every title maps through a bounded balance. Bring your
> backend, or build from scratch: `docs/PUBLISHERS.md`.
