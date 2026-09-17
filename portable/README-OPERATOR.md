# litnode — operator build

The same node as the portable build, plus what an operator needs: a
no-prompt config, a scheduled task so it survives reboots and closed
terminals, and the chain tooling (bond other nodes, import studio ledgers,
anchor the hour's root). Nothing here is a different program: **every node
runs the same daemon; roles are configuration.**

## Roles, and who runs what

| Node | Bond | Roles | Runs where | Why |
|---|---|---|---|---|
| Operator (publisher) | yes, its own wallet | mesh, host, witness, settler | a desktop or VPS that stays up | seeds the mesh, keeps every ledger and build, settles and anchors |
| Volunteer / guild | yes, its own wallet | mesh, witness (+ host) | anyone's machine | verifies other operators' matches; hosts when drawn |
| Relay / court | via its operator | host | beside a game's own server | Agent Fighter relay, Pickle Brawl court |
| Player | none | — | the browser | not a node: signs queue entries and ledgers, talks to nodes over HTTPS/WSS |

A witness must be bonded from a **different wallet** than the host it
witnesses. Two nodes from one wallet are one operator.

## Set up

1. Unzip. The `-win-x64` zip carries its runtime in `runtime/`; the plain
   zip needs Node.js 20+ (`winget install OpenJS.NodeJS.LTS`).
2. Copy `node.env.example` to `node.env`, set `OPERATOR`, `SEEDS`, and
   `PUBLIC_ADDR` if this machine has a public address.
3. **Start it interactively first**: `start-node.cmd`. This generates the
   identity, shows the dashboard, and — because it is an interactive
   program listening on every interface — triggers Windows' own firewall
   prompt, which a scheduled task never gets. Click Allow, or run
   `allow-firewall.cmd` once instead. Note the `nodeId`; confirm
   `http://localhost:7801/health` shows `inbound.reachable: true` once a
   peer is pointed at you.
4. Bond it (see below), then from an **admin** prompt: `install-task.cmd`.
   The node now starts at logon and restarts if it dies, writing one line
   per event to `litnode.log` (no dashboard: there is no terminal).

An operator behind a Cloudflare tunnel needs no firewall rule at all — the
tunnel dials out. The rule is for LAN meshes and port-forwarded hosts.

## Chain tooling (needs `npm install` in this folder once — pulls ethers)

Every command reads the signing key from the environment of the shell you
run it in, and nowhere else. Never write a private key into a file here.

    set DEPLOYER_KEY=0x...
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

- **Seeds** are two or three operator nodes with stable public addresses,
  set as NODE_URL in cabinet/config.js. Everything else discovers through them.
- **Operators** stay up. A node that lapses ages out of the draw in ~6 s and
  back in when it returns; nothing it settled is lost, because deltas and
  builds are kept on disk and served by hash.
- **Public reachability** is one line: `TUNNEL=quick` in `node.env` and the
  node runs its own Cloudflare tunnel, advertises the public https URL in
  its heartbeat and falls back to the LAN address if it drops. Add
  `RELAY_PORT=8477` and it fronts the Agent Fighter relay on this machine
  too (`npm run server` in the AF checkout) and advertises it as `wsAddr`.
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
