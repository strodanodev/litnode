/** The Agent Fighter adapter against the real engine, plus the two numbers
 *  the build spec asserts without measuring: full-match replay cost, and the
 *  cost of verifying one ed25519 signature per tick versus one per ledger.
 *
 *    node tools/bundle-ruleset.mjs && node --test demo/af-adapter.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, h, sha256Hex } from '../protocol/canonical.js';
import { agent, hydrationManifest } from '../protocol/erc6699.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesetPath = join(here, '..', 'rulesets', 'agent-fighter.v1.js');
const { default: title, engine, balance } = await import(pathToFileURL(rulesetPath).href);
const manifest = JSON.parse(readFileSync(join(here, '..', 'rulesets', 'agent-fighter.v1.json'), 'utf8'));

const HERMES = agent({ tokenId: 1, stats: { strength: 30000, agility: 58000, resilience: 20000, intelligence: 40000, level: 3, experience: 0 },
  manifest: { characterConfigURI: null, soulManifestHash: 'aa', agentController: null }, equipped: { head: { collection: '0x1', assetId: '7' } } });
const BRUTE = agent({ tokenId: 2, stats: { strength: 65535, agility: 5000, resilience: 60000, intelligence: 1000, level: 9, experience: 0 },
  manifest: { characterConfigURI: null, soulManifestHash: 'bb', agentController: null } });
const P = ['player-a', 'player-b'];

/** Run one whole match headless with the engine's own AI as both players.
 *  Returns the input log too, so the replay and signature tests reuse it. */
const play = (seed, agents, { log = null } = {}) => {
  const ctx = { agents: { [P[0]]: agents[0], [P[1]]: agents[1] } };
  const s = title.init(seed, P, ctx);
  const ai = [engine.createAi(0, 60, 11), engine.createAi(1, 60, 99)];
  const inputs = [];
  let tick = 0;
  while (!title.done(s)) {
    // A replayed log may be shorter than this match (different hydration ends
    // it at a different tick); past its end both sides are idle.
    const fr = log ? (log[tick] ?? [0, 0]) : [engine.aiPoll(ai[0], s), engine.aiPoll(ai[1], s)];
    inputs.push(fr);
    title.step(s, { [P[0]]: fr[0], [P[1]]: fr[1] });
    tick++;
  }
  return { root: h('state', title.serialize(s)), ticks: tick, scores: title.scores(s), inputs };
};

test('pure-JS sha256 agrees with node:crypto', () => {
  for (const msg of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)])
    assert.equal(sha256Hex(msg), createHash('sha256').update(msg).digest('hex'));
});

test('artifact is self-contained and its buildHash matches the manifest', () => {
  const src = readFileSync(rulesetPath, 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.equal(h('ruleset', src), manifest.buildHash);
  assert.equal(engine.ENGINE_VERSION, manifest.engine);
});

test('stats map into the engine\'s bounded aura band', () => {
  const a = balance.apply(BRUTE.stats);
  assert.equal(a.atk, 80);          // maxed strength = AURA_MAX = +8%
  assert.ok(a.crit >= 0 && a.crit <= 80);
  assert.ok(Object.values(balance.apply(HERMES.stats)).every((v) => v >= 0 && v <= 80));
});

test('a full match completes and replays to the same root', () => {
  const first = play('deadbeef01', [HERMES, BRUTE]);
  assert.ok(first.ticks > 0 && first.ticks <= title.manifest.maxTicks, `ticks ${first.ticks}`);
  const again = play('deadbeef01', [HERMES, BRUTE], { log: first.inputs });
  assert.equal(again.root, first.root);
  assert.equal(again.ticks, first.ticks);
});

test('different hydration reaches a different root from the same inputs', () => {
  const base = play('deadbeef02', [HERMES, BRUTE]);
  const swapped = play('deadbeef02', [BRUTE, HERMES], { log: base.inputs });
  assert.notEqual(swapped.root, base.root);
  const sterile = agent({ ...HERMES, stats: { strength: 0, agility: 0, resilience: 0, intelligence: 0, level: 0, experience: 0 } });
  const zeroed = play('deadbeef02', [sterile, BRUTE], { log: base.inputs });
  assert.notEqual(zeroed.root, base.root);
});

test('ranked and casual hydration manifests of the same agents differ', () => {
  const ranked = hydrationManifest({ agents: [HERMES, BRUTE], mode: 'ranked', balanceVersion: balance.version });
  const casual = hydrationManifest({ agents: [HERMES, BRUTE], mode: 'casual', balanceVersion: balance.version });
  assert.equal(ranked.sterile, true);
  assert.deepEqual(ranked.entries[0].equipped, {});
  assert.notEqual(ranked.manifestHash, casual.manifestHash);
});

test('measure: replay cost vs per-tick signature verification', () => {
  const m = play('deadbeef03', [HERMES, BRUTE]);
  const N = 5;
  let t = performance.now();
  for (let i = 0; i < N; i++) play('deadbeef03', [HERMES, BRUTE], { log: m.inputs });
  const replayMs = (performance.now() - t) / N;

  const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
  const matchId = 'm-' + m.root.slice(0, 16);
  // Per-tick: each player signs {matchId, tick, frame}.
  const perTick = [];
  for (let k = 0; k < m.ticks; k++)
    for (const side of [0, 1]) {
      const msg = Buffer.from(canonical({ matchId, tick: k, side, k: m.inputs[k][side] }));
      perTick.push([msg, sign(null, msg, keys[side].privateKey), keys[side].publicKey]);
    }
  t = performance.now();
  for (const [msg, sig, pub] of perTick) assert.ok(verify(null, msg, pub, sig));
  const perTickMs = performance.now() - t;

  // Per-ledger: each player signs the hash of the whole hash-chained log once.
  let chain = 'genesis';
  for (let k = 0; k < m.ticks; k++) chain = h('tick', chain, { k, a: m.inputs[k][0], b: m.inputs[k][1] });
  const ledgerMsg = Buffer.from(canonical({ matchId, ticks: m.ticks, chain }));
  const ledgerSigs = keys.map((kp) => sign(null, ledgerMsg, kp.privateKey));
  t = performance.now();
  let c = 'genesis';
  for (let k = 0; k < m.ticks; k++) c = h('tick', c, { k, a: m.inputs[k][0], b: m.inputs[k][1] });
  assert.equal(c, chain);
  ledgerSigs.forEach((sig, i) => assert.ok(verify(null, ledgerMsg, keys[i].publicKey, sig)));
  const perLedgerMs = performance.now() - t;

  console.log(JSON.stringify({
    engine: engine.ENGINE_VERSION, ticks: m.ticks,
    replayMs: +replayMs.toFixed(1),
    perTickSignatures: perTick.length, perTickVerifyMs: +perTickMs.toFixed(0),
    perLedgerVerifyMs: +perLedgerMs.toFixed(1),
    ratioPerTickToReplay: +(perTickMs / replayMs).toFixed(0),
  }));
});
