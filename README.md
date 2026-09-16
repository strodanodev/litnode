# litnode + LIT GAMES cabinet

**litnode** is a portable, dependency-free settlement daemon for the LIT
GAMES arcade mesh: gossip, deterministic matchmaking, ledger replay,
witness co-signing, derived leaderboards, hourly settlement proofs. **The
cabinet** is the static frontend that sits in front of it — a gamer
dashboard players open to see the mesh and launch games.

See [SPEC.md](SPEC.md) for the full as-built spec, and
[docs/NODE-CABINET-SYNC.md](docs/NODE-CABINET-SYNC.md) for exactly what
still needs to be built to connect the two — that file is written to be
handed to an agent working in the node repo.

Live cabinet: **https://lit-games-cabinet.vercel.app**

## Run a node

One folder, no install step, no dependencies beyond Node.js 20+.

1. Install Node.js 20+ if missing: `winget install OpenJS.NodeJS.LTS`
2. Unzip this folder anywhere. Double-click `start-node.cmd`.
3. Answer two prompts: an operator name (`laptop`, `rog-ally`) and the seed
   URL of a node that is already running (blank on the first machine).
4. Allow inbound TCP 7801 once, from an admin prompt, if peers cannot reach
   it:

   ```
   netsh advfirewall firewall add rule name="litnode 7801" dir=in action=allow protocol=TCP localport=7801
   ```

The first line the node prints is its `nodeId`. Health is at
`http://<lan-ip>:7801/health`.

### Bond the node (once per machine)

A node that is not bonded gossips and hydrates rulesets but is excluded
from placement and cannot co-sign; its health shows `bonded: false`. From
the machine that holds the deployer key:

```
set DEPLOYER_KEY=0x...
node tools/bond-node.mjs <nodeId printed by the other machine>
```

Testnet minimum is 1 tLITVM (`contracts/deploy.testnet.json`). Health
flips to `bonded: true` within about ten seconds.

### What to look at

```
http://<ip>:7801/health          identity, bond, peers, chain head, uptime
http://<ip>:7801/snapshot        bonded peers + manifests + root (same root on every node)
http://<ip>:7801/deltas          settled matches
http://<ip>:7801/leaderboard?ruleset=agent-fighter.v1
http://<ip>:7801/epoch           this hour's tree + anchor calldata
```

### Environment overrides

`OPERATOR`, `PORT`, `SEEDS` (comma list), `ROLES`, `PUBLIC_ADDR`, `REGION`,
`OFFLINE=1` (local beacon, no chain), `RPC`, `NODE_STAKE`.

## Run the cabinet

No build step, no dependencies.

```
node cabinet/serve.mjs          →  http://127.0.0.1:5180/
```

Start a node and the header goes green — the cabinet reads
`/health`, `/peers`, `/leaderboard`, `/stats`, `/deltas` from whatever URL
is set in the footer (`http://127.0.0.1:7801` by default, editable,
persisted in `localStorage`). Deploy the `cabinet/` folder as-is to any
static host:

```
cd cabinet
vercel deploy --prod --yes
```

See [cabinet/README.md](cabinet/README.md) for the file-by-file breakdown.

## Settle a real Agent Fighter match on the mesh

On the laptop (needs the Agent Fighter checkout and its `.env`):

```
npm run import:af -- <matchId> --post http://127.0.0.1:7801
```

Any bonded witness on the mesh under a different operator will fetch it,
replay it and co-sign; `/delta/<matchId>` shows `cosigners`. This is a
manual, one-match-at-a-time bridge — the cabinet's Agent Fighter title
does not call it automatically. See
[docs/NODE-CABINET-SYNC.md](docs/NODE-CABINET-SYNC.md) for what automatic
settlement would need.

## Pickle Brawl (attested)

The court process reports to a node when these are set in its environment:

```
LITNODE_URL=http://<ip>:7801
COURT_IDENTITY=<path to identity.json from `node tools/keygen.mjs`>
```

The node settles the report labelled `attested` (it cannot replay it).

## Docs

- [SPEC.md](SPEC.md) — as-built system spec (node API, ruleset interface,
  cabinet architecture, known gaps)
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [docs/NODE-CABINET-SYNC.md](docs/NODE-CABINET-SYNC.md) — handoff report:
  what the node backend needs to implement to sync with the cabinet
  frontend (queueing, live match transport, settlement wiring, per title)
