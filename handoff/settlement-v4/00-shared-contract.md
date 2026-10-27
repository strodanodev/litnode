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
