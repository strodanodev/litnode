# Standby host: Agent Fighter and Pickle Brawl on a second machine

On 27 Sep 2026 the desktop went offline and both games went with it:
Agent Fighter's relay and Pickle Brawl's API, matchmaker and courts ran
only there. This page puts a second copy on the m16 laptop, so multiplayer
survives one machine going down.

It is a stopgap. The lasting fix is the title hosting standard (per-match
servers with no secrets, started by whichever node the mesh places), which
removes the need for any machine to hold a database key. Until then the
standby holds the same secrets as the desktop, so use only a machine you
own.

## How clients choose

Both relays run at once. Each game is its own matchmaker, so every player
has to land on the same one. Clients therefore try hosts in a fixed order,
not "newest announced", and use the first one that answers:

| Title | Order | Where it is set |
|---|---|---|
| Agent Fighter | desktop `5b703f…`, then m16 `50bb1da9…`, then any other bonded relay | `PREFERRED_RELAYS` in `packages/client/src/mesh.ts`; a relay counts only if its `/health` says `game: agent-fighter` |
| Pickle Brawl | `VITE_LITNODE_NODE` first, then the rest of `VITE_LITNODE_NODES` | the web build's `.env`; `followBackend` re-checks every minute |

A launch from the arcade is different: it passes the drawn host's relay as
`?ws=`, and both players get the same one.

## 1. Give m16 a public address

m16 must advertise an `https://…trycloudflare.com` address, not
`http://192.168.x.x`. In the Control Plane, open **Configure**, turn the
public tunnel on, then **Show hidden icons → LITNODE → Quit** and reopen the
Control Plane.

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:7801/health | Select-Object nodeId, addr, wsAddr, version
```

`addr` starts with `https://`. If it goes back to a LAN address after a
Windows restart, that is the restart defect (see the troubleshooter). Fix
it before continuing.

## 2. Agent Fighter relay on m16

1. Clone the game and install it (Node 20+ and Git on PATH):
   ```powershell
   git clone https://github.com/strodanodev/agent-fighter C:\litvm\agent-fighter
   cd C:\litvm\agent-fighter; npm ci
   ```
2. Copy `E:\NPC\AGENT FIGHTER\agent-fighter\.env` from the desktop to
   `C:\litvm\agent-fighter\.env`. Use a USB stick or a password manager,
   never chat or email. It holds `SUPABASE_SERVICE_KEY`.
3. Save this as `C:\litvm\run-af-relay.cmd`. It is the desktop's wrapper
   with the paths written in:
   ```bat
   @echo off
   set AF_ROOT=C:\litvm\agent-fighter
   for /f "usebackq eol=# tokens=1,* delims==" %%k in ("%AF_ROOT%\.env") do if not "%%k"=="" set "%%k=%%l"
   set PORT=8477
   set LOG=%~dp0af-relay.log
   :again
   powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8477 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
   cd /d "%AF_ROOT%"
   echo [%date% %time%] relay starting >> "%LOG%"
   call npm run server >> "%LOG%" 2>&1
   echo [%date% %time%] relay exited (%errorlevel%); restarting in 5 s >> "%LOG%"
   timeout /t 5 /nobreak >nul
   goto again
   ```
   Start it once by double-clicking. To start it at sign-in, put a shortcut
   to it in `shell:startup`.
4. Tell the node to front it. The Control Plane rewrites `node.env` on every
   start, so set the value as a user environment variable instead:
   ```powershell
   setx RELAY_PORT 8477
   ```
   Then Quit the Control Plane from the tray and reopen it.
5. Check:
   ```powershell
   $h = Invoke-RestMethod http://127.0.0.1:7801/health; $h.wsAddr
   Invoke-RestMethod (($h.wsAddr -replace '^wss','https') + '/health') | Select-Object game, protocol
   ```
   `game` is `agent-fighter`. Within a minute or two the node publishes the
   new `wsAddr` in NodeDirectory.

## 3. Pickle Brawl services on m16

This takes more work. Do it after Agent Fighter is proven.

1. Clone the PB repo and add a runtime worktree at the commit the live web
   build came from (the desktop's `E:\NPC\PICKLEBRAWLv2\pb-runtime`,
   `git -C E:\NPC\PICKLEBRAWLv2\pb-runtime rev-parse HEAD`). Run
   `pnpm install` in the root, then
   `pnpm install --ignore-workspace` in `services/api` and in
   `services/matchmaker`. Copy that build's `.dist/game.js` as well. The
   courts must run the engine the players' browsers run.
2. Copy `services/api/.env`, `services/matchmaker/.env` and the court key
   `~/.litnode/pickle-brawl-court.json` from the desktop, the same way as
   the AF `.env`.
3. Copy `gauntlets/pickle-brawl.services.json` and
   `gauntlets/pickle-brawl.json` from this repo. Edit `cwd`, `envFiles` and
   `COURT_IDENTITY` to the m16 paths.
4. Set the user environment variables:
   ```powershell
   setx SERVICES "C:/litvm/pickle-brawl.services.json"
   setx GAUNTLETS "pickle-brawl.v1=C:/litvm/pickle-brawl.json"
   setx GAUNTLET_GATEWAY_PORT 8478
   setx COURTS "pickle-brawl.v1:09b2b84947a10dcee1bc2f05deda59c6f4b98dc6f3c6d193071fd7c82d097e23"
   ```
   Quit and reopen the Control Plane. `RELAY_PORT=8477` stays: the gateway
   on 8478 sends Agent Fighter traffic on to it.
5. Check that `https://<m16 wsAddr host>/svc` lists four services `up`.
6. Rebuild the PB web build with
   `VITE_LITNODE_NODES=5b703f1288765c0ca3734ab0625df161121ef45a9eabafaaae539be1add95151,50bb1da9d3dbd72f10c27bfbb709643e7fe6055ddc09879d7d2a8146055c2e05`
   and deploy it. Until then the live client accepts only the desktop.

## 4. Prove it

With m16 up, stop the desktop's relay. For Agent Fighter, end the
`litnode-relay` task. Then:

- Agent Fighter (www.agentfighter.wtf, not launched from the arcade):
  two browsers queue and get a match. The lobby's connection goes to m16's
  relay within a minute (the client re-reads the directory after a failed
  connection).
- Pickle Brawl: same check, after step 3.6 is deployed.

Then start the desktop's relay again. New sessions move back to it.
Players already in a match on m16 finish there.
