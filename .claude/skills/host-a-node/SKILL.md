---
name: host-a-node
description: Connect, publish and host a LIT GAMES arcade node (litnode) on any machine — configure, preflight, run supervised, bond on litVM, expose a public URL, announce on NodeDirectory, install as a service, and verify — using the `npm run host` harness. Use when someone wants to run, join, seed, witness or host on the litVM Games mesh, or an agent must operate a node without a terminal session.
---

# Host an arcade node

You are taking a machine from "checkout or unzipped release" to a bonded,
reachable, announced litnode, using `npm run host -- <command>`. Read
`docs/HOST-A-NODE.md` once; it is the contract (commands, JSON shapes,
exit codes, what each stage proves). Every command is non-interactive and
idempotent, so re-running is always safe.

## Ground rules

- **Never touch a private key.** The operator wallet key is set by the
  human in their own shell as `OPERATOR_KEY` for one command and unset
  after. You never ask for it, print it, write it to a file, or pass it as
  a flag (the harness refuses `--key`). When a step exits `2` with
  `needs: ["OPERATOR_KEY"]`, stop and tell the operator exactly which
  command to run themselves.
- **Trust the harness, not your memory.** `status --json` reads the node
  and the chain; a stage is `done` only when they say so. Do not declare a
  node bonded, reachable or announced from a log line.
- **One install per folder, one node per identity.** `status` says
  `blocked` when the port answers as another identity, and reports a
  service that belongs to another install as `foreign`. Leave foreign
  things alone; never stop, replace or re-register them.
- **Roles decide what is required.** A witness needs no inbound path; a
  host or seed does. `verify` is strict about required stages only.

## Procedure

1. **Preconditions.** Node.js 20+; for `publish`, `cloudflared` on PATH;
   for `bond`, `npm install` once (pulls ethers). `npm run host -- doctor
   --json` checks all of it and names the fix for each failure.
2. **Configure.** `npm run host -- init --operator <name> [--seeds <url,…>]
   [--roles mesh,host,witness,settler | --witness] [--rulesets ./rulesets/<id>.js,…]
   [--tunnel quick] [--port 7801] [--region <r>] [--json]`. Writes `node.env`
   (comments kept), creates the identity, prints `nodeId` and `announcer`.
   Re-run with only the flags to change. `--home <dir>` (or `LITNODE_HOME`)
   keeps `node.env` and the log outside the code folder.
3. **Preflight.** `doctor --json`; fix every `ok: false` (each has `fix`).
4. **Run.** `start --detach --json` (supervised: relaunches on crash, at
   once after a signed update; log in `litnode.log`). `start` alone gives
   the dashboard in a terminal. `logs --lines 50` reads the log.
5. **Loop on `next`.** `npm run host -- next --json` returns
   `{stage, command, why, needs?}`. Run `command` unless `needs` lists
   something only the operator has; then hand it to them verbatim and wait.
   The stages in order: configure → identity → running → current → hosting
   → connected → reachable → bonded → announced → service.
6. **Publish (hosts and seeds).** `publish --tunnel quick` (or `--tunnel
   named --tunnel-name <n> --tunnel-host <h>` after the three `cloudflared`
   commands in `portable/README-OPERATOR.md`). Restarts the node with the
   tunnel, waits for the public URL, checks proof of possession at it, and
   delegates + funds the announcer when `OPERATOR_KEY` is in the shell.
7. **Bond.** Operator runs `set OPERATOR_KEY=0x…` (or `export`) then
   `npm run host -- bond`; the harness passes the nodeId to
   `tools/bond-node.mjs`. A witness must be bonded from a **different
   wallet** than the host it witnesses.
8. **Service.** `install-service` (Windows: scheduled task, needs an admin
   prompt — exit 2 says so; Linux: `systemd --user` unit + `loginctl
   enable-linger`; macOS: LaunchAgent). `install-service --remove` undoes it.
9. **Verify.** `verify --json` exits 0 only when every required stage is
   done; otherwise 3 with `failing[]`. Report the `stages` table to the
   operator, plus the public URL and `nodeId`.

## Hosting a title

The node hosts whatever `RULESETS` names. A new game goes through the
`host-a-title` skill first (scaffold → conformance → bundle); then
`init --rulesets ./rulesets/<id>.js,…` and `restart`. `status` shows it
under `hosting`, and `GET /titles` on the node lists it with its display.

## What the stages prove

| stage | done means |
|---|---|
| running | `/health` at the local port answers with this install's `nodeId` |
| current | no newer signed release on this node's channel |
| connected | at least one fresh peer in `/peers` |
| reachable | a public URL that answers `/whoami` with a signature by this node key, or inbound gossip in the last 30 s |
| bonded | `NodeStake.standingOf(nodeId).active` on litVM |
| announced | `NodeDirectory.entryOf(nodeId).url` equals what the node advertises |
| service | a scheduled task / unit / agent **for this folder** exists |

## Do not

- Edit `node.env` by hand when `init` can; never put a key in it.
- Run two nodes from one `DATA_DIR` or bond two nodes from one wallet and
  expect them to witness each other.
- Use `--force` on `install-service` unless the operator said to replace
  the other install's service.
- Run `stop` on a machine whose production node lives in another folder and
  expect it to be untouched by anything but this install's supervisor —
  it is untouched, but confirm with `status` rather than assuming.
