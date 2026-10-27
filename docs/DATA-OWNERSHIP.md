# Data ownership: who holds what (24 Oct 2026)

Audited at litnode `5adf5b4` (0.12.1 + two commits) against the five products
in `handoff/settlement-v4/7-integration-audit-2026-10-24.md`. Four places
hold data, and each answers a different question:

| Plane | Who runs it | Answers |
| --- | --- | --- |
| **Frontend** (Vercel) | each publisher, and us for the arcade | what the player sees; holds nothing authoritative |
| **Studio plane** (the title's own database) | each publisher | accounts, soft currency, inventory, shop, social |
| **Node plane** (litnode) | bonded operators | placement, hosting, settlement, every fold of results |
| **Chain** (litVM Liteforge, 4441) | contracts, no admin on the result path | which ranked matches are final, who is bonded, who owns what title |

The rule that keeps them apart (BUILD-SPEC §1.2, §10): the studio plane is
never on the path from a cold browser to a settled match. The node never
reads a studio database; a title's backend writes to the node
(`POST /ledger`), never the other way.

## 1. Frontend — Vercel

| Surface | Vercel project | Domain |
| --- | --- | --- |
| Arcade (cabinet) | team NPC, `cabinet` (deployed from `cabinet/`) | arcade.litvm.games |
| Agent Fighter client | AF repo | www.agentfighter.wtf |
| Pickle Brawl web | PB repo (`dist-web/vercel.json`) | — |
| FLOOD CONTROL board + court | bagyogame repo | play.bagyo.app |
| AFC client | AFC repo | — (its host is on Railway, not the mesh) |
| Website / Control Plane download | `litgaming-website` (Codex-owned) | litvm.games |

What a frontend keeps is the browser's: the cabinet stores the **player's
ed25519 key** in `localStorage` (`cabinet/client.js loadKeypair`), the AIR
session (`cabinet/air.js`), the chosen node URL and uptime samples. The
player owns that key; no server has a copy. Losing the browser loses the key
unless it was bound to a wallet through `PlayerProfile`.

## 2. Backend database, credits, inventory — the studio plane

Each title owns its own database. Nobody's sits behind the node.

| Title | Database | What it holds |
| --- | --- | --- |
| Agent Fighter | Supabase (32 migrations, last `0032_pet_roll_tickets`) | profiles, **credits** + escrow, items + equip, pets, tickets, trained agents, referrals, its own **Elo** (`0021`), season board, daily economy, match ledgers |
| Pickle Brawl | Postgres on Supabase, through its own API (`services/api`, 11 migrations) | accounts, friends, open play + payouts, orders (PayPal), collection, **inventory**, wallet links, court results |
| FLOOD CONTROL | **Neon** (`daily_entries`) | daily runs and their rich stats |
| AFC | Supabase (6 migrations) | AIR identity, ledger, **inventory**, matches, `litnode_settlements` (settle status per match) |
| Arcade | none | Cards / inventory pages show sample data (`cabinet/roster.js INVENTORY_SAMPLE`) |

**Credits.** The real soft currencies live here (AF credits, PB payouts).
The node also derives a per-title credit balance from deltas
(`protocol/derive.js`, `GET /credits`), but it reconciles to nothing on
chain (SPEC §4) and no title spends it. Two numbers carry the same name.

**Inventory.** Entirely studio-side. `ERC6699Registry` (characters) is
deployed and has no minter, so nothing a player owns is on chain yet.

### Preferred stack: Neon

For a **new** title the studio database is **Neon Postgres provisioned
through the Vercel Marketplace**: one integration on the title's Vercel
project injects `DATABASE_URL` into every environment, preview deployments
get their own Neon branch, and the secret never leaves managed env (see
`docs/STANDBY-HOST.md` on secrets). FLOOD CONTROL already runs this way.

Existing Supabase titles (Agent Fighter, Pickle Brawl, AFC) stay where they
are; nothing on the mesh depends on which Postgres a studio picks, so a
move is the studio's call and never blocks settlement. Supabase remains
supported for the things Neon does not bundle (auth, storage, realtime) —
a title that needs them can keep Supabase or pair Neon with its own.

## 3. Matchmaking, multiplayer, rankings, stats — litnode

| Concern | Owner | Where |
| --- | --- | --- |
| **Ranked matchmaking / placement** | litnode | queue → placement from the chain beacon: players, build, seed, host and three witnesses fixed and signed before play (`SETTLEMENT-STANDARD.md §6`) |
| Lobbies, parties, casual rooms | the title | PB's matchmaker and AF's relay rooms; they can run **on** a node as publisher services (`SERVICES=`, `/svc/…`) or gauntlet servers, but the logic is the publisher's |
| **Multiplayer transport** | the title's server, hosted by a node | gauntlet: the drawn host spawns the title's headless server per match and fronts it on its tunnel (AF, PB courts). FLOOD CONTROL is single-player; AFC is off-mesh on Railway |
| **Settlement** | litnode | `POST /ledger` → replay or validate → delta with `resultHash` → witnesses co-sign or dispute |
| **Rankings (Elo), XP, level** | litnode folds | `protocol/derive.js`, `protocol/progression.js` → `/leaderboard`, `/progress`. **Official** standings fold the MatchBook event log (`source: chain`); anyone can recompute them |
| **Stats** | litnode folds | the title declares a schema; the node lifts per-match stats into the committed delta (`protocol/stats.js`) → `/stats`, `/proof/stats` |
| Match logs | litnode custody | `<dataDir>/logs/<inputsHash>`, served at `/log/…`, held by k = 3 custodians for off-chain results |
| Rewards points (Season Zero) | litnode tooling | `npm run rewards` folds chain events off-chain; paid from the rewards treasury on `NodeStake` |

Overlap to resolve: Agent Fighter keeps its **own Elo and season board** in
Supabase beside the node's ladder. The node's is the one that can be
proven; the studio copy should be labelled as the studio's, or read from
the node.

Custody to decide: AIR sign-in makes the node keep a litVM **proxy wallet**
per AIR account (`POST /air/session`), so for those players the node holds
a key (the open AIR custody decision).

## 4. What is attested on chain

Per ranked, placed match (L3, `proof: verified`), from the host's and the
seats' delegated keys on **`MatchBook`**:

- `commit(matchId, descriptorHash, rulesetId, hostKey, panel[3])` before play
- `settle(matchId, resultHash, ledgerHash, buildHash, participants, scores, custodians)`
- `attest(matchId, witnessKey, resultHash)` × 3, then `finalize`
- on dissent: `escalate` → nine-seat panel → `resolve`, slashing through `NodeStake`

Per hour, on **`EpochAnchor`**: one root = `sha256(resultsRoot ‖ statsRoot)`
over the hour's final matches and every player's season stats line,
final at stake quorum. Any single result or stats line proves against it
(`EpochAnchor.verifyInclusion`).

Registries:

| Contract | What it records |
| --- | --- |
| `NodeStake` | operator bonds, delegate keys, unbonding, slashes; the treasury slashes go to (the rewards pool) |
| `NodeDirectory` | each node's public URL |
| `TitleRegistry` (ERC-721) | one token per ruleset = the publisher; registered build and verifier hashes |
| `ReleaseRegistry` | litnode release hashes nodes may run |
| `PlayerProfile` (ERC-721) | a player's name and the keys bound to their wallet |
| `GasRefund` | refunds to hosts and agreeing seats |
| `NodeBadge`, `TestLITVM` | soulbound badge per bonded node key; the test token |
| `ERC6699Registry` | characters: deployed, **empty** |

**Not on chain:** every result that never reaches MatchBook — casual,
unplaced, and L1 `attested` / L2 `checkable` (Pickle Brawl, FLOOD
CONTROL). They live on the nodes, co-signed by custodians, in each node's
local root (`/epoch?scope=local`) until §12 of the settlement standard
lands. Nothing per match is minted: Elo,
XP, credits and stats are folds, never balances. No credit, item, pet or
ticket is on chain.

Addresses: `contracts/deployed.testnet.json`.
