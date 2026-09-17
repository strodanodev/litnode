/** Trustworthy hydration (audit finding 5): with a registry configured, a
 *  ranked match's characters come from ERC6699Registry v2 at the placement's
 *  block — never from the submission — and the player key's profile owner
 *  must own or control the token. Changing submitted stats or equipment
 *  cannot produce a valid competitive result; the witness reads the same
 *  pinned state and reaches the same hydration hash.
 *    node --test demo/hydration.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import { selector } from '../protocol/keccak.js';
import { OWNER_OF_KEY } from '../protocol/profile.js';
import { CORE_STATS, MANIFEST_OF, OWNER_OF, EQUIPPED, readAgent, decodeManifest, mayPlay, progressCalldata, PROGRESS } from '../protocol/registry.js';
import { agent, hydrationManifest } from '../protocol/erc6699.js';
import { placeMatch, playPlaced, until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);
const REG = '0x' + '69'.repeat(20), PROF = '0x' + '77'.repeat(20);
const ALICE = '0x' + 'a1'.repeat(20), BOB = '0x' + 'b0'.repeat(20), MALLORY = '0x' + 'ee'.repeat(20);
const word = (h) => h.replace(/^0x/, '').padStart(64, '0');
const enc = (s) => Buffer.from(s).toString('hex');

/** A mock chain holding a v2 registry, profiles, and blocks that advance so a chain beacon exists. */
function mockChain({ tokens, bindings }) {
  let blockNo = 0x1000;
  const calls = { registry: 0, blocks: new Set() };
  return async (url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    let result;
    if (method === 'eth_getBlockByNumber') { blockNo++; result = { number: '0x' + blockNo.toString(16), timestamp: '0x' + Math.floor(Date.now() / 1000 + 1).toString(16), hash: '0x' + blockNo.toString(16).padStart(64, '0') }; }
    else if (method === 'eth_call') {
      const data = params[0].data, to = params[0].to;
      if (to === PROF && data.startsWith(selector(OWNER_OF_KEY))) { const b = bindings[data.slice(10)] ?? { owner: '0x' + '0'.repeat(40), tokenId: 0n, active: false }; result = '0x' + word(b.owner) + word(b.tokenId.toString(16)) + word(b.active ? '1' : '0'); }
      else if (to === REG) {
        calls.registry++; calls.blocks.add(params[1]);
        const tokenId = BigInt('0x' + data.slice(10, 74)).toString();
        const t = tokens[tokenId];
        if (data.startsWith(selector(OWNER_OF))) result = '0x' + word(t?.owner ?? '0');
        else if (data.startsWith(selector(CORE_STATS))) result = '0x' + [t.stats.strength, t.stats.agility, t.stats.resilience, t.stats.intelligence, t.stats.level ?? 0, t.stats.experience ?? 0].map((v) => word(v.toString(16))).join('');
        else if (data.startsWith(selector(MANIFEST_OF))) { const uri = enc(t.uri ?? ''); result = '0x' + word('20') + word('c0') + word(t.soul) + word(t.controller) + word(t.configHash) + word((t.statsNonce ?? 0).toString(16)) + word('0') + word((uri.length / 2).toString(16)) + (uri.padEnd(Math.ceil(uri.length / 64) * 64 || 64, '0')); }
        else if (data.startsWith(selector(EQUIPPED))) { const slot = '0x' + data.slice(74, 138); const e = t.equipped?.[slot]; result = '0x' + word(e?.collection ?? '0') + word(e ? BigInt(e.assetId).toString(16) : '0'); }
        else result = '0x';
      } else result = '0x';
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }), calls };
  };
}

test('registry reads decode a v2 manifest; mayPlay needs an owning or controlling profile', async () => {
  const tokens = { 7: { owner: ALICE, stats: { strength: 40000, agility: 20000, resilience: 30000, intelligence: 10000 }, soul: 'ab'.repeat(32), controller: '0x' + '0'.repeat(40), configHash: 'cd'.repeat(32), statsNonce: 3, uri: 'ipfs://seven' } };
  const fetchImpl = mockChain({ tokens, bindings: {} });
  const call = async (payload, tag) => (await (await fetchImpl('mock://', { body: JSON.stringify({ id: 1, method: 'eth_call', params: [payload, tag] }) })).json()).result;
  const a = await readAgent(call, REG, '7', '0x1234');
  assert.equal(a.source, 'registry'); assert.deepEqual(a.pin, { contract: REG, block: '0x1234' });
  assert.equal(a.stats.strength, 40000); assert.equal(a.manifest.statsNonce, 3); assert.equal(a.manifest.characterConfigURI, 'ipfs://seven');
  assert.equal(a.manifest.characterConfigHash, '0x' + 'cd'.repeat(32)); assert.equal(a.manifest.owner, ALICE);
  assert.equal(await readAgent(call, REG, '8', 'latest'), null, 'unknown token');
  assert.equal(mayPlay(a, { owner: ALICE, active: true }).ok, true);
  assert.equal(mayPlay(a, { owner: BOB, active: true }).ok, false);
  assert.equal(mayPlay(a, { owner: ALICE, active: false }).ok, false, 'a revoked key may not play');
  assert.equal(mayPlay(a, null).ok, false, 'no profile, no character');
  assert.ok(progressCalldata('7', a.stats, 3).startsWith(selector(PROGRESS)));
  assert.equal(progressCalldata('7', a.stats, 3).length, 10 + 64 * 8);
});

test('ranked hydration comes from the registry at the placement block; submitted stats and unowned tokens are refused; witness agrees', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-hyd-'));
  const [alice, bob, mallory] = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair()]);
  const tokens = {
    1: { owner: ALICE, stats: { strength: 30000, agility: 58000, resilience: 20000, intelligence: 40000 }, soul: 'aa'.repeat(32), controller: '0x' + '0'.repeat(40), configHash: '11'.repeat(32), statsNonce: 0 },
    2: { owner: BOB, stats: { strength: 65535, agility: 5000, resilience: 60000, intelligence: 1000 }, soul: 'bb'.repeat(32), controller: '0x' + '0'.repeat(40), configHash: '22'.repeat(32), statsNonce: 5 },
  };
  const bindings = { [alice.publicKey]: { owner: ALICE, tokenId: 1n, active: true }, [bob.publicKey]: { owner: BOB, tokenId: 2n, active: true }, [mallory.publicKey]: { owner: MALLORY, tokenId: 3n, active: true } };
  const chainFetch = mockChain({ tokens, bindings });
  const nodes = [];
  const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), rpc: 'mock://', offline: false, chainFetch, erc6699: REG, playerProfile: PROF, heartbeatMs: 200, updates: false, ...opts }).then((n) => (nodes.push(n), n));
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET] });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr] });
  assert.ok(await until(() => wit.rulesets()['agent-fighter.v1']));
  assert.equal((await (await fetch(`${host.addr}/health`)).json()).registry, 'chain');

  const desc = await placeMatch(host.addr, [alice, bob], { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  assert.equal(desc.beaconSource, 'chain'); assert.ok(desc.beaconBlock > 0, 'the placement pins a block');
  const block = '0x' + Number(desc.beaconBlock).toString(16);

  // What an honest client signs: the registry's characters at that block (it reads the chain too).
  const call = async (payload, tag) => (await (await chainFetch('mock://', { body: JSON.stringify({ id: 1, method: 'eth_call', params: [payload, tag] }) })).json()).result;
  const regAgents = { [alice.publicKey]: await readAgent(call, REG, '1', block), [bob.publicKey]: await readAgent(call, REG, '2', block) };
  const P = desc.participants;
  const agentsByP = { [P[0]]: regAgents[P[0]], [P[1]]: regAgents[P[1]] };
  const kps = P.map((p) => (p === alice.publicKey ? alice : bob));
  const honest = await playPlaced(desc, kps, { title, engine, manifest, balance, agents: agentsByP });
  // The submission names tokens only; any stats it carries are ignored.
  honest.hydration = { agents: { [P[0]]: { tokenId: agentsByP[P[0]].tokenId, stats: { strength: 65535, agility: 65535, resilience: 65535, intelligence: 65535 } }, [P[1]]: { tokenId: agentsByP[P[1]].tokenId } } };
  const r = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(honest) });
  const delta = await r.json();
  assert.equal(r.status, 200, JSON.stringify(delta));
  assert.equal(delta.hydrationSource, 'registry');
  assert.equal(delta.hydrationManifest.entries.every((e) => e.source === 'registry'), true);
  assert.equal(delta.hydrationManifest.entries.find((e) => e.tokenId === '1').stats.strength, 30000, 'the inflated submitted stats did not survive');
  assert.equal(delta.hydrationManifest.entries.find((e) => e.tokenId === '2').statsNonce, 5);
  const expected = hydrationManifest({ agents: [agentsByP[P[0]], agentsByP[P[1]]], mode: 'ranked', balanceVersion: balance.version });
  assert.equal(delta.hydrationHash, expected.manifestHash, 'exactly the registry state at the pinned block');
  assert.ok((await chainFetch('mock://', { body: '{"id":0,"method":"x","params":[]}' })).calls.blocks.has(block), 'reads were pinned to the placement block, not latest');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json()).cosigners.length === 1, 30_000), 'the witness hydrated from the same pinned block and agreed');
  assert.equal((await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json()).verification, 'verified');
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1`)).json()).leaderboard.length, 2, 'official: registry-hydrated, placed, signed, witnessed');

  // A cheater who signed the ledger over inflated stats: the node hydrates from the registry → hash differs → signatures fail.
  const desc2 = await placeMatch(host.addr, [alice, bob], { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const P2 = desc2.participants, kps2 = P2.map((p) => (p === alice.publicKey ? alice : bob));
  const inflated = { [P2[0]]: agent({ ...regAgents[P2[0]], stats: { ...regAgents[P2[0]].stats, intelligence: 60000 }, source: 'registry' }), [P2[1]]: regAgents[P2[1]] };
  const cheat = await playPlaced(desc2, kps2, { title, engine, manifest, balance, agents: inflated });
  cheat.hydration = { agents: { [P2[0]]: { tokenId: inflated[P2[0]].tokenId, stats: inflated[P2[0]].stats }, [P2[1]]: { tokenId: inflated[P2[1]].tokenId } } };
  const rc = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(cheat) });
  assert.equal(rc.status, 400, (await rc.clone().text()).slice(0, 4000)); assert.match((await rc.json()).error, /signatures/);

  // A token the player's profile neither owns nor controls
  const stolen = { ...cheat, hydration: { agents: { [P2[0]]: { tokenId: P2[0] === alice.publicKey ? '2' : '1' }, [P2[1]]: { tokenId: P2[1] === alice.publicKey ? '2' : '1' } } } };
  const rs = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(stolen) });
  assert.equal(rs.status, 400, await rs.clone().text()); assert.match((await rs.json()).error, /neither owns nor controls/);
  // An unknown token
  const ghost = { ...cheat, hydration: { agents: { [P2[0]]: { tokenId: '99' }, [P2[1]]: { tokenId: '2' } } } };
  const rg = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(ghost) });
  assert.equal(rg.status, 400); assert.match((await rg.json()).error, /unknown to the registry/);
});
