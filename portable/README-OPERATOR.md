# litnode — operator build

The same node as the portable build, plus what an operator needs: a
no-prompt config, a scheduled task so it survives reboots and closed
terminals, and the chain tooling (bond other nodes, import studio ledgers,
anchor the hour's root). Nothing here is a different program: **every node
runs the same daemon; roles are configuration.**

**Start here:** the operator guide,
https://github.com/strodanodev/litnode/blob/master/docs/OPERATORS.md —
requirements, install, bonding with your own wallet, going public, the
Agent Fighter match server, updates and troubleshooting. This file is the
short version for this folder.

## Roles, and who runs what

| Node | Bond | Roles | Runs where | Why |
|---|---|---|---|---|
| Operator | yes, its own wallet | mesh, host, witness, settler | a desktop or VPS that stays up | hosts and witnesses matches, keeps every ledger and build, settles and anchors |
| Volunteer / witness | yes, its own wallet | mesh, witness | anyone's machine, even without a public address | verifies other operators' matches |
| Game match server | runs on its host node | — | the node drawn to host (`GAUNTLETS=`) | Agent Fighter's per-match server; no database, no publisher key |
| Player | none | — | the browser | not a node: signs queue entries and ledgers, talks to nodes over HTTPS/WSS |

A witness must be bonded from a **different wallet** than the host it
witnesses. Two nodes from one wallet are one operator. A ranked match
goes on chain only with a host and three witnesses under four different
wallets.

## Set up (Windows)

Every step also exists as one non-interactive command —
`runtime
ode.exe sdkhostcli.mjs init|doctor|start --detach|bond|publish|install-service|verify`
(or `npm run host -- …` with Node.js installed) — which is what an
agent, a Linux or macOS machine, or a script should use.

1. Unzip somewhere you will keep. The `-win-x64` zip carries its runtime
   in `runtime/`; the plain zip needs Node.js 20+
   (`winget install OpenJS.NodeJS.LTS`). For a public address install
   `cloudflared` too (`winget install Cloudflare.cloudflared`).
2. Copy `node.env.example` to `node.env`; set a unique `OPERATOR`, your
   `REGION`, and `TUNNEL=quick`. Leave `SEEDS` empty: the node finds the
   mesh on chain.
3. **Start it interactively first**: `start-node.cmd`. This generates the
   identity, shows the dashboard, and — because it is an interactive
   program listening on every interface — triggers Windows' own firewall
   prompt, which a scheduled task never gets. Click Allow, or run
   `allow-firewall.cmd` once instead.
4. Open **http://localhost:7801/#/node** and bond from the **Operator**
   panel with your own browser wallet on litVM LiteForge: faucet tLITVM,
   bond (1 tLITVM), set the hot key, delegate and fund the announcer, top
   up the hot key with zkLTC. The **Setup checklist** on that page ticks
   off each step.
5. Stop the dashboard (`q`), then from an **admin** prompt:
   `install-task.cmd`. The node now starts at logon and restarts if it
   stops, writing one line per event to `litnode.log`.

An operator behind a Cloudflare tunnel needs no firewall rule at all — the
tunnel dials out. The rule is for LAN meshes and port-forwarded hosts.

If the node exits with code 74, `litnode.log` names what holds its port;
code 73 means this node already runs under another launcher.

## Chain tooling (needs `npm install` in this folder once — pulls ethers)

Every command reads the signing key from the environment of the shell you
run it in, and nowhere else. Never write a private key into a file here.

    set DEPLOYER_KEY=0x...                         your operator wallet (the harness takes OPERATOR_KEY)
    node tools/bond-node.mjs <nodeId>              bond a node (yours or another machine's)
    node tools/af-import-ledger.mjs <matchId> --post http://127.0.0.1:7801
                                                   settle an Agent Fighter relay match
    node tools/anchor-epoch.mjs http://127.0.0.1:7801
                                                   broadcast this hour's root, verify one proof on chain
    node tools/keygen.mjs court-identity.json      an identity for an attesting host (Pickle Brawl court)
    set DEPLOYER_KEY=

`af-import-ledger` needs the Agent Fighter checkout and its `.env` (set
`AF_ROOT`). Contracts and addresses are in `contracts/`.

## Production shape

- **Seeds** are bonded nodes with a public address and a delegated, funded
  announcer: they publish themselves on NodeDirectory, and fresh installs
  and the hosted arcade find the mesh there. A named tunnel keeps a
  seed's address stable across restarts.
- **Operators** stay up. A node that lapses ages out of the draw in ~6 s and
  back in when it returns; nothing it settled is lost, because deltas and
  builds are kept on disk and served by hash.
- **Public reachability** is one line: `TUNNEL=quick` in `node.env` and the
  node runs its own Cloudflare tunnel, advertises the public https URL in
  its heartbeat and falls back to the LAN address if it drops. Add
  `GAUNTLETS=agent-fighter.v1=<your copy of gauntlets/agent-fighter.json>`
  and `GAUNTLET_GATEWAY_PORT=8478` and it runs Agent Fighter's match server
  for each match it hosts and advertises the gateway as `wsAddr` (copy the
  template outside this folder: updates replace `gauntlets/`).
  A quick tunnel's hostname changes every run — fine for everything that
  learns addresses by gossip, not for the `SEEDS=` a new node types in or
  the hosted cabinet's default. For a stable name, once on this machine:
  `cloudflared tunnel login` → `cloudflared tunnel create litnode-seed` →
  `cloudflared tunnel route dns litnode-seed node.<your-domain>` (the domain
  must be on Cloudflare DNS), then `TUNNEL=named TUNNEL_NAME=litnode-seed
  TUNNEL_HOST=node.<your-domain>`; same three commands with another name
  for `RELAY_TUNNEL_NAME/HOST`. Nodes behind NAT still work as witnesses
  without any tunnel: gossip replies carry everything.
- **Being a seed from behind carrier-grade NAT** (hop 2 of `tracert` in
  100.64–100.127: the ISP shares its public IP; no port forward can help):
  `TUNNEL=quick` plus an announcer. The node prints its announcer address
  on `/health.directory.announcer`; delegate it once and give it gas:
  `set DEPLOYER_KEY=0x…` then `npm run announcer -- <nodeId> <announcer> --fund 0.02`.
  From then on every new tunnel hostname is published on NodeDirectory
  within a tick, fresh installs seed from the chain with no `SEEDS=`, and
  arcade.litvm.games reads the mesh through you for visitors with no node.
- **Clocks** must be synced. A node more than ~4 s behind is stale to
  everyone; `/peers` shows each peer's skew.
- **Keys**: the node key is generated on first run and bonded once. The
  wallet that bonds it is the operator. Rotate the deployer/slasher wallet
  before any operator outside the team bonds.

## Endpoints

    /health  /peers  /snapshot  /ruleset/:id[?build=]  /match  /queue
    /ledger  /delta/:id  /deltas  /cosign  /leaderboard  /credits  /stats
    /epoch  /proof/:id
