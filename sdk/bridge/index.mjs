/** litnode bridge — settle matches that are played on a publisher's own
 *  backend. The path for a game that already exists: keep the engine, the
 *  database, the servers and the art; hand the mesh one thing per match.
 *
 *  Two kinds of match, same as the title contract (titles/title.js):
 *
 *   REPLAYABLE  your server (or relay) has the per-tick input log. You post
 *               the log; the node re-runs it in the sandbox and a witness on
 *               another operator's node re-runs it again. Backed by either
 *               both players' signatures over the ledger head ('players' —
 *               official when placed) or this bridge's relay key ('relay' —
 *               authenticated, unofficial). Agent Fighter.
 *   ATTESTED    your server is the only thing that can compute the outcome
 *               (float physics, closed engine, no input log). You post the
 *               outcome report; this bridge signs it as your court; the node
 *               validates it against your ruleset and settles it labelled
 *               'attested'. Pickle Brawl.
 *
 *  This module is the library: keys, signing, submission shapes, a
 *  cursor-based watcher over any source (`adapter`), an HTTP intake, and
 *  the read-back that says what the mesh made of a match. `sdk/bridge/cli.mjs`
 *  wraps it. No dependencies beyond protocol/. Nothing here handles a
 *  wallet key; the bridge key is an ed25519 identity, not a wallet. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeypair, sign, verify } from '../../protocol/keys.js';
import { chainHead, ledgerBody, LEDGER_TAG } from '../../protocol/log.js';
import { roomCodeFor } from '../../protocol/pairing.js';
import { RELAY_TAG, ATTEST_TAG } from '../../node/settle.js';

export const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
export const DEFAULT_KEY_FILE = join(homedir(), '.litnode', 'bridge-key.json');
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);
const trim = (u) => String(u).replace(/\/+$/, '');

// --------------------------------------------------------------------- key

/** The bridge identity: a relay key for replayable titles, a court key for
 *  attested ones — the same ed25519 file format as a node identity. Created
 *  on first use, never printed in full by anything here. */
export async function loadOrCreateKey(file = DEFAULT_KEY_FILE) {
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(await generateKeypair(), null, 2) + '\n'); }
  const kp = JSON.parse(readFileSync(file, 'utf8'));
  if (!isKey(kp.publicKey) || !isKey(kp.privateKey)) throw new Error(`${file}: not an ed25519 identity`);
  return kp;
}

/** What the node operator must add to node.env so this key counts. */
export const nodeEnvLine = (kind, rulesetId, publicKey) => (kind === 'attested' ? `COURTS=${rulesetId}:${publicKey}` : `RELAY_KEYS=${publicKey}`);

// ------------------------------------------------------------- submissions

/** Check a replayable submission's shape before it leaves the publisher's
 *  machine. Returns [] when fine. */
export function validateReplayable(sub) {
  const e = [];
  if (!sub || typeof sub !== 'object') return ['submission must be an object'];
  if (typeof sub.matchId !== 'string' || !sub.matchId) e.push('matchId (string) required');
  if (typeof sub.rulesetId !== 'string' || !/^[a-z0-9][a-z0-9-]*\.v\d+$/.test(sub.rulesetId)) e.push('rulesetId must look like name.v1');
  if (sub.buildHash != null && !isKey(sub.buildHash)) e.push('buildHash must be 64 hex');
  if (sub.mode != null && !['ranked', 'casual'].includes(sub.mode)) e.push('mode must be ranked or casual');
  if (!Array.isArray(sub.participants) || sub.participants.length < 2 || new Set(sub.participants).size !== sub.participants.length) e.push('participants: ≥2 distinct ids');
  if (sub.mode === 'ranked' && !(sub.participants ?? []).every(isKey)) e.push('ranked: participants must be player keys (64 hex)');
  if (!Array.isArray(sub.entries) || !sub.entries.length) e.push('entries: a non-empty per-tick input log');
  else if (!sub.entries.every((x, i) => x && x.k === i && Array.isArray(x.inputs) && x.inputs.length === (sub.participants?.length ?? 0))) e.push('entries must be [{k: 0..n-1, inputs: [one per participant]}]');
  if (sub.signatures && Object.keys(sub.signatures).some((k) => !(sub.participants ?? []).includes(k))) e.push('signatures keyed by participant');
  return e;
}

export function validateAttested(sub) {
  const e = [];
  if (!sub || typeof sub !== 'object') return ['submission must be an object'];
  if (sub.kind !== 'attested') e.push("kind must be 'attested'");
  if (typeof sub.matchId !== 'string' || !sub.matchId) e.push('matchId (string) required');
  if (typeof sub.rulesetId !== 'string' || !/^[a-z0-9][a-z0-9-]*\.v\d+$/.test(sub.rulesetId)) e.push('rulesetId must look like name.v1');
  if (sub.mode != null && !['ranked', 'casual'].includes(sub.mode)) e.push('mode must be ranked or casual');
  if (!Array.isArray(sub.participants) || sub.participants.length < 2) e.push('participants: ≥2 ids');
  if (!Array.isArray(sub.teams) || sub.teams.length !== 2) e.push('teams: exactly two arrays');
  else { const flat = sub.teams.flat(); if (flat.length !== (sub.participants?.length ?? -1) || flat.some((p) => !sub.participants.includes(p))) e.push('teams must partition participants'); }
  if (!sub.report || typeof sub.report !== 'object') e.push('report (object) required — what your ruleset validates');
  return e;
}

/** The body each player signs at match end (protocol 3). Give it to your
 *  clients: sign(LEDGER_TAG, body, playerKey) → signatures[playerId]. */
export const playerBody = ({ matchId, entries, buildHash }) => ledgerBody({ matchId, ticks: entries.length, head: chainHead(entries), buildHash });
export const signAsPlayer = (body, playerKp) => sign(LEDGER_TAG, body, playerKp.privateKey);
export const verifyPlayerSig = (body, sig, playerId) => verify(LEDGER_TAG, body, sig, playerId);

/** Sign a replayable submission as the relay. `expected` is your own
 *  record of the outcome; the node cross-checks it against its replay. */
export async function signRelay(sub, kp) {
  const body = { matchId: sub.matchId, head: chainHead(sub.entries), ticks: sub.entries.length, expected: sub.expected ?? null };
  return { ...sub, relay: { id: kp.publicKey, sig: await sign(RELAY_TAG, body, kp.privateKey) } };
}

/** Sign an attested submission as the court. */
export async function signAttest(sub, kp) {
  const sig = await sign(ATTEST_TAG, { matchId: sub.matchId, rulesetId: sub.rulesetId, report: sub.report }, kp.privateKey);
  return { ...sub, kind: 'attested', attestor: { id: kp.publicKey, sig } };
}

/** Sign whichever kind it is, after validating. Throws on a bad shape. */
export async function prepare(sub, kp) {
  const attested = sub.kind === 'attested' || (sub.report && !sub.entries);
  const errs = attested ? validateAttested({ ...sub, kind: 'attested' }) : validateReplayable(sub);
  if (errs.length) throw new Error(errs.join('; '));
  if (attested) return signAttest(sub, kp);
  // Player-signed logs need no relay word, but carrying it costs nothing
  // and the node prefers the players' signatures when both verify.
  return signRelay(sub, kp);
}

// ------------------------------------------------------------ placement map

/** The mesh's frozen placements, by relay room code — so a match your
 *  relay ran for two cabinet-placed players settles under the mesh match id
 *  and the keys the mesh placed (same as tools/lib/af-submission.mjs). */
export async function placements(nodeUrl, fetchImpl = fetch) {
  try {
    const { matches } = await (await fetchImpl(`${trim(nodeUrl)}/match`, { signal: AbortSignal.timeout(8000) })).json();
    return new Map(matches.map((m) => [roomCodeFor(m.matchId), m]));
  } catch { return new Map(); }
}

/** If `room` names a live placement, rewrite the submission onto it. */
export const bindToPlacement = (sub, room, rooms) => {
  const placed = room ? rooms.get(String(room)) : null;
  if (!placed) return { ...sub, placed: false };
  // The node refuses a mode that differs from its descriptor, so the
  // placement's mode wins; participants stay the keys the relay recorded.
  return { ...sub, matchId: placed.matchId, mode: placed.mode ?? sub.mode ?? 'casual', placed: true };
};

// ------------------------------------------------------------- discovery

/** Find a live node hosting `rulesetId` from NodeDirectory on chain — the
 *  bootstrap every node and the hosted arcade use — so a publisher's
 *  server is never pinned to a tunnel hostname that rotates. Reads keys(),
 *  each entry, each standing; keeps bonded, fresh entries, newest first;
 *  prefers one whose /titles lists the ruleset and that proves its key.
 *  Defaults come from contracts/deployed.testnet.json. */
export async function resolveNode({ rulesetId = null, rpc = null, nodeDirectory = null, nodeStake = null, fetchImpl = fetch, log = () => {} } = {}) {
  const deployedPath = join(ROOT, 'contracts', 'deployed.testnet.json');
  const deployed = existsSync(deployedPath) ? JSON.parse(readFileSync(deployedPath, 'utf8')) : {};
  rpc ??= deployed.rpc; nodeDirectory ??= deployed.NodeDirectory?.address; nodeStake ??= deployed.NodeStake?.address;
  if (!rpc || !nodeDirectory || !nodeStake) throw new Error('resolveNode: rpc, NodeDirectory and NodeStake are required (contracts/deployed.testnet.json)');
  const { keysCall, entryOfCall, decodeKeys, decodeEntry, liveSeeds } = await import('../../protocol/directory.js');
  const { standingCall, decodeStanding } = await import('../../protocol/staking.js');
  const { checkChallenge, newNonce } = await import('../../protocol/challenge.js');
  let id = 0;
  const call = async (c) => { const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [c, 'latest'] }), signal: AbortSignal.timeout(15_000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const keys = decodeKeys(await call(keysCall(nodeDirectory)));
  const entries = {}, stakes = {};
  for (const k of keys) { entries[k] = decodeEntry(await call(entryOfCall(nodeDirectory, k))); stakes[k] = decodeStanding(await call(standingCall(nodeStake, k))); }
  const seeds = liveSeeds(entries, stakes);
  const tried = [];
  for (const s of seeds) {
    try {
      const nonce = newNonce();
      const who = await (await fetchImpl(`${s.url}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(8000) })).json();
      const c = await checkChallenge(who, { expectNodeId: s.nodeId, nonce });
      if (!c.ok) { tried.push({ url: s.url, reason: `proof ${c.reason}` }); continue; }
      if (rulesetId) {
        const h = await (await fetchImpl(`${s.url}/health`, { signal: AbortSignal.timeout(8000) })).json();
        if (!h.rulesets?.[rulesetId]) { tried.push({ url: s.url, reason: `does not host ${rulesetId}` }); continue; }
        if (!(h.roles ?? []).includes('settler')) { tried.push({ url: s.url, reason: 'no settling role' }); continue; }
      }
      log(`resolved ${s.url} (${s.nodeId.slice(0, 12)}…) from NodeDirectory`);
      return { url: s.url, nodeId: s.nodeId, operator: s.operator, updatedAt: s.updatedAt, candidates: seeds.length, tried };
    } catch (e) { tried.push({ url: s.url, reason: e.message }); }
  }
  throw new Error(`no live node${rulesetId ? ` hosting ${rulesetId}` : ''} on NodeDirectory (${seeds.length} seed(s): ${tried.map((t) => `${t.url}: ${t.reason}`).join('; ') || 'none announced'})`);
}

// ------------------------------------------------------------------ submit

/** POST /ledger, idempotently: a match the node already settled is
 *  reported as 'already', never re-sent. Returns
 *  { status: 'settled'|'already'|'refused', matchId, delta?, error? }. */
export async function submit(nodeUrl, signed, { fetchImpl = fetch } = {}) {
  const base = trim(nodeUrl);
  try {
    const have = await fetchImpl(`${base}/delta/${encodeURIComponent(signed.matchId)}`, { signal: AbortSignal.timeout(8000) });
    if (have.ok) return { status: 'already', matchId: signed.matchId, delta: await have.json() };
  } catch { /* fall through to submit */ }
  const { placed, ...body } = signed; // `placed` is bridge bookkeeping, not part of the wire shape
  const r = await fetchImpl(`${base}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return r.ok ? { status: 'settled', matchId: signed.matchId, delta: j } : { status: 'refused', matchId: signed.matchId, error: j.error ?? `HTTP ${r.status}` };
}

/** What the mesh made of a match: the delta, its proof, and a verdict in
 *  words a publisher can act on. */
export async function check(nodeUrl, matchId, { fetchImpl = fetch } = {}) {
  const base = trim(nodeUrl);
  const get = async (p) => { const r = await fetchImpl(`${base}${p}`, { signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; };
  const delta = await get(`/delta/${encodeURIComponent(matchId)}`);
  if (!delta) return { matchId, found: false, verdict: 'not settled on this node' };
  const proof = await get(`/proof/${encodeURIComponent(matchId)}`);
  const cosigners = delta.cosigners?.length ?? 0;
  const disputes = delta.disputes?.length ?? 0;
  const why = [];
  if (delta.mode !== 'ranked') why.push('casual mode');
  if (!delta.placed) why.push('not placed by the mesh (your matchmaking, not ours)');
  if (delta.attestation === 'relay') why.push('relay-attested: authenticated but players did not sign');
  if (delta.attestation === 'host') why.push("host's word only");
  if (delta.attestation === 'attested') why.push('court-attested: trusted, not replayed');
  if (!cosigners) why.push('no independent witness yet');
  if (disputes) why.push(`${disputes} dispute(s)`);
  return {
    matchId, found: true, official: !!delta.official, placed: !!delta.placed, mode: delta.mode, attestation: delta.attestation, verifiable: delta.verifiable,
    cosigners, disputes, scores: delta.scores, ticks: delta.ticks ?? null, buildHash: delta.buildHash, hostId: delta.hostId, hydrationSource: delta.hydrationSource ?? null,
    proof: proof ? { status: proof.status, verified: proof.verified ?? null, epoch: proof.epoch ?? null } : null,
    verdict: delta.official ? 'OFFICIAL: placed, signed, independently verified, undisputed' : `settled, not official: ${why.join('; ')}`,
  };
}

// ----------------------------------------------------------------- watcher

/** An adapter is the publisher's side of the bridge — the only code they
 *  write. Its contract:
 *
 *    export const kind = 'replayable' | 'attested';
 *    export const rulesetId = 'my-game.v1';
 *    export async function poll(cursor, ctx)   → { rows: [{ id, cursor, ...anything }], cursor }
 *    export async function toSubmission(row, ctx) → an unsigned submission (see validate*), or null to skip
 *
 *  `cursor` is whatever the source orders by (a timestamp, a row id); it is
 *  persisted between runs. `ctx` carries { nodeUrl, rooms, log }. See
 *  sdk/bridge/adapters/ for three working ones. */
export async function loadAdapter(spec) {
  const url = /^[a-z0-9-]+$/.test(spec) ? new URL(`./adapters/${spec}.mjs`, import.meta.url) : pathToFileURL(resolve(spec));
  const mod = await import(url.href);
  for (const f of ['kind', 'rulesetId', 'poll', 'toSubmission']) if (!(f in mod)) throw new Error(`adapter ${spec}: missing export ${f}`);
  if (!['replayable', 'attested'].includes(mod.kind)) throw new Error(`adapter ${spec}: kind must be replayable|attested`);
  return mod;
}

/** Cursor-based watcher: poll → toSubmission → sign → submit, skipping
 *  what the node already holds, persisting the cursor and every outcome. */
export function createBridge({ nodeUrl, key, adapter, stateFile, pollMs = 5000, fetchImpl = fetch, log = () => {}, adapterOptions = {} }) {
  const base = trim(nodeUrl);
  const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { cursor: null, seen: {} };
  const save = () => { if (stateFile) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n'); } };
  let running = false, timer = null;
  const results = [];

  /** One pass over the source. Returns what it did. */
  const once = async () => {
    const rooms = await placements(base, fetchImpl);
    const ctx = { nodeUrl: base, rooms, log, options: adapterOptions };
    const { rows = [], cursor } = await adapter.poll(state.cursor, ctx);
    const did = [];
    for (const row of rows) {
      const id = String(row.id);
      if (state.seen[id]) continue;
      try {
        let sub = await adapter.toSubmission(row, ctx);
        if (!sub) { state.seen[id] = { status: 'skipped', at: Date.now() }; did.push({ id, status: 'skipped' }); continue; }
        if (row.room) sub = bindToPlacement(sub, row.room, rooms);
        const signed = await prepare(sub, key);
        const r = await submit(base, signed, { fetchImpl });
        state.seen[id] = { status: r.status, matchId: r.matchId, at: Date.now(), ...(r.error ? { error: r.error } : {}) };
        did.push({ id, ...r, delta: undefined, attestation: r.delta?.attestation, official: r.delta?.official });
        log(`${id} → ${r.matchId}: ${r.status}${r.delta ? ` · ${r.delta.attestation}${r.delta.official ? ' · OFFICIAL' : ''}` : ''}${r.error ? ` · ${r.error}` : ''}`);
      } catch (e) {
        state.seen[id] = { status: 'error', at: Date.now(), error: e.message };
        did.push({ id, status: 'error', error: e.message });
        log(`${id}: ${e.message}`);
      }
    }
    if (cursor !== undefined) state.cursor = cursor;
    save();
    results.push(...did);
    return did;
  };

  const start = () => {
    if (running) return;
    running = true;
    const tick = async () => { if (!running) return; try { await once(); } catch (e) { log(`poll: ${e.message}`); } if (running) timer = setTimeout(tick, pollMs); };
    tick();
  };
  const stop = () => { running = false; clearTimeout(timer); };
  return { once, start, stop, state, results, publicKey: key.publicKey };
}

// ------------------------------------------------------------- HTTP intake

/** The simplest wiring for an existing backend: at match end, your server
 *  POSTs the unsigned submission here with `authorization: Bearer <token>`;
 *  this signs it and forwards it to the node, answering with what settled.
 *
 *    POST /submit            body: a replayable or attested submission
 *    GET  /check/:matchId    what the mesh made of it
 *    GET  /health            this bridge's key and node
 *
 *  Runs beside the node (loopback) or anywhere that can reach it. */
export function createIntake({ nodeUrl, key, token, host = '127.0.0.1', port = 8480, fetchImpl = fetch, log = () => {}, rulesetId = null, kind = null }) {
  if (!token || token.length < 16) throw new Error('intake needs a BRIDGE_TOKEN of at least 16 characters');
  const base = trim(nodeUrl);
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, bridge: key.publicKey, node: base, rulesetId, kind });
      if (req.method === 'GET' && url.pathname.startsWith('/check/')) return json(res, 200, await check(base, decodeURIComponent(url.pathname.slice(7)), { fetchImpl }));
      if (req.method === 'POST' && url.pathname === '/submit') {
        if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'bad token' });
        let text = ''; for await (const c of req) { text += c; if (text.length > 8e6) return json(res, 413, { error: 'too large' }); }
        let sub; try { sub = JSON.parse(text); } catch { return json(res, 400, { error: 'body must be JSON' }); }
        if (rulesetId && sub.rulesetId !== rulesetId) return json(res, 400, { error: `this bridge signs for ${rulesetId} only` });
        if (kind === 'attested') sub.kind = 'attested';
        if (sub.room) sub = bindToPlacement(sub, sub.room, await placements(base, fetchImpl));
        const signed = await prepare(sub, key);
        const r = await submit(base, signed, { fetchImpl });
        log(`intake ${sub.matchId}: ${r.status}${r.error ? ` · ${r.error}` : r.delta ? ` · ${r.delta.attestation}` : ''}`);
        return json(res, r.status === 'refused' ? 400 : 200, r);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  return {
    server, publicKey: key.publicKey,
    listen: () => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
