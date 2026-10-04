# litnode — portable build

One folder, nothing to install. The `-win-x64` zip carries its own Node.js
runtime in `runtime/` (the official build, checksum-verified when packed);
the plain zip needs Node.js 20+ on PATH. Every node runs the same daemon —
mesh, placement, pairing, settlement, witness, epoch tree — and serves the
LIT GAMES cabinet at `http://localhost:7801/`.

## On each machine

1. Unzip this folder anywhere. Double-click `start-node.cmd`.
2. Answer two prompts: a name for your node (`alice-laptop`), and a seed
   URL — leave it blank: the node finds the mesh on chain.
3. The dashboard opens in the terminal: peers, titles, live gossip with real
   signatures, placements, settlements. Keys: `q` quit, `g` show every
   gossip envelope, `l` log, `p` pause. `http://localhost:7801/` is the
   cabinet.

That is all for a volunteer or witness. **Firewall:** Windows blocks only
inbound connections, and a node that reaches outward needs none — gossip
replies carry everything it must verify. Only a node other machines must
connect *to* (a seed, a LAN host, a relay) needs a rule, and for that the
first interactive start shows Windows' own "allow this app" prompt; or run
`allow-firewall.cmd` once (one UAC click, a rule for this folder's runtime
on private networks only). `/health` says `inbound.reachable` either way.

## Updating

The node checks for a new signed release every hour and says so in its
dashboard header (press `u`), on `/health`, and on the cabinet's Nodes
page (**Update node** — only from `http://localhost:7801/` on the node's
own machine). Or double-click `update.cmd`. The release must be signed by
the litnode release key and the zip must hash as the manifest says, or it
is refused. Your `data` folder, `node.env` and log are never touched.

## Bond the node (once per machine)

A node that is not bonded gossips and hydrates rulesets but is excluded from
placement and cannot co-sign; its health shows `bonded: false`. Open
**http://localhost:7801/#/node** and use the **Operator** panel with your
own browser wallet on litVM LiteForge: faucet tLITVM, bond, set the hot key,
then fund it with a little zkLTC (free at liteforge.hub.caldera.xyz). The
Setup checklist on that page shows what is left. The full operator guide:
https://github.com/strodanodev/litnode/blob/master/docs/OPERATORS.md

From a terminal instead (needs `npm install ethers` in this folder once):

    set DEPLOYER_KEY=0x...        your operator wallet, this shell only
    node tools/bond-node.mjs <nodeId>

Testnet minimum is 1 tLITVM (contracts/deploy.testnet.json). Health flips to
`bonded: true` within about ten seconds.

## What to look at

    http://<ip>:7801/health          identity, bond, peers, chain head
    http://<ip>:7801/snapshot        bonded peers + manifests + root (same root on every node)
    http://<ip>:7801/deltas          settled matches
    http://<ip>:7801/leaderboard?ruleset=agent-fighter.v1
    http://<ip>:7801/epoch           this hour's tree + anchor calldata

## Settle a real Agent Fighter match on the mesh

On the laptop (needs the Agent Fighter checkout and its .env):

    npm run import:af -- <matchId> --post http://127.0.0.1:7801

Any bonded witness on the mesh under a different operator will fetch it,
replay it and co-sign; `/delta/<matchId>` shows `cosigners`.

## Pickle Brawl (attested)

The court process reports to a node when these are set in its environment:

    LITNODE_URL=http://<ip>:7801
    COURT_IDENTITY=<path to identity.json from `node tools/keygen.mjs`>

The node settles the report labelled `attested` (it cannot replay it).

## Environment overrides

`OPERATOR`, `PORT`, `SEEDS` (comma list), `ROLES`, `PUBLIC_ADDR`, `REGION`,
`OFFLINE=1` (local beacon, no chain), `RPC`, `NODE_STAKE`.
