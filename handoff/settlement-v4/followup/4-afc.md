# Follow-up: AFC's court moves to Vercel (afc.v1 on litnode)

You are in the AFC repository at `E:\NPC\AGENT 21\AFC` (notsedano/afc, branch `cel-rebuild`). litnode is at
`E:\NPC\AGENT 24 NODE` (strodanodev/litnode). Read it for reference, but don't edit it. AFC's litnode side
(adapter, roster, tests) is prepared there on branch `afc-v4`, in the worktree `.claude/worktrees/afc-v4`.

## Decisions already made by the user (24 Oct 2026)

- **Railway is deprecated** everywhere. Nothing new goes there, and the Railway `match-host` and `agent-ws`
  services are on their way out.
- **AFC's court runs as a Vercel function**, the same pattern as FLOOD CONTROL's board. It re-simulates the bout,
  pays it, and signs the afc.v1 report.
- **The court key is a new, dedicated key**, kept in Vercel env as `LITNODE_COURT_IDENTITY`. It is not the host's
  hmc-attestation key. The user creates it and sends its public half to the litnode session, which pins it in
  `attestors`.
- **The stack split:** litnode does multiplayer, matchmaking, resolution and per-match stats that witnesses can
  recompute. The database does inventory, credits and the studio's own stats. Nothing economic goes through the node.

## Work already in flight in this checkout: build on it, don't undo it

The main checkout holds an **uncommitted move from Supabase to Neon**. `store.ts` uses the `postgres` driver over
`DATABASE_URL` with `prepare: false` for Neon's pooled endpoint. The migrations moved to `db/migrations/`, and
`docs/deploy.md` and `.env.example` changed with them. Someone else wrote it. Before you start, make sure it is
committed, or work on top of it; never revert it. Its `docs/deploy.md` still lists Railway for `@hmc/server`; this
plan replaces that row.

## What litnode already has for AFC (branch `afc-v4`, not merged yet)

- **Committed on `afc-v4` as `9a7f2a0`** (not merged into master, not pushed; npm test 269/269).
- `titles/afc.adapter.js`: your hand-back adapter, unchanged apart from `attestors`, which pins the court key
  **`040bc3d9de3530ae955f410b4c78bc503ca3644ab50278ea376523238ae6c5b5`**. The user created it straight into the
  `afc` Vercel project's env as `LITNODE_COURT_IDENTITY` (24 Oct). Ruleset build **`6371d0f6…42fc`**.
- **Verifier repacked: `14336181ea31a16330c6b85b3495e92470665868846e31a9a690a569fddce8e9`.**
  - Packed from this repo at `4dc1f8b` with litnode's current `tools/bundle-server.mjs --kind verifier`.
  - Byte-identical from two working directories.
  - On a real bout it reproduces `finalHash` `3be840b329ceb32a` and refuses a one-bit change.
  - Since litnode `7b752dd` the commit is no longer inside the hashed manifest, which is why your `c7d885c3…` no
    longer reproduces.
  - Repack it here to commit the sidecar:
    `node "E:/NPC/AGENT 24 NODE/tools/bundle-server.mjs" docs/litnode/afc.verifier.json --kind verifier --root . --out verifiers`
- On litnode test nodes, the real bout settles `checkable` with that verifier and `attested` without it, and `/log`
  serves the exact match file.

## The plan

### 1. One Vercel function for the HTTP API

`handleApi` (`packages/server/src/api.ts`) is already a plain Node `(req, res)` handler, so a Vercel Node function
can call it unchanged.

- **Function:** add `api/hmc.ts`. It builds the deps once at module scope (warm instances reuse them):
  `playerAuthFromEnv()`, `matchStoreFromEnv()` with `max: 1`, the host keypair from env, `hostName`, and the litnode
  bridge. On each request it calls `handleApi(req, res, deps)`.
- **Routes:** in `vercel.json`, rewrite `/replay`, `/me`, `/inventory`, `/buy` and `/crate` to `/api/hmc`. The API
  then lives on the client's own origin.
- **Client:** set `VITE_MATCH_HOST_URL` to empty. `session.ts` then calls `/replay` and the other routes on its own
  origin, and CORS stops mattering.
- **Function config:** Node 22, 1024 MB, `maxDuration: 60`. A replay is short: the packed verifier took 0.16 s cold
  and 0.06 s warm for a 1,151-tick bout on this machine. `attestReplay` also re-runs both pilots, so allow a few
  times that. Rapier's WebAssembly is inlined by the compat build, so nothing else needs to be loaded at run time.
- **No local files:** drop `outDir` (the signed-replay mirror) on Vercel; the filesystem there is read-only. The
  attestation is durable in Neon.

### 2. Keys and secrets, all in Vercel env (production)

| Variable | What | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon's **pooled** connection string | from the Vercel → Neon integration |
| `HMC_HOST_KEY` | the hmc-attestation host key, `{"privateKey","publicKey"}` base64 DER | new; replaces the Railway volume file `/keys/host-key.json` |
| `HMC_HOST_NAME` | the signed `host` attribution | e.g. `afc.vercel`; it is inside every signed envelope, so make it true |
| `LITNODE_ENABLED` | `1` | |
| `LITNODE_COURT_IDENTITY` | the dedicated court key, `{"publicKey","privateKey"}` 64 hex each | the user creates it; never the host key |
| `LITNODE_VERIFIER_HASH` | `14336181…` | set only once it is registered on TitleRegistry |
| `HMC_REQUIRE_AUTH`, `AIR_PARTNER_ID`, `AIR_PARTNER_IDS` | as today | add the arcade's partner to `AIR_PARTNER_IDS` |
| `AIR_PARTNER_KEY_JSON` | the Partner JWT key, as JSON content | only if the host issues AIR credentials; see below |

- **A new host key is safe.** Every stored attestation carries its own `publicKey`, and nothing in this repo pins the
  host key: `verifySignature` is called without an expected key. Old matches therefore keep verifying. The "orphans"
  warning in `cli.ts` was about a key silently changing under a running host, not a deliberate move. Minting the new
  key straight into Vercel env means no private key is copied off Railway.
- **Read the host key from env.** Add a loader for `HMC_HOST_KEY`, validated with `hostKeypairSchema`, beside
  `loadOrCreateKeypair`. Refuse to start without it; never mint one inside a function.
- **The Partner JWT key and its JWKS** need the same treatment if the host issues AIR credentials. Add an env-content
  variant of `partnerKeyFromEnv`, serve `/.well-known/jwks.json` from the function, and update the JWKS URL in the
  AIR dashboard, because the old one points at the Railway host. If the host issues no credentials today, leave this
  out and say so.

### 3. Settlement: queue in the database first, post after answering

On Vercel, work started after the response may be cut off, and `setTimeout` retries never fire. So:

- **Split `LitnodeBridge.submit`** into `enqueue(job)` and `drain(matchId)`.
  - `enqueue` builds the envelope and inserts the `pending` row in `match_settlements`.
  - `drain` posts one queued row and records the outcome.
- **In `/replay`:** `await enqueue(...)` after `record_match` and before responding, then
  `waitUntil(bridge.drain(matchId))` (`@vercel/functions`). The row exists before the player gets an answer, so
  nothing is ever lost.
- **Remove `retryLater`'s timers** on Vercel; keep them for a long-lived process if you want.
- **A Vercel Cron**, e.g. `/api/litnode-drain` every 5 minutes, protected by `CRON_SECRET`, runs
  `bridge.retryPending(50)`. One invocation drains a batch, so node discovery runs once per batch, not once per
  bout. That avoids the litVM 429s FLOOD CONTROL hit.
  - Check the team's Vercel plan. Hobby runs crons at most once a day; then rely on `waitUntil` plus the daily
    sweep, and say so.
- **Never in the payout path.** The player is paid by `record_match` exactly as today, and settlement only changes
  `match_settlements`.

### 4. Re-vendor `sdk/court` from litnode `9076bc5` or later

The vendored copy (`packages/server/src/vendor/litnode-court.ts`) is from `84c6fb0`. The newer one adds:

- a remembered settler with fall-through (`cacheMs`, `fallbacks`);
- `oversizeLog: 'skip'`;
- `rpcFallback` from the arcade's `contracts.json`;
- an optional `descriptor` in `envelope()` / `attest()`.

Keep the `// @ts-nocheck` header, and record the commit and sha256s the way Pickle Brawl's `VENDORED.md` does.

### 5. What does not move to Vercel

- **`MatchHost`** (`host.ts`, the 30 Hz WebSocket two-seat host) and **`agent-ws`** cannot run on Vercel.
  - 1P bouts against the house bot don't need them: `/replay` is HTTP.
  - When PvP is real, the match host belongs on litnode as a server bundle, the way Agent Fighter's gauntlet server
    ships. That is the stack's multiplayer half, and it is also AFC's path to L3 (`docs/LITNODE-L3.md`).
  - Until then, deploy neither. Write down what stops when Railway is switched off: agent-ws users and any client
    path that opens the WebSocket.
- **Inventory, credits, crates and gear** stay in Neon, behind the same routes.

### 6. Tests

- **The function:** fake request and response objects drive `api/hmc.ts`. `/replay` answers 200 and the
  `match_settlements` row exists **before** the response is sent. A missing `HMC_HOST_KEY` refuses to start.
- **The bridge:** `enqueue` is idempotent per `matchId`; `drain` on an already settled row does nothing; a node that
  is unreachable leaves the row `unreachable` for the cron.
- **The cron route** refuses a request without `CRON_SECRET`.
- **Determinism:** before and after, `attestations/m0-acceptance.json` 100/100 → `bd07d270d99e1e75` and
  `hmc verify --runs 100` → `3a2d714e658daaf3`. The sim must not change; a change means a new verifier hash.

## User steps (list them; don't do them)

1. ~~Create the court key in Vercel env~~ **Done 24 Oct** (`040bc3d9…c5b5`, pinned in `6371d0f6`). For reference, in the linked AFC folder
   (`.vercel` → project `afc`), this prints only the public key; the JSON goes straight to Vercel:
   `node -e "const k=require('crypto').generateKeyPairSync('ed25519').privateKey.export({format:'jwk'});const h=(s)=>Buffer.from(s,'base64url').toString('hex');console.error('court public key:',h(k.x));process.stdout.write(JSON.stringify({publicKey:h(k.x),privateKey:h(k.d)}))" | vercel env add LITNODE_COURT_IDENTITY production`
2. Create `HMC_HOST_KEY` the same way: a new hmc-attestation key generated straight into Vercel env.
3. Apply the migrations to Neon (`pnpm db:migrate` with the pooled `DATABASE_URL`).
4. Deploy (`vercel --prod`), then play one bout. `/replay` should pay, and the `match_settlements` row should go
   `pending` → `settled`.
5. In litnode, once `afc-v4` is merged and released:
   - register the ruleset (`npm run publish:title -- register` / `set-build rulesets/afc.v1.js`);
   - register the verifier (`npm run publish:title -- set-build verifiers/afc.v1.verifier.json`);
   - then set `LITNODE_VERIFIER_HASH`.
6. Switch off the Railway services once nothing depends on them.

## Rules

- Commit locally only. Don't push, deploy, migrate a remote database, register or send transactions.
- Secrets stay in managed env. Never print or copy `.env` or key files, and never print a private key.
- A sim change is a new verifier hash. Old results are never relabelled.

## Hand-back

Append an "after the Vercel move" section to `docs/LITNODE-V4-HANDBACK.md`. It covers:
- the function layout and routes;
- the env names;
- the queue and cron design, and the Vercel plan's cron limit;
- the re-vendored `sdk/court` commit;
- the verifier sidecar you committed;
- what stops when Railway goes;
- anything litnode still needs.
