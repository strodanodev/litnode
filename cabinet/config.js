/** Cabinet configuration. The only file to touch when the seed/server node
 *  syncs in: point NODE_URL at the public seed and edit the roster. Contract
 *  addresses are NOT here — see CHAIN below. */
import { CONTRACTS } from './contracts.js';

/** Default node the cabinet reads from. Users can override it in the footer
 *  (stored in localStorage). Hosted at cabinet.litvm.games this should be the
 *  public seed; locally it is the node next to this folder. */
export const NODE_URL = 'http://127.0.0.1:7801';

/** Universal login (docs/UNIVERSAL-LOGIN.md). The partner id is a public
 *  client identifier (the AIR dashboard pins it to allowed domains:
 *  arcade.litvm.games, litvm.games). buildEnv 'sandbox' | 'production' must
 *  match the environment that partner was created in. Unset partnerId hides
 *  the button. ?airenv= overrides buildEnv for a test. */
export const AIR = { partnerId: '62e01755-138f-4e58-9cdc-fab71e037afd', buildEnv: new URLSearchParams(location.search).get('airenv') || 'sandbox' };

/** The first three titles. Each opens in the cabinet's iframe on PLAY (all
 *  three allow framing). `login: 'arcade'` = universal login: inside this
 *  page the title signs in with THIS page's AIR session (it asks over
 *  postMessage, cabinet:air) and never shows its own login; on its own domain
 *  it logs in itself. Only first-party titles get it: the token it is handed
 *  is the arcade's, which also speaks for the player's proxy wallet on a node.
 *  The token goes only to the origin of `url` (plus `origins`, if listed). `cover` is a capture of the game's own title screen
 *  (covers/, 960×540); `logo` is an optional overlay for covers whose logo is
 *  an HTML layer rather than part of the canvas. `rulesetId` links the title
 *  to the mesh (leaderboard, record); `queue: false` keeps it there without a
 *  Find match button. */
export const GAMES = [
  {
    id: 'agent-fighter',
    title: 'AGENT FIGHTER',
    accent: '#ff2d95',
    tagline: 'Humans and AI agents. Same arena. Verified wins.',
    description: 'A browser fighting game with Marvel vs Capcom feel. Fight the house bot in solo, raid the ranked arcade map, or wager online. Matches are input ledgers: both players sign the log, the mesh replays it, and the result is what the replay says — never what a client claims.',
    controls: ['Move: ← → / A D', 'Jump: ↑ / W', 'Crouch: ↓ / S', 'Light / Medium / Heavy: J K L', 'Special: motion + button', 'Gamepad supported'],
    modes: ['agent arcade (free)', 'ranked pvp (ticket)', 'wager online'],
    players: '1P / 2P online',
    url: 'https://www.agentfighter.wtf/',
    cover: './covers/agent-fighter.jpg',
    rulesetId: 'agent-fighter.v1',
    buildHash: '859e7215418db6473f0ceb1a88a1f51dc279db1974636c2262f547fcafca76da',
    kind: 'replayable', // L3: both players sign the input log and witnesses replay it
    status: 'live',
    tags: ['PWA', 'CREDITS / TICKETS'],
    badge: 'agentfighter.wtf',
    playable: true,
    login: 'arcade',
  },
  {
    id: 'pickle-brawl',
    title: 'PICKLE BRAWL',
    accent: '#7cff4a',
    tagline: 'Physics, paddles, no mercy.',
    description: 'The 1:1 pickleball showdown — Managers Cup, Season 1. Lob, dink, drive, smash and split on a 3D court. Results reach the mesh as signed reports; the node checks the rules (to 11, win by two) and the attestor signature, then settles.',
    controls: ['Move: W A S D', 'Drive: left mouse', 'Lob: right mouse', 'Dink: E', 'Smash: F', 'Split: Shift'],
    modes: ['single player', 'open play', 'managers cup'],
    players: '1P / 2P · doubles',
    url: 'https://play.picklebrawl.live/', // the game; www.picklebrawl.live is the marketing site. The arcade lends its AIR session to this origin only
    cover: './covers/pickle-brawl.jpg',
    logo: './covers/pickle-brawl-logo.webp',
    rulesetId: 'pickle-brawl.v1',
    buildHash: 'd7233fa3e5b838f320952e71a2298411c638c69cd5b116e7c29c65263d35d991',
    kind: 'attested', // L1 today: the court signs a report the node checks; L2 once it commits a log and a verifier
    status: 'attested',
    tags: ['THREE.JS', 'PWA', 'PICKLES / BRINE'],
    badge: 'picklebrawl.live',
    playable: true,
    login: 'arcade',
  },
  {
    id: 'afc',
    title: 'ROBOT FIGHTING CHAMPIONSHIP',
    accent: '#8ce8ff',
    tagline: 'Humanoid mech combat. Bring a better loadout.',
    description: 'AFC — humanoid robot fighting. Every bout is re-simulated by the AFC host, which signs it; the node checks the rules and holds the match file, and anyone can re-run the registered verifier.',
    controls: ['Move: W A S D', 'Strike: J / K', 'Guard: L', 'Loadout in the garage'],
    modes: ['casual', 'garage', 'shop'],
    players: '1P',
    url: 'https://rfc.litvm.games/', // the only AFC host AIR's partner allows; the old hosts redirect here
    cover: './covers/afc.jpg',
    rulesetId: 'afc.v1',
    buildHash: 'e3725bd2a25692274916c02f177902e908559efee4ba01fa7fa09509d65cb6a4',
    kind: 'attested', // L1 until its verifier is registered; then the node derives `checkable` (L2) per bout
    status: 'attested',
    login: 'arcade', // AFC asks cabinet:air; the session is lent to this title's own origin only
    tags: ['THREE.JS', 'PWA', 'SCRAP / SILVER'],
    badge: 'rfc.litvm.games',
    playable: true,
    queue: false, // casual single-player only: no Find match until AFC's PvP bundle and ranked ship
  },
];

/** litVM (LiteForge testnet) — read-only from the dashboard. Addresses come from
 *  ./contracts.js, GENERATED by tools/vendor-cabinet.mjs from contracts/deployed.testnet.json
 *  (the one place they live; demo/cabinet.test.mjs fails when the copy lags). Never paste an
 *  address here: a hand-copied generation-2 set outlived the generation-3 deploy by a day in
 *  Agent Fighter's client and every launch said SERVER OFFLINE (22 Sep 2026). */
const at = (name) => CONTRACTS.contracts[name]?.address ?? null;
export const CHAIN = {
  name: 'litVM LiteForge',
  chainId: CONTRACTS.chainId,
  rpc: CONTRACTS.rpc ?? 'https://liteforge.rpc.caldera.xyz/http',
  /** rpc, then the deploy record's rpcFallback: what rpcCall (chain.js) walks when a provider is out of bandwidth. */
  rpcs: [...new Set([CONTRACTS.rpc ?? 'https://liteforge.rpc.caldera.xyz/http', ...(CONTRACTS.rpcFallback ?? [])])],
  generation: CONTRACTS.generation,
  NodeStake: at('NodeStake'),
  TestLITVM: at('TestLITVM'),
  EpochAnchor: at('EpochAnchor'),
  /** Every ranked match on chain (BUILD-SPEC v0.3 §11): the cabinet can fold the ladder from RPC alone (protocol/matchbook.js). */
  MatchBook: at('MatchBook'),
  /** null = "Sign in with wallet" stays hidden; keys are players (docs/WALLET-IDENTITY.md). */
  PlayerProfile: at('PlayerProfile'),
  NodeBadge: at('NodeBadge'),
  /** The seed list on chain: a visitor with no node reads the mesh through the freshest bonded seed. */
  NodeDirectory: at('NodeDirectory'),
  ReleaseRegistry: at('ReleaseRegistry'),
  TitleRegistry: at('TitleRegistry'),
  explorer: 'https://liteforge.explorer.caldera.xyz',
  token: 'tLITVM',
};
