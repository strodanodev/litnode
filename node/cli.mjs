/** Run one litnode from environment variables.
 *
 *    PORT=7801 OPERATOR=publisher RULESETS=./rulesets/agent-fighter.v1.js npm run node
 *    PORT=7802 OPERATOR=guild-a SEEDS=http://127.0.0.1:7801 npm run node
 *
 *  RPC and NODE_STAKE default from contracts/deployed.testnet.json when it
 *  exists; OFFLINE=1 forces the local beacon and no stake reads. RPC_FALLBACK
 *  (comma-separated) lists endpoints to use while RPC is failing (node/chain.js).
 *
 *  On a terminal the node draws its dashboard (node/tui.js). Under a
 *  scheduled task, a pipe or LITNODE_PLAIN=1 it prints one line per event
 *  instead, so litnode.log reads the same as the screen. */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNode } from './litnode.js';
import { createTui, formatEvent } from './tui.js';
import { lanAddress } from './upnp.js';
import { loadGauntletConfigs } from './gauntlet.js';
import { loadServiceBundles } from './publisher-services.js';
import { checkInstance, describePortHolder, ALREADY_RUNNING_EXIT, PORT_BUSY_EXIT } from './port.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployedPath = join(root, 'contracts', 'deployed.testnet.json');
const deployed = existsSync(deployedPath) ? JSON.parse(readFileSync(deployedPath, 'utf8')) : {};
const env = process.env;
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const dataDir = env.DATA_DIR ?? join(root, 'data', env.OPERATOR ?? 'node');
const port = Number(env.PORT ?? 7801);
const pidFile = join(dataDir, 'node.pid');
const ownId = (() => { try { return JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).publicKey ?? null; } catch { return null; } })();

// One node per data directory (node/port.js): two launchers on one identity
// (a leftover scheduled task and the Control Plane, say) must not both run.
const inst = await checkInstance({ pidFile, port, nodeId: ownId, log: (m) => console.log(m) });
if (inst.state === 'running') {
  console.log(`this node (${inst.health.nodeId.slice(0, 8)}…, operator ${inst.health.operator ?? '?'}) is already running as PID ${inst.pid} on :${port}; not starting a second copy`);
  process.exit(ALREADY_RUNNING_EXIT);
}
// Record the PID beside the identity BEFORE loading, so a second launcher
// sees this node while it is still starting, and restart-node.cmd /
// stop-node.cmd can end THIS process rather than its wrapper (a scheduled
// task's End only stops cmd.exe; the node kept running and held the port).
try { mkdirSync(dataDir, { recursive: true }); writeFileSync(pidFile, `${process.pid}\n`); } catch { /* read-only data dir: nothing to record */ }
const dropPid = () => { try { if (Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) rmSync(pidFile, { force: true }); } catch { /* gone already */ } };

// Output nobody reads. The Control Plane runs the node with its stdout and stderr in pipes it reads into its
// own log; when the Control Plane goes away (it quit, crashed, was killed) the node keeps running and its
// next write fails with EPIPE. That error reached the keep-alive handler at the bottom, which logged it to the
// same dead stream, which failed again: a loop that left the node answering GETs but never finishing a request
// body — gossip, /queue and /ledger all hung (m16, 4 Oct 2026). So the first write error on either stream ends
// console output for good, and the log continues in <dataDir>/litnode.log. A pipe that stays open but is no
// longer read (its reader hung) backs up in memory instead; past 8 MB unwritten, the same.
let fileLog = null;
const detachOutput = (why) => {
  if (fileLog) return;
  fileLog = { write: () => true };
  try { const f = createWriteStream(join(dataDir, 'litnode.log'), { flags: 'a' }); f.on('error', () => {}); fileLog = f; } catch { /* no data dir: drop the output */ }
  for (const s of [process.stdout, process.stderr]) {
    s.removeAllListeners('error');
    s.on('error', () => {});
    s.write = (chunk, enc, cb) => { fileLog.write(chunk); const done = typeof enc === 'function' ? enc : cb; if (typeof done === 'function') queueMicrotask(done); return true; };
  }
  fileLog.write(`[${new Date().toISOString()}] console output stopped (${why}): whatever read it is gone; the log continues here\n`);
};
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => detachOutput(e?.code ?? String(e)));
setInterval(() => { if ((process.stdout.writableLength ?? 0) > 8 * 1024 * 1024) detachOutput('stdout backed up'); }, 5000).unref();

const interactive = process.stdout.isTTY && !env.LITNODE_PLAIN;
const tui = interactive ? createTui({ chainId: deployed.chainId ?? null }) : null;
const stamp = () => `[${new Date().toISOString().slice(11, 19)}]`;
// Plain mode: gossip is too chatty for a log file; everything else is one line.
const QUIET = new Set(['gossip.in', 'gossip.out', 'block', 'log']); // per-tick noise; the dashboard shows these, a log file should not
const plainEvent = (ev) => { if (!QUIET.has(ev.type)) console.log(`${stamp()} ${formatEvent(ev, false)}`); };

let node;
try {
node = await createNode({
  dataDir,
  port,
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
  // The preferred endpoint first, then RPC_FALLBACK and the release's own fallbacks: node/chain.js moves a call to
  // the next one while an endpoint is failing, and back once it answers again.
  rpc: env.OFFLINE ? null : [...new Set([env.RPC ?? deployed.rpc ?? 'https://liteforge.rpc.caldera.xyz/http', ...list(env.RPC_FALLBACK), ...(deployed.rpcFallback ?? [])])],
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
  // GasRefund: the treasury pays back the gas of the FINAL matches this node served; the node claims it itself.
  gasRefund: env.GAS_REFUND ?? deployed.GasRefund?.address ?? null,
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
  gauntlets: loadGauntletConfigs(env.GAUNTLETS, { root }), gauntletUpstream: env.GAUNTLET_UPSTREAM || null, gauntletPort: env.GAUNTLET_GATEWAY_PORT ? Number(env.GAUNTLET_GATEWAY_PORT) : null,
  // SERVICES=<bundle.json>,… — a publisher's long-lived backend run on this node (node/publisher-services.js).
  services: loadServiceBundles(env.SERVICES, { root }),
  // Universal login (docs/UNIVERSAL-LOGIN.md): on whenever PlayerProfile is set; AIR=0 turns it off.
  // AIR_PARTNER_ID pins tokens to one partner app (recommended); AIR_JWKS_URL overrides the key set.
  air: env.AIR === '0' ? null : { partnerId: env.AIR_PARTNER_ID ?? null, jwksUrl: env.AIR_JWKS_URL || undefined },
  log: tui ? tui.log : (m) => console.log(`${stamp()} ${m}`),
  onEvent: tui ? tui.event : plainEvent,
});
} catch (e) {
  if (tui) await tui.stop();
  dropPid();
  if (e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES') throw e;
  const busy = e.port ?? port;
  if (e.code === 'EACCES') {
    console.error(`cannot listen on :${busy} (EACCES). Hyper-V, WSL and Docker reserve port ranges at boot, and the ranges can move after a restart:\n  netsh interface ipv4 show excludedportrange protocol=tcp\n  set PORT to a number outside them`);
    process.exit(PORT_BUSY_EXIT);
  }
  const who = await describePortHolder(busy, { nodeId: ownId });
  console.error(`cannot listen on :${busy} (EADDRINUSE)\n${who.text}`);
  process.exit(who.kind === 'self' ? ALREADY_RUNNING_EXIT : PORT_BUSY_EXIT);
}
if (tui) tui.attach(node);
else console.log(`health: ${node.addr}/health   cabinet: ${node.addr}/`);
// Last-resort safety net: a rejection nobody caught (a poll that failed, a
// handler bug) must not end the process. Ending it rotates the quick-tunnel
// hostnames and blinds every peer for a directory cycle; logging it does
// not. Same policy as the Agent Fighter relay. Registered only here, never
// in createNode, so tests that spin up many nodes do not stack listeners.
// A broken stdout/stderr is never logged to itself (see detachOutput): that is the loop that hung m16.
const brokenOutput = (e) => ['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes(e?.code);
process.on('unhandledRejection', (reason) => { if (brokenOutput(reason)) return detachOutput(reason.code); console.error(`[fatal] unhandledRejection (kept alive):`, reason); });
process.on('uncaughtException', (err) => { if (brokenOutput(err)) return detachOutput(err.code); console.error(`[fatal] uncaughtException (kept alive):`, err); });

const bail = async () => { if (tui) await tui.stop(); await node.stop(); dropPid(); process.exit(0); };
process.on('SIGINT', bail);
process.on('SIGTERM', bail);
