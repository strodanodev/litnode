# Verification — litnode review

- Reviewed artifact: https://claude.ai/artifact/ViKUCMBk39VrYVWPJ8KSGe, read through the browser.
- Reviewed whitepaper: https://www.litvm.games/whitepaper/#article-vi, read through the browser.
- Working tree: version 0.7.0, HEAD c915601ee3b3ecb0b9941b516d5ec3f08843673a, with substantial pre-existing uncommitted changes. Findings apply to inspected working-tree code, not a verified byte-for-byte installed release.
- Local running node observation at 2026-09-17 11:59:53 UTC: version 0.6.5, bonded, one peer entry (self). This is one node's view, not an independent network census. No contract deployment, ownership rotation or transaction history was independently validated on chain in this review.
- The sandbox initially prevented spawning test subprocesses (EPERM). Running with the required process permission succeeded. The first unbounded npm test run appeared stalled after directory tests and was interrupted; no assertion failure had been reported there.
- A subsequent run used the same 15 test files from package.json, concurrency 1, and --test-timeout=45000. **51 tests passed; 0 failed, 0 cancelled, 0 skipped; duration 214.5 seconds.** See bounded-test-output.txt. This demonstrates the existing suite passes, not that the missing security properties are present.
- Four additional harmless local probes confirmed: execution before purity rejection; a bracket-notation purity bypass passing 27 checks; an empty unsigned ranked submission labelled relay and appearing in the default ladder; a witness accepting altered host-signed scores. See litnode-probes.mjs and probe-results.jsonl.
- The probes exercise the real conformance/settlement functions with local fixtures and temporary audit keys. They do not constitute exploitation of the running node, arbitrary-code payload delivery, or on-chain testing. No live node was mutated, no service was restarted or upgraded, no authority was rotated, and no transaction was submitted.
- The review canvas was syntax-checked separately. Host rendering was requested but not visually verified. The Markdown review and raw evidence remain the standalone deliverables.
