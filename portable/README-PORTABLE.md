# litnode — portable test build

One folder, no install step, no dependencies beyond Node.js 20+. Runs the
arcade node: gossip, placement, pairing, settlement, witness, epoch tree.

## On each machine

1. Install Node.js 20 or newer if missing: `winget install OpenJS.NodeJS.LTS`
2. Unzip this folder anywhere. Double-click `start-node.cmd`.
3. Answer two prompts: an operator name (`laptop`, `rog-ally`) and the seed
   URL of a node that is already running (blank on the first machine).
4. Allow inbound TCP 7801 once, from an admin prompt, if peers cannot reach it:
   `netsh advfirewall firewall add rule name="litnode 7801" dir=in action=allow protocol=TCP localport=7801`

The first line the node prints is its `nodeId`. Health is at
`http://<lan-ip>:7801/health`.

## Bond the node (once per machine)

A node that is not bonded gossips and hydrates rulesets but is excluded from
placement and cannot co-sign; its health shows `bonded: false`. From the
laptop that holds the deployer key:

    set DEPLOYER_KEY=0x...
    node tools/bond-node.mjs <nodeId printed by the other machine>

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
