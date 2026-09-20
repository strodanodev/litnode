<p align="center">
  <img src="cabinet/icons/icon-512.png" width="96" alt="LIT GAMES">
</p>

<h1 align="center">litnode</h1>
<p align="center"><b>The node that runs the LitVM Games arcade — and the arcade it serves.</b></p>

<p align="center">
  <img src="docs/images/home.png" width="800" alt="litnode arcade — home dashboard">
</p>

<p align="center">
  <i>That's a real screenshot. This node, right now, serving that page.</i>
</p>

## 🕹️ What is this, actually

Two things live in this one repo:

1. **litnode** — a small server (no external dependencies) that gossips
   with other litnodes, matches players, replays games deterministically
   to check who really won, and settles the result on-chain. Run one on
   a laptop, a Pi, or a cloud box and you're part of the mesh.
2. **The cabinet** — the arcade UI every node serves at `/`. Profile,
   ladders, match history, a library of games you can play right in the
   browser. It's also a static site you can deploy anywhere and point at
   any node.

No account to make, no server to trust blindly — every match result is
recomputed locally by the client and by other nodes on the mesh before
anyone calls it a win. If a node claims a result the replay disagrees
with, it gets ignored.

> **Heads up:** this is a testnet prototype, not a finished product. It
> doesn't pay out rewards, the contracts are unaudited, and there's a
> running list of what's not built yet — see [Where things stand](#-where-things-stand-honestly)
> below. We'd rather tell you that up front than have you find out.

## 🎮 The arcade, in pictures

<table>
<tr>
<td width="50%">
<img src="docs/images/arcade.png" width="420" alt="Arcade — the game library"><br>
<b>Arcade</b> — every game on the mesh, one screen.
</td>
<td width="50%">
<img src="docs/images/game.png" width="420" alt="Agent Fighter game page"><br>
<b>Game page</b> — controls, live leaderboard, your record.
</td>
</tr>
<tr>
<td width="50%">
<img src="docs/images/ranks.png" width="420" alt="Ranks — global leaderboard"><br>
<b>Ranks</b> — ladders computed from replayed matches, not a database anyone can edit.
</td>
<td width="50%">
<img src="docs/images/node.png" width="420" alt="Node page — uptime and mesh work"><br>
<b>Your node</b> — uptime, what it's settled and witnessed, what it's bonded.
</td>
</tr>
</table>

Three games ship with it today: **Agent Fighter** (a browser fighting
game, humans vs. AI agents, real matches settle here), **Pickle Brawl**
(physics dodgeball, adapter built, waiting on a court to sign results),
and **Robot Fighting Championship** (in the cabinet, not wired to the
mesh yet).

## 🚀 Try it in two minutes

You need [Node.js 20+](https://nodejs.org). That's it — the node itself
has zero runtime dependencies.

```bash
git clone https://github.com/strodanodev/litnode.git
cd litnode
npm install          # only needed for the chain tooling (ethers, solc)
npm run node          # starts one node on :7801
```

Then open **http://localhost:7801** — that's the whole arcade, served by
the node you just started. Click a game, hit Play. No sign-up wall; a
guest identity is generated for you in the browser, and you can turn it
into a real profile later with a wallet.

Want to see the node run on its own (no games, just the daemon and
dashboard) in plain text instead of the live view?

```bash
LITNODE_PLAIN=1 npm run node
```

Want just the cabinet UI, pointed at some other node?

```bash
npm run cabinet        # http://127.0.0.1:5180 — set the node URL in the footer
```

## 🖥️ Running your own node for real

Anyone can bond a machine into the mesh — it doesn't have to be ours.
The friendliest way in is the hosting harness, which walks through it
one command at a time and tells you exactly what's missing at each step:

```bash
npm run host -- init --operator my-node --seeds https://<a-seed-node>
npm run host -- doctor      # checks your runtime, port, RPC, seeds, clock
npm run host -- start --detach
npm run host -- status      # shows every stage, and the one next command to run
```

Full walkthrough, including bonding a stake and getting listed publicly,
in [docs/HOST-A-NODE.md](docs/HOST-A-NODE.md). If you'd rather point an
agent at it, there's a skill for that too (`host-a-node`).

A node that isn't bonded still gossips and serves the arcade — it just
can't host matches or co-sign results until it is.

## 🧪 Running the tests

```bash
npm test
```

29 suites, run one at a time on purpose (replaying a match spins up a
real sandboxed process, so we don't parallelize it) — takes about four
minutes. This has to be green before anything ships.

## 🗺️ Repo map

```
protocol/   the shared rules — hashing, keys, matchmaking, placement — used by node and browser alike
node/       the daemon: identity, gossip, matchmaking, settlement, witnessing; serves cabinet/ at /
cabinet/    the arcade frontend — plain HTML/CSS/JS, no build step
sdk/        what a game developer imports to put a title on the mesh, plus the node-hosting harness
titles/     the game adapters (Agent Fighter, Pickle Brawl, …)
rulesets/   bundled, hash-pinned game logic
contracts/  the on-chain pieces — staking, title ownership, settlement
tools/      command-line scripts: create a title, bond a node, publish a release, and so on
portable/   the zipped, double-click-and-go build for operators without a terminal
demo/       the test suite
```

## 📚 Building something on top of it

| I want to… | Start here |
|---|---|
| Put my existing game (with its own backend) on the mesh | [docs/BRING-YOUR-BACKEND.md](docs/BRING-YOUR-BACKEND.md) |
| Build a brand-new game against the SDK | [docs/BUILD-FROM-SCRATCH.md](docs/BUILD-FROM-SCRATCH.md) |
| Understand the node's API and the cabinet's architecture | [SPEC.md](SPEC.md) |
| Run and operate a node long-term | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| See what's built vs. still spec | [BUILD-SPEC.md](BUILD-SPEC.md) |
| Sign in players with a wallet | [docs/WALLET-IDENTITY.md](docs/WALLET-IDENTITY.md) |

The full docs index, endpoint list, and mesh-config reference used to
live inline here — they've moved to [SPEC.md](SPEC.md) so this page
could stay a page you'd actually want to read.

## ✅ Where things stand, honestly

Kept in one place and updated with every release:
[SPEC.md §4 — Known gaps and honest zeroes](SPEC.md#4-known-gaps-and-honest-zeroes).
The short version right now: matches replay and settle for real, nodes
gossip and bond for real, but there's no rewards contract, the
publisher-independence story isn't fully demonstrated yet, and the
contracts haven't been through a third-party audit.

Live arcade if you just want to look around first: **https://arcade.litvm.games**

---

<sub>Apache-2.0 · questions and contributions welcome — open an issue.</sub>
