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
import { generateKeypair, seal, opened } from '../protocol/keys.js';
import { snapshot as buildSnapshot, verifyHeartbeats, HEARTBEAT_TAG, epochOf, EPOCH_MS } from '../protocol/snapshot.js';
import { applyStakes } from '../protocol/staking.js';
import { pair, QUEUE_TAG, bucketOf } from '../protocol/pairing.js';
import { placement } from '../protocol/placement.js';
import { createChain } from './chain.js';
import { createSettlement } from './settle.js';

// Every response is readable from any origin, and from an https page reaching
// a loopback node (Chrome's Private Network Access asks on the preflight).
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true' };
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
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
  operator = 'dev', roles = ['mesh', 'witness'], region = 'local', wsAddr = null,
  seeds = [], rulesets = [], rpc = null, offline = !rpc, nodeStake = null,
  heartbeatMs = EPOCH_MS / 2, log = () => {}, onEvent = () => {},
}) {
  // Every observable thing the node does goes through emit(): the TUI draws
  // from it, a log file gets a line per event, tests can subscribe. Never
  // throws into the caller.
  const emit = (type, data = {}) => { try { onEvent({ t: Date.now(), type, ...data }); } catch { /* observer's problem */ } };
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'rulesets'), { recursive: true });
  const startedAt = Date.now(); // /health reports it so a dashboard can show process uptime

  // ---------------------------------------------------------------- identity
  const idPath = join(dataDir, 'identity.json');
  const identity = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : await generateKeypair();
  if (!existsSync(idPath)) writeFileSync(idPath, JSON.stringify(identity, null, 2) + '\n');
  const nodeId = identity.publicKey;

  const chain = createChain({ rpc: rpc ?? 'offline', offline, nodeStake });

  // ---------------------------------------------------------------- rulesets
  const loaded = new Map(); // rulesetId → CURRENT build { buildHash, source, title, mod } (advertised)
  // Every build this node has ever held, by hash. A delta names the build it
  // was settled with; a witness must replay in THAT build, not the newest.
  // Nothing is ever evicted: an old delta stays verifiable for as long as
  // one node kept the bytes (BUILD-SPEC §4).
  const builds = new Map(); // buildHash → { rulesetId, buildHash, source, title, mod }
  const importSource = async (source, buildHash) => {
    // .mjs so the cache dir needs no package.json to be treated as ESM.
    const file = join(dataDir, 'rulesets', `${buildHash}.mjs`);
    if (!existsSync(file)) writeFileSync(file, source);
    const mod = await import(pathToFileURL(file).href);
    const title = mod.default;
    if (!title?.manifest?.rulesetId) throw new Error('ruleset has no default defineTitle export');
    return { title, mod };
  };
  /** Install a ruleset ONLY if its bytes hash to the pinned value. */
  const installRuleset = async (source, expectedHash, { current = true } = {}) => {
    const actual = rulesetHash(source);
    if (expectedHash && actual !== expectedHash) throw new Error(`ruleset hash mismatch: expected ${expectedHash.slice(0, 12)} got ${actual.slice(0, 12)}`);
    if (builds.has(actual)) { if (current) loaded.set(builds.get(actual).rulesetId, builds.get(actual)); return builds.get(actual).title; }
    const { title, mod } = await importSource(source, actual);
    const entry = { rulesetId: title.manifest.rulesetId, buildHash: actual, source, title, mod };
    builds.set(actual, entry);
    if (current) loaded.set(title.manifest.rulesetId, entry);
    log(`ruleset ${title.manifest.rulesetId} @ ${actual.slice(0, 12)} ${current ? 'loaded' : 'held (not current)'}`);
    emit('ruleset', { rulesetId: title.manifest.rulesetId, buildHash: actual, current, bytes: source.length });
    return title;
  };
  // Re-hold every build cached on disk from earlier runs, then make the
  // configured rulesets current.
  for (const f of readdirSync(join(dataDir, 'rulesets')).filter((f) => f.endsWith('.mjs'))) {
    try { await installRuleset(readFileSync(join(dataDir, 'rulesets', f), 'utf8'), f.slice(0, -4), { current: false }); }
    catch (e) { log(`cached build ${f}: ${e.message}`); }
  }
  for (const p of rulesets) await installRuleset(readFileSync(p, 'utf8'), null);

  const settlement = createSettlement({ dataDir, nodeId, identity, loaded, builds, log });
  const canSettle = roles.some((r) => ['host', 'settler', 'relay'].includes(r));
  const isWitness = roles.includes('witness');
  const witnessed = new Set(); // matchIds this node already answered

  const buildHashes = () => Object.fromEntries([...loaded].map(([id, r]) => [id, r.buildHash]));
  const manifests = () => Object.fromEntries([...loaded].map(([id, r]) => [id, { ...r.title.manifest, buildHash: r.buildHash }]));

  // ---------------------------------------------------------------- registry state
  const heartbeats = new Map(); // nodeId → latest verified body
  // Remote addresses that have POSTed /gossip to us, with the last time. If
  // this stays empty while peers are fresh, nobody can reach us inbound —
  // fine for a witness, not for a seed or a LAN host.
  const inbound = new Map();
  const queue = new Map();      // `${bucket}|${playerId}` → verified body
  const peersKnown = new Set(seeds);
  let stakes = null;            // nodeId → standing, when nodeStake configured
  let addr = publicAddr;

  const myHeartbeat = () => seal(HEARTBEAT_TAG, {
    nodeId, operator, roles, region, addr, wsAddr, standing: 0,
    buildHashes: buildHashes(), manifests: manifests(), epoch: epochOf(Date.now()),
  }, identity);

  const mergeHeartbeats = async (envelopes) => {
    for (const b of await verifyHeartbeats(envelopes ?? [])) {
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
          const r = await fetch(`${p.addr}/ruleset/${encodeURIComponent(rid)}`);
          if (!r.ok) continue;
          await installRuleset(await r.text(), m.buildHash);
          break;
        } catch (e) { log(`hydrate ${rid} from ${p.addr}: ${e.message}`); }
      }
    }
  };

  // ---------------------------------------------------------------- gossip loop
  let timer = null;
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
          emit('stakes', { read: Object.keys(st).length, bonded: Object.values(next).filter((x) => x.active).length });
        }
      }
      await hydrateMissing(currentSnapshot());
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
        await installRuleset(await r.text(), ad.buildHash, { current: false });
      }
      const [delta, ledger] = await Promise.all([
        fetch(`${ad.addr}/delta/${encodeURIComponent(ad.matchId)}`).then((r) => r.json()),
        fetch(`${ad.addr}/ledger/${encodeURIComponent(ad.matchId)}`).then((r) => r.json()),
      ]);
      const res = await settlement.cosign(delta, ledger);
      if (!res.ok) { log(`witness ${ad.matchId}: DISAGREE (${res.reason})`); emit('witness', { matchId: ad.matchId, ok: false, reason: res.reason, ours: res.ours, theirs: res.theirs }); return; }
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
    return { ...m, beaconSource: chain.beaconFor(m.bucket)?.source, snapshotRoot: s.root, snapshotEpoch: s.epoch, computedBy: nodeId, computedAt: Date.now(),
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
      if (req.method === 'GET' && url.pathname === '/health') {
        const s = currentSnapshot();
        return json(res, 200, { nodeId, operator, roles, region, addr, epoch: s.epoch, peers: s.peers.length, rulesets: buildHashes(), buildsHeld: builds.size, staking: s.staking, bonded: stakes?.[nodeId]?.active ?? null, chain: chain.status(), startedAt: new Date(startedAt).toISOString(), uptimeMs: Date.now() - startedAt,
          // reachable: a peer has pushed gossip to us in the last 30 s. null = no peers known, so nothing to conclude.
          inbound: { peers: [...inbound.values()].filter((t) => Date.now() - t < 30_000).length, lastAt: inbound.size ? new Date(Math.max(...inbound.values())).toISOString() : null, reachable: peersKnown.size ? [...inbound.values()].some((t) => Date.now() - t < 30_000) : null } });
      }
      if (req.method === 'GET' && url.pathname === '/snapshot') return json(res, 200, currentSnapshot());
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
          rulesets: Object.keys(b.buildHashes ?? {}),
        })) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/ruleset/')) {
        const rid = decodeURIComponent(url.pathname.slice(9));
        const want = url.searchParams.get('build');
        const r = want ? (builds.get(want)?.rulesetId === rid ? builds.get(want) : null) : loaded.get(rid);
        if (!r) return json(res, 404, { error: want ? 'build not held' : 'unknown ruleset' });
        res.writeHead(200, { 'content-type': 'text/javascript', 'x-build-hash': r.buildHash, ...CORS });
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
      if (req.method === 'GET' && url.pathname === '/deltas') return json(res, 200, { deltas: settlement.list(url.searchParams.get('ruleset') ?? undefined) });
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
      if (req.method === 'GET' && ['/leaderboard', '/credits', '/stats'].includes(url.pathname)) {
        const rid = url.searchParams.get('ruleset');
        if (!rid) return json(res, 400, { error: 'ruleset= required' });
        try {
          const d = settlement.derived(rid, { requireCosign: url.searchParams.get('cosigned') === '1' });
          const player = url.searchParams.get('player');
          if (url.pathname === '/leaderboard') return json(res, 200, { rulesetId: rid, deriveVersion: d.deriveVersion, digest: d.digest, skipped: d.skipped, leaderboard: d.leaderboard });
          if (url.pathname === '/credits') { const cur = url.searchParams.get('currency'); const table = cur ? d.credits[cur] ?? {} : d.credits; return json(res, 200, player ? { player, currency: cur, balance: table[player] ?? 0 } : table); }
          return json(res, 200, player ? { player, ...(d.stats[player] ?? { matches: 0, wins: 0, ticks: 0 }) } : d.stats);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/epoch') {
        const hour = url.searchParams.get('epoch');
        const { tree, ...e } = settlement.epoch(hour ? Number(hour) : undefined);
        return json(res, 200, e);
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
  timer = setInterval(tick, heartbeatMs);
  await tick();
  log(`litnode ${nodeId.slice(0, 12)} on ${addr} roles=${roles.join(',')} rulesets=${[...loaded.keys()].join(',') || '-'}`);

  return {
    nodeId, addr, port: actualPort, identity,
    snapshot: currentSnapshot, matches: matchesNow, installRuleset, chain, settlement,
    rulesets: () => buildHashes(), peers: () => heartbeats, inbound, operator, roles, region, startedAt,
    async stop() { clearInterval(timer); await new Promise((r) => server.close(r)); },
  };
}
