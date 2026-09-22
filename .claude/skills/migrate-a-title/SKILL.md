---
name: migrate-a-title
description: Wire a game that already runs on its own backend (relay, match server, results database) into litnode settlement — assess replayable vs attested, write or port the ruleset, create the bridge key, configure the node (RELAY_KEYS/COURTS), run the bridge as a webhook or watcher, backfill history, and verify what the mesh made of each match. Use when a publisher with existing infrastructure wants their matches on the litVM ladder without rewriting their game.
---

# Migrate an existing title onto the mesh

You are wiring a publisher's existing backend to litnode settlement with
`npm run bridge`. Read `docs/BRING-YOUR-BACKEND.md` first; it is the
contract. The publisher keeps their engine, database, servers and art;
what changes is that one message per finished match reaches a node.

## Ground rules

- **Never weaken a label.** A result is `players`, `relay`, `host` or
  `attested` because of what backs it; the bridge cannot upgrade it. Say
  which one the publisher gets and why. OFFICIAL means finalized on
  `MatchBook`: placed, players-signed, three witnesses under other
  operators attested the same hash, nobody dissented (`/match/:id/chain`,
  `bridge check`).
- **The node, not the bridge, decides.** After every step, `npm run bridge
  -- check <matchId> --json` is the truth. Do not report "settled" from a
  bridge log line.
- **Secrets stay where they are.** The bridge key is created by the tool
  and never printed in full; the publisher's database credentials are
  read by their adapter from their own environment; `BRIDGE_TOKEN` is set
  by them. You never ask for, echo, or write any of them.
- **The node operator adds the key.** `RELAY_KEYS` / `COURTS` go in the
  node's `node.env` and need a restart; if you are not operating that
  node, hand the exact line over and wait.

## Procedure

1. **Assess.** Ask (or read from their code) three facts, then run
   `npm run bridge -- assess --input-log y|n --deterministic y|n --engine-open y|n --json`.
   Replayable needs all three; anything else is attested. Tell the
   publisher what that means for the ladder (`docs/BRING-YOUR-BACKEND.md` §1).
2. **Ruleset.** Replayable: port the simulation into `titles/<id>.mjs`
   (`host-a-title` skill) — it must be the *same* engine their server runs;
   bundle the engine with it if it is a package (`tools/bundle-ruleset.mjs`
   is the Agent Fighter example). Attested: write `validate(report)` and
   `scores(report, participants, teams)` covering everything a node can
   check. Then `npm run conformance` and `npm run bundle:title`; note
   `buildHash` from `rulesets/<id>.json`.
3. **Bridge key.** `npm run bridge -- key --kind <kind> --ruleset <id> --json`.
   Give the operator the `nodeEnv` line; confirm after restart that
   `GET /health` shows it under `trust.relayKeys` or `trust.courts`.
4. **Choose the wiring** with the publisher:
   - their server can call a URL at match end → `bridge serve` (webhook,
     `BRIDGE_TOKEN`), they POST the unsigned submission;
   - they would rather not change server code → `bridge watch` with the
     `jsonl` (a file their backend appends to) or `http` (an endpoint they
     already have or can add) adapter, or an adapter you write for their
     source following `sdk/bridge/adapters/agent-fighter.mjs`.
   Map their result records to the submission shape (§5 of the doc):
   replayable needs `entries: [{k, inputs:[…]}]` in participant order and
   `buildHash`; attested needs `report` and `teams`. Include `room` when
   the arcade launched the match (`?room=` on their URL) so it settles
   under the mesh placement.
   - nothing should be hosted anywhere else: **gauntlet**. The node runs
     their headless match server per placed match (`docs/BRING-YOUR-BACKEND.md`
     section 6a). Write `gauntlets/<id>.json` (command, cwd, env with
     `${port} ${secret} ${publicUrl} ${seats} ${nodeUrl}`, command `${node}`),
     add `GAUNTLETS=` and `RELAY_PORT=` to the host's `node.env` (or
     `GAUNTLET_GATEWAY_PORT=` when that node already fronts another title's
     relay on `RELAY_PORT`; `npm run host -- doctor` checks it), have their server verify
     the HMAC ticket at its gate and report to `LITNODE_URL` with the seated
     player keys as participants, and their client fetch its ticket from
     `<ws-as-https>/<room>/ticket?player=` on the arcade launch. Prove it
     with a placement: `/health.gauntlet` shows the process, the delta says
     `placed: true`.
   - the studio's whole backend should live on the node (API, matchmaker,
     court pool): **publisher services**, `docs/BRING-YOUR-BACKEND.md`
     section 6c. Write `gauntlets/<prefix>.services.json`, give each service
     a plain HTTP entry point (Vercel functions need a small server, as
     Pickle Brawl's `services/api/src/server.ts`), set `SERVICES=` on the
     node, and make the client find `/svc` through NodeDirectory at runtime
     (Pickle Brawl's `web/litnodeBackend.ts`), never a baked hostname.
     Static files, including an identity provider's key file, stay on the
     frontend host. Prove it: `GET <relay>/svc` lists every service `up`.
   Where the node's hostname can rotate (quick tunnels), use `--node auto`
   / `LITNODE_URL=auto` or `bridge resolve` so nothing is pinned to it.
5. **Test one match.** Submit a real finished match (`bridge submit
   <file>` or through the wiring); `bridge check <matchId>` must find it
   with the expected attestation. A refusal names the fix.
6. **Run it as a service** beside the node (`install-service` pattern in
   `host-a-node`, or their own supervisor). `--state` keeps the cursor;
   restarts re-send nothing.
7. **Backfill** if they want history: `bridge backfill --adapter … --source …`.
   Old results settle unplaced and labelled; they are never official.
8. **Toward official** (replayable only): their client asks the arcade
   shell to sign at match end (`docs/BUILD-FROM-SCRATCH.md` §shell) and
   their relay includes both `signatures`; matches launched from the
   arcade carry `room`. Then `check` reports `players`, placed, and —
   with a witness under another operator — OFFICIAL.
9. **Report** the publisher: kind, label, the node.env line, the wiring
   chosen, one `check` output, and what remains for official results.

## Reference instances

- Agent Fighter (replayable, Supabase): `tools/af-watch.mjs`,
  `tools/lib/af-submission.mjs`, `sdk/bridge/adapters/agent-fighter.mjs`.
- Pickle Brawl (attested, its own court, migrated 21 Sep 2026):
  `titles/pickle-brawl.adapter.js`, `demo/attested.test.mjs`; the court
  signs locally and resolves the node from chain
  (`services/court/src/litnode-report.ts` in the Pickle Brawl repo) —
  the worked example in `docs/BRING-YOUR-BACKEND.md`.

## Do not

- Promise official results for an attested title, or for relay-signed
  logs.
- Put economics in the ruleset or the bridge.
- Run the bridge against a node whose operator has not added the key and
  call the refusals a bug.
