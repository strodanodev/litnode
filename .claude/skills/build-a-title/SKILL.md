---
name: build-a-title
description: Build a new game for the litVM Games mesh from scratch — a deterministic title file the node replays, a browser client on sdk/client.js that runs the same file, records inputs, gets the player's ledger signature from the arcade shell and settles on the host node, a transport of the publisher's choosing, and a bonded node that hosts and lists it. Use when a developer is starting a game and wants it born on the mesh, with no settlement backend of their own.
---

# Build a title from scratch

You are helping a developer make a game whose matches settle on the mesh
with no backend of their own. Read `docs/BUILD-FROM-SCRATCH.md` (the
client contract) and `docs/HOST-YOUR-TITLE.md` (the title contract) first.
The `host-a-title` skill covers step 1 in detail; this skill is the whole
path, client included.

## Ground rules

- **One file, two runtimes.** The title module the client renders from is
  byte-for-byte the module the node replays. Never let the client's game
  logic drift from the ruleset; the client imports it.
- **Inputs are the match.** Everything the game does must follow from the
  seed and the per-tick inputs of every participant, in participant
  order. If the client needs something else to decide the outcome, the
  design is wrong for the mesh.
- **The key never enters the game.** The player's ledger signature comes
  from the cabinet shell (`cabinet:sign`) or, standalone, from a key the
  developer holds for tests. The game code never sees a private key.
- **Verify by settlement.** A feature is done when a match round-trips:
  queue → placement → play → `settle()` → `GET /delta/<matchId>` shows
  `attestation: 'players'` and the delta's `finalStateRoot` equals the
  client's `sim.root()`.

## Procedure

1. **Title.** `npm run create-title -- <id>.v1 "<Name>"`; put the rules in
   `init/step/done/serialize/view/scores`; `inputSchema` documents the
   input vector; `defineBalance` for character stats; `display` with the
   client's URL. `npm run conformance`, then `npm run bundle:title`. Keep
   `buildHash` from `rulesets/<id>.v1.json`.
2. **Client skeleton** (`docs/BUILD-FROM-SCRATCH.md` §2): import the title
   module and `sdk/client.js`; `parseLaunch` + `connectShell` (fall back to
   standalone when no `cabinet:init` arrives); `matchSeed(match)`;
   `createSim(title, { seed, participants, ctx: { agents: externalAgents(participants) } })`;
   `createRecorder`. Participants and their order come from the placement.
3. **Transport.** The developer's choice: a WebSocket relay beside their
   host node (fronted by `RELAY_PORT`, advertised as `wsAddr`) or
   anything else. Requirements you enforce: every tick's inputs for every
   player reach both clients in the same order; the room is `parseLaunch().room`;
   the other player's ledger signature can cross it at match end.
4. **Match end.** `rec.body()` → `shell.sign(body)` (or `localSigner`) on
   each client; the submitting client calls `settle({ nodeUrl: match.hostAddr,
   recorder, signers })`. Handle `already` (the other client submitted
   first) as success.
5. **Standalone test.** Two `localSigner`s, an in-process node
   (`demo/publisher.test.mjs` "client sdk" test is the template): the
   delta's scores and `finalStateRoot` must equal the local sim's.
6. **Host and list.** `host-a-node` skill: `npm run host -- init … --rulesets
   ./rulesets/<id>.v1.js`, `start --detach`, `status`; `GET /titles` lists
   the display. Bond the node; unbonded hosts are never placed. Then claim
   the title from the same wallet: `PUBLISHER_KEY=0x… npm run publish:title
   -- register rulesets/<id>.v1.js` — an ERC-721 the wallet holds; the mesh
   loads the build from the chain's word and `GET /titles` reports
   `published: true` while that wallet's bonded host carries it. Hand-over
   = transfer the token.
7. **Arcade round trip.** Open the cabinet against that node, *Find match*
   with two browsers, launch, play, and read `GET /delta/<matchId>`:
   `placed: true`, `attestation: 'players'`. With a witness under another
   operator, `official: true`.
8. **Report** what works, the `buildHash`, the node's URL, and which of
   the known gaps (`docs/BUILD-FROM-SCRATCH.md` §Known gaps) apply.

## Do not

- Use `Math.random`, `Date`, `fetch`, timers or storage inside the title,
  or floats where integers will do.
- Let one client submit a log the other never saw; the witness will
  replay exactly what was submitted, and a disputed log helps nobody.
- Treat `attestation: 'host'` (no signatures) as a result: it is casual
  only and off every official ladder.
