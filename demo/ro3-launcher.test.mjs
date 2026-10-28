/** The arcade's #/ro3 page for the RO3 on LITNODE launcher (cabinet/ro3.js): it reads only a well-formed launcher
 *  request, trusts nothing the URL says about the server (it must be listed by this page's node, its challenge must
 *  name that listing's node), links by signing the server's challenge with the player key, and sends public facts only
 *  back to the launcher. The RO3 server is a stand-in that checks the proof as RO3Emu does (verifyKeyProof).
 *    node --test demo/ro3-launcher.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair } from '../protocol/keys.js';
import { verifyKeyProof } from '../protocol/challenge.js';
import { ro3Params, ro3Audience, listedRealm, signedProfile, linkAccount, returnUrl, ro3View, RO3_RULESET, shopInfo, zkltcToWei, shopAmount, pay, claim } from '../cabinet/ro3.js';

const state = 'ab'.repeat(16);
const serverId = 'cd'.repeat(32);
const otherId = 'ef'.repeat(32);
const realm = 'https://fake-realm.trycloudflare.com';
const nodeUrl = 'https://node.example';
const req = (r, id = serverId) => `#/ro3?return=50123&state=${state}&realm=${encodeURIComponent(r)}&server=Official%20RO3&serverId=${id}`;

test('ro3: only a well-formed launcher request is read; a server needs https and a node id', () => {
  assert.deepEqual(ro3Params(`#/ro3?return=50123&state=${state}`), { port: 50123, state, realm: null, serverId: null, shop: false });
  assert.deepEqual(ro3Params(req(realm + '/')), { port: 50123, state, realm, serverId, shop: false });
  assert.equal(ro3Params(req('http://evil.example')).realm, null, 'plain http would carry the password in the clear');
  assert.equal(ro3Params(req('http://127.0.0.1:5480')).realm, 'http://127.0.0.1:5480', 'this machine, for development');
  assert.equal(ro3Params(`#/ro3?return=50123&state=${state}&realm=${encodeURIComponent(realm)}`).realm, null, 'no node id');
  assert.equal(ro3Params(req('javascript:alert(1)')).realm, null);
  assert.equal(ro3Params(`#/ro3?return=80&state=${state}`), null);
  assert.equal(ro3Params('#/ro3?return=50123&state=nope'), null);
});

/** This page's node: GET /ro3/hosts lists the real server only. */
const node = (hosts = [{ nodeId: serverId, name: 'New Prontera', url: realm }]) => async (url) => {
  assert.equal(url, `${nodeUrl}/ro3/hosts`);
  return Response.json({ hosts });
};

test('ro3: the server must be listed by this page\'s node, and is named by the listing, not the URL', async () => {
  const p = ro3Params(req(realm));
  assert.deepEqual(await listedRealm({ nodeUrl, ...p, fetchImpl: node() }), { name: 'New Prontera', url: realm, serverId });
  const evil = ro3Params(req('https://evil.example'));
  await assert.rejects(listedRealm({ nodeUrl, ...evil, fetchImpl: node() }), /not on LITNODE/, 'a link to a server the mesh does not list');
  const wrongId = ro3Params(req(realm, otherId));
  await assert.rejects(listedRealm({ nodeUrl, ...wrongId, fetchImpl: node() }), /not on LITNODE/, 'a listed address under another node id');
  await assert.rejects(listedRealm({ nodeUrl, ...p, fetchImpl: async () => new Response('', { status: 404 }) }), /does not list RO3 servers/);
});

test('ro3: a profile counts once the node bound this page\'s key to it', () => {
  const key = 'ef'.repeat(32);
  const session = { tokenId: '7', name: 'Pat', address: '0xAbC', custody: 'here', playerKey: { owner: '0xabc', active: true } };
  assert.deepEqual(signedProfile(session, key), { ok: true, name: 'Pat', tokenId: '7', address: '0xAbC' });
  assert.equal(signedProfile({ ...session, playerKey: null }, key).ok, false);
  assert.equal(signedProfile({ ...session, custody: 'elsewhere', playerKey: null }, key).ok, false);
  assert.equal(signedProfile(null, key).ok, false);
});

/** An RO3 server: a challenge naming `aud`, then a link checked as Http/ArcadeLinkEndpoints.cs does. */
function server(kp, { aud = ro3Audience(serverId), linked = false } = {}) {
  const nonces = new Set();
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, realm);
    if (u.pathname === '/ro3emu/arcade/challenge') {
      const nonce = crypto.randomUUID().replace(/-/g, '');
      nonces.add(nonce);
      return Response.json({ aud, nonce, rulesetId: RO3_RULESET });
    }
    const form = new URLSearchParams(init.body);
    sent.push(Object.fromEntries(form));
    const ok = nonces.delete(form.get('nonce')) && await verifyKeyProof({ aud, nonce: form.get('nonce'), player: form.get('player'), rulesetId: RO3_RULESET }, form.get('sig'));
    if (!ok || form.get('player') !== kp.publicKey) return Response.json({ code: 401, reason: 'Signature' });
    if (form.get('password') !== 'secret') return Response.json({ code: 401, reason: 'password' });
    if (linked) return Response.json({ code: 409, reason: 'ProfileLinked' });
    return Response.json({ code: 0, account: form.get('account') });
  };
  return { fetchImpl, sent };
}

test('ro3: linking signs the server\'s own challenge with the player key', async () => {
  const kp = await generateKeypair();
  const player = { id: kp.publicKey, privateKey: kp.privateKey };
  const link = (s, extra = {}) => linkAccount({ realm, serverId, account: 'Pat', password: 'secret', player, fetchImpl: s.fetchImpl, ...extra });
  const s = server(kp);
  assert.equal(await link(s), 'Pat');
  assert.equal(s.sent[0].account, 'Pat');
  await assert.rejects(link(s, { password: 'wrong' }), /do not match/);
  await assert.rejects(link(server(kp, { linked: true })), /already linked/);
  await assert.rejects(link(s, { account: '' }), /Enter the name/);
  await assert.rejects(link({ fetchImpl: async () => new Response('', { status: 404 }) }), /not turned it on/);
});

test('ro3: a server passing on another server\'s challenge gets nothing signed', async () => {
  const kp = await generateKeypair();
  const player = { id: kp.publicKey, privateKey: kp.privateKey };
  const relay = server(kp, { aud: ro3Audience(otherId) }); // the other server's real challenge
  await assert.rejects(linkAccount({ realm, serverId, account: 'Pat', password: 'secret', player, fetchImpl: relay.fetchImpl }), /not its own/);
  assert.equal(relay.sent.length, 0, 'no proof, and no password, was sent');
});

test('ro3: the launcher gets public facts only, and the page names the listed server', () => {
  const params = ro3Params(req(realm));
  const url = new URL(returnUrl(params, { name: 'Pat', tokenId: '7', address: '0xabc' }, 'Pat'));
  assert.equal(url.origin, 'http://127.0.0.1:50123');
  assert.equal(url.pathname, '/ro3/return');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['account', 'address', 'name', 'serverId', 'state', 'tokenId']);
  const profile = { name: 'Pat', tokenId: '7' };
  assert.match(ro3View({ params, profile, listed: { name: 'New Prontera' } }), /Link your account on <b>New Prontera<\/b>/);
  assert.doesNotMatch(ro3View({ params, profile, listed: { name: 'New Prontera' } }), /Official RO3/, 'the URL\'s name is never shown');
  assert.doesNotMatch(ro3View({ params, profile }), /ro3-link/, 'no form before the server is checked');
  assert.match(ro3View({ params: null }), /Open this page from the RO3 on LITNODE launcher/);
  assert.doesNotMatch(ro3View({ params, profile: { name: '<b>x</b>', tokenId: '7' }, listed: { name: 'y' } }), /<b>x<\/b>/);
});

// ---------------------------------------------------------------- shop
const treasury = '0x' + 'aa'.repeat(20);
const price = 400000000000000000n; // 0.4 zkLTC per 100

test('ro3 shop: zkLTC is read exactly and buys what the server will credit', () => {
  assert.equal(zkltcToWei('0.4'), price);
  assert.equal(zkltcToWei(' 1 '), 10n ** 18n);
  assert.equal(zkltcToWei('0.000000000000000001'), 1n);
  for (const bad of ['', '0', '-1', '1e3', 'abc', '0.1234567890123456789']) assert.equal(zkltcToWei(bad), null, bad);
  assert.equal(shopAmount(price, price), 100);
  assert.equal(shopAmount(10n ** 18n, price), 250);
  assert.equal(shopAmount(1n, price), 0);
});

test('ro3 shop: only a well-formed litVM price list is used', async () => {
  const answer = (body) => async () => Response.json(body);
  assert.deepEqual(await shopInfo({ realm, fetchImpl: answer({ treasury, priceWeiPer100: String(price), currencyItem: 3, chainId: 4441 }) }), { treasury, priceWeiPer100: price, currencyItem: 3 });
  assert.equal(await shopInfo({ realm, fetchImpl: answer({ treasury, priceWeiPer100: String(price), chainId: 1 }) }), null, 'another chain');
  assert.equal(await shopInfo({ realm, fetchImpl: answer({ treasury: 'nope', priceWeiPer100: String(price), chainId: 4441 }) }), null);
  assert.equal(await shopInfo({ realm, fetchImpl: async () => new Response('', { status: 404 }) }), null, 'a server that sells nothing');
});

test('ro3 shop: the payment goes to the treasury and names this page\'s key', async () => {
  const sent = [];
  const wallet = { connect: async () => '0xbuyer', chainId: async () => 4441, pay: async (...a) => { sent.push(a); return '0x' + '11'.repeat(32); } };
  const key = 'cd'.repeat(32);
  assert.equal(await pay({ info: { treasury }, wei: price, playerKey: key, wallet }), '0x' + '11'.repeat(32));
  assert.deepEqual(sent, [['0xbuyer', treasury, price, '0x' + key]]);
});

test('ro3 shop: a wallet switched off litVM after connecting sends nothing', async () => {
  let chain = 4441;
  const sent = [];
  // connect() puts the wallet on litVM; the player then switches to Ethereum mainnet before confirming.
  const wallet = { connect: async () => { chain = 1; return '0xbuyer'; }, chainId: async () => chain, pay: async (...a) => { sent.push(a); return '0x'; } };
  await assert.rejects(pay({ info: { treasury }, wei: price, playerKey: 'cd'.repeat(32), wallet }), /not on litVM/);
  assert.deepEqual(sent, [], 'no transfer was attempted');
});

test('ro3 shop: a claim waits for litVM, and says why it cannot credit', async () => {
  const tx = '0x' + '11'.repeat(32);
  const answers = [{ code: 202, reason: 'Pending' }, { code: 0, amount: 250, already: false }];
  const fetchImpl = async (url, init) => {
    assert.equal(url, `${realm}/ro3emu/shop/claim`);
    assert.equal(new URLSearchParams(init.body).get('tx'), tx);
    return Response.json(answers.shift());
  };
  assert.deepEqual(await claim({ realm, tx, fetchImpl, wait: async () => {} }), { amount: 250, already: false });
  const notLinked = async () => Response.json({ code: 409, reason: 'NotLinked' });
  await assert.rejects(claim({ realm, tx, fetchImpl: notLinked, wait: async () => {} }), /Link one, then press Claim again/);
  const never = async () => Response.json({ code: 202, reason: 'Pending' });
  await assert.rejects(claim({ realm, tx, fetchImpl: never, tries: 2, wait: async () => {} }), /kept for you/);
});

test('ro3 shop: the page shows the price and returns what was credited', () => {
  const params = ro3Params(req(realm) + '&shop=1');
  assert.equal(params.shop, true);
  const html = ro3View({ params, profile: { name: 'Pat', tokenId: '7' }, listed: { name: 'New Prontera' }, shop: { priceWeiPer100: price }, amount: '0.4' });
  assert.match(html, /0\.4 zkLTC = 100/);
  assert.match(html, /= 100 Sacred Relic Crystals/);
  const back = new URL(returnUrl(params, { name: 'Pat', tokenId: '7' }, null, 100));
  assert.equal(back.searchParams.get('credited'), '100');
  assert.equal(back.searchParams.get('serverId'), serverId);
});

test('ro3 page: the same state draws the same markup, so a node poll does not redraw (and wipe) the form', () => {
  // cabinet/app.js renderRo3 leaves the page alone when the markup is unchanged; anything time- or random-dependent
  // in the view would redraw it every 5 s and erase what the player is typing.
  const st = { params: ro3Params(req(realm)), profile: { name: 'Pat', tokenId: '7' }, listed: { name: 'New Prontera' } };
  assert.equal(ro3View(st), ro3View({ ...st }));
  assert.match(ro3View(st), /id="ro3-account"[^>]*placeholder=/, 'a placeholder keeps the empty required field from showing as invalid');
  assert.notEqual(ro3View({ ...st, error: 'x' }), ro3View(st), 'an error does redraw');
});
