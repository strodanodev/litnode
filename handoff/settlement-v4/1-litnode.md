# Prompt 1 — LITNODE: settlement v4 (proof levels), on top of the 21 Oct audit

You are in the litnode checkout at `E:\NPC\AGENT 24 NODE` (origin
strodanodev/litnode, branch master). Goal: make litnode a composable settlement
and stats backend that any title plugs into. Four titles share one pipeline with
graded proof levels, defined in the shared contract at the end of this prompt.
You own the canonical version of that contract.

## Ground rules

- **graphify:** `graphify-out/graph.json` exists. Run `graphify query "<question>"`
  before your first grep or source read, use `graphify path` / `graphify explain`
  for relationships, and run `graphify update .` after code changes. Put this
  rule in every subagent prompt that explores code.
- **Shared checkout:** other sessions (Codex agents, the Pickle Brawl session)
  sometimes edit this checkout. Run `git status` and `git log -5` first, and
  never revert work you didn't make. Their failing tests aren't yours to "fix"
  by deleting.
- Commit locally in logical commits. **Do not** push, cut or publish a release,
  register on TitleRegistry/ReleaseRegistry, deploy the arcade, or send any
  chain transaction. Those are user steps: list them at the end with exact
  commands.
- Secrets stay in managed env. Never read or print `.env` or key files.

## Where things stand (verify, don't trust)

- **The 21 Oct audit:** `audit/audit-2026-10-21.md` and the atlas
  `audit/atlas-2026-10-21.html`.
  - 0.11.30 (commit 4840ffe) closes the six high findings in §4.1 and §4.3.
    It is committed but not pushed or released.
  - Still open: §4.4 (zips missing `tools/lib/rpc.mjs` and scripts the package
    names; the scheduled task runs `-RunLevel Highest`), §4.2 (the gen-4
    contract fixes), §4.5 (hermetic tests), §4.6 (stale docs), and the
    mediums in §4.1.
  - Read §7 for the recommended order.
- **graphify artifacts are untracked:** `CLAUDE.md`, `.claude/CLAUDE.md`,
  `.claude/settings.json` (PreToolUse hook), `.claude/skills/graphify/`,
  `.graphifyignore`, `graphify-out/`. Ask the user before committing them.
- **Settlement today** (`docs/SETTLEMENT-STANDARD.md` is the current standard):
  - `node/settle.js` takes two envelopes, replayable and attested.
  - `protocol/result.js` holds `resultFields`, `verification` and `isOfficial`.
  - `protocol/derive.js` applies a fixed stat line of
    `{matches, wins, ticks}` (around line 51).
  - `titles/title.js` defines `defineTitle` / `defineAttestedTitle`. The
    manifest already has `attestors`; check whether `settle.js` actually honors
    them without `COURTS`.
- **The titles today:**
  - **Agent Fighter:** replayable, `players`, full MatchBook cycle, two ranked
    finals. It has three intakes: relay with af-watch, the gauntlet server, and
    import.
  - **Pickle Brawl:** attested, `pb:<AIR sub>` seats for matchmaker-formed
    matches, never reached MatchBook.
  - **FLOOD CONTROL / "The Arc"** (`E:\NPC\06 AERIS GAME\bagyogame`): attested,
    casual, single-seat `fc:<id>`.
    - The game's Vercel board replays every run headlessly before its court
      signs (`scripts/arc/board/verify.ts`).
    - The court client is `scripts/arc/board/litnode.ts`: signing, envelope,
      `LITNODE_URL=auto` discovery through NodeDirectory + NodeStake, settle.
    - Its ruleset PR (strodanodev/litnode#1) awaits review.
  - **AFC / Robot Fighting Championship** (`E:\NPC\AGENT 21\AFC`): not on the
    mesh.
    - Deterministic sim with sfc32 PRNG and Rapier WASM physics.
    - The host signs `hmc-attestation@1` (ed25519) after replaying.
    - The cabinet lists it as live with no ruleset, which audit §4.3.3 flags.

## Work, in order

### 1. Settle 0.11.30 and the cheap audit items first
- Confirm 0.11.30 is green: run the `hardening` test and the full `npm test`
  in the background.
- Fix §4.4.1: derive `tools/pack.mjs`'s copy list from the scripts map, and add
  a test that resolves every script in a staged zip.
- Fix §4.4.2: drop `-RunLevel Highest`.
- Fix §4.5: clear the update timer in `stop()`, set `LITNODE_NO_UPDATE` in the
  harness, list `beacon` and `air` in `npm test`, assert the selector, scaffold
  into a tmpdir, and use disjoint port ranges.
- Ship this as **0.11.31**, a patch with no protocol change.

### 2. Protocol v4: proof levels, per the contract
- `protocol/version.js` 3 → 4. Add a CHANGELOG entry.
  - Plan the rollout: every node refuses peers on another version, so state the
    upgrade path in the CHANGELOG and docs/OPERATORS.md.
  - Attested courts sending v3-shaped reports must keep settling, at
    `attested`.
- **Commitments:**
  - Lift `report.commitments` and `report.stats` into delta fields.
  - Add `proof` (`verified | checkable | attested | host`) and `stats` to
    `resultFields`. `proof` must be derived from what the node can check, never
    taken from the submitter.
- **Log intake:**
  - Accept the optional envelope `log` (base64, ≤ 512 KiB) and check its
    sha256 against `inputsHash`.
  - Store it at `<dataDir>/logs/<hash>` and serve `GET /log/<hash>`.
  - Witnesses fetch and hold it. Prune with the same policy as ledgers.
  - Respect the 0.11.30 budgets (`readText` cap, unsigned-ledger budget).
- **Verifier bundles:**
  - A third bundle kind beside ruleset and server:
    `verifierHash = sha256('verifier' NUL tar)`.
  - Registered with the existing TitleRegistry `setBuild`, so no contract
    change. Reuse `node/server-bundle.js`.
  - In v4 the node only checks that the hash is registered and active, which
    is what grants `checkable`. **It does not run it yet.**
  - Running it on challenge in the escalation panel, outside the sandbox
    budget, is phase 2: write the design in the standard, not the code.
- **Stats:**
  - `services.stats.schema` with ops `sum | max | min | last`.
  - Replayable titles export `stats(state, participants)`, run in the sandbox.
    Attested titles export `stats(report, participants)`.
  - `derive.js` and `progression.js` fold per schema. Bump `DERIVE_VERSION`.
  - Hourly stats root per title: `H(resultsRoot, statsRoot)` under the existing
    EpochAnchor root. Add a Merkle-proof endpoint (`GET /proof/stats?...`).
  - Change EpochAnchor only if unavoidable, and fold that into gen-4 below.
- **Court keys:** make the manifest `attestors` sufficient on every node, with
  `COURTS` as an override. Test it.
- **`isOfficial`:** unchanged, `verified` only.

### 3. `sdk/court`
- Extract it from FLOOD CONTROL's `scripts/arc/board/litnode.ts`: `signReport`,
  `inputsHash`, `findSettler` (fresh, bonded, has the ruleset, `settler` role,
  RPC fallback and 429 backoff), `settle`, and v4 log attachment gated on
  `/health.protocol >= 4`.
- Plain ESM, zero dependencies, usable from TypeScript (add `.d.ts`), with a
  test.
- Wire `npm run bridge` to use it.

### 4. Titles in this repo
- **FLOOD CONTROL:** review PR #1, and adopt `stats.schema` and `attestors`
  (coordinate with the FLOOD CONTROL session's hand-back).
- **AFC:** the AFC session will hand back an adapter `titles/afc.adapter.js`
  (`afc.v1`, attested). Review it, bundle it, and add the cabinet roster
  entry with `rulesetId`.
- **Pickle Brawl:** add the stat schema and `attestors`.
- **Agent Fighter:** add `stats(state)` once the AF session reports which state
  fields hold the counters.
- **Cabinet:**
  - Show a proof-level badge per title and per match.
  - Remove the hard-coded "settled by" text keyed by title id (audit §4.3.3).
  - Stop calling a title live on litVM when it has no ruleset.
  - Run `tools/vendor-cabinet.mjs --check`.

### 5. Gen-4 contracts (code and tests only, no deploy)
- The audit §7.3 fixes: key proof-of-possession on `NodeStake.stake`,
  `minStake` to announce with paginated `NodeDirectory.keys`, `epoch < now` in
  `EpochAnchor.propose`, a bounded enrol pool, and an `Escalated` branch in
  `expire`.
- Anything v4 strictly needs.
- Add `contracts/MIGRATION.md` notes. Deploy is a user step.

### 6. Skills, harnesses, docs: make every step run as written
- **Skills** (`.claude/skills/` and the gitignored byte-identical
  `.agents/skills/` copy): add a sync step or script so the copy can't drift.
  - `build-a-title`: replayable path, the `stats(state)` export, proof levels.
  - `host-a-title`: split it from build-a-title by whether a client exists, and
    state that discriminator in both frontmatters.
  - `migrate-a-title`: the attested/L2 path, `sdk/court`, commitments, log,
    verifier bundle, `attestors`, the identity rule.
  - `host-a-node`: v4 upgrade, the `/log` storage footprint,
    `--gauntlet-servers`, `OPERATOR_KEY`.
  - Fix every audit §4.4 step that doesn't run: `conformance` / `bundle:title`
    with no file, `settle()` never returning `already`, `npm run bond` args,
    `NodeStake.delegateOf`, doctor's cloudflared check.
  - **Dry-run each skill in a scratch install.**
- **Harnesses:**
  - `npm run host`: `doctor` / `next --json` report the v4 capability, log
    storage, and verifier and server opt-ins.
  - `npm run conformance`: checks the stat schema and `stats()` purity, and
    attested adapters with commitments.
  - `npm run bridge`: uses `sdk/court`.
  - Add `npm run bundle:verifier`.
- **Docs:** update SETTLEMENT-STANDARD (the canonical v4 contract),
  BRING-YOUR-BACKEND, SDK, PUBLISHERS and OPERATORS. Mark the historical docs
  as historical (audit §4.6).
- Run `graphify update .` at the end.

## Done means
- `npm test` is green, with new suites for log intake, proof derivation, stat
  folds and roots, `sdk/court`, and attestors-without-COURTS.
- 0.11.31 and the v4 release candidate are committed locally.
- Skills are dry-run.
- A final report covers:
  - what changed;
  - the exact v4 field names, with any deviation from the contract called out
    so the title sessions can follow;
  - the user steps in order (push, release, registry, set-build for verifier
    bundles, arcade deploy, gen-4 deploy);
  - what remains from the audit.

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
