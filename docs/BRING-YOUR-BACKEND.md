# Bring your backend: settle an existing game on the mesh

For a game that already runs — its own relay or match server, its own
database, its own accounts. Nothing about how it plays changes. At the end
of every match, one message reaches a node; the node and an independent
witness decide what it is worth; the result lands on the same ladder and
under the same hourly root as every other title.

Code: `sdk/bridge/` (`npm run bridge`). Tests: `demo/publisher.test.mjs`.
Agent procedure: `.claude/skills/migrate-a-title/SKILL.md`. The title
contract itself: [HOST-YOUR-TITLE.md](HOST-YOUR-TITLE.md).

## 1. Which kind of title you have

```bash
npm run bridge -- assess --input-log yes|no --deterministic yes|no [--engine-open yes|no]
```

| your backend | kind | the node does | the label |
|---|---|---|---|
| keeps every player's input per tick, and re-running them from the seed reproduces the result on any machine (integer or seeded math, no wall clock, no float physics), and the sim can be bundled as one import-free ES module | **replayable** | re-runs the log in its sandbox; a witness on another operator's node re-runs it again | `players` (both signed → can be OFFICIAL) or `relay` (your key signed → authenticated, not official) |
| anything else (float physics, a closed engine, no input log) | **attested** | validates your outcome report against your ruleset (bounds, win condition, seats) and settles it | `attested`: trusted, not verified, never OFFICIAL |

Agent Fighter is the replayable reference (`titles/agent-fighter.adapter.js`,
`sdk/bridge/adapters/agent-fighter.mjs`); Pickle Brawl the attested one
(`titles/pickle-brawl.adapter.js`). Attested is the honest label for most
existing games; the path from attested to replayable is a build change on
your side (seeded randomness, fixed-point or integer math, an input log)
and a new build hash on the mesh — never a migration of old results.

## 2. The ruleset

Replayable: port `init/step/done/serialize/scores/view` into
`titles/<id>.mjs` — the *same* simulation your server runs, so bundle your
engine with it (`tools/bundle-ruleset.mjs` does this for Agent Fighter's
`@af/core`). Attested: write `validate(report)` and `scores(report,
participants, teams)` — the rules a node can check without playing. Then:

```bash
npm run conformance -- titles/<id>.mjs
npm run bundle:title -- titles/<id>.mjs        # rulesets/<id>.js + .json { buildHash }
```

The `buildHash` in the `.json` goes into every replayable submission.

## 3. The bridge key

```bash
npm run bridge -- key --kind replayable --ruleset <id>.v1     # or --kind attested
```

Creates `~/.litnode/bridge-key.json` (an ed25519 identity, not a wallet)
and prints the one line the node operator adds to `node.env`:

- replayable: `RELAY_KEYS=<publicKey>` — the node settles what this key
  signs as `relay` provenance
- attested: `COURTS=<rulesetId>:<publicKey>` — the node accepts this key's
  reports for that title (or list it in the manifest's `attestors`)

Then restart the node. Until then every submission is refused with
"not a relay this host trusts" / "not an authorized court".

## 4. Wire the backend — pick one

### a. Webhook (simplest): `bridge serve`

```bash
set BRIDGE_TOKEN=<random ≥16 chars>
npm run bridge -- serve --port 8480 --node http://127.0.0.1:7801 --ruleset <id>.v1 --kind replayable|attested
```

At match end your server POSTs the **unsigned** submission:

```
POST http://127.0.0.1:8480/submit
authorization: Bearer <BRIDGE_TOKEN>
content-type: application/json
```

The bridge validates, signs (relay or court), forwards to the node, and
answers `{ status: 'settled'|'already'|'refused', matchId, delta?|error }`.
`GET /check/<matchId>` afterwards says what the mesh made of it.

### b. Poll (no code on your side): `bridge watch`

```bash
npm run bridge -- watch --adapter jsonl --source ./results.jsonl --kind attested --ruleset <id>.v1
npm run bridge -- watch --adapter http  --source https://api.your.game/litnode/results --kind replayable --ruleset <id>.v1
npm run bridge -- watch --adapter ./my-adapter.mjs                                # your own source
```

`jsonl`: your backend appends one line per finished match (a cron job, a
DB trigger). `http`: your backend exposes `GET …?since=<cursor>` returning
`{ rows: [{ id, room?, submission }], cursor }`. Your own adapter exports
`kind, rulesetId, poll(cursor, ctx), toSubmission(row, ctx)` — see
`sdk/bridge/adapters/agent-fighter.mjs` for a Supabase one. The cursor and
every outcome persist in `~/.litnode/bridge-<adapter>.json`, so restarts
re-send nothing. `--once` runs one pass; `backfill` runs from the start
until caught up (history import: everything already on the node comes
back `already`).

Run `serve` or `watch` as a service beside the node (the operator zip's
`run-af-watch.cmd` is the Agent Fighter instance of exactly this).

## 5. Submission shapes

**Replayable**

```json
{ "matchId": "…", "rulesetId": "my-game.v1", "buildHash": "<64 hex from rulesets/my-game.v1.json>",
  "mode": "casual" | "ranked",
  "participants": ["<player key or id>", "<player key or id>"],
  "entries": [ { "k": 0, "inputs": [<p0 input>, <p1 input>] }, … ],
  "signatures": { "<playerKey>": "<sig>", … },        // optional: both → 'players'
  "hydration": { … }, "expected": { "hash", "winner", "rounds", "endTick" },   // optional
  "room": "LIT-…" }                                    // optional: the mesh room code the arcade launched with
```

`bridge body <file>` prints the exact body a player signs
(`{ matchId, ticks, head, buildHash }`, tag `ledger`). In the arcade the
cabinet signs it for the player (`cabinet:sign`, [BUILD-FROM-SCRATCH.md](BUILD-FROM-SCRATCH.md));
your relay collects both signatures and includes them. Without them the
bridge's relay key backs the result: authenticated, labelled `relay`, not
official. `expected` is your own record — the node refuses a log whose
replay disagrees with it. `room` (from `?room=` on the launch URL) binds
the submission to the mesh's placement: same match id, the keys the mesh
placed, the mode it placed — which is what makes a result eligible to be
official.

**Attested**

```json
{ "kind": "attested", "matchId": "…", "rulesetId": "my-game.v1", "mode": "casual",
  "participants": ["pb:air:ana", "pb:air:bo"], "teams": [["pb:air:ana"], ["pb:air:bo"]],
  "report": { … whatever your validate() checks … } }
```

## 6. Read back

```bash
npm run bridge -- check <matchId>
```

`OFFICIAL: placed, signed, independently verified, undisputed` or
`settled, not official: <reasons>` — casual mode; not placed by the mesh;
relay-attested; court-attested; no independent witness yet; disputes. The
ladder at `GET /leaderboard?ruleset=<id>` is the official one; `&scope=all`
shows everything, labelled.

## 6b. Finding the node

`--node auto` (or `LITNODE_URL=auto`) on any bridge command, and `npm run
bridge -- resolve --ruleset <id>`, read NodeDirectory on litVM and pick the
freshest bonded node that proves its key, hosts the ruleset and settles.
Use it wherever the node's hostname can change (a quick tunnel); a
publisher's server that cannot import the bridge can do the same three
`eth_call`s itself, as Pickle Brawl's court does (`services/court/src/litnode-report.ts`).

## 7. Cutover checklist

1. `assess` → kind. 2. Ruleset conformant and bundled; `buildHash` known.
3. `bridge key`; operator adds `RELAY_KEYS`/`COURTS`, restarts, `/health.trust` shows it.
4. `serve` or `watch` running as a service; one test match settles and `check` finds it.
5. `display.url` in the manifest is your game's URL, and the game honours
   the launch (`?room&player&match&build`, [BUILD-FROM-SCRATCH.md](BUILD-FROM-SCRATCH.md) §launch)
   so arcade-placed matches settle under the mesh id.
6. Replayable and want OFFICIAL: your client asks the shell to sign at
   match end and your relay forwards both signatures.
7. `backfill` history if you want old results on the ladder (they settle
   unplaced, labelled, never official).

## Worked example: Pickle Brawl (attested, signs locally)

Migrated 21 Sep 2026. The game keeps its matchmaker, lobbies, courts and
Supabase; nothing about play changes.

- `assess --input-log no --deterministic no --engine-open no` → **attested**.
- Ruleset: `titles/pickle-brawl.adapter.js` (to 11, win by two, seats by
  mode) → `rulesets/pickle-brawl.v1.js`, hosted on the desktop node.
- Key: `npm run bridge -- key --kind attested --ruleset pickle-brawl.v1
  --file ~/.litnode/pickle-brawl-court.json`; the node operator adds
  `COURTS=pickle-brawl.v1:<publicKey>` and restarts.
- Wiring: the court process (`services/court/src/litnode-report.ts` in the
  Pickle Brawl repo) signs the report itself at GameEnd — the court *is*
  the authority, so the key lives with it (Railway env `COURT_IDENTITY`
  as inline JSON) — and posts to the node it resolves from NodeDirectory
  (`LITNODE_URL=auto`). `mode: 'casual'`, unplaced: the mesh did not book
  the match. Settles `attested`; a witness co-signs attestation-only.
- Verified: `services/court/test/litnode-report.test.ts` against a live
  node (settles, idempotent, win-by-one refused, unlisted court refused,
  abandoned game scores 0–0); chain discovery resolved the desktop in ~3 s.
- Not done, by design: arcade placement (`room`), player signatures, and
  anything official — an attested title cannot be. The path to replayable
  is stated in the adapter.

## What this does not do

- Make an attested result official. Only a replayable, placed,
  player-signed, independently witnessed, undisputed result is.
- Carry your gameplay. The relay between players stays yours.
- Read your database. The bridge reads only what your adapter hands it.
- Touch a wallet. The bridge key signs match records; bonding the node is
  the operator's wallet ([HOST-A-NODE.md](HOST-A-NODE.md)).
