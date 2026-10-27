# Prompt 5 — FLOOD CONTROL ("The Arc"): settlement v4, attested → L2 checkable

You are in the FLOOD CONTROL repository at `E:\NPC\06 AERIS GAME\bagyogame`
(bagyo.app, Vercel project `the-arc`; the core class is `ArcGame`). The litnode
node software is at `E:\NPC\AGENT 24 NODE` (strodanodev/litnode). Read it for
reference, but **don't edit it**: litnode-side changes go in your hand-back, and
your ruleset PR is strodanodev/litnode#1. The shared contract is at the end of
this prompt.

## Context

FLOOD CONTROL is live on the mesh as an **L1 `attested`**, casual,
single-seat title, and already does more than L1 credits.
- **The flow:** the board (a Vercel function) runs `scripts/arc/board/handler.ts`:
  `checkSubmission` → `replayDaily` (a headless `ArcGame` run of the
  `{hour, cmd}` RunLog, 66–136 s) → `judge` → store → `FloodReport` →
  `settleRun`.
- **The court:** `scripts/arc/board/litnode.ts` signs and posts `/ledger`,
  finding a node automatically through NodeDirectory + NodeStake
  (`LITNODE_URL=auto`).
- **Identity:** `fc:<random localStorage id>`, with no accounts.
- **Stats:** the Neon `daily_entries` table holds rich stats, but the node
  folds only matches, wins and ticks.
- **Known pain:** litVM RPC 429s show up in `settle_status`.

Because your court only signs **after a replay**, you are one step from
**L2 `checkable`**: commit the log, and register the verifier.

## Goals, in order

1. **Commitments** in the `FloodReport`:
   - `logFormat: 'arc-runlog@1'`;
   - `inputsHash` = sha256 of the exact stored command-log bytes. This may
     differ from the existing commands digest, which `checkSubmission` computes.
     Define it as the bytes you will ship, and document it.
   - `finalHash` = a hash of the judged replay result;
   - `verifierHash` = null until goal 3.
   - Attach `log` (base64) only when the node reports `protocol >= 4`. Keep it
     under 512 KiB; measure a long run.
2. **Stats.**
   - Add `report.stats` for the single seat, with the run's integers:
     `points` (max), `stars` (sum), `rescued` (sum), `casualties` (sum),
     `bestChain` (max), `keptDry` (sum), `stormsSurvived` (sum, 0/1).
   - Update `docs/litnode/flood-control.adapter.js` with
     `services.stats.schema`, `stats(report, participants)`, and
     `attestors: [<court pubkey f82a5ef3…>]`, so nodes no longer need
     `COURTS`.
   - This changes the ruleset hash. Coordinate with PR #1 by noting it in the
     hand-back: update the PR branch, or file a follow-up.
3. **The verifier bundle.**
   - Package the headless replay (`verify.ts`, `ArcGame` and `src/sim`, the
     baked level data for the daily maps, forced onto the sync flood link) as one
     deterministic esbuild bundle and tar, with entry
     `verify(logBytes, spec) → {finalHash, result}`.
   - Make sure no `Date.now`/`performance.now` value can reach the judged
     result.
   - Print `sha256('verifier' NUL tar)` and a size.
   - Registering it on TitleRegistry is a user step, and it is what makes runs
     `checkable`.
4. **Identity.** When launched inside the arcade (`cabinet:init`), use the
   arcade's ed25519 player key as the participant. Otherwise keep `fc:<id>`,
   casual-only.
5. **Move to `sdk/court` when it lands.** Your `litnode.ts` is the template
   litnode extracts into `sdk/court`. Note in the hand-back anything in it that
   should be generalized, including 429 backoff and the RPC fallback list. Once
   the package exists, replace your copy with it.

## Ground rules

- Determinism first. Replay a stored daily before and after every change, and
  check the judged results are byte-identical.
- Commit locally. **Don't** push, deploy to Vercel, register, or send
  transactions. List the user steps.
- Secrets stay in managed env (`COURT_IDENTITY`, `DATABASE_URL` and the rest).
  Never open or print `.env.local`, and never copy key files between machines.
- If this repo has a `graphify-out/graph.json`, query it before grepping.

## Hand-back

Write `docs/litnode/V4-HANDBACK.md` and print it. It covers:
- an example report with commitments and stats;
- the log byte format and sizes;
- the verifier bundle hash, size and rebuild command;
- the adapter diff;
- the PR #1 plan;
- the `sdk/court` generalization notes;
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
