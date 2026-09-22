# Build from scratch: a title with no backend

For a game that starts today. The simulation is one deterministic file;
the client and every node run the same file; a match is a signed input log
that anyone can re-run. You write no settlement backend, no ladder, no
result database — the mesh derives all of it from the deltas.

Code: `sdk/index.js` (the title), `sdk/client.js` (the client), the
cabinet shell (`cabinet/app.js`). Tests: `demo/publisher.test.mjs` (client
SDK), `demo/conformance.test.mjs` (the title gate). Agent procedure:
`.claude/skills/build-a-title/SKILL.md`; the rulebook: [HOST-YOUR-TITLE.md](HOST-YOUR-TITLE.md).

## The shape

```
  arcade (cabinet)                     your client (display.url, in the cabinet's iframe)
  ──────────────                       ────────────────────────────────────────────────
  Find match: signs a queue entry,     parseLaunch(): ?room ?player ?match ?build
  verifies the placement, launches     connectShell(): cabinet:init → { player, node, match }
  display.url?room&player&match&build  createSim(title): the same file the node replays
                                       your transport: inputs both ways, same order both sides
                                       createRecorder(): entries + chain head
                                       shell.sign(body): the player's ledger signature
                                       settle(): POST /ledger with both signatures
  host node replays → delta → witness on another operator replays → co-sign → hourly root on litVM
```

## 1. The title

```bash
npm run create-title -- my-game.v1 "My Game"     # titles/my-game.v1.mjs: TUG, a complete replayable sample
npm run conformance -- titles/my-game.v1.mjs      # the gate every node runs before loading you
npm run bundle:title -- titles/my-game.v1.mjs     # rulesets/my-game.v1.js + .json { buildHash }
```

`init(seed, participants, ctx) / step(state, inputs) / done / serialize /
view / scores` and a `display`. Integers or `seededRandom(seed)`; never
`Math.random`, `Date`, the network. `ctx.agents[playerId].stats` are the
four `uint16` core stats, read through `defineBalance`. Full rules:
[HOST-YOUR-TITLE.md](HOST-YOUR-TITLE.md).

## 2. The client

```js
import title from './my-game.v1.mjs';               // the SAME module the node runs (bundle it into your client)
import { parseLaunch, connectShell, localSigner, createSim, createRecorder, matchSeed, externalAgents, settle } from './litnode/sdk/client.js';  // the litnode checkout

const launch = parseLaunch(location.search);        // { ws, room, player, matchId, buildHash, placed }
const shell = await connectShell().catch(() => null);   // null when not inside the arcade
const match = shell?.match ?? null;                 // the placement: matchId, host, hostAddr, wsAddr, beacon, participants, mode, buildHash
if (!match) throw new Error('not launched from a placed match: use the standalone path below');
const me = shell.player.id;                         // this player's key; the shell holds the private half
const them = match.participants.find((p) => p !== me);
const sim = createSim(title, { seed: matchSeed(match), participants: match.participants, ctx: { agents: externalAgents(match.participants) } });
const rec = createRecorder({ matchId: match.matchId, participants: match.participants, rulesetId: 'my-game.v1', buildHash: match.buildHash, mode: match.mode ?? 'casual' });

// each tick, once BOTH inputs for the tick are known (your transport's job), in participant order:
sim.step(inputs); rec.record(inputs); render(sim.view());

// at the end: the shell signs for this player (the key never leaves the cabinet); the other
// player's signature arrives over your transport as a hex string. The HOST settles a placed match.
const delta = await settle({ nodeUrl: match.hostAddr, recorder: rec, signers: { [me]: shell, [them]: theirSignature } });
```

`settle` needs both signatures. One client holds its own shell; the other
player's signature crosses your transport (each client asks its own shell
for `rec.body()`; whoever submits collects both). Either client may submit;
the node settles a match id once.

### The launch

The cabinet opens `display.url` with `?room=LIT-…&player=<key>&match=<id>&build=<hash>`
(and `&ws=<wss>` when the host fronts a relay). `room` is a friendly-room
code both placed players derive from the match id — the rendezvous for your
transport. `connectShell()` then delivers the full placement descriptor in
`cabinet:init`.

### The shell protocol (postMessage, `cabinet/app.js`)

| direction | message |
|---|---|
| game → shell | `{ type: 'cabinet:hello' }` — ask for init |
| shell → game | `{ type: 'cabinet:init', version: 1, player: { id, guest, name }, node: { url, online }, game: { id, title }, chain, air, match?: { matchId, host, hostAddr, witness, wsAddr, beacon, beaconSource, participants, mode, buildHash, rulesetId } }` |
| game → shell | `{ type: 'cabinet:sign', body: { matchId, ticks, head, buildHash } }` |
| shell → game | `{ type: 'cabinet:signed', matchId, player, sig }` or `{ …, error }` — signed only for the match and build the shell launched |
| game → shell | `{ type: 'cabinet:played', matchId }`: the placed match was played; the arcade closes the title |
| game → shell | `{ type: 'cabinet:exit' }` |

### Standalone

Outside the arcade (your own lobby, a dev loop, a test): `createClient`
from `sdk/client.js` (re-exported from `cabinet/client.js`) queues and
verifies placement against any node; `localSigner(kp)` signs with a key
you hold; `matchSeed({ matchId })` is the seed for an unplaced casual
match. The client test in `demo/publisher.test.mjs` is the worked example.

## 3. Transport

Yours. The mesh does not carry frames: it places, replays, witnesses and
settles. A WebSocket relay beside your host node, fronted through the
node's own tunnel (`RELAY_PORT`, [HOST-A-NODE.md](HOST-A-NODE.md)) and
advertised as `wsAddr`, is the pattern Agent Fighter uses; WebRTC with the
node as signalling is roadmap. Whatever it is, every tick's inputs for
every player must reach whoever submits, in order.

## 4. Host, list, verify

```bash
npm run host -- init --operator <you> --roles mesh,host,witness,settler --rulesets ./rulesets/my-game.v1.js --tunnel quick
npm run host -- start --detach && npm run host -- status
```

`GET /titles` lists you with your `display`; the arcade shows it. A queue →
placement → play → `settle` → `GET /delta/<matchId>` round trip is the
acceptance test; `npm run bridge -- check <matchId>` reads it back in words.

## Known gaps, said plainly

- **Characters in a ranked match.** The node hydrates from the registry at
  the placement's block; the shell does not yet pass those characters to
  the client, so a client rendering ranked characters must read the same
  registry itself. Until the registry has a minter, every match hydrates
  `external` (zero stats) — which is what `externalAgents()` gives your
  local sim, and why it reaches the node's exact state root today.
- **The other player's signature** crosses your transport; there is no
  mesh service for it yet.
- **AI AGENT mode** (an agent daemon on the node playing through the same
  input vector) is roadmap; the harness shape is in place.
- Everything in [SPEC §4](../SPEC.md#4-known-gaps-and-honest-zeroes).
