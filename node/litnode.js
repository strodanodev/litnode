/** litnode — the daemon anyone runs. BUILD-SPEC v0.2 §1.
 *
 *  This slice: identity on disk, signed heartbeat gossip, bonded snapshot,
 *  ruleset fetch-by-hash, signed queue intake, deterministic pairing and
 *  placement served over HTTP. Settlement (ledger intake, witness replay,
 *  epoch tree) is the next slice and is NOT here yet.
 *
 *  Dependency-free: node:http + fetch. One process = one node. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { h, canonical } from '../protocol/canonical.js';
import { generateKeypair, seal, opened, verify } from '../protocol/keys.js';
import { snapshot as buildSnapshot, HEARTBEAT_TAG, epochOf, EPOCH_MS, isFresh } from '../protocol/snapshot.js';
import { applyStakes, bondProof, bondMessage } from '../protocol/staking.js';
import { pair, QUEUE_TAG, bucketOf, isStale } from '../protocol/pairing.js';
import { CHAT_TAG, chatBody, chatId, chatProblem, chatRateOk, chatRoot, CHAT_PAST_MS, CHAT_RING, CHAT_UNBONDED_RING, CHAT_PUSH_WINDOW_MS, CHAT_PER_MESSAGE, CHAT_SEEN_MAX } from '../protocol/chat.js';
import { hourOf } from '../protocol/epoch.js';
import { install as installDoh } from './dns.js';
import { placement } from '../protocol/placement.js';
import { createChain } from './chain.js';
import { MAX_LOG_BYTES, createSettlement } from './settle.js';
import { createMatchBook } from './matchbook.js';
import { matchIdBytes32 } from '../protocol/matchbook.js';
import { createUpdater, RESTART_EXIT } from './update.js';
import { createTunnel } from './tunnel.js';
import { createRo3Host, ro3Entry, ro3Name } from './ro3.js';
import { createGauntlets } from './gauntlet.js';
import { openBundle, writeFiles, configFromBundle, runtimeOk, permanent, MANIFEST_NAME, MAX_BUNDLE_BYTES } from './server-bundle.js';
import { createServices as createPublisherServices } from './publisher-services.js';
import { policyOf, scanDataDir } from './secrets.js';
import { keepMapped } from './upnp.js';
import { createAnnouncer } from './announce.js';
import { createAirVerifier } from './air.js';
import { createProxyWallets } from './proxy.js';
import { randomPrivateKey, addressOf } from '../protocol/evm.js';
import { liveSeeds } from '../protocol/directory.js';
// The SDK ships in the release zip. An install that an OLDER updater brought
// to this build may lack it (0.6.x copy lists predate sdk/): a static import
// would crash at link time on every relaunch, forever. Load it dynamically
// and, when it is missing, start anyway and repair by re-applying the
// current release (node/update.js apply({force})).
let conformance = null, staticCheck = null, sdkMissing = null;
try { ({ check: conformance, staticCheck } = await import('../sdk/conformance.mjs')); }
catch (e) { sdkMissing = e?.code === 'ERR_MODULE_NOT_FOUND' ? 'sdk/ is missing from this install' : `sdk failed to load: ${e.message}`; }
import { createSandbox } from './sandbox.js';
import { RELEASE_PUBKEY } from './update.js';
import { titleVerdict } from '../protocol/title.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { progression, progressOf } from '../protocol/progression.js';
import { answerChallenge, checkChallenge, newNonce, NONCE_RE } from '../protocol/challenge.js';
import { CABINET_VERSION } from '../cabinet/version.js';
import { descriptorHash as descriptorHashOf } from './settle.js';
import { proposeCalldata } from '../protocol/epoch.js';
import { verifyReport } from '../protocol/guardian.js';

// Every response is readable from any origin, and from an https page reaching
// a loopback node (Chrome's Private Network Access asks on the preflight).
// A POST with a JSON body from another origin (the cabinet on localhost
// talking to 127.0.0.1, or the hosted cabinet) is preflighted: the OPTIONS
// answer must name the method and the header or the POST never leaves the
// browser (net::ERR_FAILED, seen live 17 Sep 2026 on Find match).
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
const json = (res, status, body) => {
  // A second answer on the same response (a route that wrote, then threw,
  // then hit the handler's catch) must be a no-op, never a throw: an
  // ERR_HTTP_HEADERS_SENT escaping the async handler is an unhandled
  // rejection and took the desktop node down twice on 20 Sep 2026 — each
  // crash rotating both tunnel hostnames.
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, { 'content-type': 'application/json', ...CORS });
    // A BigInt anywhere in a body would throw here, AFTER the headers went out — the reply then dies mid-air. Stringify it.
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch { try { res.destroy(); } catch { /* gone */ } }
};
/** Read a request body up to MAX_BODY bytes. Past the cap the socket is destroyed: a rejected promise
 *  alone left the closure concatenating until the string limit (audit of 21 Oct 2026). */
const MAX_BODY = 4e6;
const readText = (req) => new Promise((resolve, reject) => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); }
  let s = '', done = false;
  const fail = (e) => { if (done) return; done = true; req.destroy(); reject(e); };
  req.on('data', (d) => { if (done) return; s += d; if (s.length > MAX_BODY) fail(new Error('body too large')); });
  req.on('end', () => { if (!done) { done = true; resolve(s); } });
  req.on('error', fail);
});
const readBody = async (req) => { const s = await readText(req); return s ? JSON.parse(s) : {}; };

/** A peer address a heartbeat may carry: an http(s) origin and nothing else. A path or a query would let a
 *  peer steer this node's own gossip push at an arbitrary route — `${addr}/gossip` against
 *  `http://127.0.0.1:7801/update?x=` reached the loopback-only updater (audit of 21 Oct 2026). */
export function peerOrigin(addr) {
  if (typeof addr !== 'string' || addr.length > 200) return null;
  let u;
  try { u = new URL(addr); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (!/\/\/[^/]+\/?$/.test(addr)) return null; // the exact text must be the origin: nothing a URL parser silently drops
  return u.origin;
}

export const rulesetHash = (source) => h('ruleset', source);

export async function createNode({
  dataDir, port = 0, host = '127.0.0.1', publicAddr = null,
  operator = 'dev', roles = ['mesh', 'witness'], region = 'local', wsAddr: wsAddrIn = null,
  seeds = [], rulesets = [], rpc = null, offline = !rpc, nodeStake = null, playerProfile = null, chainFetch = globalThis.fetch,
  version = null, updates = true, releaseUrl = undefined, releaseChannel = 'stable', onRestart = null,
  // Tunnels the node owns (node/tunnel.js): 'quick' | 'named' for this
  // node's own port; relayPort fronts a title's relay on this machine and
  // advertises it as wsAddr. tunnelBin is for tests.
  tunnel = null, tunnelName = null, tunnelHost = null, relayPort = null, relayTunnelName = null, relayTunnelHost = null, tunnelBin = undefined,
  // How a new tunnel URL is checked from the outside before it is advertised (tests inject one): url → true when this node answered through it.
  tunnelProbe = null,
  // RO3Emu's tunnel front on this machine (RO3_PORT, node/ro3.js): fronted by its own quick tunnel and advertised as
  // `ro3` in the heartbeat. ro3Probe replaces the outside check in tests: url → true when RO3Emu answered through it.
  ro3Port = null, ro3Name: ro3NameIn = null, ro3Probe = null,
  // Relay verification: (url) → true when a WebSocket opens through it. Default: a real WebSocket open (8 s);
  // tests pass a fake. A relay tunnel is advertised and announced only once this passes, and dropped when it stops.
  relayProbe = null,
  // The contract generation deployed.testnet.json says the addresses above belong to (cli.mjs passes it); /fleet reports it beside the addresses so a cabinet can spot skew.
  contractsGeneration = null,
  // UPnP: ask the router to forward our port (and the relay's) — what a
  // torrent client does. Reports CGNAT when the ISP makes it pointless.
  upnp = false, upnpGateway = null,
  // NodeDirectory: read the live seed list from the chain (bootstrap) and,
  // with a delegated announcer key, publish our own addresses there.
  nodeDirectory = null, chainId = null, announce = true,
  // ReleaseRegistry (BUILD-SPEC v0.3 §2.4): a release must be registered on
  // chain and active before this node applies it. Unset → signature only.
  releaseRegistry = null,
  // TitleRegistry: a title is an ERC-721 whose holder is the publisher; a
  // build from a PEER loads when the chain says it is registered under its
  // title and active (or, still, when signed by a TRUSTED_PUBLISHERS key).
  // /titles.published says whether the publisher runs a bonded host for it.
  titleRegistry = null, titleRefreshMs = 60_000,
  // The stake token (TestLITVM on testnet): only so an AIR account's proxy can bond this node (POST /air/bond).
  stakeToken = null,
  // MatchBook (§6, §11): ranked matches are committed, settled and attested
  // on chain from this node's delegated key; ladders fold the event log.
  // Unset → v0.2 local settlement, gossip-advertised deltas, never official
  // beyond this node's own view. `matchBookFromBlock`: where a fresh node
  // starts reading the log (the deploy block); `matchBookWindows` in seconds.
  matchBook: matchBookAddr = null, gasRefund = null, matchBookFromBlock = 0, matchBookWindows = { attestWindow: 120, escalationWindow: 300 }, matchBookDrive = true,
  // Custody before settle (0.12.2): false makes this node neither wait for its seats nor take custody as one, as 0.12.1 (tests: a mixed fleet).
  matchBookCustody = true,
  // EpochAnchor v3: the settler proposes each frozen hour's root over the chain-finalized set from its delegate.
  epochAnchor = null,
  // ERC6699Registry (this project's proposed interface): characters for
  // ranked play are read from here at the placement's block, never from
  // the submission. Unset → hydration is labelled fixture/external.
  erc6699 = null,
  // Title sandbox (node/sandbox.js): every replay runs in a separate,
  // permission-restricted process with these limits.
  sandboxTimeoutMs = 10_000, sandboxMemoryMb = 256,
  // Which builds this node will load from PEERS. 'trusted' (default): only
  // builds whose {rulesetId, buildHash} attestation is signed by a key in
  // trustedPublishers (default: the litVM release key). 'open': any build
  // that passes conformance — the sandbox is then the only boundary.
  // Builds named in RULESETS (local files) are the operator's own choice
  // and always load.
  titleTrust = 'trusted', trustedPublishers = [RELEASE_PUBKEY],
  // Courts this operator authorizes for attested titles: rulesetId → [pubkeys].
  courts = {},
  verifiers = {}, // rulesetId → [verifierHash] the operator accepts as registered (VERIFIERS); TitleRegistry is the normal source
  // Relay keys whose signed submissions this host accepts as 'relay' provenance.
  relayKeys = [],
  // Universal login (docs/UNIVERSAL-LOGIN.md): verify AIR Kit session tokens
  // and keep litVM proxy wallets for AIR accounts. Needs playerProfile and a
  // chain. { partnerId, jwksUrl } — partnerId pins tokens to one partner app.
  air = null,
  // Gauntlet loops (node/gauntlet.js): per-match headless servers this node
  // runs for titles whose sim is a process. {rulesetId: config}. The gateway
  // listens on gauntletPort (or relayPort when that is unset) and the relay
  // tunnel fronts the gateway; rooms it does not know go to gauntletUpstream,
  // which defaults to the title relay on relayPort when both ports are set —
  // so a node that already fronts a relay (Agent Fighter's, whose wrapper
  // listens on RELAY_PORT) adds gauntlets with GAUNTLET_GATEWAY_PORT alone.
  gauntlets = {}, gauntletUpstream = null, gauntletPort = null,
  // Each match's process output, kept per title under <dataDir>/gauntlet-logs (node/gauntlet.js openProcessLog):
  // { maxBytes, keep } override the size cap per file and the files kept per title; { dir: null } keeps none.
  gauntletLogs = {},
  // Secrets rule (node/secrets.js, docs/SETTLEMENT-ARCHITECTURE.md §11): 'warn' reports a publisher secret in a
  // service's or gauntlet's environment; 'strict' (Season 0) refuses to start that process.
  secretsPolicy = 'warn',
  // Server bundles (node/server-bundle.js): a gauntlet title's match server as a hashed artifact.
  // { rulesetId: null } opts in to fetching the title's bundle from peers (admitted by TitleRegistry or a
  // TRUSTED_PUBLISHERS signature) and running it; { rulesetId: '<path>.tgz' } is this operator's own file (the
  // publisher's node), served to peers. Either way the title joins `gauntlets` once the bundle is held.
  gauntletServers = {},
  // Publisher services (node/publisher-services.js): a title's long-lived backend — matchmaker,
  // accounts API, a court pool — supervised here and published on the gateway at /svc/<prefix>.<name>.
  services: serviceBundles = [],
  heartbeatMs = EPOCH_MS / 2, log = () => {}, onEvent = () => {},
}) {
  // Every observable thing the node does goes through emit(): the TUI draws
  // from it, a log file gets a line per event, tests can subscribe. Never
  // throws into the caller.
  // The last RECENT_MAX events worth a line on a dashboard — not the per-second ticks — served on /fleet.events.
  const RECENT_MAX = 100, QUIET = new Set(['gossip.out', 'gossip.in', 'block', 'guardian.ok']);
  const recent = [];
  const emit = (type, data = {}) => {
    const ev = { t: Date.now(), type, ...data };
    if (!QUIET.has(type)) { recent.push(ev); if (recent.length > RECENT_MAX) recent.shift(); }
    try { onEvent(ev); } catch { /* observer's problem */ }
  };
  // Event-loop stalls. A node that cannot answer for seconds looks dead to its peers and to Cloudflare
  // (502/530/524), and the cause is rarely visible from outside: the desktop froze for up to 34 s while the
  // machine idled (4 Oct 2026). A 250 ms timer that fires late measures how long the loop was blocked; past a
  // second it is logged with the events just before it, and counted on /health and /fleet.
  const STALL_MS = 1000, STALL_TICK = 250;
  const stalls = { count: 0, maxMs: 0, last: null };
  let stallAt = performance.now();
  const stallTimer = setInterval(() => {
    const now = performance.now(), lag = Math.round(now - stallAt - STALL_TICK);
    stallAt = now;
    if (lag < STALL_MS) return;
    const after = recent.slice(-3).map((e) => e.type).join(', ') || 'nothing logged';
    stalls.count++; stalls.maxMs = Math.max(stalls.maxMs, lag); stalls.last = { at: new Date().toISOString(), ms: lag, after };
    log(`event loop stalled ${lag} ms (after: ${after})`);
  }, STALL_TICK);
  stallTimer.unref?.();
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'rulesets'), { recursive: true });
  if (!offline) installDoh({ log }); // once per process: quick-tunnel names — ours and our peers' — resolve through Cloudflare's DoH
  const startedAt = Date.now(); // /health reports it so a dashboard can show process uptime
  // Lite-guardian reports: advisory, in memory, bounded. matchId → Map(guardianId → report).
  const guardianReports = new Map();
  const guardianWindow = new Map(); // guardianId → { from, n } — per-guardian rate limit
  const guardianRecent = [];        // newest last, for /fleet
  const GUARDIAN_PER_MIN = 30, GUARDIAN_MATCHES = 5000, GUARDIANS_PER_MATCH = 64;
  const guardianSummary = () => {
    let reports = 0; const flagged = [];
    for (const [matchId, m] of guardianReports) { reports += m.size; if ([...m.values()].some((r) => r.verdict === 'inconsistent')) flagged.push(matchId); }
    return { matches: guardianReports.size, reports, flagged };
  };
  const guardianFleet = () => {
    const { matches, reports, flagged } = guardianSummary();
    const hourAgo = Date.now() - 3_600_000;
    const active = new Set(guardianRecent.filter((r) => r.receivedAt > hourAgo).map((r) => r.guardianId));
    return { matches, reports, flagged: flagged.slice(-20), flaggedCount: flagged.length, guardiansLastHour: active.size, recent: guardianRecent.slice(-20) };
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  version ??= (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch { return null; } })();

  // ---------------------------------------------------------------- updates
  // A release is an artifact like a ruleset, plus a signature (node/update.js).
  // Checked hourly; applied only on request, and only from this machine.
  const chain = createChain({ rpc: rpc ?? 'offline', offline, nodeStake, playerProfile, nodeDirectory, erc6699, releaseRegistry, titleRegistry, fetchImpl: chainFetch });
  const updater = createUpdater({ root, version: version ?? '0.0.0', releaseUrl, channel: releaseChannel, dataDir, log,
    registry: releaseRegistry && !offline ? { statusOf: chain.releaseStatus } : null });
  const checkUpdates = async () => { if (!updates || !version) return; const before = updater.status().available; await updater.check(); const s = updater.status(); if (s.available && !before) emit('update', { version: s.version, latest: s.latest }); };
  // Self-repair: this build started without a directory it needs. Re-apply
  // the current release (which carries it) and restart; until then no build
  // is verified or loaded, and /health says `repair`.
  if (sdkMissing) {
    log(`REPAIR: ${sdkMissing} — re-applying release ${version} to fill it`);
    (async () => {
      try { await updater.check(); const r = await updater.apply({ force: true }); log(`repair: applied ${r.to} (${r.changed.join(', ')}); restarting`); restart(); }
      catch (e) { log(`repair failed: ${e.message} — unzip the current release over this folder and restart`); }
    })();
  }
  // This machine only. cloudflared (and any local reverse proxy) connects
  // from 127.0.0.1 too, so a loopback socket that carries forwarding headers
  // is a public caller relayed through the tunnel, not the operator.
  // A request this node sent itself (its gossip push carries x-litnode-from) is never the operator either.
  const FORWARDED = ['cf-connecting-ip', 'cf-ray', 'cdn-loop', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'x-litnode-from'];
  const isLoopback = (req) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress ?? '')
    && !FORWARDED.some((h) => h in req.headers);
  const restart = (why = 'to run the new build') => { log(`restarting ${why}`); emit('restart', {}); setTimeout(() => { if (onRestart) onRestart(); else process.exit(RESTART_EXIT); }, 300); };
  // Unsigned (host-labelled) ledgers per remote address: a sliding minute, a bounded table.
  const UNSIGNED_LEDGERS_PER_MIN = 10;
  let lastPruneAt = 0;
  const unsignedLedgers = new Map(); // address → [at, …]
  const unsignedLedgerOk = (from) => {
    const now = Date.now();
    const recent = (unsignedLedgers.get(from) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= UNSIGNED_LEDGERS_PER_MIN) { unsignedLedgers.set(from, recent); return false; }
    recent.push(now); unsignedLedgers.set(from, recent);
    if (unsignedLedgers.size > 4096) for (const [k, v] of unsignedLedgers) { if (v.every((t) => now - t >= 60_000)) unsignedLedgers.delete(k); if (unsignedLedgers.size <= 2048) break; }
    return true;
  };

  // ---------------------------------------------------------------- identity
  const idPath = join(dataDir, 'identity.json');
  const identity = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : await generateKeypair();
  if (!existsSync(idPath)) writeFileSync(idPath, JSON.stringify(identity, null, 2) + '\n');
  const nodeId = identity.publicKey;

  const sandbox = createSandbox({ timeoutMs: sandboxTimeoutMs, memoryMb: sandboxMemoryMb, log });
  if (!sandbox.flag) throw new Error('this Node runtime has no permission model (--permission); litnode refuses to host titles without the sandbox');

  // ---------------------------------------------------------------- player profiles
  // key → { owner, tokenId, active, at }. Read like stakes: every tick, for
  // keys seen in the queue or in settled deltas, refreshed after PROFILE_TTL;
  // merged, never replaced. Unset contract → keys are players, reported.
  const profileCache = new Map();
  const PROFILE_TTL = 30_000;
  const profileState = () => (!playerProfile ? 'unset' : offline ? 'offline' : profilesRead ? 'chain' : 'unreadable');
  let profilesRead = false;
  const profilesFor = (keys) => Object.fromEntries(keys.filter((k) => profileCache.has(k)).map((k) => [k, profileCache.get(k)]));
  const refreshProfiles = async (keys) => {
    if (!playerProfile || offline) return;
    const now = Date.now();
    // Only real player keys: relay-era deltas name players `af:<name>`, which no contract can answer for.
    const stale = [...new Set(keys)].filter((k) => /^[0-9a-f]{64}$/i.test(k) && now - (profileCache.get(k)?.at ?? 0) > PROFILE_TTL).slice(0, 50);
    if (!stale.length) return;
    const got = await chain.profiles(stale);
    if (!got) return;
    for (const [k, v] of Object.entries(got)) { const prev = profileCache.get(k); profileCache.set(k, { ...v, at: now }); if (prev && prev.active && !v.active) emit('revoked', { playerId: k, owner: prev.owner }); }
    profilesRead = true;
  };

  // ---------------------------------------------------------------- rulesets
  const loaded = new Map(); // rulesetId → CURRENT build (advertised)
  // Every build this node has ever held, by hash. A delta names the build it
  // was settled with; a witness must replay in THAT build, not the newest.
  // Nothing is ever evicted: an old delta stays verifiable for as long as
  // one node kept the bytes (BUILD-SPEC §4).
  //
  // A build is { rulesetId, buildHash, source, manifest, kind, publisher,
  // sig, origin }. There is NO title object: title code never runs in this
  // process. Manifest and replays come out of the sandbox.
  const builds = new Map();
  const BUILD_TAG = 'build';
  /** The chain's word on a peer's build: TitleRegistry says the build is
   *  registered under its title and active. null = no registry configured.
   *  A read failure shuts THIS gate (unreadable is not unregistered); the
   *  signature gate below may still open. Cached a minute per build so
   *  gossip cannot make us re-ask the RPC for the same hash. */
  const titleVerdicts = new Map(); // `${rulesetId}|${buildHash}` → { at, verdict }
  const buildRegistered = async (rulesetId, buildHash) => {
    if (!titleRegistry || offline) return null;
    const k = `${rulesetId}|${buildHash}`, c = titleVerdicts.get(k);
    if (c && Date.now() - c.at < titleRefreshMs) return c.verdict;
    let verdict;
    try { verdict = titleVerdict(await chain.titleBuild(rulesetId, buildHash)); }
    catch (e) { verdict = { ok: false, reason: `unreadable (${e.message})` }; }
    titleVerdicts.set(k, { at: Date.now(), verdict });
    return verdict;
  };
  // rulesetId → the title's publisher (token holder) on chain, lowercase; null = unregistered. Refreshed each minute for every title the mesh hosts.
  const titleOwners = new Map();
  const titleBuilds = new Map(); // rulesetId → the verdict on the build THIS node serves (for the publisher panel)
  let lastTitleRead = 0;
  const refreshTitleOwners = async () => {
    if (!titleRegistry || offline || Date.now() - lastTitleRead < titleRefreshMs) return;
    lastTitleRead = Date.now();
    const ids = new Set(loaded.keys());
    for (const b of heartbeats.values()) for (const rid of Object.keys(b.manifests ?? {})) ids.add(rid);
    for (const rid of ids) { try { const o = await chain.titleOwner(rid); titleOwners.set(rid, o ? o.toLowerCase() : null); } catch { /* keep what we knew */ } }
    for (const [rid, b] of loaded) { try { titleBuilds.set(rid, titleVerdict(await chain.titleBuild(rid, b.buildHash))); } catch { /* keep */ } }
  };
  /** Who vouches for a build: sig = sign('build', { rulesetId, buildHash }, publisherKey). */
  const buildAttested = async (rulesetId, buildHash, att) => !!att?.publisher && !!att?.sig && trustedPublishers.includes(att.publisher) && (await verify(BUILD_TAG, { rulesetId, buildHash }, att.sig, att.publisher));
  /** Install a ruleset ONLY if its bytes hash to the pinned value, it passes
   *  the STATIC stage (nothing has executed anywhere yet), it passes the
   *  SANDBOX stage (executed only inside node/sandbox.js), and — for a build
   *  that did not come from this operator's own RULESETS — the trust policy
   *  admits it. A refusal executes no title code in this process; a refused
   *  build is remembered so peers cannot make us re-run the suite forever. */
  const refused = new Map(); // buildHash → reason
  const installRuleset = async (source, expectedHash, { current = true, origin = 'peer', attestation = null } = {}) => {
    const actual = rulesetHash(source);
    if (expectedHash && actual !== expectedHash) throw new Error(`ruleset hash mismatch: expected ${expectedHash.slice(0, 12)} got ${actual.slice(0, 12)}`);
    if (builds.has(actual)) { const b = builds.get(actual); if (current) loaded.set(b.rulesetId, b); return b; }
    if (refused.has(actual)) throw new Error(`ruleset ${actual.slice(0, 12)} refused earlier: ${refused.get(actual)}`);
    if (sdkMissing) throw new Error(`cannot verify builds: ${sdkMissing} (repair in progress)`);
    const st = staticCheck(source);
    if (!st.ok) {
      const failed = st.checks.filter((c) => !c.ok && !c.warn).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
      refused.set(actual, failed.join('; ')); emit('ruleset-refused', { buildHash: actual, stage: 'static', failed });
      throw new Error(`ruleset ${actual.slice(0, 12)} refused (static, nothing executed): ${failed.join('; ')}`);
    }
    const conf = await conformance(source, { ticks: 120, sandbox, timeoutMs: sandboxTimeoutMs * 3 });
    if (!conf.ok) {
      const failed = conf.checks.filter((c) => !c.ok && !c.warn).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
      refused.set(actual, failed.join('; ')); emit('ruleset-refused', { buildHash: actual, stage: conf.stage, failed });
      throw new Error(`ruleset ${actual.slice(0, 12)} refused (${conf.stage}): ${failed.join('; ')}`);
    }
    const manifest = conf.manifest;
    const onChain = origin === 'local' || titleTrust === 'open' ? null : await buildRegistered(manifest.rulesetId, actual);
    const trusted = origin === 'local' || titleTrust === 'open' || onChain?.ok === true || (await buildAttested(manifest.rulesetId, actual, attestation));
    if (!trusted) {
      const failed = [onChain ? `title registry: ${onChain.reason}` : null, 'not signed by a trusted publisher'].filter(Boolean);
      emit('ruleset-refused', { buildHash: actual, stage: 'trust', failed });
      throw new Error(`ruleset ${manifest.rulesetId} @ ${actual.slice(0, 12)} refused: ${failed.join('; ')} (TITLE_TRUST=trusted)`);
    }
    const entry = { rulesetId: manifest.rulesetId, buildHash: actual, source, manifest: { ...manifest, buildHash: actual }, kind: manifest.kind, publisher: attestation?.publisher ?? null, sig: attestation?.sig ?? null, origin };
    const file = join(dataDir, 'rulesets', `${actual}.mjs`);
    if (!existsSync(file)) { writeFileSync(file, source); writeFileSync(join(dataDir, 'rulesets', `${actual}.json`), JSON.stringify({ rulesetId: entry.rulesetId, buildHash: actual, publisher: entry.publisher, sig: entry.sig, origin })); }
    builds.set(actual, entry);
    if (current) loaded.set(manifest.rulesetId, entry);
    log(`ruleset ${manifest.rulesetId} @ ${actual.slice(0, 12)} ${current ? 'loaded' : 'held (not current)'} · ${origin}${entry.publisher ? ` · publisher ${entry.publisher.slice(0, 12)}` : ''} · sandbox ${conf.checks.length} checks`);
    emit('ruleset', { rulesetId: manifest.rulesetId, buildHash: actual, current, bytes: source.length, origin });
    return entry;
  };
  // Re-hold every build cached on disk from earlier runs (re-checked, never
  // trusted for having been here), then make the configured rulesets current.
  for (const f of readdirSync(join(dataDir, 'rulesets')).filter((f) => f.endsWith('.mjs'))) {
    try {
      const side = join(dataDir, 'rulesets', `${f.slice(0, -4)}.json`);
      const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
      await installRuleset(readFileSync(join(dataDir, 'rulesets', f), 'utf8'), f.slice(0, -4), { current: false, origin: meta.origin ?? 'cache', attestation: meta.publisher ? { publisher: meta.publisher, sig: meta.sig } : null });
    } catch (e) { log(`cached build ${f}: ${e.message}`); }
  }
  for (const p of rulesets) {
    // A sidecar rulesets/<id>.json (tools/bundle-title.mjs, tools/sign-build.mjs) carries the publisher attestation to advertise.
    const side = p.replace(/\.js$/, '.json');
    const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
    await installRuleset(readFileSync(p, 'utf8'), null, { origin: 'local', attestation: meta.publisher ? { publisher: meta.publisher, sig: meta.sig } : null });
  }

  // ---------------------------------------------------------------- server bundles (node/server-bundle.js)
  // A gauntlet title's match server as a hashed artifact, held like a build: every bundle this node ever
  // fetched, by hash, never evicted; the CURRENT one per opted-in title is the gauntlet config this node runs.
  // Nothing here executes a bundle: one runs only when a placement names this node (node/gauntlet.js).
  const servers = new Map();        // serverHash → { rulesetId, hash, manifest, dir, file, bytes, publisher, sig, origin }
  const serverCurrent = new Map();  // rulesetId → entry
  const serversRefused = new Map(); // serverHash → { reason, until }: when to ask again (Infinity: the bytes themselves are wrong)
  const SERVER_RETRY_MS = 60_000;
  const serversDir = join(dataDir, 'servers');
  mkdirSync(serversDir, { recursive: true });
  const makeCurrent = (entry) => {
    gauntlets[entry.rulesetId] = configFromBundle(entry, { stateDir: join(dataDir, 'gauntlet-state', entry.rulesetId) });
    serverCurrent.set(entry.rulesetId, entry);
  };
  /** Hold a server bundle ONLY if its bytes hash to the pinned value, its manifest is sound and names the title it
   *  is held under, this runtime satisfies it, and — unless it is this operator's own file — the title's publisher
   *  vouches for the hash: TitleRegistry says it is registered and active, or a TRUSTED_PUBLISHERS key signed it.
   *  TITLE_TRUST=open does not apply: a server is a trusted process, and the sandbox 'open' leans on is not there.
   *  Refused before anything is written. */
  const installServer = async (gzBytes, expectedHash, { rulesetId = null, current = true, origin = 'peer', attestation = null } = {}) => {
    const { tar, hash, files, manifest } = openBundle(gzBytes, expectedHash);
    if (rulesetId && manifest.rulesetId !== rulesetId) throw permanent(new Error(`server bundle ${hash.slice(0, 12)} is ${manifest.rulesetId}'s, not ${rulesetId}'s`));
    if (servers.has(hash)) { const e = servers.get(hash); if (current) makeCurrent(e); return e; }
    if (!runtimeOk(manifest)) throw permanent(new Error(`server bundle ${manifest.rulesetId} @ ${hash.slice(0, 12)} needs Node ${manifest.runtime.node}; this node runs ${process.versions.node}`));
    const onChain = origin === 'local' ? null : await buildRegistered(manifest.rulesetId, hash);
    const trusted = origin === 'local' || onChain?.ok === true || (await buildAttested(manifest.rulesetId, hash, attestation));
    if (!trusted) {
      const failed = [onChain ? `title registry: ${onChain.reason}` : null, 'not signed by a trusted publisher'].filter(Boolean);
      emit('server-refused', { serverHash: hash, rulesetId: manifest.rulesetId, stage: 'trust', failed });
      throw new Error(`server bundle ${manifest.rulesetId} @ ${hash.slice(0, 12)} refused: ${failed.join('; ')}`);
    }
    const dir = join(serversDir, hash), file = join(serversDir, `${hash}.tgz`);
    if (!existsSync(join(dir, MANIFEST_NAME))) { const tmp = `${dir}.tmp`; rmSync(tmp, { recursive: true, force: true }); writeFiles(tmp, files); rmSync(dir, { recursive: true, force: true }); renameSync(tmp, dir); }
    if (!existsSync(file)) { writeFileSync(file, gzBytes); writeFileSync(join(serversDir, `${hash}.json`), JSON.stringify({ rulesetId: manifest.rulesetId, serverHash: hash, publisher: attestation?.publisher ?? null, sig: attestation?.sig ?? null, origin })); }
    const entry = { rulesetId: manifest.rulesetId, hash, manifest, dir, file, bytes: tar.length, files: Object.keys(files).length, publisher: attestation?.publisher ?? null, sig: attestation?.sig ?? null, origin };
    servers.set(hash, entry);
    if (current) makeCurrent(entry);
    log(`server ${manifest.rulesetId} @ ${hash.slice(0, 12)} ${current ? 'current' : 'held'} · ${origin} · ${entry.files} files, ${tar.length} bytes${entry.publisher ? ` · publisher ${entry.publisher.slice(0, 12)}` : ''}`);
    emit('server', { rulesetId: manifest.rulesetId, serverHash: hash, current, bytes: tar.length, origin });
    return entry;
  };
  // Re-hold every bundle cached from earlier runs (re-checked: the hash from its bytes, the trust gate again unless
  // it was this operator's own file), then make the operator's own files current.
  for (const f of readdirSync(serversDir).filter((f) => f.endsWith('.tgz'))) {
    try {
      const hash = f.slice(0, -4);
      const side = join(serversDir, `${hash}.json`);
      const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
      await installServer(readFileSync(join(serversDir, f)), hash, { current: false, origin: meta.origin === 'local' ? 'local' : 'cache', attestation: meta.publisher ? { publisher: meta.publisher, sig: meta.sig } : null });
    } catch (e) { log(`cached server bundle ${f}: ${e.message}`); }
  }
  for (const [rid, file] of Object.entries(gauntletServers)) {
    if (!file) continue;
    if (!existsSync(file)) throw new Error(`GAUNTLET_SERVERS: ${rid}: ${file} not found`);
    // The sidecar <file minus .tgz>.json (tools/bundle-server.mjs, tools/sign-build.mjs) carries the hash and the publisher attestation to serve.
    const side = file.replace(/\.tgz$/, '.json');
    const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
    await installServer(readFileSync(file), meta.serverHash ?? null, { rulesetId: rid, origin: 'local', attestation: meta.publisher ? { publisher: meta.publisher, sig: meta.sig } : null });
  }
  // A title opted in without a file: run what was held from an earlier run until peers say otherwise.
  for (const [rid, file] of Object.entries(gauntletServers)) if (!file && !serverCurrent.has(rid)) { const held = [...servers.values()].find((e) => e.rulesetId === rid); if (held) makeCurrent(held); }
  /** For every title opted in without a file, the bundle peers advertise (heartbeat `servers`): the hash most
   *  peers name (ties by hash) is the one to hold and run, fetched from a peer that serves it and admitted by
   *  installServer. A hash whose bytes were refused is never asked for again; one refused for trust is retried
   *  after a minute (a build activates, a chain read recovers); a peer that served wrong bytes is just skipped. */
  const hydrateServers = async () => {
    for (const [rid, file] of Object.entries(gauntletServers)) {
      if (file) continue;
      const votes = new Map(); // serverHash → peers advertising it
      for (const b of heartbeats.values()) { const hsh = b.servers?.[rid]; if (b.nodeId !== nodeId && b.addr && /^[0-9a-f]{64}$/.test(hsh ?? '')) votes.set(hsh, [...(votes.get(hsh) ?? []), b]); }
      if (!votes.size) continue;
      const [want, peers] = [...votes.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0];
      if (serverCurrent.get(rid)?.hash === want) continue;
      if (servers.has(want)) { makeCurrent(servers.get(want)); log(`server ${rid} @ ${want.slice(0, 12)} current (held)`); emit('server', { rulesetId: rid, serverHash: want, current: true, origin: servers.get(want).origin, held: true }); continue; }
      const r = serversRefused.get(want);
      if (r && Date.now() < r.until) continue;
      for (const p of peers.slice(0, 3)) {
        try {
          const res = await fetch(`${p.addr}/server/${encodeURIComponent(rid)}?build=${want}`, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) continue;
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length > MAX_BUNDLE_BYTES) continue;
          const att = res.headers.get('x-build-publisher') ? { publisher: res.headers.get('x-build-publisher'), sig: res.headers.get('x-build-sig') } : null;
          await installServer(bytes, want, { rulesetId: rid, origin: 'peer', attestation: att });
          serversRefused.delete(want);
          break;
        } catch (e) {
          log(`server ${rid} @ ${want.slice(0, 12)} from ${p.addr}: ${e.message}`);
          if (/hash mismatch|not a gzip/.test(e.message)) continue; // that peer's bytes, not the bundle's: try another
          serversRefused.set(want, { reason: e.message, until: e.permanent ? Infinity : Date.now() + SERVER_RETRY_MS });
          break;
        }
      }
    }
  };
  const serverStatus = () => ({
    optIns: gauntletServers,
    current: Object.fromEntries([...serverCurrent].map(([rid, e]) => [rid, { serverHash: e.hash, origin: e.origin, publisher: e.publisher, bytes: e.bytes, files: e.files, entry: e.manifest.entry, builtAt: e.manifest.builtAt ?? null, source: e.manifest.source ?? null }])),
    held: [...servers.values()].map((e) => ({ rulesetId: e.rulesetId, serverHash: e.hash, origin: e.origin })),
    refused: Object.fromEntries([...serversRefused].map(([hsh, r]) => [hsh, r.reason])),
  });

  const registry = erc6699 && !offline ? {
    configured: true,
    readAgent: (tokenId, block) => chain.agentAt(tokenId, block),
    profile: async (playerKey) => { await refreshProfiles([playerKey]).catch(() => {}); return profileCache.get(playerKey) ?? null; },
  } : null;
  let mbook = null; // the MatchBook driver, created below once the settlement exists
  const settlement = createSettlement({
    dataDir, nodeId, identity, loaded, builds, sandbox, log, registry, courts, relayKeys,
    // Settlement v4: a court's verifier bundle grants `checkable` only while it is registered and active for the title.
    verifierActive: async (rulesetId, hash) => (verifiers[rulesetId] ?? []).includes(hash) || (await buildRegistered(rulesetId, hash))?.ok === true,
    onSettled: async (delta, ledger) => {
      const e = matchBook.get(delta.matchId);
      if (e) { e.settled = true; if (e.committed && !e.commitTx) await Promise.race([e.committed, new Promise((r) => setTimeout(r, 15_000))]); } // a match settled within seconds of placement: let the commit go first
      else {
        // The book no longer holds this placement (an earlier rival replaced it, its 15 minutes ran out, the node
        // restarted) and the ledger bound to the signed descriptor it carried. The chain decides where the result goes:
        // a commit under THIS id (sent before the book lost it) is settled on chain below; none, and it settles here
        // only. A commit under a rival id for the same players (the book replaced this placement after a client had
        // already fetched it) is never settled and expires on its own: the seats void it after the settle window.
        const st = mbook ? mbook.statusOf(matchIdBytes32(delta.matchId)) : null;
        const rival = [...matchBook.values()].find((x) => x.commitTx && (delta.participants ?? []).some((p) => x.descriptor.participants?.includes(p)));
        log(`settled ${delta.matchId.slice(0, 12)} from the ledger's own descriptor: the match book no longer holds it; ${!mbook ? 'no MatchBook here' : st !== 'none' ? `the chain holds its commit (${st})` : `no commit on chain under this id${rival ? `, ${rival.descriptor.matchId.slice(0, 12)} for the same players is committed instead and expires on its own` : ''}: it settles locally only`}`);
      }
      return mbook?.settle(delta, ledger);
    },
    descriptorFor: (matchId) => { const e = matchBook.get(matchId); return e ? { descriptor: e.descriptor, envelope: e.envelope } : null; },
    /** A descriptor envelope a ledger carries, for a placement this node's book does not hold: the witness path
     *  always, the host path once the book replaced, pruned or lost the placement it served (0.11.31). */
    verifyDescriptor: async (env) => {
      const d = env?.body;
      const refuse = (why) => { log(`descriptor ${String(d?.matchId ?? '?').slice(0, 12)} from ${String(d?.computedBy ?? '?').slice(0, 8)} refused: ${why}`); return null; };
      if (!d?.matchId || !d.host || d.computedBy !== env.signer) return refuse('malformed');
      if (!(await checked(MATCH_TAG, env))) return refuse('bad signature');
      if ((d.protocol ?? 1) !== PROTOCOL_VERSION) return refuse(`protocol ${d.protocol ?? 1}`);
      // Bonded: in the live table, or — for a placer no heartbeat reaches now (it restarted, the placement outlived
      // its 15 minutes here) or whose bond moved since — at the block the placement pinned.
      if (stakes && !stakes[d.computedBy]?.active) { const st = await chain.standingAt(d.computedBy, d.beaconBlock ?? null); if (!st?.active) return refuse(`placer not bonded${st ? ` at ${st.at}` : ''}`); }
      // The beacon must be this node's own for that bucket when this node has one from the same source (the chain, or
      // the offline mesh's local string): a bonded key cannot name a beacon — a seed — of its choosing.
      const bc = Number.isInteger(d.bucket) ? chain.beaconFor(d.bucket) : null;
      if (bc && bc.source === d.beaconSource && bc.beacon !== d.beacon) return refuse(`beacon is not this node's ${bc.source} beacon for bucket ${d.bucket}`);
      return d;
    },
    hostRelayKeys: (hostId) => heartbeats.get(hostId)?.relayKeys ?? [],
    chatStamp: () => chatStamp(), // defined below; only called at settle time
  });
  const canSettle = roles.some((r) => ['host', 'settler', 'relay'].includes(r));
  const CUSTODY_TAG = 'custody'; // a seat's receipt for a ledger it holds before the host settles (POST /custody)
  const isWitness = roles.includes('witness');
  if (matchBookAddr && !offline) {
    mbook = createMatchBook({
      dataDir, nodeId, contract: matchBookAddr, stakeContract: nodeStake, epochAnchor, chainId: chainId ?? 4441, rpc: chain.rpc, fromBlock: matchBookFromBlock, log, emit, settlement,
      hostAddr: (hostKey) => (hostKey === nodeId ? addr : heartbeats.get(hostKey)?.addr ?? null),
      rulesetIds: () => [...loaded.keys()], hasRole: (r) => roles.includes(r), windows: matchBookWindows, drive: matchBookDrive, fetchImpl: globalThis.fetch, baseFee: chain.baseFeeWei, gasRefund,
      // a seat counts toward the host's custody wait only when its own heartbeat says it takes custody (0.12.2 and later)
      custody: matchBookCustody ? { capable: (k) => (heartbeats.get(k)?.custody ?? 0) >= 1, seal: (body) => seal(CUSTODY_TAG, body, identity) } : null,
    });
  }
  /** /health.settlement (v4): what this node does with proof levels, logs and verifiers — read by a court
   *  (sdk/court attaches a log only to protocol >= 4) and by `npm run host -- doctor`. Log totals are cached a minute. */
  let logTotals = { at: 0, value: null };
  const settlementStatus = () => {
    if (Date.now() - logTotals.at > 60_000) { try { logTotals = { at: Date.now(), value: settlement.logStats() }; } catch { /* unreadable */ } }
    return { v: 4, proofLevels: ['verified', 'checkable', 'attested', 'host'], logs: { maxBytes: MAX_LOG_BYTES, ...(logTotals.value ?? {}) }, custody: CUSTODY_K,
      verifiers: { registry: !!titleRegistry && !offline, operator: Object.fromEntries(Object.entries(verifiers).map(([k, v]) => [k, v.length])) } };
  };
  const witnessed = new Set(); // matchIds this node already answered (bounded below)
  const markWitnessed = (id) => { witnessed.add(id); if (witnessed.size > 20_000) { let n = 0; for (const k of witnessed) { witnessed.delete(k); if (++n >= 5_000) break; } } };
  /** Settlement v4 custody for results that never reach MatchBook (casual, attested, unplaced): the CUSTODY_K
   *  nodes whose h('custody', matchId, nodeId) sorts lowest among fresh peers holding the title, other than the
   *  host and its operator's other keys, fetch the delta, the ledger and the log, check them and co-sign.
   *  Every node computes the same set from its own snapshot, so an advert costs the mesh k checks, not N. */
  const CUSTODY_K = 3;
  const custodians = (matchId, rulesetId, hostId) => {
    const hostOp = stakes?.[hostId]?.operator ?? heartbeats.get(hostId)?.operator ?? null;
    const cands = [...heartbeats.values()].filter((b) => b.nodeId !== hostId && b.manifests?.[rulesetId] && (b.nodeId === nodeId || isFresh(b, Date.now())) && !isUnbonded(b.nodeId)
      && (stakes ? stakes[b.nodeId]?.operator !== hostOp || !hostOp : b.operator !== hostOp));
    return cands.map((b) => b.nodeId).sort((a, b) => (h('custody', matchId, a) < h('custody', matchId, b) ? -1 : 1)).slice(0, CUSTODY_K);
  };
  /** What a push advertises for witnessing: without MatchBook every result (the v0.2 path); with it, only results
   *  the chain never sees. The newest ADVERT_MAX settled in the last day, until they hold CUSTODY_K co-signatures. */
  const ADVERT_MAX = 64, ADVERT_AGE_MS = 24 * 60 * 60_000;
  const adverts = () => settlement.list()
    .filter((d) => (!mbook || !(d.mode === 'ranked' && d.placed)) && Date.now() - Date.parse(d.settledAt ?? 0) < ADVERT_AGE_MS && (d.cosigners?.length ?? 0) < CUSTODY_K)
    .sort((a, b) => (a.settledAt < b.settledAt ? 1 : -1)).slice(0, ADVERT_MAX)
    .map((d) => ({ matchId: d.matchId, rulesetId: d.rulesetId, buildHash: d.buildHash, hostId: d.hostId, addr, cosigners: d.cosigners }));

  const buildHashes = () => Object.fromEntries([...loaded].map(([id, r]) => [id, r.buildHash]));
  const manifests = () => Object.fromEntries([...loaded].map(([id, r]) => [id, { ...r.manifest, buildHash: r.buildHash, publisher: r.publisher, buildSig: r.sig }]));

  // ---------------------------------------------------------------- registry state
  const heartbeats = new Map(); // nodeId → latest verified body
  // Remote addresses that have POSTed /gossip to us, with the last time. If
  // this stays empty while peers are fresh, nobody can reach us inbound —
  // fine for a witness, not for a seed or a LAN host.
  const inbound = new Map();
  const queue = new Map();      // `${bucket}|${playerId}` → verified body
  const peersKnown = new Set(seeds);
  const unreachable = new Map(); // peer URL → when it first stopped answering our pushes
  // Link telemetry, measured on the gossip push every tick already makes — never an extra probe: per peer URL,
  // the last round trip, a moving average and the last LINK_WINDOW outcomes. /fleet folds it per node and the
  // heartbeat carries a digest of it (`links`) so any node can draw the whole graph, not only its own edges.
  const links = new Map(); // peer URL → { rttMs, emaMs, window: [1|0…], okAt, failAt, sent, ok }
  const LINK_WINDOW = 20;
  const linkNote = (peer, ok, ms = 0) => {
    const l = links.get(peer) ?? { rttMs: null, emaMs: null, window: [], okAt: 0, failAt: 0, sent: 0, ok: 0 };
    l.sent++; l.window.push(ok ? 1 : 0); if (l.window.length > LINK_WINDOW) l.window.shift();
    if (ok) { l.ok++; l.okAt = Date.now(); l.rttMs = Math.round(ms); l.emaMs = l.emaMs == null ? l.rttMs : Math.round(l.emaMs * 0.7 + l.rttMs * 0.3); } else l.failAt = Date.now();
    links.set(peer, l);
  };
  // `inboundMs`: what the peer's own heartbeat says about reaching US. A link is 'both', 'outbound' (we reach them),
  // 'inbound' (they reach us — a LAN peer on another subnet pushing to our tunnel: m16 and the Ally from the desktop,
  // 22 Sep 2026) or 'none' (heard only through a third node). A one-way link is still a live link.
  const linkOf = (peerUrl, inboundMs = null) => {
    const l = peerUrl ? links.get(peerUrl) : null;
    const out = l && Date.now() - l.okAt < 10_000;
    if (!l && inboundMs == null) return null;
    const loss = l?.window.length ? +(1 - l.window.reduce((a, b) => a + b, 0) / l.window.length).toFixed(2) : null;
    return { rttMs: l?.rttMs ?? null, emaMs: l?.emaMs ?? null, loss, samples: l?.window.length ?? 0, sent: l?.sent ?? 0, ok: l?.ok ?? 0, okAt: l?.okAt ? new Date(l.okAt).toISOString() : null, failAt: l?.failAt ? new Date(l.failAt).toISOString() : null,
      direct: !!out, inboundMs, direction: out && inboundMs != null ? 'both' : out ? 'outbound' : inboundMs != null ? 'inbound' : 'none' };
  };
  // One number and a grade a dashboard can colour: heartbeat freshness, loss on our pushes, round trip. A peer we
  // cannot push to grades on the direction that works (its reported rtt to us); one heard only through a third node
  // grades on freshness alone, capped at B.
  const quality = (ageS, link) => {
    if (ageS == null) return { score: 0, grade: 'F' };
    let score = ageS <= 2 ? 100 : ageS <= 10 ? 80 : ageS <= 60 ? 50 : 20;
    const ms = link?.direction === 'outbound' || link?.direction === 'both' ? link.emaMs : link?.direction === 'inbound' ? link.inboundMs : null;
    if (link?.direction === 'inbound') score -= 5; // one way: they reach us, we do not reach them — fine for gossip, noted
    else if (link?.samples) score -= Math.round((link.loss ?? 0) * 60);
    else score = Math.min(score, 75);
    if (ms != null) score -= ms > 2000 ? 30 : ms > 800 ? 15 : ms > 300 ? 5 : 0;
    score = Math.max(0, Math.min(100, score));
    return { score, grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F' };
  };
  // Gossip volume over the last minute, for the dashboard's traffic view (real bytes, not a fixture).
  const traffic = []; // { t, dir: 'out'|'in', bytes }
  const trafficNote = (dir, bytes) => { const now = Date.now(); traffic.push({ t: now, dir, bytes }); while (traffic.length && traffic[0].t < now - 60_000) traffic.shift(); };
  const trafficNow = () => { const cut = Date.now() - 60_000; const o = { outPerMin: 0, outBytesPerMin: 0, inPerMin: 0, inBytesPerMin: 0 }; for (const x of traffic) { if (x.t < cut) continue; if (x.dir === 'out') { o.outPerMin++; o.outBytesPerMin += x.bytes; } else { o.inPerMin++; o.inBytesPerMin += x.bytes; } } return o; };
  let stakes = null;            // nodeId → standing, when nodeStake configured
  let wsAddr = wsAddrIn;        // the relay this node fronts; a relay tunnel sets it live
  // The port the relay tunnel fronts: the gauntlet gateway when this node runs one on its own port
  // (it forwards everything else to the title relay on relayPort), else the title relay itself.
  const runsGateway = Object.keys(gauntlets).length > 0 || Object.keys(gauntletServers).length > 0 || serviceBundles.length > 0;
  const relayFront = runsGateway && gauntletPort != null ? gauntletPort : relayPort;
  let lanAddr = null;           // what we listen on, kept for /health when a tunnel replaces addr
  const tunnels = { node: null, relay: null, ro3: null };
  let ro3 = null; // { url, name } while the RO3 tunnel answers (node/ro3.js)
  let upnpCtl = null;
  // ---------------------------------------------------------------- directory
  let chainSeeds = [];          // liveSeeds() from NodeDirectory, refreshed every 10 min, or at once when lonely
  let lastDirectoryRead = 0;
  let announcer = null;
  let airVerifier = null, proxies = null; // universal login (set below when configured)
  const readDirectory = async () => {
    if (!nodeDirectory || offline) return;
    lastDirectoryRead = Date.now();
    const entries = await chain.directory();
    if (!entries) return;
    const st = await chain.standings(Object.keys(entries)) ?? {};
    chainSeeds = liveSeeds(entries, st);
    for (const s of chainSeeds) if (s.nodeId !== nodeId && s.url) void admitSeed(s);
  };
  // A directory entry is a CLAIM that key K is at URL U. Before U becomes a
  // peer we send a nonce to U/whoami and check K signed it (audit finding
  // 8); a URL that cannot is logged and never gossiped to.
  const seedChecks = new Map(); // url → { nodeId, ok, at }
  const admitSeed = async (s) => {
    const prev = seedChecks.get(s.url);
    if (prev && prev.nodeId === s.nodeId && Date.now() - prev.at < 60 * 60_000) { if (prev.ok) peersKnown.add(s.url); return prev.ok; }
    let ok = false, reason = null;
    try {
      const nonce = newNonce();
      const r = await fetch(`${s.url}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(8000) });
      const c = await checkChallenge(await r.json(), { expectNodeId: s.nodeId, nonce });
      ok = c.ok; reason = c.reason ?? null;
    } catch (e) { reason = e.message; }
    seedChecks.set(s.url, { nodeId: s.nodeId, ok, at: Date.now() });
    if (ok) peersKnown.add(s.url); else { peersKnown.delete(s.url); log(`seed ${s.url} did not prove key ${s.nodeId.slice(0, 12)} (${reason}); ignored`); emit('seed-refused', { url: s.url, nodeId: s.nodeId, reason }); }
    return ok;
  };
  let announceRetry = null, announceDebounce = null;
  // Coalesce: the node tunnel and the relay tunnel come up a second apart,
  // and an announce sent between them published the node URL with NO relay
  // (seen 20 Sep 2026: "server offline" for the length of the rate-limit
  // window). Wait a few seconds so one transaction carries both.
  const announceNow = () => { clearTimeout(announceDebounce); announceDebounce = setTimeout(announceSend, 4000); };
  // ---------------------------------------------------------------- relay watch
  // The relay tunnel's URL used to be advertised (heartbeat) and announced (NodeDirectory) the moment
  // cloudflared printed it — with nothing checking that a WebSocket actually opens through it, or that the
  // relay process behind relayPort is alive. A directory entry that points at a dead relay is worse than
  // none: every client that trusts it says "server offline". Now: verify before advertising, keep checking,
  // and withdraw (advertise/announce no wsAddr) when it stops answering.
  // Withdrawn is not mended. A quick tunnel whose name Cloudflare dropped never answers on that name again
  // (cloudflared keeps running, reconnecting to an edge that no longer routes it), and the desktop checked one
  // dead name every minute for 18 hours while Agent Fighter said SERVER OFFLINE (17–18 Oct 2026): the node
  // tunnel's outside check restarts cloudflared in that case, the relay's only rotated a name that had never
  // verified. Now RELAY_ROTATE_FAILS misses in a row restart it too — a quick tunnel comes back on a fresh name,
  // verified and announced like any new one. A name that only blinked (25 min on 17 Oct) answers before that.
  const RELAY_VERIFY_MS = relayProbe ? 200 : 5000, RELAY_GIVE_UP_MS = relayProbe ? 3000 : 5 * 60_000, RELAY_WATCH_MS = relayProbe ? 500 : 60_000, RELAY_FAILS = 3, RELAY_ROTATE_FAILS = 6;
  const relay = { url: null, state: 'off', checkedAt: null, ms: null, lastError: null, fails: 0, rotations: 0 }; // state: off | verifying | up | down | unreachable; rotations: cloudflared restarts this check asked for
  const openWs = relayProbe ?? (async (u) => { const t0 = Date.now(); await new Promise((res, rej) => { const ws = new WebSocket(u); const t = setTimeout(() => { try { ws.close(); } catch { /* */ } rej(new Error('timeout')); }, 8000); ws.onopen = () => { clearTimeout(t); ws.close(); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('websocket error')); }; }); return Date.now() - t0; });
  let relayTimer = null;
  const relayCheck = async () => {
    const u = relay.url;
    if (!u) return;
    try {
      const t0 = Date.now(); const ms = await openWs(u); relay.ms = typeof ms === 'number' ? ms : Date.now() - t0; relay.lastError = null; relay.fails = 0; relay.checkedAt = Date.now();
      if (relay.state !== 'up') { relay.state = 'up'; wsAddr = u; log(`relay: ${u} answers a WebSocket (${relay.ms} ms) — advertising and announcing`); emit('tunnel', { which: 'relay', url: u, state: 'up' }); announceNow(); }
    } catch (e) {
      relay.lastError = e.message; relay.checkedAt = Date.now(); relay.fails++;
      if (relay.state === 'up' && relay.fails >= RELAY_FAILS) { relay.state = 'down'; wsAddr = null; log(`relay: ${u} stopped answering (${e.message}) — withdrawing wsAddr from the heartbeat and the directory`); emit('tunnel', { which: 'relay', url: u, state: 'down' }); announceNow(); }
      // Still dead after the withdrawal: restart cloudflared for a fresh hostname. The exit brings relayUrl(null)
      // (this check stops), the supervisor's restart brings relayUrl(new) (verifying → up → announced). The miss
      // count starts over so a kill that did not take is tried again, not waited on.
      else if (relay.state === 'down' && relay.fails >= RELAY_ROTATE_FAILS && tunnels.relay) { const misses = relay.fails; relay.fails = 0; relay.rotations++; log(`relay: ${u} still not answering (${e.message}; ${misses} checks in a row) — restarting cloudflared for a fresh hostname`); emit('tunnel', { which: 'relay', url: u, state: 'rotating' }); tunnels.relay.rotate(); }
      else if (relay.state === 'verifying' && Date.now() - relay.since > RELAY_GIVE_UP_MS) { relay.state = 'unreachable'; log(`relay: ${u} never answered a WebSocket (${e.message}) — rotating the hostname`); emit('tunnel', { which: 'relay', url: u, state: 'unreachable' }); tunnels.relay?.rotate(); }
    }
  };
  const relayUrl = (u) => {
    clearInterval(relayTimer); relayTimer = null;
    if (relay.state === 'up' && wsAddr) { wsAddr = null; announceNow(); } // the old hostname is gone either way
    Object.assign(relay, { url: u ? u.replace(/^https:/, 'wss:') : null, state: u ? 'verifying' : 'off', checkedAt: null, ms: null, lastError: null, fails: 0, since: Date.now() });
    emit('tunnel', { which: 'relay', url: relay.url, state: relay.state });
    if (!u) return;
    relayTimer = setInterval(() => { void relayCheck().then(() => { if (relay.state === 'up' && relayTimer) { clearInterval(relayTimer); relayTimer = setInterval(() => void relayCheck(), RELAY_WATCH_MS); } }); }, RELAY_VERIFY_MS);
    void relayCheck();
  };
  const relayStatus = () => ({ url: relay.url, port: relayFront, state: relay.state, checkedAt: relay.checkedAt ? new Date(relay.checkedAt).toISOString() : null, ms: relay.ms, lastError: relay.lastError, rotations: relay.rotations });
  const announceSend = () => {
    if (!announcer || !announce) return;
    // Only a node with a public https address is worth announcing (a seed
    // behind a tunnel or a real domain). A LAN-only node used to try anyway
    // and log "not delegated" every cycle — noise, not a fault.
    if (!/^https:\/\//.test(addr ?? '')) return;
    announcer.sync(addr, wsAddr ?? '').then((r) => {
      if (r === 'sent' || r === 'error' || r === 'not-delegated' || r === 'unfunded') log(`announce: ${r}${announcer.status().lastError ? ` — ${announcer.status().lastError}` : ''}`);
      // A change that arrived while a send was in flight, or inside the
      // rate-limit window (two tunnels coming up in the same second), is
      // tried again shortly rather than on the next 10-minute cycle.
      if (r === 'skip' || r === 'rate-limited' || r === 'error') { clearTimeout(announceRetry); announceRetry = setTimeout(announceNow, 2.5 * 60_000); }
    }).catch(() => {});
  };
  let lastBonded = null;        // the bonded set as last reported; stakes events fire on change only
  // This node's own v3 standing (lock, eligibility age, delegate) and whether
  // NodeStake's admin is a contract. Read once a minute; null on a v2 contract.
  let myBond = null, stakeAdmin = null, lastBondRead = 0;
  const STAKE_TTL = 15_000; let lastStakeRead = 0;
  const readMyBond = async ({ force = false } = {}) => {
    if (!nodeStake || offline || (!force && Date.now() - lastBondRead < 60_000)) return;
    lastBondRead = Date.now();
    const prev = myBond;
    myBond = await chain.nodeInfo(nodeId);
    stakeAdmin = await chain.stakeAdminIsContract();
    if (myBond && (!prev || prev.eligible !== myBond.eligible || prev.delegate !== myBond.delegate)) emit('bond', { active: myBond.active, eligible: myBond.eligible, delegate: myBond.delegate, bondedSince: myBond.bondedSince });
  };
  let addr = publicAddr;

  const myHeartbeat = () => seal(HEARTBEAT_TAG, {
    nodeId, operator, roles, region, addr, wsAddr, standing: 0, version, protocol: PROTOCOL_VERSION, relayKeys,
    // Titles whose match server THIS node runs (node/gauntlet.js). Placement puts these nodes first
    // for those titles: a gauntlet title drawn onto a node without its court is a match nobody can join.
    // An RO3Emu server reachable through this node's RO3 tunnel (node/ro3.js); players' nodes list it at /ro3/hosts.
    ...(ro3 ? { ro3 } : {}),
    ...(Object.keys(gauntlets).length ? { gauntlets: Object.keys(gauntlets).sort() } : {}),
    // Server bundles this node holds and runs (node/server-bundle.js), by title: a peer that opted in fetches the hash from GET /server/<id>?build=.
    ...(serverCurrent.size ? { servers: Object.fromEntries([...serverCurrent].map(([rid, e]) => [rid, e.hash]).sort()) } : {}),
    // Publisher services this node runs (reachable at <wsAddr>/svc/<name>): how a game client finds its backend.
    ...(serviceBundles.length ? { services: serviceBundles.flatMap((b) => Object.keys(b.services).map((n) => `${b.prefix}.${n}`)).sort() } : {}),
    // A witness that takes custody before settle (0.12.2): a host waits for such seats only. Not in the snapshot root.
    ...(mbook && isWitness && matchBookCustody ? { custody: 1 } : {}),
    buildHashes: buildHashes(), manifests: manifests(), epoch: epochOf(Date.now()),
    // who we reached in the last ten seconds and how fast (16 hex of the key, ms) — the mesh's edges, for /fleet.graph on any node; not part of the snapshot root
    links: [...heartbeats.values()].filter((b) => b.nodeId !== nodeId && b.addr && Date.now() - (links.get(b.addr)?.okAt ?? 0) < 10_000).map((b) => ({ id: b.nodeId.slice(0, 16), ms: links.get(b.addr).emaMs })),
  }, identity);

  // ---------------------------------------------------------------- gossip limits
  // A key costs nothing to make, so "anyone can run a node" also means anyone can send a thousand heartbeats or
  // queue entries. Everything a peer hands us is verified BEFORE it is cached for forwarding (it used to be cached
  // first, so a forged envelope travelled the whole mesh), and every table a stranger can add to has a ceiling.
  const MAX_PEER_KEYS = 512;       // heartbeats held and forwarded
  const MAX_UNBONDED_KEYS = 64;    // with NodeStake: keys the chain says are not bonded (a pre-bond operator, a test node)
  const EVICTED_MS = 10 * 60_000;  // an evicted unbonded key is not taken back for this long
  const MAX_QUEUE = 4096;          // queue entries held and forwarded
  const QUEUE_AHEAD = 4;           // buckets ahead of ours an entry may name: POST /queue's window (2) plus a peer's clock up to 4 s ahead
  const MAX_PER_MESSAGE = 1024;    // envelopes of each kind looked at in one gossip message
  const NEW_KEY_READS = 4;         // standings read per tick for keys not seen before: a flood of keys is not a flood of eth_calls
  const UNBONDED_PUSH_EVERY = 10;  // ticks between our pushes to an unbonded peer (it still gets everything in our replies)
  const verifiedSigs = new Map();  // `tag|sig` → digest of what was signed: an envelope is verified once, not on every push
  const evicted = new Map();       // nodeId → when it was dropped as unbonded over the cap
  const guard = { heartbeat: { badSig: 0, badAddr: 0, full: 0, evicted: 0 }, queue: { badSig: 0, window: 0, unknownTitle: 0, full: 0 }, chat: { badSig: 0, malformed: 0, window: 0, rate: 0, full: 0, unbonded: 0, unknown: 0 } };
  const guardJson = () => JSON.stringify({ heartbeat: guard.heartbeat, queue: guard.queue, chat: guard.chat });
  guard.reported = guardJson(); // nothing refused yet: nothing to report
  /** opened(), remembered: the same sig over the same body (signer, tag) is not verified twice. */
  const checked = async (tag, env) => {
    if (!env?.body || !env.signer || typeof env.sig !== 'string') return false;
    const k = `${tag}|${env.sig}`;
    const d = createHash('sha256').update(`${tag}\0${env.signer}\0${canonical(env.body)}`).digest('hex');
    const hit = verifiedSigs.get(k);
    if (hit === d) return true;
    if (hit === '!' + d) return false;
    const ok = await opened(tag, env);
    verifiedSigs.set(k, ok ? d : '!' + d);
    if (verifiedSigs.size > 8192) verifiedSigs.delete(verifiedSigs.keys().next().value);
    return ok;
  };
  const isUnbonded = (k) => !!(nodeStake && stakes && stakes[k] && !stakes[k].active);
  const forgetKey = (k) => {
    const addrOf = heartbeats.get(k)?.addr ?? envelopeCache.get(k)?.body?.addr;
    heartbeats.delete(k); envelopeCache.delete(k);
    if (addrOf && !seeds.includes(addrOf) && ![...heartbeats.values()].some((b) => b.addr === addrOf)) peersKnown.delete(addrOf);
  };
  const evict = (k) => {
    forgetKey(k); guard.heartbeat.evicted++;
    evicted.set(k, Date.now());
    if (evicted.size > 4096) evicted.delete(evicted.keys().next().value);
  };
  const evictedRecently = (k) => { const at = evicted.get(k); return !!at && Date.now() - at < EVICTED_MS; };
  /** Room in the peer table for a key we do not hold yet (asked only after its envelope verified, so a forgery
   *  cannot evict anyone): a full table makes room by dropping the stalest unbonded key, and refuses when there is none. */
  const roomFor = (k) => {
    if (envelopeCache.has(k) || heartbeats.has(k)) return true;
    if (envelopeCache.size < MAX_PEER_KEYS) return true;
    const stalest = [...envelopeCache.values()].filter((e) => isUnbonded(e.body.nodeId)).sort((a, b) => (a.body.epoch ?? 0) - (b.body.epoch ?? 0))[0];
    if (!stalest) { guard.heartbeat.full++; return false; }
    evict(stalest.body.nodeId);
    return true;
  };
  /** After a stake read: keep at most MAX_UNBONDED_KEYS unbonded keys, the freshest. */
  const trimUnbonded = () => {
    const unbonded = [...envelopeCache.values()].filter((e) => isUnbonded(e.body.nodeId)).sort((a, b) => (b.body.epoch ?? 0) - (a.body.epoch ?? 0));
    for (const e of unbonded.slice(MAX_UNBONDED_KEYS)) evict(e.body.nodeId);
  };
  // ---------------------------------------------------------------- node chat (docs/NODE-CHAT.md)
  // One global line between operators, riding the gossip above: id → { env, at, seenBy }. Held for CHAT_RING
  // messages or CHAT_PAST_MS, in memory only; a restarted node gets the ring back in its first gossip reply.
  const chat = new Map();
  /** With NodeStake: 'bonded' speaks and is forwarded, 'unbonded' is held at a small cap and never forwarded,
   *  'unknown' (a key the stake table has not listed) is dropped — it is re-pushed for two minutes and in every
   *  reply, so a bonded node whose standing is read a tick later is heard then. A dev mesh has no stake table: everyone speaks. */
  const chatTier = (signer) => (signer === nodeId ? 'bonded' : !nodeStake || !stakes ? 'bonded' : !(signer in stakes) ? 'unknown' : stakes[signer].active ? 'bonded' : 'unbonded');
  const chatForwardable = (c) => chatTier(c.env.signer) === 'bonded';
  const chatPrune = (now = Date.now()) => {
    for (const [id, c] of chat) if (c.at < now - CHAT_PAST_MS) chat.delete(id);
    while (chat.size > CHAT_RING) { let oldest = null; for (const [id, c] of chat) if (!oldest || c.at < oldest.at) oldest = { id, at: c.at }; chat.delete(oldest.id); }
  };
  const chatNewest = () => { let m = 0; for (const c of chat.values()) if (chatForwardable(c) && c.at > m) m = c.at; return m; };
  /** What a tick pushes: the forwardable messages of the last CHAT_PUSH_WINDOW_MS; `all` = the whole forwardable ring (catch-up). */
  const chatEnvelopes = (all = false, now = Date.now()) => [...chat.values()].filter((c) => chatForwardable(c) && (all || c.at > now - CHAT_PUSH_WINDOW_MS)).map((c) => c.env);
  const mergeChat = async (list, from = null) => {
    const now = Date.now();
    for (const env of (Array.isArray(list) ? list : []).slice(0, CHAT_PER_MESSAGE)) {
      const why = chatProblem(env, { now });
      if (why) { guard.chat[why]++; continue; }
      const id = chatId(env);
      const cur = chat.get(id);
      if (cur) { if (from && cur.seenBy.size < CHAT_SEEN_MAX) cur.seenBy.add(from); continue; }
      const tier = chatTier(env.signer);
      if (tier === 'unknown') { guard.chat.unknown++; continue; }
      if (tier === 'unbonded' && [...chat.values()].filter((c) => !chatForwardable(c)).length >= CHAT_UNBONDED_RING) { guard.chat.unbonded++; continue; }
      if (!(await checked(CHAT_TAG, env))) { guard.chat.badSig++; continue; } // verified before the rate limit: a forgery cannot spend a real key's budget
      const raced = chat.get(id); // a push and a reply carrying the same message are absorbed concurrently; the verify above yielded
      if (raced) { if (from && raced.seenBy.size < CHAT_SEEN_MAX) raced.seenBy.add(from); continue; }
      if (!chatRateOk([...chat.values()].filter((c) => c.env.signer === env.signer).map((c) => c.at), env.body.at)) { guard.chat.rate++; continue; }
      if (chat.size >= CHAT_RING && [...chat.values()].every((c) => c.at >= env.body.at)) { guard.chat.full++; continue; } // older than everything a full ring holds
      chat.set(id, { env, at: env.body.at, seenBy: new Set(from ? [from] : []) });
      chatPrune(now);
      emit('chat', { id, signer: env.signer, operator: env.signer === nodeId ? operator : heartbeats.get(env.signer)?.operator ?? null, at: env.body.at, text: env.body.text, mine: env.signer === nodeId });
    }
  };
  /** The ring for /fleet, newest last, with what a dashboard shows beside each line. */
  const chatLines = () => [...chat.entries()].sort((a, b) => a[1].at - b[1].at).map(([id, c]) => ({
    id, at: c.at, signer: c.env.signer, operator: c.env.signer === nodeId ? operator : heartbeats.get(c.env.signer)?.operator ?? null,
    wallet: stakes?.[c.env.signer]?.operator ?? null, bonded: stakes ? !!stakes[c.env.signer]?.active : null, text: c.env.body.text, seenBy: c.seenBy.size, mine: c.env.signer === nodeId,
  }));
  /** This node's ring at one moment, for the ledger it settles (node/settle.js `meta.chat`): host-asserted, chain-timestamped via ledgerHash. */
  const chatStamp = () => { const ids = [...chat.keys()]; let newest = null; for (const [id, c] of chat) if (!newest || c.at > newest.at) newest = { id, at: c.at }; return { hour: hourOf(Date.now()), root: chatRoot(ids), newest: newest?.id ?? null, count: ids.length }; };
  /** Titles this node could place: what it holds and what any peer advertises. */
  const knownTitles = () => {
    const t = new Set(loaded.keys());
    for (const b of heartbeats.values()) for (const rid of Object.keys(b.manifests ?? {})) t.add(rid);
    return t;
  };
  const guardStatus = () => ({ peerKeys: envelopeCache.size, maxPeerKeys: MAX_PEER_KEYS, unbonded: [...envelopeCache.keys()].filter(isUnbonded).length, maxUnbonded: MAX_UNBONDED_KEYS, evicted: evicted.size, queue: queueEnvelopes.size, maxQueue: MAX_QUEUE, chat: chat.size, maxChat: CHAT_RING, verifyCache: verifiedSigs.size, refused: { heartbeat: { ...guard.heartbeat }, queue: { ...guard.queue }, chat: { ...guard.chat } } });
  // Refusals are counted, and reported once a minute at most: a flood must not become a flood of log lines.
  let guardReportAt = 0;
  const guardReport = () => {
    if (Date.now() - guardReportAt < 60_000) return;
    const now = guardJson();
    if (now === guard.reported) return;
    guardReportAt = Date.now(); guard.reported = now;
    log(`gossip limits: refused ${now}`); emit('gossip.guard', guardStatus());
  };

  // Peers on another protocol version are heard and listed, never placed,
  // never witnesses: old and new rules must not meet inside one match.
  const incompatible = new Map(); // nodeId → { version, protocol, at }
  const FORGET_AFTER_EPOCHS = Math.ceil(10 * 60_000 / EPOCH_MS); // a heartbeat this old is neither learned nor kept (forgetStale below)
  const mergeHeartbeats = async (envelopes) => {
    for (const env of envelopes ?? []) {
      if (env?.body?.nodeId !== env?.signer || !(await checked(HEARTBEAT_TAG, env))) continue;
      const b = env.body;
      if (b.nodeId !== nodeId && (b.protocol ?? 1) !== PROTOCOL_VERSION) {
        if (!incompatible.has(b.nodeId)) { log(`peer ${b.nodeId.slice(0, 12)} speaks protocol ${b.protocol ?? 1} (${b.version ?? '?'}), ours is ${PROTOCOL_VERSION}: excluded`); emit('incompatible', { nodeId: b.nodeId, protocol: b.protocol ?? 1, version: b.version ?? null }); }
        incompatible.set(b.nodeId, { version: b.version ?? null, protocol: b.protocol ?? 1, at: Date.now() });
        heartbeats.delete(b.nodeId);
        continue;
      }
      incompatible.delete(b.nodeId);
      if (b.nodeId !== nodeId && (b.epoch ?? 0) < epochOf(Date.now()) - FORGET_AFTER_EPOCHS) continue; // too old to learn: a peer on older code still forwards the dead
      if (b.nodeId !== nodeId && b.addr != null && peerOrigin(b.addr) !== b.addr) { guard.heartbeat.badAddr++; continue; } // an addr that is not a bare origin is refused whole
      const cur = heartbeats.get(b.nodeId);
      if (!cur || b.epoch >= cur.epoch) heartbeats.set(b.nodeId, b);
      if (b.addr && b.nodeId !== nodeId) peersKnown.add(b.addr);
    }
  };
  const mergeQueue = async (envelopes) => {
    for (const env of envelopes ?? []) {
      const b = env?.body;
      if (!b || b.playerId !== env.signer || typeof b.bucket !== 'number' || !b.rulesetId) continue;
      const k = `${b.bucket}|${b.playerId}`;
      if (queue.has(k) || isStale(b.bucket, Date.now()) || !(await checked(QUEUE_TAG, env))) continue;
      queue.set(k, b);
    }
  };

  const currentSnapshot = () => {
    const now = Date.now();
    const s = buildSnapshot([...heartbeats.values()], now);
    if (stakes) { s.peers = applyStakes(s.peers, stakes); s.staking = 'chain'; }
    else s.staking = nodeStake ? 'unreadable' : 'unbonded-dev';
    return s;
  };

  // ---------------------------------------------------------------- secrets (node/secrets.js)
  // Names and paths only, never values. The data folder is rescanned at most every 10 minutes.
  let dataScan = { at: 0, findings: [] };
  const secretsStatus = () => {
    if (Date.now() - dataScan.at > 600_000) dataScan = { at: Date.now(), findings: scanDataDir(dataDir) };
    const services = (publisherServices?.status() ?? []).filter((x) => x.secrets?.length).map((x) => ({ name: x.name, secrets: x.secrets }));
    return { policy: policyOf(secretsPolicy), clean: !dataScan.findings.length && !services.length, dataDir: dataScan.findings.map(({ path, kind }) => ({ path, kind })), services };
  };

  // ---------------------------------------------------------------- hydration by hash
  const hydrateMissing = async (s) => {
    for (const [rid, m] of Object.entries(s.manifests)) {
      if (loaded.get(rid)?.buildHash === m.buildHash) continue;
      // Already held (a cached build re-checked at boot, or a build fetched earlier and superseded): make it
      // current from disk. A witness that restarted was re-fetching a build it had, from peers it could not
      // reach, and advertised nothing meanwhile — so no panel could seat it (22 Sep 2026).
      if (builds.has(m.buildHash) && builds.get(m.buildHash).rulesetId === rid) { const b = builds.get(m.buildHash); loaded.set(rid, b); log(`ruleset ${rid} @ ${m.buildHash.slice(0, 12)} current (held)`); emit('ruleset', { rulesetId: rid, buildHash: m.buildHash, current: true, bytes: b.source.length, origin: b.origin, held: true }); continue; }
      const holders = s.peers.filter((p) => p.buildHashes?.[rid] === m.buildHash && p.addr && p.nodeId !== nodeId);
      for (const p of holders) {
        try {
          const r = await fetch(`${p.addr}/ruleset/${encodeURIComponent(rid)}?build=${m.buildHash}`);
          if (!r.ok) continue;
          const att = r.headers.get('x-build-publisher') ? { publisher: r.headers.get('x-build-publisher'), sig: r.headers.get('x-build-sig') } : (m.publisher ? { publisher: m.publisher, sig: m.buildSig } : null);
          await installRuleset(await r.text(), m.buildHash, { origin: 'peer', attestation: att });
          break;
        } catch (e) { log(`hydrate ${rid} from ${p.addr}: ${e.message}`); }
      }
    }
  };

  // ---------------------------------------------------------------- gossip loop
  let timer = null, updateTimer = null, firstUpdateTimer = null, directoryTimer = null, tickNo = 0;
  // A heartbeat nobody has renewed in this long is forgotten: from the table, from the envelopes we forward and
  // from the incompatible list. Without this every node ever heard of stayed in every peer's gossip until a
  // restart (four dead test nodes from the day before were still travelling the mesh on 21 Sep 2026), and a
  // payload that grows with churn is exactly what "anyone can run a node" produces.
  const forgetStale = () => {
    const floor = epochOf(Date.now()) - FORGET_AFTER_EPOCHS;
    for (const [id, b] of heartbeats) if (id !== nodeId && (b.epoch ?? 0) < floor) { heartbeats.delete(id); emit('peer.forgotten', { nodeId: id, operator: b.operator ?? null }); }
    for (const [id, env] of envelopeCache) if ((env.body?.epoch ?? 0) < floor) envelopeCache.delete(id);
    const cut = Date.now() - FORGET_AFTER_EPOCHS * EPOCH_MS;
    for (const [id, x] of incompatible) if (x.at < cut) incompatible.delete(id);
  };
  const tick = async () => {
    try {
      await mergeHeartbeats([await myHeartbeat()]);
      forgetStale();
      const payload = { heartbeats: [], queue: [] };
      for (const b of heartbeats.values()) if (b.nodeId === nodeId) payload.heartbeats.push(await myHeartbeat());
      // Forward what we know: our own sealed heartbeat plus cached envelopes we received.
      payload.heartbeats.push(...envelopeCache.values());
      payload.queue.push(...queueEnvelopes.values());
      // Node chat: the last two minutes, and how far our ring reaches so a peer that is behind gets the rest in its reply.
      chatPrune();
      payload.chat = chatEnvelopes(); payload.chatNewest = chatNewest();
      // Advertise what we settled so witnesses can come and check it, and the
      // placements we froze so peers converge on them.
      // Bounded either way (settlement v4): the chain indexes ranked placed results; the rest go to a drawn custody set.
      payload.deltas = adverts();
      // MatchBook hints: the transaction hashes of the matches this node touched today — a peer verifies each from its receipt, never from our word
      payload.hints = mbook ? mbook.hints() : [];
      // Settles this host holds until its seats hold the ledger: each seat pulls it outbound and sends a receipt (POST /custody)
      payload.custody = mbook ? mbook.custodyAdverts() : [];
      matchesNow();
      payload.matches = matchEnvelopes();
      const body = JSON.stringify(payload);
      // An address only unbonded keys claim is pushed to every UNBONDED_PUSH_EVERY ticks: it still hears everything
      // in our replies to its own pushes, and a forged heartbeat cannot point every node at a stranger's server
      // once a second.
      tickNo++;
      const bondedAddrs = new Set(), unbondedAddrs = new Set();
      for (const b of heartbeats.values()) if (b.addr) (isUnbonded(b.nodeId) ? unbondedAddrs : bondedAddrs).add(b.addr);
      const targets = [...peersKnown].filter((p) => p !== addr && (seeds.includes(p) || bondedAddrs.has(p) || !unbondedAddrs.has(p) || tickNo % UNBONDED_PUSH_EVERY === 0));
      if (targets.length) emit('gossip.out', { peers: targets.length, bytes: body.length, heartbeats: payload.heartbeats.length, queue: payload.queue.length, deltas: payload.deltas.length, matches: payload.matches.length });
      for (const peer of targets) {
        const t0 = performance.now();
        trafficNote('out', body.length);
        fetch(`${peer}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-litnode-from': nodeId }, body, signal: AbortSignal.timeout(8000) })
          .then(async (r) => { if (r.ok) { linkNote(peer, true, performance.now() - t0); unreachable.delete(peer); const text = await r.text(); trafficNote('in', text.length); const m = JSON.parse(text); await absorb(m, { from: peer, bytes: text.length, via: 'reply' }); } else { linkNote(peer, false); unreachable.set(peer, unreachable.get(peer) ?? Date.now()); } })
          .catch(() => { linkNote(peer, false); unreachable.set(peer, unreachable.get(peer) ?? Date.now()); });
      }
      // A peer URL that has not answered for a while is a hostname that rotated (a seed restarted on a new
      // quick tunnel: seen 21 Sep 2026 — two nodes pushed to a dead URL for 36 minutes while the new one sat
      // on NodeDirectory). Re-read the directory now, not on the ten-minute cycle, and forget the URL once
      // it has been dead for long enough that it is not coming back.
      const deadFor = (peer) => Date.now() - (unreachable.get(peer) ?? Date.now());
      if (nodeDirectory && !offline && Date.now() - lastDirectoryRead > 60_000 && [...unreachable.keys()].some((p) => deadFor(p) > 30_000)) {
        lastDirectoryRead = Date.now(); log('a known peer stopped answering — re-reading NodeDirectory'); readDirectory().catch(() => {});
      }
      for (const [p] of unreachable) if (deadFor(p) > 10 * 60_000) { unreachable.delete(p); peersKnown.delete(p); seedChecks.delete(p); }
      // Lonely with a directory configured: every fresh peer is gone (a seed
      // restarted on a new tunnel hostname, say). Re-read NodeDirectory now
      // rather than on the 10-minute cycle — the desktop's restart left its
      // peers blind for up to ten minutes once. Rate-limited to one read a
      // minute so a genuinely empty mesh does not hammer the RPC.
      if (nodeDirectory && !offline && Date.now() - lastDirectoryRead > 60_000) {
        const fresh = currentSnapshot().peers.filter((p) => p.nodeId !== nodeId).length;
        if (fresh === 0) { lastDirectoryRead = Date.now(); log('no fresh peers — re-reading NodeDirectory'); readDirectory().catch(() => {}); }
      }
      chainRun = chainTick();
    } catch (e) { log(`tick: ${e.message}`); }
  };
  // The chain half of a tick: head, stakes, bonds, titles, builds, profiles, MatchBook. It used to run inside every
  // tick, and a tick did not wait for the one before: when the RPC slowed (rate-limited, retrying), ticks piled up
  // on each other and so did their calls, 42 a second from the desktop on 9 Oct 2026, all refused. Gossip stays
  // on every tick (a heartbeat must not wait on the chain, or peers drop the node after 4 s); the chain half is
  // skipped while the previous one is still running.
  let chainBusy = false, chainSkipped = 0, chainRun = null;
  const chainTick = async () => {
    if (chainBusy) { chainSkipped++; return; }
    chainBusy = true;
    try {
      const head = chain.status().head;
      const b = await chain.pollBlock();
      if (b && b.number !== head) emit('block', { number: b.number, hash: b.hash });
      // Standings are read every STAKE_TTL, not every tick: one eth_call per peer per second (two with
      // witnessEligible) from every node on a machine was ~25 requests/s from one IP and Caldera's
      // gateway answered 429 to everything, the operator's tools included (21 Sep 2026). A key we
      // hold no standing for yet (a new peer) is read at once.
      // A key not read before is read at once, but only NEW_KEY_READS of them a tick: a burst of new keys (a flood,
      // or a mesh restarting) is a few eth_calls a second, not one per key.
      const ids = [...heartbeats.keys()];
      const unknown = nodeStake && !offline ? ids.filter((k) => !stakes || !(k in stakes)) : [];
      const due = Date.now() - lastStakeRead > STAKE_TTL;
      if (nodeStake && !offline && (due || unknown.length)) {
        if (due) lastStakeRead = Date.now();
        const st = await chain.standings(due ? [...ids.filter((k) => stakes && k in stakes), ...unknown.slice(0, NEW_KEY_READS)] : unknown.slice(0, NEW_KEY_READS));
        // Merge, never replace: one transient RPC failure for one key must
        // not drop that peer from the bonded set for a tick (it changed a
        // live placement once). Keys we no longer hear from are pruned.
        if (st) {
          const next = { ...(stakes ?? {}), ...st };
          for (const k of Object.keys(next)) if (!heartbeats.has(k)) delete next[k];
          stakes = next;
          const bondedNow = Object.keys(next).filter((k) => next[k].active).sort().join(',');
          if (bondedNow !== lastBonded) { lastBonded = bondedNow; emit('stakes', { read: Object.keys(st).length, bonded: bondedNow ? bondedNow.split(',').length : 0 }); }
          trimUnbonded();
        }
      }
      guardReport();
      await readMyBond().catch(() => {});
      await refreshTitleOwners();
      await hydrateMissing(currentSnapshot());
      await hydrateServers();
      await refreshProfiles([...queue.values()].map((b) => b.playerId).concat(settlement.list().flatMap((d) => d.participants)));
      settlement.maybeFreeze();
      if (Date.now() - lastPruneAt > 3600_000) { lastPruneAt = Date.now(); settlement.prune(); }
      await mbook?.poll();
    } catch (e) { log(`tick (chain): ${e.message}`); }
    finally { chainBusy = false; }
  };
  const envelopeCache = new Map(); // nodeId → latest envelope (for forwarding)
  const queueEnvelopes = new Map();
  const absorb = async (msg, meta = null) => {
    if (meta) {
      const sig = msg.heartbeats?.find((e) => e?.body?.nodeId !== nodeId)?.sig ?? null;
      emit('gossip.in', { from: meta.from, via: meta.via, bytes: meta.bytes, heartbeats: msg.heartbeats?.length ?? 0, queue: msg.queue?.length ?? 0, deltas: msg.deltas?.length ?? 0, matches: msg.matches?.length ?? 0, chat: msg.chat?.length ?? 0, sig });
    }
    const list = (x) => (Array.isArray(x) ? x.slice(0, MAX_PER_MESSAGE) : []);
    const now = Date.now();
    const fresh = [];
    for (const env of list(msg.heartbeats)) {
      const b = env?.body;
      if (!b?.nodeId || b.nodeId === nodeId || b.nodeId !== env.signer) continue;
      if ((b.epoch ?? 0) < epochOf(now) - FORGET_AFTER_EPOCHS) continue; // not ours to forward either
      const cur = envelopeCache.get(b.nodeId);
      if (cur && (cur.sig === env.sig || b.epoch < cur.body.epoch)) continue; // held already, or older than what we hold
      if (!cur && evictedRecently(b.nodeId)) continue;
      if (!(await checked(HEARTBEAT_TAG, env))) { guard.heartbeat.badSig++; continue; }
      if (!cur && !roomFor(b.nodeId)) continue;
      envelopeCache.set(b.nodeId, env); fresh.push(env);
    }
    await mergeHeartbeats(fresh);
    const titles = knownTitles();
    const entries = [];
    for (const env of list(msg.queue)) {
      const b = env?.body;
      if (!b || b.playerId !== env.signer || typeof b.bucket !== 'number' || !b.rulesetId) continue;
      const k = `${b.bucket}|${b.playerId}`;
      if (queueEnvelopes.has(k)) continue; // the first valid entry for a player's bucket stands
      if (isStale(b.bucket, now) || b.bucket > bucketOf(now) + QUEUE_AHEAD) { guard.queue.window++; continue; } // a far-future bucket never went stale: it was forwarded forever
      if (!titles.has(b.rulesetId)) { guard.queue.unknownTitle++; continue; }
      if (queueEnvelopes.size >= MAX_QUEUE) { guard.queue.full++; continue; }
      if (!(await checked(QUEUE_TAG, env))) { guard.queue.badSig++; continue; }
      queueEnvelopes.set(k, env); entries.push(env);
    }
    await mergeQueue(entries);
    // seen-by is counted per peer NODE: the sender's own heartbeat leads every push and every reply, so its key names
    // the peer whether the message came by push (a socket address) or by reply (a URL)
    if (Array.isArray(msg.chat)) await mergeChat(msg.chat, meta ? (msg.heartbeats?.[0]?.signer ?? meta.from) : null);
    for (const env of list(msg.matches)) await absorbMatch(env);
    // Ranked placed results are witnessed from the chain (node/matchbook.js); everything else by its custody set.
    if (isWitness) for (const ad of list(msg.deltas)) void witnessOne(ad);
    if (mbook && Array.isArray(msg.hints)) mbook.absorbHints(msg.hints);
    if (mbook && Array.isArray(msg.custody)) mbook.absorbCustody(msg.custody);
  };

  /** Witness role: fetch the ledger and the delta, replay independently,
   *  send back a signature only over the root we reached ourselves. */
  const witnessOne = async (ad) => {
    if (!ad?.matchId || ad.hostId === nodeId || witnessed.has(ad.matchId) || ad.cosigners?.includes(nodeId)) return;
    const hostHb = heartbeats.get(ad.hostId);
    if (hostHb && hostHb.operator === operator && !stakes) { witnessed.add(ad.matchId); return; } // same operator (dev mesh)
    if (stakes && stakes[ad.hostId]?.operator && stakes[nodeId]?.operator === stakes[ad.hostId].operator) { witnessed.add(ad.matchId); return; }
    if (!loaded.has(ad.rulesetId)) return; // hydrate first, retry on a later gossip
    if (peerOrigin(ad.addr) !== ad.addr) return; // an advert's address is as untrusted as a heartbeat's
    if (typeof ad.matchId !== 'string' || ad.matchId.length > 128 || typeof ad.rulesetId !== 'string') return;
    if (!custodians(ad.matchId, ad.rulesetId, ad.hostId).includes(nodeId)) { markWitnessed(ad.matchId); return; } // not drawn for this one
    markWitnessed(ad.matchId);
    try {
      // Replay in the build the delta names. If we do not hold it, fetch it
      // by hash from the host and hold it without making it current.
      if (ad.buildHash && !builds.has(ad.buildHash)) {
        const r = await fetch(`${ad.addr}/ruleset/${encodeURIComponent(ad.rulesetId)}?build=${ad.buildHash}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`host does not serve build ${ad.buildHash.slice(0, 12)}`);
        const att = r.headers.get('x-build-publisher') ? { publisher: r.headers.get('x-build-publisher'), sig: r.headers.get('x-build-sig') } : null;
        await installRuleset(await r.text(), ad.buildHash, { current: false, origin: 'peer', attestation: att });
      }
      const [delta, ledger] = await Promise.all([
        fetch(`${ad.addr}/delta/${encodeURIComponent(ad.matchId)}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()),
        fetch(`${ad.addr}/ledger/${encodeURIComponent(ad.matchId)}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()),
      ]);
      // Settlement v4: a custodian holds the log a court committed, fetched from the host and checked against
      // commitments.inputsHash. Without it this node's proof for the result is `attested`, and a host that claimed
      // `checkable` is disputed rather than taken at its word.
      const lh = delta?.commitments?.inputsHash;
      if (lh && !settlement.hasLog(lh)) {
        try {
          const r = await fetch(`${ad.addr}/log/${lh}`, { signal: AbortSignal.timeout(20_000) });
          if (r.ok) { const bytes = Buffer.from(await r.arrayBuffer()); if (bytes.length <= MAX_LOG_BYTES) settlement.holdLog(bytes, lh); }
        } catch (e) { log(`witness ${ad.matchId}: log ${lh.slice(0, 12)} not fetched (${e.message})`); }
      }
      const res = await settlement.cosign(delta, ledger);
      if (!res.ok) {
        log(`witness ${ad.matchId}: DISAGREE (${res.reason})`); emit('witness', { matchId: ad.matchId, ok: false, reason: res.reason, ours: res.ours, theirs: res.theirs });
        // A recomputed-different result is a signed dispute on the host's
        // record; a failure to check at all (build missing, malformed) is not.
        if (res.dispute) await fetch(`${ad.addr}/dispute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.dispute) }).catch(() => {});
        return;
      }
      await fetch(`${ad.addr}/cosign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(res) });
      log(`witness ${ad.matchId}: co-signed`);
      emit('witness', { matchId: ad.matchId, ok: true, hostId: ad.hostId, root: delta.finalStateRoot, sig: res.sig });
    } catch (e) { witnessed.delete(ad.matchId); log(`witness ${ad.matchId}: ${e.message}`); }
  };

  // ---------------------------------------------------------------- matches
  // A placement is computed ONCE per match on this node, against the snapshot
  // of that moment, and then frozen: the eligible set drifts (a peer ages
  // out, a stake read lags) and a host that changes after it was announced is
  // no placement at all. Descriptors are signed by the computing node and
  // gossiped; a peer that has not computed one adopts a bonded peer's, and a
  // peer that computed differently records the dispute rather than flip.
  // The browser recomputes placement itself and is the final authority.
  const MATCH_TAG = 'match';
  const matchBook = new Map(); // matchId → { descriptor, envelope, disputes: [] }
  let gauntlet = null;          // node/gauntlet.js, created after the server listens (needs our loopback URL)
  let publisherServices = null; // node/publisher-services.js, created with the gateway (POST /gauntlet/* reads its grants)
  const matchTtlMs = 15 * 60_000;
  const SPENT_BUCKETS = 2;
  const describe = (m, s) => {
    const manifest = s.manifests[m.rulesetId];
    const place = manifest ? placement({ nodes: s.peers, manifest, rulesetId: m.rulesetId, matchId: m.matchId, beacon: m.beacon, regions: m.regions }) : null;
    const bc = chain.beaconFor(m.bucket);
    return { ...m, protocol: PROTOCOL_VERSION, buildHash: manifest?.buildHash ?? null, beaconSource: bc?.source, beaconBlock: bc?.block ?? null, snapshotRoot: s.root, snapshotEpoch: s.epoch, computedBy: nodeId, computedAt: Date.now(),
      host: place?.host?.nodeId ?? null, witness: place?.witness?.nodeId ?? null, panel: place?.panel?.map((n) => n.nodeId) ?? [], order: place?.order.map((n) => n.nodeId) ?? [] };
  };
  const matchesNow = () => {
    const s = currentSnapshot();
    const now = Date.now();
    for (const [id, e] of matchBook) if (now - e.descriptor.computedAt > matchTtlMs) matchBook.delete(id);
    // Entries that outlived their bucket: the player left, or was placed a
    // minute ago. Kept, they would pair again as soon as the placement's TTL
    // ran out, and be gossiped forever.
    for (const [k, b] of queue) if (isStale(b.bucket, now)) { queue.delete(k); queueEnvelopes.delete(k); }
    for (const [k, env] of queueEnvelopes) if (env?.body && isStale(env.body.bucket, now)) queueEnvelopes.delete(k);
    // An entry a player posted while still waiting to hear of a placement is SPENT by that placement, not a
    // new search: the client posts one entry per bucket until it sees its match, and every one of those used
    // to become a fresh placement — and a fresh commit the host paid for — a bucket later (four commits for one
    // match in the end-to-end test). A placement spends the player's entries up to the bucket after the one it
    // was COMPUTED in (the client cannot have seen it before then, and posts once more while it polls) — at
    // least two past the placement's own bucket, since a beacon can be slow; an entry after that is a rematch
    // and pairs at once, whether or not the last match settled.
    const spent = new Map(); // player → last bucket spent
    for (const e of matchBook.values()) { const until = Math.max((e.descriptor.bucket ?? -1) + SPENT_BUCKETS, bucketOf(e.descriptor.computedAt) + 1); for (const p of e.descriptor.participants ?? []) spent.set(p, Math.max(spent.get(p) ?? -1, until)); }
    const held = new Set(); // seated earlier in this same pass (two buckets can close in one call)
    const pairs = pair([...queue.values()].filter((b) => b.bucket > (spent.get(b.playerId) ?? -1)), now, (b) => chain.beaconFor(b)?.beacon ?? null);
    for (const m of pairs) {
      if (matchBook.has(m.matchId)) continue;
      if (m.participants.some((p) => held.has(p))) continue; // two buckets paired in one pass: the earlier placement stands
      for (const p of m.participants) held.add(p);
      const d = describe(m, s);
      if (!d.host) continue; // nobody eligible yet; try again next call
      const entry = { descriptor: d, envelope: null, disputes: [], commitTx: null };
      matchBook.set(m.matchId, entry);
      // Placed players leave the queue: the entries they posted while waiting (one per bucket) would otherwise pair
      // again as each bucket closed — a commit transaction the host pays for and a match nobody plays, per bucket
      // (seen end to end: three commits for one match). Every node prunes on the same rule, so the queues agree.
      for (const p of m.participants) for (const k of [...queue.keys()]) if (k.endsWith(`|${p}`)) { queue.delete(k); queueEnvelopes.delete(k); }
      emit('placed', { matchId: m.matchId, bucket: m.bucket, rulesetId: m.rulesetId, host: d.host, witness: d.witness, panel: d.panel, beacon: d.beaconSource, snapshotRoot: d.snapshotRoot, participants: m.participants });
      gauntlet?.onPlaced({ ...d, participants: m.participants, mode: m.mode ?? null });
      // The signature lands a moment later; GET /match waits for it, so no client is served a placement without its envelope.
      entry.sealing = seal(MATCH_TAG, d, identity).then((env) => { entry.envelope = env; }).catch(() => {});
      commitIfHost(m.matchId);
    }
    return [...matchBook.values()].map((e) => ({ ...e.descriptor, disputes: e.disputes, commitTx: e.commitTx ?? null, commitSkipped: e.commitSkipped ?? null }));
  };
  /** The drawn host commits BEFORE play (§6): the panel is on chain before a tick is played. Runs for a
   *  placement this node computed AND for one it adopted from a peer — the adopted path used to commit
   *  nothing at all. A peer's draw may seat fewer than three (it saw fewer fresh peers than we do: a
   *  LAN-only witness beside us is not always fresh across the house); the host redraws from ITS OWN
   *  snapshot then, since the host is the one the chain holds to the panel. */
  // The commit waits one gossip round after the placement is first known: a peer that saw an earlier bucket for
  // the same players sends its placement within a tick or two, and the earliest must be the one on chain. Three
  // commits went out in two seconds for one match on 21 Sep 2026 — one per replacement. Once committed, a
  // placement is never replaced (absorbMatch).
  const COMMIT_SETTLE_MS = 3000;
  const commitIfHost = (matchId) => {
    const e = matchBook.get(matchId);
    if (!mbook || !e || e.commitTx || e.committing) return;
    const d = e.descriptor;
    if (d.host !== nodeId || (d.mode ?? 'casual') !== 'ranked') return;
    if (mbook.statusOf(matchIdBytes32(d.matchId)) !== 'none') { e.commitTx = 'on-chain'; return; } // committed before (a restart, a re-adoption): the chain already has it
    if (e.commitFailedAt && Date.now() - e.commitFailedAt < 60_000) return; // a reverted commit is not retried twice a second
    if (!e.commitAt) {
      e.commitAt = Date.now() + COMMIT_SETTLE_MS;
      e.committed = new Promise((resolve) => { e.resolveCommitted = resolve; }); // a settle that lands first waits on this
      setTimeout(() => commitIfHost(matchId), COMMIT_SETTLE_MS + 50);
      return;
    }
    if (Date.now() < e.commitAt) return;
    let desc = d;
    if ((d.panel?.length ?? 0) < 3) {
      const s = currentSnapshot();
      const manifest = s.manifests[d.rulesetId];
      const place = manifest ? placement({ nodes: s.peers, manifest, rulesetId: d.rulesetId, matchId: d.matchId, beacon: d.beacon, regions: d.regions }) : null;
      if (place?.panel?.length === 3) { desc = { ...d, panel: place.panel.map((n) => n.nodeId) }; e.descriptor = desc; log(`placement ${matchId.slice(0, 12)}: ${d.computedBy === nodeId ? 'our' : 'an adopted'} draw seated ${d.panel?.length ?? 0}; redrawn from our snapshot: ${desc.panel.map((k) => k.slice(0, 8)).join(',')}`); }
    }
    e.committing = true;
    // A draw that seated fewer than three witnesses cannot go on MatchBook: the match stands casual-only. Say so on
    // the entry, so a player's page waiting on this host for a commit (cabinet/client.js confirmWithHost) launches
    // at once instead of waiting out its deadline for a transaction that is never sent.
    const seated = desc.panel?.length ?? 0;
    mbook.commit(desc).then((tx) => { e.commitTx = tx; if (!tx) e.commitFailedAt = Date.now(); e.commitSkipped = !tx && seated !== 3 ? `the draw seated ${seated} witnesses, MatchBook needs 3: casual-only` : null; }).catch(() => { e.commitFailedAt = Date.now(); }).finally(() => { e.committing = false; e.resolveCommitted?.(); });
  };
  /** Adopt or dispute a peer's descriptor. */
  const absorbMatch = async (env) => {
    const d = env?.body;
    if (!d?.matchId || !d.host || d.computedBy !== env.signer || !(await checked(MATCH_TAG, env))) return; // every peer forwards every placement every tick: verified once
    if ((d.protocol ?? 1) !== PROTOCOL_VERSION) return; // another protocol's placement is not ours to adopt
    if (stakes && !stakes[d.computedBy]?.active) return; // only bonded peers' descriptors count
    if (Date.now() - (d.computedAt ?? 0) > matchTtlMs) return; // older than our own TTL: it was pruned here once and would be again (re-adopting one made the host retry a reverted commit twice a second for 20 minutes, 21 Sep 2026)
    const mine = matchBook.get(d.matchId);
    if (!mine) {
      // The same players, already placed here under another id (a peer paired a later bucket before our placement
      // reached it, or an earlier one we missed): one placement per pair stands on every node — the earliest
      // bucket, then the smaller id — so the clients, the host's commit and the seats all name the same match.
      const rival = [...matchBook.values()].find((e) => e.descriptor.matchId !== d.matchId && Math.abs((e.descriptor.bucket ?? 0) - (d.bucket ?? 0)) <= SPENT_BUCKETS && (d.participants ?? []).some((p) => e.descriptor.participants?.includes(p)));
      if (rival) {
        const earlier = (d.bucket ?? Infinity) < (rival.descriptor.bucket ?? Infinity) || (d.bucket === rival.descriptor.bucket && d.matchId < rival.descriptor.matchId);
        if (!earlier) return; // ours stands; theirs is a re-pairing of placed players
        if (rival.commitTx || rival.committing) { log(`placement ${d.matchId.slice(0, 12)} from ${d.computedBy.slice(0, 8)} is earlier than ${rival.descriptor.matchId.slice(0, 12)}, but ours is on chain — it stands`); return; }
        matchBook.delete(rival.descriptor.matchId); // theirs came first: it stands, ours goes (a commit already sent expires on its own)
        gauntlet?.stop(rival.descriptor.matchId, 'replaced by an earlier placement');
        log(`placement ${d.matchId.slice(0, 12)} from ${d.computedBy.slice(0, 8)} replaces our later ${rival.descriptor.matchId.slice(0, 12)} for the same players`);
      }
      matchBook.set(d.matchId, { descriptor: { ...d, disputes: undefined }, envelope: env, disputes: [], commitTx: null });
      // An adopted placement that names this node as host is ours to serve exactly like one we computed: start
      // the title's match server, or the players reach a host with no room (only computed ones used to).
      gauntlet?.onPlaced({ ...d, participants: d.participants, mode: d.mode ?? null });
      commitIfHost(d.matchId); return;
    }
    if (mine.descriptor.host !== d.host && !mine.disputes.some((x) => x.by === d.computedBy)) {
      mine.disputes.push({ by: d.computedBy, host: d.host, snapshotRoot: d.snapshotRoot });
      emit('dispute', { matchId: d.matchId, ours: mine.descriptor.host, theirs: d.host, by: d.computedBy });
      log(`placement dispute ${d.matchId.slice(0, 12)}: we drew ${mine.descriptor.host.slice(0, 12)}, ${d.computedBy.slice(0, 12)} drew ${d.host.slice(0, 12)}`);
    }
  };
  const matchEnvelopes = () => [...matchBook.values()].map((e) => e.envelope).filter(Boolean);

  // ---------------------------------------------------------------- static
  // Every node serves the cabinet (the arcade frontend) at / and the protocol
  // modules it imports, so a node is also a frontend host: open http://<node>/
  // and play. The same cabinet/ folder deploys unchanged to any static host
  // (BUILD-SPEC §12: origin is not authorization). API paths are matched
  // before the static fallback, so /health can never be shadowed by a file.
  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  const serveStatic = (res, rel) => {
    const safe = rel.replace(/\.\./g, '').replace(/^\/+/, '');
    const file = join(staticRoot, safe);
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...CORS, 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
    return true;
  };

  // ---------------------------------------------------------------- views
  const titlesNow = () => {
    const now = epochOf(Date.now());
    const titles = new Map();
    const take = (m, host, hostRoles) => {
      const t = titles.get(m.rulesetId) ?? { rulesetId: m.rulesetId, kind: m.kind, buildHash: m.buildHash, publisher: m.publisher ?? null, owner: titleOwners.get(m.rulesetId) ?? null, build: loaded.get(m.rulesetId)?.buildHash === m.buildHash ? titleBuilds.get(m.rulesetId) ?? null : null, display: m.display ?? null, modes: m.modes, participants: m.participants, services: m.services, hosts: [], bondedHosts: 0, publisherHosts: 0, published: null };
      if (!t.hosts.includes(host)) {
        t.hosts.push(host);
        // publisherHosts: bonded, carrying the HOST role, bonded from the wallet that holds the title
        if (stakes?.[host]?.active) { t.bondedHosts++; if (t.owner && hostRoles.includes('host') && stakes[host].operator?.toLowerCase() === t.owner) t.publisherHosts++; }
      }
      // published: the title is registered on chain AND its publisher runs a bonded host for it. null = no registry configured (listing falls back to display + a bonded host).
      t.published = titleRegistry ? !!t.owner && t.publisherHosts > 0 : null;
      titles.set(m.rulesetId, t);
    };
    for (const m of Object.values(manifests())) take(m, nodeId, roles);
    for (const b of heartbeats.values()) if (b.nodeId !== nodeId && b.epoch >= now - 2) for (const m of Object.values(b.manifests ?? {})) take(m, b.nodeId, b.roles ?? []);
    return [...titles.values()];
  };

  // With MatchBook the chain says what is official; the v0.2 local flag (witness co-signs over gossip, which
  // MatchBook nodes no longer send) read `official: false` for a match the chain had finalized — two answers on
  // one screen. The local delta keeps its fields; `chain` says what the log says and `official` follows it.
  const withChain = (deltas) => (mbook ? deltas.map((d) => {
    const st = mbook.statusOf(matchIdBytes32(d.matchId));
    // Final on chain is official only for a result the players signed (protocol/result.js isOfficial): an attested
    // title's court report can finalize, and still never counts as official.
    return { ...d, chain: st, ...(st === 'none' ? {} : { official: st === 'final' && d.attestation === 'players', verification: st === 'final' ? 'verified' : st === 'void' ? 'disputed' : d.verification }) };
  }) : deltas);
  /** The operator's whole view in one document, from memory: this node, its chain, the mesh as it hears it, every
   *  link it measures, the rooms it holds, who is queued, the titles on offer, the last events. GET /fleet. */
  const fleetNow = () => {
    const now = Date.now(), nowEpoch = epochOf(now);
    const s = currentSnapshot();
    const eligible = new Set(s.peers.map((p) => p.nodeId));
    const peers = [...heartbeats.values()].filter((b) => b.nodeId !== nodeId).map((b) => {
      const ageS = Math.max(0, +(((nowEpoch - b.epoch) * EPOCH_MS) / 1000).toFixed(1));
      const link = linkOf(b.addr, (b.links ?? []).find((l) => nodeId.startsWith(l.id))?.ms ?? null);
      return { nodeId: b.nodeId, operator: b.operator, addr: b.addr ?? null, wsAddr: b.wsAddr ?? null, region: b.region, roles: b.roles, version: b.version ?? null, protocol: b.protocol ?? 1,
        fresh: b.epoch >= nowEpoch - 2, ageS, clockSkewS: +(((b.epoch - nowEpoch) * EPOCH_MS) / 1000).toFixed(1),
        bonded: stakes ? !!stakes[b.nodeId]?.active : null, wallet: stakes?.[b.nodeId]?.operator ?? null, eligible: eligible.has(b.nodeId), rulesets: Object.keys(b.buildHashes ?? {}),
        link, quality: quality(ageS, link), links: b.links ?? [] };
    });
    const byPrefix = (id16) => (nodeId.startsWith(id16) ? nodeId : peers.find((p) => p.nodeId.startsWith(id16))?.nodeId ?? null);
    // The graph: our measured edges, then every edge a peer reports in its heartbeat (its own measurements).
    const edges = [];
    for (const p of peers) if (p.link?.direct) edges.push({ from: nodeId, to: p.nodeId, ms: p.link.emaMs, measured: true });
    for (const p of peers) for (const l of p.links) { const to = byPrefix(l.id); if (to && to !== p.nodeId) edges.push({ from: p.nodeId, to, ms: l.ms ?? null, measured: false }); }
    const versions = {};
    for (const b of heartbeats.values()) versions[b.version ?? '?'] = (versions[b.version ?? '?'] ?? 0) + 1;
    const local = new Map(settlement.list().map((d) => [d.matchId, d]));
    const rooms = matchesNow().map((m) => {
      const cs = mbook ? mbook.chainStatus(m.matchId) : null;
      const d = local.get(m.matchId) ?? null;
      const chainStatus = cs?.status ?? 'none';
      const state = chainStatus !== 'none' ? chainStatus : d ? 'played' : m.commitTx ? 'committing' : 'placed';
      return { matchId: m.matchId, room: `LIT-${m.matchId}`, rulesetId: m.rulesetId, mode: m.mode ?? 'casual', bucket: m.bucket, participants: m.participants, host: m.host, witness: m.witness ?? null, panel: m.panel ?? [], ours: m.host === nodeId, seated: (m.panel ?? []).includes(nodeId),
        placedAt: new Date(m.computedAt).toISOString(), state, commitTx: m.commitTx ?? null, attests: cs ? cs.events.filter((e) => e.event === 'Attested').length : 0, chainEvents: cs?.events.length ?? 0, disputes: m.disputes?.length ?? 0, settledAt: d?.settledAt ?? null, ticks: d?.ticks ?? null };
    });
    const waiting = new Map();
    for (const b of queue.values()) { const k = `${b.rulesetId}|${b.mode ?? 'casual'}`; const w = waiting.get(k) ?? { rulesetId: b.rulesetId, mode: b.mode ?? 'casual', waiting: 0, players: [], buckets: new Set() }; w.waiting++; if (!w.players.includes(b.playerId)) w.players.push(b.playerId); w.buckets.add(b.bucket); waiting.set(k, w); }
    const mbs = mbook ? mbook.status() : null;
    return {
      at: new Date(now).toISOString(), nodeId, version, protocol: PROTOCOL_VERSION, cabinet: CABINET_VERSION,
      self: { nodeId, operator, roles, region, version, addr, lanAddr, wsAddr, startedAt: new Date(startedAt).toISOString(), uptimeMs: now - startedAt, stalls,
        bonded: stakes?.[nodeId]?.active ?? null, wallet: stakes?.[nodeId]?.operator ?? null, eligible: eligible.has(nodeId), bond: myBond ? { eligible: myBond.eligible, delegate: myBond.delegate, amount: myBond.amount.toString() } : null,
        tunnel: tunnels.node?.status() ?? null, relay: relayFront ? relayStatus() : null, upnp: upnpCtl?.status() ?? null, update: (({ available, latest, checkedAt, lastError, registry, channel, canRollback, applying, date }) => ({ available, latest, checkedAt: checkedAt ?? null, lastError: lastError ?? null, registry, channel, canRollback, applying: !!applying, date: date ?? null }))(updater.status()),
        inbound: { peers: [...inbound.values()].filter((t) => now - t < 30_000).length, reachable: peersKnown.size ? [...inbound.values()].some((t) => now - t < 30_000) : null }, sandbox: sandbox.status() },
      chain: { ...(({ rpc, rpcEndpoints, head, headTs, lagS, rpcMs, rpcLastMs, rpcCalls, rpcFailures, rpcAt, lastError, offline }) => ({ rpc, rpcEndpoints, head, headTs, lagS, rpcMs, rpcLastMs, rpcCalls, rpcFailures, rpcAt, lastError, offline }))(chain.status()),
        matchBook: mbs ? { contract: mbs.contract, delegate: mbs.delegate, delegated: mbs.delegated, funded: mbs.funded, enrolled: mbs.enrolled, purse: mbs.purse, cursor: mbs.cursor, scanRange: mbs.scanRange, events: mbs.events, sends: mbs.sends, lastTx: mbs.lastTx, lastError: mbs.lastError, hosting: mbs.hosting, seated: mbs.seated, windows: mbs.windows, sent: mbook.sent(50) } : null,
        // the addresses THIS process runs against, and the generation its deployed.testnet.json claimed — a cabinet compares with its own contracts.js
        contracts: { generation: contractsGeneration, NodeStake: nodeStake, NodeDirectory: nodeDirectory, MatchBook: matchBookAddr, GasRefund: gasRefund, EpochAnchor: epochAnchor, ReleaseRegistry: releaseRegistry, TitleRegistry: titleRegistry, PlayerProfile: playerProfile, ERC6699Registry: erc6699 },
        announcer: announcer?.status() ? (({ address, delegated, funded, lastTx, lastError, entry }) => ({ address, delegated, funded, lastTx, lastError, entry: entry ? { url: entry.url, wsAddr: entry.wsAddr || null, updatedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : null } : null }))(announcer.status()) : null,
        recentBlocks: chain.recentBlocks(12) },
      mesh: { active: peers.filter((p) => p.fresh).length + 1, known: peers.length + 1, bonded: peers.filter((p) => p.bonded).length + (stakes?.[nodeId]?.active ? 1 : 0), eligible: s.peers.length, incompatible: incompatible.size,
        snapshotRoot: s.root, epoch: s.epoch, versions, urls: peersKnown.size, unreachable: [...unreachable.keys()], gossip: trafficNow() },
      peers, graph: { nodes: [{ nodeId, operator, self: true, fresh: true }, ...peers.map((p) => ({ nodeId: p.nodeId, operator: p.operator, self: false, fresh: p.fresh }))], edges },
      rooms, queue: [...waiting.values()].map((w) => ({ ...w, buckets: [...w.buckets].sort() })), titles: titlesNow().map((t) => ({ rulesetId: t.rulesetId, display: t.display, hosts: t.hosts.length, bondedHosts: t.bondedHosts, published: t.published })),
      recent: mbook ? mbook.recent(20) : [], events: recent.slice(-50), guardian: guardianFleet(), chat: chatLines(),
    };
  };

  // ---------------------------------------------------------------- http
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { if (serveStatic(res, 'cabinet/index.html')) return; }
      if (req.method === 'GET' && (url.pathname.startsWith('/cabinet/') || url.pathname.startsWith('/protocol/'))) { if (serveStatic(res, url.pathname)) return; return json(res, 404, { error: 'not found' }); }
      // Proof of possession: sign the reader's nonce with the node key, so a
      // URL from the directory can be checked against the key it claims.
      if (req.method === 'GET' && url.pathname === '/whoami') {
        const nonce = url.searchParams.get('nonce') ?? '';
        if (!NONCE_RE.test(nonce)) return json(res, 400, { error: 'nonce=<16..64 hex> required' });
        return json(res, 200, await answerChallenge({ nodeId, nonce, addr }, identity.privateKey));
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        const s = currentSnapshot();
        return json(res, 200, { nodeId, operator, roles, region, addr, protocol: PROTOCOL_VERSION, settlement: settlementStatus(), epoch: s.epoch, peers: s.peers.length, incompatible: incompatible.size, rulesets: buildHashes(), buildsHeld: builds.size, refused: refused.size, gossipLimits: guardStatus(), staking: s.staking, bonded: stakes?.[nodeId]?.active ?? null,
          // v3 bond: witnessEligible, delegate, bondedSince; `admin` says whether NodeStake's admin is a multisig/timelock ('contract') or a wallet ('eoa'). null = v2 contract or unread.
          bond: myBond ? { eligible: myBond.eligible, delegate: myBond.delegate, bondedSince: myBond.bondedSince ? new Date(myBond.bondedSince * 1000).toISOString() : null, unbondAt: myBond.unbondAt ? new Date(myBond.unbondAt * 1000).toISOString() : null, amount: myBond.amount.toString() } : null,
          admin: stakeAdmin === null ? null : stakeAdmin ? 'contract' : 'eoa', matchBook: mbook ? mbook.status() : matchBookAddr ? { contract: matchBookAddr, offline: true } : null, chain: chain.status(), profiles: profileState(), version, repair: sdkMissing, update: updater.status(),
          sandbox: sandbox.status(), secrets: secretsStatus(), trust: { policy: titleTrust, publishers: trustedPublishers, titleRegistry: titleRegistry ?? null, relayKeys, courts: Object.keys(courts) }, registry: registry ? 'chain' : erc6699 ? 'offline' : 'unset',
          cabinet: { version: CABINET_VERSION }, // the copy this node serves at /; a cabinet loaded from elsewhere compares its own
          relay: relayFront ? relayStatus() : null, // the relay tunnel as a WebSocket client sees it: verified before it is advertised
          wsAddr, lanAddr, tunnel: { node: tunnels.node?.status() ?? null, relay: tunnels.relay?.status() ?? null, ro3: tunnels.ro3?.status() ?? null }, upnp: upnpCtl?.status() ?? null, gauntlet: gauntlet?.status() ?? null, gauntletServers: Object.keys(gauntletServers).length || servers.size ? serverStatus() : null, guardian: (({ matches, reports, flagged }) => ({ matches, reports, flagged: flagged.length }))(guardianSummary()),
          directory: nodeDirectory ? { contract: nodeDirectory, seeds: chainSeeds.length, announcer: announcer?.status() ?? null } : null, startedAt: new Date(startedAt).toISOString(), uptimeMs: Date.now() - startedAt, stalls, chainTicksSkipped: chainSkipped,
          // reachable: a peer has pushed gossip to us in the last 30 s. null = no peers known, so nothing to conclude.
          inbound: { peers: [...inbound.values()].filter((t) => Date.now() - t < 30_000).length, lastAt: inbound.size ? new Date(Math.max(...inbound.values())).toISOString() : null, reachable: peersKnown.size ? [...inbound.values()].some((t) => Date.now() - t < 30_000) : null } });
      }
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        const s = currentSnapshot();
        // ?envelopes=1: the signed heartbeats behind it, so a client can
        // re-verify every signature and recompute the root itself instead
        // of taking this node's word for the membership (audit finding 8).
        if (url.searchParams.get('envelopes') === '1') return json(res, 200, { ...s, envelopes: [await myHeartbeat(), ...envelopeCache.values()], stakes: stakes ?? null, protocol: PROTOCOL_VERSION });
        return json(res, 200, s);
      }
      // Every title the mesh hosts right now: this node's plus every fresh
      // peer's, from the manifests they gossip. The arcade lists from here.
      if (req.method === 'GET' && url.pathname === '/titles') return json(res, 200, { titles: titlesNow() });
      if (req.method === 'GET' && url.pathname === '/fleet') {
        // The operator's dashboard, signed: everything above folded into one document from memory (no RPC, no
        // disk), a digest of it, and — with ?nonce= — the node key's answer over nonce + digest, so LITNODE-CONTROL
        // knows it is looking at THIS node's word, now (docs/FLEET-TELEMETRY.md).
        const nonce = url.searchParams.get('nonce');
        if (nonce != null && !NONCE_RE.test(nonce)) return json(res, 400, { error: 'nonce=<16..64 hex> required' });
        const body = fleetNow();
        const digest = h('fleet', body);
        return json(res, 200, { ...body, digest, proof: nonce ? await answerChallenge({ nodeId, nonce, addr, digest }, identity.privateKey) : null });
      }
      // Everyone we have heard from, bonded or not — for onboarding a new
      // machine (its full nodeId is what the bond tool needs). /snapshot is
      // the bonded set only.
      // RO3Emu servers on the mesh, newest heartbeat first: what `RO3Emu.exe join litnode` reads (node/ro3.js).
      if (req.method === 'GET' && url.pathname === '/ro3/hosts') {
        const now = Date.now(), recent = epochOf(now) - Math.ceil(60_000 / EPOCH_MS);
        const hosts = [...heartbeats.values()].filter((b) => b.nodeId !== nodeId && b.epoch >= recent)
          .map((b) => ({ b, e: ro3Entry(b) })).filter((x) => x.e)
          .map(({ b, e }) => ({ nodeId: b.nodeId, name: e.name, url: e.url, seenAt: b.epoch * EPOCH_MS }));
        if (ro3) hosts.push({ nodeId, name: ro3.name, url: ro3.url, seenAt: now, self: true });
        return json(res, 200, { hosts: hosts.sort((x, y) => y.seenAt - x.seenAt) });
      }
      if (req.method === 'GET' && url.pathname === '/peers') {
        const now = Date.now();
        return json(res, 200, { peers: [...heartbeats.values()].map((b) => ({
          nodeId: b.nodeId, operator: b.operator, addr: b.addr, region: b.region, roles: b.roles,
          fresh: b.epoch >= epochOf(now) - 2, bonded: stakes ? !!stakes[b.nodeId]?.active : null,
          // The staking wallet and witness eligibility the chain gives this key (0.12.2): what MatchBook counts as an
          // operator. `operator` above is the label the node chose for itself. null = not read (or no NodeStake).
          wallet: stakes?.[b.nodeId]?.operator?.toLowerCase() ?? null, witnessEligible: typeof stakes?.[b.nodeId]?.eligible === 'boolean' ? stakes[b.nodeId].eligible : null,
          // Their clock minus ours, in seconds, at their last heartbeat. A peer
          // more than ~4 s behind never reads as fresh: that is clock skew,
          // not a dead node (BUILD-SPEC §16).
          clockSkewS: +(((b.epoch - epochOf(now)) * EPOCH_MS) / 1000).toFixed(1),
          rulesets: Object.keys(b.buildHashes ?? {}), version: b.version ?? null, protocol: b.protocol ?? 1,
        })), incompatible: [...incompatible].map(([id, x]) => ({ nodeId: id, ...x })) });
      }
      // A title's server bundle, by hash (node/server-bundle.js): the gzipped archive, with the publisher attestation
      // in headers as a ruleset's; ?manifest=1 answers with what is inside instead.
      if (req.method === 'GET' && url.pathname.startsWith('/server/')) {
        const rid = decodeURIComponent(url.pathname.slice(8));
        const want = url.searchParams.get('build');
        const e = want ? (servers.get(want)?.rulesetId === rid ? servers.get(want) : null) : serverCurrent.get(rid);
        if (!e) return json(res, 404, { error: want ? 'server bundle not held' : 'no server bundle for this title' });
        if (url.searchParams.get('manifest') === '1') return json(res, 200, { rulesetId: e.rulesetId, serverHash: e.hash, manifest: e.manifest, publisher: e.publisher, origin: e.origin, bytes: e.bytes, files: e.files });
        res.writeHead(200, { 'content-type': 'application/gzip', 'x-build-hash': e.hash, ...(e.publisher ? { 'x-build-publisher': e.publisher, 'x-build-sig': e.sig } : {}), ...CORS });
        return res.end(readFileSync(e.file));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/ruleset/')) {
        const rid = decodeURIComponent(url.pathname.slice(9));
        const want = url.searchParams.get('build');
        const r = want ? (builds.get(want)?.rulesetId === rid ? builds.get(want) : null) : loaded.get(rid);
        if (!r) return json(res, 404, { error: want ? 'build not held' : 'unknown ruleset' });
        res.writeHead(200, { 'content-type': 'text/javascript', 'x-build-hash': r.buildHash, ...(r.publisher ? { 'x-build-publisher': r.publisher, 'x-build-sig': r.sig } : {}), ...CORS });
        return res.end(r.source);
      }
      if (req.method === 'POST' && url.pathname === '/gossip') {
        const text = await readText(req);
        const from = req.socket.remoteAddress ?? '?';
        inbound.set(from, Date.now());
        trafficNote('in', text.length);
        const msg = text ? JSON.parse(text) : {};
        await absorb(msg, { from, bytes: text.length, via: 'push' });
        // Answer with everything we push, deltas included: a peer that can
        // reach us while we cannot reach it (NAT, a second subnet) must still
        // learn what we settled, or it can never witness it.
        return json(res, 200, {
          heartbeats: [await myHeartbeat(), ...envelopeCache.values()],
          queue: [...queueEnvelopes.values()],
          deltas: adverts(),
          hints: mbook ? mbook.hints() : [],
          custody: mbook ? mbook.custodyAdverts() : [],
          matches: matchEnvelopes(),
          // the chat window — or the whole ring when the pusher's newest is further behind ours than the window (a restart, a partition)
          chat: chatEnvelopes(Number.isFinite(msg?.chatNewest) && chatNewest() - msg.chatNewest > CHAT_PUSH_WINDOW_MS), chatNewest: chatNewest(),
        });
      }
      // Node chat: this machine speaks from the node's own key (docs/NODE-CHAT.md). Anyone reads it on /fleet.chat.
      // Generation 4 NodeStake binds a node key only with the key's own signature over bondMessage(chainId, NodeStake,
      // operator). The Nodes page asks this node for it. Loopback only, and only for this node's own page, the hosted
      // arcade or a caller with no Origin (a terminal): with CORS open, any website on the operator's machine could
      // otherwise obtain a proof naming ITS wallet and bind the key first.
      if (req.method === 'GET' && url.pathname === '/bond-proof') {
        if (!isLoopback(req)) return json(res, 403, { error: 'bond proofs are signed for this machine only' });
        const origin = req.headers.origin;
        const ownOrigins = [`http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`, 'https://arcade.litvm.games'];
        if (origin && !ownOrigins.includes(origin)) return json(res, 403, { error: `bond proofs are not signed for pages at ${origin}` });
        const operatorAddr = url.searchParams.get('operator') ?? '';
        if (!/^0x[0-9a-fA-F]{40}$/.test(operatorAddr)) return json(res, 400, { error: 'operator must be a 0x address' });
        if (!nodeStake) return json(res, 400, { error: 'no NodeStake configured' });
        const cid = chainId ?? 4441;
        const proof = await bondProof(identity.privateKey, cid, nodeStake, operatorAddr);
        emit('bond-proof', { operator: operatorAddr });
        return json(res, 200, { nodeId, operator: operatorAddr.toLowerCase(), chainId: cid, nodeStake, message: Buffer.from(bondMessage(cid, nodeStake, operatorAddr)).toString('hex'), proof });
      }
      if (req.method === 'POST' && url.pathname === '/chat') {
        if (!isLoopback(req)) return json(res, 403, { error: 'chat is sent from the node\'s own machine only' });
        if (stakes && !stakes[nodeId]?.active) return json(res, 403, { error: 'bond this node to chat: an unbonded key is not forwarded' });
        let env;
        try { const b = await readBody(req).catch(() => ({})); env = await seal(CHAT_TAG, chatBody(b?.text), identity); } catch (e) { return json(res, 400, { error: e.message }); }
        const before = guard.chat.rate;
        await mergeChat([env]);
        const id = chatId(env);
        if (!chat.has(id)) return json(res, guard.chat.rate > before ? 429 : 400, { error: guard.chat.rate > before ? 'too fast: three messages per fifteen seconds' : 'not held' });
        return json(res, 202, { ok: true, id, at: env.body.at, envelope: env });
      }
      if (req.method === 'POST' && url.pathname === '/queue') {
        const env = await readBody(req);
        const b = env?.body;
        if (!b || b.playerId !== env.signer) return json(res, 400, { error: 'queue entry must be signed by the player it names' });
        if (!(await checked(QUEUE_TAG, env))) return json(res, 403, { error: 'bad signature' });
        // Typed before stored: `Math.abs(undefined - n) > 2` is false, and an entry with no bucket sat in the table for good.
        if (!Number.isInteger(b.bucket) || Math.abs(b.bucket - bucketOf(Date.now())) > 2) return json(res, 400, { error: 'bucket out of window' });
        if (typeof b.rulesetId !== 'string' || !knownTitles().has(b.rulesetId)) { guard.queue.unknownTitle++; return json(res, 400, { error: `unknown title ${String(b.rulesetId).slice(0, 64)}` }); }
        // A key its profile owner revoked is refused; an unbound key is a guest and fine.
        await refreshProfiles([b.playerId]).catch(() => {});
        const prof = profileCache.get(b.playerId);
        if (prof && prof.tokenId !== 0n && !prof.active) { emit('refused', { what: 'queue', reason: 'key revoked', playerId: b.playerId }); return json(res, 403, { error: 'key revoked by its profile owner' }); }
        const qk = `${b.bucket}|${b.playerId}`;
        if (!queueEnvelopes.has(qk) && queueEnvelopes.size >= MAX_QUEUE) { guard.queue.full++; return json(res, 503, { error: 'matchmaking queue is full on this node; try another node or a moment later' }); }
        await mergeQueue([env]);
        if (!queue.has(qk)) return json(res, 400, { error: 'queue entry refused' }); // held only once the queue itself accepted it
        queueEnvelopes.set(qk, env);
        emit('queue', { playerId: b.playerId, rulesetId: b.rulesetId, mode: b.mode, bucket: b.bucket, region: b.region ?? null, sig: env.sig });
        return json(res, 202, { ok: true, bucket: b.bucket });
      }
      if (req.method === 'GET' && url.pathname === '/match') {
        const pid = url.searchParams.get('playerId');
        // Each entry carries its signed envelope: the client sends it back as the submission's `descriptor`, so the
        // ledger binds even once this book has replaced, pruned or (a restart) lost the placement (settle.js bind).
        const now = matchesNow();
        await Promise.all(now.map((m) => matchBook.get(m.matchId)?.sealing)); // a placement computed this very tick: its signature is a moment away
        const all = now.map((m) => ({ ...m, envelope: matchBook.get(m.matchId)?.envelope ?? null }));
        return json(res, 200, { matches: pid ? all.filter((m) => m.participants.includes(pid)) : all });
      }
      // ---------------------------------------------------------- settlement
      if (req.method === 'POST' && url.pathname === '/ledger') {
        if (!canSettle) return json(res, 403, { error: 'this node has no settling role' });
        try {
          const sub = await readBody(req);
          // A submission nobody signed (no players, no relay, no court) settles casual, labelled `host`, and costs this
          // node a sandbox process and a file. Strangers get a budget per address; the operator's own machine does not.
          const unsigned = sub?.kind !== 'attested' && !sub?.relay && !(sub?.signatures && Object.keys(sub.signatures).length);
          if (unsigned && !isLoopback(req) && !unsignedLedgerOk(req.socket.remoteAddress ?? '?')) { emit('refused', { what: 'ledger', reason: 'unsigned submissions rate-limited' }); return json(res, 429, { error: 'too many unsigned submissions from this address; sign the ledger or wait a minute' }); }
          const d = await settlement.intake(sub);
          emit('settled', { matchId: d.matchId, rulesetId: d.rulesetId, ticks: d.ticks, root: d.finalStateRoot, attestation: d.attestation, hostSig: d.hostSig, participants: d.participants });
          gauntlet?.onSettled(d.matchId);
          return json(res, 200, d);
        } catch (e) { emit('refused', { what: 'ledger', reason: e.message }); return json(res, 400, { error: e.message }); }
      }
      // A seat serves the ledgers it holds in custody too (0.12.2): a reader checks what it fetched against the chain's
      // ledgerHash, so any holder is as good as the host.
      if (req.method === 'GET' && url.pathname.startsWith('/ledger/')) {
        const id = decodeURIComponent(url.pathname.slice(8));
        const l = settlement.ledger(id) ?? mbook?.held(id)?.ledger ?? null;
        return l ? json(res, 200, l) : json(res, 404, { error: 'unknown match' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/delta/')) {
        const id = decodeURIComponent(url.pathname.slice(7));
        // this node's own result, else a seat's custody copy — which a results screen reads with ?chain=1 too
        const d = settlement.delta(id) ?? mbook?.held(id)?.delta ?? null;
        // ?chain=1: the same chain view /deltas gives, so a results screen can tell "final on MatchBook" from one
        // route. Opt-in: witnesses and custodians fetch the delta itself here, and must get it unannotated.
        if (!d) return json(res, 404, { error: 'unknown match' });
        return json(res, 200, url.searchParams.get('chain') === '1' ? withChain([d])[0] : d);
      }
      // Settlement v4: the exact log bytes a court committed (report.commitments.inputsHash), content-addressed.
      if (req.method === 'GET' && url.pathname.startsWith('/log/')) {
        const hash = url.pathname.slice('/log/'.length);
        const bytes = /^[0-9a-f]{64}$/.test(hash) ? settlement.readLog(hash) : null;
        if (!bytes) return json(res, 404, { error: 'log not held here' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-log-sha256': hash });
        return res.end(bytes);
      }
      if (req.method === 'GET' && url.pathname === '/deltas') {
        // ?player=<id> keeps one player's results (a key, or a prefixed casual id), so an in-game history does not
        // download every result of the title.
        const who = url.searchParams.get('player');
        let ds = settlement.list(url.searchParams.get('ruleset') ?? undefined, { scope: url.searchParams.get('scope') === 'official' ? 'official' : 'all' });
        if (who) ds = ds.filter((d) => d.participants?.includes(who));
        return json(res, 200, { deltas: withChain(ds) });
      }
      // Custody before settle: a seat says it holds the ledger this host is about to settle (node/matchbook.js acceptReceipt)
      if (req.method === 'POST' && url.pathname === '/custody') {
        if (!mbook) return json(res, 404, { ok: false, reason: 'no MatchBook here' });
        const env = await readBody(req).catch(() => null);
        const b = env?.body;
        if (!b || typeof b.matchId !== 'string' || typeof b.ledgerHash !== 'string' || b.seat !== env.signer) return json(res, 400, { ok: false, reason: 'a custody receipt is signed by the seat it names' });
        if (!(await checked(CUSTODY_TAG, env))) return json(res, 403, { ok: false, reason: 'bad signature' });
        return json(res, 200, mbook.acceptReceipt(b));
      }
      if (req.method === 'POST' && url.pathname === '/dispute') {
        const dsp = await readBody(req);
        if (stakes) { const w = stakes[dsp.witnessId], me = stakes[nodeId]; if (!w?.active) return json(res, 200, { ok: false, reason: 'witness not bonded' }); if (me?.operator && w.operator === me.operator) return json(res, 200, { ok: false, reason: 'witness shares the host\'s staking address' }); }
        const r = await settlement.acceptDispute(dsp);
        if (r.ok) emit('disputed', { matchId: dsp.matchId, witnessId: dsp.witnessId, reason: dsp.reason, disputes: r.disputes }); else emit('refused', { what: 'dispute', reason: r.reason, matchId: dsp.matchId });
        return json(res, 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/cosign') {
        const c = await readBody(req);
        // With staking on chain, only a bonded witness under a different
        // staking address than this host counts.
        if (stakes) {
          const w = stakes[c.witnessId], me = stakes[nodeId];
          if (!w?.active) return json(res, 200, { ok: false, reason: 'witness not bonded' });
          if (me?.operator && w.operator === me.operator) return json(res, 200, { ok: false, reason: 'witness shares the host\'s staking address' });
        }
        const r = await settlement.acceptCosign(c);
        if (r.ok) emit('cosigned', { matchId: c.matchId, witnessId: c.witnessId, sig: c.sig, cosigners: r.cosigners.length });
        else emit('refused', { what: 'cosign', reason: r.reason, matchId: c.matchId });
        return json(res, 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/guardian') {
        let env; try { env = await readBody(req); } catch (e) { return json(res, 400, { ok: false, reason: e.message }); }
        const bad = await verifyReport(env);
        if (bad) return json(res, 400, { ok: false, reason: bad });
        const b = env.body, gid = env.signer;
        const w = guardianWindow.get(gid);
        if (w && Date.now() - w.from < 60_000) { if (++w.n > GUARDIAN_PER_MIN) return json(res, 429, { ok: false, reason: 'rate limited' }); }
        else { if (guardianWindow.size > 10_000) guardianWindow.clear(); guardianWindow.set(gid, { from: Date.now(), n: 1 }); }
        const d = settlement.delta(b.matchId);
        if (!d) return json(res, 404, { ok: false, reason: 'unknown match' });
        if (d.resultHash !== b.resultHash) return json(res, 409, { ok: false, reason: 'report is for another result' });
        let m = guardianReports.get(b.matchId);
        if (!m) {
          if (guardianReports.size >= GUARDIAN_MATCHES) guardianReports.delete(guardianReports.keys().next().value);
          guardianReports.set(b.matchId, (m = new Map()));
        }
        if (!m.has(gid) && m.size >= GUARDIANS_PER_MATCH) return json(res, 200, { ok: true, counted: false });
        m.set(gid, { verdict: b.verdict, failed: b.failed, at: b.at, sig: env.sig });
        guardianRecent.push({ matchId: b.matchId, guardianId: gid, verdict: b.verdict, failed: b.failed, at: b.at, receivedAt: Date.now() });
        if (guardianRecent.length > 200) guardianRecent.splice(0, guardianRecent.length - 200);
        emit(b.verdict === 'inconsistent' ? 'guardian' : 'guardian.ok', { matchId: b.matchId, guardianId: gid, verdict: b.verdict, failed: b.failed });
        return json(res, 200, { ok: true, counted: true });
      }
      if (req.method === 'GET' && url.pathname === '/guardian') {
        const id = url.searchParams.get('matchId');
        if (!id) return json(res, 200, guardianSummary());
        const m = guardianReports.get(id);
        return json(res, 200, { matchId: id, reports: m ? [...m].map(([guardianId, r]) => ({ guardianId, ...r })) : [] });
      }
      // A court for a match a PUBLISHER formed (node/gauntlet.js startDirect): its matchmaker, running
      // as a publisher service on this node, asks here with the token only it was given
      // (node/publisher-services.js "gauntletCallers"). This machine only - the node's port is public
      // through its tunnel - and only for the bundle's own titles. The answer carries the run's
      // per-match ticket secret, which is why neither check is optional.
      if ((url.pathname === '/gauntlet/start' || url.pathname === '/gauntlet/stop') && req.method === 'POST') {
        if (!isLoopback(req)) return json(res, 403, { error: 'gauntlets are started from this machine only' });
        const grant = publisherServices?.gauntletGrant(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
        if (!grant) return json(res, 401, { error: 'a publisher gauntlet token is required' });
        if (!gauntlet) return json(res, 503, { error: 'this node runs no gauntlets' });
        let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        if (url.pathname === '/gauntlet/stop') {
          const run = gauntlet.active.get(String(body?.matchId ?? ''));
          if (!run || !run.direct || run.owner !== grant.prefix) return json(res, 404, { error: 'no direct match of yours with that id' });
          gauntlet.stop(run.matchId, `stopped by ${grant.prefix}`);
          return json(res, 200, { ok: true });
        }
        const rulesetId = String(body?.rulesetId ?? '');
        if (!grant.rulesets.includes(rulesetId)) return json(res, 403, { error: `this token cannot start ${rulesetId || 'that title'}` });
        const out = await gauntlet.startDirect({ rulesetId, matchId: body?.matchId, format: body?.mode, seats: body?.seats, owner: grant.prefix });
        if (out.error) return json(res, out.code, { error: out.error });
        const r = out.run;
        if (r.state !== 'up') return json(res, 502, { error: r.lastError ?? `court is ${r.state}`, state: r.state });
        return json(res, 200, { ok: true, matchId: r.matchId, room: r.room, ws: gauntlet.publicWs(r.room), secret: r.secret, mode: r.mode, state: r.state });
      }
      // Updates: anyone may ask; only this machine may apply. The cabinet's
      // button works on http://localhost:<port>/ and nowhere else.
      if (url.pathname === '/update') {
        if (req.method === 'GET') { if (url.searchParams.get('check') === '1') await updater.check(); return json(res, 200, updater.status()); }
        if (req.method === 'POST') {
          if (!isLoopback(req)) return json(res, 403, { error: 'updates are applied from the node\'s own machine only (open http://localhost:' + actualPort + '/)' });
          try {
            const body = await readBody(req).catch(() => ({}));
            if (body?.rollback) { const r = updater.rollback(); json(res, 200, { ok: true, ...r, restarting: true }); restart(); return; }
            await updater.check(); const r = await updater.apply(); json(res, 200, { ok: true, ...r, restarting: true }); restart(); return;
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
      }
      // Restart without admin: a node started elevated outlives `schtasks /End` and an ordinary taskkill, but it can
      // be asked to exit; its launcher (or the task wrapper waiting on the port) brings it back on the current code.
      // A page in the operator's browser also connects from loopback, so a foreign Origin is refused.
      if (req.method === 'POST' && url.pathname === '/restart') {
        const origin = req.headers.origin;
        if (!isLoopback(req) || (origin && !/^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(origin))) return json(res, 403, { error: 'the node is restarted from its own machine only' });
        json(res, 200, { ok: true, restarting: true }); restart('on request (POST /restart)'); return;
      }
      // The bootstrap list as this node last read it from NodeDirectory.
      if (req.method === 'GET' && url.pathname === '/seeds') return json(res, 200, { source: nodeDirectory ? (chainSeeds.length ? 'chain' : 'chain-empty') : 'unset', seeds: chainSeeds });
      // ---- universal login (docs/UNIVERSAL-LOGIN.md): an AIR session token
      // becomes a litVM proxy wallet + PlayerProfile with the AIR id bound.
      if (url.pathname === '/air') return json(res, 200, { enabled: !!proxies, ...(airVerifier ? airVerifier.status() : {}), ...(proxies ? proxies.status() : {}) });
      if (req.method === 'GET' && url.pathname === '/air/resolve') {
        const sub = url.searchParams.get('sub');
        if (!sub) return json(res, 400, { error: 'sub= required' });
        if (!proxies) return json(res, 200, { sub, enabled: false, profile: null });
        try { return json(res, 200, { sub, enabled: true, profile: await proxies.resolve(sub) }); } catch (e) { return json(res, 502, { error: e.message }); }
      }
      if (req.method === 'POST' && (url.pathname === '/air/session' || url.pathname === '/air/revoke')) {
        if (!proxies) return json(res, 404, { error: 'universal login is not enabled on this node (AIR_PARTNER_ID / PlayerProfile)' });
        let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        let who; try { who = await airVerifier.verify(body.token); } catch (e) { return json(res, 401, { error: `air token: ${e.message}` }); }
        const playerKey = typeof body.playerKey === 'string' && /^[0-9a-f]{64}$/i.test(body.playerKey) ? body.playerKey.toLowerCase() : null;
        try {
          if (url.pathname === '/air/revoke') { if (!playerKey) return json(res, 400, { error: 'playerKey required' }); return json(res, 200, await proxies.revoke({ sub: who.sub, playerKey })); }
          const r = await proxies.session({ sub: who.sub, email: who.email, playerKey, name: typeof body.name === 'string' ? body.name : null });
          return json(res, 200, { ...r, email: who.email, airAddress: who.address });
        } catch (e) { log(`air: ${url.pathname} for ${who.sub.slice(0, 8)}…: ${e.message}`); return json(res, 502, { error: e.message }); }
      }
      // ---- publisher and operator actions from the AIR account's proxy
      // (docs/PUBLISHER-BONDS.md §4): the proxy claims the title, adds or
      // revokes a build, hands the title over, or bonds THIS node.
      if (req.method === 'POST' && (url.pathname === '/air/publish' || url.pathname === '/air/bond')) {
        if (!proxies) return json(res, 404, { error: 'universal login is not enabled on this node (AIR_PARTNER_ID / PlayerProfile)' });
        let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        let who; try { who = await airVerifier.verify(body.token); } catch (e) { return json(res, 401, { error: `air token: ${e.message}` }); }
        try {
          if (url.pathname === '/air/bond') { const r = await proxies.bond({ sub: who.sub }); await readMyBond({ force: true }).catch(() => {}); return json(res, 200, r); }
          const action = String(body.action ?? '');
          const rulesetId = typeof body.rulesetId === 'string' && body.rulesetId.length <= 64 ? body.rulesetId : null;
          if (!['register', 'set-build', 'revoke', 'transfer'].includes(action) || !rulesetId) return json(res, 400, { error: 'action (register|set-build|revoke|transfer) and rulesetId required' });
          // The build defaults to the one THIS node serves for the title: a publisher publishes what their host runs.
          const buildHash = typeof body.buildHash === 'string' && /^[0-9a-f]{64}$/i.test(body.buildHash) ? body.buildHash.toLowerCase() : loaded.get(rulesetId)?.buildHash ?? null;
          if (action !== 'transfer' && !buildHash) return json(res, 400, { error: `this node does not host ${rulesetId}; pass buildHash` });
          const r = await proxies.publish({ sub: who.sub, action, rulesetId, buildHash, to: body.to ?? null, activatesAt: Number(body.activatesAt ?? 0) || 0 });
          titleVerdicts.clear(); lastTitleRead = 0; await refreshTitleOwners();
          return json(res, 200, r);
        } catch (e) { log(`air: ${url.pathname} for ${who.sub.slice(0, 8)}…: ${e.message}`); return json(res, 502, { error: e.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/profile') {
        const pid = url.searchParams.get('player');
        if (!pid) return json(res, 400, { error: 'player= required' });
        if (!playerProfile) return json(res, 200, { player: pid, profiles: 'unset', owner: null, tokenId: null, active: null, name: null });
        await refreshProfiles([pid]).catch(() => {});
        const p = profileCache.get(pid);
        if (!p) return json(res, 200, { player: pid, profiles: profileState(), owner: null, tokenId: null, active: null, name: null });
        const name = p.tokenId ? await chain.profileName(p.tokenId) : null;
        return json(res, 200, { player: pid, profiles: profileState(), owner: p.owner, tokenId: p.tokenId ? p.tokenId.toString() : null, active: p.tokenId ? p.active : null, name });
      }
      // Player progression (protocol/progression.js): XP, level, rating, record and streak, folded from results
      // FINAL on chain, so every node answers the same and no publisher database is involved. ?player=<key> for
      // one line, else the ranking (?limit, default 100). ?scope=pending adds settled results not yet final.
      if (req.method === 'GET' && url.pathname === '/progress') {
        const rid = url.searchParams.get('ruleset');
        if (!rid) return json(res, 400, { error: 'ruleset= required' });
        const manifest = loaded.get(rid)?.manifest ?? {};
        const scope = url.searchParams.get('scope') === 'pending' ? 'pending' : 'official';
        // Without MatchBook (a dev mesh): this node's own official results — ranked, placed, verified, the players'.
        const f = mbook ? mbook.progress(rid, manifest, { scope })
          : { ...progression(settlement.list(rid, { scope: 'official' }), manifest), scope, source: 'local', cursor: null, counts: null };
        const head = { rulesetId: rid, scope: f.scope, source: f.source, cursor: f.cursor, counts: f.counts, version: f.version, digest: f.digest, rules: f.rules };
        const player = url.searchParams.get('player');
        if (player) return json(res, 200, { ...head, ...progressOf(f, player.toLowerCase()) });
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
        return json(res, 200, { ...head, players: f.ranking.length, ranking: f.ranking.slice(0, limit) });
      }
      if (req.method === 'GET' && ['/leaderboard', '/credits', '/stats'].includes(url.pathname)) {
        const rid = url.searchParams.get('ruleset');
        if (!rid) return json(res, 400, { error: 'ruleset= required' });
        try {
          const byOwner = url.searchParams.get('by') === 'owner';
          // Official standings by default: ranked, placed, verified. ?scope=all shows everything, labelled.
          const scopeQ = url.searchParams.get('scope');
          const scope = scopeQ === 'all' ? 'all' : scopeQ === 'pending' ? 'pending' : 'official';
          // With MatchBook, official and pending ladders are a fold over the CHAIN's event log (§9) — the same
          // tables on every node and on the cabinet reading RPC alone. `all` stays this node's local view.
          const d = mbook && scope !== 'all' && !byOwner
            ? { rulesetId: rid, by: 'key', ...mbook.ladder(rid, loaded.get(rid)?.manifest ?? {}, { scope }) }
            : settlement.derived(rid, { scope: scope === 'pending' ? 'all' : scope, profiles: byOwner ? profilesFor(settlement.list(rid).flatMap((x) => x.participants)) : null });
          const player = url.searchParams.get('player');
          if (url.pathname === '/leaderboard') return json(res, 200, { rulesetId: rid, scope: d.scope, by: d.by, source: d.source ?? 'local', cursor: d.cursor ?? null, counts: d.counts ?? null, deriveVersion: d.deriveVersion, digest: d.digest, skipped: d.skipped ?? [], leaderboard: d.leaderboard });
          if (url.pathname === '/credits') { const cur = url.searchParams.get('currency'); const table = cur ? d.credits[cur] ?? {} : d.credits; return json(res, 200, player ? { player, currency: cur, balance: table[player] ?? 0 } : table); }
          return json(res, 200, player ? { player, ...(d.stats[player] ?? { matches: 0, wins: 0, ticks: 0 }) } : d.stats);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && /^\/match\/[^/]+\/chain$/.test(url.pathname)) {
        if (!mbook) return json(res, 200, { matchBook: null });
        return json(res, 200, mbook.chainStatus(decodeURIComponent(url.pathname.split('/')[2])));
      }
      if (req.method === 'GET' && url.pathname === '/epoch') {
        const hour = url.searchParams.get('epoch');
        // With MatchBook the hour's tree is over the CHAIN-finalized set — the same root on every node (§11.6); the settler proposes it itself.
        if (mbook) { const { tree, statsTree, ...e } = mbook.epoch(hour ? Number(hour) : undefined); return json(res, 200, { ...e, proposeCalldata: proposeCalldata(e.epoch, e.root, nodeId), anchor: { contract: 'EpochAnchor v3', method: 'propose(uint64,bytes32,bytes32)', note: 'finalizes on chain when nodes holding quorumBps of the active bonded stake propose the same root' } }); }
        const { tree, statsTree, ...e } = settlement.epoch(hour ? Number(hour) : undefined);
        return json(res, 200, { ...e, source: 'local', anchor: { contract: 'EpochAnchor v3', method: 'propose(uint64,bytes32,bytes32)', note: 'a local tree: MatchBook is not configured, so this root is this node\'s own view' } });
      }
      // Settlement v4: a player's season stats for one title through an hour, with the Merkle path to that hour's root.
      // scope=chain (default with MatchBook): the anchored root over FINAL matches; scope=local: this node's own results
      // of every level above `host` (attested and checkable titles live here until their roots are anchored).
      if (req.method === 'GET' && url.pathname === '/proof/stats') {
        const rid = url.searchParams.get('ruleset'), player = url.searchParams.get('player');
        if (!rid || !player) return json(res, 400, { error: 'ruleset and player are required' });
        const hour = url.searchParams.get('epoch') != null ? Number(url.searchParams.get('epoch')) : undefined;
        const scope = url.searchParams.get('scope') ?? (mbook ? 'chain' : 'local');
        const p = scope === 'chain' && mbook ? mbook.statsProof(rid, player, hour) : settlement.statsProof(rid, player, hour);
        return p ? json(res, 200, { ...p, anchor: { contract: 'EpochAnchor', method: 'verifyInclusion(uint64,bytes32,bytes32[],bool[])' } }) : json(res, 404, { error: 'no stats for that player and title through that hour' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/proof/')) {
        const p = (mbook ? mbook.proof(decodeURIComponent(url.pathname.slice(7))) : null) ?? settlement.proof(decodeURIComponent(url.pathname.slice(7)));
        return p ? json(res, 200, p) : json(res, 404, { error: 'unknown match' });
      }
      // The cabinet's own files (app.js, style.css, sw.js, covers/…) resolve
      // relative to /, after every API route above has had its chance.
      if (req.method === 'GET' && serveStatic(res, `cabinet/${url.pathname}`)) return;
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  // A taken port rejects (err.code EADDRINUSE, err.port) instead of throwing
  // an unhandled 'error' event; node/cli.mjs names who holds it.
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, () => { server.off('error', rej); res(); }); });
  const actualPort = server.address().port;
  addr ??= `http://${host}:${actualPort}`;
  lanAddr = addr;
  if (runsGateway) {
    if (serviceBundles.length) publisherServices = createPublisherServices({ bundles: serviceBundles, nodeUrl: `http://127.0.0.1:${actualPort}`, publicBase: () => wsAddr, log, emit, secretsPolicy });
    const upstream = gauntletUpstream ?? (gauntletPort != null && relayPort && gauntletPort !== relayPort ? `ws://127.0.0.1:${relayPort}` : null);
    gauntlet = createGauntlets({ configs: gauntlets, port: gauntletPort ?? relayPort ?? 0, upstream, nodeUrl: `http://127.0.0.1:${actualPort}`, wsAddr: () => wsAddr, nodeId, log, emit, services: publisherServices, secretsPolicy,
      logs: gauntletLogs.dir === null ? null : { dir: gauntletLogs.dir ?? join(dataDir, 'gauntlet-logs'), maxBytes: gauntletLogs.maxBytes, keep: gauntletLogs.keep } });
    await gauntlet.listen();
    if (publisherServices) await publisherServices.start({ gatewayPort: gauntlet.port });
    if (!relayPort && gauntletPort == null) log('gauntlet gateway has no RELAY_PORT or GAUNTLET_GATEWAY_PORT: reachable on this machine only');
  }
  if (upnp) {
    const ports = [{ external: actualPort, internal: actualPort, label: 'node' }];
    if (relayFront) ports.push({ external: relayFront, internal: relayFront, label: 'relay' });
    upnpCtl = keepMapped(ports, { log, gateway: upnpGateway });
    upnpCtl.ready.then(() => { const s = upnpCtl.status(); emit('upnp', s); if (s.mapped.length && !tunnel && s.publicIp && !s.cgnat) { addr = `http://${s.publicIp}:${actualPort}`; log(`advertising ${addr} (UPnP)`); } });
  }
  // The node's own tunnel: when it comes up, its URL becomes the address we
  // advertise; when it drops, we fall back to the LAN address. A relay tunnel
  // does the same for wsAddr. Peers learn both from the next heartbeat.
  let tunnelWatch = null; // the advertised URL's outside check (below); stop() clears it
  try {
    if (tunnel) {
      // A quick tunnel's hostname exists before Cloudflare's DNS has published it. Advertised at once, it is
      // looked up at once — by peers reading NodeDirectory and by this very machine — and a resolver that got
      // NXDOMAIN caches that for minutes: the desktop announced a name nobody could resolve while its own
      // relay tunnel, looked up a moment later, was fine (22 Sep 2026). So a new URL is advertised and
      // announced only once THIS node has reached itself through it (a /whoami round trip), and a name that
      // never becomes reachable is rotated for a fresh one rather than kept.
      // The name is looked up through Cloudflare's DoH (node/dns.js), so a probe before the record exists fails
      // cleanly instead of poisoning this machine's resolver for the zone's 30-minute negative TTL — the desktop
      // rotated seven names in a row and had no public URL for 38 minutes that way (21 Sep 2026).
      const VERIFY_EVERY_MS = tunnelProbe ? 200 : 5000, VERIFY_GIVE_UP_MS = tunnelProbe ? 3000 : 5 * 60_000;
      const probe = tunnelProbe ?? (async (u) => { const nonce = newNonce(); const r = await fetch(`${u}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(8000) }); const c = await checkChallenge(await r.json(), { expectNodeId: nodeId, nonce }); if (!c.ok) throw new Error(c.reason ?? 'challenge failed'); return true; });
      let verifying = null;
      // Once advertised, the URL is checked from outside every TUNNEL_WATCH_MS, as the relay's is: cloudflared can
      // keep running while its tunnel is gone (Cloudflare answers 530, and a quick tunnel's name stops resolving),
      // and nothing else notices — m16 advertised a dead name for over half an hour on 7 Oct 2026. TUNNEL_FAILS
      // misses in a row stop advertising it and restart cloudflared; a quick tunnel comes back on a new name,
      // verified and announced as a new one is.
      const TUNNEL_WATCH_MS = tunnelProbe ? 300 : 60_000, TUNNEL_FAILS = 3;
      const watchTunnel = (u) => {
        clearInterval(tunnelWatch?.timer);
        let fails = 0, busy = false;
        tunnelWatch = { url: u, timer: setInterval(async () => {
          if (busy) return;
          if (tunnels.node?.url !== u || addr !== u) { clearInterval(tunnelWatch?.timer); tunnelWatch = null; return; } // rotated or dropped meanwhile
          busy = true;
          let ok = false, why = null;
          try { ok = !!(await probe(u)); } catch (e) { why = e.cause?.code ?? e.message; }
          busy = false;
          if (ok) { fails = 0; return; }
          if (++fails < TUNNEL_FAILS) return;
          clearInterval(tunnelWatch?.timer); tunnelWatch = null;
          log(`tunnel: ${u} stopped answering from outside (${why ?? 'no answer'}; ${fails} checks in a row) — restarting cloudflared`);
          addr = lanAddr; emit('tunnel', { which: 'node', url: u, state: 'lost' });
          tunnels.node?.rotate();
        }, TUNNEL_WATCH_MS) };
      };
      const verifyTunnel = (u) => {
        if (verifying) { clearInterval(verifying.timer); verifying = null; }
        clearInterval(tunnelWatch?.timer); tunnelWatch = null;
        if (!u) { addr = lanAddr; emit('tunnel', { which: 'node', url: null }); return; }
        const started = Date.now();
        emit('tunnel', { which: 'node', url: u, state: 'verifying' });
        const attempt = async () => {
          if (tunnels.node?.url !== u) { clearInterval(verifying?.timer); verifying = null; return; } // rotated meanwhile
          try {
            if (!(await probe(u))) throw new Error('not reachable yet');
            clearInterval(verifying.timer); verifying = null;
            addr = u; log(`tunnel: ${u} reachable from outside — advertising and announcing`); emit('tunnel', { which: 'node', url: u, state: 'up' }); announceNow();
            watchTunnel(u);
          } catch (e) {
            if (Date.now() - started > VERIFY_GIVE_UP_MS) { clearInterval(verifying.timer); verifying = null; log(`tunnel: ${u} never became reachable (${e.cause?.code ?? e.message}) — rotating the hostname`); emit('tunnel', { which: 'node', url: u, state: 'unreachable' }); tunnels.node?.rotate(); }
          }
        };
        verifying = { url: u, timer: setInterval(attempt, VERIFY_EVERY_MS) };
        void attempt();
      };
      tunnels.node = createTunnel({ port: actualPort, name: tunnel === 'named' ? tunnelName : null, hostname: tunnel === 'named' ? tunnelHost : null, log, bin: tunnelBin, onUrl: verifyTunnel });
    }
    if (ro3Port) {
      tunnels.ro3 = createRo3Host({ port: ro3Port, name: ro3Name(ro3NameIn) || ro3Name(operator) || nodeId.slice(0, 12), bin: tunnelBin, log, emit,
        probe: ro3Probe, fast: !!ro3Probe, onChange: (e) => { ro3 = e; } }); // the next heartbeat carries it
    }
    if (relayFront && !wsAddrIn) {
      tunnels.relay = createTunnel({ port: relayFront, name: relayTunnelName, hostname: relayTunnelHost, log, bin: tunnelBin,
        onUrl: relayUrl });
    }
  } catch (e) {
    // A misconfigured tunnel must not leave a half-started node listening.
    tunnels.node?.stop(); tunnels.ro3?.stop();
    await new Promise((r) => server.close(r));
    throw e;
  }
  if (air && playerProfile && !offline) {
    // The sponsor is the announcer key (<dataDir>/announcer.json): one key the
    // operator already funds. Created here when there is no directory to announce to.
    const sponsorPath = join(dataDir, 'announcer.json');
    if (!existsSync(sponsorPath)) writeFileSync(sponsorPath, JSON.stringify({ privateKey: randomPrivateKey() }, null, 2) + '\n');
    const sponsorKey = JSON.parse(readFileSync(sponsorPath, 'utf8'));
    airVerifier = createAirVerifier({ jwksUrl: air.jwksUrl, partnerId: air.partnerId ?? null, fetchImpl: chainFetch });
    proxies = createProxyWallets({ dataDir, chainId: chainId ?? 4441, rpc: chain.rpc, playerProfile, sponsor: { privateKey: sponsorKey.privateKey, address: addressOf(sponsorKey.privateKey) }, titleRegistry, nodeStake, stakeToken, nodeId, log, emit });
    log(`air: universal login on · partner ${air.partnerId ?? 'any'} · sponsor ${addressOf(sponsorKey.privateKey)}`);
  }
  if (nodeDirectory && !offline) {
    announcer = createAnnouncer({ dataDir, nodeId, contract: nodeDirectory, chainId: chainId ?? 4441, rpc: chain.rpc, log, emit });
    await readDirectory().catch((e) => log(`directory: ${e.message}`));
    log(`directory: ${chainSeeds.length} live seed(s) on chain · announcer ${announcer.address}`);
    directoryTimer = setInterval(() => { readDirectory().catch(() => {}); announceNow(); }, 10 * 60_000);
    // Announce what we have now (the LAN address if no tunnel); a tunnel
    // coming up announces again. Both are no-ops when nothing changed.
    if (!tunnel) setTimeout(announceNow, 3_000);
  }
  timer = setInterval(tick, heartbeatMs);
  await tick(); await chainRun; // the first tick's chain half too: callers read stakes and the head right after start
  if (updates && version) { firstUpdateTimer = setTimeout(() => checkUpdates().catch(() => {}), 5_000); updateTimer = setInterval(() => checkUpdates().catch(() => {}), 60 * 60_000); }
  log(`litnode ${nodeId.slice(0, 12)} on ${addr} roles=${roles.join(',')} rulesets=${[...loaded.keys()].join(',') || '-'}`);

  return {
    nodeId, addr, port: actualPort, identity,
    snapshot: currentSnapshot, matches: matchesNow, installRuleset, installServer, servers: serverStatus, chain, settlement, matchBook: mbook,
    rulesets: () => buildHashes(), peers: () => heartbeats, inbound, operator, roles, region, startedAt, chat: chatLines,
    version, updater, restart, tunnels, upnp: upnpCtl, get wsAddr() { return wsAddr; }, get announcer() { return announcer; }, seeds: () => chainSeeds, seedChecks, admitSeed, sandbox, refused, incompatible, protocol: PROTOCOL_VERSION, peersKnown,
    get gauntlet() { return gauntlet; },
    async stop() { clearInterval(stallTimer); clearInterval(timer); clearInterval(tunnelWatch?.timer); clearInterval(updateTimer); clearTimeout(firstUpdateTimer); clearInterval(directoryTimer); clearTimeout(announceRetry); clearInterval(relayTimer); await publisherServices?.stop(); await gauntlet?.stopAll(); tunnels.node?.stop(); tunnels.relay?.stop(); tunnels.ro3?.stop(); await upnpCtl?.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}
