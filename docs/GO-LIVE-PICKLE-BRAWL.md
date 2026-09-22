# Go live: Pickle Brawl's backend on the desktop node

The target: Pickle Brawl's API, matchmaker and courts run on the desktop
litnode; the game finds them through the mesh; the only hosting left is
the static frontend on Vercel. Everything below was built and tested on
23 Sep 2026. The order matters: the frontend must not switch over before
the node serves the backend, and the node must run a release that knows
`SERVICES` before its config names them.

## What is ready

| piece | where | state |
|---|---|---|
| node support | this repo: `node/publisher-services.js`, `node/gauntlet.js`, `SERVICES=`, `GAUNTLET_GATEWAY_PORT=` | tested (`demo/services.test.mjs`, `demo/gauntlet.test.mjs`), committed, **not released** |
| service bundle | `gauntlets/pickle-brawl.services.json` (API, matchmaker, court-1, court-2) | ran against the production database under a scratch node: all up, no restarts |
| per-match courts | `gauntlets/pickle-brawl.json` | ran the real court from a real placement |
| runtime checkout | `E:/NPC/PICKLEBRAWLv2/pb-runtime` (worktree, engine 16.1.21, Pickle Brawl commit `cbbc0af` since 23 Sep; was `3eb0624`) | dependencies installed; `.dist` from 10 Sep |
| frontend build | `E:/NPC/PICKLEBRAWLv2/pb-runtime/dist-web` (mesh discovery on, linked to Vercel `picklebrawl`) | live on www.picklebrawl.live; rebuilt from `cbbc0af` and deployed 23 Sep (arcade sign-in) |

The development checkout (`E:/NPC/PICKLEBRAWLv2/PickleBrawl`) carries an
uncommitted engine 17 upgrade. The runtime checkout and the frontend build
both stay on engine 16 so the courts and the players' browsers match. Move
them forward together, never one alone.

## Steps

1. **Release litnode.** Commit what is in the working tree (a second
   session has uncommitted work here too: settle what ships), then
   `npm run release`. Protocol is unchanged; the placement rule for
   gauntlet titles changed, so update every node together.
2. **Update the desktop** to that release (`u` on the dashboard, or
   `Invoke-RestMethod -Method Post http://127.0.0.1:7801/update`).
3. **Configure the desktop.** Add to `E:\NPC\LITNODE-DESKTOP\node.env`:
   ```
   SERVICES=E:/NPC/AGENT 24 NODE/gauntlets/pickle-brawl.services.json
   GAUNTLETS=pickle-brawl.v1=E:/NPC/AGENT 24 NODE/gauntlets/pickle-brawl.json
   GAUNTLET_GATEWAY_PORT=8478
   COURTS=pickle-brawl.v1:09b2b84947a10dcee1bc2f05deda59c6f4b98dc6f3c6d193071fd7c82d097e23
   ```
   `RELAY_PORT=8477` stays: the Agent Fighter relay keeps listening there,
   and every Agent Fighter path, HTTP and WebSocket, reaches it through the
   gateway. Then `restart-node.cmd` from an administrator prompt. Do not
   add these lines to a node older than the release in step 1: its gateway
   would take port 8477 and the node would not start.
4. **Check the node.** On the desktop:
   ```
   curl http://127.0.0.1:7801/health
   ```
   `gauntlet.services` lists four services `up`; `wsAddr` is set. From
   anywhere: `https://<wsAddr host>/svc` lists them, and
   `https://<wsAddr host>/svc/pickle-brawl.api/health` answers. Agent
   Fighter still works: its relay answers at `https://<wsAddr host>/`.
5. **Deploy the frontend.** From `E:\NPC\PICKLEBRAWLv2\pb-runtime\dist-web`:
   `vercel deploy --prod`. Load www.picklebrawl.live, sign in, and read
   `window.__PB_CONFIG__` in the console: both base URLs point at
   `…/svc/pickle-brawl.*` on the desktop's relay.
6. **Move AIR Kit's key file.** In the AIR Kit developer dashboard, change
   the partner JWKS URL from `https://picklebrawl-api.vercel.app/.well-known/jwks.json`
   to `https://www.picklebrawl.live/.well-known/jwks.json` (the frontend now
   serves the same file).
7. **Retire the old hosts**, once a day of play has gone through the node:
   suspend the Render matchmaker, delete the `picklebrawl-api` Vercel
   project (after step 6), delete the Railway project (all its secrets are
   in the local `.env` files). The Pickle Brawl repo no longer carries their
   deploy paths (commit `cbbc0af`: `deploy/render`, `deploy/vultr`,
   `railway.json`, the API's `vercel.json` and `push-secrets` are gone), so
   nothing redeploys them. Render also deploys from a `render` branch on
   GitHub; delete it once the service is suspended.
7b. **One sign-in in the arcade** (23 Sep). The runtime checkout is at
   `cbbc0af`, whose API and matchmaker accept the arcade's AIR partner when
   `AIR_PARTNER_IDS` says so; the services bundle sets it. The node reads
   both at start, so run `restart-node.cmd` (administrator prompt) BEFORE the
   arcade ships `login: 'arcade'` for Pickle Brawl: an arcade build that
   lends its token to a backend that does not accept it leaves the game's
   account features refusing every request inside the arcade. Order:
   restart the node, then deploy the arcade (`cabinet/`), then the titles
   (already safe in any order: a title the arcade does not answer falls back
   to its own login after 8 s).
8. **Multiplayer.** The development checkout now has
   `MULTIPLAYER_ENABLED = true`. It reaches players with the next Genesys
   build of `.dist/game.js`, which is also when the runtime checkout and the
   frontend move to that commit and engine together.

## If something goes wrong

- A service keeps restarting: `/health.gauntlet.services[].lastError`
  names it; `litnode.log` has the line.
- The game shows accounts offline: the launcher found no node. Check
  `https://<wsAddr host>/svc` answers from outside, and that the desktop's
  NodeDirectory entry carries the relay address (`npm run fleet`).
- Roll back the frontend with Vercel's previous deployment; the old API and
  matchmaker keep working until step 7.
