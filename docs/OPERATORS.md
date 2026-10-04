# Run a litnode: operator guide (testnet pilot)

This is the one page a new operator needs: install a node, bond it with
your own wallet, make it reachable, and keep it running. It takes about
30 minutes. Everything happens on the **litVM LiteForge testnet**, so the
tokens are free and have no value.

Written for litnode **0.11.21**. Deeper references:
[HOST-A-NODE.md](HOST-A-NODE.md) (the `npm run host` harness, command by
command) and [RUNBOOK.md](RUNBOOK.md) (keys, releases, evidence).

## What you are joining

litnode is a network of referees for online games. Players play; nodes
pair them, re-run each match from its inputs to check who won, and
record ranked results on chain. Every node runs the same program.

- **Your node** gossips with the mesh, can be drawn to **host** a match
  (collect the match record, settle it) or to **witness** one (replay it
  and attest on chain).
- **Your wallet** is your operator identity. It bonds your node with
  1 tLITVM. Two nodes bonded by one wallet count as one operator.
- **Ranked play needs 4 operators.** A ranked match goes on chain with a
  host and 3 witnesses, all under different wallets. Below 4 online
  operators every match is casual. Each new operator brings the network
  closer to ranked play.
- **Your node pays a little gas** (zkLTC, free from a faucet) for the
  matches it hosts and witnesses, through a "hot key" it holds itself.
  Testnet gas is free; there are no rewards yet.

## Before you start

| You need | Notes |
|---|---|
| A machine that stays on | Windows 10/11, macOS or Linux. A laptop is fine for testing; keep it awake while it runs |
| A **new** browser wallet | MetaMask or similar, used only for this pilot. Never use a wallet that holds real funds |
| zkLTC for gas | Free at [liteforge.hub.caldera.xyz](https://liteforge.hub.caldera.xyz). 0.05 covers your bond and many matches |
| `cloudflared` | Only to be publicly reachable (recommended). Windows: `winget install Cloudflare.cloudflared`; macOS: `brew install cloudflared`; Linux: [Cloudflare's packages](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |
| Node.js 20+ | Only for the plain zip, a source checkout, or hosting Agent Fighter matches. The Windows `-win-x64` zip and the Control Plane carry their own |
| A synced clock | A node more than ~4 s off is ignored. Windows: Settings › Time › Sync now |

Network details, for adding LiteForge to your wallet:

| | |
|---|---|
| Network | litVM LiteForge (testnet) |
| Chain ID | 4441 |
| RPC | `https://liteforge.rpc.caldera.xyz/http` |
| Explorer | `https://liteforge.explorer.caldera.xyz` |
| Gas token | zkLTC ([faucet](https://liteforge.hub.caldera.xyz)) |
| Stake token | tLITVM (faucet button on your node's Nodes page) |

## 1. Install

Pick one.

**A. Windows, point and click: LITNODE Control Plane.** Download it from
**[arcade.litvm.games/#/download](https://arcade.litvm.games/#/download)**
(the page lists the installer's SHA-256 and the install steps). It is a
per-user `.msi`, no administrator needed. It is not code-signed yet, so
Windows SmartScreen may warn: check the checksum, then **More info → Run
anyway**. Open it:
it unpacks a node with its own runtime, keeps it running from the system
tray, and has buttons for restart, update and opening the arcade.
Continue at step 3.

**B. Any OS: the release zip.** Download from
[GitHub Releases](https://github.com/strodanodev/litnode/releases/latest):

- `litnode-operator-v<version>-win-x64.zip`: Windows, carries its own
  Node.js runtime, plus the scheduled-task scripts.
- `litnode-operator-v<version>.zip`: macOS and Linux (needs Node.js 20+).

Releases are signed, and registered on chain before a node will apply
them. Unzip anywhere you can keep, for example `C:\litvm\litnode`.

**C. From source** (to read or change the code):

```bash
git clone https://github.com/strodanodev/litnode.git
cd litnode && npm install
```

## 2. Configure

Copy `node.env.example` to `node.env` in the same folder and edit three
lines:

```ini
OPERATOR=alice-laptop     # your node's name: lowercase, digits, dashes, unique to you
REGION=eu-west            # roughly where you are: ap-southeast, eu-west, us-east, …
TUNNEL=quick              # public reachability through Cloudflare (needs cloudflared)
```

Leave `SEEDS` empty: the node finds the mesh on chain. With the harness
one command writes the same file (in the `-win-x64` zip, which has no
`npm`, run `runtime\node.exe sdk\host\cli.mjs init …` instead of
`npm run host -- init …`):

```bash
npm run host -- init --operator alice-laptop --region eu-west --tunnel quick
npm run host -- doctor      # checks runtime, port, RPC, clock, cloudflared
```

The Control Plane writes its own `node.env` on every start: use its
**Configure** screen for the name, port and public tunnel, and Windows
user variables for anything it has no setting for (Troubleshooting).

## 3. Start, and open your node's page

- **Control Plane:** it starts the node on launch.
- **Windows zip:** double-click `start-node.cmd`. The first start shows
  Windows' firewall prompt; **Allow** it (or run `allow-firewall.cmd` once).
- **Harness:** `npm run host -- start --detach`.
- **macOS/Linux zip:** `node node/cli.mjs` in the folder.

Open **http://localhost:7801/#/node**. This is your node's control page.
Its **Setup checklist** ticks off every step below as it completes. The
node generates its key on first start (`data/<OPERATOR>/identity.json`);
that file is your node's identity, so back it up and never delete it.

## 4. Bond with your wallet

All on the same page, in the **Operator** panel. Each button asks your
wallet to confirm; nothing is sent until you do.

1. **Connect operator wallet** (on LiteForge, with some zkLTC).
2. **Faucet tLITVM** if the wallet has less than the 1 tLITVM minimum.
3. **Bond this node**: approve and stake 1 tLITVM behind this node's key,
   and set the node's hot key (2–4 wallet prompts).
4. **Delegate + fund announcer**: lets the node publish its own address
   in the on-chain directory, and sends it 0.02 zkLTC for that.
5. In the **Hot key · gas** panel, top up the hot key (0.05 zkLTC is a
   good start). A hot key that runs dry mid-match voids that match.

The node enrolls itself in the witness pool once the hot key is set and
funded, and can be drawn as a witness 2 minutes after bonding.

No browser wallet? Use the CLI (operator zip or source checkout; run
`npm install` once in the folder for the chain tools) with your key in
the shell for that one command, never in a file:

```bash
export OPERATOR_KEY=0x…        # PowerShell: $env:OPERATOR_KEY="0x…"
npm run host -- bond
npm run host -- announce --fund 0.02
unset OPERATOR_KEY             # PowerShell: Remove-Item Env:OPERATOR_KEY
```

## 5. Be reachable

With `TUNNEL=quick` and `cloudflared` installed, the node opens its own
Cloudflare tunnel, checks that the public URL answers as itself, and
publishes it on chain. On the checklist: **Public address verified** and
**Announced on NodeDirectory** turn green within a few minutes. No
router setup or firewall rule is needed: the tunnel dials out.

A node without a tunnel still works as a witness. A public node can also
serve as a seed for players and new nodes.

## 6. Optional: host Agent Fighter matches

A node can run Agent Fighter's own match server for each match it is
drawn to host. It needs no database and no publisher key. This is what
lets the game run without its publisher online.

1. Install Node.js 20+ and Git, then:
   ```bash
   git clone https://github.com/strodanodev/agent-fighter C:/litvm/agent-fighter
   cd C:/litvm/agent-fighter && npm ci
   ```
2. Copy `gauntlets/agent-fighter.json` from the litnode folder to a place
   **outside** it (updates replace the litnode folder's copy), for example
   `C:/litvm/agent-fighter.json`, and set its `"cwd"` to your checkout.
3. Add to `node.env` (Control Plane: as user environment variables, see
   Troubleshooting), with `TUNNEL` set:
   ```ini
   GAUNTLETS=agent-fighter.v1=C:/litvm/agent-fighter.json
   GAUNTLET_GATEWAY_PORT=8478
   ```
4. Restart the node. `http://localhost:7801/health` shows `gauntlet.titles`
   with `agent-fighter.v1` and a `wsAddr`.

Keep the checkout current (`git pull && npm ci`) when the game updates:
players and your server must run the same engine.

## 7. Keep it running and current

- **Survive reboots.** Control Plane: it starts at sign-in. Windows zip:
  `install-task.cmd` from an **administrator** prompt (a scheduled task
  that restarts the node if it stops). Harness on any OS:
  `npm run host -- install-service`.
- **Updates.** The node checks for a signed release every hour and says
  so on its page. Apply it with **Update node** on
  `http://localhost:7801/#/node` (works only from that machine), the
  Control Plane's **Apply update**, `update.cmd`, or `u` in the terminal
  dashboard. Your `data` folder and `node.env` are never touched. Please
  update within a day of a release: nodes on an older protocol are
  dropped from placement.

## 8. Done when

The Setup checklist is all green, or `npm run host -- verify` exits 0.
Concretely:

- bonded on NodeStake, hot key set and funded, enrolled
- public address verified and announced (if you run a tunnel)
- `http://localhost:7801/peers` lists other nodes as fresh
- your node shows on the arcade's Nodes page from another machine

Then send us your **nodeId** (top of your node's page) and the wallet
address you bonded with.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Node exits with code **74**, log says `cannot listen on :7801 (EADDRINUSE)` | Something else holds the port. The log names it: another litnode (with its nodeId and path) or another program | End that process, or set `PORT` to another number. If the log lists a `litnode` scheduled task and you use the Control Plane, remove the task: `Get-ScheduledTask -TaskName 'litnode*' \| Unregister-ScheduledTask -Confirm:$false` (admin PowerShell) |
| Exits with code **73**, `already running` | This node is already running under another launcher | Nothing to fix: use the running one. Don't start a second copy on the same `data` folder |
| `EACCES` on the port after a reboot | Hyper-V, WSL or Docker reserved a port range that covers it | `netsh interface ipv4 show excludedportrange protocol=tcp`, then pick a `PORT` outside those ranges |
| Control Plane **Restart** changes nothing | Some builds re-attach to the running node instead of restarting it | Tray icon › **Quit**, end the old node (`Get-NetTCPConnection -LocalPort 7801 -State Listen \| % { Stop-Process -Id $_.OwningProcess -Force }`), reopen the Control Plane |
| A setting in `node.env` is ignored under the Control Plane | The Control Plane rewrites `node.env` on every start | Set it as a Windows user variable (`setx GAUNTLETS "…"`), then Quit and reopen the Control Plane |
| Address is `http://192.168.…` after a restart | The tunnel did not start | `cloudflared --version` must work in a new terminal; check `TUNNEL=quick`; look for `tunnel` lines in `litnode.log` |
| Node is listed as stale, or alone | Clock off by more than ~4 s, or no chain access | Sync the clock; check `chain` and `peers` in `http://localhost:7801/health` |
| "casual-only" / ranked never goes on chain | Fewer than 4 operators online with fresh, bonded nodes | Expected during onboarding; it fixes itself as operators join |
| Hot key **LOW** | Gas running out | Top it up in the Hot key panel, or send zkLTC from the faucet straight to the hot-key address |

Logs: `litnode.log` beside `node.env` (task, service or Control Plane),
or the terminal dashboard (`l`).

## Safety rules

- Use a **fresh wallet** for this pilot. The node never asks for your
  wallet key; only the CLI bond command reads it, from the shell.
- Never paste a private key into chat, an issue, a file or a log. If you
  did, treat that wallet as burned and make a new one.
- `data/<OPERATOR>/identity.json` is your node's key. Back it up.
- If players sign in through your node with AIR, the node creates and
  keeps their litVM proxy-wallet keys in its `data` folder. Treat that
  folder as sensitive. `AIR=0` in `node.env` turns sign-in off.
- This is a testnet prototype: contracts are unaudited, and parameters
  (stake, windows) may change with a release.

## What we ask of pilot operators

- Keep the node up during the agreed test windows, and update within a
  day of a release.
- Report problems as a GitHub issue on
  [strodanodev/litnode](https://github.com/strodanodev/litnode/issues)
  with: your nodeId, OS, install path (Control Plane, zip or source),
  what you did, and the last 50 lines of `litnode.log`. Read the lines
  first and remove anything you consider private.
- Tell us before you stop for good. There is no unbond button yet; the
  stake is testnet tLITVM and has no value.
