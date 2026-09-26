# Fleet telemetry — the contract between a node and LITNODE-CONTROL

**What this is.** One endpoint, `GET /fleet`, that gives an operator's dashboard
everything it shows about a node and the mesh as that node hears it — measured,
signed, from memory. It exists so that the exe's fleet, connection-quality,
traffic and 3D views draw real data instead of fixtures, and so that the exe
never has to invent telemetry of its own. Enforced by `demo/fleet.test.mjs`
(shape, signature, measured links, the graph) and read by the reference
consumer `npm run fleet` (`tools/fleet.mjs`), which is the ground truth for
"how do I verify a document".

Since litnode **0.11.12**. A node before that answers 404: show "update the node".

---

## 1. Reading it

```
GET http://127.0.0.1:<PORT>/fleet?nonce=<16..64 hex>
```

- No auth, CORS `*` (an Electron renderer or a page at `http://localhost:PORT/` reads it as-is).
- Cheap: no RPC call, no disk read; everything is what the node already holds. Poll every **2 s**.
  Above ~5 req/s from one client you are the load, not the mesh.
- `nonce` is optional. Without it `proof` is `null` — fine for a local dev
  glance, not for anything the operator will trust.

### Verifying (do this before showing a screen)

The document carries `digest` and `proof`. Verify exactly as `tools/fleet.mjs → readFleet()` does:

1. Remove `digest` and `proof` from the object; `h('fleet', body)` (`protocol/canonical.js`) must equal `digest`.
   `h` is SHA-256 over `'fleet' + '\0' + canonical JSON` of the body (sorted keys, no whitespace).
2. `checkChallenge(proof, { expectNodeId, nonce, expectDigest: digest })` (`protocol/challenge.js`) must be `{ ok: true }`.
   `proof` is `{ nodeId, nonce, addr, at, digest, sig }`, `sig` = Ed25519 over `'whoami'`-tagged canonical body by the
   **node key** — the same key the operator bonded on NodeStake. `at` must be within ±120 s.
3. `expectNodeId`: pin it. The exe already knows the node it started (it can read `data/identity.json`'s public key,
   or take the first answer's `nodeId` and keep it). A document another key signed is refused, whatever it says.

Both modules are plain ES modules with no dependencies; the cabinet vendors
them in `cabinet/protocol/` and the exe can vendor the same two files
(`canonical.js`, `challenge.js`, plus `keys.js` they import).

---

## 2. The document

Top level: `at nodeId version protocol cabinet self chain mesh peers graph rooms queue titles recent events guardian digest proof`.
The test asserts exactly this set of keys.

### `self` — the node the exe runs
| field | meaning |
|---|---|
| `nodeId operator roles region version addr lanAddr wsAddr` | identity and what it advertises |
| `startedAt uptimeMs` | process uptime |
| `bonded wallet eligible bond{eligible,delegate,amount}` | on-chain standing (`bonded` null = no stake contract / unread); `wallet` = the operator address that bonded this node — the attestation, public on chain |
| `tunnel{mode,state,url,restarts,lastError}` | the quick/named tunnel, or null |
| `relay{url,port,state,checkedAt,ms,lastError}` | the relay tunnel as a WebSocket client sees it: `verifying` → `up` (a WebSocket opened through the public hostname; only then is `wsAddr` advertised and announced) → `down` (three misses in a row: `wsAddr` withdrawn from the heartbeat and NodeDirectory) / `unreachable` (never opened in 5 min: hostname rotated). Null when the node fronts no relay. **Show `down` red** — it is what a player would call "server offline" |
| `inbound{peers,reachable}` | peers that pushed gossip to us in the last 30 s; `reachable` null = no peers known |
| `update{available,latest,checkedAt,lastError,registry,channel,canRollback,applying,date}` | registry-gated release check; `registry` = `active` | `pending` | `revoked` | `unset` | `unchecked` | `unreadable` (0.11.15) |
| `sandbox` | replay sandbox status |

### `chain`
| field | meaning |
|---|---|
| `rpc offline head headTs lagS` | RPC URL; head block and its timestamp; seconds since that block (Liteforge: 0.25 s blocks, so lag > 10 s is the RPC or the poll, not the chain) |
| `rpcMs rpcLastMs rpcCalls rpcFailures rpcAt lastError` | RPC round trip: moving average and last; counts since start |
| `matchBook.purse{address,balance,balanceWei,gasPriceWei,txType,matchesLeft,low,readAt}` | the **hot key**: zkLTC balance, the price the last send paid, ~matches it still covers as host (670k gas each), `low` under 25 — **show this red**; `txType` 2 = EIP-1559 |
| `matchBook.{cursor,scanRange,events,sends,lastTx,lastError,hosting,seated,windows,delegated,funded,enrolled}` | settlement driver state |
| `matchBook.sent[]` | the hot key's transactions since start, newest last (up to 50): `{ what, matchId, tx, at, ok, gasUsed, block }` — `ok` null until the receipt is read, then true/false (reverted). The operator's ledger of work (0.11.15) |
| `contracts{generation, NodeStake, NodeDirectory, MatchBook, EpochAnchor, ReleaseRegistry, TitleRegistry, PlayerProfile, ERC6699Registry}` | the addresses THIS process runs against and the generation its `deployed.testnet.json` claimed — compare with your own copy to spot skew (0.11.15) |
| `announcer{address,delegated,funded,lastTx,lastError,entry}` | the NodeDirectory announce key (same key as the purse today); `entry` = what the directory holds for this node right now `{ url, wsAddr, updatedAt }` or null (0.11.15) |
| `recentBlocks[]` | the last 12 blocks this node sampled: `{ number, hash, timestamp }` — a real block strip |

### `mesh` — the mesh as this node hears it
| field | meaning |
|---|---|
| `active` | **fresh peers + self** (heartbeat ≤ 2 s old) — the "active nodes" number |
| `known bonded eligible incompatible` | heard in the last 10 min; bonded on chain; in the placement set; on another protocol |
| `versions` | `{ "0.11.12": 4, "0.11.11": 1 }` — version skew at a glance |
| `snapshotRoot epoch` | the placement snapshot root every node should agree on |
| `gossip{outPerMin,outBytesPerMin,inPerMin,inBytesPerMin}` | real traffic, last 60 s — the traffic chart |
| `urls unreachable[]` | peer URLs known; URLs that stopped answering pushes |

### `peers[]` — one row per node heard
| field | meaning |
|---|---|
| `nodeId operator addr wsAddr region roles version protocol rulesets` | identity |
| `fresh ageS clockSkewS` | heartbeat ≤ 2 s old; age in seconds; their clock − ours |
| `bonded wallet eligible` | chain standing; the wallet that bonded them (null = unbonded); in the placement set |
| `link` | **measured on our gossip push to them, every second**: `rttMs` last round trip, `emaMs` moving average, `loss` 0..1 over the last 20 pushes, `samples sent ok okAt failAt`, `direct` (an OK push in the last 10 s); `inboundMs` = what *their* heartbeat says about reaching us; `direction` = `both` | `outbound` | `inbound` (they reach us, we cannot reach them — a peer on another subnet pushing to our tunnel; still a live link) | `none`. Null only when neither side has measured anything (heard through a third node) |
| `quality{score,grade}` | 0–100 and A–F from freshness, loss and rtt (§3) — the **connection-quality** colour |
| `links[]` | what *they* reported reaching in their heartbeat: `{ id: 16-hex prefix, ms }` — the edges of the graph from their side |

### `graph` — for the 3D view
```
nodes: [{ nodeId, operator, self, fresh }]
edges: [{ from, to, ms, measured }]
```
`measured: true` — this node's own push to that peer, `ms` its moving average.
`measured: false` — an edge a peer reported in its heartbeat (its own
measurement, learned through gossip). With N nodes fully meshed you get up to
N·(N−1) directed edges; a NAT'd node shows edges *from* it and none *to* it.
Draw `ms` as length or colour; drop edges older than one refresh. Node
position is yours to choose — a stable hash of `nodeId` gives a stable layout.

### `rooms[]` — matches this node holds a placement for (placements live 15 min)
| field | meaning |
|---|---|
| `matchId room` | `room` = `LIT-<matchId>`, the room name the title is launched with |
| `rulesetId mode bucket participants host witness panel` | the placement |
| `ours seated` | this node is the host / on the attestation panel |
| `placedAt state` | `placed → committing → committed → settled → final \| void` on chain; `played` = settled locally, casual (no chain) |
| `commitTx attests chainEvents disputes settledAt ticks` | the chain trail; `attests` counts toward 3 |

### `queue[]` — who is waiting: `{ rulesetId, mode, waiting, players[], buckets[] }`
### `titles[]` — `{ rulesetId, display, hosts, bondedHosts, published }`
### `recent[]` — the last 20 decided matches from the chain log: `{ matchId (bytes32 key), status, block, tx, at }`
### `events[]` — the last 50 node events worth a line (never the per-second ticks): `{ t, type, …data }`.
Types you will see: `placed settled attested chain-final backstop tx tx-failed gas-low witness dispute ruleset stakes bond
tunnel announced update incompatible peer.forgotten seed-refused proposed enrolled`.

---

### `guardian` — lite-guardian reports this node received (advisory; `POST /guardian`)

`{ matches, reports, flagged[] (last 20 matchIds), flaggedCount, guardiansLastHour, recent[] (last 20: { matchId, guardianId, verdict, failed, at, receivedAt }) }`. In memory; resets with the process. A flag is also an `events[]` entry of type `guardian`.

## 3. The quality grade

```
base:   age ≤ 2 s → 100 · ≤ 10 s → 80 · ≤ 60 s → 50 · else 20
loss:   − 60 × loss                       (over the last 20 pushes)
rtt:    − 5 (> 300 ms) · − 15 (> 800 ms) · − 30 (> 2 s)   on the moving average
inbound only (they reach us, we do not reach them): − 5, rtt from their side
no link (never pushed; heard through others):  capped at 75
grade:  A ≥ 90 · B ≥ 75 · C ≥ 50 · D ≥ 25 · F
```
A is "fresh, lossless, fast". B is typically a NAT'd peer we hear but cannot
push to. C/D is a peer going quiet. F is gone (it is forgotten entirely after 10 min).

---

## 4. Segregation (from the build report, 22 Sep 2026)

- **The exe owns** the process (start/stop/restart, tray, autostart), `node.env`, log capture, firewall help, picking
  and extracting the node zip, triggering `/update`. It **reads** `/fleet` for every number it shows and invents none.
- **The cabinet owns** everything that signs with a wallet (bond, delegate, faucet, profile) and the player's side.
- **The node owns** the truth: identity, gossip, placement, replay, chain transactions, this document.

Attestation of the exe to the account owner stays where it is: on chain. The exe shows `self.bond` and `self.bonded`
(the wallet that bonded this `nodeId`), never a key of its own. The "sign node challenge" browser key in 0.1.0 is
not this proof — `proof` here is the node key's.

---

## 5. Putting more nodes on one machine (a demo of fewer than ten)

```
npm run fleet -- spawn --count 3            # 7811, 7812, 7813, seeded from the watched node, roles mesh,witness
npm run fleet                                # watch the seed: every peer, rtt, loss, grade, rooms, events, proof ok
```
Spawned nodes advertise `http://127.0.0.1:<port>`: nodes on this machine
reach them directly, remote nodes hear them through the seed (they show as
fresh with `link: null` there). They are unbonded unless the operator bonds
them (`npm run bond`) and unfunded unless their hot key is sent zkLTC; the
mesh, gossip, placement and the graph need neither.
