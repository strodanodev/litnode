# Build audit — 20 September 2026 (0.9.0, protocol 3)

Scope: the checkout at commit `0600c84` (0.9.0), its test suite, the live
desktop node, and the path an operator or an agent takes to bring up a
node. Method: read the code and docs, ran the suite, read `/health` on the
desktop, exercised every onboarding step against scratch installs. This is
an internal review, not a third-party audit; the 17 September review
(`litnode-build-review.md`) and its remediation (`remediation.md`) remain
the security baseline and their open items are restated in §4.

## 1. State of the build

| | |
|---|---|
| Version / protocol | 0.9.0 / 3 (players sign `{matchId, ticks, head, buildHash}`) |
| Test suite at start | 19 files, 63 tests: 62 pass, 1 skipped, 0 fail, 256 s |
| Test suite at end | 20 files, 69 tests: 67 pass, 1 skipped, 1 fail in the full run — `custody` hit `isStale is not defined` while a concurrent session was mid-edit on `node/litnode.js` (its 0.9.1 queue-pruning change, uncommitted); re-run against the settled tree, custody + host + protocol: 20/20 pass |
| Live desktop node | `publisher`, 0.9.0, protocol 3, quick tunnel up, announced on NodeDirectory v2, bonded; **1 bonded peer in its snapshot: itself** |
| Contracts | v2 set on Liteforge (4441), deployed 19 Sep from the rotated wallet; `NodeStake.minStake` 1 tLITVM |
| Runtime on this machine | Node 24.19.0; `cloudflared` on PATH |

The build is coherent: the daemon, the cabinet, the tools and the docs
describe the same thing, every claim in SPEC §4 still reads as an honest
zero, and the suite is green. What was weak is **hosting a node** — the
thing the project needs strangers to do.

## 2. Findings on the hosting path (before this session)

Ordered by how much they stood between a willing operator and a bonded,
reachable node.

1. **Windows-only, interactive, dashboard-driven onboarding.** The only
   launchers were `.cmd` files; the first run had to be interactive (to
   trigger the firewall prompt and print the `nodeId`); the `nodeId` for
   `bond-node.mjs` was read off a dashboard. There was no path for Linux or
   macOS, none for a script, none for an agent. *Fixed:* `npm run host`
   (`sdk/host/`), one non-interactive, idempotent, `--json` command per
   step on every OS; `identity` produces the `nodeId` before first start.

2. **No machine-readable "how far along is this node".** `/health` reports
   facts (bonded, tunnel, update, inbound) but nothing composed them into
   "what is done, what is next, what do I need". RUNBOOK §6 was the only
   description of the sequence, in prose. *Fixed:* `status`/`next`/`verify`
   compute ten stages from the node and the chain and name the next
   command and its prerequisites; exit codes are the contract.

3. **`npm run node` with `HOST=0.0.0.0` advertised `http://0.0.0.0:<port>`.**
   `start-node.cmd` computed the LAN IPv4 for the zips, but the daemon's own
   CLI did not, so a checkout run with the documented env advertised an
   unusable address in its heartbeat. *Fixed* in `node/cli.mjs`.

4. **Two installs on one machine collide on the scheduled task.** The task
   is named `litnode` with no link to its folder; `stop-node.cmd` and
   `schtasks /End` act on whatever holds the name. Found the hard way: a
   harness smoke test ended the wrapper of the production desktop task
   (`E:\NPC\LITNODE-DESKTOP`); the node itself stayed up, but until
   `restart-node.cmd` is run there the task will not relaunch it after a
   crash or an update. *Fixed in the harness* (`serviceStatus` checks the
   task's `Start In` and command; a foreign service is reported and never
   touched; `install-service` refuses to replace one without `--force`).
   *Not changed:* the `.cmd` scripts in the zips still assume one install
   per machine — documented here, and worth a folder-suffixed task name in
   a later release.

5. **`node.env` was not ignored by git** at the repository root, so a
   checkout operator's configuration could be committed. No key ever
   belongs in it, but seeds, tunnel names and `AF_ROOT` do. *Fixed*
   (`.gitignore`).

6. **Bonding needs `npm install`.** `tools/bond-node.mjs` uses ethers
   while the node itself and `set-announcer.mjs` are dependency-free
   (`protocol/evm.js`). An operator of the plain portable zip cannot bond
   without installing a package tree. *Open:* port the bond tool to
   `protocol/evm.js` like the announcer; the harness's `doctor` and `bond`
   say what to install meanwhile.

7. **Agent-runtime skills are half-tracked.** `.claude/skills/` is
   committed; `.agents/skills/` (the same files, for other runtimes) is
   gitignored, so a fresh clone has the skill for Claude Code only.
   *Mirrored* `host-a-node` into both, like `host-a-title`; *open:* track
   `.agents/` or generate it in `pack`.

8. **Key handling was correct and is preserved.** Every chain tool reads
   the key from the environment and nowhere else; the node holds no
   operator key; the announcer key can publish one node's URL and nothing
   more. The harness keeps that: no flag takes a key (`--key` is refused),
   the daemon's environment is stripped of `OPERATOR_KEY`/`DEPLOYER_KEY`,
   and `bond`/`announce` are child processes of the existing tools. The
   test suite asserts the stripping.

## 3. What the harness proves, and what it does not

Each stage is judged by a read, never by a prior action: `/health` with
this identity's `nodeId`; `/peers` freshness; `/health.tunnel` plus a
`/whoami` nonce challenge at the advertised URL (proof of possession, the
same check readers apply to directory entries); `NodeStake.standingOf`;
`NodeDirectory.entryOf`/`announcerOf` and the announcer's balance; a
service whose command and folder are this install's. A failed read is
`unknown`, not a guess.

It does not make an unbonded node count, make a witness bonded by the
host's wallet independent, or make a title conformant. Those remain the
chain's, the operator's and `host-a-title`'s.

## 4. Open items carried forward (unchanged from `remediation.md` §"What remains")

- Registry hydration on Liteforge (minter, progressor, one forged character).
- The live two-player run across independent networks with player
  signatures (0.9.0 has the protocol; the AF client redeploy and an hour's
  freeze have not been run live).
- **Second operator, second relay, no quick tunnels** — still a procedure,
  not a fact. The desktop snapshot's bonded set is one node. This is the
  item the harness exists to shorten: a second operator now needs `init`,
  `bond` from their own wallet, `publish`, `install-service`.
- Load, success-rate and recovery measurements under a documented workload.
- Slashing (disputes recorded, nothing slashed).
- Items 6 and 7 above.

## 5. Actions taken in this session

- `sdk/host/{index,cli,supervisor}.mjs`, `demo/host.test.mjs`,
  `docs/HOST-A-NODE.md`, `.claude/skills/host-a-node/SKILL.md` (+ `.agents`
  mirror), `npm run host`, `npm test` includes the new suite.
- `node/cli.mjs`: LAN address when bound to every interface.
- `.gitignore`: `/node.env`.
- README, CHANGELOG (Unreleased), `portable/README-OPERATOR.md` pointers.
- **Owed to the operator:** run `restart-node.cmd` from an administrator
  prompt in `E:\NPC\LITNODE-DESKTOP` to put the production node back under
  its task wrapper (its quick-tunnel hostname will rotate and be
  re-announced, as on any restart).
