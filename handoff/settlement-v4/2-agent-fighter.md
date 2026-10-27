# Prompt 2 — Agent Fighter: settlement v4 (stats on-chain, one intake, arcade identity)

You are working in the Agent Fighter repository (GitHub strodanodev/agent-fighter,
engine package `@af/core`) on this machine. The litnode node software is a
separate repository (strodanodev/litnode). If it isn't cloned here, clone it
read-only next to this repo for reference, and expect its v4 work to land on its
master later; the user will tell you when it is pushed. Until then, build against
the shared contract at the end of this prompt.

## Context

Agent Fighter is the reference **L3 `verified`** title, the only one whose
results can count as official.
- Every match is a per-tick input log both players sign
  (`{matchId, ticks, head, buildHash}` under the `ledger` tag, signed by the
  arcade shell via `cabinet:sign`).
- Nodes replay it in a sandbox with litnode's adapter
  `titles/agent-fighter.adapter.js`, which is bundled with `@af/core` into one
  import-free artifact (`npm run bundle:af` in litnode). The buildHash pins
  engine and adapter together.
- Ranked matches run the full MatchBook cycle on LitVM
  (commit → settle → attest×3 → finalize). Two ranked finals exist.

Engine facts the adapter relies on:
- `createGameState(seed:int32, bounds?)` and `step(state, [frameA, frameB])`,
  which mutates state, with inputs as bitfields by side.
- `Phase.MatchOver`, `serialize(state): Int32Array`, and an FNV `stateHash()`.
- `setCharacters` / `setMatchPets` / `setMatchItems` are **module-level pins**,
  so one process can simulate only one match. The adapter sets
  `exclusive = true` because of this.

Settlement reaches nodes by three intakes: the relay with af-watch, the
gauntlet match server, and an import tool. The serverless work (M0–M4; M4
pushed as d7a4478, unreleased) moves play off the publisher.

## Goals

1. **Per-match stats that witnesses recompute.**
   - Decide the competitive stats worth keeping on-chain. Suggestions: `kos`,
     `roundsWon`, `perfectRounds`, `damageDealt`, `maxCombo`, `supersLanded`,
     `parries`.
   - Make the engine accumulate them **inside GameState as integers**, so they
     are in `serialize(state)` and reproduced bit-exactly by every replay. No
     floats, no clock, no `Math.random`.
   - Then write the adapter's `stats(state, participants)` and the stat schema
     (`sum | max | min | last`) as a patch for litnode's
     `titles/agent-fighter.adapter.js`, and hand it back.
   - This is a consensus change: a new engine build, a new buildHash, and
     re-registration on TitleRegistry (a user step). Old results are never
     relabelled.
2. **Move the engine pins into GameState, if feasible.** Move
   `setCharacters` / `setMatchPets` / `setMatchItems` into the state so a
   process can replay matches concurrently. Then tell the litnode session it
   can drop `exclusive`. If it's too invasive, write down why and stop.
3. **One intake.**
   - Make the gauntlet match-server path, with players signing, the only ranked
     path.
   - Inventory what still uses the relay and af-watch intake, and what import
     is for.
   - Propose the retirement plan for the relay intake: retire it once the
     gauntlet runs on two or more operators.
   - Make sure the match server can ship as a litnode **server bundle**: one
     deterministic tar, esbuild-bundled, no node_modules, a `manifest.json` with
     `kind: 'server'`.
4. **Arcade identity everywhere.**
   - Participants are the arcade's ed25519 player key in every mode the arcade
     launches.
   - Any `af:<name>` path is casual-only, and must be labelled that way in the
     UI.
5. **Read contract addresses from the arcade.**
   - Read LitVM contract addresses from the arcade's served `/contracts.json`
     (or the litnode config). Never hard-code them: a hand-copied gen-2 address
     set once took the client down for a day.
   - Show each match's proof level and an EpochAnchor or MatchBook link in
     results and history.

## Ground rules

- Determinism first. Run the existing cross-platform replay and determinism
  tests before and after every engine change. Any change to `serialize` output
  is a new build.
- Commit locally. **Don't** push, deploy, publish a build, register, or send
  transactions; those are user steps, so list them.
- Secrets stay in managed env (Vercel or the host). Never print or copy `.env`
  or key files.
- If this repo has a `graphify-out/graph.json`, query it before grepping.

## Hand-back (end of session)

Write `docs/LITNODE-V4-HANDBACK.md` in this repo and print it. It covers:
- the stat names and ops;
- the engine fields holding them;
- the exact adapter patch (`stats()` and schema);
- the new engine version and how to rebuild the bundle;
- the relay-retirement plan;
- whether the pins moved;
- user steps;
- open questions for the LITNODE session.

---

# Settlement v4 — the shared contract (proof levels)

Every prompt in this folder embeds this block, so each session works against the
same names. The LITNODE session owns the canonical text: once it lands in
`docs/SETTLEMENT-STANDARD.md`, that file wins over this one. A rename there must be
announced to the four title sessions.

## Principle

One pipeline for every title: PLAY → REPORT → VERIFY → RESULT HASH → RECORD.
What varies is only the proof level, which is recorded and never upgraded after
the fact.

| Level | `proof` | Meaning | Official ladder |
|---|---|---|---|
| L3 | `verified` | Independent nodes replayed the signed input log (`attestation: 'players'` + witness agreement) | yes |
| L2 | `checkable` | An authorized court replayed it and committed the log (bytes held by the mesh) and a verifier registered on TitleRegistry; anyone can re-run it on challenge | no (prize-eligible once the challenge path ships) |
| L1 | `attested` | An authorized court signed a report the node checked against the rules | no |
| L0 | `host` | One node's word | no |

## New report fields (attested titles) — safe to send TODAY

They live inside `report`, so the court already signs them (`attest` tag over
`{ matchId, rulesetId, report }`) and the node already commits them (an attested
delta's `finalStateRoot = H('attested', { rulesetId, report })`). v3 nodes ignore
them; v4 nodes lift them into first-class delta fields.

```jsonc
"report": {
  // ...the title's existing fields...
  "commitments": {
    "logFormat":    "arc-runlog@1",   // the title's own log format name + version
    "inputsHash":   "<64 hex>",       // sha256 of the EXACT log bytes (not re-serialized), or null if no log exists
    "finalHash":    "<string ≤128>",  // the title's own end-state / replay hash, or null
    "verifierHash": "<64 hex>"        // sha256('verifier' NUL tar) of the headless verifier bundle, or null until registered
  },
  "stats": {                          // per participant id, non-negative INTEGERS only, ≤32 names, names [a-zA-Z][a-zA-Z0-9]{0,31}
    "<participant id>": { "rescued": 41, "bestChain": 7 }
  }
}
```

## New envelope field — send ONLY when the node says `protocol >= 4`

`"log": "<base64 of the exact log bytes>"` (≤ 512 KiB decoded), at the top level
of the attested envelope, next to `report` and `attestor`. The node checks
`sha256(decoded) === report.commitments.inputsHash`, stores it content-addressed,
serves `GET /log/<inputsHash>`, and witnesses fetch and hold it. Check `GET /health`
(the `protocol` field) before including it; a v3 node may refuse unknown shapes.

## Stats schema (title manifest)

`services.stats` gains a `schema` alongside the existing `track`:

```js
services: { stats: { track: ['matches', 'wins', 'ticks'], schema: { rescued: 'sum', bestChain: 'max', fastestKo: 'min' } } }
```

Ops: `sum | max | min | last`. Replayable titles export `stats(state, participants)`
(computed in the sandbox, so witnesses recompute it). Attested titles export
`stats(report, participants)`, which normally just filters `report.stats` to the
schema. Per-match stats go into the result commitment. Per-player folds go into an
hourly stats root alongside the results root in EpochAnchor, so any contract can
check "player X has N" with a Merkle proof.

## Identity

A participant is the player's ed25519 key (64 hex) whenever the game runs inside
the arcade (`cabinet:init` / the join ticket's `sub`, signing via `cabinet:sign`),
bound to a wallet or AIR account by `PlayerProfile`. A prefixed id (`pb:`, `fc:`,
`afc:`) remains allowed for casual play only. It never binds to a profile or counts
for rewards. Ranked requires keys.

## Court keys

A title's court keys go in its adapter manifest's `attestors` (ed25519 pubkey hex).
That array is pinned by the ruleset hash registered on TitleRegistry, so every node
accepts the court with no per-operator `COURTS` entry. `COURTS` stays as an
operator override. Court private keys live only in the studio's managed env
(Vercel/Railway/secret store) and are never copied between machines.

## What goes on LitVM

- **TitleRegistry:** ruleset hash (with `attestors`), server bundle, verifier bundle.
- **PlayerProfile:** key ↔ wallet/AIR.
- **MatchBook:** commit → settle → attest×3 → finalize, for RANKED L3 matches only.
- **NodeStake:** disputes and slashing.
- **EpochAnchor (hourly):** one root over every finalized result of every level, plus the stats root.

Never on-chain: logs, per-match mints, studio economies (credits, pickles,
scrap/silver, crates).

## Shared helper

`sdk/court` in strodanodev/litnode (extracted from FLOOD CONTROL's
`scripts/arc/board/litnode.ts`) provides `signReport`, `inputsHash`,
`findSettler` (NodeDirectory + NodeStake discovery from the arcade's
`/contracts.json`), and `settle` with retries and 429 handling. Studios use it
instead of copying signing code.

## Rules for every session

- Commit locally. Do not push, deploy, release, register on TitleRegistry or send
  any chain transaction without the user's explicit go-ahead; those are user
  steps.
- Secrets stay in managed env. Never print or copy `.env` / key files.
- A consensus-relevant change (sim, adapter, validator, stat derivation) means a
  new build or ruleset hash. Old results are never relabelled.
- End with a short hand-back report for the LITNODE session: what you changed,
  the field values you emit, open questions.
