# cabinet — the arcade dashboard

A gamer dashboard in the LIT GAMES look — Y2K future: painted sky and cyan
wireframe behind dark glass panels, chrome wordmark, peach primary, mono
uppercase labels, chamfered cards with tick-mark edges. Plain HTML/CSS/JS —
no build step, no dependencies.

**Brand art:** drop the site's painted-sky artwork in as `cabinet/bg.jpg` and
it replaces the procedural sky (the wireframe still draws over it). Until
then `bg.js` paints a stand-in sky + clouds + mesh.

    node cabinet/serve.mjs          →  http://127.0.0.1:5180/

Start the node (`start-node.cmd`) and the header goes green. Node URL is
editable in the footer (localStorage). Installable as a PWA.

## Views

    #/, #/games     Arcade (landing page) — the arcade window loads the featured
                    title (first playable in config.js) and plays it in the page;
                    the strip below it switches titles; then the library
    #/home          Home — node status band, profile card, rating chart, game
                    library, leaderboard, cards panel
    #/game/<id>     one title — hero, about, controls, mesh info, leaderboard,
                    your record + match history
    #/leaderboards  top-3 rank cards (bracket badge, tier, rating / win rate /
                    streak) + full table per title, player search
    #/cards         live litVM testnet NFTs (nfts.js): #/cards/0x…, an address
                    typed on the page, the profile or AIR wallet, or "My
                    wallet"; with none, the newest Rapture Cards mints. The old
                    #/characters and #/inventory links land here
    #/match/<id>    the match receipt: each on-chain step, re-checked from the
                    browser (receipt.js)
    #/node          status band, then tabs: Overview (setup checklist, this
                    node) · Wallet & gas · Network · Activity · Run a node
    #/build         developer docs: How it works · SDK (short form of docs/SDK.md)
    #/download      the LITNODE Control Plane download (download.js)
    #/ro3           sign-in, account link and zkLTC shop for the RO3 on LITNODE
                    launcher (ro3.js; opened by the launcher, not the nav)

The header shows LOGIN when signed out; signed in, the avatar opens the
account menu (address, level, Profile / My cards / Ranks / Rename, Sign out).
Sign-in is AIR (Google, email or a wallet), a device already bound to a
wallet, or your own wallet (docs/UNIVERSAL-LOGIN.md, docs/WALLET-IDENTITY.md).

## Find match

On a title's page, *Find match* is the mesh: `client.js` signs a queue entry
with the player key, polls `/match` for the pair, fetches `/snapshot`,
recomputes `placement()` locally and compares. ACCEPT launches the title
against the drawn host's `wsAddr` with the descriptor in `cabinet:init.match`
(Agent Fighter also gets `?ws=`); REFUSE says why (the node named a host the
rule did not produce, or the eligible set moved) and does not launch. The
node is a directory, never an authority.

## Node uptime & mesh work

The highlighted band at the top of Home (and the Nodes page) shows:

    UPTIME    24 h ring + 10-minute strip (7-day heatmap: Nodes › Activity) —
              observed by this dashboard while open (localStorage, per node
              URL). "Up" is the node's own figure (/health startedAt,
              uptimeMs).
    WORK      with the signed /fleet: the hot key's commits, attests, settles,
              finals, backstops and anchors since start; always: matches this
              node settled as host and witness co-signatures, counted from the
              settled deltas (any node with the same deltas counts the same).
    ON CHAIN  bond amount, operator wallet balance, hot-key gas (from /fleet),
              operator address — read live from litVM (chain.js, read-only,
              calldata built with the node's own staking/keccak modules).

There is no reward figure. There is no rewards contract on litVM (Season
Zero is points only, docs/REWARDS.md); the bond is collateral, not a yield.
A number nothing can pay is a claim, so the cabinet does not show one.

## Deploy

Live: https://arcade.litvm.games (Vercel project `cabinet`, static, no
build). From this folder:

    vercel deploy --prod --yes

Deploy with every litnode release whose changelog says the cabinet changed;
`version.js` must equal the release (`demo/cabinet.test.mjs` checks it).

The folder is self-contained: `protocol/` is a generated copy of the
protocol modules the cabinet runs, and `contracts.js` of the deployed
addresses (`npm run vendor:cabinet` from the repo root; `MANIFEST.json`
pins each by sha256 and `demo/cabinet.test.mjs` fails on drift — never edit
the copies). `vercel.json` sets cache headers; `serve.mjs` and this README
are excluded by `.vercelignore`.

Hosted → local node: an https page reading http://127.0.0.1:7801 gets
Chrome's one-time "local network access" prompt; the node answers with
`Access-Control-Allow-Private-Network: true` for older PNA builds. Point the
footer's node URL at a public https seed for players who don't run a node.

## Titles

    01  Agent Fighter                 https://www.agentfighter.wtf/       ruleset agent-fighter.v1
    02  Pickle Brawl                  https://www.picklebrawl.live/       ruleset pickle-brawl.v1
    03  Robot Fighting Championship   https://rfc.litvm.games/            ruleset afc.v1 (casual)
    04  Rapture Chess                 https://chess.litvm.games/          ruleset rapture-chess.v1 (featured)
    05  Ragnarok Online 3             desktop launcher, #/ro3             not settled by the mesh

The roster is `GAMES` in config.js. A mesh title that isn't in it, such as
FLOOD CONTROL (`flood-control.v1`, play.bagyo.app), is listed from its
ruleset's own `display` when the node serves it.

PLAY opens the game in the cabinet's iframe (the web titles allow framing; the
iframe delegates fullscreen/gamepad/autoplay/pointer-lock to any origin —
`allow="… *"` — because `'src'` delegation breaks when a site redirects to
`www.`). Covers in `covers/` are captures of each game's own title screen
(960×540 JPEG); Pickle Brawl's logo is an HTML layer, so it is composited
over the court capture (`logo` in config). Use the canonical `www.` URLs.

Sign-in inside a framed title: the AIR/Moca sign-in a game embeds sets
`frame-ancestors` to the game's own domain, so a first-party title asks the
shell instead — `cabinet:air` lends it the arcade's AIR session (and a fresh
token when asked), `cabinet:air-login` / `cabinet:air-logout` drive this
page's sign-in (app.js, docs/UNIVERSAL-LOGIN.md). Gameplay never depends on
it.

## What the page shows

    FROM THE NODE               node status · leaderboards · per-player stats ·
                                match history · rating curve (Elo replayed
                                client-side from /deltas, same fold as derive.js)
                                · level/XP from AF's real curve (win 60 / loss 20,
                                xp_for_next = 80 + level·45, cap 40)
    FROM THE CHAIN              bond, balances, seeds (NodeDirectory), match
                                receipts, and the Cards page's NFTs (litVM
                                testnet, labelled "testnet")

Player identity: an ed25519 keypair from the node's own `protocol/keys.js`,
kept in localStorage — the same `playerId` the node sees once games queue and
settle through it. Display name and photo are local.

## Files

    config.js       NODE_URL default, the game roster, chain addresses (the one file to edit)
    app.js          views, router, node polling, derived profile, login + account menu, play overlay
    air.js          universal login: AIR Kit sign-in, a litVM identity from a node
    wallet.js       sign in with your own wallet (EIP-1193, no wallet library)
    nfts.js         the Cards page's NFTs: explorer list, balanceOf, tokenURI, IPFS art
    ro3.js          #/ro3 for the RO3 on LITNODE launcher
    receipt.js      #/match/<id>: the match receipt, re-checked against the chain
    build.js        #/build developer docs
    download.js     the Control Plane download (header button, banner, #/download)
    nodeops.js      operator actions from the Nodes page, signed by the operator's wallet
    fleet.js        the node's signed /fleet telemetry, verified here
    quorum.js       can the mesh this node hears put a ranked match on chain?
    seeds.js        the seed list from NodeDirectory, read from litVM with no node
    avatar.js       identicon from the player key; photo upload resize
    uptime.js       uptime sampling/history + ring, strip, heatmap SVG/HTML
    chain.js        read-only litVM: NodeStake.standingOf, TestLITVM.balanceOf
    bg.js           backdrop painter (procedural sky + wireframe, or bg.jpg)
    index.html, style.css
    client.js       the isomorphic client: player key, signed queue entries,
                    /match polling, verifyPlacement — also drives demo/client.test.mjs
    sdk-client.js   drop into a game: connectCabinet() → onInit (with match) / exit
    serve.mjs       dev static server for this folder
    version.js      the litnode release these files were cut with (npm version keeps it in step)
    contracts.js    GENERATED deployed addresses (npm run vendor:cabinet)
    protocol/       GENERATED copies of the protocol modules + MANIFEST.json
    vendor/         AIR Kit (airkit.esm.js, Apache-2.0, its LICENSE beside it)
    covers/         title cover art (960×540 JPEG)
    manifest.webmanifest, sw.js, icons/   PWA (SW is network-first; never caches API)

## Shell ↔ game messages (postMessage, version 1)

    shell → game   { type:'cabinet:init', version:1, player:{id,guest,name}, node:{url,online}, game:{id,title},
                     match?:{matchId,host,witness,wsAddr,beacon,participants} }   ← from a verified placement
    game → shell   { type:'cabinet:hello' }   ask for init again
                   { type:'cabinet:exit' }    back to the dashboard
