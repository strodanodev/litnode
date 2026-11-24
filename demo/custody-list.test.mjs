/** Which nodes the arcade hands a player's AIR sign-in token to (cabinet/custody.js; audit of 10 Nov 2026).
 *  The token is a bearer credential, so it goes to the node that served the page, a node on this machine, or a node
 *  that proves its key and is bonded by a listed operator wallet — and to nobody else.
 *    node --test demo/custody-list.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCustody, CUSTODY_OPERATORS } from '../cabinet/custody.js';

const OURS = '0x04be2b954346324ee54c4b4c0189df5bb577a378', STRANGER = '0x' + '9c'.repeat(20);
const key = (c) => c.repeat(64);
// a little mesh: url → the node key it proves, key → its bond
const world = () => {
  const nodes = {
    'https://ours.example': key('a'),
    'https://stranger.example': key('b'),
    'https://unbonded.example': key('c'),
    'https://liar.example': null, // answers /whoami with a signature that does not check
  };
  const stakes = { [key('a')]: { bonded: true, operator: OURS.toUpperCase().replace('0X', '0x') }, [key('b')]: { bonded: true, operator: STRANGER }, [key('c')]: { bonded: false, operator: OURS } };
  const asked = { whoami: [], stake: [] };
  return {
    asked, stakes,
    whoami: async (origin) => { asked.whoami.push(origin); if (!(origin in nodes)) throw new Error('fetch failed'); return nodes[origin] ? { ok: true, nodeId: nodes[origin] } : { ok: false, reason: 'signature' }; },
    stakeOf: async (nodeId) => { asked.stake.push(nodeId); return stakes[nodeId] ?? { bonded: false, operator: '0x' + '00'.repeat(20) }; },
  };
};

test('custody: the list ships with the publisher\'s operator wallet, lowercase', () => {
  assert.deepEqual(CUSTODY_OPERATORS, [OURS]);
  assert.ok(CUSTODY_OPERATORS.every((a) => /^0x[0-9a-f]{40}$/.test(a)));
});

test('custody: the page\'s own node and a node on this machine qualify without a read; anything else must prove its key and its operator', async () => {
  const w = world();
  const c = createCustody({ pageOrigin: 'https://some-tunnel.trycloudflare.com', whoami: w.whoami, stakeOf: w.stakeOf });
  assert.equal((await c.trusted('https://some-tunnel.trycloudflare.com')).ok, true, 'the node that served this page');
  assert.equal((await c.trusted('https://some-tunnel.trycloudflare.com/')).ok, true);
  for (const local of ['http://127.0.0.1:7801', 'http://localhost:7801', 'http://[::1]:7801']) assert.equal((await c.trusted(local)).ok, true, local);
  assert.deepEqual(w.asked.whoami, [], 'none of those needed the network');

  const ours = await c.trusted('https://ours.example');
  assert.deepEqual([ours.ok, ours.nodeId, ours.operator], [true, key('a'), OURS], 'bonded by a listed operator, whatever case the chain read came in');
  for (const [url, why] of [
    ['https://stranger.example', /operator is not one the arcade gives sign-ins to/],
    ['https://unbonded.example', /no active bond/],
    ['https://liar.example', /did not prove its key \(signature\)/],
    ['https://nowhere.example', /did not prove its key \(fetch failed\)/],
    ['http://ours.example', /not reached over https/],
    ['http://127.0.0.1.evil.example', /not reached over https/],
    ['not a url', /not a node address/],
  ]) {
    const v = await c.trusted(url);
    assert.equal(v.ok, false, url); assert.match(v.reason, why, url);
  }
  await assert.rejects(c.assertTrusted('https://stranger.example'), /your sign-in is not sent to https:\/\/stranger\.example: its operator is not one/);
  assert.equal((await c.assertTrusted('https://ours.example')).ok, true);
});

test('custody: a verdict is cached five minutes; an unreadable chain is asked again, and is a refusal meanwhile', async () => {
  const w = world();
  let t = 1_000_000, chainUp = false;
  const c = createCustody({ whoami: w.whoami, stakeOf: async (id) => { if (!chainUp) throw new Error('rpc 429'); return w.stakeOf(id); }, now: () => t });
  const down = await c.trusted('https://ours.example');
  assert.equal(down.ok, false); assert.match(down.reason, /bond could not be read from the chain/);
  chainUp = true;
  assert.equal((await c.trusted('https://ours.example')).ok, true, 'not cached while unreadable');
  const before = w.asked.whoami.length;
  await c.trusted('https://ours.example'); await c.trusted('https://ours.example/');
  assert.equal(w.asked.whoami.length, before, 'cached');
  // the operator unbonds: the cached yes lasts at most five minutes
  w.stakes[key('a')] = { bonded: false, operator: OURS };
  t += 4 * 60_000; assert.equal((await c.trusted('https://ours.example')).ok, true);
  t += 2 * 60_000; assert.equal((await c.trusted('https://ours.example')).ok, false);
});

test('custody: airNode keeps the node the page talks to when it qualifies, else a listed operator\'s seed, else nothing', async () => {
  const w = world();
  const seeds = async () => [
    { nodeId: key('b'), url: 'https://stranger.example', operator: STRANGER },
    { nodeId: key('z'), url: 'https://nowhere.example', operator: OURS },          // listed, but offline
    { nodeId: key('a'), url: 'https://ours.example', operator: OURS },
  ];
  const c = createCustody({ whoami: w.whoami, stakeOf: w.stakeOf, seeds });
  assert.equal(await c.airNode('http://127.0.0.1:7801'), 'http://127.0.0.1:7801');
  assert.equal(await c.airNode('https://ours.example/'), 'https://ours.example');
  assert.equal(await c.airNode('https://stranger.example'), 'https://ours.example', 'the page talks to a stranger\'s seed: the token goes to ours instead');
  assert.ok(!w.asked.whoami.slice(w.asked.whoami.indexOf('https://stranger.example') + 1).includes('https://stranger.example'), 'a stranger\'s seed is not even tried as a fallback');
  // a seed that CLAIMS a listed operator in the directory read but proves another key's bond is still judged by its own proof
  const spoof = createCustody({ whoami: w.whoami, stakeOf: w.stakeOf, seeds: async () => [{ nodeId: key('a'), url: 'https://stranger.example', operator: OURS }] });
  assert.equal(await spoof.airNode('https://stranger.example'), null);
  // nobody listed is up
  const none = createCustody({ whoami: w.whoami, stakeOf: w.stakeOf, seeds: async () => [{ nodeId: key('z'), url: 'https://nowhere.example', operator: OURS }] });
  assert.equal(await none.airNode('https://stranger.example'), null);
  const dark = createCustody({ whoami: w.whoami, stakeOf: w.stakeOf, seeds: async () => { throw new Error('rpc down'); } });
  assert.equal(await dark.airNode(null), null);
});

test('custody: every call in the arcade that carries the token passes the check first', () => {
  const air = readFileSync(join('cabinet', 'air.js'), 'utf8');
  // each function that calls token() and then fetches a node asserts before it does either
  for (const fn of ['export async function nodeSession(', 'async function post(']) {
    const body = air.slice(air.indexOf(fn), air.indexOf('\n}', air.indexOf(fn)));
    const guard = body.indexOf('custody().assertTrusted(nodeUrl)'), tok = body.indexOf('await token()'), net = body.indexOf('fetch(');
    assert.ok(guard > 0 && guard < tok && tok < net, `${fn} checks the node, then reads the token, then sends`);
  }
  assert.equal((air.match(/JSON\.stringify\(\{ token: t/g) ?? []).length, 2, 'two places put the token in a request body; both are covered above');
  const app = readFileSync(join('cabinet', 'app.js'), 'utf8');
  assert.match(app, /const target = await custody\(\)\.airNode\(nodeUrl\(\)\);[\s\S]{0,400}air\.nodeSession\(target,/, 'sign-in asks custody for the node');
  assert.ok(!/air\.nodeSession\(nodeUrl\(\)/.test(app));
});
