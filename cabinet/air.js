/** Universal login: sign in with AIR Kit, get a litVM identity from a node.
 *  docs/UNIVERSAL-LOGIN.md.
 *
 *  AIR Kit (vendor/airkit.esm.js, Apache-2.0, @mocanetwork/airkit) opens
 *  its own login dialog — Google, passwordless email, an external wallet —
 *  and hands back a session token. The cabinet posts that token to its node
 *  (`POST /air/session`) with this browser's player key; the node verifies
 *  the token against AIR's JWKS, keeps a litVM PROXY WALLET for the AIR
 *  account, mints the PlayerProfile with the AIR id bound to it on first
 *  sign-in and binds this browser's key to it. From then on the key signs
 *  play as before; the chain says which profile it belongs to.
 *
 *  Nothing here holds a secret: the AIR session lives in AIR's own iframe,
 *  the proxy key on the node. What is remembered locally is the answer —
 *  who this browser is signed in as — for display. The SDK is loaded on
 *  first use (it is 180 KB and injects an iframe), or at boot when a
 *  remembered session says it is worth rehydrating. */
import { AIR } from './config.js';
import { decodeJwtPayload } from './protocol/air.js';

const KEY = 'cabinet.air';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
const store = (v) => { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

let sdk = null, svc = null, initPromise = null;
const me = { loggedIn: false, id: null, address: null, email: null, session: load() };

export const configured = () => !!AIR?.partnerId;
/** What this browser last learned about itself (display only; the node re-verifies every time). */
export const current = () => ({ ...me });
export const remembered = () => !!load();

async function service() {
  if (!configured()) throw new Error('AIR is not configured (cabinet/config.js AIR.partnerId)');
  sdk ??= await import('./vendor/airkit.esm.js');
  if (!svc) {
    svc = new sdk.AirService({ partnerId: AIR.partnerId });
    initPromise = svc.init({ buildEnv: sdk.BUILD_ENV?.[String(AIR.buildEnv ?? 'sandbox').toUpperCase()] ?? AIR.buildEnv, enableLogging: false, skipRehydration: false })
      .then((r) => { if (r?.isLoggedIn) applyLogin(r); return r; });
  }
  await initPromise;
  return svc;
}
function applyLogin(r) {
  me.loggedIn = !!r.isLoggedIn; me.id = r.id ?? me.id; me.address = r.abstractAccountAddress ?? me.address;
  const p = decodeJwtPayload(r.token); if (p?.email && typeof p.email === 'string') me.email = p.email;
}
async function fillUser(s) {
  try { const info = await s.getUserInfo(); me.email = info?.user?.email ?? me.email; me.address = info?.user?.abstractAccountAddress ?? me.address; me.id = info?.user?.id ?? me.id; } catch { /* optional */ }
}

/** Silent: pick up an existing AIR session (30-day cookie in AIR's iframe). */
export async function rehydrate() {
  const s = await service();
  if (s.isLoggedIn) { me.loggedIn = true; await fillUser(s); }
  else { me.loggedIn = false; me.session = null; store(null); } // the AIR session ended: forget the remembered identity too
  return me.loggedIn;
}
/** Interactive: AIR's dialog. Must be called from a user gesture. */
export async function login() {
  const s = await service();
  const r = await s.login();
  if (!r?.isLoggedIn) throw new Error('AIR login did not complete');
  applyLogin(r); await fillUser(s);
  return current();
}
export async function logout() {
  try { const s = await service(); await s.logout(); } catch { /* already out */ }
  me.loggedIn = false; me.id = null; me.address = null; me.email = null; me.session = null; store(null);
}
/** A fresh session token for the node (AIR rotates them; never cache one). */
export async function token() {
  const s = await service();
  const t = await s.getAccessToken();
  return typeof t === 'string' ? t : t?.token;
}

/** Ask the node for this account's litVM identity, binding this browser's key.
 *  The node answers { address (proxy), tokenId, name, custody, playerKey, steps }. */
export async function nodeSession(nodeUrl, { playerKey = null, name = null } = {}) {
  const t = await token();
  if (!t) throw new Error('no AIR session token');
  const r = await fetch(`${nodeUrl}/air/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t, playerKey, name }), signal: AbortSignal.timeout(90_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `node answered ${r.status}`);
  me.session = { ...body, at: Date.now() };
  store(me.session);
  return me.session;
}
/** Single sign-on into a title: AIR rewrites the launch URL with a one-time
 *  token so the title's own AIR Kit picks the session up without a second
 *  dialog (which an iframe could not show anyway — AIR's login page refuses
 *  to be framed). Falls back to the plain URL when not signed in or when AIR
 *  cannot vouch for that destination. */
export async function ssoUrl(url) {
  if (!me.loggedIn) return url;
  try { const s = await service(); const r = await s.goToPartner(url); return typeof r?.urlWithToken === 'string' && r.urlWithToken ? r.urlWithToken : url; }
  catch { return url; }
}
/** Does this node do universal login at all? */
export async function nodeSupports(nodeUrl) {
  try { const r = await fetch(`${nodeUrl}/air`, { signal: AbortSignal.timeout(5000) }); const j = await r.json(); return !!j.enabled; } catch { return false; }
}
