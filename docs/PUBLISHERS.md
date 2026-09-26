# Publishers: two paths onto the mesh

The one-page form of everything below, with the "for dummies" pictures, is
[SDK.md](SDK.md), served by the arcade at arcade.litvm.games/#/build.

This is the front door for a studio or a solo developer. Everything the
whitepaper and litvm.games promise a developer maps to something in this
repository that runs today, or to an honest "not yet". Two paths:

| you have | path | what you keep | what changes |
|---|---|---|---|
| A game already running on your own backend (a relay, a match server, a database of results) | **Bring your backend** — [BRING-YOUR-BACKEND.md](BRING-YOUR-BACKEND.md), skill `migrate-a-title` | your engine, your database, your art direction, your soft currency, your servers | one message per finished match reaches a node; a ruleset the node can check; a bridge key the node trusts |
| A game whose match server should run **on the node**, nothing hosted elsewhere | **Gauntlet loop**: [BRING-YOUR-BACKEND.md section 6a](BRING-YOUR-BACKEND.md), config in `gauntlets/`, skill `migrate-a-title` | your engine, your art, your database for everything outside the match | the node spawns your headless server per placed match, mints the seats, fronts it on its tunnel, ends it when the match settles |
| A studio backend that is more than a court (accounts API, matchmaker, lobbies) and should run **on the node** | **Publisher services**: [BRING-YOUR-BACKEND.md section 6c](BRING-YOUR-BACKEND.md), `SERVICES=` in `node.env`, skill `migrate-a-title` | your engine, your art, your database | the node supervises each service and publishes it at `/svc/<prefix>.<name>` on its tunnel; the client finds it through NodeDirectory |
| A game you are starting now | **Build from scratch** — [BUILD-FROM-SCRATCH.md](BUILD-FROM-SCRATCH.md), skill `build-a-title` | the same; you write no backend for settlement | the simulation is one deterministic file both the client and the node run |

Both end at the same place: a *title* (one file, [HOST-YOUR-TITLE.md](HOST-YOUR-TITLE.md))
hosted on a bonded node ([HOST-A-NODE.md](HOST-A-NODE.md), skill `host-a-node`),
its matches settling into the same hourly roots on litVM as every other
title, its players on one ladder with one identity.

## The vocabulary, mapped

The site and the litepaper use one set of words; the code uses another.
They are the same things.

| site / litepaper | in this repository | status |
|---|---|---|
| **Gauntlet Loop** — "spins up on a node when a match is requested, runs the fixed tick simulation, collects signed inputs, produces a match delta, has it co-signed, and relays it to settlement. Then it dies." | Two shapes. (a) A *replayable title* (`defineTitle`) run by `node/sandbox.js`: placement freezes the match, the node replays the signed input log in a separate permission-restricted process, produces a delta, a witness on another operator's node co-signs it, the hour's deltas go to `EpochAnchor`. The process dies after the replay. (b) A *gauntlet* (`node/gauntlet.js`): the node spawns the title's own headless server per placed match, seats the players, fronts it on its relay tunnel, and ends it when the match settles. | (a) built, tested (`demo/settle.test.mjs`, `demo/audit.test.mjs`); (b) built, tested (`demo/gauntlet.test.mjs`); Pickle Brawl's court runs on it |
| **Harness** — "one interface for humans and agents" | The title's `inputSchema`: one input vector per participant per tick, whoever produced it. `sdk/client.js` records it; a human's keyboard and an agent's policy fill the same field. | built; AI AGENT mode (an agent daemon on the node) is roadmap |
| **Infrastructure** — "attest characters, equipment and matches to the global database" | Matches: settlement + `EpochAnchor` (live on Liteforge). Characters: `ERC6699Registry` v2 (deployed, no minter yet). Players: `PlayerProfile` (deployed). | matches live; characters deployed but empty |
| **Attested node / operator** | A node whose key is bonded on `NodeStake`; placement draws only from the bonded set | live |
| **Settle everything. Trust nothing that is not signed.** | Every queue entry, heartbeat, ledger head, delta, co-signature, dispute and directory entry is an ed25519 signature or an EVM transaction | live |
| **Verified wins** (Agent Fighter's line) | `attestation: 'players'` + independent witness = OFFICIAL. Today AF's live results are `relay`-attested (authenticated, not yet player-signed live); 0.9.0 has the signing path | protocol built; live demonstration pending |
| **Attested** (Pickle Brawl) | `defineAttestedTitle`: a court signs a report the node validates but cannot replay; labelled, never OFFICIAL | live on the desktop node since 26 Sep: court key authorized in `COURTS`, API, matchmaker and two courts run as publisher services, first attested result settled |
| **One account, universal sign-in through AirKit** | A player is an ed25519 key, bindable to a wallet through `PlayerProfile` ([WALLET-IDENTITY.md](WALLET-IDENTITY.md)). AirKit sign-in is in litnode since 0.10.0: `POST /air/session` verifies an AIR Kit session and keeps a litVM proxy wallet for the account ([UNIVERSAL-LOGIN.md](UNIVERSAL-LOGIN.md)); the cabinet's identity is the key, optionally bound to a wallet | live |
| **Every title keeps its own Supabase** | Yes — the *studio plane* (BUILD-SPEC §10). Nothing in it may sit on the match critical path; the bridge reads from it, the node never does | by design |
| **Every credit … reconciles to litVM, 1:1 backing** | Credits are derived per title from deltas (`protocol/derive.js`); they reconcile against nothing on chain yet | not yet ([SPEC §4](../SPEC.md#4-known-gaps-and-honest-zeroes)) |
| **ERC-6699** | This project's *proposed* interface (`contracts/ERC6699Registry.sol`); no such ERC number is assigned. Titles read four `uint16` core stats through `defineBalance` | deployed v2, empty |
| **Every title runs as a node** | Every title runs *on* nodes; a publisher usually also runs one (a seed and host for their title) — `npm run host` | live |

## The seven developer steps, as they really are

The litepaper's Article VII lists what a developer must do. Here is each one
against the code.

1. **Authenticate through AirKit.** In litnode since 0.10.0: `POST /air/session` (docs/UNIVERSAL-LOGIN.md). What exists: the cabinet
   holds the player key and hands the title a signature over the match it
   launched (`cabinet:sign`). Inside the arcade a first-party title signs
   in with the arcade's own AIR session and never shows its own login
   (`cabinet:air`, docs/UNIVERSAL-LOGIN.md "Titles inside the arcade"); on
   its own domain it logs in itself.
2. **Declare balance mapping.** `defineBalance` in your title file, bounded
   ranges, versioned by hash. Real.
3. **Hydrate agents.** The node reads `ctx.agents` from the registry at the
   placement's block for ranked matches; a submission's own claim is
   labelled `fixture`. Real, but the registry holds no characters yet.
4. **Move simulation into a Gauntlet Loop.** The title file's
   `init/step/done/serialize`, replayed in the sandbox. Real.
5. **Expose a harness.** `inputSchema` + `sdk/client.js` recorder. Real.
6. **Settle matches.** `POST /ledger` with both players' signatures (from
   scratch) or through the bridge (existing backend). Real.
7. **Ship.** Claim the title on chain — an ERC-721 your wallet holds; hand
   it over by transferring it. Signed in with AIR on your node: the
   cabinet's Publisher panel claims it and bonds the node from the same
   wallet, no prompts (docs/UNIVERSAL-LOGIN.md). From a wallet you hold:
   `npm run publish:title -- register rulesets/<id>.js` and `npm run host -- bond` with `OPERATOR_KEY` set to that same wallet.
   Either way `display` in the manifest lists you in the arcade once the
   holder's bonded host carries the title. Real. "Characters
   forged anywhere can enter" waits on the registry's minter.

## Where things are

```
docs/SDK.md                 the one-page SDK instructions + for-dummies pictures (= arcade #/build)
docs/PUBLISHERS.md          this page
docs/PUBLISHER-BONDS.md     title ownership as an ERC-721 (BUILT: TitleRegistry, npm run publish:title); host grants, escalation, revenue share (spec)
docs/BRING-YOUR-BACKEND.md  existing backend → bridge → settlement          sdk/bridge/   npm run bridge
docs/BUILD-FROM-SCRATCH.md  new title → client SDK → cabinet → settlement   sdk/client.js
docs/HOST-YOUR-TITLE.md     the title contract and the rules of recognition sdk/index.js  npm run create-title|conformance|bundle:title
docs/HOST-A-NODE.md         run the node that hosts it                     sdk/host/     npm run host
docs/WEBSITE-COPY.md        what the site and litepaper say vs. what ships, and the copy to change
.claude/skills/             migrate-a-title · build-a-title · host-a-title · host-a-node
```
