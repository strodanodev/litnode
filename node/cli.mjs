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
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNode } from './litnode.js';
import { createTui, formatEvent } from './tui.js';

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
  publicAddr: env.PUBLIC_ADDR ?? null,
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
  log: tui ? tui.log : (m) => console.log(`${stamp()} ${m}`),
  onEvent: tui ? tui.event : plainEvent,
});
if (tui) tui.attach(node);
else console.log(`health: ${node.addr}/health   cabinet: ${node.addr}/`);
const bail = async () => { if (tui) await tui.stop(); await node.stop(); process.exit(0); };
process.on('SIGINT', bail);
process.on('SIGTERM', bail);
