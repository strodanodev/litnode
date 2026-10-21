/** sdk/court — the court client for an ATTESTED litnode title.
 *
 *  An attested title's outcome is computed by the studio's own server (the
 *  court), which holds an ed25519 key the node operator lists in COURTS. The
 *  court signs an outcome report and posts the envelope to a bonded node's
 *  POST /ledger; the node validates the report against the title's ruleset
 *  and settles it labelled `attested`.
 *
 *  Self-contained on purpose: plain ESM, zero dependencies, no node: imports,
 *  nothing from ../../protocol. Runs on Node 20+ and in a browser (WebCrypto
 *  needs a secure context there). A studio may vendor this folder as is.
 *
 *    signReport / attest / envelope   what the court signs and sends
 *    inputsHash / encodeLog           the settlement-v4 input log commitment
 *    findSettler                      a live, bonded node hosting the ruleset, from NodeDirectory on litVM
 *    settle                           post an envelope; never throws for a network failure
 *
 *  Wire contract (litnode node/settle.js, checkAttested): attestor.sig is
 *  ed25519 over UTF-8 of "attest" ‖ 0x00 ‖ canonical({ matchId, rulesetId, report }),
 *  canonical being JSON with recursively sorted object keys, undefined and
 *  functions dropped — byte-for-byte protocol/keys.js sign('attest', …). */

export const ATTEST_TAG = 'attest';
export const WHOAMI_TAG = 'whoami';
/** The largest input log a node accepts beside an envelope, decoded. */
export const LOG_MAX_BYTES = 512 * 1024;
/** The node protocol from which POST /ledger takes `log` (and serves GET /log/<inputsHash>). */
export const LOG_PROTOCOL = 4;
/** Roles under which a node answers POST /ledger (node/litnode.js canSettle). */
export const SETTLING_ROLES = Object.freeze(['host', 'settler', 'relay']);
/** The arcade publishes the live contract set here: { generation, rpc, contracts: { NodeDirectory: { address }, … } }. */
export const CONTRACTS_URL = 'https://arcade.litvm.games/contracts.json';
/** litVM Liteforge (chain 4441) gateways, preferred first. The public /http gateway rate-limits per IP. */
export const DEFAULT_RPCS = Object.freeze(['https://liteforge.rpc.caldera.xyz/http', 'https://liteforge.rpc.caldera.xyz/infra-partner-http']);
/** Generation-3 contracts: the fallback when contracts.json cannot be read. */
export const DEFAULT_CONTRACTS = Object.freeze({ generation: 3, NodeDirectory: '0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df', NodeStake: '0x3CFe2D006d946A1E0E5Cf6B3E0958aFc3fF73717' });
/** Function selectors, hard-coded (no keccak at runtime); demo/court.test.mjs checks them against protocol/keccak.js. */
export const SELECTORS = Object.freeze({
  keys: '0x307540f6', //        NodeDirectory keys() → bytes32[]
  keysPage: '0x7ae61bff', //    NodeDirectory keysPage(uint256 offset, uint256 limit) → bytes32[]   (generation 4+)
  entryOf: '0x82fb8643', //     NodeDirectory entryOf(bytes32) → (string url, string wsAddr, uint64 updatedAt, address announcer)
  standingOf: '0x43aa9ad3', //  NodeStake standingOf(bytes32) → (address operator, uint256 amount, bool active)
});
/** A directory entry older than this is not a seed any more (protocol/directory.js FRESH_S). */
export const FRESH_S = 7 * 24 * 3600;
export const STAT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
export const STATS_MAX_NAMES = 32;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const RULESET_RE = /^[a-z0-9][a-z0-9-]*\.v\d+$/;
// A rate limit can come as HTTP 429 or as a JSON-RPC error with a 200 (Caldera: "Bandwidth limit exceeded").
const RATE_RE = /rate.?limit|bandwidth limit|too many requests|request limit|limit exceeded|exceeded .*limit|capacity exceeded/i;
const enc = new TextEncoder();
const dec = new TextDecoder();
const trim = (u) => String(u).replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto unavailable: needs Node 20+, or a page served over https or localhost');
  return s;
};

// ------------------------------------------------------------------ bytes

/** Stable JSON: object keys sorted recursively, arrays in order, undefined and functions dropped. */
export const canonical = (value) =>
  JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined && typeof v[k] !== 'function') out[k] = v[k];
      return out;
    }
    return v;
  });

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new TypeError('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
/** Uint8Array (a Node Buffer is one), ArrayBuffer, any typed array, or a string (UTF-8). */
const toBytes = (data) => {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('bytes: a Uint8Array, ArrayBuffer or string');
};
const b64url = (s) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);

/** What gets signed: tag ‖ 0x00 ‖ canonical(body), UTF-8. */
export const signingBytes = (tag, body) => enc.encode(`${tag}\0${canonical(body)}`);
/** The attested body: exactly these three fields, nothing else from the envelope. */
export const attestBody = ({ matchId, rulesetId, report }) => ({ matchId, rulesetId, report });

// ---------------------------------------------------------------- ed25519

const PKCS8_PREFIX = fromHex('302e020100300506032b657004220420'); // RFC 8410 wrapper for a raw 32-byte seed
const pkcs8 = (seed) => { const b = new Uint8Array(48); b.set(PKCS8_PREFIX); b.set(seed, 16); return b; };
const checked = new Map(); // privateKey hex → public key hex it derives (checked once per process)

async function importSigner(identity) {
  if (!HEX64.test(identity?.publicKey ?? '') || !HEX64.test(identity?.privateKey ?? '')) throw new TypeError('identity: { publicKey, privateKey } as 64 lowercase hex each (an ed25519 seed), or { publicKey, sign(bytes) }');
  const key = await subtle().importKey('pkcs8', pkcs8(fromHex(identity.privateKey)), { name: 'Ed25519' }, true, ['sign']);
  if (!checked.has(identity.privateKey)) {
    // A key file whose halves do not match signs fine and is refused by every node ("attestor signature invalid"); say so here.
    let derived = null;
    try { const jwk = await subtle().exportKey('jwk', key); if (jwk.x) derived = toHex(Uint8Array.from(atob(b64url(jwk.x)), (c) => c.charCodeAt(0))); } catch { /* runtime cannot export: skip the check */ }
    checked.set(identity.privateKey, derived);
  }
  const derived = checked.get(identity.privateKey);
  if (derived && derived !== identity.publicKey) throw new Error('identity: publicKey is not the key of this privateKey');
  return key;
}

/** Ed25519 verify; never throws — a malformed key or signature is false. */
export async function verifySignature(tag, body, sigHex, publicKeyHex) {
  try {
    const key = await subtle().importKey('raw', fromHex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, fromHex(sigHex), signingBytes(tag, body));
  } catch { return false; }
}

/** The court's signature over { matchId, rulesetId, report } → the envelope's `attestor`.
 *  `identity` is { publicKey, privateKey } (hex; `npm run bridge -- key` makes one) or, for a key held in a
 *  KMS/HSM, { publicKey, sign(bytes) → hex | Uint8Array }. */
export async function signReport({ matchId, rulesetId, report }, identity) {
  if (typeof matchId !== 'string' || !matchId) throw new TypeError('signReport: matchId (string) required');
  if (typeof rulesetId !== 'string' || !rulesetId) throw new TypeError('signReport: rulesetId (string) required');
  if (!isObj(report)) throw new TypeError('signReport: report (object) required');
  const bytes = signingBytes(ATTEST_TAG, attestBody({ matchId, rulesetId, report }));
  if (typeof identity?.sign === 'function') {
    if (!HEX64.test(identity.publicKey ?? '')) throw new TypeError('identity.publicKey: 64 lowercase hex');
    const sig = await identity.sign(bytes);
    return { id: identity.publicKey, sig: typeof sig === 'string' ? sig.toLowerCase() : toHex(toBytes(sig)) };
  }
  const key = await importSigner(identity);
  return { id: identity.publicKey, sig: toHex(new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key, bytes))) };
}

/** Does `attestor` sign this envelope's report? The node's own check, for a studio's tests. */
export const verifyEnvelope = (env) => verifySignature(ATTEST_TAG, attestBody(env ?? {}), env?.attestor?.sig, env?.attestor?.id);

// ------------------------------------------------------------- the report

/** Problems with the settlement-v4 parts of a report (`commitments`, `stats`); [] when fine or absent.
 *  The rest of the report is the title's own and its ruleset's validate() judges it. */
export function checkReport(report, participants = null) {
  const e = [];
  if (!isObj(report)) return ['report (object) required'];
  if (report.commitments !== undefined) {
    const c = report.commitments;
    if (!isObj(c)) e.push('report.commitments must be an object');
    else {
      if (typeof c.logFormat !== 'string' || !c.logFormat) e.push('report.commitments.logFormat: a non-empty string');
      if (c.inputsHash !== null && !HEX64.test(c.inputsHash ?? '')) e.push('report.commitments.inputsHash: lowercase hex sha256 of the exact log bytes, or null');
      for (const k of ['finalHash', 'verifierHash']) if (c[k] !== null && typeof c[k] !== 'string') e.push(`report.commitments.${k}: a string or null`);
    }
  }
  if (report.stats !== undefined) {
    const s = report.stats;
    if (!isObj(s)) e.push('report.stats must be an object { participant: { name: integer } }');
    else {
      for (const [p, row] of Object.entries(s)) {
        if (participants && !participants.includes(p)) e.push(`report.stats.${p}: not a participant`);
        if (!isObj(row)) { e.push(`report.stats.${p}: an object of counters`); continue; }
        const names = Object.keys(row);
        if (names.length > STATS_MAX_NAMES) e.push(`report.stats.${p}: at most ${STATS_MAX_NAMES} names`);
        for (const n of names) {
          if (!STAT_NAME_RE.test(n)) e.push(`report.stats.${p}.${n}: names match ${STAT_NAME_RE}`);
          if (!Number.isSafeInteger(row[n]) || row[n] < 0) e.push(`report.stats.${p}.${n}: a non-negative integer`);
        }
      }
    }
  }
  return e;
}

/** Problems with an envelope's shape; [] when it is fit to post. */
export function checkEnvelope(env) {
  if (!isObj(env)) return ['envelope must be an object'];
  const e = [];
  if (env.kind !== 'attested') e.push("kind must be 'attested'");
  if (typeof env.matchId !== 'string' || !env.matchId) e.push('matchId (string) required');
  if (typeof env.rulesetId !== 'string' || !RULESET_RE.test(env.rulesetId)) e.push('rulesetId must look like name.v1');
  if (!['ranked', 'casual'].includes(env.mode)) e.push('mode must be ranked or casual');
  const ps = env.participants;
  if (!Array.isArray(ps) || !ps.length || ps.some((p) => typeof p !== 'string' || !p)) e.push('participants: a non-empty array of ids');
  else if (new Set(ps).size !== ps.length) e.push('participants: duplicate id');
  if (env.teams !== undefined) {
    if (!Array.isArray(env.teams) || env.teams.length !== 2 || !env.teams.every(Array.isArray)) e.push('teams: exactly two arrays');
    else if (Array.isArray(ps)) { const flat = env.teams.flat(); if (flat.length !== ps.length || flat.some((p) => !ps.includes(p))) e.push('teams must partition participants'); }
  }
  e.push(...checkReport(env.report, Array.isArray(ps) ? ps : null));
  if (!HEX64.test(env.attestor?.id ?? '') || !HEX128.test(env.attestor?.sig ?? '')) e.push('attestor: { id: 64 hex, sig: 128 hex } (signReport)');
  return e;
}

/** The attested envelope POST /ledger takes. Throws a TypeError listing every problem. `log` is never part
 *  of it: settle() attaches the log only for a node that takes one. `meta` rides beside the match unsigned. */
export function envelope({ matchId, rulesetId, mode = 'casual', participants, teams, report, attestor, meta }) {
  const env = { kind: 'attested', matchId, rulesetId, mode, participants, ...(teams !== undefined ? { teams } : {}), report, attestor, ...(meta !== undefined ? { meta } : {}) };
  const errs = checkEnvelope(env);
  if (errs.length) throw new TypeError(`envelope: ${errs.join('; ')}`);
  return env;
}

/** signReport + envelope in one step. */
export async function attest(fields, identity) {
  const pre = checkReport(fields?.report, Array.isArray(fields?.participants) ? fields.participants : null);
  if (pre.length) throw new TypeError(`attest: ${pre.join('; ')}`);
  return envelope({ ...fields, attestor: await signReport(fields, identity) });
}

// ------------------------------------------------------------------ input log

/** Lowercase hex sha256 of the exact log bytes: report.commitments.inputsHash. */
export async function inputsHash(bytes) {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', toBytes(bytes))));
}

/** Base64 of the exact log bytes for the envelope's `log`; throws a RangeError past LOG_MAX_BYTES. */
export function encodeLog(bytes) {
  const b = toBytes(bytes);
  if (b.length > LOG_MAX_BYTES) throw new RangeError(`log is ${b.length} bytes; a node takes at most ${LOG_MAX_BYTES}`);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const decodeLog = (b64) => Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));

/** report.commitments from the log itself: inputsHash computed, never typed by hand. `log` null → inputsHash null. */
export async function makeCommitments({ logFormat, log = null, finalHash = null, verifierHash = null }) {
  if (log != null && toBytes(log).length > LOG_MAX_BYTES) throw new RangeError(`log exceeds ${LOG_MAX_BYTES} bytes`);
  return { logFormat, inputsHash: log == null ? null : await inputsHash(log), finalHash, verifierHash };
}

// ------------------------------------------------------------------ HTTP

const retryAfterMs = (r) => {
  const v = r?.headers?.get?.('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
};
/** Exponential backoff with jitter: half fixed, half random, capped. */
const backoff = (baseMs, n, capMs = 8000) => { const d = Math.min(capMs, baseMs * 2 ** n); return Math.round(d / 2 + Math.random() * (d / 2)); };
const readJson = async (r) => {
  try {
    if (typeof r.text === 'function') { const t = await r.text(); return t ? JSON.parse(t) : undefined; }
    return await r.json();
  } catch { return undefined; }
};
const netError = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : String(e?.cause?.code ?? e?.message ?? e));

/** One HTTP exchange with retries for what is worth retrying (network, timeout, 408, 429, 5xx, a 2xx that is
 *  not JSON — a tunnel's error page). Never throws. → { ok, status, body, error } */
async function request(fetchImpl, url, { method = 'GET', body, retries = 0, backoffMs = 500, timeoutMs = 8000 } = {}) {
  let last = { ok: false, status: null, body: undefined, error: 'not tried' };
  for (let n = 0; n <= retries; n++) {
    if (n) await sleep(Math.max(Math.min(last.retryAfter ?? 0, 30_000), backoff(backoffMs, n - 1)));
    try {
      const r = await fetchImpl(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body } : {}), signal: AbortSignal.timeout(timeoutMs) });
      const status = r.status ?? (r.ok ? 200 : 500);
      const j = await readJson(r);
      if (status === 408 || status === 429 || status >= 500 || (status < 300 && j === undefined)) {
        last = { ok: false, status, body: j, error: j?.error ?? (status === 429 ? 'HTTP 429 (rate limited)' : status < 300 ? `HTTP ${status}: not JSON` : `HTTP ${status}`), retryAfter: retryAfterMs(r) };
        continue;
      }
      return { ok: status >= 200 && status < 300, status, body: j, error: status >= 300 ? String(j?.error ?? `HTTP ${status}`) : null };
    } catch (e) { last = { ok: false, status: null, body: undefined, error: netError(e) }; }
  }
  const { retryAfter, ...out } = last;
  return out;
}

// ------------------------------------------------------------------ discovery

/** Bounded concurrency plus a floor between request starts (the litVM gateway 429s past ~25 req/s from one IP). */
function pacer({ concurrency = 4, maxRps = 8 } = {}) {
  const gap = maxRps > 0 ? 1000 / maxRps : 0;
  let last = -Infinity, active = 0;
  const waiting = [];
  // Measured on the clock, not on the timers: timers fire late and together (Windows' ~15 ms tick), so each
  // waiter re-checks after waking and only one of them takes the slot.
  const spaced = async () => { for (;;) { const now = Date.now(), wait = last + gap - now; if (wait <= 0) { last = now; return; } await sleep(wait); } };
  return async (fn) => {
    if (active < concurrency) active++;
    else await new Promise((r) => waiting.push(r)); // the slot is handed over by release
    try {
      if (gap) await spaced();
      return await fn();
    } finally { const w = waiting.shift(); if (w) w(); else active--; }
  };
}

/** Run fn over items with at most `n` in flight; results in input order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const strip = (hex) => String(hex ?? '').replace(/^0x/, '');
export function decodeBytes32Array(hexRet) {
  const d = strip(hexRet);
  if (d.length < 128) return [];
  const off = Number(BigInt('0x' + d.slice(0, 64))) * 2;
  const n = Number(BigInt('0x' + d.slice(off, off + 64)));
  return Array.from({ length: n }, (_, i) => d.slice(off + 64 + i * 64, off + 128 + i * 64).toLowerCase());
}
export function decodeEntry(hexRet) {
  const d = strip(hexRet);
  const w = (i) => d.slice(i * 64, i * 64 + 64);
  const str = (off) => { const o = Number(BigInt('0x' + off)) * 2; const l = Number(BigInt('0x' + d.slice(o, o + 64))); return dec.decode(fromHex(d.slice(o + 64, o + 64 + l * 2))); };
  if (d.length < 256) return { url: '', wsAddr: '', updatedAt: 0, announcer: null };
  return { url: str(w(0)), wsAddr: str(w(1)), updatedAt: Number(BigInt('0x' + w(2))), announcer: '0x' + w(3).slice(24) };
}
export function decodeStanding(hexRet) {
  const d = strip(hexRet);
  if (d.length < 192) throw new Error('short standingOf result');
  return { operator: '0x' + d.slice(24, 64), amount: BigInt('0x' + d.slice(64, 128)), active: BigInt('0x' + d.slice(128, 192)) === 1n };
}

const rpcList = (rpc) => [...new Set((Array.isArray(rpc) ? rpc : String(rpc ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean))];

/** eth_call over a list of endpoints. A rate limit (429, or a JSON-RPC "limit" error) backs off with jitter,
 *  honouring Retry-After, and moves to the next endpoint; a transport failure moves at once; a JSON-RPC error
 *  (a revert) is an answer and is thrown as { revert: true } without moving. The endpoint that answered last
 *  is tried first next time. */
const preferred = new Map(); // endpoint list → index of the one that answered last, kept across calls in this process
function rpcClient({ urls, fetchImpl, pace, backoffMs = 500, attempts = null, timeoutMs = 15_000 }) {
  if (!urls.length) throw new Error('findSettler: no RPC endpoint');
  const listKey = urls.join(' ');
  let pref = preferred.get(listKey) ?? 0, id = 0;
  const answered = (k) => { pref = k; preferred.set(listKey, k); };
  const total = attempts ?? urls.length * 3;
  const call = async (to, data) => {
    const problems = [];
    let limits = 0;
    for (let a = 0; a < total; a++) {
      const k = (pref + a) % urls.length, url = urls[k];
      let r, j, rateWait = null;
      try {
        r = await pace(() => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(timeoutMs) }));
        const status = r.status ?? (r.ok ? 200 : 500);
        if (status === 429) rateWait = retryAfterMs(r) ?? 0;
        else {
          j = await readJson(r);
          if (j?.error && RATE_RE.test(String(j.error.message))) rateWait = 0;
          else if (j?.error) { answered(k); throw Object.assign(new Error(`eth_call reverted: ${j.error.message ?? 'error'}`), { revert: true }); }
          else if (j && j.result !== undefined && j.result !== null) { answered(k); return j.result; }
          else problems.push(`${url}: HTTP ${status}${j === undefined ? ' non-JSON' : ' no result'}`);
        }
      } catch (e) {
        if (e.revert) throw e;
        problems.push(`${url}: ${netError(e)}`);
      }
      if (rateWait !== null) { problems.push(`${url}: rate limited`); await sleep(Math.max(Math.min(rateWait, 30_000), backoff(backoffMs, limits++))); }
      else if ((a + 1) % urls.length === 0 && a + 1 < total) await sleep(backoff(backoffMs, Math.floor(a / urls.length))); // every endpoint failed this round: wait before the next
    }
    throw Object.assign(new Error(`RPC unavailable after ${total} attempt(s): ${problems.slice(-3).join('; ')}`), { transient: true });
  };
  return { call, get url() { return urls[pref]; } };
}

const normalizeContracts = (j) => {
  if (!isObj(j)) return null;
  const src = isObj(j.contracts) ? j.contracts : j;
  const pick = (v) => (typeof v === 'string' ? v : v?.address);
  const NodeDirectory = pick(src.NodeDirectory), NodeStake = pick(src.NodeStake);
  if (!NodeDirectory || !NodeStake) return null;
  return { NodeDirectory, NodeStake, generation: Number(j.generation ?? src.generation ?? 0) || null, rpc: j.rpc ?? src.rpc ?? null };
};

/** The live seed list: every NodeDirectory key whose entry is fresh and whose NodeStake standing is active,
 *  newest announcement first. → { seeds: [{ nodeId, url, wsAddr, updatedAt, operator }], keys, via, contracts, rpc } */
export async function readDirectory({ contracts = null, contractsUrl = CONTRACTS_URL, rpc = null, fetch: fetchImpl = globalThis.fetch, keysPage = 'auto', pageSize = 100, concurrency = 4, maxRps = 8, backoffMs = 500, now = Math.floor(Date.now() / 1000) } = {}) {
  let c = contracts ? normalizeContracts(contracts) : null;
  if (contracts && !c) throw new TypeError('contracts: { NodeDirectory, NodeStake } addresses (or the arcade contracts.json shape)');
  let source = contracts ? 'given' : null;
  if (!c) {
    const r = await request(fetchImpl, contractsUrl, { retries: 1, backoffMs, timeoutMs: 5000 });
    c = r.ok ? normalizeContracts(r.body) : null;
    source = c ? contractsUrl : 'default';
    c ??= { ...DEFAULT_CONTRACTS, rpc: null };
  }
  const urls = rpc ? rpcList(rpc) : rpcList([c.rpc, ...DEFAULT_RPCS]);
  const chain = rpcClient({ urls, fetchImpl, pace: pacer({ concurrency, maxRps }), backoffMs });

  let keys = null, via = 'keys';
  if (keysPage === true || (keysPage === 'auto' && (c.generation ?? 0) >= 4)) {
    try {
      keys = [];
      for (let off = 0; ; off += pageSize) {
        const page = decodeBytes32Array(await chain.call(c.NodeDirectory, SELECTORS.keysPage + word(off) + word(pageSize)));
        keys.push(...page);
        if (page.length < pageSize || off > 1_000_000) break;
      }
      via = 'keysPage';
    } catch { keys = null; } // no keysPage on this contract (or it failed): the whole list instead
  }
  if (!keys) keys = decodeBytes32Array(await chain.call(c.NodeDirectory, SELECTORS.keys));
  keys = [...new Set(keys)];

  const rows = await pool(keys, concurrency, async (k) => {
    try {
      const e = decodeEntry(await chain.call(c.NodeDirectory, SELECTORS.entryOf + k));
      if (!e.url || now - e.updatedAt > FRESH_S) return null; // no standing read for an entry that is not a seed anyway
      const s = decodeStanding(await chain.call(c.NodeStake, SELECTORS.standingOf + k));
      return s.active ? { nodeId: k, url: trim(e.url), wsAddr: e.wsAddr || null, updatedAt: e.updatedAt, operator: s.operator } : null;
    } catch (e) { if (e.revert) return null; throw e; }
  });
  const seeds = rows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  return { seeds, keys: keys.length, via, contracts: { NodeDirectory: c.NodeDirectory, NodeStake: c.NodeStake, generation: c.generation, source }, rpc: chain.url };
}

const newNonce = () => toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/** Does `url` prove node key `nodeId`? GET /whoami?nonce → sig = ed25519('whoami', { nodeId, nonce, addr, at[, digest] }). */
export async function proveNode(url, nodeId, { fetch: fetchImpl = globalThis.fetch, maxSkewMs = 120_000, timeoutMs = 8000, backoffMs = 500 } = {}) {
  const nonce = newNonce();
  const r = await request(fetchImpl, `${trim(url)}/whoami?nonce=${nonce}`, { retries: 1, backoffMs, timeoutMs });
  if (!r.ok || !isObj(r.body)) return { ok: false, reason: r.error ?? 'no answer' };
  const a = r.body;
  if (a.nodeId !== nodeId) return { ok: false, reason: 'identity' };
  if (a.nonce !== nonce) return { ok: false, reason: 'nonce' };
  if (typeof a.at !== 'number' || Math.abs(Date.now() - a.at) > maxSkewMs) return { ok: false, reason: 'stale' };
  const { sig, ...body } = a;
  return (await verifySignature(WHOAMI_TAG, body, sig, nodeId)) ? { ok: true } : { ok: false, reason: 'signature' };
}

/** A live node to settle `rulesetId` on: bonded and freshly announced on NodeDirectory, /health lists the
 *  ruleset and a settling role, /whoami proves the key the directory names. Newest announcement wins.
 *  Throws when there is none; the message lists every seed tried and why it was passed over.
 *  → { url, nodeId, operator, updatedAt, protocol, version, roles, candidates, tried: [{ url, reason }], via, rpc, contracts } */
export async function findSettler({ rulesetId = null, contracts = null, contractsUrl = CONTRACTS_URL, rpc = null, fetch: fetchImpl = globalThis.fetch, exclude = [], concurrency = 4, maxRps = 8, backoffMs = 500, keysPage = 'auto', timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('findSettler: no fetch');
  const dir = await readDirectory({ contracts, contractsUrl, rpc, fetch: fetchImpl, keysPage, concurrency, maxRps, backoffMs });
  const skip = new Set(exclude.map((x) => trim(String(x).toLowerCase())));
  const seeds = dir.seeds.filter((s) => !skip.has(s.nodeId) && !skip.has(s.url.toLowerCase()));
  const probe = async (s) => {
    const h = await request(fetchImpl, `${s.url}/health`, { retries: 1, backoffMs, timeoutMs });
    if (!h.ok || !isObj(h.body)) return { reason: h.error ?? 'no health' };
    const b = h.body;
    if (b.nodeId && b.nodeId !== s.nodeId) return { reason: 'answers as another node' };
    if (rulesetId && !b.rulesets?.[rulesetId]) return { reason: `does not host ${rulesetId}` };
    const roles = Array.isArray(b.roles) ? b.roles : [];
    if (!roles.some((r) => SETTLING_ROLES.includes(r))) return { reason: 'no settling role' };
    const p = await proveNode(s.url, s.nodeId, { fetch: fetchImpl, timeoutMs, backoffMs });
    if (!p.ok) return { reason: `proof ${p.reason}` };
    return { ok: true, protocol: Number(b.protocol ?? 1), version: b.version ?? null, roles };
  };
  const tried = [];
  // Newest first, `concurrency` probes at a time; the first seed in order that passes wins.
  for (let i = 0; i < seeds.length; i += concurrency) {
    const batch = seeds.slice(i, i + concurrency);
    const out = await Promise.all(batch.map((s) => probe(s).catch((e) => ({ reason: netError(e) }))));
    for (let k = 0; k < batch.length; k++) {
      const s = batch[k], r = out[k];
      if (r.ok) return { url: s.url, nodeId: s.nodeId, operator: s.operator, updatedAt: s.updatedAt, wsAddr: s.wsAddr, protocol: r.protocol, version: r.version, roles: r.roles, candidates: seeds.length, tried, via: dir.via, rpc: dir.rpc, contracts: dir.contracts };
      tried.push({ url: s.url, reason: r.reason });
    }
  }
  throw Object.assign(new Error(`no live node${rulesetId ? ` hosting ${rulesetId}` : ''} on NodeDirectory (${seeds.length} seed(s): ${tried.map((t) => `${t.url}: ${t.reason}`).join('; ') || 'none announced'})`), { tried, candidates: seeds.length });
}

// ------------------------------------------------------------------ settle

/** Post one envelope. Never throws for a network failure; throws only for a caller error (a log that is too big
 *  or does not hash to report.commitments.inputsHash).
 *
 *  node      an origin (http://127.0.0.1:7801), a findSettler() result, or 'auto' (default): findSettler for the
 *            envelope's ruleset, with `discovery` as its options.
 *  log       the exact log bytes. Attached as base64 `log` only when the node's /health says protocol >= 4.
 *
 *  → { status: 'settled' | 'already' | 'refused' | 'unreachable', matchId, node, delta?, error?, httpStatus?, protocol?, logAttached }
 *    already      the node held this matchId before (its delta, which may not be this envelope's)
 *    refused      the node answered and will not settle it (400: the reason; 403: no settling role) — resending will not help
 *    unreachable  no answer worth acting on after `retries` (network, timeout, 429, 5xx): try later or another node */
export async function settle(env, { node = 'auto', log = null, fetch: fetchImpl = globalThis.fetch, retries = 3, backoffMs = 500, timeoutMs = 30_000, discovery = {} } = {}) {
  if (!isObj(env) || typeof env.matchId !== 'string' || !env.matchId) throw new TypeError('settle: an envelope with a matchId');
  const matchId = env.matchId;
  let logBytes = null;
  if (log != null) {
    logBytes = toBytes(log);
    if (logBytes.length > LOG_MAX_BYTES) throw new RangeError(`settle: log is ${logBytes.length} bytes; a node takes at most ${LOG_MAX_BYTES}`);
    const want = env.report?.commitments?.inputsHash, got = await inputsHash(logBytes);
    if (want !== got) throw new Error(`settle: the log hashes to ${got}, report.commitments.inputsHash is ${want ?? 'missing'}`);
  }
  let base;
  if (!node || node === 'auto') {
    try { base = (await findSettler({ rulesetId: env.rulesetId ?? null, fetch: fetchImpl, backoffMs, ...discovery })).url; }
    catch (e) { return { status: 'unreachable', matchId, node: null, error: e.message, logAttached: false }; }
  } else base = trim(typeof node === 'string' ? node : node.url);
  const out = (o) => ({ matchId, node: base, logAttached: false, ...o });

  const h = await request(fetchImpl, `${base}/health`, { retries, backoffMs, timeoutMs: Math.min(timeoutMs, 10_000) });
  if (!h.ok || !isObj(h.body)) return out({ status: 'unreachable', error: `health: ${h.error ?? 'not JSON'}`, httpStatus: h.status });
  const protocol = Number(h.body.protocol ?? 1);

  // A matchId settles once. Asking first keeps a resend from carrying the log again and labels it honestly.
  const have = await request(fetchImpl, `${base}/delta/${encodeURIComponent(matchId)}`, { timeoutMs: Math.min(timeoutMs, 10_000) });
  if (have.ok && isObj(have.body)) return out({ status: 'already', delta: have.body, protocol });

  const attach = !!logBytes && protocol >= LOG_PROTOCOL;
  const body = attach ? { ...env, log: encodeLog(logBytes) } : env;
  const p = await request(fetchImpl, `${base}/ledger`, { method: 'POST', body: JSON.stringify(body), retries, backoffMs, timeoutMs });
  if (p.ok && isObj(p.body)) {
    // The node answers a matchId it already settled with that delta: another court's (or another report's) is not ours.
    const theirs = p.body.attestor && env.attestor?.id && p.body.attestor !== env.attestor.id;
    return out({ status: theirs ? 'already' : 'settled', delta: p.body, protocol, logAttached: attach && !theirs });
  }
  if (p.status && p.status >= 400 && p.status < 500 && p.status !== 408 && p.status !== 429) return out({ status: 'refused', error: p.error, httpStatus: p.status, protocol });
  return out({ status: 'unreachable', error: p.error, httpStatus: p.status, protocol });
}
