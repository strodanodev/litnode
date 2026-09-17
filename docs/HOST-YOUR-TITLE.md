# Host your title on the litVM Games mesh

litnode is Apache-2.0. Anyone can run it, fork it, and put a game on it. What
makes a title, its assets and its agents *recognised* in the litVM Games
ecosystem is not a listing or a licence — it is a set of on-chain facts that
every node checks for itself. Meet them and you are in: the arcade lists you,
your matches settle into the same epoch roots as Agent Fighter, and your
players carry one profile and one ladder history across every title.

This page is the rulebook. The Claude Code skill `host-a-title` walks it.

## The five-minute version

```bash
git clone https://github.com/strodanodev/litnode && cd litnode && npm install
npm run create-title -- my-game.v1 "My Game"      # titles/my-game.v1.mjs — a complete, replayable sample (TUG)
#   … replace TUG with your rules …
npm run conformance -- titles/my-game.v1.mjs      # the suite every node runs before it loads you
npm run bundle:title -- titles/my-game.v1.mjs     # → rulesets/my-game.v1.js + .json { buildHash }
RULESETS=./rulesets/my-game.v1.js npm run node    # host it; bond the node to be counted
```

Your game client talks to the node exactly as the cabinet does
(`cabinet/client.js`): `POST /queue` to find a match, `GET /match` for the
placement, your own transport for inputs, `POST /ledger` with both players'
signatures at the end. The node replays, a witness on another machine
replays, and the result is what the replay says.

## What a title is

One file. Five functions and a manifest:

| you write | the mesh does with it |
|---|---|
| `init(seed, participants, ctx)` | seeds every host and witness identically from `H(beacon, matchId)`; `ctx.agents` are the hydrated ERC-6699 tokens |
| `step(state, inputs)` | the only way state moves; re-run tick by tick from the signed input log |
| `done(state)` | ends the match |
| `serialize(state)` | hashed into the final state root the players sign and the delta carries |
| `view(state)` | what a client may see — the only place hidden information is filtered |
| `scores(state)` | feeds the derived ladders (`protocol/derive.js`): Elo, credits, stats |
| `display` | how the arcade lists you: `{ title, url, description?, cover?, accent?, controls? }` |

A game the node **cannot** replay (floating-point physics, a proprietary
engine) is an *attested* title: `defineAttestedTitle({ validate, scores,
attestors: [<court pubkeys>], … })`. Your own court signs an outcome report;
the node accepts it only from a court the manifest (or the operator's
`COURTS`) authorizes, validates it against your rules in the sandbox and
settles it labelled `attested`. Pickle Brawl is the reference, and the
ladder shows the label. Prefer replayable when you can — it is the
difference between *verified* and *trusted*.

## The rules of recognition

Every one of these is checked by code, not by us.

**1. Conformance, in a sandbox** — `sdk/conformance.mjs`. The same suite
runs in your terminal, in `bundle:title`, and inside every node's
`installRuleset` before it loads a build. Two stages: STATIC (reads the
text, executes nothing: one ES module with no imports, a default export, a
purity lint for `Math.random`, `Date`, `fetch`, timers, storage) and SANDBOX
(everything that executes — manifest, two replays of seeded inputs from
scratch to the same `serialize()` root, `view()`, `validate({})` — runs in
`node/sandbox.js`: a separate `node --permission` process with an empty
environment, a heap ceiling and a deadline, inside a V8 context that has
NO `Date`, `Intl`, `Math.random`, `process`, `fetch` or `require` at all).
The lint catches mistakes early; the sandbox is the boundary: a title that
reaches for the world by any spelling fails at run time, and a title that
spins or allocates without bound is killed without touching the node.
`display` is a warning: hosting works without it, listing does not.

**1b. A publisher's signature** — nodes load a build from a PEER only when
`{rulesetId, buildHash}` is signed by a key in their `TRUSTED_PUBLISHERS`
(`npm run sign:build -- rulesets/<id>.js`; the default trusted key is the
litVM release key). An operator's own `RULESETS` load regardless, and an
operator may run `TITLE_TRUST=open`. This is the honest state of a sandbox
without a track record: capability-restricted, not proven escape-free.

**2. Bytes pinned by hash** — `buildHash = H('ruleset', bytes)`. Nodes
advertise the hash, fetch each other's builds by it, and refuse a body that
does not hash to what was promised. A retune is a new build and a new hash;
old deltas stay replayable in the build they settled with, forever, on any
node that kept the bytes.

**3. A bonded host** — `NodeStake` on litVM Liteforge (chain 4441). The
snapshot every node computes is the *bonded* set; placement draws hosts and
witnesses from it; an unbonded node's heartbeats are heard and weigh nothing.
Bond with `npm run bond` (1 tLITVM on testnet today). A title hosted only by
unbonded nodes is a title nobody will be placed on.

**4. Settlement on chain** — every settled match becomes a delta; every hour
the deltas become a Merkle tree and its root goes to `EpochAnchor`. A ladder
entry, a credit, a stat is a leaf under an anchored root or it is nothing.
Titles do not get a private ledger. This is also where the economics will
live: nothing charges anything yet, and when micro-transactions arrive they
will be leaves and contract calls under the same roots — not a toll on the
node and not something a ruleset implements.

**5. Agents are characters in the registry** — `ERC6699Registry` v2, this
project's PROPOSED "ERC-6699" interface (no such number is assigned in the
official ERC index; do not describe it as a standard). Characters come in
with four `uint16` core stats, a soul-manifest hash, a config hash and a
stats nonce; only a MINTER forges and only a PROGRESSOR changes stats. A
ranked match reads them from the chain at the placement's block — never
from the submission — and the player key's profile owner must own or
control the token. Your title declares a `defineBalance` mapping and never
reads raw; ranked is sterile (equipment stripped, mapping bounded); the
hydration manifest hashes into the result commitment, and a witness that
reads a different character reaches a different commitment. Your assets are
recognised across titles exactly to the extent they are these tokens and
this mapping. An asset that lives only in your database is yours alone.

**6. Players are keys** — an ed25519 public key signs every queue entry and
every ledger head. Bound to a wallet through `PlayerProfile` (soulbound), it
is one identity across the arcade; `revoked` on chain is `revoked` on every
node within a minute.

## What is yours and what is shared

Yours: the game, its client, its art, its servers if any, its `display.url`,
which node(s) host the ruleset, how you fund them. The code is Apache-2.0
with no field-of-use restriction.

Shared, and not negotiable if you want recognition: the ruleset contract, the
conformance suite, the hash pinning, the bonded set, the epoch roots, the
agent standard, the player identity. A fork that changes any of these is a
different mesh with a different snapshot root — it will run, and it will not
be litVM Games.

## What the harness does not do yet

Said plainly, so the SDK does not imply otherwise:

- No fees, revenue share or micro-transactions are implemented. The contracts
  on Liteforge are unaudited testnet deployments — and, today, the v1 set;
  the v2 registry and anchor in this source are not deployed yet
  (`contracts/MIGRATION.md`), so registry hydration reads nothing live.
- A ranked result is OFFICIAL only when the mesh placed it, both players (or
  an authorized court) signed it, an independent bonded witness reached the
  same commitment, and nobody disputes it. Agent Fighter's own client does
  not sign yet, so its relay-attested results are labelled and unofficial.
- `ctx.agents` is hydrated by the node from the registry for Agent Fighter's
  path; a new title receives the same shape, but the registry has no write
  path for progression yet (BUILD-SPEC §8).
- The arcade launches `display.url` in an iframe with `?ws&room&player`; your
  client has to honour that the way Agent Fighter's does (`mesh.ts`).
- A title's own transport between players is not the node's business. The
  reference relay (`run-af-relay.cmd`) is Agent Fighter's; bring yours.

## Files

```
sdk/index.js               defineTitle, defineAttestedTitle, defineBalance, seededRandom, lerp, clamp, ladders
sdk/conformance.mjs        the suite (CLI + the node's gate)
sdk/bundle.mjs             one-file artifact (esbuild, no minify)
sdk/template/title.mjs     the scaffold: TUG, a complete replayable title
tools/create-title.mjs     npm run create-title -- <name.v1> ["Display Name"]
tools/bundle-title.mjs     bundle + check + write rulesets/<id>.js and .json
node/litnode.js            installRuleset() refuses non-conformant builds; GET /titles lists what the mesh hosts
demo/conformance.test.mjs  the harness's own test
```
