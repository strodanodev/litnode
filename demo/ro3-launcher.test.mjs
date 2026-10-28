/** The arcade's #/ro3 page for the RO3 on LITNODE launcher (cabinet/ro3.js): it reads only a well-formed launcher
 *  request, trusts nothing the URL says about the server (it must be listed by this page's node, its challenge must
 *  name that listing's node), links by signing the server's challenge with the player key, and sends public facts only
 *  back to the launcher. The RO3 server is a stand-in that checks the proof as RO3Emu does (verifyKeyProof).
 *    node --test demo/ro3-launcher.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair } from '../protocol/keys.js';
import { verifyKeyProof } from '../protocol/challenge.js';
import { ro3Params, ro3Audience, listedRealm, signedProfile, linkAccount, returnUrl, ro3View, RO3_RULESET } from '../cabinet/ro3.js';

const state = 'ab'.repeat(16);
const serverId = 'cd'.repeat(32);
const otherId = 'ef'.repeat(32);
const realm = 'https://fake-realm.trycloudflare.com';
const nodeUrl = 'https://node.example';
const req = (r, id = serverId) => `#/ro3?return=50123&state=${state}&realm=${encodeURIComponent(r)}&server=Official%20RO3&serverId=${id}`;

test('ro3: only a well-formed launcher request is read; a server needs https and a node id', () => {
  assert.deepEqual(ro3Params(`#/ro3?return=50123&state=${state}`), { port: 50123, state, realm: null, serverId: null });
  assert.deepEqual(ro3Params(req(realm + '/')), { port: 50123, state, realm, serverId });
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
