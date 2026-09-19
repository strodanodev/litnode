/** Cabinet configuration. The only file to touch when the seed/server node
 *  syncs in: point NODE_URL at the public seed and edit the roster. */

/** Default node the cabinet reads from. Users can override it in the footer
 *  (stored in localStorage). Hosted at cabinet.litvm.games this should be the
 *  public seed; locally it is the node next to this folder. */
export const NODE_URL = 'http://127.0.0.1:7801';

/** The first three titles. Each opens in the cabinet's iframe on PLAY (all
 *  three allow framing). `cover` is a capture of the game's own title screen
 *  (covers/, 960×540); `logo` is an optional overlay for covers whose logo is
 *  an HTML layer rather than part of the canvas. `rulesetId` links the title
 *  to the mesh (leaderboard, record); AFC has no ruleset on the node yet. */
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
    status: 'live',
    tags: ['PWA', 'CREDITS / TICKETS'],
    badge: 'agentfighter.wtf',
    playable: true,
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
    url: 'https://www.picklebrawl.live/',
    cover: './covers/pickle-brawl.jpg',
    logo: './covers/pickle-brawl-logo.webp',
    rulesetId: 'pickle-brawl.v1',
    buildHash: 'db035b782d23e85d4dcfdab0b2364f9e4f1c828b3dd8b2217c25b62cf0e1cb2e',
    status: 'live',
    tags: ['THREE.JS', 'PWA', 'PICKLES / BRINE'],
    badge: 'picklebrawl.live',
    playable: true,
  },
  {
    id: 'afc',
    title: 'ROBOT FIGHTING CHAMPIONSHIP',
    accent: '#8ce8ff',
    tagline: 'Humanoid mech combat. Bring a better loadout.',
    description: 'AFC — deterministic, verifiable robot fighting. Every match re-simulates to the same hash, which is exactly what a witness node needs. Not on the mesh yet: the ruleset lands with the node sync.',
    controls: ['Move: W A S D', 'Strike: J / K', 'Guard: L', 'Loadout in the garage'],
    modes: ['casual', 'garage', 'shop'],
    players: '1P',
    url: 'https://afc-pi-seven.vercel.app/',
    cover: './covers/afc.jpg',
    status: 'live',
    tags: ['THREE.JS', 'PWA', 'SCRAP / SILVER'],
    badge: 'afc-pi-seven.vercel.app',
    playable: true,
  },
];

/** litVM (LiteForge testnet) — read-only from the dashboard. Addresses from
 *  contracts/deployed.testnet.json — the v2 set deployed 19 Sep 2026 from the
 *  rotated wallet (contracts/MIGRATION.md); the 12–17 Sep v1 addresses are
 *  archived in contracts/deployed.testnet.2026-09-17T00-45-43-682Z.json. */
export const CHAIN = {
  name: 'litVM LiteForge',
  chainId: 4441,
  rpc: 'https://liteforge.rpc.caldera.xyz/http',
  NodeStake: '0x53822d9a334082e88AB70103F58AD65eBEF73801',
  TestLITVM: '0x85D309Fe638B639Ae8c9889A5199Fce55B5dBd41',
  EpochAnchor: '0x87d9fB5FC60140B3e7A63FC657c1969baAf7d6eD',
  /** Set after `npm run deploy:testnet` writes it to contracts/deployed.testnet.json.
   *  null = "Sign in with wallet" stays hidden; keys are players (docs/WALLET-IDENTITY.md). */
  PlayerProfile: '0xCdB1901aA9f4bc5dfd7F62c68B9d06247229B112',
  NodeBadge: '0x036f11E25d2A352f1B2DDc621c64aa22276D5f6e',
  /** The seed list on chain. Set after deploy; then a visitor with no node
   *  reads the mesh through the freshest bonded seed (docs: decentralized bootstrap). */
  NodeDirectory: '0x278e4550F8a45B5D7d630a606d577F9Fb6cBE4c1',
  explorer: 'https://liteforge.explorer.caldera.xyz',
  token: 'tLITVM',
};
