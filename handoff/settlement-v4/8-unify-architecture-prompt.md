# Prompt: unify match settlement across every title

You are the settlement architecture lead for the litVM Games mesh, working in the litnode checkout `E:\NPC\AGENT 24 NODE` (origin strodanodev/litnode, branch master).

**Goal.** One settlement flow and one hosting model that every title plugs into: Agent Fighter, Pickle Brawl, FLOOD CONTROL, AFC, and any future title. Today each title reached the mesh its own way. The result is three hosting patterns, two trust models, and a standby that copies a private key between machines. Design the target and the migration first; write no code until the user approves the plan.

## Read first

- `docs/SETTLEMENT-STANDARD.md`. This is the canonical contract: proof levels, envelopes, commitments, verifier contract (§11) and stats schema. Extend it; don't fork it.
- `handoff/settlement-v4/7-integration-audit-2026-10-24.md`, the facts as of 24 Oct, and `handoff/settlement-v4/00-shared-contract.md`.
- `docs/BRING-YOUR-BACKEND.md`, `docs/STANDBY-HOST.md` and `docs/OPERATORS.md`.
- `gauntlets/agent-fighter.server.json`, `gauntlets/pickle-brawl.json` and `gauntlets/pickle-brawl.services.json`.
- `node/gauntlet.js`, `node/server-bundle.js` and `node/publisher-services.js`.
- The adapters in `titles/`, and `sdk/court/`.
- Pickle Brawl's `web/litnodeBackend.ts` (in `E:\NPC\PICKLEBRAWLv2\PickleBrawl`): how its client picks a node and why it allowlists them.
- The AFC plan in `handoff/settlement-v4/followup/4-afc.md`, and litnode branch `afc-v4` (9a7f2a0, unmerged).
- Run `graphify query "<question>"` before grepping, and put that rule in any subagent prompt.

## Where each piece runs today

| Title | Trust model | Who runs the match / court | How results reach the mesh | Pinned to |
|---|---|---|---|---|
| Agent Fighter, ranked | replayable: both players sign, witnesses replay (L3 `verified`) | the per-match server as a hashed bundle (`e8d8f22b`), on any node that opts in with `GAUNTLET_SERVERS`; the mesh draws the host | the gauntlet posts the signed log to its node | nobody |
| Agent Fighter, casual | none (stays in AF's database) | the always-on relay | not reported (ADR 0014) | desktop, then m16 (`PREFERRED_RELAYS`) |
| Pickle Brawl | attested by court key `09b2b849` (L1; L2 `checkable` once its verifier is registered) | the court and matchmaker run from a local checkout (`pb-runtime`) as node gauntlet and publisher services | the court settles to its own node | desktop and m16 (`VITE_LITNODE_NODES` allowlist) |
| FLOOD CONTROL | attested by court key `f82a5ef3`, single seat | a Vercel function (board court) | `sdk/court` `settle()` to any node found through NodeDirectory | nobody |
| AFC (planned) | attested, dedicated court key `040bc3d9` | a Vercel function (planned) | `sdk/court` | nobody (PvP server undecided) |

## The divergences to resolve

1. **Court keys are shared secrets.** m16 can stand in for the desktop only because `STANDBY-HOST.md` §3 copies the desktop's Pickle Brawl court private key and its API and matchmaker `.env` files. The ruleset trusts exactly one key, so one leaked machine compromises every Pickle Brawl result. Rotating that key means a new ruleset build.
2. **Player credentials pass through operator nodes.** Pickle Brawl's matchmaker receives players' sign-in tokens and payment calls, so its client allowlists the studio's own nodes. That is the reason Pickle Brawl can't use the open mesh.
3. **Matchmaking state lives in one process's memory.** Pickle Brawl's queues, lobbies and court leases sit in RAM. A node restart drops them, and only one node can serve at a time (primary plus standby, not a pool). Agent Fighter's ranked play uses the mesh's own pairing (`protocol/pairing.js`).
4. **Two intakes.** A node-run gauntlet (Agent Fighter's bundle, Pickle Brawl's checkout), versus an off-node court calling `sdk/court` (FLOOD CONTROL, AFC). Pickle Brawl's court runs from a checkout pinned to a commit, not from a hashed artifact.
5. **Seat identity is inconsistent.** Arcade-launched Pickle Brawl matches still name players `pb:<uuid>`, so they settle unplaced and stay off arcade profiles. FLOOD CONTROL falls back to `fc:` ids outside the arcade. Agent Fighter seats players by key.
6. **Build drift breaks the proof level silently.** The Pickle Brawl session rebuilt its game and verifier (`11203288`) without registering it, so live results fell to `attested` with no warning. Nothing ties "court build" to "registered verifier" at release time.
7. **`checkable` has no enforcement yet.** No node runs the challenge runner, and verifiers are heavy (Pickle Brawl's is 16 MB and about 1 GB of RAM).
8. **Stats duplication.** FLOOD CONTROL sends `report.stats` that repeats its report fields.
9. **Ops skew.** The desktop is the only reliably live node. A guardian (`bfee8495`) on pre-v4 code flags every result. The last EpochAnchor proposal was 22 Sep.

## Constraints (from the user; do not trade these away)

- **Stack separation (24 Oct).**
  - litnode handles multiplayer, matchmaking, match resolution (settlement and proof levels) and per-match stats.
  - Neon or Supabase holds inventory, credits, the economy and studio stats.
  - No economy goes through the node, and no settlement goes through the database.
  - Railway is deprecated everywhere.
- **Secrets stay in managed env.** Never copy keys or `.env` files between machines. Nodes stay secret-free apart from their own per-node keys. Publisher secrets live in Vercel env.
- **Zero cost, no named Cloudflare tunnel.** Nodes use quick tunnels, so their hostnames rotate; discovery goes through NodeDirectory, never a baked hostname.
- **Never sacrifice security.** For anything that exposes player IPs, opens public endpoints or widens a trust boundary, state the cost and how it is contained.
- **Results are never relabelled.** An engine change is a new build hash.
- **Who acts.**
  - Registrations, releases, deploys, pushes and wallet transactions are the user's steps.
  - Commit locally only.
  - Other sessions edit this checkout. Commit only your own files, and stage a HEAD-based blob for shared files such as CHANGELOG.

## What to design

Answer each with a recommendation, the alternatives considered, and the security and cost consequence.

1. **One intake contract.** When a title runs a node-hosted match server (a gauntlet, always as a hashed bundle, never a checkout), when it uses an off-node court calling `sdk/court`, and whether both converge on one envelope and one call (`/ledger` with protocol ≥ 4). Cover how real-time PvP (Pickle Brawl, AFC PvP) fits when the court can't live on Vercel.
2. **Court identity without shared secrets.**
   - Per-instance court keys, generated where the court runs.
   - Rotation and revocation without a new engine build. Options: an attestor set on TitleRegistry kept separate from the ruleset hash, or a signed attestor list from the publisher key.
   - What a compromised key can and cannot do.
   - Replace `STANDBY-HOST.md` §3.
3. **Credentials out of operator nodes.** Players' tokens and payments go straight to the studio API on Vercel. Nodes receive only arcade-signed seats or tickets, so any node can host any title without seeing a credential, and allowlists become unnecessary.
4. **Matchmaking.** Decide one of:
   - the mesh's pairing for every title's ranked play;
   - a studio matchmaker whose state lives in Neon or Supabase, so any node can serve;
   - or a split between them.

   Lobbies and friends' matches must survive a node restart.
5. **Seat identity.** The arcade key everywhere an arcade launch happens (`cabinet:init`, `cabinet:sign-seat`, `cabinet:sign-run`). Prefixed ids are casual-only. Define the client and court checks that guarantee it.
6. **Release discipline.** One pipeline per title that rebuilds the ruleset, server bundle and verifier together, refuses to ship a court that names an unregistered verifier, and prints the exact registration calls. Add `doctor` checks for drift between the court build, the registered verifier and the live node.
7. **Proof levels in practice.**
   - The minimum challenge runner that makes `checkable` mean something.
   - Who runs it, and how verifier cost is bounded.
   - What stays `attested` honestly.
8. **Stats.** Schema-only, with no duplicated fields. Confirm the working split: per-match counters in litnode, studio counters in the database.
9. **Resilience target.** A failure matrix per title (desktop down, both down, publisher offline, Vercel down) for today and for the target, with "publisher offline" as the north star.
10. **Ops.**
    - Guardian version skew: a guardian should report its protocol and be ignored when stale.
    - Epoch anchoring with few operators.
    - The minimum operator count each guarantee needs.

## Deliverables

1. `docs/SETTLEMENT-ARCHITECTURE.md`: the target architecture, a short decision record for each item above, and the before/after failure matrix. Amend `docs/SETTLEMENT-STANDARD.md` only where the contract itself changes, and list each amendment.
2. A per-title migration table: what changes in litnode, in each title's repo, and in deploy and registration steps, and in what order, so that no live title breaks mid-migration.
3. A phased plan.
   - **Phase 1** must be the smallest change that removes the shared court key and the credential exposure.
   - Each phase lists its tests, its rollback, and the user steps it needs.
4. One short follow-up prompt per title session (Agent Fighter, Pickle Brawl, FLOOD CONTROL, AFC), in `handoff/settlement-v4/followup/`, ready to paste.
5. A short summary to the user. Recommendations go first; open questions only where a decision is genuinely theirs.

Stop after the deliverables and wait for the user's approval before changing code in any repo.
