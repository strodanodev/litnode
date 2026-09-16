import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standingCall, decodeStanding, applyStakes, nodeKeyBytes32, STANDING_OF } from '../protocol/staking.js';
import { selector } from '../protocol/keccak.js';
import { placement } from '../protocol/placement.js';

const KEY = 'ab'.repeat(32);
const CONTRACT = '0x' + '11'.repeat(20);

test('standingOf call is well-formed', () => {
  const c = standingCall(CONTRACT, KEY);
  assert.equal(c.to, CONTRACT);
  assert.equal(c.data.length, 2 + 8 + 64);
  assert.ok(c.data.startsWith(selector(STANDING_OF)));
  assert.throws(() => nodeKeyBytes32('abcd'));
});

test('standingOf result decodes', () => {
  const op = '22'.repeat(20);
  const amount = (150n * 10n ** 18n).toString(16).padStart(64, '0');
  const hex = '0x' + '0'.repeat(24) + op + amount + '0'.repeat(63) + '1';
  const s = decodeStanding(hex);
  assert.equal(s.operator, '0x' + op);
  assert.equal(s.amount, 150n * 10n ** 18n);
  assert.equal(s.active, true);
  assert.equal(decodeStanding(hex.slice(0, -1) + '0').active, false);
});

test('chain standing replaces self-asserted operator and standing; unstaked nodes drop', () => {
  const peers = [
    { nodeId: 'a', operator: 'i-claim-publisher', standing: 9999, roles: ['host', 'witness'], buildHashes: { r: 'B' } },
    { nodeId: 'b', operator: 'guild', standing: 0, roles: ['host', 'witness'], buildHashes: { r: 'B' } },
    { nodeId: 'c', operator: 'guild', standing: 0, roles: ['host', 'witness'], buildHashes: { r: 'B' } },
    { nodeId: 'd', operator: 'nobody', standing: 5, roles: ['host'], buildHashes: { r: 'B' } },
  ];
  const stakes = {
    a: { operator: '0xAAAA', amount: 100n * 10n ** 18n, active: true },
    b: { operator: '0xBBBB', amount: 500n * 10n ** 18n, active: true },
    c: { operator: '0xBBBB', amount: 500n * 10n ** 18n, active: true },
    d: { operator: '0xDDDD', amount: 500n * 10n ** 18n, active: false }, // unbonding
  };
  const staked = applyStakes(peers, stakes);
  assert.deepEqual(staked.map((p) => p.nodeId), ['a', 'b', 'c']);
  assert.equal(staked[0].operator, '0xaaaa');
  assert.equal(staked[0].standing, 100);
  const manifest = { buildHash: 'B', standingFloor: 200, hostPolicy: { affinity: 'open' } };
  const p = placement({ nodes: staked, manifest, rulesetId: 'r', matchId: 'm', beacon: 'x' });
  assert.ok(['b', 'c'].includes(p.host.nodeId), 'floor of 200 tokens excludes a');
  assert.equal(p.witness, null, 'b and c share a staking address, so neither can witness the other');
});
