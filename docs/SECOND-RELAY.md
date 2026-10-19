# A second Agent Fighter relay

On 17–18 Oct 2026 the desktop's relay lost its tunnel name and Agent Fighter
said SERVER OFFLINE for 18 hours, because the desktop (`5b703f…`) was the
only node on the mesh announcing a relay. 0.11.27 now restarts a relay
tunnel that stays dead (`node/litnode.js:619-643`), which shortens an outage.
It does not remove the single point of failure. This page is how to get a
second announced relay, and how to prove the title survives losing the first.

Written 19 Oct 2026 against litnode 0.11.28 and Agent Fighter's
`packages/client/src/mesh.ts`. Read `docs/STANDBY-HOST.md` first; this page
narrows it to the one thing that is missing and corrects where the world
has moved since.

## The short answer

- **The candidate is m16, id `50bb1da9…`.** It is already named second in
  the client's `PREFERRED_RELAYS`, it already has the Agent Fighter checkout
  and `.env` from the 5 Oct standby setup, and on 5 Oct it announced a relay
  and passed a simulated desktop outage. Restoring it needs no code change
  anywhere.
- **The other bonded operators (`18d67e…`, `f0fb2a…`) are not candidates
  for the lobby relay**, even though OPERATORS §6 lets them host Agent
  Fighter matches. See "Why a bundle host is not a relay" below.
- Two players meet on the same relay because the client does not choose
  "newest": it takes the first live relay in a fixed order. No new id has to
  be added for m16.

## Why a bundle host is not a relay

OPERATORS §6 (`GAUNTLET_SERVERS=agent-fighter.v1`) makes a node run Agent
Fighter's **per-match** server for matches the mesh places on it. That path
is real and good: an arcade launch passes the drawn host's relay as `?ws=`,
both players get the same one, and no publisher is needed. But it is not the
thing `www.agentfighter.wtf` connects to when a player queues from the page.
That is the **title relay** (`npm run server`, `packages/server/src/server.ts`):
the lobby, the matchmaker, and the account API in one process.

A bundle-only node has no title relay behind its gateway. The gateway then
answers `/health` with its own status, not the relay's
(`node/gauntlet.js:223`, `status()` at `:320`), which has no `game` field.
The client's probe requires `game === 'agent-fighter'`
(`mesh.ts:138-145`), so it classes the node `'other'` and never picks it
(`mesh.ts:164-165`). If every real relay is down, the pick is `null` and the
client falls through to `PROD_MATCH_WS`, the retired Railway host
(`main.ts:436`, `:448`), which is SERVER OFFLINE again. So a bundle-only
operator that announces a `wsAddr` does not help the lobby, and it makes
`npm run fleet -- relay` look healthier than a player's experience (see
Verification, "What the probe does not tell you").

Running the real relay on another operator's node means giving that machine
the publisher's database key (`SUPABASE_SERVICE_KEY`,
`packages/server/src/persist.ts:1930-1944`), or running it on the throwaway
in-memory economy (`AF_ALLOW_DEV_ECONOMY=1`), which accepts any identity a
client claims and must never be public. Neither is acceptable for other
people's machines. That is the "secrets stay in managed env" rule, and it is
why m16, a machine the publisher owns, is the only candidate until the
relay itself is made secret-free.

## 1. What m16 needs

Nothing new is installed if the 5 Oct setup is intact. It needs, line by
line, to be in this state. Check it before changing anything.

### The machine

| Item | State required | How to check on m16 |
|---|---|---|
| litnode | 0.11.27 or later (earlier builds never mend a dead relay name) | `(Invoke-RestMethod http://127.0.0.1:7801/health).version` |
| Agent Fighter checkout | `C:\litvm\agent-fighter`, current master, `npm ci` done | `git -C C:\litvm\agent-fighter log -1 --oneline` |
| Agent Fighter `.env` | already there since 5 Oct; **do not copy a new one** | `Test-Path C:\litvm\agent-fighter\.env` |
| Relay wrapper | `C:\litvm\run-af-relay.cmd`, running, restarting itself | `Get-NetTCPConnection -LocalPort 8477 -State Listen` |
| `cloudflared` | on PATH | `cloudflared --version` in a new terminal |

If the `.env` is missing, stop. Do not copy one from the desktop by USB or
chat to fix it; decide with the publisher how m16 should get its secrets.
`docs/STANDBY-HOST.md` step 2.2 predates that rule.

### node.env

The Control Plane rewrites `node.env` on every start (OPERATORS,
Troubleshooting), so on m16 these are **user environment variables**, set
once with `setx` and picked up after the tray's **Quit** and a reopen. For a
zip or source install they are plain `node.env` lines. Same names either way:

```ini
# the node's own public URL: a quick tunnel, announced on NodeDirectory
TUNNEL=quick

# the Agent Fighter relay (npm run server) listens here; the node fronts it
# with a second quick tunnel and advertises that tunnel as wsAddr
RELAY_PORT=8477
```

```powershell
setx TUNNEL quick
setx RELAY_PORT 8477
```

That is the whole relay configuration. In `node/litnode.js`: `RELAY_PORT`
becomes `relayPort` (`node/cli.mjs:104-108`); with no gateway configured the
relay tunnel fronts that port directly (`relayFront`, `litnode.js:561`) and
`createTunnel` starts for it (`:1667-1670`). The relay is verified before it
is announced: a WebSocket must open through the new name
(`relayCheck`, `:619-634`). Only then does `wsAddr` ride the heartbeat and
the announce transaction (`:645-658`).

Do not set `GAUNTLETS` or `GAUNTLET_GATEWAY_PORT` for this goal. Adding
`GAUNTLET_SERVERS=agent-fighter.v1` plus `GAUNTLET_GATEWAY_PORT=8478` later is
compatible: the tunnel then fronts the gateway on 8478, which forwards every
path that is not a match room to the relay on 8477
(`litnode.js:1591`, `gauntlet.js:233`, `:293`), so `/health` is still the
relay's. It is a separate improvement (arcade matches served from the
bundle, no checkout needed), not a requirement for a second lobby relay.
Leave it until the relay is proven.

### Bonding and announcing

`50bb1da9…` is bonded on the generation-3 NodeStake, but a node is eligible
only while that stays true, and it announces only if its announcer key is
delegated and funded (`announce: not-delegated` / `unfunded` in `litnode.log`).
Keep the announcer funded: every relay name change is a transaction, and a
quick tunnel that rotates (0.11.27) spends one each time.

### Why it stopped announcing

I could not read m16 from here, and the public RPC throttled this checkout
while I tried the directory (see Verification), so the cause is not known.
Work down the list on m16 and stop at the first that fails:

1. `Invoke-RestMethod http://127.0.0.1:7801/health` shows `relay.state`.
   `off` means no `RELAY_PORT` reached the node (the Control Plane
   re-attached to an old `node.exe`: 5 Oct gotcha. Tray Quit, end the port
   owner, reopen). `down` or `unreachable` means the tunnel or the relay is
   the problem. `verifying` for minutes is a tunnel that never became
   reachable and should rotate by itself on 0.11.27.
2. Port 8477 not listening: the wrapper is not running or the relay exits
   at start. Read `C:\litvm\af-relay.log`. A "refusing to start" about
   `SUPABASE_URL` means the `.env` was lost.
3. `version` older than 0.11.27: update the node from its own page
   (**Update node**) before anything else.
4. `addr` begins `http://192.168.`: the node's own tunnel is not up, so the
   node does not announce at all (`litnode.js:650`). Fix `TUNNEL`.
5. `announcer.lastError` in `/fleet` or `/health`: delegation or funding.
6. m16 is off or asleep. Then it is a power plan or a hardware problem, not
   a litnode one.

When the machine is healthy, within a few minutes of a start the log says
`relay: wss://… answers a WebSocket (… ms) — advertising and announcing`,
then `announce: sent`.

## 2. What the client does with two relays

All in `agent-fighter/packages/client/src/mesh.ts`. On a page served over
https, `discoverRelay` runs at boot (`main.ts:451`, `refreshRelay` at
`mesh.ts:202`) and:

1. Reads every key in NodeDirectory and, for each, its entry and its
   NodeStake standing (`:151-158`).
2. Keeps an entry only if its `wsAddr` is `wss://…`, it was updated within
   7 days (`FRESH_S`, `:64`) and the key is bonded.
3. Sorts the survivors by position in `PREFERRED_RELAYS`: desktop `5b703f…`
   first, m16 `50bb1da9…` second, everyone else after them, newest
   announcement first among the others (`:73-76`, `:159-160`).
4. Probes every candidate's `/health` at once (6 s each) and takes **the
   first in that order whose `game` is `agent-fighter`** (`:164-166`). If
   none is `ok`, it takes the first that merely did not answer, never one
   that answered as another title.
5. Caches the winner for 2 minutes (`CACHE_MS`, `:62`), and `matchWsUrl()`
   reads that cache (`main.ts:445-450`).

So the choice is deterministic and does not depend on who announced last:
every browser that can reach both relays picks the desktop while the
desktop's `/health` says `agent-fighter`, and picks m16 only when it does
not. Two players meet on the same relay because they apply the same fixed
order to the same shared directory. The one way to split is a player who can
reach the desktop and one who cannot (a regional block on the desktop's
quick-tunnel name): they would land on different relays and not match. That
is the reason the order is fixed, and there is no cheap fix for a partial
partition.

**`PREFERRED_RELAYS` does not need m16's id added.** It is already there. It
would need a new id only for a third relay: the id is listed in the same
array and Agent Fighter is redeployed. Without that, a third relay ranks
after both and is used only when both are down.

Two more behaviours matter for failover:

- A relay that refuses a connection triggers a re-read once a minute
  (`relayFailed`, `mesh.ts:176`; `main.ts:3493-3500`): the lobby retries on
  whatever the directory now names. A player sees a longer CONNECTING, not
  OFFLINE, as long as the probe finds a live relay.
- The player's AIR token goes only to relays in `PREFERRED_RELAYS`
  (`isPublisherRelay`, `mesh.ts:130-135`), and the wager and arcade modes
  that spend credits pause while none of them answers (`publisherOnline`,
  `:189-196`). m16 counts as a publisher relay, so wagers keep working
  through the desktop's outage. A relay outside that list would play
  casual matches only.

## 3. What must change for two relays to coexist

**Nothing is required in litnode or the client for m16 + desktop.** They are
already designed for it. Specifically:

- litnode: each node announces its own `wsAddr` under its own key
  (`litnode.js:651`), so two entries coexist in NodeDirectory. The relay
  check is per node (`:619`), and a dead relay withdraws only that node's
  `wsAddr` (`:627`).
- Client: ranking, probing, fallback and retry above.

Two improvements are worth doing. Neither blocks bringing m16 up, and both
are outside this page's remit (this change touches only this file):

1. **`tools/fleet.mjs:109` does not model the client.** `relay` picks the
   newest bonded fresh entry and opens a WebSocket at the root; it ignores
   `PREFERRED_RELAYS` and never reads `/health`. With one relay that was a
   fair stand-in. With two it names whichever announced last, which may not
   be the one a player gets, and it counts a bundle-only node as healthy.
   It should rank like `mesh.ts:159-166` and read `/health` for
   `game: agent-fighter`.
2. **`mesh.ts:22` reads one RPC, with no fallback.** A throttled endpoint
   ("Bandwidth limit exceeded", seen from this machine on 19 Oct) makes
   `discoverRelay` throw, `refreshRelay` swallows it (`:205`), and a client
   with an expired cache falls to `PROD_MATCH_WS`, the retired Railway host.
   So the second relay does not help a player whose directory read fails.
   litnode has had `RPC_FALLBACK` since 0.11.23; the client wants the
   same, or a larger cache window.

The lasting fix is a relay with no secrets in it, which any operator could
run. At that point `PREFERRED_RELAYS` should become a list read from a
registry rather than two baked ids.

## 4. Verification

### 4.1 Announced

From any machine, no key needed:

```bash
npm run fleet -- relay --arcade
```

Done when its output is exactly this shape, **with m16 listed**:

```text
contracts: generation 3 from https://arcade.litvm.games/contracts.json
  NodeDirectory 0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df
  NodeStake     0x3CFe2D006d946A1E0E5Cf6B3E0958aFc3fF73717
  5b703f128876 bonded   fresh <ISO time> wss://<desktop-name>.trycloudflare.com
  50bb1da9d3db bonded   fresh <ISO time> wss://<m16-name>.trycloudflare.com
  …other keys, usually "(no relay)"…
relay: wss://<one of the two> (<12 hex>) opens a WebSocket in <n> ms — a title finds the mesh
```

and exit code 0 (`echo $?`). Two rows with `bonded fresh wss://…` is the
point. The final line names the **newest** of them, not the client's choice.
Failure shapes: `NO bonded, fresh entry advertises a relay` (exit 1) means
neither relay is announced; `… does NOT answer` (exit 1) means the newest
one is announced but its tunnel is dead.

Also prove that m16's relay is the right *game*:

```powershell
foreach ($u in @('<desktop wsAddr>', '<m16 wsAddr>')) {
  "$u -> " + (Invoke-RestMethod (($u -replace '^wss','https') + '/health')).game
}
```

Both lines end `agent-fighter`.

### What the probe does not tell you

The RPC can throttle you. On 19 Oct three runs from this checkout read an
empty directory, one entry, and one entry reported `unbonded`, while the
same endpoint answered `Bandwidth limit exceeded` when queried directly.
A directory read that comes back short is not the mesh's state. Re-run
before concluding anything. `tools/fleet.mjs` reads the arcade's single RPC
(`contracts.json`); a node reads its `RPC_FALLBACK` list too
(`node/cli.mjs:95-97`), so the node's own `/health` and `/peers` are a
second opinion on what the directory holds.

`fleet` also opens a WebSocket only at the root; a gateway with no title
relay behind it opens one too. Always follow it with the `/health` check
above.

### 4.2 Selection, without touching the desktop

This proves the client's failover logic exactly, and costs the desktop
nothing. In Chrome, open `https://www.agentfighter.wtf` in two windows and,
in each, DevTools > Network > Network request blocking, add the desktop's
hostname (the host part of its `wsAddr`). Then clear the cached pick and
reload:

```js
localStorage.removeItem('af.mesh-relay'); localStorage.removeItem('af.mesh-publisher-relays'); location.reload();
```

After about 10 seconds:

```js
JSON.parse(localStorage.getItem('af.mesh-relay'))
```

must show **m16's** `wsAddr`. Queue the two windows against each other: they
get a match, on m16 (its `af-relay.log` shows both connections). Remove the
block and clear the cache again: they return to the desktop.

### 4.3 Failover for real (a user step on the desktop)

This stops the desktop's relay, which ends any match running on it. Do it
when nobody is playing, and not from this checkout: `E:/NPC/LITNODE-DESKTOP`
is the production install.

1. On the desktop, end the `litnode-relay` scheduled task and the process on
   port 8477 (STANDBY-HOST §4). Leave the `litnode` task alone.
2. Watch the desktop's `litnode.log`. The node's relay check runs every
   minute and withdraws after three misses (`RELAY_FAILS`, `litnode.js:615`),
   so about three minutes later:
   `relay: … stopped answering — withdrawing wsAddr from the heartbeat and the directory`.
   The announce follows after a 4 s debounce (`:602`).
3. Players do not wait for that. Their probe sees the desktop's `/health`
   fail at once, so within 2 minutes (the cache) or on the next failed
   connection (`main.ts:3493`), they move to m16. Run 4.2's check in a
   normal, unblocked window: `af.mesh-relay` names m16.
4. `npm run fleet -- relay --arcade` now shows the desktop as `(no relay)`
   and m16 as the pick. Two browsers queue and get a match on m16.
5. Restart the desktop relay within five minutes. After six misses in a row
   (`RELAY_ROTATE_FAILS`, `:615`, `:631`) the node restarts cloudflared for a
   fresh name by design; harmless, but the desktop then announces a new
   hostname and a longer re-verification. When the relay answers again,
   the desktop announces again by itself and new sessions go back to it.
   Players already on m16 finish there.

Pass criteria: during step 3, a fresh browser reaches CONNECTING and then a
match without SERVER OFFLINE; and after step 5 `fleet` shows two relays
again.

## Done when

- `npm run fleet -- relay --arcade` lists the desktop and `50bb1da9…`, both
  `bonded fresh wss://…`, and exits 0.
- Both `/health` calls say `agent-fighter`.
- 4.2 passes with the desktop's hostname blocked.
- 4.3 has been done once, with the desktop restored afterwards.

## Not covered

- Pickle Brawl's standby (STANDBY-HOST §3). It has the same secrets
  problem, and its own client order.
- Other operators as lobby relays. That needs a relay with no secrets in it
  first (the title hosting standard in STANDBY-HOST's opening).
- m16's actual state today: not read from here. The first section lists
  how to read it.
