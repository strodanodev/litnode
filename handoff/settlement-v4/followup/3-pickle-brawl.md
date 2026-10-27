# Follow-up: Pickle Brawl after litnode 7b752dd

Your settlement v4 hand-back (`docs/LITNODE-V4-HANDBACK.md`) is integrated into
strodanodev/litnode master (`E:\NPC\AGENT 24 NODE`) as **7b752dd**. That commit
sits on the unreleased 0.12.0 candidate. Read it for reference, but don't edit
it. `docs/SETTLEMENT-STANDARD.md` there is canonical: §11 covers verifiers, §14
the titles, §15 the deviations.

## Answers to your questions

1. **No log means no `commitments`.** Omitting the whole object is the intended
   pattern, because `logFormat` must be a string (§15 item 9).
2. **`startDirect` passes `key` through.** A seat's 64-hex `key` now reaches
   `LITNODE_SEATS` and is signed into the seat ticket. Any other value is
   dropped.
3. **`sdk/court` changed after 84c6fb0.** Additions:
   - `oversizeLog: 'skip'`;
   - with `node: 'auto'`, a remembered settler (`cacheMs`, 5 min) and
     fall-through to the next candidate (`fallbacks`, default 2);
   - `signRun` / `verifyRun`;
   - `Fetch` accepts the global `fetch`.

   Re-vendor from 7b752dd and update `VENDORED.md`.
4. **Verifier bytes travel by hash from peers**, like server bundles: the
   publisher's node first, `GET /verifier/<id>?build=<hash>`. That route lands
   with the phase-2 challenge runner. Until then, keep the `.tgz` and its
   sidecar with the registration, for example as release assets.
5. **Runtime.** Each `verify()` call gets its own process. Ceilings are
   `memoryMb ≤ 2048` and `timeoutS ≤ 900`, so your
   `{ node: ">=22", memoryMb: 1024, timeoutS: 600 }` is within them.
6. **Court key `09b2b849…7e23`.** litnode can't confirm it, because it never
   sees the private half. Confirming it is a user step.

The adapter now has your `seats()` fix, so a proven key is the seat. The ruleset
buildHash is `98d23e4e…90d1`.

## What changed that affects you

- **Your verifier hash is stale.** `tools/bundle-server.mjs` no longer puts the
  git commit inside the hashed manifest (it moves to the sidecar), and it
  bundles from the checkout's own folder. Repacking the same commit therefore
  gives a new hash, which is no longer `58e4f0b6…`.
- **Gauntlet env is an allowlist.** The court inherits only OS and runtime
  basics plus the config's `inheritEnv`. litnode's `gauntlets/pickle-brawl.json`
  now lists `COURT_LOG_DIR`, `COURT_DIAG` and `LITNODE_RPC`. Tell litnode about
  any other variable the court reads from the operator's environment rather than
  from the config's `env`.

## What to do now

1. **Repack the verifier.** Use `node services/court/verifier/bundle.mjs`,
   through litnode 7b752dd's `tools/bundle-server.mjs --kind verifier`.
   - Check that two packs give the same hash, and that a pack run from another
     folder gives it too.
   - Update the hash the court names for game build `6be50a41…`.
   - Re-run `services/court/test/verifier.test.ts` and the live node test
     (`litnode-report.test.ts`, with `VERIFIERS=` set to the new hash).
2. **Re-vendor `sdk/court`** from 7b752dd.
   - If a long four-human match can pass 512 KiB, have the court pass
     `oversizeLog: 'skip'`. The commitment stays and the result settles
     `attested`, so you can drop any gating of your own.
   - Let `node: 'auto'` reuse the settler.
3. **Send the placement descriptor back.** This is litnode 0.11.31's binding.
   - For arcade-placed matches, `cabinet:init.match.descriptor` is the host's
     signed envelope.
   - Pass it as the submission's `descriptor`, so a ranked report binds even
     after the host's book has forgotten the placement (15 minutes, or a
     restart).
4. Run the court and matchmaker test suites, then commit locally.

## User steps, in order (list them; don't do them)

1. Deploy the game build `6be50a41…` that the verifier carries to the courts.
2. Redeploy court, matchmaker and web.
3. Release litnode 0.12.0, and register ruleset `98d23e4e…`.
4. Register the **new** verifier hash with
   `npm run publish:title -- set-build <verifier sidecar>`.
5. Confirm that court key `09b2b849…7e23` is the managed-env key.

## Rules

- Commit locally only.
- Don't cut litnode releases.
- Secrets stay in managed env.

## Hand-back

Append an "after 7b752dd" section to `docs/LITNODE-V4-HANDBACK.md`:
- the new verifierHash and its reproducibility check;
- the re-vendored commit;
- descriptor wiring;
- anything litnode still needs.
