# Hand-back: litnode → Agent Fighter (23 Oct 2026, after the relay simplification)

Your hand-back of 23 Oct is done on the litnode side. Everything here is committed locally on master and is not pushed: the user pushes, releases, registers and sends transactions.

## The ref and fsck

- `master` was restored to `032fe10` with `git update-ref`, from the last line of `.git/logs/refs/heads/master`.
- `git fsck --no-dangling --connectivity-only` is clean.
- master is now 6 commits ahead of `origin/master`:

  | Commit | What |
  | --- | --- |
  | `8936bff` | the relay glue removed |
  | `032fe10` | the arcade shows per-title v4 stats |
  | `bcf679a` | the Ranks podium fits a phone |
  | `43ddd2e` | `litnode-watch` is retired on update; leftover docs fixed |
  | `26c2643` | `POST /restart` |
  | `364435f` | `rpcFallback` |

## Full `npm test`

**262/262 pass, 0 fail, 0 skipped** (`npm test`, 11 min, on `364435f`).

The working tree also holds the Pickle Brawl session's uncommitted forfeit fix (`titles/pickle-brawl.adapter.js`, the ruleset `866bb9eb`, `demo/attested.test.mjs`), so the run includes it. That build is not registered.

## Review of `8936bff` and `032fe10`

Both are sound. No source file still references the removed pieces; only old `dist/` packages do.

One gap was real, and `43ddd2e` closes it:

- An update deletes and recopies every CODE item, so `tools/af-watch.mjs` disappears.
- But `run-af-watch.cmd` had left CODE, so it stayed behind.
- Any operator whose `litnode-watch` task survived would loop on a missing script every 5 s, logging about 3 MB a day.

## Items 2–6 and 8

**2 · `litnode-watch` and the CHANGELOG.** Both mechanisms, so no operator has to do it by hand:

- The update ships `run-af-watch.cmd` again as a stub (in CODE and the operator zip).
  - The running loop ends at the new end of the file.
  - The next start tries `schtasks /Delete /TN litnode-watch` and otherwise exits 0.
- `install-task.cmd`, run from an admin prompt, unregisters a leftover `litnode-watch` task.

The CHANGELOG Operators note now says this. `[Unreleased]` holds:

- the watcher retirement;
- `/restart`;
- `rpcFallback`;
- the Pickle Brawl session's forfeit fix (uncommitted, theirs).

Rename the section at release time: `tools/release.mjs` uses the top section as the notes.

**3 · Control Plane.** Not changed here. The Control Plane runtime lives in the website repo, which this session stays out of apart from the UI redesign. The fix is unchanged:

- ship the 0.12.0 runtime;
- start no node while :7801 or the task node is live (or drive the task node instead);
- stop the node and `cloudflared` children on quit.

`POST /restart` (item 4) lets the Control Plane hand the port back without admin.

**4 · Restarting without admin** (`26c2643`).

- **New `POST /restart`:** the node exits and its launcher, or the waiting task wrapper, takes over within a minute. This works for a node started elevated, which `taskkill` can't end from an ordinary prompt.
- **Guard:**
  - loopback only;
  - refused when a forwarding header is present;
  - refused when the `Origin` header isn't `localhost`, `127.x` or `[::1]`, so another site open in the operator's browser can't restart it.
- **`restart-node.cmd`** tries `/restart` first, then the PID file.
- **Tests and docs:** `demo/hardening.test.mjs` covers it, and RUNBOOK §2 and the host-a-node skill ("When the node will not start") document it.
- **Why not have `run-node.cmd` free the port from the PID file:** an unelevated wrapper can't end an elevated orphan, so that wouldn't fix the reported case.

**5 · Peers.** No code change. The other operators need 0.12.0, including the m16 standby `50bb1da9…`. Its tunnel name was dead (ENOTFOUND) when last checked. These are operator steps.

**6 · `rpcFallback`** (`364435f`).

- **Deploy record:** `contracts/deployed.testnet.json` has `rpcFallback: ["https://liteforge.rpc.caldera.xyz/infra-partner-http"]`.
- **Cabinet copy:** vendor-cabinet copies it into `cabinet/contracts.json` and `contracts.js`.
- **Cabinet reads:** the cabinet's four single-URL RPC helpers are now one `rpcCall` (`cabinet/chain.js`).
  - It falls through on a network error, an HTTP error or a rate limit.
  - It stays with the provider that answered.
  - A JSON-RPC error is thrown, not retried.
- **MetaMask:** `wallet_addEthereumChain` gets every URL.
- **`sdk/court` discovery** tries `rpcFallback` after `rpc`, before `DEFAULT_RPCS`.
- **Not live yet:** the arcade serves this only after the user's next `vercel deploy --prod` from `cabinet/`.

**8 · Leftover docs** (`43ddd2e`).

- `BUILD-SPEC.md` §16 now says the old `af:<name>` relay results stay as settled and labelled, and that AF results now come only through the gauntlet, seated by key and signed by both players.
- The no-op manual relay-ledger test in `demo/settle.test.mjs` is gone.
- The `node/server-bundle.js` header says bundle mode is AF's only intake.

## What Agent Fighter must do

- **Nothing, until the next gauntlet server bundle.** Rebuild from AF master; the user runs `sign:build` and `publish:title set-build`. Ruleset `7414ddf3` is unchanged.
- **Optional:** the AF client can keep reading `rpcFallback` as it does. It appears in the arcade's `contracts.json` after the next arcade deploy.

## User steps that remain

1. Push litnode master (6 commits).
2. Redeploy the arcade from `cabinet/`. This ships the per-title stats, the phone fixes and `rpcFallback`.
3. Optionally, remove `RELAY_KEYS=7214bf9d…` from the desktop's `node.env`; nothing signs with it any more.
4. Get the other operators onto 0.12.0 (item 5).
5. At the next release, rename `[Unreleased]` and cut it. Operators then get the watcher stub and `/restart`.
