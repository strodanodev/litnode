/** Run one litnode from environment variables.
 *
 *    PORT=7801 OPERATOR=publisher RULESETS=./rulesets/agent-fighter.v1.js npm run node
 *    PORT=7802 OPERATOR=guild-a SEEDS=http://127.0.0.1:7801 npm run node
 *
 *  RPC and NODE_STAKE default from contracts/deployed.testnet.json when it
 *  exists; OFFLINE=1 forces the local beacon and no stake reads.
 *
 *  On a terminal the node draws its dashboard (node/tui.js). Under a
 *  scheduled task, a pipe or LITNODE_PLAIN=1 it prints one line per event
 *  instead, so litnode.log reads the same as the screen. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNode } from './litnode.js';
import { createTui, formatEvent } from './tui.js';
import { lanAddress } from './upnp.js';
import { loadGauntletConfigs } from './gauntlet.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployedPath = join(root, 'contracts', 'deployed.testnet.json');
const deployed = existsSync(deployedPath) ? JSON.parse(readFileSync(deployedPath, 'utf8')) : {};
const env = process.env;
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const interactive = process.stdout.isTTY && !env.LITNODE_PLAIN;
const tui = interactive ? createTui({ chainId: deployed.chainId ?? null }) : null;
const stamp = () => `[${new Date().toISOString().slice(11, 19)}]`;
// Plain mode: gossip is too chatty for a log file; everything else is one line.
const QUIET = new Set(['gossip.in', 'gossip.out', 'block', 'log']); // per-tick noise; the dashboard shows these, a log file should not
const plainEvent = (ev) => { if (!QUIET.has(ev.type)) console.log(`${stamp()} ${formatEvent(ev, false)}`); };

const node = await createNode({
  dataDir: env.DATA_DIR ?? join(root, 'data', env.OPERATOR ?? 'node'),
  port: Number(env.PORT ?? 7801),
  host: env.HOST ?? '127.0.0.1',
  // Listening on every interface with nothing set: advertise the LAN IPv4
  // (what start-node.cmd computed for the zips), never 0.0.0.0. A tunnel
  // replaces this with the public URL once it is up.
  publicAddr: env.PUBLIC_ADDR ?? ((env.HOST ?? '127.0.0.1') === '0.0.0.0' ? `http://${lanAddress()}:${Number(env.PORT ?? 7801)}` : null),
  operator: env.OPERATOR ?? 'dev',
  roles: list(env.ROLES).length ? list(env.ROLES) : ['mesh', 'host', 'witness'],
  region: env.REGION ?? 'local',
  // The relay this node fronts (wss://… for browsers on https pages). Only a
  // node with a relay advertises one; the cabinet launches against it.
  wsAddr: env.WS_ADDR ?? null,
  seeds: list(env.SEEDS),
  rulesets: list(env.RULESETS),
  rpc: env.OFFLINE ? null : (env.RPC ?? deployed.rpc ?? 'https://liteforge.rpc.caldera.xyz/http'),
  offline: !!env.OFFLINE,
  nodeStake: env.NODE_STAKE ?? deployed.NodeStake?.address ?? null,
  playerProfile: env.PLAYER_PROFILE ?? deployed.PlayerProfile?.address ?? null,
  updates: env.LITNODE_NO_UPDATE !== '1',            // hourly signed-manifest check; apply is always manual
  // TUNNEL=quick | TUNNEL=named (with TUNNEL_NAME + TUNNEL_HOST): the node
  // exposes itself through cloudflared and advertises the public URL.
  // RELAY_PORT=8477: also front the title relay on this machine and advertise
  // it as wsAddr (RELAY_TUNNEL_NAME/HOST for a named one). WS_ADDR wins if set.
  tunnel: env.TUNNEL === 'quick' || env.TUNNEL === 'named' ? env.TUNNEL : null,
  tunnelName: env.TUNNEL_NAME ?? null, tunnelHost: env.TUNNEL_HOST ?? null,
  relayPort: env.RELAY_PORT ? Number(env.RELAY_PORT) : null,
  relayTunnelName: env.RELAY_TUNNEL_NAME ?? null, relayTunnelHost: env.RELAY_TUNNEL_HOST ?? null,
  releaseUrl: env.RELEASE_URL || undefined,           // a mirror, for testing
  releaseChannel: env.RELEASE_CHANNEL || 'stable',    // 'canary' nodes take releases first (release-canary.json)
  upnp: env.UPNP === '1',                             // ask the router to forward PORT (and RELAY_PORT); reports CGNAT
  // NodeDirectory (contracts/deployed.testnet.json): the seed list on chain.
  // Bootstrap reads it; with a delegated + funded announcer key this node
  // publishes its own addresses there. ANNOUNCE=0 reads only.
  nodeDirectory: env.NODE_DIRECTORY ?? deployed.NodeDirectory?.address ?? null,
  chainId: deployed.chainId ?? 4441,
  // ReleaseRegistry: a release must be registered on chain and active before
  // this node applies it (BUILD-SPEC v0.3 §2.4). Unset → signature-only, reported.
  releaseRegistry: env.RELEASE_REGISTRY ?? deployed.ReleaseRegistry?.address ?? null,
  // TitleRegistry: a title is an ERC-721 whose holder is the publisher; a peer's
  // build loads when the chain says it is the title's active build. Unset →
  // TRUSTED_PUBLISHERS signatures only, and /titles.published is null.
  titleRegistry: env.TITLE_REGISTRY ?? deployed.TitleRegistry?.address ?? null,
  stakeToken: env.STAKE_TOKEN ?? deployed.TestLITVM?.address ?? null,
  // MatchBook: ranked matches committed, settled and attested on chain from the delegated key (BUILD-SPEC v0.3 §11).
  matchBook: env.MATCH_BOOK ?? deployed.MatchBook?.address ?? null,
  matchBookFromBlock: Number(env.MATCH_BOOK_FROM_BLOCK ?? deployed.MatchBook?.block ?? 0),
  contractsGeneration: deployed.generation ?? null,
  matchBookWindows: { attestWindow: Number(deployed.MatchBook?.attestWindowS ?? 120), escalationWindow: Number(deployed.MatchBook?.escalationWindowS ?? 300) },
  epochAnchor: env.EPOCH_ANCHOR ?? ((deployed.EpochAnchor?.version ?? 1) >= 3 ? deployed.EpochAnchor?.address : null) ?? null,
  announce: env.ANNOUNCE !== '0',
  // ERC6699Registry v2: characters for ranked play come from here at the
  // placement's block. Unset (or a v1 address) → hydration is labelled.
  erc6699: env.ERC6699 ?? deployed.ERC6699RegistryV2?.address ?? null,
  // Title sandbox limits (node/sandbox.js). Every replay is a separate
  // permission-restricted process; these are its deadline and heap ceiling.
  sandboxTimeoutMs: Number(env.SANDBOX_TIMEOUT_MS ?? 10_000), sandboxMemoryMb: Number(env.SANDBOX_MEMORY_MB ?? 256),
  // TITLE_TRUST=trusted (default): builds from peers load only when signed
  // by a key in TRUSTED_PUBLISHERS (default: the litVM release key).
  // TITLE_TRUST=open: any conformant build — the sandbox is the boundary.
  titleTrust: env.TITLE_TRUST === 'open' ? 'open' : 'trusted',
  trustedPublishers: list(env.TRUSTED_PUBLISHERS).length ? list(env.TRUSTED_PUBLISHERS) : undefined,
  // COURTS=pickle-brawl.v1:<pubkey>[,<pubkey>];<rulesetId>:… — authorized attestors per attested title.
  courts: Object.fromEntries((env.COURTS ?? '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [rid, keys] = x.split(':'); return [rid, list(keys)]; })),
  // RELAY_KEYS=<pubkey>,… — relays whose signed submissions this host settles as 'relay' provenance (tools/af-watch.mjs prints its key).
  relayKeys: list(env.RELAY_KEYS),
  // GAUNTLETS=<rulesetId>=<config.json>,… — per-match headless servers this node runs for
  // those titles, behind the relay port (node/gauntlet.js). GAUNTLET_UPSTREAM=ws://127.0.0.1:8477
  // sends rooms the gateway does not know to a title's own relay on this machine.
  gauntlets: loadGauntletConfigs(env.GAUNTLETS, { root }), gauntletUpstream: env.GAUNTLET_UPSTREAM || null,
  // Universal login (docs/UNIVERSAL-LOGIN.md): on whenever PlayerProfile is set; AIR=0 turns it off.
  // AIR_PARTNER_ID pins tokens to one partner app (recommended); AIR_JWKS_URL overrides the key set.
  air: env.AIR === '0' ? null : { partnerId: env.AIR_PARTNER_ID ?? null, jwksUrl: env.AIR_JWKS_URL || undefined },
  log: tui ? tui.log : (m) => console.log(`${stamp()} ${m}`),
  onEvent: tui ? tui.event : plainEvent,
});
if (tui) tui.attach(node);
else console.log(`health: ${node.addr}/health   cabinet: ${node.addr}/`);
// Last-resort safety net: a rejection nobody caught (a poll that failed, a
// handler bug) must not end the process. Ending it rotates the quick-tunnel
// hostnames and blinds every peer for a directory cycle; logging it does
// not. Same policy as the Agent Fighter relay. Registered only here, never
// in createNode, so tests that spin up many nodes do not stack listeners.
process.on('unhandledRejection', (reason) => console.error(`[fatal] unhandledRejection (kept alive):`, reason));
process.on('uncaughtException', (err) => console.error(`[fatal] uncaughtException (kept alive):`, err));

// Record the PID beside the identity, so restart-node.cmd / stop-node.cmd can
// end THIS process rather than the wrapper (a scheduled task's End only
// stops cmd.exe; the node kept running and held the port).
const pidFile = join(env.DATA_DIR ?? join(root, 'data', env.OPERATOR ?? 'node'), 'node.pid');
try { writeFileSync(pidFile, `${process.pid}\n`); } catch { /* read-only data dir: nothing to record */ }
const bail = async () => { if (tui) await tui.stop(); await node.stop(); try { rmSync(pidFile, { force: true }); } catch {} process.exit(0); };
process.on('SIGINT', bail);
process.on('SIGTERM', bail);
