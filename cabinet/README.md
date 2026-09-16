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

    #/              Home — profile card, rating chart, game library, leaderboard,
                    characters, inventory
    #/games         all titles
    #/game/<id>     one title — hero, about, controls, mesh info, leaderboard,
                    your record + match history
    #/leaderboards  top-3 rank cards (bracket badge, tier, rating / win rate /
                    streak) + full table per title, player search
    #/characters    fighter roster with style filter
    #/inventory     consumables, pets, tickets
    #/node          this node, run-a-node steps, peers

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

    UPTIME    24 h ring + 10-minute strip, 7-day heatmap on the Nodes page —
              observed by this dashboard while open (localStorage, per node
              URL). "Process up" is the node's own figure (/health startedAt,
              uptimeMs).
    WORK      matches this node settled as host and witness co-signatures,
              counted from the settled deltas. Real: any node with the same
              deltas counts the same.
    ON CHAIN  bond amount, operator wallet balance, operator address — read
              live from litVM (chain.js, read-only, calldata built with the
              node's own staking/keccak modules).

There is no reward figure. There is no rewards contract on litVM; nothing
accrues; the bond is a cost of misbehaviour, not a yield. A number nothing
can pay is a claim, so the cabinet does not show one.

## Deploy

Live: https://lit-games-cabinet.vercel.app (Vercel project `lit-games-cabinet`,
static, no build). From this folder:

    vercel deploy --prod --yes

The folder is self-contained: `protocol/` is a generated copy of the eight
protocol modules the cabinet runs (`npm run vendor:cabinet` from the repo
root; `MANIFEST.json` pins each by sha256 and `demo/cabinet.test.mjs` fails
on drift — never edit the copies). `vercel.json` sets cache headers;
`serve.mjs` and this README are excluded by `.vercelignore`.

Custom domain: `vercel domains add cabinet.litvm.games lit-games-cabinet`,
then a CNAME `cabinet → cname.vercel-dns.com` at the litvm.games DNS.

Hosted → local node: an https page reading http://127.0.0.1:7801 gets
Chrome's one-time "local network access" prompt; the node answers with
`Access-Control-Allow-Private-Network: true` for older PNA builds. Point the
footer's node URL at a public https seed for players who don't run a node.

## Titles

    01  Agent Fighter                 https://www.agentfighter.wtf/       ruleset agent-fighter.v1
    02  Pickle Brawl                  https://www.picklebrawl.live/       ruleset pickle-brawl.v1
    03  Robot Fighting Championship   https://afc-pi-seven.vercel.app/    not on the mesh yet

PLAY opens the game in the cabinet's iframe (all three allow framing; the
iframe delegates fullscreen/gamepad/autoplay/pointer-lock to any origin —
`allow="… *"` — because `'src'` delegation breaks when a site redirects to
`www.`). Covers in `covers/` are captures of each game's own title screen
(960×540 JPEG); Pickle Brawl's logo is an HTML layer, so it is composited
over the court capture (`logo` in config). Use the canonical `www.` URLs.

Known limit: the AIR/Moca sign-in these games embed sets `frame-ancestors`
to the games' own domains. Inside the cabinet the cabinet is an extra
ancestor, so sign-in is blocked until `cabinet.litvm.games` (and any dev
origin) is added to the AIR partner allowlist, or the games switch to
popup-mode auth. Gameplay itself is unaffected. AFC's intended domain per that
allowlist is `afc.picklebrawl.live`.

## Real vs. sample

    REAL (from the node)        node status · leaderboards · per-player stats ·
                                match history · rating curve (Elo replayed
                                client-side from /deltas, same fold as derive.js)
                                · level/XP from AF's real curve (win 60 / loss 20,
                                xp_for_next = 80 + level·45, cap 40)
    SAMPLE (until AF sync)      unlocked fighters · main · items · pets · tickets
                                — everything labelled "sample" comes from
                                roster.js INVENTORY_SAMPLE

Player identity: an ed25519 keypair from the node's own `protocol/keys.js`,
kept in localStorage — the same `playerId` the node sees once games queue and
settle through it. Display name and photo are local.

## Files

    config.js       NODE_URL default, the game roster, chain addresses (the one file to edit)
    roster.js       fighters, item lines, pets, sample loadout; portraits hotlink
                    from the hosted Agent Fighter build
    app.js          views, router, node polling, derived profile, play overlay
    avatar.js       identicon from the player key; photo upload resize
    uptime.js       uptime sampling/history + ring, strip, heatmap SVG/HTML
    chain.js        read-only litVM: NodeStake.standingOf, TestLITVM.balanceOf
    bg.js           backdrop painter (procedural sky + wireframe, or bg.jpg)
    index.html, style.css
    client.js       the isomorphic client: player key, signed queue entries,
                    /match polling, verifyPlacement — also drives demo/client.test.mjs
    sdk-client.js   drop into a game: connectCabinet() → onInit (with match) / exit
    serve.mjs       dev static server for this folder
    protocol/       generated copies of eight protocol modules + MANIFEST.json
    manifest.webmanifest, sw.js, icons/   PWA (SW is network-first; never caches API)

## Shell ↔ game messages (postMessage, version 1)

    shell → game   { type:'cabinet:init', version:1, player:{id,guest,name}, node:{url,online}, game:{id,title},
                     match?:{matchId,host,witness,wsAddr,beacon,participants} }   ← from a verified placement
    game → shell   { type:'cabinet:hello' }   ask for init again
                   { type:'cabinet:exit' }    back to the dashboard
