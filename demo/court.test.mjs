/** sdk/court — the court client a studio imports for an attested title: byte-equal signing with the node's
 *  protocol, hard-coded selectors that match keccak, the v4 log commitment and its cap, discovery from a mocked
 *  chain (RPC fail-over, 429 backoff, bounded concurrency, keysPage), settle()'s outcomes, and an end-to-end
 *  settle on a real in-process node for a v3-shaped report and one carrying commitments + stats.
 *    node --test demo/court.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair, sign, verify, signingBytes as protoSigningBytes } from '../protocol/keys.js';
import { canonical as protoCanonical } from '../protocol/canonical.js';
import { selector } from '../protocol/keccak.js';
import { KEYS, ENTRY_OF } from '../protocol/directory.js';
import { STANDING_OF } from '../protocol/staking.js';
import { answerChallenge } from '../protocol/challenge.js';
import { ATTEST_TAG } from '../node/settle.js';
import * as court from '../sdk/court/index.js';

const { canonical, signReport, envelope, attest, inputsHash, encodeLog, decodeLog, makeCommitments, checkReport, findSettler, readDirectory, settle, SELECTORS, LOG_MAX_BYTES, DEFAULT_CONTRACTS } = court;
const PB = join(process.cwd(), 'rulesets', 'pickle-brawl.v1.js');
const { seats } = await import(pathToFileURL(PB).href);
const pbReport = (matchId, scoreA = 11, scoreB = 6, extra = {}) => ({ matchId, mode: 'singles', scoreA, scoreB, winnerTeam: scoreA > scoreB ? 0 : 1, courtUrl: 'wss://court.test', ticks: 4000, claims: [{ sub: 'air:ana', team: 0, slot: 0 }, { sub: 'air:bo', team: 1, slot: 0 }], ...extra });

// ------------------------------------------------------------- mocks
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
// ABI (string url, string wsAddr, uint64 updatedAt, address announcer)
const encEntry = (url, at) => { const u = Buffer.from(url, 'utf8'); const s1 = w(u.length) + u.toString('hex').padEnd(Math.ceil(u.length / 32) * 64, '0'); return '0x' + w(0x80) + w(0x80 + s1.length / 2) + w(at) + w(0) + s1 + w(0); };
const encKeys = (ks) => '0x' + w(0x20) + w(ks.length) + ks.join('');
const encStanding = (active) => '0x' + w(0xabc) + w(10n ** 18n) + w(active ? 1 : 0);
const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const DIR = '0x' + '11'.repeat(20), STAKE = '0x' + '22'.repeat(20);

test('signReport is byte-equal to protocol/keys.js sign(attest) over protocol/canonical.js', async () => {
  const kp = await generateKeypair();
  const reports = [
    pbReport('m-1'),
    { z: 1, a: { y: [3, { b: 2, a: 1 }], x: 'ü€😀' }, gone: undefined, n: -0.5, t: true, nil: null },
    { ...pbReport('m-2'), commitments: { logFormat: 'pb-inputs.v1', inputsHash: 'ab'.repeat(32), finalHash: null, verifierHash: 'cd'.repeat(32) }, stats: { 'pb:air:ana': { rallies: 12, aces: 3 } } },
  ];
  for (const report of reports) {
    const body = { matchId: 'match-ü', rulesetId: 'pickle-brawl.v1', report };
    assert.equal(canonical(body), protoCanonical(body));
    assert.deepEqual(court.signingBytes(ATTEST_TAG, body), protoSigningBytes(ATTEST_TAG, body));
    const mine = await signReport(body, kp);
    assert.deepEqual(mine, { id: kp.publicKey, sig: await sign(ATTEST_TAG, body, kp.privateKey) }, 'ed25519 is deterministic: same bytes, same signature');
    assert.ok(await verify(ATTEST_TAG, body, mine.sig, kp.publicKey));
  }
  assert.equal(court.ATTEST_TAG, ATTEST_TAG);
  // a signer held elsewhere (KMS/HSM): same signature from sign(bytes)
  const body = { matchId: 'm-k', rulesetId: 'pickle-brawl.v1', report: pbReport('m-k') };
  const remote = { publicKey: kp.publicKey, sign: async (bytes) => { assert.deepEqual(bytes, protoSigningBytes(ATTEST_TAG, body)); return (await signReport(body, kp)).sig; } };
  assert.deepEqual(await signReport(body, remote), await signReport(body, kp));
  // halves that do not belong together are caught before any node refuses them
  const other = await generateKeypair();
  await assert.rejects(signReport(body, { publicKey: other.publicKey, privateKey: kp.privateKey }), /not the key of this privateKey/);
  await assert.rejects(signReport(body, { publicKey: 'xx', privateKey: kp.privateKey }), /identity/);
  const env = await attest({ ...body, mode: 'casual', ...seats(body.report) }, kp);
  assert.ok(await court.verifyEnvelope(env));
  assert.equal(await court.verifyEnvelope({ ...env, report: { ...env.report, scoreA: 12 } }), false);
});

test('selectors and default contracts match protocol/keccak.js, protocol/directory.js, protocol/staking.js and the arcade', () => {
  assert.equal(SELECTORS.keys, selector(KEYS));
  assert.equal(SELECTORS.entryOf, selector(ENTRY_OF));
  assert.equal(SELECTORS.standingOf, selector(STANDING_OF));
  assert.equal(SELECTORS.keysPage, selector('keysPage(uint256,uint256)'));
  const arcade = JSON.parse(readFileSync(join(process.cwd(), 'cabinet', 'contracts.json'), 'utf8'));
  assert.equal(DEFAULT_CONTRACTS.NodeDirectory, arcade.contracts.NodeDirectory.address);
  assert.equal(DEFAULT_CONTRACTS.NodeStake, arcade.contracts.NodeStake.address);
  assert.ok(court.DEFAULT_RPCS.includes(arcade.rpc));
  assert.deepEqual(court.SETTLING_ROLES, ['host', 'settler', 'relay']);
});

test('input log: sha256 of the exact bytes, base64 round trip, 512 KiB cap; commitments and stats shape', async () => {
  const log = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
  assert.equal(await inputsHash(log), createHash('sha256').update(log).digest('hex'));
  assert.equal(await inputsHash('abc'), createHash('sha256').update('abc').digest('hex'));
  assert.equal(await inputsHash(log.buffer), await inputsHash(Buffer.from(log)));
  assert.equal(encodeLog(log), Buffer.from(log).toString('base64'));
  assert.deepEqual(decodeLog(encodeLog(log)), log);
  const max = new Uint8Array(LOG_MAX_BYTES).fill(0xa5);
  assert.deepEqual(decodeLog(encodeLog(max)), max, 'exactly 512 KiB is allowed');
  assert.throws(() => encodeLog(new Uint8Array(LOG_MAX_BYTES + 1)), RangeError);
  await assert.rejects(makeCommitments({ logFormat: 'x', log: new Uint8Array(LOG_MAX_BYTES + 1) }), RangeError);
  assert.deepEqual(await makeCommitments({ logFormat: 'pb-inputs.v1', log, finalHash: 'f' }), { logFormat: 'pb-inputs.v1', inputsHash: await inputsHash(log), finalHash: 'f', verifierHash: null });
  assert.equal((await makeCommitments({ logFormat: 'none' })).inputsHash, null);

  assert.deepEqual(checkReport(pbReport('m')), [], 'a v3 report has nothing to check');
  assert.deepEqual(checkReport({ commitments: { logFormat: 'x', inputsHash: null, finalHash: null, verifierHash: null }, stats: { a: { kills: 0, wallHits: 3 } } }, ['a', 'b']), []);
  const bad = checkReport({ commitments: { logFormat: '', inputsHash: 'AB'.repeat(32), finalHash: 3 }, stats: { c: { '1x': 1, ok: -1, f: 1.5 }, a: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, 1])) } }, ['a', 'b']);
  for (const re of [/logFormat/, /inputsHash/, /finalHash/, /verifierHash/, /stats\.c: not a participant/, /1x: names match/, /ok: a non-negative integer/, /f: a non-negative integer/, /at most 32 names/]) assert.ok(bad.some((e) => re.test(e)), `${re} in ${bad.join(' | ')}`);
  assert.throws(() => envelope({ matchId: 'm', rulesetId: 'Bad', participants: ['a', 'a'], teams: [['a'], ['b']], report: {}, attestor: { id: 'x', sig: 'y' } }), (e) => /rulesetId/.test(e.message) && /duplicate/.test(e.message) && /attestor/.test(e.message));
  const one = envelope({ matchId: 'fc-1', rulesetId: 'flood-control.v1', participants: ['fc:p'], teams: [['fc:p'], []], report: {}, attestor: { id: 'a'.repeat(64), sig: 'b'.repeat(128) } });
  assert.equal(one.mode, 'casual'); assert.equal(one.kind, 'attested'); assert.equal('log' in one, false);
});

/** A chain + nodes mock. Seeds (updatedAt descending among the live ones): noRole, liar, good (429s once on /health,
 *  protocol 4), older. Plus one unbonded (newest) and one stale. rpc-a is down; rpc-b 429s its first call. */
async function mesh({ generation = 3, keysPageReverts = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const names = ['unbonded', 'stale', 'noRole', 'liar', 'good', 'older'];
  const kps = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await generateKeypair()])));
  const impostor = await generateKeypair();
  const at = { unbonded: now - 1, stale: now - 8 * 24 * 3600, noRole: now - 10, liar: now - 20, good: now - 30, older: now - 40 };
  const byKey = Object.fromEntries(names.map((n) => [kps[n].publicKey, n]));
  const keys = names.map((n) => kps[n].publicKey);
  const stats = { rpcA: 0, rpcB: 0, rpc429: 0, health429: 0, inflight: 0, maxInflight: 0, starts: [], methods: [] };
  let first = true;
  const fetchImpl = async (url, init) => {
    url = String(url);
    if (url === 'http://rpc-a.test') { stats.rpcA++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }
    if (url === 'http://rpc-b.test') {
      stats.rpcB++; stats.starts.push(Date.now());
      stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (first) { first = false; stats.rpc429++; return reply(429, 'Too Many Requests', { 'retry-after': '0' }); }
        const { to, data } = JSON.parse(init.body).params[0];
        const sel = data.slice(0, 10), arg = data.slice(10);
        stats.methods.push(sel);
        if (sel === SELECTORS.keysPage) {
          if (keysPageReverts || generation < 4) return reply(200, { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } });
          const off = Number(BigInt('0x' + arg.slice(0, 64))), lim = Number(BigInt('0x' + arg.slice(64, 128)));
          return reply(200, { result: encKeys(keys.slice(off, off + lim)) });
        }
        if (sel === SELECTORS.keys) { assert.equal(to, DIR); return reply(200, { result: encKeys(keys) }); }
        const n = byKey[arg];
        if (sel === SELECTORS.entryOf) return reply(200, { result: encEntry(`http://${n.toLowerCase()}.test/`, at[n]) });
        if (sel === SELECTORS.standingOf) { assert.equal(to, STAKE); return reply(200, { result: encStanding(n !== 'unbonded') }); }
        return reply(200, { error: { message: 'execution reverted' } });
      } finally { stats.inflight--; }
    }
    const u = new URL(url);
    const n = names.find((x) => u.origin === `http://${x.toLowerCase()}.test`);
    if (!n) throw new TypeError('fetch failed');
    if (u.pathname === '/health') {
      if (n === 'good' && !stats.health429) { stats.health429++; return reply(429, { error: 'slow down' }, { 'retry-after': '0' }); }
      return reply(200, { nodeId: kps[n].publicKey, protocol: n === 'good' ? 4 : 3, version: '0.12.0', roles: n === 'noRole' ? ['mesh', 'witness'] : n === 'good' ? ['mesh', 'host'] : ['mesh', 'settler'], rulesets: { 'pickle-brawl.v1': 'h' } });
    }
    if (u.pathname === '/whoami') return reply(200, await answerChallenge({ nodeId: kps[n].publicKey, nonce: u.searchParams.get('nonce'), addr: u.origin }, (n === 'liar' ? impostor : kps[n]).privateKey));
    return reply(404, { error: 'not found' });
  };
  return { kps, fetchImpl, stats };
}

test('findSettler: fresh, bonded, hosts the ruleset, settles, proves its key — RPC fail-over, 429 backoff, bounded concurrency', async () => {
  const m = await mesh();
  const opts = { rulesetId: 'pickle-brawl.v1', contracts: { NodeDirectory: DIR, NodeStake: STAKE }, rpc: ['http://rpc-a.test', 'http://rpc-b.test'], fetch: m.fetchImpl, backoffMs: 1, concurrency: 2, maxRps: 100 };
  const s = await findSettler(opts);
  assert.equal(s.url, 'http://good.test', 'host role counts as settling; the newer seeds fail');
  assert.equal(s.nodeId, m.kps.good.publicKey);
  assert.equal(s.protocol, 4);
  assert.equal(s.candidates, 4, 'unbonded and stale are not seeds');
  assert.deepEqual(s.tried, [{ url: 'http://norole.test', reason: 'no settling role' }, { url: 'http://liar.test', reason: 'proof signature' }]);
  assert.equal(s.via, 'keys', 'generation 3: keys()');
  assert.equal(s.rpc, 'http://rpc-b.test', 'stays on the endpoint that answers');
  const rpcA = m.stats.rpcA; assert.ok(rpcA >= 1 && rpcA <= 2, 'the down endpoint is tried only while finding one that answers');
  assert.equal(m.stats.rpc429, 1); assert.equal(m.stats.health429, 1, 'a 429 is retried after backoff, not counted as a dead node');
  const s2 = await findSettler(opts); assert.equal(s2.url, 'http://good.test'); assert.equal(m.stats.rpcA, rpcA, 'then the endpoint that answered is preferred');
  assert.ok(m.stats.maxInflight <= 2, `at most 2 RPC calls in flight (saw ${m.stats.maxInflight})`);
  const gaps = m.stats.starts.slice(1).map((t, i) => t - m.stats.starts[i]);
  assert.ok(Math.min(...gaps) >= 9, `requests are spaced for maxRps (min gap ${Math.min(...gaps)} ms)`);
  assert.ok(!m.stats.methods.includes(SELECTORS.keysPage));
  // the stale entry's standing is never read: 5 standings per run, two runs
  assert.equal(m.stats.methods.filter((x) => x === SELECTORS.standingOf).length, 10);

  const again = await findSettler({ ...opts, exclude: ['http://good.test'] });
  assert.equal(again.url, 'http://older.test', 'exclude passes over a node (say, one that refused)');
  await assert.rejects(findSettler({ ...opts, rulesetId: 'tug.v1' }), /no live node hosting tug.v1 on NodeDirectory \(4 seed\(s\): http:\/\/norole.test: does not host tug.v1/);
  await assert.rejects(findSettler({ ...opts, rpc: ['http://rpc-a.test'] }), /RPC unavailable after 3 attempt/);
});

test('readDirectory: keysPage on generation 4, keys() when it reverts; contracts.json supplies the set and its rpc', async () => {
  const m4 = await mesh({ generation: 4 });
  const d4 = await readDirectory({ contracts: { generation: 4, contracts: { NodeDirectory: { address: DIR }, NodeStake: { address: STAKE } } }, rpc: 'http://rpc-b.test', fetch: m4.fetchImpl, pageSize: 4, backoffMs: 1, maxRps: 0 });
  assert.equal(d4.via, 'keysPage'); assert.equal(d4.keys, 6); assert.equal(d4.seeds.length, 4);
  assert.equal(m4.stats.methods.filter((x) => x === SELECTORS.keysPage).length, 2, 'two pages of 4');
  const mr = await mesh({ generation: 4, keysPageReverts: true });
  const dr = await readDirectory({ contracts: { generation: 4, NodeDirectory: DIR, NodeStake: STAKE }, rpc: 'http://rpc-b.test', fetch: mr.fetchImpl, backoffMs: 1, maxRps: 0 });
  assert.equal(dr.via, 'keys'); assert.equal(dr.seeds.length, 4);
  const m3 = await mesh();
  const viaUrl = await readDirectory({ contractsUrl: 'http://arcade.test/contracts.json', fetch: async (url, init) => (String(url) === 'http://arcade.test/contracts.json' ? reply(200, { generation: 3, rpc: 'http://rpc-b.test', contracts: { NodeDirectory: { address: DIR }, NodeStake: { address: STAKE } } }) : m3.fetchImpl(url, init)), backoffMs: 1, maxRps: 0 });
  assert.equal(viaUrl.contracts.source, 'http://arcade.test/contracts.json'); assert.equal(viaUrl.rpc, 'http://rpc-b.test'); assert.equal(viaUrl.seeds[0].url, 'http://norole.test');
});

test('settle against mocked nodes: log only for protocol >= 4, 429 retried, already, refused, unreachable never throws', async () => {
  const kp = await generateKeypair();
  const log = new TextEncoder().encode('{"k":0,"inputs":[1,2]}\n'.repeat(50));
  const report = pbReport('v4-1', 11, 6, { commitments: await makeCommitments({ logFormat: 'jsonl.v1', log, finalHash: 'ff'.repeat(32), verifierHash: null }), stats: { 'pb:air:ana': { aces: 2 } } });
  const env = await attest({ matchId: 'v4-1', rulesetId: 'pickle-brawl.v1', ...seats(report), report }, kp);
  const node = (protocol, { ledger = [], delta = null } = {}) => {
    const posted = [];
    return { posted, fetch: async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/health') return reply(200, { nodeId: 'n', protocol, roles: ['settler'], rulesets: {} });
      if (u.pathname.startsWith('/delta/')) return delta ? reply(200, delta) : reply(404, { error: 'unknown match' });
      if (u.pathname === '/ledger') { posted.push(JSON.parse(init.body)); const [s, b] = ledger.shift() ?? [200, { matchId: env.matchId, attestor: kp.publicKey, attestation: 'attested' }]; return reply(s, b); }
      return reply(404, {});
    } };
  };
  const v4 = node(4, { ledger: [[429, { error: 'budget' }]] });
  const r4 = await settle(env, { node: 'http://v4.test/', log, fetch: v4.fetch, backoffMs: 1 });
  assert.equal(r4.status, 'settled'); assert.equal(r4.logAttached, true); assert.equal(r4.protocol, 4); assert.equal(r4.node, 'http://v4.test');
  assert.equal(v4.posted.length, 2, 'the 429 was retried');
  assert.deepEqual(decodeLog(v4.posted[1].log), log); assert.equal(await inputsHash(decodeLog(v4.posted[1].log)), report.commitments.inputsHash);
  const v3 = node(3);
  const r3 = await settle(env, { node: 'http://v3.test', log, fetch: v3.fetch, backoffMs: 1 });
  assert.equal(r3.status, 'settled'); assert.equal(r3.logAttached, false); assert.equal('log' in v3.posted[0], false, 'a protocol-3 node never gets a log');
  await assert.rejects(settle(env, { node: 'http://v4.test', log: new Uint8Array([1, 2, 3]), fetch: v4.fetch }), /hashes to/);
  await assert.rejects(settle(env, { node: 'http://v4.test', log: new Uint8Array(LOG_MAX_BYTES + 1), fetch: v4.fetch }), RangeError);

  const held = node(4, { delta: { matchId: env.matchId, attestor: kp.publicKey } });
  const ra = await settle(env, { node: 'http://held.test', log, fetch: held.fetch });
  assert.equal(ra.status, 'already'); assert.equal(held.posted.length, 0, 'nothing re-sent, the log least of all');
  const theirs = node(4, { ledger: [[200, { matchId: env.matchId, attestor: 'e'.repeat(64) }]] });
  assert.equal((await settle(env, { node: 'http://t.test', fetch: theirs.fetch })).status, 'already', "the node answered with another court's delta");
  const ro = await settle(env, { node: 'http://r.test', fetch: node(4, { ledger: [[403, { error: 'this node has no settling role' }]] }).fetch });
  assert.deepEqual([ro.status, ro.httpStatus, ro.error], ['refused', 403, 'this node has no settling role']);
  const rb = await settle(env, { node: 'http://r.test', fetch: node(4, { ledger: [[400, { error: 'report rejected: win by two' }]] }).fetch });
  assert.deepEqual([rb.status, rb.error], ['refused', 'report rejected: win by two']);
  const busy = node(4, { ledger: [[429, {}], [429, {}], [503, {}]] });
  const rr = await settle(env, { node: 'http://busy.test', fetch: busy.fetch, retries: 2, backoffMs: 1 });
  assert.equal(rr.status, 'unreachable'); assert.equal(rr.httpStatus, 503); assert.equal(busy.posted.length, 3);
  let calls = 0;
  const down = await settle(env, { node: 'http://down.test', fetch: async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, retries: 1, backoffMs: 1 });
  assert.deepEqual([down.status, down.error], ['unreachable', 'health: ENOTFOUND']); assert.equal(calls, 2);
  const tunnelPage = await settle(env, { node: 'http://tp.test', fetch: async () => reply(200, '<html>tunnel error</html>'), retries: 0 });
  assert.equal(tunnelPage.status, 'unreachable', 'an HTML page is not a node');
  const lost = await settle(env, { fetch: async () => { throw new TypeError('fetch failed'); }, discovery: { contracts: { NodeDirectory: DIR, NodeStake: STAKE }, rpc: 'http://rpc.test', backoffMs: 1 } });
  assert.equal(lost.status, 'unreachable'); assert.match(lost.error, /RPC unavailable/);
});

test('end to end on a real node: v3-shaped report and one with commitments + stats settle `attested`; resend is already; refusals', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-court-'));
  const kp = await generateKeypair();
  const stranger = await generateKeypair();
  const courts = { 'pickle-brawl.v1': [kp.publicKey] };
  const node = await createNode({ dataDir: join(tmp, 'studio'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'settler'], rulesets: [PB], courts });
  const witness = await createNode({ dataDir: join(tmp, 'guild'), offline: true, heartbeatMs: 200, operator: 'guild', roles: ['mesh', 'witness'], rulesets: [PB], courts });
  t.after(async () => { await node.stop(); await witness.stop(); rmSync(tmp, { recursive: true, force: true }); });
  const make = async (report, key = kp) => attest({ matchId: report.matchId, rulesetId: 'pickle-brawl.v1', ...seats(report), report }, key);

  // v3-shaped: the report as Pickle Brawl's court sends it today
  const e1 = await make(pbReport('court-e2e-1'));
  const r1 = await settle(e1, { node: node.addr });
  assert.equal(r1.status, 'settled', JSON.stringify(r1));
  assert.equal(r1.delta.attestation, 'attested'); assert.equal(r1.delta.attestor, kp.publicKey); assert.equal(r1.delta.scores['pb:air:ana'], 11);
  assert.equal(r1.protocol, node.protocol);
  const again = await settle(e1, { node: node.addr });
  assert.equal(again.status, 'already'); assert.equal(again.delta.hostSig, r1.delta.hostSig);

  // settlement v4 fields inside the signed report: safe on this node version
  const log = new TextEncoder().encode('tick,0,1\n'.repeat(400));
  const report = pbReport('court-e2e-2', 7, 11, { commitments: await makeCommitments({ logFormat: 'pb-csv.v1', log, finalHash: 'aa'.repeat(32), verifierHash: null }), stats: { 'pb:air:ana': { rallies: 30, aces: 1 }, 'pb:air:bo': { rallies: 30, aces: 4 } } });
  const e2 = await make(report);
  const r2 = await settle(e2, { node: node.addr, log });
  assert.equal(r2.status, 'settled', JSON.stringify(r2));
  assert.equal(r2.logAttached, node.protocol >= 4, 'the log rides only to a node that takes it');
  assert.equal(r2.delta.scores['pb:air:bo'], 11);
  const ledger = await (await fetch(`${node.addr}/ledger/court-e2e-2`)).json();
  assert.deepEqual(ledger.report.commitments, report.commitments); assert.deepEqual(ledger.report.stats, report.stats);

  const bad = await settle(await make(pbReport('court-e2e-3', 11, 10)), { node: node.addr });
  assert.equal(bad.status, 'refused'); assert.match(bad.error, /win by two/);
  const notCourt = await settle(await make(pbReport('court-e2e-4'), stranger), { node: node.addr });
  assert.equal(notCourt.status, 'refused'); assert.match(notCourt.error, /not an authorized court/);
  const noRole = await settle(await make(pbReport('court-e2e-5')), { node: witness.addr });
  assert.deepEqual([noRole.status, noRole.httpStatus], ['refused', 403]);

  // discovery against the real node's /health and /whoami, the chain mocked: the witness is newer but cannot settle
  const now = Math.floor(Date.now() / 1000);
  const entries = { [node.nodeId]: encEntry(node.addr, now - 60), [witness.nodeId]: encEntry(witness.addr, now - 5) };
  const chainFetch = async (url, init) => {
    if (String(url) !== 'http://rpc.test') return fetch(url, init);
    const data = JSON.parse(init.body).params[0].data;
    if (data.startsWith(SELECTORS.keys)) return reply(200, { result: encKeys([witness.nodeId, node.nodeId]) });
    if (data.startsWith(SELECTORS.entryOf)) return reply(200, { result: entries[data.slice(10)] });
    return reply(200, { result: encStanding(true) });
  };
  const auto = await settle(await make(pbReport('court-e2e-6')), { fetch: chainFetch, discovery: { contracts: { NodeDirectory: DIR, NodeStake: STAKE }, rpc: 'http://rpc.test', maxRps: 0 } });
  assert.equal(auto.status, 'settled', JSON.stringify(auto)); assert.equal(auto.node, node.addr);
});
