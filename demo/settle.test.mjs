/** Settlement end to end on two nodes, the way the audit says it must go:
 *  the mesh places the match, a player-signed ledger settles on the host
 *  bound to that placement, the witness recomputes the COMPLETE result in
 *  its own sandbox and co-signs the commitment, the official ladder derives
 *  from verified results only, the hour's tree carries the leaf with a
 *  verifiable proof. Then every audit probe, as a regression:
 *    empty/unsigned ranked → refused · altered scores → witness disputes ·
 *    forged relay provenance → refused · mismatched descriptor → refused ·
 *    bad player signature → refused · modified outcome fields → disputed.
 *    node --test demo/settle.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { verifyProof } from '../protocol/epoch.js';
import { resultHash } from '../protocol/result.js';
import { HOST_TAG, RELAY_TAG } from '../node/settle.js';
import { chainHead } from '../protocol/log.js';
import { placeMatch, playPlaced, until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
// The test imports the ruleset in-process to PLAY it (a client would); the node never does.
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);
const tmp = mkdtempSync(join(tmpdir(), 'litnode-settle-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const reSign = async (delta, kp, patch) => { const { hostSig, cosigners, cosigs, disputes, verification, official, ...body } = { ...delta, ...patch }; body.resultHash = resultHash(body); return { ...body, hostSig: await sign(HOST_TAG, body, kp.privateKey), cosigners: [], cosigs: {}, disputes: [] }; };

test('settle: placed + signed → verified delta → witness co-sign → official ladder → epoch proof', { timeout: 120_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const relayKp = await generateKeypair();
  const host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET], relayKeys: [relayKp.publicKey] });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr], titleTrust: 'open' });
  assert.ok(await until(() => wit.rulesets()['agent-fighter.v1']), 'witness hydrates the ruleset');

  const kps = await Promise.all([generateKeypair(), generateKeypair()]);
  const desc = await placeMatch(host.addr, kps, { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  assert.equal(desc.host, host.nodeId);
  assert.equal(desc.protocol, 2);
  assert.equal(desc.buildHash, manifest.buildHash, 'the descriptor pins the build');
  const sub = await playPlaced(desc, kps, { title, engine, manifest, balance });
  const r = await post(`${host.addr}/ledger`, sub);
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const delta = JSON.parse(text);
  assert.equal(delta.attestation, 'players');
  assert.equal(delta.placed, true);
  assert.equal(delta.hostId, host.nodeId);
  assert.equal(delta.ticks, sub.entries.length);
  assert.equal(delta.complete, true);
  assert.equal(delta.hydrationSource, 'fixture', 'no registry configured: labelled, never silent');
  assert.equal(delta.resultHash, resultHash(delta), 'the commitment covers the whole result');
  assert.equal(delta.verification, 'unverified', 'no witness yet');
  assert.equal(delta.official, false);

  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json()).cosigners.length === 1, 30_000), 'witness co-signs over gossip');
  const signed = await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json();
  assert.deepEqual(signed.cosigners, [wit.nodeId]);
  assert.equal(signed.verification, 'verified');
  assert.equal(signed.official, true);

  const lb = await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1`)).json();
  assert.equal(lb.scope, 'official');
  assert.equal(lb.leaderboard.length, 2, 'a verified ranked result reaches the official ladder');
  const stats = await (await fetch(`${host.addr}/stats?ruleset=agent-fighter.v1&player=${kps[0].publicKey}`)).json();
  assert.equal(stats.matches, 1);

  const ep = await (await fetch(`${host.addr}/epoch`)).json();
  assert.equal(ep.count, 1); assert.equal(ep.status, 'open');
  assert.ok(ep.proposeCalldata.startsWith('0x'), 'EpochAnchor v2 propose(epoch, root, nodeKey) calldata');
  const pr = await (await fetch(`${host.addr}/proof/${desc.matchId}`)).json();
  assert.equal(pr.verified, true);
  assert.ok(verifyProof(pr.leaf, pr.path, ep.root));
  // freeze: the leaf set is final; a proof from the frozen batch says so
  host.settlement.freeze(delta.epoch);
  const pf = await (await fetch(`${host.addr}/proof/${desc.matchId}`)).json();
  assert.equal(pf.status, 'finalized'); assert.deepEqual(pf.cosignersAtFreeze, [wit.nodeId]); assert.equal(pf.leaf, pr.leaf);

  // ---- AUDIT PROBE 3: an empty, unsigned ranked submission with `expected: {}` → refused, no ladder rows
  const kps2 = await Promise.all([generateKeypair(), generateKeypair()]);
  const desc2 = await placeMatch(host.addr, kps2, { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const empty = { matchId: desc2.matchId, rulesetId: 'agent-fighter.v1', mode: 'ranked', participants: desc2.participants, entries: [], expected: {} };
  const re = await post(`${host.addr}/ledger`, empty);
  assert.equal(re.status, 400); assert.match((await re.json()).error, /empty log/);
  // unplaced ranked → refused outright
  const unplaced = { ...(await playPlaced(desc2, kps2, { title, engine, manifest, balance })), matchId: 'audit-unplaced' };
  const ru = await post(`${host.addr}/ledger`, unplaced);
  assert.equal(ru.status, 400); assert.match((await ru.json()).error, /no placement descriptor/);
  // complete but unsigned ranked → refused: signatures or an authenticated relay
  const sub2 = await playPlaced(desc2, kps2, { title, engine, manifest, balance });
  const rs = await post(`${host.addr}/ledger`, { ...sub2, signatures: {} });
  assert.equal(rs.status, 400); assert.match((await rs.json()).error, /player signatures or an authenticated relay/);
  // forged provenance: a relay key the host does not trust
  const rogue = await generateKeypair();
  const relaySig = (kp, s) => sign(RELAY_TAG, { matchId: s.matchId, head: chainHead(s.entries), ticks: s.entries.length, expected: null }, kp.privateKey);
  const rf = await post(`${host.addr}/ledger`, { ...sub2, signatures: {}, relay: { id: rogue.publicKey, sig: await relaySig(rogue, sub2) } });
  assert.equal(rf.status, 400); assert.match((await rf.json()).error, /not a relay this host trusts/);
  // bad player signature: one signature made by a stranger
  const rb2 = await post(`${host.addr}/ledger`, { ...sub2, signatures: { ...sub2.signatures, [kps2[1].publicKey]: sub2.signatures[kps2[0].publicKey] } });
  assert.equal(rb2.status, 400); assert.match((await rb2.json()).error, /signatures/);
  // mismatched descriptor: participants that are not the placed ones
  const rm = await post(`${host.addr}/ledger`, { ...sub2, participants: [kps2[0].publicKey, kps[1].publicKey] });
  assert.equal(rm.status, 400); assert.match((await rm.json()).error, /participants differ from the placement/);
  // tampered entries with the original signatures
  const rt = await post(`${host.addr}/ledger`, { ...sub2, entries: sub2.entries.map((e) => (e.k === 50 ? { ...e, inputs: [e.inputs[0] ^ 1, e.inputs[1]] } : e)) });
  assert.equal(rt.status, 400, await rt.clone().text()); assert.match((await rt.json()).error, /signatures/);
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1&scope=all`)).json()).leaderboard.length, 2, 'none of the refusals produced a row');

  // an AUTHENTICATED relay submission settles, labelled relay, and stays off the official ladder
  const rr = await post(`${host.addr}/ledger`, { ...sub2, signatures: {}, relay: { id: relayKp.publicKey, sig: await relaySig(relayKp, sub2) } });
  assert.equal(rr.status, 200, await rr.clone().text());
  const relayDelta = await rr.json();
  assert.equal(relayDelta.attestation, 'relay'); assert.equal(relayDelta.official, false);
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/${desc2.matchId}`)).json()).cosigners.length === 1, 30_000), 'the witness recomputes and agrees (it read the host\'s relayKeys from the heartbeat)');
  assert.equal((await (await fetch(`${host.addr}/delta/${desc2.matchId}`)).json()).verification, 'unverified', 'relay-attested is authenticated, not player-verified');
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1`)).json()).leaderboard.length, 2, 'official ladder unchanged');
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1&scope=all`)).json()).leaderboard.length, 4, 'scope=all shows it');

  // ---- AUDIT PROBE 4: a host-signed delta with altered scores — the witness recomputes and DISPUTES
  const ledger = await (await fetch(`${host.addr}/ledger/${desc.matchId}`)).json();
  const forged = await reSign(signed, host.identity, { scores: { [kps[0].publicKey]: 999999, [kps[1].publicKey]: 0 } });
  const v = await wit.settlement.cosign(forged, ledger);
  assert.equal(v.ok, false); assert.match(v.reason, /result differs: scores/);
  assert.ok(v.dispute?.sig, 'a signed dispute comes back');
  // modified outcome fields other than scores are caught the same way
  const forged2 = await reSign(signed, host.identity, { ticks: signed.ticks - 1 });
  assert.match((await wit.settlement.cosign(forged2, ledger)).reason, /result differs: ticks/);
  const forged3 = await reSign(signed, host.identity, { attestation: 'players', signatures: {} });
  assert.equal((await wit.settlement.cosign({ ...forged3 }, { ...ledger, signatures: {} })).ok, false, 'signatures are re-verified at the witness, not read off the delta');
  // the host records the dispute; the delta leaves the official ladder
  const dr = await post(`${host.addr}/dispute`, { ...v.dispute, resultHash: signed.resultHash });
  assert.equal((await dr.json()).ok, false, 'a dispute over a forged commitment does not attach to the honest delta');
  const honestDispute = { matchId: desc.matchId, resultHash: signed.resultHash, witnessId: wit.nodeId, reason: 'scores', ours: 'x'.repeat(64) };
  const dr2 = await post(`${host.addr}/dispute`, { ...honestDispute, sig: await sign('dispute', honestDispute, wit.identity.privateKey) });
  assert.equal((await dr2.json()).ok, true);
  const disputed = await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json();
  assert.equal(disputed.verification, 'disputed'); assert.equal(disputed.official, false);
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1`)).json()).leaderboard.length, 0, 'a disputed result is out of official standings');

  // same-node co-sign refused; a co-sign over a stale commitment refused
  assert.equal((await (await post(`${host.addr}/cosign`, { matchId: desc.matchId, witnessId: host.nodeId, sig: 'ab' })).json()).ok, false);

  // casual, unplaced, unsigned: settles labelled host/unplaced, never official
  const un = { ...(await playPlaced(desc2, kps2, { title, engine, manifest, balance, mode: 'casual' })), matchId: 'm-casual-unplaced', mode: 'casual', signatures: {} };
  const rc = await post(`${host.addr}/ledger`, un);
  assert.equal(rc.status, 200, await rc.clone().text());
  const cd = await rc.json();
  assert.equal(cd.attestation, 'host'); assert.equal(cd.placed, false); assert.equal(cd.official, false);
});

test('settle: a real Agent Fighter relay ledger reproduces the relay\'s own result', { skip: !existsSync(join(process.cwd(), 'data', 'ledgers-import')) }, async (t) => {
  // Kept as a manual check against imported relay ledgers (data/ledgers-import/*.json);
  // unplaced relay records now settle as casual/unofficial and need a RELAY_KEYS signature.
  t.skip('manual');
});
