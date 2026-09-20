# Host a node: the `npm run host` harness

One command per step from a checkout or an unzipped release to a bonded,
reachable, announced litnode — for a person at a terminal and, equally,
for an agent acting on their behalf. The daemon is unchanged
(`node/cli.mjs`); the harness reads the same `node.env`, computes the same
effective configuration, and judges every stage by what the node and the
chain say, never by what it did last.

Code: `sdk/host/index.mjs` (library), `sdk/host/cli.mjs` (commands),
`sdk/host/supervisor.mjs` (keeps a detached node alive). Tests:
`demo/host.test.mjs`. Agent procedure: `.claude/skills/host-a-node/SKILL.md`.

## Contract

- **Non-interactive.** No prompts, ever. Missing input is an exit code and
  a message naming it.
- **Idempotent.** Every command can be re-run. `init` keeps what it did not
  change; `start` on a running node says so; `stop` on nothing is fine.
- **`--json`** prints exactly one JSON object on stdout and nothing else.
  Without it, short human lines.
- **Exit codes:** `0` ok · `1` error · `2` needs something only the
  operator can supply (a key, admin rights, a binary) · `3` not ready
  (`verify`).
- **Keys never pass through.** `bond` and `announce` need the operator
  wallet: set `OPERATOR_KEY` (or the older `DEPLOYER_KEY`) in the shell for
  that one command. It is handed to `tools/bond-node.mjs` /
  `tools/set-announcer.mjs` as a child environment and stripped from the
  daemon's. No flag accepts a key (`--key` is refused with exit 2); nothing
  writes one.
- **One install, one identity.** The harness identifies its node by the
  `identity.json` in `DATA_DIR`. A port answering as another identity is
  `blocked`, not `running`. A scheduled task, systemd unit or LaunchAgent
  that runs another folder is reported `foreign` and never stopped,
  replaced or removed.
- **Home.** `node.env` and `litnode.log` live in the code folder, or in
  `--home <dir>` / `LITNODE_HOME`. Code, `data/` (unless `DATA_DIR` is
  absolute) and `rulesets/` resolve against the code folder, as the daemon
  does.

## Commands

```
npm run host -- init --operator <name> [--seeds u1,u2] [--roles mesh,host,witness,settler | --witness]
                     [--rulesets ./rulesets/a.js,…] [--port 7801] [--host 0.0.0.0] [--public-addr https://…]
                     [--region r] [--tunnel quick|named --tunnel-name n --tunnel-host h] [--relay-port 8477]
                     [--air-partner <id> | --no-air]   AIR_PARTNER_ID defaults to the arcade's partner app
                     [--data-dir d] [--channel stable|canary] [--trust trusted|open] [--upnp] [--offline] [--rpc url]
npm run host -- doctor              preflight (see below)
npm run host -- identity            create/print nodeId + announcer address, no start needed
npm run host -- env                 the effective configuration the daemon will run with
npm run host -- start [--detach]    dashboard in a terminal, or supervised in the background
npm run host -- status              every stage + the one next command
npm run host -- next                just the next command (for a loop)
npm run host -- verify              status with a strict exit code (3 unless every required stage is done)
npm run host -- bond                OPERATOR_KEY in the shell → tools/bond-node.mjs <nodeId>
npm run host -- announce [--fund 0.02]   OPERATOR_KEY → tools/set-announcer.mjs <nodeId> <announcer> --fund
npm run host -- publish [--tunnel quick|named …] [--relay-port p]   tunnel + proof + announce (if key present)
npm run host -- install-service [--remove] [--force]   schtasks (Windows) · systemd --user (Linux) · launchd (macOS)
npm run host -- stop | restart | logs [--lines 50]
```

All commands take `--json` and `--home <dir>`.

### `init`

Writes `node.env` from `portable/node.env.example` on first run (comments
kept, each flag replacing its key, an empty value commenting the key out)
and merges on later runs. Validates: `OPERATOR` `^[a-z0-9][a-z0-9-]{0,31}$`,
roles ⊆ {mesh, host, witness, settler}, seeds are http(s) URLs, `TUNNEL`
∈ {quick, named} with name+host for named. Creates the identity so `bond`
can run before the first start. `--witness` is `--roles mesh,witness
--rulesets ''`.

### `doctor` — preflight checks

| id | ok when | fix |
|---|---|---|
| node-version | Node ≥ 20 | install Node.js 20+ |
| env-file / env-valid | `node.env` exists and validates | `init` |
| data-dir | writable | `DATA_DIR` |
| rulesets | every `RULESETS` file exists (`null` when none) | bundle the title |
| port | free, or held by this identity (`null`) | `PORT` / stop the other |
| cloudflared | on PATH when `TUNNEL` is set (`null` otherwise) | install it |
| rpc | `eth_chainId` answers and matches `contracts/deployed.testnet.json` (`null` offline) | `RPC` / `OFFLINE=1` |
| contracts | NodeStake + NodeDirectory addresses known | re-apply the release |
| seeds | each `SEEDS` URL answers `/health` on this protocol version | fix `SEEDS` |
| clock | within 4 s of each seed (HTTP `Date`) | sync the clock |

`ok: null` means "not applicable"; only `false` fails the run.

### `status` / `next` / `verify` — stages

Each stage is `{id, status, detail, next?, needs?}` with `status` ∈
`done | todo | blocked | optional | unknown`. `optional` means "not
required for these roles"; `unknown` means a read failed and the harness
will not guess. `next` is the first `todo`/`blocked` stage's command;
`needs` lists what the operator must supply first.

| stage | source | done when |
|---|---|---|
| configure | `node.env` | present and valid |
| identity | `DATA_DIR/identity.json` | exists |
| running | `GET /health` at `127.0.0.1:PORT` | answers with this identity's `nodeId` |
| current | `/health.update` | no newer signed release on the channel |
| hosting | `/health.rulesets` | ≥ 1 ruleset loaded (optional without the host role) |
| connected | `GET /peers` | ≥ 1 fresh peer |
| reachable | `/health.tunnel`, `/health.inbound`, `GET /whoami` at the advertised URL | tunnel up **and** the URL answers the nonce challenge with this key; or inbound gossip in the last 30 s. Optional for witness-only nodes; CGNAT is detected from `/health.upnp` |
| bonded | `NodeStake.standingOf(nodeId)` via JSON-RPC | `active` (optional offline) |
| announced | `NodeDirectory.entryOf / announcerOf`, `eth_getBalance(announcer)` | entry URL equals what the node advertises. Otherwise: not delegated → `announce`; unfunded → `announce --fund`; delegated+funded but stale → wait (the node re-announces within ~2 min) |
| service | schtasks / systemd / launchd, **for this folder** | installed (optional) |

`verify` exits 3 if any stage is `todo`, `blocked` or `unknown`.

### `publish`

Sets `TUNNEL` (default `quick`) in `node.env`, requires `cloudflared`,
restarts the node if the tunnel mode changed, waits up to 90 s for
`/health.tunnel.node.state == 'up'`, then challenges the public URL with
`/whoami` and reports `proof`. With `OPERATOR_KEY` in the shell it also
delegates and funds the announcer; without, it says exactly what to run.
`--relay-port 8477` also fronts a title relay on this machine (Agent
Fighter's `npm run server`) as `wsAddr`.

### `install-service`

Runs `sdk/host/supervisor.mjs` at logon. Windows: scheduled task
`litnode`, S4U headless, restart on failure — needs an administrator
prompt (exit 2 otherwise). Linux: `~/.config/systemd/user/litnode.service`,
`systemctl --user enable --now`; run `loginctl enable-linger $USER` so it
survives logout. macOS: `~/Library/LaunchAgents/games.litvm.litnode.plist`,
`KeepAlive`. An existing service for **another** install is refused
(`--force` to replace it, only when the operator asks).

### The supervisor

`start --detach` and every service run `sdk/host/supervisor.mjs`: it runs
`node/cli.mjs` in plain mode with `node.env` (plus the computed
`PUBLIC_ADDR`, minus any key) and appends to `litnode.log`; relaunches at
once on exit 75 (an applied signed update) and after 5 s on anything else;
ends cleanly on SIGTERM or a `supervisor.stop` file. PIDs:
`DATA_DIR/supervisor.pid` and `DATA_DIR/node.pid`. It is the cross-platform
`run-node.cmd`.

## Library

```js
import { effectiveConfig, readEnv, writeEnv, validateEnv, ensureIdentity,
         preflight, inspect, plan, health, peers, titles, prove,
         chainStanding, directoryEntry, daemonEnv, serviceStatus } from './sdk/host/index.mjs';

const cfg = effectiveConfig(readEnv());          // what the daemon runs with
const pre = await preflight(cfg);                // { ok, checks[] }
const p   = plan(cfg, await inspect(cfg));       // { ready, stages[], next }
```

`inspect` performs every read once (health, peers, titles, chain standing,
directory entry, announcer balance, whoami proof, service) and returns
nulls for what failed; `plan` is pure and testable against a synthetic
inspection. Nothing in the library takes a key.

## Typical runs

**Volunteer witness, laptop, no public address:**

```bash
npm run host -- init --operator my-laptop --witness --seeds https://<a seed>
npm run host -- doctor
npm run host -- start --detach
set OPERATOR_KEY=0x…        # your wallet, this shell only
npm run host -- bond
set OPERATOR_KEY=
npm run host -- verify
```

**Second operator: host + seed behind NAT, hosting Agent Fighter:**

```bash
npm install                  # once: the bond tool needs ethers
npm run host -- init --operator guild-a --roles mesh,host,witness,settler --rulesets ./rulesets/agent-fighter.v1.js --tunnel quick
npm run host -- doctor
npm run host -- start --detach
export OPERATOR_KEY=0x…
npm run host -- bond
npm run host -- publish --tunnel quick --fund 0.02     # public URL, proof, announcer delegated + funded
unset OPERATOR_KEY
npm run host -- install-service
npm run host -- verify
```

**An agent, in a loop:**

```
repeat:
  r = `npm run host -- next --json`
  if r.next == null: done
  if r.next.needs: tell the operator r.next.command and r.next.needs; wait
  else run r.next.command
```

## What the harness does not do

- Hold, request or store a wallet key (BUILD-SPEC §11 stands: the node has
  no operator key; the announcer key it makes can publish one node's URL
  and nothing else).
- Make an unbonded node count: placement and co-signing still require the
  on-chain bond, and a witness bonded by the host's wallet is the same
  operator (README-OPERATOR).
- Make a title conformant. That is `docs/HOST-YOUR-TITLE.md` and the
  `host-a-title` skill; the harness only hosts what `RULESETS` names.
- Replace `install-task.cmd` in the operator zip. That path (relay +
  watcher tasks from `AF_ROOT`) still exists; `install-service` covers the
  node alone on every OS.
