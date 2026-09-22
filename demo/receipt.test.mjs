/** The match receipt (cabinet/receipt.js): every on-chain step links to the
 *  Liteforge explorer, and a step is "confirmed" only when the browser's own
 *  eth_getTransactionReceipt shows it succeeded, went to MatchBook, and
 *  carries that event for that match. A node that names a tx the chain does
 *  not back is shown, marked, never upgraded.
 *    node --test demo/receipt.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReceipt, renderReceipt, confirmTx } from '../cabinet/receipt.js';
import { keccak256Hex, selector } from '../protocol/keccak.js';

const MB = '0x90d642d1f1cb00ebfeb2268dd13dee32a2852e5b';
const ANCHOR = '0x919e9500785ab077d2058490a465f05bd8238a64';
const EXPLORER = 'https://liteforge.explorer.caldera.xyz';
const M = '524cd42dfcf73b05a38c77e1663e1139d61103a3cc4fe15d55c70d3352e07e8b';
const A = 'c6'.repeat(32), B = '44'.repeat(32), H = '5b'.repeat(32);
const W = ['3b'.repeat(32), '90'.repeat(32), '2c'.repeat(32)];
const topic = (sig) => '0x' + keccak256Hex(sig);
const T = {
  Committed: topic('Committed(bytes32,bytes32,bytes32,bytes32,bytes32[3])'),
  Settled: topic('Settled(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32[],int64[],bytes32[])'),
  Attested: topic('Attested(bytes32,bytes32,bytes32,bool,bool)'),
  Finalized: topic('Finalized(bytes32,bytes32,bytes32,uint8)'),
};
const tx = (n) => '0x' + String(n).repeat(64).slice(0, 64);
const ROOT = 'ab'.repeat(32);

// What the node says (its decoded MatchBook events), as GET /match/:id/chain answers.
const events = [
  { event: 'Committed', matchId: M, block: 100, logIndex: 1, tx: tx(1), hostKey: H, descriptorHash: 'dd'.repeat(32), panel: W },
  { event: 'Settled', matchId: M, block: 200, logIndex: 2, tx: tx(2), hostKey: H, resultHash: 'b9'.repeat(32), ledgerHash: '5e'.repeat(32), buildHash: '85'.repeat(32), participants: [A, B], scores: [2, 0], custodians: [H] },
  { event: 'Attested', matchId: M, block: 210, logIndex: 3, tx: tx(3), witnessKey: W[0], resultHash: 'b9'.repeat(32), agrees: true, escalation: false },
  { event: 'Attested', matchId: M, block: 220, logIndex: 4, tx: tx(4), witnessKey: W[1], resultHash: 'b9'.repeat(32), agrees: true, escalation: false },
  { event: 'Finalized', matchId: M, block: 300, logIndex: 5, tx: tx(5), finalHash: 'b9'.repeat(32), status: 'final' },
];
const api = async (path) => {
  if (path === `/match/${M}/chain`) return { matchId: M, key: M, status: 'final', panel: W, events };
  if (path === `/delta/${M}`) return { matchId: M, rulesetId: 'agent-fighter.v1', participants: [A, B], scores: { [A]: 2, [B]: 0 }, ticks: 2758, attestation: 'players' };
  if (path === `/proof/${M}`) return { matchId: M, epoch: 497229, status: 'final', root: ROOT, leaf: ROOT, path: [] };
  if (path === '/match/never/chain') return { matchId: 'never', key: 'ff'.repeat(32), status: 'none', panel: null, events: [] };
  if (path === '/delta/never') return { matchId: 'never', rulesetId: 'agent-fighter.v1', participants: [A, B], scores: { [A]: 0, [B]: 1 }, ticks: 900, attestation: 'relay' };
  return { error: 'unknown match' };
};
// What the chain says. Tx 4 is a forgery the node names (no such receipt); everything else is real.
const receipt = (e, over = {}) => ({ status: '0x1', to: MB, blockNumber: '0x' + e.block.toString(16), gasUsed: '0x1234', from: '0x7467246301df4e45c446a98acb037c85315b560d', logs: [{ address: MB, topics: [T[e.event], '0x' + M] }], ...over });
const rpc = async (method, params) => {
  if (method === 'eth_getTransactionReceipt') { const e = events.find((x) => x.tx === params[0]); return e && e.tx !== tx(4) ? receipt(e) : null; }
  if (method === 'eth_call' && params[0].to === ANCHOR && params[0].data.startsWith(selector('rootOf(uint64)'))) return '0x' + ROOT;
  throw new Error(`unexpected ${method}`);
};

test('receipt: every node-reported step is re-checked on chain; a tx the chain does not back is marked, not hidden', async () => {
  const r = await loadReceipt(M, { api, rpc, contracts: { MatchBook: MB, EpochAnchor: ANCHOR } });
  assert.equal(r.status, 'final');
  assert.deepEqual(r.events.map((e) => e.event), ['Committed', 'Settled', 'Attested', 'Attested', 'Finalized']);
  assert.deepEqual(r.events.map((e) => e.check.ok), [true, true, true, false, true]);
  assert.match(r.events[3].check.reason, /no such transaction/);
  assert.equal(r.proof.anchoredRoot, ROOT);

  const html = renderReceipt(r, { explorer: EXPLORER, me: A, names: { [A]: 'Nezuko' }, contracts: { MatchBook: MB, EpochAnchor: ANCHOR } });
  for (const e of events) assert.ok(html.includes(`${EXPLORER}/tx/${e.tx}`), `${e.event} links its transaction on the explorer`);
  assert.ok(html.includes(`${EXPLORER}/block/100`), 'blocks link too');
  assert.ok(html.includes(`${EXPLORER}/address/${MB}`), 'the contract links');
  assert.match(html, /final on chain/);
  assert.match(html, /<b>you<\/b> · Nezuko/);
  assert.match(html, /winner/);
  assert.match(html, /Score as posted on chain/);
  assert.match(html, /✓ root anchored on EpochAnchor/);
  assert.equal((html.match(/✓ confirmed/g) ?? []).length, 4);
  assert.match(html, /✗ no such transaction on chain/);
  assert.match(html, /2\/3 witness verdicts/);
});

test('receipt: the chain check refuses a wrong contract, a revert, another block, another match', async () => {
  const e = events[1];
  const base = { tx: e.tx, event: 'Settled', matchKey: M, contract: MB, block: e.block };
  const one = (r) => confirmTx(async () => r, base);
  assert.equal((await one(receipt(e))).ok, true);
  assert.match((await one(receipt(e, { to: '0x' + '11'.repeat(20) }))).reason, /another contract/);
  assert.match((await one(receipt(e, { status: '0x0' }))).reason, /reverted/);
  assert.match((await one(receipt(e, { blockNumber: '0x1' }))).reason, /another block/);
  assert.match((await one(receipt(e, { logs: [{ address: MB, topics: [T.Settled, '0x' + 'ee'.repeat(32)] }] }))).reason, /no Settled for this match/);
  assert.match((await one(receipt(e, { logs: [{ address: MB, topics: [T.Attested, '0x' + M] }] }))).reason, /no Settled/);
  assert.equal((await confirmTx(null, base)).ok, null, 'without a chain reader it says so');
});

test('receipt: a match that never reached the chain says so, with its local result and no transaction to open', async () => {
  const r = await loadReceipt('never', { api, rpc, contracts: { MatchBook: MB, EpochAnchor: ANCHOR } });
  assert.equal(r.status, 'none');
  assert.equal(r.events.length, 0);
  const html = renderReceipt(r, { explorer: EXPLORER, me: A, contracts: { MatchBook: MB } });
  assert.match(html, /not on chain/);
  assert.match(html, /never committed to MatchBook, so there is no transaction to open/);
  assert.match(html, /Score from this node's local settlement/);
  assert.ok(!html.includes(`${EXPLORER}/tx/`), 'no transaction link is invented');
});
