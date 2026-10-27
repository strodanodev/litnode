# Prompt 4 — AFC (Robot Fighting Championship): join litnode at L2, plan L3

You are in the AFC repository at `E:\NPC\AGENT 21\AFC` (pnpm monorepo:
`packages/core` sim, `packages/server`, `packages/meta`, `packages/agent`,
`supabase/`). The litnode node software is at `E:\NPC\AGENT 24 NODE`
(strodanodev/litnode). Read it for reference, especially:
- `titles/title.js`;
- `titles/pickle-brawl.adapter.js` and `titles/flood-control.adapter.js`, which
  are attested examples;
- `docs/BRING-YOUR-BACKEND.md` and `docs/SETTLEMENT-STANDARD.md`;
- `node/settle.js`, the attested intake.

FLOOD CONTROL's working court client is
`E:\NPC\06 AERIS GAME\bagyogame\scripts\arc\board\litnode.ts`. **Don't edit
either repo.** Litnode-side files go in your hand-back. The shared contract is
at the end of this prompt.

## Context

AFC isn't on the mesh at all. The arcade lists it with no ruleset. It is closer
to fitting than it looks:
- **Deterministic sim:** `packages/core/src/sim.ts`, at 30 Hz with 3 rounds of
  1350 ticks. It uses an sfc32 PRNG (`prng.ts`) and Rapier
  `@dimforge/rapier3d-deterministic-compat` pinned at 0.20.0. A
  `StreamHash` produces a 16-hex `finalHash`.
- **Replay verification:** `verifyMatchFile` (`replay.ts`) and the
  `hmc verify --runs N` CLI.
- **The host signs:** `hmc-attestation@1` (ed25519) over canonical JSON
  (`packages/server/src/attest.ts`). The match file is
  `hmc-match@2`: seed, robots, pilots, loadouts, sparse commands, result and
  finalHash.
- **The server replays before paying:** `/replay` checks that the bot's
  commands are genuine, then attests and pays credits in Supabase.
- **Identity:** AIR Kit (Moca) smart account, in `profiles.smart_account` /
  `air_sub`.
- **Gear changes outcomes:** `applyEquipMods` applies up to ±10% per stat, and
  the server checks ownership.
- **Play:** effectively 1P against a deterministic bot. `MatchHost` (a WS, 30 Hz,
  two-seat host) exists, but real player-versus-player play isn't finished.
- **No chain code.** `docs/loop-integration.md` plans an epoch Merkle root of
  finalHashes. Litnode's EpochAnchor already does exactly that, so converge on it
  rather than building a second anchor.

The ed25519 host key is already the kind of key a litnode court uses. That makes
AFC an attested title with real replay behind it, which is **L2 `checkable`**.

## Goals, in order

1. **Adapter `afc.v1`** (hand-back file, `titles/afc.adapter.js` for litnode).
   - Use `defineAttestedTitle`: `modes ['casual']` for now, `participants [1]`
     or `[1, 2]` as decided, `teams`.
   - `validate(report)`:
     - winner ∈ {0, 1, null} and a known `reason`;
     - rounds ≤ 3;
     - ticks ≤ 3×1350 plus breaks;
     - hp bounds;
     - stats are integers;
     - a `commitments` shape check.
   - `scores()`, `stats()` and the stat schema. Suggestions: `kos`,
     `roundsWon`, `damageDealt` (sum), `maxCombo` (max), `parries`,
     `fastestKoTicks` (min).
   - `attestors: [<court pubkey>]`.
   - Make it pass litnode's `npm run conformance` from a scratch copy, without
     editing the litnode repo.
2. **A bridge from `hmc-attestation@1` to the litnode attested envelope**, in
   `packages/server`.
   - After `/replay` accepts a match, build `{kind: 'attested', matchId,
     rulesetId: 'afc.v1', mode: 'casual', participants, teams, report,
     attestor}`.
   - Sign with the `attest` tag over `{matchId, rulesetId, report}` (port
     FLOOD CONTROL's `signBody` exactly, or use litnode `sdk/court` once it
     exists).
   - Find a settler (`LITNODE_URL=auto` through NodeDirectory + NodeStake) and
     `POST /ledger`.
   - Store a `settle_status` per match in Supabase. Never block the player
     payout on the node.
   - Feature flag: `LITNODE_ENABLED`.
3. **Commitments:**
   - `logFormat: 'hmc-match@2'`;
   - `inputsHash` = sha256 of the exact stored match-file bytes;
   - `finalHash` = StreamHash `finalHash`;
   - `verifierHash` = null until goal 4.
   - Attach the `log` only when the node reports `protocol >= 4`.
4. **The verifier bundle.** Package `hmc verify` (core sim plus Rapier WASM)
   as one deterministic esbuild bundle and tar, entry `verify(matchBytes) →
   {finalHash, result}`, and print its `sha256('verifier' NUL tar)`.
   Registering it is a user step, and it is what upgrades AFC to `checkable`.
5. **Identity.** Inside the arcade, use the arcade's ed25519 player key as the
   participant: it is bound to the AIR account through `PlayerProfile`, and the
   arcade lends AIR to first-party titles. Outside the arcade, use
   `afc:<air_sub>`, casual-only. Add the arcade frame handshake (`cabinet:init`)
   if the client lacks it.
6. **Gear.** Include a `loadoutHash` per seat in the report (a hash of the
   resolved RobotDoc after equipment mods), so the committed result names the
   gear that produced it. Ranked sterility rules come later.
7. **An L3 scoping doc only** (`docs/LITNODE-L3.md`, no code). Cover:
   - Rapier: replace it with a pure-JS or fixed-point solver, or allow WASM in
     the litnode sandbox.
   - A synchronous `Match.create`.
   - Dense per-tick input logs.
   - Player-signed ledger heads, which need real PvP: two-party signatures mean
     nothing against a bot.
   - The buildHash discipline.

## Ground rules

- Determinism first: run the cross-architecture fixture
  (`attestations/m0-acceptance.json`) and `hmc verify --runs 100` before and
  after changes.
- Commit locally. **Don't** push, deploy (Vercel/Railway), run migrations
  against remote Supabase, register, or send transactions. List the user steps.
- Secrets stay in managed env. Never open, print or copy `.env`. A new court key
  is generated into the managed env, or the existing host key is reused there.
- If this repo has a `graphify-out/graph.json`, query it before grepping.

## Hand-back

Write `docs/LITNODE-V4-HANDBACK.md` and print it. It covers:
- the adapter file contents;
- an example envelope;
- the court pubkey;
- the verifier bundle hash and how to rebuild it;
- the env var names;
- the cabinet roster entry to add (`rulesetId`, `login: 'arcade'`);
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
