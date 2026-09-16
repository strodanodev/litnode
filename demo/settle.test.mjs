/** Settlement end to end on two nodes: a player-signed ledger settles on the
 *  host, the witness replays independently and co-signs over gossip, the
 *  ladder derives, the hour's tree carries the leaf with a verifiable proof.
 *  Then a tampered ledger is refused and a same-node co-sign is refused.
 *    node --test demo/settle.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import { createLog, ledgerBody, signLedger } from '../protocol/log.js';
import { verifyProof } from '../protocol/epoch.js';
import { agent, hydrationManifest } from '../protocol/erc6699.js';
import { h } from '../protocol/canonical.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(100); } return false; };
const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);
const tmp = mkdtempSync(join(tmpdir(), 'litnode-settle-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));

/** Play a match with the built-in AI and produce a player-signed submission. */
async function playSigned(matchId, kps) {
  const P = kps.map((k) => k.publicKey);
  const agents = { [P[0]]: agent({ tokenId: 1, stats: { strength: 30000, agility: 58000, resilience: 20000, intelligence: 40000 }, manifest: { soulManifestHash: 'aa' } }),
                   [P[1]]: agent({ tokenId: 2, stats: { strength: 65535, agility: 5000, resilience: 60000, intelligence: 1000 }, manifest: { soulManifestHash: 'bb' } }) };
  const s = title.init(h('seed', matchId), P, { agents });
  const ai = [engine.createAi(0, 60, 11), engine.createAi(1, 60, 99)];
  const log = createLog();
  while (!title.done(s)) { const fr = [engine.aiPoll(ai[0], s), engine.aiPoll(ai[1], s)]; log.append(fr); title.step(s, { [P[0]]: fr[0], [P[1]]: fr[1] }); }
  const hm = hydrationManifest({ agents: [agents[P[0]], agents[P[1]]], mode: 'ranked', balanceVersion: balance.version });
  const body = ledgerBody({ matchId, ticks: log.length, head: log.head, buildHash: manifest.buildHash, hydrationHash: hm.manifestHash });
  const signatures = Object.fromEntries(await Promise.all(kps.map(async (k) => [k.publicKey, await signLedger(body, k)])));
  return { matchId, rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash, mode: 'ranked', participants: P, entries: log.entries(), signatures, hydration: { agents } };
}

test('settle: signed ledger → delta → witness co-sign → ladder → epoch proof; tamper refused', { timeout: 90_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET] });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr] });
  assert.ok(await until(() => wit.rulesets()['agent-fighter.v1']), 'witness hydrates the ruleset');

  const kps = await Promise.all([generateKeypair(), generateKeypair()]);
  const sub = await playSigned('m-signed-1', kps);
  const r = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(sub) });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const delta = JSON.parse(text);
  assert.equal(delta.attestation, 'players');
  assert.equal(delta.hostId, host.nodeId);
  assert.equal(delta.ticks, sub.entries.length);

  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/m-signed-1`)).json()).cosigners.length === 1, 20_000), 'witness co-signs over gossip');
  const signed = await (await fetch(`${host.addr}/delta/m-signed-1`)).json();
  assert.deepEqual(signed.cosigners, [wit.nodeId]);

  const lb = await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1`)).json();
  assert.equal(lb.leaderboard.length, 2);
  assert.equal(lb.deriveVersion, 2);
  const stats = await (await fetch(`${host.addr}/stats?ruleset=agent-fighter.v1&player=${kps[0].publicKey}`)).json();
  assert.equal(stats.matches, 1);

  const ep = await (await fetch(`${host.addr}/epoch`)).json();
  assert.equal(ep.count, 1);
  assert.ok(ep.anchorCalldata.startsWith('0xbc978154'));
  const pr = await (await fetch(`${host.addr}/proof/m-signed-1`)).json();
  assert.ok(verifyProof(pr.leaf, pr.path, ep.root));

  // Tampered: one input changed, same signatures → refused before replay.
  const bad = { ...sub, matchId: 'm-tampered', entries: sub.entries.map((e) => (e.k === 50 ? { ...e, inputs: [0, 0] } : e)) };
  const rb = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(bad) });
  assert.equal(rb.status, 400);
  assert.match((await rb.json()).error, /signatures/);

  // Same-node co-sign refused.
  const self = await fetch(`${host.addr}/cosign`, { method: 'POST', body: JSON.stringify({ matchId: 'm-signed-1', witnessId: host.nodeId, sig: 'ab' }) });
  assert.equal((await self.json()).ok, false);

  // Unsigned ledger with no relay record settles as 'host' — labelled, not hidden.
  const un = { ...(await playSigned('m-unsigned', kps)), signatures: {} };
  const ru = await (await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(un) })).json();
  assert.equal(ru.attestation, 'host');
});

test('settle: a real Agent Fighter relay ledger reproduces the relay\'s own result', { skip: !existsSync(join(process.cwd(), 'data', 'ledgers-import')) }, async (t) => {
  const dir = join(process.cwd(), 'data', 'ledgers-import');
  const files = (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) return t.skip('no imported ledgers');
  const node = await createNode({ dataDir: join(tmp, 'real'), offline: true, heartbeatMs: 1000, operator: 'real', roles: ['settler'], rulesets: [RULESET] });
  t.after(() => node.stop());
  for (const f of files) {
    const sub = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (sub.source?.engine !== engine.ENGINE_VERSION) continue;
    // The import stamps the artifact hash at import time. A rebuilt adapter on
    // the SAME engine still reproduces the relay's result, which is what this
    // test proves, so re-stamp to the current artifact rather than skip.
    sub.buildHash = manifest.buildHash;
    const r = await fetch(`${node.addr}/ledger`, { method: 'POST', body: JSON.stringify(sub) });
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    assert.equal(d.attestation, 'relay', 'replay matched the relay\'s recorded hash and endTick');
    console.log(JSON.stringify({ matchId: d.matchId, ticks: d.ticks, engineHash: d.engineHash, expected: sub.expected.hash, scores: d.scores }));
  }
});
