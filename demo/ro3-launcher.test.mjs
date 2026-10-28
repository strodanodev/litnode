/** The arcade's #/ro3 page for the RO3 on LITNODE launcher (cabinet/ro3.js): it reads only a well-formed launcher
 *  request, links an RO3 account by signing the server's challenge with the player key, and sends public facts only
 *  back to the launcher. The RO3 server is a stand-in that checks the proof as RO3Emu does (verifyKeyProof).
 *    node --test demo/ro3-launcher.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair } from '../protocol/keys.js';
import { verifyKeyProof } from '../protocol/challenge.js';
import { ro3Params, signedProfile, linkAccount, returnUrl, ro3View, RO3_RULESET } from '../cabinet/ro3.js';

const state = 'ab'.repeat(16);
const serverId = 'cd'.repeat(32);
const realm = 'https://fake-realm.trycloudflare.com';

test('ro3: only a well-formed launcher request is read', () => {
  assert.deepEqual(ro3Params(`#/ro3?return=50123&state=${state}`), { port: 50123, state, realm: null, server: null, serverId: null });
  const withRealm = ro3Params(`#/ro3?return=50123&state=${state}&realm=${encodeURIComponent(realm + '/')}&server=New%20Prontera&serverId=${serverId}`);
  assert.deepEqual(withRealm, { port: 50123, state, realm, server: 'New Prontera', serverId });
  assert.equal(ro3Params(`#/ro3?return=80&state=${state}`), null);
  assert.equal(ro3Params('#/ro3?return=50123&state=nope'), null);
  assert.equal(ro3Params(`#/ro3?return=50123&state=${state}&realm=javascript:alert(1)`).realm, null);
});

test('ro3: a profile counts once the node bound this page\'s key to it', () => {
  const key = 'ef'.repeat(32);
  const session = { tokenId: '7', name: 'Pat', address: '0xAbC', custody: 'here', playerKey: { owner: '0xabc', active: true } };
  assert.deepEqual(signedProfile(session, key), { ok: true, name: 'Pat', tokenId: '7', address: '0xAbC' });
  assert.equal(signedProfile({ ...session, playerKey: null }, key).ok, false);
  assert.equal(signedProfile({ ...session, custody: 'elsewhere', playerKey: null }, key).ok, false);
  assert.equal(signedProfile(null, key).ok, false);
});

/** An RO3 server: a challenge, then a link checked as Http/ArcadeLinkEndpoints.cs does (proof, then the password). */
function server(kp, { linked = false } = {}) {
  const nonces = new Set();
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, realm);
    if (u.pathname === '/ro3emu/arcade/challenge') {
      const nonce = crypto.randomUUID().replace(/-/g, '');
      nonces.add(nonce);
      return Response.json({ aud: 'ro3.test-realm', nonce, rulesetId: RO3_RULESET });
    }
    const form = new URLSearchParams(init.body);
    sent.push(Object.fromEntries(form));
    const ok = nonces.delete(form.get('nonce')) && await verifyKeyProof({ aud: 'ro3.test-realm', nonce: form.get('nonce'), player: form.get('player'), rulesetId: RO3_RULESET }, form.get('sig'));
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
  const s = server(kp);
  assert.equal(await linkAccount({ realm, account: 'Pat', password: 'secret', player, fetchImpl: s.fetchImpl }), 'Pat');
  assert.equal(s.sent[0].account, 'Pat');
  await assert.rejects(linkAccount({ realm, account: 'Pat', password: 'wrong', player, fetchImpl: s.fetchImpl }), /do not match/);
  await assert.rejects(linkAccount({ realm, account: 'Pat', password: 'secret', player, fetchImpl: server(kp, { linked: true }).fetchImpl }), /already linked/);
  await assert.rejects(linkAccount({ realm, account: '', password: 'x', player, fetchImpl: s.fetchImpl }), /Enter the name/);
  const off = async () => new Response('', { status: 404 });
  await assert.rejects(linkAccount({ realm, account: 'Pat', password: 'secret', player, fetchImpl: off }), /not turned it on/);
});

test('ro3: the launcher gets public facts only, and the page reads plainly', () => {
  const params = ro3Params(`#/ro3?return=50123&state=${state}&realm=${encodeURIComponent(realm)}&server=New%20Prontera&serverId=${serverId}`);
  const url = new URL(returnUrl(params, { name: 'Pat', tokenId: '7', address: '0xabc' }, 'Pat'));
  assert.equal(url.origin, 'http://127.0.0.1:50123');
  assert.equal(url.pathname, '/ro3/return');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['account', 'address', 'name', 'serverId', 'state', 'tokenId']);
  assert.match(ro3View({ params, profile: { name: 'Pat', tokenId: '7' } }), /Link your account on <b>New Prontera<\/b>/);
  assert.match(ro3View({ params: null }), /Open this page from the RO3 on LITNODE launcher/);
  assert.doesNotMatch(ro3View({ params, profile: { name: '<b>x</b>', tokenId: '7' } }), /<b>x<\/b>/);
});
