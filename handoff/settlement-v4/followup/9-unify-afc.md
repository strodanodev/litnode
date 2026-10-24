# Follow-up: AFC, unified settlement

**Run this only after the user has approved `docs/SETTLEMENT-ARCHITECTURE.md`
(rev 2) in strodanodev/litnode (`E:\NPC\AGENT 24 NODE`).** Read its §3, §4,
§8 and §9. AFC's `d4ddf43` already runs PvP as a keyless gauntlet; rev 2
keeps that and makes the mesh's replay the judge, with `/court/bout`
optional.

You work in `E:\NPC\AGENT 21\AFC` (`cel-rebuild`, `d4ddf43`; many
uncommitted asset files are not yours). litnode's adapter is on branch
`afc-v4` (`9a7f2a0`, unmerged).

## Do (phase 1)

1. **Casual until ranked is ready.** The user's rule: AFC ranked is work in
   progress and must switch on plug and play, without breaking anything.
   - Keep the adapter's `modes: ['casual']`.
   - Make `pvpEnvelope` send `mode: 'casual'` until ranked ships. (From
     protocol 5, a node settles a ranked envelope for a casual-only title
     as casual anyway, so nothing breaks either way.)
   - Ranked turns on later by releasing a ruleset that declares it, once
     litnode's `doctor` reports every `ranked.*` check green (architecture
     §9).
2. Re-vendor `sdk/court` from litnode master, which now carries the
   `descriptor` (U1).
3. Run the tests, then commit locally (only your files).

## Phase 2 (design notes now; build when the user says so)

1. **Seat-signed input heads.** Each client signs its command-stream head
   through the shell (`cabinet:sign`, `ledger` tag over `{ matchId, seat,
   ticks, head }`) at least every 30 s and at the end. The gauntlet records
   the heads, and the client and applied tick of each input. This is a
   client and gauntlet change, not an engine change; confirm the verifier
   hash doesn't move.
2. **The verifier as the judge.** Check that AFC's verifier (Rapier WASM)
   runs under `node --permission` with read access to its own unpacked
   bundle only, and report what else it needs.
3. **`boundKey`.** Once litnode's `sdk/court boundKey()` lands, replace
   `identity.ts` and the vendored keccak with it.

## User steps to list (don't do them)

From 4-afc.md, still open:
1. `HMC_HOST_KEY`.
2. Neon migrate.
3. Deploy.
4. One signer batch: ruleset `6371d0f6` (or its successor) and verifier
   `14336181`.
5. Set `LITNODE_VERIFIER_HASH`.
6. Retire Railway.

The court key `040bc3d9` lives only in Vercel env. Never copy it.

## Hand-back

Report:
- the mode change;
- the phase 2 notes (head format, sandbox check);
- the hashes before and after;
- what litnode must merge from `afc-v4`.
