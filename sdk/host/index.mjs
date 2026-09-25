/** litnode host harness — the programmatic half of `npm run host`.
 *
 *  Everything an operator (or an agent acting for one) needs to take a
 *  machine from "checkout or unzipped folder" to "bonded, reachable,
 *  announced node hosting titles", as plain functions that return plain
 *  objects. Nothing here holds or asks for a private key: the two chain
 *  steps that need one (bond, announce) shell out to the existing tools,
 *  which read it from the environment and nowhere else.
 *
 *  The daemon is node/cli.mjs, unchanged; this module reads the same
 *  node.env, computes the same effective configuration, and reads the same
 *  /health. A stage is `done` only when the node or the chain says so.
 *
 *    import { readEnv, effectiveConfig, preflight, inspect, plan } from '../sdk/host/index.mjs';
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeypair } from '../../protocol/keys.js';
import { randomPrivateKey, addressOf } from '../../protocol/evm.js';
import { standingCall, decodeStanding } from '../../protocol/staking.js';
import { entryOfCall, announcerOfCall, decodeEntry, decodeAddress } from '../../protocol/directory.js';
import { checkChallenge, newNonce } from '../../protocol/challenge.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';
import { lanAddress } from '../../node/upnp.js';
import { loadGauntletConfigs } from '../../node/gauntlet.js';
import { loadServiceBundles } from '../../node/publisher-services.js';

export const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
export const ENV_FILE = 'node.env';
/** Where node.env and litnode.log live: the code folder, or LITNODE_HOME
 *  (so a config can sit outside the checkout, and tests get a scratch one). */
export const home = () => (process.env.LITNODE_HOME ? resolve(process.env.LITNODE_HOME) : ROOT);
export const KNOWN_KEYS = ['OPERATOR', 'ROLES', 'PORT', 'HOST', 'PUBLIC_ADDR', 'SEEDS', 'RULESETS', 'DATA_DIR', 'REGION', 'TUNNEL', 'TUNNEL_NAME', 'TUNNEL_HOST', 'UPNP', 'RELAY_PORT', 'RELAY_TUNNEL_NAME', 'RELAY_TUNNEL_HOST', 'WS_ADDR', 'RELAY_KEYS', 'COURTS', 'TITLE_TRUST', 'TRUSTED_PUBLISHERS', 'SANDBOX_TIMEOUT_MS', 'SANDBOX_MEMORY_MB', 'RELEASE_CHANNEL', 'RPC', 'NODE_STAKE', 'NODE_DIRECTORY', 'ANNOUNCE', 'ERC6699', 'OFFLINE', 'AF_ROOT', 'AIR_PARTNER_ID', 'AIR_JWKS_URL', 'AIR', 'TITLE_REGISTRY', 'STAKE_TOKEN', 'RELEASE_REGISTRY', 'MATCH_BOOK', 'GAUNTLETS', 'GAUNTLET_UPSTREAM', 'GAUNTLET_GATEWAY_PORT', 'SERVICES', 'SERVICE_NAME'];
/** The arcade's AIR partner app (cabinet/config.js AIR.partnerId); `host init` pins tokens to it unless --no-air. */
export const AIR_PARTNER_ID = '62e01755-138f-4e58-9cdc-fab71e037afd';
export const ALL_ROLES = ['mesh', 'host', 'witness', 'settler'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ------------------------------------------------------------------ node.env

/** Parse KEY=VALUE lines (what start-node.cmd and tools/update.mjs read). */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

export function readEnv(dir = home()) {
  const p = join(dir, ENV_FILE);
  return existsSync(p) ? parseEnv(readFileSync(p, 'utf8')) : null;
}

/** Merge `values` into node.env, keeping every comment and unknown line.
 *  A key set to null or '' is commented out rather than deleted, so the
 *  file stays readable as its own record. Returns the written text. */
export function writeEnv(values, { dir = home(), template = join(ROOT, 'portable', 'node.env.example') } = {}) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, ENV_FILE);
  const base = existsSync(p) ? readFileSync(p, 'utf8') : existsSync(template) ? readFileSync(template, 'utf8') : '# litnode settings\n';
  const lines = base.split(/\r?\n/);
  const pending = { ...values };
  const out = lines.map((line) => {
    const m = /^\s*(#\s*)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || !(m[2] in pending)) return line;
    const key = m[2], v = pending[key];
    delete pending[key];
    return v == null || v === '' ? `#${key}=` : `${key}=${v}`;
  });
  for (const [k, v] of Object.entries(pending)) if (v != null && v !== '') out.push(`${k}=${v}`);
  const text = out.join('\n').replace(/\n*$/, '\n');
  writeFileSync(p, text);
  return text;
}

/** Validate what an operator may type. Returns [] when fine. */
export function validateEnv(env) {
  const errors = [];
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (!env.OPERATOR) errors.push('OPERATOR is required (a short name: laptop, guild-a)');
  else if (!ID_RE.test(env.OPERATOR)) errors.push(`OPERATOR "${env.OPERATOR}" must match ${ID_RE}`);
  for (const r of list(env.ROLES)) if (!ALL_ROLES.includes(r)) errors.push(`ROLES: unknown role "${r}" (${ALL_ROLES.join(', ')})`);
  if (env.PORT && !(Number(env.PORT) > 0 && Number(env.PORT) < 65536)) errors.push(`PORT "${env.PORT}" is not a port`);
  for (const s of list(env.SEEDS)) if (!/^https?:\/\//.test(s)) errors.push(`SEEDS: "${s}" is not an http(s) URL`);
  if (env.PUBLIC_ADDR && !/^https?:\/\//.test(env.PUBLIC_ADDR)) errors.push('PUBLIC_ADDR must be an http(s) origin');
  if (env.TUNNEL && !['quick', 'named'].includes(env.TUNNEL)) errors.push('TUNNEL must be quick or named');
  if (env.TUNNEL === 'named' && !(env.TUNNEL_NAME && env.TUNNEL_HOST)) errors.push('TUNNEL=named needs TUNNEL_NAME and TUNNEL_HOST');
  if (env.TITLE_TRUST && !['trusted', 'open'].includes(env.TITLE_TRUST)) errors.push('TITLE_TRUST must be trusted or open');
  if (env.RELEASE_CHANNEL && !['stable', 'canary'].includes(env.RELEASE_CHANNEL)) errors.push('RELEASE_CHANNEL must be stable or canary');
  return errors;
}

/** The configuration node/cli.mjs will actually run with, given node.env
 *  plus the process environment (the latter wins, as it does for the CLI). */
export function effectiveConfig(env = readEnv() ?? {}, { root = ROOT, processEnv = process.env } = {}) {
  const e = { ...env };
  for (const k of KNOWN_KEYS) if (processEnv[k] != null && processEnv[k] !== '') e[k] = processEnv[k];
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const deployedPath = join(root, 'contracts', 'deployed.testnet.json');
  const deployed = existsSync(deployedPath) ? JSON.parse(readFileSync(deployedPath, 'utf8')) : {};
  const operator = e.OPERATOR || 'dev';
  const abs = (p) => (isAbsolute(p) ? p : resolve(root, p));
  const port = Number(e.PORT ?? 7801);
  return {
    root, home: home(), operator, port,
    host: e.HOST ?? '127.0.0.1',
    dataDir: abs(e.DATA_DIR ?? join('data', operator)),
    roles: list(e.ROLES).length ? list(e.ROLES) : ['mesh', 'host', 'witness'],
    region: e.REGION ?? 'local',
    // start-node.cmd advertises the LAN IPv4 when listening on every
    // interface and nothing else is set; the harness does the same.
    publicAddr: e.PUBLIC_ADDR || ((e.HOST ?? '127.0.0.1') === '0.0.0.0' && !e.TUNNEL ? `http://${lanAddress()}:${port}` : null),
    publicAddrExplicit: !!e.PUBLIC_ADDR,
    seeds: list(e.SEEDS),
    rulesets: list(e.RULESETS).map(abs),
    tunnel: e.TUNNEL === 'quick' || e.TUNNEL === 'named' ? e.TUNNEL : null,
    tunnelName: e.TUNNEL_NAME || null, tunnelHost: e.TUNNEL_HOST || null,
    upnp: e.UPNP === '1',
    relayPort: e.RELAY_PORT ? Number(e.RELAY_PORT) : null,
    gauntlets: e.GAUNTLETS || null,
    services: e.SERVICES || null,
    gauntletGatewayPort: e.GAUNTLET_GATEWAY_PORT ? Number(e.GAUNTLET_GATEWAY_PORT) : null,
    afRoot: e.AF_ROOT || null,
    wsAddr: e.WS_ADDR || null,
    offline: !!e.OFFLINE,
    rpc: e.OFFLINE ? null : (e.RPC || deployed.rpc || null),
    chainId: deployed.chainId ?? null,
    nodeStake: e.NODE_STAKE || deployed.NodeStake?.address || null,
    nodeDirectory: e.NODE_DIRECTORY || deployed.NodeDirectory?.address || null,
    announce: e.ANNOUNCE !== '0',
    // The start-at-logon task/unit name. A second node on one machine needs its own, or installing it replaces the first.
    serviceName: /^[A-Za-z0-9._-]{1,64}$/.test(e.SERVICE_NAME ?? '') ? e.SERVICE_NAME : 'litnode',
    titleTrust: e.TITLE_TRUST === 'open' ? 'open' : 'trusted',
    releaseChannel: e.RELEASE_CHANNEL || 'stable',
    localUrl: `http://127.0.0.1:${port}`,
    minStake: deployed.NodeStake?.minStake ?? null,
    explorer: deployed.explorer ?? 'https://liteforge.explorer.caldera.xyz',
  };
}

/** The environment node/cli.mjs is started with: node.env, then the
 *  process environment (an operator's shell override wins), plus the
 *  computed PUBLIC_ADDR when node.env left it out. */
export function daemonEnv(cfg, env = readEnv(cfg.home) ?? {}, processEnv = process.env) {
  const out = { ...processEnv, ...env };
  for (const k of KNOWN_KEYS) if (processEnv[k] != null && processEnv[k] !== '') out[k] = processEnv[k];
  if (!out.PUBLIC_ADDR && cfg.publicAddr) out.PUBLIC_ADDR = cfg.publicAddr;
  if (!out.DATA_DIR) out.DATA_DIR = cfg.dataDir;
  delete out.OPERATOR_KEY; delete out.DEPLOYER_KEY; // the daemon never holds an operator key (BUILD-SPEC §11)
  return out;
}

// ----------------------------------------------------------------- identity

/** The node key and announcer key, created exactly as the daemon would on
 *  first run (same files, same format), so `bond` can run before `start`.
 *  Only public halves are returned. */
export async function ensureIdentity(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const idPath = join(dataDir, 'identity.json');
  if (!existsSync(idPath)) writeFileSync(idPath, JSON.stringify(await generateKeypair(), null, 2) + '\n');
  const annPath = join(dataDir, 'announcer.json');
  if (!existsSync(annPath)) writeFileSync(annPath, JSON.stringify({ privateKey: randomPrivateKey() }, null, 2) + '\n');
  const nodeId = JSON.parse(readFileSync(idPath, 'utf8')).publicKey;
  const announcer = addressOf(JSON.parse(readFileSync(annPath, 'utf8')).privateKey);
  return { nodeId, announcer, dataDir, files: { identity: idPath, announcer: annPath } };
}

export function readIdentity(dataDir) {
  const idPath = join(dataDir, 'identity.json'), annPath = join(dataDir, 'announcer.json');
  if (!existsSync(idPath)) return null;
  return {
    nodeId: JSON.parse(readFileSync(idPath, 'utf8')).publicKey,
    announcer: existsSync(annPath) ? addressOf(JSON.parse(readFileSync(annPath, 'utf8')).privateKey) : null,
  };
}

// -------------------------------------------------------------------- reads

const timeoutFetch = (url, ms = 8000, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

/** One JSON-RPC call over plain fetch; a few retries for the gateway's 5xx. */
export async function rpcCall(rpc, method, params = [], { tries = 3, fetchImpl = fetch } = {}) {
  let id = 0;
  for (let i = 1; ; i++) {
    try {
      const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { throw Object.assign(new Error(`${method}: HTTP ${r.status} non-JSON reply`), { transient: true }); }
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      const transient = e.transient || e.name === 'TimeoutError' || /fetch failed|ECONNRESET|ETIMEDOUT/.test(String(e.message));
      if (!transient || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

export async function chainStanding(cfg, nodeId, opts) {
  if (!cfg.rpc || !cfg.nodeStake) return null;
  return decodeStanding(await rpcCall(cfg.rpc, 'eth_call', [standingCall(cfg.nodeStake, nodeId), 'latest'], opts));
}

export async function directoryEntry(cfg, nodeId, opts) {
  if (!cfg.rpc || !cfg.nodeDirectory) return null;
  const [entry, announcer] = await Promise.all([
    rpcCall(cfg.rpc, 'eth_call', [entryOfCall(cfg.nodeDirectory, nodeId), 'latest'], opts).then(decodeEntry),
    rpcCall(cfg.rpc, 'eth_call', [announcerOfCall(cfg.nodeDirectory, nodeId), 'latest'], opts).then(decodeAddress),
  ]);
  return { ...entry, delegatedAnnouncer: /^0x0+$/.test(announcer) ? null : announcer };
}

export async function announcerBalance(cfg, address, opts) {
  if (!cfg.rpc || !address) return null;
  return BigInt(await rpcCall(cfg.rpc, 'eth_getBalance', [address, 'latest'], opts));
}

/** GET /health, or null when nothing answers. */
export async function health(url) {
  try { const r = await timeoutFetch(`${url.replace(/\/+$/, '')}/health`, 5000); return r.ok ? await r.json() : null; }
  catch { return null; }
}

export async function peers(url) {
  try { const r = await timeoutFetch(`${url.replace(/\/+$/, '')}/peers`, 5000); return r.ok ? await r.json() : null; }
  catch { return null; }
}

export async function titles(url) {
  try { const r = await timeoutFetch(`${url.replace(/\/+$/, '')}/titles`, 5000); return r.ok ? (await r.json()).titles : null; }
  catch { return null; }
}

/** Proof of possession: does the thing at `url` hold `nodeId`'s key? */
export async function prove(url, nodeId) {
  const nonce = newNonce();
  try {
    const r = await timeoutFetch(`${url.replace(/\/+$/, '')}/whoami?nonce=${nonce}`, 8000);
    return await checkChallenge(await r.json(), { expectNodeId: nodeId, nonce });
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---------------------------------------------------------------- preflight

const portFree = (port, host) => new Promise((res) => {
  const s = createServer();
  s.once('error', () => res(false));
  s.listen(port, host, () => s.close(() => res(true)));
});

export const onPath = (bin) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) ?? null : null;
};

/** Everything that can be checked before the daemon runs. Each check is
 *  {id, ok, detail, fix?}; `ok: null` means "not applicable here". */
export async function preflight(cfg, { env = readEnv(cfg.home), fetchImpl = fetch, skipNetwork = false } = {}) {
  const checks = [];
  const add = (id, ok, detail, fix = null) => checks.push({ id, ok, detail, ...(fix && ok === false ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('node-version', major >= 20, `node ${process.versions.node}`, 'install Node.js 20+ (winget install OpenJS.NodeJS.LTS / nvm)');

  add('env-file', !!env, env ? `${ENV_FILE} read` : `${ENV_FILE} missing`, `npm run host -- init --operator <name>`);
  const errs = env ? validateEnv(env) : [];
  add('env-valid', env ? errs.length === 0 : null, errs.length ? errs.join('; ') : 'values are well-formed', 'fix node.env (npm run host -- init --operator <name> …)');

  try { mkdirSync(cfg.dataDir, { recursive: true }); accessSync(cfg.dataDir, constants.W_OK); add('data-dir', true, cfg.dataDir); }
  catch (e) { add('data-dir', false, `${cfg.dataDir}: ${e.message}`, 'set DATA_DIR to a writable folder'); }

  const missing = cfg.rulesets.filter((p) => !existsSync(p));
  add('rulesets', cfg.rulesets.length ? missing.length === 0 : null, cfg.rulesets.length ? (missing.length ? `missing: ${missing.join(', ')}` : `${cfg.rulesets.length} file(s)`) : 'none (witness/mesh only)', 'point RULESETS at bundled rulesets/*.js files (npm run bundle:title)');

  const idStarted = readIdentity(cfg.dataDir);
  const running = await health(cfg.localUrl);
  const mine = running && idStarted && running.nodeId === idStarted.nodeId;
  const free = mine ? null : await portFree(cfg.port, cfg.host === '0.0.0.0' ? undefined : cfg.host);
  add('port', mine ? null : free, mine ? `${cfg.port}: this node is already listening` : free ? `${cfg.port} free on ${cfg.host}` : `${cfg.port} in use by something else on ${cfg.host}`, 'choose another PORT or stop what holds it');

  if (cfg.tunnel) add('cloudflared', !!onPath('cloudflared'), onPath('cloudflared') ?? 'cloudflared not on PATH', 'install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) or unset TUNNEL');
  else add('cloudflared', null, 'no TUNNEL configured');

  if (cfg.offline) add('rpc', null, 'OFFLINE=1: local beacon, no chain');
  else if (skipNetwork) add('rpc', null, 'skipped');
  else {
    try {
      const id = Number(await rpcCall(cfg.rpc, 'eth_chainId', [], { fetchImpl, tries: 2 }));
      add('rpc', cfg.chainId == null || id === cfg.chainId, `${cfg.rpc} chainId ${id}${cfg.chainId != null && id !== cfg.chainId ? ` (expected ${cfg.chainId})` : ''}`, 'set RPC to a Liteforge endpoint, or OFFLINE=1 for a local mesh');
    } catch (e) { add('rpc', false, `${cfg.rpc}: ${e.message}`, 'check the network, or OFFLINE=1 for a local mesh'); }
  }

  add('contracts', !!(cfg.nodeStake && cfg.nodeDirectory) || cfg.offline, cfg.offline ? 'not needed offline' : `NodeStake ${cfg.nodeStake ?? '—'} · NodeDirectory ${cfg.nodeDirectory ?? '—'}`, 'contracts/deployed.testnet.json is missing or older than this build; re-apply the release');

  if (skipNetwork || !cfg.seeds.length) add('seeds', cfg.seeds.length ? null : null, cfg.seeds.length ? 'skipped' : 'none configured (the chain directory is the fallback)');
  else {
    const results = await Promise.all(cfg.seeds.map(async (s) => {
      const t0 = Date.now();
      const h = await health(s);
      if (!h) return { url: s, ok: false, detail: 'no /health' };
      let skewMs = null;
      try { const d = (await fetchImpl(`${s}/health`, { method: 'HEAD', signal: AbortSignal.timeout(5000) })).headers.get('date'); if (d) skewMs = Date.parse(d) - (t0 + (Date.now() - t0) / 2); } catch { /* skew unknown */ }
      return { url: s, ok: h.protocol === PROTOCOL_VERSION, protocol: h.protocol, operator: h.operator, skewMs, detail: h.protocol === PROTOCOL_VERSION ? `protocol ${h.protocol}, operator ${h.operator}` : `protocol ${h.protocol}, this build speaks ${PROTOCOL_VERSION}` };
    }));
    const bad = results.filter((r) => !r.ok);
    add('seeds', bad.length === 0, results.map((r) => `${r.url}: ${r.detail}`).join('; '), 'fix SEEDS (a URL that answers /health on protocol ' + PROTOCOL_VERSION + ') or leave it empty');
    const skewed = results.filter((r) => r.skewMs != null && Math.abs(r.skewMs) > 4000);
    add('clock', results.some((r) => r.skewMs != null) ? skewed.length === 0 : null, skewed.length ? skewed.map((r) => `${r.url}: ${Math.round(r.skewMs / 1000)} s`).join('; ') : 'within 4 s of every seed', 'sync this machine\'s clock (a node >4 s behind is stale to everyone)');
  }

  const bonded = cfg.roles.includes('host') || cfg.roles.includes('witness');
  // Gauntlets (node/gauntlet.js): every config loads, its working folder exists, and the gateway
  // does not land on the port a title relay already listens on (RELAY_PORT is the Agent Fighter
  // relay's own port when AF_ROOT is set; the gateway then needs GAUNTLET_GATEWAY_PORT).
  // Publisher services (node/publisher-services.js): every bundle loads, its folder and env files exist.
  if (!cfg.services) add('services', null, 'no SERVICES: this node runs no studio backend');
  else {
    const problems = [], names = [];
    try {
      for (const b of loadServiceBundles(cfg.services, { root: cfg.root })) {
        if (!existsSync(b.cwd)) problems.push(`${b.prefix}: cwd ${b.cwd} not found`);
        for (const f of b.envFiles ?? []) { const p = isAbsolute(f) || /^[A-Za-z]:/.test(f) ? f : join(b.cwd, f); if (!existsSync(p)) problems.push(`${b.prefix}: env file ${p} not found`); }
        names.push(...Object.keys(b.services).map((n) => `${b.prefix}.${n}`));
      }
    } catch (e) { problems.push(e.message); }
    add('services', problems.length === 0, problems.length ? problems.join('; ') : names.join(', '), 'fix SERVICES (docs/BRING-YOUR-BACKEND.md §6c)');
  }
  if (!cfg.gauntlets && cfg.services && cfg.afRoot && cfg.relayPort && cfg.gauntletGatewayPort == null) add('gauntlets', false, `the gateway (for SERVICES) would take RELAY_PORT ${cfg.relayPort}, where the Agent Fighter relay listens; set GAUNTLET_GATEWAY_PORT (e.g. 8478)`, 'set GAUNTLET_GATEWAY_PORT');
  else if (!cfg.gauntlets) add('gauntlets', null, 'no GAUNTLETS: this node runs no title match servers');
  else {
    let problems = [], titles = [];
    try {
      const configs = loadGauntletConfigs(cfg.gauntlets, { root: cfg.root });
      titles = Object.keys(configs);
      for (const [rid, c] of Object.entries(configs)) if (c.cwd && !existsSync(c.cwd)) problems.push(`${rid}: cwd ${c.cwd} not found`);
    } catch (e) { problems.push(e.message); }
    if (cfg.afRoot && cfg.relayPort && cfg.gauntletGatewayPort == null) problems.push(`the gateway would take RELAY_PORT ${cfg.relayPort}, where the Agent Fighter relay listens; set GAUNTLET_GATEWAY_PORT (e.g. 8478)`);
    if (cfg.gauntletGatewayPort != null && cfg.gauntletGatewayPort === cfg.relayPort) problems.push('GAUNTLET_GATEWAY_PORT equals RELAY_PORT');
    add('gauntlets', problems.length === 0, problems.length ? problems.join('; ') : `${titles.join(', ')} on gateway :${cfg.gauntletGatewayPort ?? cfg.relayPort ?? '(ephemeral, this machine only)'}`, 'fix GAUNTLETS / GAUNTLET_GATEWAY_PORT (docs/BRING-YOUR-BACKEND.md §6a)');
  }
  add('roles', true, `${cfg.roles.join(',')}${bonded ? ' (needs a bond to be placed / co-sign)' : ''}`);
  return { ok: checks.every((c) => c.ok !== false), checks };
}

// -------------------------------------------------------------------- stages

/** Read every source of truth once. Any read that fails is null and the
 *  plan says why the stage is unknown rather than guessing. */
export async function inspect(cfg, { fetchImpl = fetch, chain = true } = {}) {
  const env = readEnv(cfg.home);
  const identity = readIdentity(cfg.dataDir);
  const h = await health(cfg.localUrl);
  const mine = h && identity && h.nodeId === identity.nodeId ? h : null;
  const [p, t] = mine ? await Promise.all([peers(cfg.localUrl), titles(cfg.localUrl)]) : [null, null];
  const nodeId = identity?.nodeId ?? null;
  const advertised = mine?.tunnel?.node?.url ?? mine?.addr ?? null;
  let standing = null, entry = null, balance = null, proof = null, chainError = null;
  if (chain && nodeId && !cfg.offline) {
    try {
      [standing, entry] = await Promise.all([chainStanding(cfg, nodeId, { fetchImpl }), directoryEntry(cfg, nodeId, { fetchImpl })]);
      if (identity.announcer) balance = await announcerBalance(cfg, identity.announcer, { fetchImpl });
    } catch (e) { chainError = e.message; }
  }
  if (mine && advertised && /^https?:\/\//.test(advertised) && !/127\.0\.0\.1|localhost/.test(advertised)) proof = await prove(advertised, nodeId);
  const service = serviceStatus(cfg);
  return { at: new Date().toISOString(), env, identity, health: mine, foreign: h && !mine ? { nodeId: h.nodeId, operator: h.operator } : null, peers: p, titles: t, standing, entry, balance, proof, chainError, service, advertised };
}

/** Turn an inspection into an ordered checklist and the one next command.
 *  status: done | todo | blocked | optional | unknown. */
export function plan(cfg, s) {
  const stages = [];
  const stage = (id, status, detail, next = null, needs = []) => stages.push({ id, status, detail, ...(next ? { next } : {}), ...(needs.length ? { needs } : {}) });
  const host = (p) => `npm run host -- ${p}`;
  const wantsPublic = cfg.roles.includes('host') || !!cfg.tunnel || cfg.publicAddrExplicit;
  const wantsBond = cfg.roles.includes('host') || cfg.roles.includes('witness') || cfg.roles.includes('settler');

  // 1 configure
  if (!s.env) stage('configure', 'todo', `${ENV_FILE} missing`, host('init --operator <name> [--seeds <url>] [--roles mesh,host,witness,settler] [--tunnel quick]'));
  else { const errs = validateEnv(s.env); stage('configure', errs.length ? 'todo' : 'done', errs.length ? errs.join('; ') : `operator ${cfg.operator}, roles ${cfg.roles.join(',')}, port ${cfg.port}`, errs.length ? host('init …') : null); }

  // 2 identity
  stage('identity', s.identity ? 'done' : 'todo', s.identity ? `nodeId ${s.identity.nodeId}` : 'no identity.json yet', s.identity ? null : host('identity'));

  // 3 running
  if (s.health) stage('running', 'done', `v${s.health.version} protocol ${s.health.protocol} up ${Math.round(s.health.uptimeMs / 1000)} s at ${cfg.localUrl}`);
  else if (s.foreign) stage('running', 'blocked', `${cfg.localUrl} answers as ${s.foreign.operator} (${s.foreign.nodeId.slice(0, 12)}…), not this identity`, 'stop that node or change PORT');
  else stage('running', 'todo', `nothing answers at ${cfg.localUrl}`, host('start --detach'));

  // 4 protocol / update
  if (s.health) {
    const u = s.health.update ?? {};
    stage('current', u.available ? 'todo' : 'done', u.available ? `release ${u.latest ?? '?'} available (running ${s.health.version})` : `release ${s.health.version} (${cfg.releaseChannel})`, u.available ? 'npm run update' : null);
  } else stage('current', 'unknown', 'node not running');

  // 5 hosting
  if (!cfg.roles.includes('host')) stage('hosting', 'optional', 'no host role');
  else if (!s.health) stage('hosting', 'unknown', 'node not running');
  else { const ids = Object.keys(s.health.rulesets ?? {}); stage('hosting', ids.length ? 'done' : 'todo', ids.length ? `${ids.join(', ')}${s.health.refused ? ` (${s.health.refused} refused)` : ''}` : 'no ruleset loaded', ids.length ? null : 'set RULESETS in node.env (see the host-a-title skill) and restart'); }

  // 6 connected
  if (!s.health) stage('connected', 'unknown', 'node not running');
  else {
    const fresh = (s.peers?.peers ?? []).filter((p) => p.fresh);
    const incompatible = s.peers?.incompatible?.length ?? 0;
    const chainSeeds = s.health.directory?.seeds ?? 0;
    stage('connected', fresh.length ? 'done' : (cfg.seeds.length || chainSeeds) ? 'todo' : 'todo', `${fresh.length} fresh peer(s), ${s.health.peers} bonded, ${incompatible} incompatible, ${chainSeeds} chain seed(s)`, fresh.length ? null : cfg.seeds.length ? 'wait ~10 s; then check SEEDS answer /health' : 'set SEEDS=<a running node url> in node.env, or wait for NodeDirectory seeds');
  }

  // 7 reachable
  if (!s.health) stage('reachable', wantsPublic ? 'unknown' : 'optional', 'node not running');
  else {
    const tn = s.health.tunnel?.node;
    const inbound = s.health.inbound?.reachable;
    if (tn && tn.state === 'up' && s.proof?.ok) stage('reachable', 'done', `${tn.url} proves this key (${tn.mode} tunnel)`);
    else if (tn && tn.state === 'up') stage('reachable', 'todo', `${tn.url} up but proof failed: ${s.proof?.reason ?? 'not checked'}`, 'wait for the tunnel to settle, then re-run status');
    else if (tn && tn.state !== 'up') stage('reachable', 'todo', `tunnel ${tn.state}${tn.lastError ? `: ${tn.lastError}` : ''}`, tn.state === 'missing' ? 'install cloudflared and restart' : 'wait; the node restarts cloudflared itself');
    else if (inbound === true) stage('reachable', 'done', `peers reach ${s.health.addr} (${s.health.inbound.peers} inbound)`);
    else if (s.health.upnp?.cgnat) stage('reachable', 'todo', `behind carrier-grade NAT (${s.health.upnp.publicIp}); only a tunnel works`, host('publish --tunnel quick'));
    else if (wantsPublic) stage('reachable', 'todo', `advertising ${s.health.addr}; no inbound gossip yet`, host('publish --tunnel quick'));
    else stage('reachable', 'optional', `witness-only nodes need no inbound path (advertising ${s.health.addr})`);
  }

  // 8 bonded
  if (cfg.offline) stage('bonded', 'optional', 'OFFLINE=1: no chain');
  else if (!s.identity) stage('bonded', 'unknown', 'no identity yet');
  else if (s.chainError) stage('bonded', 'unknown', `chain read failed: ${s.chainError}`);
  else if (s.standing?.active) stage('bonded', 'done', `${Number(s.standing.amount / 10n ** 15n) / 1000} tLITVM by ${s.standing.operator}`);
  else stage('bonded', wantsBond ? 'todo' : 'optional', `not bonded (${cfg.minStake ? Number(BigInt(cfg.minStake) / 10n ** 15n) / 1000 : '?'} tLITVM minimum)`, host('bond'), ['OPERATOR_KEY (the operator wallet; set in this shell only, never in a file)']);

  // 9 announced
  const wantsAnnounce = !!cfg.tunnel && cfg.announce;
  if (cfg.offline || !cfg.nodeDirectory) stage('announced', 'optional', 'no NodeDirectory');
  else if (!s.identity) stage('announced', 'unknown', 'no identity yet');
  else if (s.chainError) stage('announced', 'unknown', `chain read failed: ${s.chainError}`);
  else {
    const delegated = !!s.entry?.delegatedAnnouncer && s.entry.delegatedAnnouncer.toLowerCase() === (s.identity.announcer ?? '').toLowerCase();
    const funded = s.balance != null && s.balance > 0n;
    const current = s.entry?.url && s.advertised && s.entry.url === s.advertised;
    if (current) stage('announced', 'done', `${s.entry.url} on NodeDirectory (updated ${new Date(Number(s.entry.updatedAt) * 1000).toISOString()})`);
    else if (!delegated) stage('announced', wantsAnnounce ? 'todo' : 'optional', `announcer ${s.identity.announcer} not delegated`, host('announce --fund 0.02'), ['OPERATOR_KEY']);
    else if (!funded) stage('announced', wantsAnnounce ? 'todo' : 'optional', `announcer ${s.identity.announcer} delegated but has no gas`, host('announce --fund 0.02'), ['OPERATOR_KEY']);
    else if (!s.advertised || !s.health) stage('announced', 'todo', 'delegated and funded; the node announces once it is up with a public URL', host('start --detach'));
    else stage('announced', 'todo', `delegated and funded; chain says ${s.entry?.url || '(nothing)'}, node advertises ${s.advertised} — the node re-announces within ~2 min`, 'wait, then re-run status');
  }

  // 10 service
  if (s.service.installed) stage('service', 'done', s.service.detail);
  else stage('service', 'optional', `not installed (${s.service.kind}); the node stops with this shell${s.service.foreign ? ` — note: ${s.service.detail}` : ''}`, host('install-service'));

  const order = ['configure', 'identity', 'running', 'current', 'hosting', 'connected', 'reachable', 'bonded', 'announced', 'service'];
  const byId = Object.fromEntries(stages.map((x) => [x.id, x]));
  const next = order.map((id) => byId[id]).find((x) => x && (x.status === 'todo' || x.status === 'blocked') && x.next) ?? null;
  const ready = stages.every((x) => x.status !== 'todo' && x.status !== 'blocked');
  return { ready, stages, next: next ? { stage: next.id, command: next.next, why: next.detail, ...(next.needs ? { needs: next.needs } : {}) } : null };
}

// ------------------------------------------------------------------- service

/** Is a start-at-logon service installed FOR THIS INSTALL? A task or unit
 *  that runs another folder's node (a production install beside a
 *  checkout, say) is reported as `foreign` and never touched. */
export function serviceStatus(cfg) {
  if (process.platform === 'win32') {
    const name = cfg.serviceName ?? 'litnode';
    const q = spawnSync('schtasks', ['/Query', '/TN', name, '/FO', 'LIST', '/V'], { encoding: 'utf8', windowsHide: true });
    if (q.status !== 0) return { kind: 'schtasks', name, installed: false, ours: false, detail: `no scheduled task ${name}` };
    const state = /Status:\s*(\S+)/.exec(q.stdout)?.[1] ?? '?';
    const startIn = (/Start In:\s*(.+)/.exec(q.stdout)?.[1] ?? '').trim().replace(/[\\/]+$/, '');
    const run = (/Task To Run:\s*(.+)/.exec(q.stdout)?.[1] ?? '').trim();
    const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
    const ours = !!startIn && same(startIn, cfg.root) && (/supervisor\.mjs/i.test(run) || /run-node\.cmd/i.test(run));
    return { kind: 'schtasks', name, installed: ours, ours, state, detail: ours ? `scheduled task ${name}: ${state} (${/supervisor/i.test(run) ? 'harness supervisor' : 'run-node.cmd'})` : `scheduled task ${name} belongs to ${startIn || 'another install'} (${state}); not this one — set SERVICE_NAME in node.env to install this node beside it`, ...(ours ? {} : { foreign: startIn || run }) };
  }
  const sup = join(cfg.root, 'sdk', 'host', 'supervisor.mjs');
  if (process.platform === 'darwin') {
    const p = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `games.litvm.${cfg.serviceName ?? 'litnode'}.plist`);
    if (!existsSync(p)) return { kind: 'launchd', installed: false, ours: false, detail: 'no LaunchAgent' };
    const ours = readFileSync(p, 'utf8').includes(sup);
    return { kind: 'launchd', installed: ours, ours, detail: ours ? p : `${p} runs another install`, ...(ours ? {} : { foreign: p }) };
  }
  const p = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'), 'systemd', 'user', `${cfg.serviceName ?? 'litnode'}.service`);
  if (!existsSync(p)) return { kind: 'systemd', installed: false, ours: false, detail: 'no user unit' };
  const ours = readFileSync(p, 'utf8').includes(sup);
  return { kind: 'systemd', installed: ours, ours, detail: ours ? p : `${p} runs another install`, ...(ours ? {} : { foreign: p }) };
}
