---
name: host-a-title
description: Put an open-source game on the litVM Games mesh — scaffold a title from the SDK template, make it deterministic and conformant, bundle it, host it on a bonded litnode, and get it listed in the arcade. Use when a developer wants their game, assets or agents recognised in the litVM Games ecosystem.
---

# Host a title on the litVM Games mesh

You are helping a game developer ingest their game into litnode so bonded
nodes host it and its matches settle on litVM. Read `docs/HOST-YOUR-TITLE.md`
first; it is the rulebook, and every rule in it is enforced by code you can run.

## Procedure

1. **Decide the kind.** Can the outcome be recomputed from a per-tick input
   log with integer/seeded math? Yes → *replayable* (`defineTitle`). No
   (floating-point physics, closed engine, no input log) → *attested*
   (`defineAttestedTitle`; the title's own signer reports outcomes; Pickle
   Brawl in `rulesets/pickle-brawl.v1.js` is the reference). Prefer replayable.

2. **Scaffold.** `npm run create-title -- <name>.v1 "<Display Name>"` writes
   `titles/<name>.v1.mjs`, a complete replayable sample (TUG). The rulesetId
   must match `^[a-z0-9][a-z0-9-]*\.v\d+$`.

3. **Port the rules into it.** Keep `init/step/done/serialize/view/scores`
   pure: no `Math.random` (use `seededRandom(seed)`), no `Date`, no network,
   no storage; integers where the engine allows. `serialize()` must include
   every field `step()` reads. `view()` filters hidden information. Map
   ERC-6699 core stats (`ctx.agents[playerId].stats`, four uint16) through
   `defineBalance` with **bounded** ranges; never read raw stats. Fill
   `display: { title, url, description, cover?, accent?, controls? }` —
   without it the node hosts but the arcade does not list.

4. **Check.** `npm run conformance -- titles/<name>.v1.mjs` (bundles in
   memory). Fix every FAIL; the node refuses the same failures at load. Do not
   weaken the suite for a title: it is the gate for every node.

5. **Bundle.** `npm run bundle:title -- titles/<name>.v1.mjs` →
   `rulesets/<name>.v1.js` + `.json` with the `buildHash`. The `.js` bytes are
   what settles; commit both.

6. **Host.** `RULESETS=./rulesets/<name>.v1.js npm run node` (or add it to
   `node.env` RULESETS, comma-separated, on an operator install). Confirm
   `GET /health` shows the rulesetId and `GET /titles` lists it with its
   display. Bond the node (`npm run bond`); unbonded hosts are never placed.
   To bring the node itself up — configure, run supervised, bond, publish,
   verify — use the `host-a-node` skill (`npm run host -- init --rulesets
   ./rulesets/<name>.v1.js …`).
   **Claim the title on chain** from the wallet that bonded that node:
   `PUBLISHER_KEY=0x… npm run publish:title -- register rulesets/<name>.v1.js`
   (`--calldata` prints what a multisig should send). The title is an
   ERC-721 the wallet holds; other nodes load the build because the chain
   says so, and `GET /titles` shows `published: true` only while a bonded
   `host`-role node bonded from the holder's wallet hosts it. A retune is
   `set-build` (active after the registry delay), `revoke` is immediate, a
   hand-over is `transfer <rulesetId> <to>` or any wallet's NFT transfer.

7. **Wire the client.** The arcade opens `display.url` with
   `?ws=<relay>&room=<LIT-…>&player=<key>`; the client queues via
   `POST /queue`, reads `GET /match`, plays over its own transport, and both
   players sign the ledger head that goes to `POST /ledger`. Agent Fighter's
   `packages/client/src/mesh.ts` is the reference for relay discovery from
   `NodeDirectory`.

8. **Verify end to end.** `npm test` (includes `demo/conformance.test.mjs`);
   then a real queue → match → ledger → delta on the running node, and the
   ladder at `GET /leaderboard?ruleset=<name>.v1`.

## Do not

- Add imports the bundle cannot inline, or ship a minified artifact.
- Put economics in the title: no fees, no token logic. Settlement is the
  node's; monetisation arrives through the ERC-6699 contracts, not rulesets.
- Store a private key in the repo. Node identity is in `DATA_DIR`; wallet
  keys live in the shell environment only.
