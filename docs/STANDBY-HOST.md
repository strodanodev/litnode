# Standby host: what a second machine may run

On 27 Sep 2026 the desktop went offline, and both games went with it:
Agent Fighter's relay and Pickle Brawl's API, matchmaker and courts ran
only there. The first version of this page put a second copy on the m16
laptop by **copying the desktop's secrets** to it: AF's `.env` with
`SUPABASE_SERVICE_KEY`, PB's `.env` files, and PB's court key.

**That is withdrawn (25 Oct 2026).** A secret is never copied between
machines (docs/SETTLEMENT-STANDARD.md §18, docs/SETTLEMENT-ARCHITECTURE.md
§11). A copied court key let one leaked machine forge every Pickle Brawl
result. A copied service key put the studio database on a laptop. The
lasting fix is the one this page used to call a stopgap's replacement:
match servers without secrets, run on whatever node the mesh places, and
studio backends in the studio's managed env. That is phase 2 of the
settlement architecture.

## What m16 does now

| Runs | Why it's allowed |
|---|---|
| a litnode node (mesh, witness, host), bonded | it holds only its own key |
| the Agent Fighter **ranked** server bundle (`GAUNTLET_SERVERS=agent-fighter.v1`) | a hashed bundle with no secret, fetched from the mesh by hash |
| nothing of Pickle Brawl | PB's court and matchmaker still need a key and `.env` files; they run on the desktop only until PB's phase 2 |
| no Agent Fighter relay | the relay holds `SUPABASE_SERVICE_KEY`; it runs on the desktop only until AF's relay split |

So while the desktop is down, Agent Fighter ranked keeps working on m16,
and Agent Fighter casual and Pickle Brawl are down. That's accepted until
phase 2, when every title survives with the publisher's machines off.

## Undo the old copy on m16 (user steps)

1. Stop the AF relay wrapper (`C:\litvm\run-af-relay.cmd`) and remove its
   `shell:startup` shortcut.
2. Clear the variables the old page set:
   ```powershell
   foreach ($v in 'RELAY_PORT','SERVICES','GAUNTLETS','COURTS') { [Environment]::SetEnvironmentVariable($v, $null, 'User') }
   ```
   Keep `GAUNTLET_GATEWAY_PORT` only if m16 serves the AF ranked bundle.
3. Delete the copies:
   - `C:\litvm\agent-fighter\.env`;
   - the PB runtime's `services/api/.env` and `services/matchmaker/.env`;
   - `%USERPROFILE%\.litnode\pickle-brawl-court.json`.
4. Quit the Control Plane from the tray and reopen it.
5. Check: `npm run host -- doctor` on m16 shows `secrets` green, and
   `Invoke-RestMethod http://127.0.0.1:7801/health | Select-Object -Expand secrets`
   says `clean: True`.

The desktop keeps its PB court key (it was generated there). Rotating it
isn't needed for phase 1: phase 2 retires it with PB's current build.

## How clients choose (until phase 2)

| Title | Hosts |
|---|---|
| Agent Fighter ranked | any node that serves the bundle; the arcade passes the drawn host as `?ws=` |
| Agent Fighter casual | the desktop's relay (`PREFERRED_RELAYS` lists only the desktop) |
| Pickle Brawl | the desktop only (`VITE_LITNODE_NODES` lists only the desktop) |
