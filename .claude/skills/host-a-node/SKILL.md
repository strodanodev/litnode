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
- **One node cannot make ranked official.** A ranked match goes on chain
  only when a host and three witnesses under four different operators
  have fresh bonded nodes carrying the title; with fewer it plays
  casual-only (`commitSkipped` on `/match`). Tell the operator this rather
  than debugging a correctly configured node that has no peers yet.

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
7b. **Settlement keys (settlement v1.0, MatchBook).** A host or witness
   also needs a hot key and, to sit on escalation panels, enrolment:
   `npm run delegate -- <nodeId> <announcer address> --fund 0.005` names
   the node's own announcer as its delegate (the key it sends commit,
   settle, attest and finalize with; gas only, never the bond) and
   `npm run enroll -- <nodeId>` joins the nine-seat pool. Both take
   `OPERATOR_KEY` from the shell. `/health.matchBook` and `/health.bond`
   (`eligible`, `delegate`) say where the node stands; a bond younger than
   `eligibilityAge` is not drawn to witness yet. The arcade's Nodes page
   does the same with a wallet and shows the live checklist from the
   node's signed `/fleet`; `npm run fleet` reads it in a terminal.
8. **Service.** `install-service` (Windows: scheduled task, needs an admin
   prompt — exit 2 says so; Linux: `systemd --user` unit + `loginctl
   enable-linger`; macOS: LaunchAgent). `install-service --remove` undoes it.
9. **Verify.** `verify --json` exits 0 only when every required stage is
   done; otherwise 3 with `failing[]`. Report the `stages` table to the
   operator, plus the public URL and `nodeId`.

## Two nodes on one machine

`init --service-name litnode-2` (`SERVICE_NAME` in `node.env`) gives the
second install its own start-at-logon task or unit; without it,
`install-service` would find the first node's `litnode` task, report it
`foreign` and refuse. Give it its own `--port`, `--data-dir` and, if it
should witness the first, a bond from a different wallet.

## Running a title's match server on the node (gauntlet)

`init --gauntlets <id>=<json> --courts <id>:<court key>` and, when the node
already runs a title relay on `RELAY_PORT` (Agent Fighter), `--gauntlet-gateway-port
8478`. `doctor` refuses a gateway that would land on the relay's port. The node
then advertises the title in its heartbeat and placement draws it first for
that title. `status` shows `/health.gauntlet`. The config and the title's side are in
`docs/BRING-YOUR-BACKEND.md` section 6a and the `migrate-a-title` skill.

## Running a studio's whole backend (publisher services)

`init --services /abs/path/<prefix>.services.json` (and
`--gauntlet-gateway-port 8478` when a title relay already sits on
`RELAY_PORT`). The node supervises each service and publishes it at
`<wsAddr>/svc/<prefix>.<name>`; `curl <gateway>/svc` must list every
service `up`. The bundle is the studio's to write (section 6c of
`docs/BRING-YOUR-BACKEND.md`); secrets stay in its `envFiles` and you never
copy them anywhere.

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
| service | a scheduled task / unit / agent **for this folder** exists, under `SERVICE_NAME` (default `litnode`) |
| delegate, enrolled (Nodes page / `/health`) | `NodeStake.delegateOf(nodeId)` is the funded hot key; MatchBook lists the key in its pool |

## Do not

- Edit `node.env` by hand when `init` can; never put a key in it.
- Run two nodes from one `DATA_DIR` or bond two nodes from one wallet and
  expect them to witness each other.
- Use `--force` on `install-service` unless the operator said to replace
  the other install's service.
- Run `stop` on a machine whose production node lives in another folder and
  expect it to be untouched by anything but this install's supervisor —
  it is untouched, but confirm with `status` rather than assuming.
