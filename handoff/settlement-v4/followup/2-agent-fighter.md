# Follow-up: Agent Fighter after litnode 7b752dd

Your settlement v4 hand-back (`docs/LITNODE-V4-HANDBACK.md`) is integrated into
strodanodev/litnode master as **7b752dd**. That commit sits on the unreleased
0.12.0 candidate and is not pushed yet. `docs/SETTLEMENT-STANDARD.md` in
litnode is the canonical contract.

## What litnode took from you

- **Adapter.** Your §3 patch is applied verbatim: pins go through
  `createGameState(seed, bounds, { chars, items, pets })`, `exclusive` is gone,
  `stats: { schema: core.STATS_SCHEMA }`, and `stats(s)` uses
  `core.matchStats`.
  - Built against your af-core-9 checkout (3d4d1d6), it gives buildHash
    `290200cf43682fa031d48c30a9ed8b5f2f602fcde10c1374049d687089e57691`. That
    build passes conformance, including "counters are in serialize()".
  - **The committed ruleset is still the release-signed af-core-8 build
    (`859e7215…`).** Peers load only signed or registered builds, and your relay
    refuses other engines. Rebuild, sign and register happen right after you
    deploy (below).
- **Your Q1, `serverHash` portability: fixed.**
  - `tools/bundle-server.mjs` now uses `absWorkingDir` = the checkout, and the
    git commit has moved out of the hashed manifest into the sidecar.
  - Your af-core-9 gauntlet server builds to `101661fb…dd62` from the litnode
    folder and from your folder alike.
- **Your Q2: `contracts.json` now names `explorer`.**
- **Your Q3: `GET /delta/<id>?chain=1`** returns `chain` and `official`.
  - It is **opt-in.** Witnesses fetch the bare delta from the same route, and
    annotating it by default broke attestation in the MatchBook suites.
- **Your Q4: `GET /deltas?ruleset=agent-fighter.v1&player=<key>`** returns one
  player's results.
- **Your Q5: gauntlet env is an allowlist now.** A server inherits only the OS
  and runtime basics, plus what its config lists in `inheritEnv`. Your AIR guard
  can stay as defence in depth.
- **Your Q6: `fastestKo` as a `min` stat is accepted.** An absent value is
  skipped in the fold.
- **Your Q7: the af-watch rule is applied.**
  - Relay rows settle unplaced and casual, under the relay's match id, with no
    player signatures.
  - Rows with `pin.intake === 'gauntlet'` are skipped.
  - Participants come from `pin.playerKeys`, else `af:<name>`.
  - `tools/af-import-ledger.mjs` follows the same rule.

## What to do now

1. **Results screen and history.** Request `GET /delta/<matchId>?chain=1`
   wherever you read `chain` / `official` from the single-match route (results
   polling in `packages/client/src/proof.ts`). History can switch to
   `/deltas?ruleset=agent-fighter.v1&player=<key>` instead of filtering every
   result client-side.
2. **Send the placement descriptor back with the ledger.** This is litnode
   0.11.31's binding: a ranked ledger binds to the placement the client was
   served, not to the host's memory of it.
   - The arcade's `cabinet:init` carries `match.descriptor`, the host's signed
     envelope.
   - The gauntlet server and any client-side settle should pass it as the
     submission's `descriptor` (`sdk/client.js settle({ descriptor })` does
     this).
   - Without it, a ranked match still settles only while the host's book holds
     the placement (15 minutes, and not across a host restart).
3. **Explorer links.** Read `explorer` from the contract set (`cabinet:init.chain`
   or `contracts.json`) and drop any fallback. Keep `check-contracts` green.
4. **Determinism, browser leg.** `determinism:browser` didn't run in your
   session. Run it, or confirm CI ran it, before deploy.
5. Run `npm run verify`, then commit locally.

## User steps, in order (list them; don't do them)

1. Push agent-fighter master.
2. Deploy client (Vercel) and relay (Railway) **together**, because the engine
   is af-core-9.
3. In litnode, with this repo at the deployed commit:
   - `npm run bundle:af`
   - `npm run sign:build -- rulesets/agent-fighter.v1.js` (release key)
   - commit
   - `npm run publish:title -- set-build rulesets/agent-fighter.v1.js`
4. In litnode:
   - `npm run bundle:server -- gauntlets/agent-fighter.server.json`
   - `npm run publish:title -- set-build servers/agent-fighter.v1.server.json`
   - serve it with `GAUNTLET_SERVERS=agent-fighter.v1=servers/agent-fighter.v1.server.tgz`
5. Operators: `GAUNTLET_SERVERS=agent-fighter.v1` on two or more operators,
   then the week-long relay retirement in your ADR 0014.

## Rules

- Commit locally only.
- Secrets stay in managed env.
- An engine change is a new build hash. Old results are never relabelled.

## Hand-back

Append a short "after 7b752dd" section to `docs/LITNODE-V4-HANDBACK.md`:
- what changed;
- the deployed commit to bundle from;
- anything litnode still needs.
