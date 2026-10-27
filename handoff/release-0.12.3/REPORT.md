# 0.12.3: merge and cross-session check (28 Oct 2026)

All of this is local. Nothing is pushed, tagged, released or registered from this session.

## Where master is

master `b7b55d1` is version **0.12.3**. It is 35 commits ahead of `origin/master` (`3482ee0`, v0.12.1). No v0.12.2 or v0.12.3 tag exists.

**Added after this report was first written:**
- `34f4c12` (in 0.12.3): CHANGELOG lists AFC under `[0.12.3]`, so the release notes cover everything it ships.
  - `tools/release.mjs` takes the notes from the top section. Before this, the release would have been titled "[Unreleased]".
  - AFC's registration was read back from TitleRegistry: ruleset `e3725bd2` and verifier `14336181`, both active, publisher `0x04bE…a378`.
- `b7b55d1` (after 0.12.3): `/ro3/hosts` lists only bonded peers' servers, with each entry's operator and staking wallet. This fixes finding 1.
- Full suite on `b7b55d1`: **294/294**.

Since v0.12.1 it carries the following.

**0.12.2 (never released on its own):**
- Custody before settle, any-holder ledger fetch, and seats expiring unfed escalations.
- The arcade counts staking wallets.
- Secrets rule phase 1.
- Per-match process logs.
- Custody copies answer `/delta/<id>?chain=1`.

**0.12.3:**
- RO3Emu hosting through the node's own quick tunnel (branch `ro3-tunnel`, merged as `68cd3ac`).
- `cabinet:sign-key` (`e3be6df`, plus the quoting fix `a763e7f`).

**AFC as `afc.v1`:**
- Branch `afc-v4` was fast-forwarded onto master at 02:35 by the AFC session, at your choice there (`00a3ff0`).
- Build `e3725bd2…` and verifier `14336181…` were registered on TitleRegistry at 18:42Z.
- That session ran `npm test` at 293/293 on `00a3ff0`.
- **Version mismatch (fixed in `34f4c12`).** CHANGELOG listed AFC under a new `[Unreleased]` heading while `package.json` said 0.12.3. The entry now sits in `[0.12.3]`.

**Fixes from this session:**
- `ff13d6b`: the Agent Fighter bundle test passes its pace flag through the bundle.
- `d8582be`: the arcade top bar fits 761–1279 px.

**Compatibility:** protocol 4 is unchanged, so 0.12.0–0.12.3 nodes are peers. No contracts changed. The cabinet changed, so redeploy it with the release.

## Tests

All suite runs had TEMP/TMP on E:, because C: is full.

| Tip | Result |
|---|---|
| `8cae9ed` (before tonight) | 286/287; the one failure was the AF bundle flake, explained below |
| `68cd3ac` (0.12.3, before AFC) | **290/290** |
| `d8582be` (AFC and the top-bar fix) | **293/293** |
| `b7b55d1` (tip: plus the changelog fold and RO3 bonded-only listing) | **294/294** |

**AF bundle flake: fixed in `ff13d6b`.**
- **Cause:** since 0.12.0 a title's process inherits only the OS basics, and a bundle passes only its manifest's `env`. So the test's own `AF_NO_PACE_CHECK` never reached the bundled server.
- **Symptom:** Agent Fighter then dropped PvP inputs above its 20× real-time cap. The lockstep bots froze, and the 30 s idle check settled the match `incomplete`.
- **Before the fix:** it failed about 2 runs in 3, on v0.12.1 and on master alike.
- **After the fix:** 7 of 8 runs passed. The eighth hit the port collision described under finding 2.

**Arcade top bar: checked in the browser.** With the arcade pointed at the bonded desktop node:

| | Sideways scroll |
|---|---|
| Before | 411 px at 800, 187 at 1024, 82 at 1200, 3 at 1279 |
| After | 0 at every width checked: 760, 761, 800, 1023, 1024, 1200, 1201, 1279, 1280, 1440 |

`demo/cabinet.test.mjs` passes 3/3.

## Merges tonight (master's reflog, local time)

| Time | master | What | By |
|---|---|---|---|
| 02:06 | `ff13d6b` | AF bundle test fix | this session |
| 02:12 | `68cd3ac` | merge `ro3-tunnel` (0.12.3) | this session |
| 02:35 | `00a3ff0` | fast-forward to `afc-v4` (AFC session had merged master into it at 02:18) | AFC session |
| 02:44 | `d8582be` | arcade top bar, re-applied from `claude/epic-herschel-df93d5` | this session |

## Cross-session check

### litnode branches

| Branch | State |
|---|---|
| `ro3-tunnel`, `afc-v4`, `claude/mesh-gaps-2accd3`, `lite-guardian`, `claude/distracted-joliot-ffad4c`, `claude/jovial-cori-15aac9`, `worktree-agent-a3f90…`, `worktree-agent-a9bc7…` | all in master |
| `claude/epic-herschel-df93d5` | its one unlanded commit (`c44b3b1`) is now ported as `d8582be`; the branch can be deleted |

Their worktrees still exist under `.claude/worktrees/` and `E:/NPC/litnode-guardian` and `E:/NPC/litnode-ro3-tunnel`. They're safe to remove once their sessions are done with them.

### Other repositories (no session was running at the check)

| Repo | Branch | Unpushed | Working tree |
|---|---|---|---|
| Agent Fighter (`E:/NPC/AGENT FIGHTER/agent-fighter`) | master | 4 (netcode `4fd7fa3`, `32841ec`, `66f874e`, `e036829`) | clean |
| Pickle Brawl (`E:/NPC/PICKLEBRAWLv2/PickleBrawl`) | master | **55** (through hand-back 12, 26 Oct) | clean |
| PB runtime (`pb-runtime`) | detached at `37837da` | n/a | 1 modified file |
| FLOOD CONTROL (`06 AERIS GAME/bagyogame`) | master | 1 (playtest kit round 2) | clean |
| AFC (`E:/NPC/AGENT 21/AFC`) | `cel-rebuild`, no upstream | n/a | 3 modified, 7 untracked; active tonight |
| RO3 (`AGENT 27 NPC/ro3agents`, `ro3emu-src`) | `master` and `agent-scale`, no upstream | n/a | `ro3agents`: 13 modified, 82 untracked |

## Open findings

1. **`/ro3/hosts` trusted any peer. Fixed in `b7b55d1`.**
   - It listed the RO3 server of every node it had heard from, bonded or not. An unbonded node could advertise a lookalike-named server and collect players' RO3 logins.
   - Now, with NodeStake, only peers the chain shows bonded are listed. A dev mesh with no chain lists everyone.
   - Each entry carries `operator` and `wallet`.
   - **Follow-up for the RO3 session:** RO3Emu's client (`src/Ro3Emu.Setup/TunnelBridge.cs`, branch `litnode-tunnel`) reads only `nodeId`, `name`, `url` and `seenAt`. It picks the newest host by name, so two bonded servers with the same name are still picked newest-first. Showing `operator` and `wallet`, or matching on them, is that repo's change.
2. **The gauntlet readiness check can mistake another process for its own server** (`node/gauntlet.js`, `canConnect`).
   - A port free on 127.0.0.1 can still be taken on `::`. The title's server then dies with `EADDRINUSE`, but the node marks the match up because another listener answers.
   - The desktop node, test runs and other sessions all use 7820–7859 on this machine.
   - The worst case is a failed match, because a foreign server rejects the seat ticket.
3. **The arcade asks every node for the `afc.v1` ladder and stats.**
   - A node without `afc.v1` answers `400`; that's the desktop today, on 0.12.1.
   - This clears as nodes take 0.12.3. Until then the AFC ranks are empty.
4. **C: has 0 MB free.**
   - The biggest items are Claude's `vm_bundles` (9.8 GB), `.claude` (4.7 GB) and Temp (2.8 GB).
   - The desktop node, the AF relay and node updates all write to C:.
5. **Test runs from different sessions on this machine collide** on gauntlet ports and CPU. Tonight's flaky runs and slow suites came partly from overlapping runs.

## Your steps, in order

1. Free space on C:.
2. litnode:
   - ~~Push and release 0.12.3~~ (done 03:11–03:14).
   - `npm run release:registry` for 0.12.3, if it isn't registered yet.
   - Then **0.12.4** for the `/ro3/hosts` fix: push `b7b55d1`, bump the version, release, register. Players' nodes on 0.12.3 still list unbonded RO3 servers until they update.
3. Update the desktop, m16 and witness-2.
   - AFC bouts settle once a node serves `afc.v1`; then the AFC session reruns its retry job.
   - On m16, stop its relay copy and delete the copied `.env`.
4. `vercel deploy --prod` from `cabinet/`. This covers the top bar, the AFC listing and the sign-key flow.
5. Push Agent Fighter (4), Pickle Brawl (55) and FLOOD CONTROL (1).
   - Agent Fighter: `npm run deploy`, then rebuild the server bundle and `set-build`.
6. Clean up: delete `claude/epic-herschel-df93d5` and the merged worktrees.
