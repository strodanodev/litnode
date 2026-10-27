# Follow-up: FLOOD CONTROL after litnode 7b752dd

Your settlement v4 hand-back (`docs/litnode/V4-HANDBACK.md`) is integrated into
strodanodev/litnode master (`E:\NPC\AGENT 24 NODE`) as **7b752dd**. That commit
sits on the unreleased 0.12.0 candidate. Read it for reference, but don't edit
it. `docs/SETTLEMENT-STANDARD.md` there is canonical: §11 covers verifiers, §15
the deviations.

## What litnode took from you

- **Adapter.** Your `docs/litnode/flood-control.adapter.js` is copied verbatim
  into `titles/`. It builds to **`b16bc0a2…1977`**, the hash you reported, so no
  follow-up PR is needed.
- **Your Q1, the shell message for a single-player run: built as you
  proposed.**
  - The game sends `cabinet:sign-run { body: { rulesetId, inputsHash } }` and
    gets back `cabinet:run-signed { inputsHash, player, sig }`, or
    `{ inputsHash, error }`.
  - `sig = sign('run', { rulesetId, inputsHash })` with the player key.
  - The shell signs only under the launched title's own `rulesetId`, so the
    arcade has to know FLOOD CONTROL's `rulesetId`. A title listed through a
    peer's `display` carries it.
  - `sdk/court` now exports `RUN_TAG`, `signRun` and `verifyRun`.
- **Your Q2:** async `verify` is fine. A throw (`refused: …`) counts as "does not
  reproduce the committed `finalHash`".
- **Your Q3:** `finalFormat`, `levels` and `source.esbuild` are standard optional
  manifest fields.
- **Your Q4:** verifier bytes travel by hash from peers, like server bundles,
  publisher's node first. The route lands with the phase-2 runner. Until then,
  keep the `.tgz` and its sidecar with the registration.
- **Your Q5:** yes. Runs settled before the verifier is registered and active
  stay `attested`, and runs after it are `checkable`. The title's
  `activationDelay` applies.
- **Your Q6:** yes. `fc:` seats keep stats lines, stay casual, never bind to a
  profile, and never count for rewards.
- **Your Q7:** `keptDry` as a whole percent, summed, is fine.
- **Your Q8:** keep `arc-runlog@1`. Over 512 KiB, see `oversizeLog` below.
- **`sdk/court` notes:**
  1. `settle(…, { oversizeLog: 'skip' })` returns `logSkipped: 'oversize'`.
  2. With `node: 'auto'`, settle remembers the settler (`cacheMs`, 5 min) and
     falls through to the next candidate on unreachable or 403 (`fallbacks`,
     default 2).
  3. Verifier manifests no longer carry the commit inside the hash, matching
     your own tar.
  4. `Fetch` accepts the global `fetch`.
  5. `signRun` / `verifyRun` are added.

## What to do now

1. **Re-vendor `sdk/court` from 7b752dd** and update `VENDORED.md`.
   - Replace your own oversize gate with `oversizeLog: 'skip'`.
   - Drop the `fetch` cast.
   - Let `node: 'auto'` reuse the settler. This should end the per-run discovery
     that caused the litVM 429s.
2. **Run signature.** Switch `verify.ts` to `verifyRun` from the package. The
   message names and the tag already match what you built.
   - Test it end to end against a local cabinet if you can, by framing the game
     from litnode's `cabinet/` with FLOOD CONTROL listed. If you can't, test it
     against a stub parent window.
   - Leave the 8 s timeout and the `fc:` fallback as they are.
3. **Verifier hash check.** Rebuild with `scripts/arc/build-web.mjs` and
   confirm it still prints `56cfff04…0a57` for this tree. Also check that
   litnode's `tools/bundle-server.mjs --kind verifier` hash layout still agrees
   with yours.
4. Run the headless suite, `pnpm lint` and `pnpm build`, then commit locally.

## User steps, in order (list them; don't do them)

1. Merge your branch, then build and deploy (`build-web.mjs`, then
   `vercel deploy --prod` from `.deploy/vercel`).
2. Confirm that Vercel's `COURT_IDENTITY` public half is `f82a5ef3…da87`.
3. Release litnode 0.12.0, then register ruleset `b16bc0a2…` and verifier
   `56cfff04…` (or the hash the deploy build printed).
4. Update the desktop node to 0.12.0, then drop its flood-control `COURTS` entry.
5. Redeploy the arcade, so `cabinet:sign-run` is live.

## Rules

- Commit locally only.
- Secrets stay in managed env. Never open `.env.local`.

## Hand-back

Append an "after 7b752dd" section to `docs/litnode/V4-HANDBACK.md`:
- the re-vendored commit;
- the verifier hash;
- the run-signature test result;
- anything litnode still needs.
