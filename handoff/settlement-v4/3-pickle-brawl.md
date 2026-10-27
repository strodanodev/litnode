# Prompt 3 — Pickle Brawl: settlement v4 (player keys, stats, path from L1 to L2)

You are in the Pickle Brawl repository at `E:\NPC\PICKLEBRAWLv2\PickleBrawl`.
The game runs on the Genesys engine with three.js. Its authoritative court
process is in `services/court`. The litnode node software is at
`E:\NPC\AGENT 24 NODE` (strodanodev/litnode). Another session works there: read
its files for reference, but **don't edit them**. Anything that belongs in
litnode goes in your hand-back. The shared contract is at the end of this
prompt.

## Context

Pickle Brawl is an **L1 `attested`** title, the weakest proof level of the four.
- The court signs an outcome report at GameEnd.
- The node checks the signature and the rulebook in litnode's
  `titles/pickle-brawl.adapter.js`: to 11, win by two, `winnerTeam` null for
  abandoned games, 2 or 4 seats.
- Nobody can recompute the match. The physics is floating-point (drag plus
  Magnus), the 60 Hz clock catches up, state is engine-replicated rather than an
  input log, and the game mode uses `Math.random`.
- No Pickle Brawl match has reached MatchBook. Results never count as official.

Two known gaps:
1. Matchmaker-formed matches report seats as `pb:<AIR sub>`, so they can't bind
   to a player profile. Arcade-placed matches already carry the player key, as
   the join ticket's `sub`.
2. The court key is provisioned per operator and listed in each node's
   `COURTS`. The `pb-standby-kit` exists for the standby host.

## Goals

1. **Player keys in every report.** Carry the arcade player key from the join
   ticket or AIR universal-login session through the matchmaker into the
   court's `claims` and the envelope's `participants`. Keep `pb:<sub>` only
   when no key exists, and only for casual play.
2. **Stats.**
   - Add `report.stats` with integer per-player stats the court observes.
     Suggestions: `pointsWon`, `aces`, `winners`, `unforcedErrors`, `smashes`,
     `dinks`, `longestRally` (max), `matchesMvp`.
   - Propose the stat schema with ops for the litnode adapter.
3. **Commitments, honestly.**
   - Add `report.commitments`, with `logFormat` and `inputsHash` set to null
     for now. There is no log, and pretending otherwise would make a witness a
     liar.
   - Fill `finalHash` only if the court has a stable end-state hash.
4. **A plan to reach L2 `checkable`.** Design it and build what is cheap.
   - Phase A: an input ledger of player intents per combat frame, recorded by
     the court, with its `inputsHash` committed.
   - Phase B: replace `Math.random` in the game mode with a seeded PRNG keyed by
     matchId.
   - Phase C: a headless replay of the court's sim pinned to the engine build,
     which reproduces the outcome from the ledger. That replay becomes the
     verifier bundle (`verifierHash`). The 9 Oct spike found the engine
     bit-exact across Node versions, so check that this still holds.
   - Estimate each phase. Build Phase A and Phase B if they are contained.
5. **Court keys in the adapter.** Put the court pubkey(s) in the adapter's
   `attestors` (a hand-back patch for litnode), so every node accepts them with
   no `COURTS` entry. Keep the private key in managed env only.
6. **Use `sdk/court` when it lands** (litnode's extraction of FLOOD CONTROL's
   court client). Until then, keep the current submit path, but make it send
   the new report fields.

## Ground rules

- Release coordination: this repo's session has cut litnode releases before.
  **Don't** cut, push or publish a litnode or game release, deploy, or send
  transactions. Commit locally and list the user steps.
- Secrets stay in managed env. Never print or copy `.env` or key files between
  machines.
- If this repo has a `graphify-out/graph.json`, query it before grepping.

## Hand-back

Write `docs/LITNODE-V4-HANDBACK.md` and print it. It covers:
- the report fields now emitted, with an example report;
- the identity change and its test;
- the stat names and ops;
- the adapter patch (stats schema, `stats()`, `attestors`);
- the L2 phase plan with estimates and what was built;
- user steps;
- questions for the LITNODE session.

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
