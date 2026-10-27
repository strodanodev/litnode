# Follow-up: FLOOD CONTROL, unified settlement phase 1

**Run this only after the user has approved `docs/SETTLEMENT-ARCHITECTURE.md`
(rev 2) in strodanodev/litnode (`E:\NPC\AGENT 24 NODE`).** Read its §4, §9
and §10.

You work in `E:\NPC\06 AERIS GAME\bagyogame` (master `c718883`).

FLOOD CONTROL already fits most of the target: the player signs the run
(`verifyRun`), `sdk/court` settles with `node: 'auto'`, and nobody is
pinned. In phase 2 the mesh's custodians replay every run with FC's
verifier, and the Vercel board court becomes optional. Phase 1 makes that
possible by fixing two things.

## 1. Stats without duplicates

`report.stats` repeats the report body:
- `points`, `stars`, `rescued`, `casualties` and `bestChain` are copied
  as-is;
- `stormsSurvived` is `survived ? 1 : 0`.

See `scripts/arc/board/handler.ts:60-66`, `litnode.ts statsOf`.

- Put `keptDry` (whole percent, 0..100) in the report body.
- Stop sending `report.stats`.
- Update `docs/litnode/flood-control.adapter.js` so that `stats(report)`
  derives every stat from the body, and the validator checks `keptDry`
  there.
- This is a new ruleset hash. Report it.

## 2. The verifier hash comes from env, not a define

`build-web.mjs:73-85` repacks the verifier on every web build and injects
`__FC_VERIFIER_HASH__`. Any rebuild therefore changes the hash every report
names, and results then drop to `attested` unannounced.

- Pack the verifier as a release step, and keep the `.tgz` and sidecar in
  `.deploy/verifier`.
- Have the court read `LITNODE_VERIFIER_HASH` from env (AFC's pattern). An
  unset value means "name no verifier", so the result settles `attested`
  honestly.
- Add a test: building the web twice does not change what the court names.

## Also

- Check that the verifier runs under `node --permission` with read access
  to its own unpacked bundle only (phase 2 runs it in the node's sandbox),
  and report anything it needs beyond that (`DecompressionStream` is a
  global, so it should be fine).
- Re-vendor `sdk/court` from litnode master and update `VENDORED.md`.
- Run the verifier reproducibility check (two packs, two folders).
- Run a run against a local node.
- Commit locally (only your files).

## User steps to list (don't do them)

1. One signer batch: the new ruleset and the verifier (owner wallet).
2. Set `LITNODE_VERIFIER_HASH` in Vercel env after activation.
3. Deploy.
4. Revoke `b16bc0a2` once a run settles `checkable` on the new build.

## Hand-back

Append to `docs/litnode/V4-HANDBACK.md`:
- the new ruleset hash;
- the verifier hash;
- the adapter diff;
- the sandbox check;
- test results.
