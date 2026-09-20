/** litnode — the daemon anyone runs. BUILD-SPEC v0.2 §1.
 *
 *  This slice: identity on disk, signed heartbeat gossip, bonded snapshot,
 *  ruleset fetch-by-hash, signed queue intake, deterministic pairing and
 *  placement served over HTTP. Settlement (ledger intake, witness replay,
 *  epoch tree) is the next slice and is NOT here yet.
 *
 *  Dependency-free: node:http + fetch. One process = one node. */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { h } from '../protocol/canonical.js';
import { generateKeypair, seal, opened, verify } from '../protocol/keys.js';
import { snapshot as buildSnapshot, verifyHeartbeats, HEARTBEAT_TAG, epochOf, EPOCH_MS } from '../protocol/snapshot.js';
import { applyStakes } from '../protocol/staking.js';
import { pair, QUEUE_TAG, bucketOf } from '../protocol/pairing.js';
import { placement } from '../protocol/placement.js';
import { createChain } from './chain.js';
import { createSettlement } from './settle.js';
import { createUpdater, RESTART_EXIT } from './update.js';
import { createTunnel } from './tunnel.js';
import { keepMapped } from './upnp.js';
import { createAnnouncer } from './announce.js';
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
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { answerChallenge, checkChallenge, newNonce, NONCE_RE } from '../protocol/challenge.js';
import { descriptorHash as descriptorHashOf } from './settle.js';

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
    res.end(JSON.stringify(body));
  } catch { try { res.destroy(); } catch { /* gone */ } }
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 4e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

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
  // UPnP: ask the router to forward our port (and the relay's) — what a
  // torrent client does. Reports CGNAT when the ISP makes it pointless.
  upnp = false, upnpGateway = null,
  // NodeDirectory: read the live seed list from the chain (bootstrap) and,
  // with a delegated announcer key, publish our own addresses there.
  nodeDirectory = null, chainId = null, announce = true,
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
  // Relay keys whose signed submissions this host accepts as 'relay' provenance.
  relayKeys = [],
  heartbeatMs = EPOCH_MS / 2, log = () => {}, onEvent = () => {},
}) {
  // Every observable thing the node does goes through emit(): the TUI draws
  // from it, a log file gets a line per event, tests can subscribe. Never
  // throws into the caller.
  const emit = (type, data = {}) => { try { onEvent({ t: Date.now(), type, ...data }); } catch { /* observer's problem */ } };
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'rulesets'), { recursive: true });
  const startedAt = Date.now(); // /health reports it so a dashboard can show process uptime
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  version ??= (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch { return null; } })();

  // ---------------------------------------------------------------- updates
  // A release is an artifact like a ruleset, plus a signature (node/update.js).
  // Checked hourly; applied only on request, and only from this machine.
  const updater = createUpdater({ root, version: version ?? '0.0.0', releaseUrl, channel: releaseChannel, dataDir, log });
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
  const isLoopback = (req) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress ?? '');
  const restart = () => { log('restarting to run the new build'); emit('restart', {}); setTimeout(() => { if (onRestart) onRestart(); else process.exit(RESTART_EXIT); }, 300); };

  // ---------------------------------------------------------------- identity
  const idPath = join(dataDir, 'identity.json');
  const identity = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : await generateKeypair();
  if (!existsSync(idPath)) writeFileSync(idPath, JSON.stringify(identity, null, 2) + '\n');
  const nodeId = identity.publicKey;

  const chain = createChain({ rpc: rpc ?? 'offline', offline, nodeStake, playerProfile, nodeDirectory, erc6699, fetchImpl: chainFetch });
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
    const trusted = origin === 'local' || titleTrust === 'open' || (await buildAttested(manifest.rulesetId, actual, attestation));
    if (!trusted) { emit('ruleset-refused', { buildHash: actual, stage: 'trust', failed: ['no attestation from a trusted publisher'] }); throw new Error(`ruleset ${manifest.rulesetId} @ ${actual.slice(0, 12)} refused: not signed by a trusted publisher (TITLE_TRUST=trusted)`); }
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

  const registry = erc6699 && !offline ? {
    configured: true,
    readAgent: (tokenId, block) => chain.agentAt(tokenId, block),
    profile: async (playerKey) => { await refreshProfiles([playerKey]).catch(() => {}); return profileCache.get(playerKey) ?? null; },
  } : null;
  const settlement = createSettlement({
    dataDir, nodeId, identity, loaded, builds, sandbox, log, registry, courts, relayKeys,
    descriptorFor: (matchId) => { const e = matchBook.get(matchId); return e ? { descriptor: e.descriptor, envelope: e.envelope } : null; },
    verifyDescriptor: async (env) => {
      const d = env?.body;
      if (!d?.matchId || d.computedBy !== env.signer || !(await opened(MATCH_TAG, env))) return null;
      if (stakes && !stakes[d.computedBy]?.active) return null;
      return d;
    },
    hostRelayKeys: (hostId) => heartbeats.get(hostId)?.relayKeys ?? [],
  });
  const canSettle = roles.some((r) => ['host', 'settler', 'relay'].includes(r));
  const isWitness = roles.includes('witness');
  const witnessed = new Set(); // matchIds this node already answered

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
  let stakes = null;            // nodeId → standing, when nodeStake configured
  let wsAddr = wsAddrIn;        // the relay this node fronts; a relay tunnel sets it live
  let lanAddr = null;           // what we listen on, kept for /health when a tunnel replaces addr
  const tunnels = { node: null, relay: null };
  let upnpCtl = null;
  // ---------------------------------------------------------------- directory
  let chainSeeds = [];          // liveSeeds() from NodeDirectory, refreshed every 10 min, or at once when lonely
  let lastDirectoryRead = 0;
  let announcer = null;
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
  let addr = publicAddr;

  const myHeartbeat = () => seal(HEARTBEAT_TAG, {
    nodeId, operator, roles, region, addr, wsAddr, standing: 0, version, protocol: PROTOCOL_VERSION, relayKeys,
    buildHashes: buildHashes(), manifests: manifests(), epoch: epochOf(Date.now()),
  }, identity);

  // Peers on another protocol version are heard and listed, never placed,
  // never witnesses: old and new rules must not meet inside one match.
  const incompatible = new Map(); // nodeId → { version, protocol, at }
  const mergeHeartbeats = async (envelopes) => {
    for (const b of await verifyHeartbeats(envelopes ?? [])) {
      if (b.nodeId !== nodeId && (b.protocol ?? 1) !== PROTOCOL_VERSION) {
        if (!incompatible.has(b.nodeId)) { log(`peer ${b.nodeId.slice(0, 12)} speaks protocol ${b.protocol ?? 1} (${b.version ?? '?'}), ours is ${PROTOCOL_VERSION}: excluded`); emit('incompatible', { nodeId: b.nodeId, protocol: b.protocol ?? 1, version: b.version ?? null }); }
        incompatible.set(b.nodeId, { version: b.version ?? null, protocol: b.protocol ?? 1, at: Date.now() });
        heartbeats.delete(b.nodeId);
        continue;
      }
      incompatible.delete(b.nodeId);
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
      if (queue.has(k) || !(await opened(QUEUE_TAG, env))) continue;
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

  // ---------------------------------------------------------------- hydration by hash
  const hydrateMissing = async (s) => {
    for (const [rid, m] of Object.entries(s.manifests)) {
      if (loaded.get(rid)?.buildHash === m.buildHash) continue;
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
  let timer = null, updateTimer = null, directoryTimer = null;
  const tick = async () => {
    try {
      await mergeHeartbeats([await myHeartbeat()]);
      const payload = { heartbeats: [], queue: [] };
      for (const b of heartbeats.values()) if (b.nodeId === nodeId) payload.heartbeats.push(await myHeartbeat());
      // Forward what we know: our own sealed heartbeat plus cached envelopes we received.
      payload.heartbeats.push(...envelopeCache.values());
      payload.queue.push(...queueEnvelopes.values());
      // Advertise what we settled so witnesses can come and check it, and the
      // placements we froze so peers converge on them.
      payload.deltas = settlement.list().map((d) => ({ matchId: d.matchId, rulesetId: d.rulesetId, buildHash: d.buildHash, hostId: d.hostId, addr, cosigners: d.cosigners }));
      matchesNow();
      payload.matches = matchEnvelopes();
      const body = JSON.stringify(payload);
      const targets = [...peersKnown].filter((p) => p !== addr);
      if (targets.length) emit('gossip.out', { peers: targets.length, bytes: body.length, heartbeats: payload.heartbeats.length, queue: payload.queue.length, deltas: payload.deltas.length, matches: payload.matches.length });
      for (const peer of targets) {
        fetch(`${peer}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          .then(async (r) => { if (r.ok) { const text = await r.text(); const m = JSON.parse(text); await absorb(m, { from: peer, bytes: text.length, via: 'reply' }); } })
          .catch(() => {});
      }
      // Lonely with a directory configured: every fresh peer is gone (a seed
      // restarted on a new tunnel hostname, say). Re-read NodeDirectory now
      // rather than on the 10-minute cycle — the desktop's restart left its
      // peers blind for up to ten minutes once. Rate-limited to one read a
      // minute so a genuinely empty mesh does not hammer the RPC.
      if (nodeDirectory && !offline && Date.now() - lastDirectoryRead > 60_000) {
        const fresh = currentSnapshot().peers.filter((p) => p.nodeId !== nodeId).length;
        if (fresh === 0) { lastDirectoryRead = Date.now(); log('no fresh peers — re-reading NodeDirectory'); readDirectory().catch(() => {}); }
      }
      const head = chain.status().head;
      const b = await chain.pollBlock();
      if (b && b.number !== head) emit('block', { number: b.number, hash: b.hash });
      if (nodeStake && !offline) {
        const ids = [...heartbeats.keys()];
        const st = await chain.standings(ids);
        // Merge, never replace: one transient RPC failure for one key must
        // not drop that peer from the bonded set for a tick (it changed a
        // live placement once). Keys we no longer hear from are pruned.
        if (st) {
          const next = { ...(stakes ?? {}), ...st };
          for (const k of Object.keys(next)) if (!heartbeats.has(k)) delete next[k];
          stakes = next;
          const bondedNow = Object.keys(next).filter((k) => next[k].active).sort().join(',');
          if (bondedNow !== lastBonded) { lastBonded = bondedNow; emit('stakes', { read: Object.keys(st).length, bonded: bondedNow ? bondedNow.split(',').length : 0 }); }
        }
      }
      await hydrateMissing(currentSnapshot());
      await refreshProfiles([...queue.values()].map((b) => b.playerId).concat(settlement.list().flatMap((d) => d.participants)));
      settlement.maybeFreeze();
    } catch (e) { log(`tick: ${e.message}`); }
  };
  const envelopeCache = new Map(); // nodeId → latest envelope (for forwarding)
  const queueEnvelopes = new Map();
  const absorb = async (msg, meta = null) => {
    if (meta) {
      const sig = msg.heartbeats?.find((e) => e?.body?.nodeId !== nodeId)?.sig ?? null;
      emit('gossip.in', { from: meta.from, via: meta.via, bytes: meta.bytes, heartbeats: msg.heartbeats?.length ?? 0, queue: msg.queue?.length ?? 0, deltas: msg.deltas?.length ?? 0, matches: msg.matches?.length ?? 0, sig });
    }
    for (const env of msg.heartbeats ?? []) if (env?.body?.nodeId && env.body.nodeId !== nodeId) {
      const cur = envelopeCache.get(env.body.nodeId);
      if (!cur || env.body.epoch >= cur.body.epoch) envelopeCache.set(env.body.nodeId, env);
    }
    for (const env of msg.queue ?? []) if (env?.body) queueEnvelopes.set(`${env.body.bucket}|${env.body.playerId}`, env);
    await mergeHeartbeats(msg.heartbeats);
    await mergeQueue(msg.queue);
    for (const env of msg.matches ?? []) await absorbMatch(env);
    if (isWitness) for (const ad of msg.deltas ?? []) void witnessOne(ad);
  };

  /** Witness role: fetch the ledger and the delta, replay independently,
   *  send back a signature only over the root we reached ourselves. */
  const witnessOne = async (ad) => {
    if (!ad?.matchId || ad.hostId === nodeId || witnessed.has(ad.matchId) || ad.cosigners?.includes(nodeId)) return;
    const hostHb = heartbeats.get(ad.hostId);
    if (hostHb && hostHb.operator === operator && !stakes) { witnessed.add(ad.matchId); return; } // same operator (dev mesh)
    if (stakes && stakes[ad.hostId]?.operator && stakes[nodeId]?.operator === stakes[ad.hostId].operator) { witnessed.add(ad.matchId); return; }
    if (!loaded.has(ad.rulesetId)) return; // hydrate first, retry on a later gossip
    witnessed.add(ad.matchId);
    try {
      // Replay in the build the delta names. If we do not hold it, fetch it
      // by hash from the host and hold it without making it current.
      if (ad.buildHash && !builds.has(ad.buildHash)) {
        const r = await fetch(`${ad.addr}/ruleset/${encodeURIComponent(ad.rulesetId)}?build=${ad.buildHash}`);
        if (!r.ok) throw new Error(`host does not serve build ${ad.buildHash.slice(0, 12)}`);
        const att = r.headers.get('x-build-publisher') ? { publisher: r.headers.get('x-build-publisher'), sig: r.headers.get('x-build-sig') } : null;
        await installRuleset(await r.text(), ad.buildHash, { current: false, origin: 'peer', attestation: att });
      }
      const [delta, ledger] = await Promise.all([
        fetch(`${ad.addr}/delta/${encodeURIComponent(ad.matchId)}`).then((r) => r.json()),
        fetch(`${ad.addr}/ledger/${encodeURIComponent(ad.matchId)}`).then((r) => r.json()),
      ]);
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
  const matchTtlMs = 15 * 60_000;
  const describe = (m, s) => {
    const manifest = s.manifests[m.rulesetId];
    const place = manifest ? placement({ nodes: s.peers, manifest, rulesetId: m.rulesetId, matchId: m.matchId, beacon: m.beacon, regions: m.regions }) : null;
    const bc = chain.beaconFor(m.bucket);
    return { ...m, protocol: PROTOCOL_VERSION, buildHash: manifest?.buildHash ?? null, beaconSource: bc?.source, beaconBlock: bc?.block ?? null, snapshotRoot: s.root, snapshotEpoch: s.epoch, computedBy: nodeId, computedAt: Date.now(),
      host: place?.host?.nodeId ?? null, witness: place?.witness?.nodeId ?? null, order: place?.order.map((n) => n.nodeId) ?? [] };
  };
  const matchesNow = () => {
    const s = currentSnapshot();
    const now = Date.now();
    for (const [id, e] of matchBook) if (now - e.descriptor.computedAt > matchTtlMs) matchBook.delete(id);
    const pairs = pair([...queue.values()], now, (b) => chain.beaconFor(b)?.beacon ?? null);
    for (const m of pairs) {
      if (matchBook.has(m.matchId)) continue;
      const d = describe(m, s);
      if (!d.host) continue; // nobody eligible yet; try again next call
      matchBook.set(m.matchId, { descriptor: d, envelope: null, disputes: [] });
      emit('placed', { matchId: m.matchId, rulesetId: m.rulesetId, host: d.host, witness: d.witness, beacon: d.beaconSource, snapshotRoot: d.snapshotRoot, participants: m.participants });
      seal(MATCH_TAG, d, identity).then((env) => { const e = matchBook.get(m.matchId); if (e) e.envelope = env; }).catch(() => {});
    }
    return [...matchBook.values()].map((e) => ({ ...e.descriptor, disputes: e.disputes }));
  };
  /** Adopt or dispute a peer's descriptor. */
  const absorbMatch = async (env) => {
    const d = env?.body;
    if (!d?.matchId || !d.host || d.computedBy !== env.signer || !(await opened(MATCH_TAG, env))) return;
    if ((d.protocol ?? 1) !== PROTOCOL_VERSION) return; // another protocol's placement is not ours to adopt
    if (stakes && !stakes[d.computedBy]?.active) return; // only bonded peers' descriptors count
    const mine = matchBook.get(d.matchId);
    if (!mine) { matchBook.set(d.matchId, { descriptor: { ...d, disputes: undefined }, envelope: env, disputes: [] }); return; }
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
        return json(res, 200, { nodeId, operator, roles, region, addr, protocol: PROTOCOL_VERSION, epoch: s.epoch, peers: s.peers.length, incompatible: incompatible.size, rulesets: buildHashes(), buildsHeld: builds.size, refused: refused.size, staking: s.staking, bonded: stakes?.[nodeId]?.active ?? null, chain: chain.status(), profiles: profileState(), version, repair: sdkMissing, update: updater.status(),
          sandbox: sandbox.status(), trust: { policy: titleTrust, publishers: trustedPublishers, relayKeys, courts: Object.keys(courts) }, registry: registry ? 'chain' : erc6699 ? 'offline' : 'unset',
          wsAddr, lanAddr, tunnel: { node: tunnels.node?.status() ?? null, relay: tunnels.relay?.status() ?? null }, upnp: upnpCtl?.status() ?? null,
          directory: nodeDirectory ? { contract: nodeDirectory, seeds: chainSeeds.length, announcer: announcer?.status() ?? null } : null, startedAt: new Date(startedAt).toISOString(), uptimeMs: Date.now() - startedAt,
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
      if (req.method === 'GET' && url.pathname === '/titles') {
        const now = epochOf(Date.now());
        const titles = new Map();
        const take = (m, host) => {
          const t = titles.get(m.rulesetId) ?? { rulesetId: m.rulesetId, kind: m.kind, buildHash: m.buildHash, publisher: m.publisher ?? null, display: m.display ?? null, modes: m.modes, participants: m.participants, services: m.services, hosts: [], bondedHosts: 0 };
          if (!t.hosts.includes(host)) { t.hosts.push(host); if (stakes?.[host]?.active) t.bondedHosts++; }
          titles.set(m.rulesetId, t);
        };
        for (const m of Object.values(manifests())) take(m, nodeId);
        for (const b of heartbeats.values()) if (b.nodeId !== nodeId && b.epoch >= now - 2) for (const m of Object.values(b.manifests ?? {})) take(m, b.nodeId);
        return json(res, 200, { titles: [...titles.values()] });
      }
      // Everyone we have heard from, bonded or not — for onboarding a new
      // machine (its full nodeId is what the bond tool needs). /snapshot is
      // the bonded set only.
      if (req.method === 'GET' && url.pathname === '/peers') {
        const now = Date.now();
        return json(res, 200, { peers: [...heartbeats.values()].map((b) => ({
          nodeId: b.nodeId, operator: b.operator, addr: b.addr, region: b.region, roles: b.roles,
          fresh: b.epoch >= epochOf(now) - 2, bonded: stakes ? !!stakes[b.nodeId]?.active : null,
          // Their clock minus ours, in seconds, at their last heartbeat. A peer
          // more than ~4 s behind never reads as fresh: that is clock skew,
          // not a dead node (BUILD-SPEC §16).
          clockSkewS: +(((b.epoch - epochOf(now)) * EPOCH_MS) / 1000).toFixed(1),
          rulesets: Object.keys(b.buildHashes ?? {}), version: b.version ?? null, protocol: b.protocol ?? 1,
        })), incompatible: [...incompatible].map(([id, x]) => ({ nodeId: id, ...x })) });
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
        const text = await new Promise((resolve, reject) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 4e6) reject(new Error('body too large')); }); req.on('end', () => resolve(b)); req.on('error', reject); });
        const from = req.socket.remoteAddress ?? '?';
        inbound.set(from, Date.now());
        await absorb(text ? JSON.parse(text) : {}, { from, bytes: text.length, via: 'push' });
        // Answer with everything we push, deltas included: a peer that can
        // reach us while we cannot reach it (NAT, a second subnet) must still
        // learn what we settled, or it can never witness it.
        return json(res, 200, {
          heartbeats: [await myHeartbeat(), ...envelopeCache.values()],
          queue: [...queueEnvelopes.values()],
          deltas: settlement.list().map((d) => ({ matchId: d.matchId, rulesetId: d.rulesetId, buildHash: d.buildHash, hostId: d.hostId, addr, cosigners: d.cosigners })),
          matches: matchEnvelopes(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/queue') {
        const env = await readBody(req);
        const b = env?.body;
        if (!b || b.playerId !== env.signer) return json(res, 400, { error: 'queue entry must be signed by the player it names' });
        if (!(await opened(QUEUE_TAG, env))) return json(res, 403, { error: 'bad signature' });
        if (Math.abs(b.bucket - bucketOf(Date.now())) > 2) return json(res, 400, { error: 'bucket out of window' });
        // A key its profile owner revoked is refused; an unbound key is a guest and fine.
        await refreshProfiles([b.playerId]).catch(() => {});
        const prof = profileCache.get(b.playerId);
        if (prof && prof.tokenId !== 0n && !prof.active) { emit('refused', { what: 'queue', reason: 'key revoked', playerId: b.playerId }); return json(res, 403, { error: 'key revoked by its profile owner' }); }
        queueEnvelopes.set(`${b.bucket}|${b.playerId}`, env);
        await mergeQueue([env]);
        emit('queue', { playerId: b.playerId, rulesetId: b.rulesetId, mode: b.mode, bucket: b.bucket, region: b.region ?? null, sig: env.sig });
        return json(res, 202, { ok: true, bucket: b.bucket });
      }
      if (req.method === 'GET' && url.pathname === '/match') {
        const pid = url.searchParams.get('playerId');
        const all = matchesNow();
        return json(res, 200, { matches: pid ? all.filter((m) => m.participants.includes(pid)) : all });
      }
      // ---------------------------------------------------------- settlement
      if (req.method === 'POST' && url.pathname === '/ledger') {
        if (!canSettle) return json(res, 403, { error: 'this node has no settling role' });
        try {
          const d = await settlement.intake(await readBody(req));
          emit('settled', { matchId: d.matchId, rulesetId: d.rulesetId, ticks: d.ticks, root: d.finalStateRoot, attestation: d.attestation, hostSig: d.hostSig, participants: d.participants });
          return json(res, 200, d);
        } catch (e) { emit('refused', { what: 'ledger', reason: e.message }); return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/ledger/')) {
        const l = settlement.ledger(decodeURIComponent(url.pathname.slice(8)));
        return l ? json(res, 200, l) : json(res, 404, { error: 'unknown match' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/delta/')) {
        const d = settlement.delta(decodeURIComponent(url.pathname.slice(7)));
        return d ? json(res, 200, d) : json(res, 404, { error: 'unknown match' });
      }
      if (req.method === 'GET' && url.pathname === '/deltas') return json(res, 200, { deltas: settlement.list(url.searchParams.get('ruleset') ?? undefined, { scope: url.searchParams.get('scope') === 'official' ? 'official' : 'all' }) });
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
      // The bootstrap list as this node last read it from NodeDirectory.
      if (req.method === 'GET' && url.pathname === '/seeds') return json(res, 200, { source: nodeDirectory ? (chainSeeds.length ? 'chain' : 'chain-empty') : 'unset', seeds: chainSeeds });
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
      if (req.method === 'GET' && ['/leaderboard', '/credits', '/stats'].includes(url.pathname)) {
        const rid = url.searchParams.get('ruleset');
        if (!rid) return json(res, 400, { error: 'ruleset= required' });
        try {
          const byOwner = url.searchParams.get('by') === 'owner';
          // Official standings by default: ranked, placed, verified. ?scope=all shows everything, labelled.
          const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'official';
          const d = settlement.derived(rid, { scope, profiles: byOwner ? profilesFor(settlement.list(rid).flatMap((x) => x.participants)) : null });
          const player = url.searchParams.get('player');
          if (url.pathname === '/leaderboard') return json(res, 200, { rulesetId: rid, scope: d.scope, by: d.by, deriveVersion: d.deriveVersion, digest: d.digest, skipped: d.skipped, leaderboard: d.leaderboard });
          if (url.pathname === '/credits') { const cur = url.searchParams.get('currency'); const table = cur ? d.credits[cur] ?? {} : d.credits; return json(res, 200, player ? { player, currency: cur, balance: table[player] ?? 0 } : table); }
          return json(res, 200, player ? { player, ...(d.stats[player] ?? { matches: 0, wins: 0, ticks: 0 }) } : d.stats);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/epoch') {
        const hour = url.searchParams.get('epoch');
        const { tree, ...e } = settlement.epoch(hour ? Number(hour) : undefined);
        return json(res, 200, { ...e, anchor: { contract: 'EpochAnchor v2', method: 'propose(uint64,bytes32,bytes32)', note: 'finalizes on chain when `quorum` bonded operators propose the same root' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/proof/')) {
        const p = settlement.proof(decodeURIComponent(url.pathname.slice(7)));
        return p ? json(res, 200, p) : json(res, 404, { error: 'unknown match' });
      }
      // The cabinet's own files (app.js, style.css, sw.js, covers/…) resolve
      // relative to /, after every API route above has had its chance.
      if (req.method === 'GET' && serveStatic(res, `cabinet/${url.pathname}`)) return;
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  await new Promise((r) => server.listen(port, host, r));
  const actualPort = server.address().port;
  addr ??= `http://${host}:${actualPort}`;
  lanAddr = addr;
  if (upnp) {
    const ports = [{ external: actualPort, internal: actualPort, label: 'node' }];
    if (relayPort) ports.push({ external: relayPort, internal: relayPort, label: 'relay' });
    upnpCtl = keepMapped(ports, { log, gateway: upnpGateway });
    upnpCtl.ready.then(() => { const s = upnpCtl.status(); emit('upnp', s); if (s.mapped.length && !tunnel && s.publicIp && !s.cgnat) { addr = `http://${s.publicIp}:${actualPort}`; log(`advertising ${addr} (UPnP)`); } });
  }
  // The node's own tunnel: when it comes up, its URL becomes the address we
  // advertise; when it drops, we fall back to the LAN address. A relay tunnel
  // does the same for wsAddr. Peers learn both from the next heartbeat.
  try {
    if (tunnel) {
      tunnels.node = createTunnel({ port: actualPort, name: tunnel === 'named' ? tunnelName : null, hostname: tunnel === 'named' ? tunnelHost : null, log, bin: tunnelBin,
        onUrl: (u) => { addr = u ?? lanAddr; emit('tunnel', { which: 'node', url: u }); if (u) announceNow(); } });
    }
    if (relayPort && !wsAddrIn) {
      tunnels.relay = createTunnel({ port: relayPort, name: relayTunnelName, hostname: relayTunnelHost, log, bin: tunnelBin,
        onUrl: (u) => { wsAddr = u ? u.replace(/^https:/, 'wss:') : null; emit('tunnel', { which: 'relay', url: wsAddr }); if (u) announceNow(); } });
    }
  } catch (e) {
    // A misconfigured tunnel must not leave a half-started node listening.
    tunnels.node?.stop();
    await new Promise((r) => server.close(r));
    throw e;
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
  await tick();
  if (updates && version) { setTimeout(() => checkUpdates().catch(() => {}), 5_000); updateTimer = setInterval(() => checkUpdates().catch(() => {}), 60 * 60_000); }
  log(`litnode ${nodeId.slice(0, 12)} on ${addr} roles=${roles.join(',')} rulesets=${[...loaded.keys()].join(',') || '-'}`);

  return {
    nodeId, addr, port: actualPort, identity,
    snapshot: currentSnapshot, matches: matchesNow, installRuleset, chain, settlement,
    rulesets: () => buildHashes(), peers: () => heartbeats, inbound, operator, roles, region, startedAt,
    version, updater, restart, tunnels, upnp: upnpCtl, get wsAddr() { return wsAddr; }, get announcer() { return announcer; }, seeds: () => chainSeeds, seedChecks, admitSeed, sandbox, refused, incompatible, protocol: PROTOCOL_VERSION, peersKnown,
    async stop() { clearInterval(timer); clearInterval(updateTimer); clearInterval(directoryTimer); clearTimeout(announceRetry); tunnels.node?.stop(); tunnels.relay?.stop(); await upnpCtl?.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}
