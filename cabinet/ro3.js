/** #/ro3: the RO3 on LITNODE launcher signs a player in here (RO3 × LITNODE MVP).
 *
 *  The launcher listens on a random 127.0.0.1 port and opens `#/ro3?return=<port>&state=<hex>`, plus
 *  `&realm=<server url>&server=<name>&serverId=<node id>` when the player asked to link an RO3 account on that server.
 *  This page:
 *    1. signs the player in with AIR as the rest of the arcade does (their litVM profile, this page's player key bound);
 *    2. with a realm: links the RO3 account the player names (its in-game name and password) to that profile on the
 *       server. The server's /ro3emu/arcade/challenge gives a nonce; this page signs litnode's `key` proof
 *       `{ aud, nonce, player, rulesetId: 'ro3.v1' }` with its player key, and posts it with the name and password to
 *       /ro3emu/arcade/link. The server checks the proof, the profile on litVM and the password (RO3Emu
 *       Http/ArcadeLinkEndpoints.cs);
 *    3. sends the browser back to http://127.0.0.1:<port>/ro3/return with public facts only: the profile's name,
 *       number and address, and the linked account's name. No AIR token or key leaves this page.
 *  The password goes from this page to the RO3 server only (over its https tunnel); the arcade keeps nothing. */
import { signKeyProof, NONCE_RE, AUD_RE } from './protocol/challenge.js';

export const RO3_RULESET = 'ro3.v1';
const STATE_RE = /^[0-9a-f]{32}$/;
const NODE_RE = /^[0-9a-f]{64}$/;

/** The launcher's request from `#/ro3?…`, or null when it is not one. */
export function ro3Params(hash) {
  const q = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const port = Number(q.get('return'));
  const state = q.get('state') ?? '';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !STATE_RE.test(state)) return null;
  const realm = (q.get('realm') ?? '').replace(/\/$/, '');
  const okRealm = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(realm) ? realm : null;   // a bare origin: a server's tunnel
  return {
    port, state, realm: okRealm, server: okRealm ? (q.get('server') ?? '').slice(0, 32) : null,
    serverId: okRealm && NODE_RE.test(q.get('serverId') ?? '') ? q.get('serverId') : null,
  };
}

/** The profile the node's /air/session answer names, once it bound this page's key to it (else the link cannot work). */
export function signedProfile(session, playerKey) {
  if (!session?.tokenId) return { ok: false, why: 'Your profile is still being made. Try again in a minute.' };
  const b = session.playerKey;
  if (playerKey && !(b?.active && String(b.owner).toLowerCase() === String(session.address).toLowerCase())) {
    return { ok: false, why: session.custody === 'elsewhere'
      ? 'Your profile is held by another node, so this page cannot link accounts for it yet.'
      : 'This page\'s key is not bound to your profile yet. Try again in a minute.' };
  }
  return { ok: true, name: session.name ?? null, tokenId: String(session.tokenId), address: session.address ?? null };
}

const REASONS = {
  password: 'That name and password do not match an account on this server.',
  ProfileLinked: 'Your profile is already linked to an account on this server.',
  AccountLinked: 'That account is already linked to another profile.',
  Unbound: 'The server does not see this page\'s key on your profile yet. Try again in a minute.',
  ChainUnavailable: 'The server could not read litVM just now. Try again in a minute.',
};

/** Link `account` on the server at `realm` to the signed-in profile. Resolves to the account; throws with a readable reason. */
export async function linkAccount({ realm, account, password, player, fetchImpl = fetch }) {
  if (!account || !password) throw new Error('Enter the name and password you use in the game on this server.');
  let r = await fetchImpl(`${realm}/ro3emu/arcade/challenge`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) throw new Error('The server does not answer. Is it still online?');
  if (r.status === 404) throw new Error('This server does not link arcade accounts (its host has not turned it on).');
  const c = await r.json();
  if (c?.rulesetId !== RO3_RULESET || !AUD_RE.test(c?.aud ?? '') || !NONCE_RE.test(c?.nonce ?? '')) throw new Error('The server sent a malformed challenge.');
  const sig = await signKeyProof({ aud: c.aud, nonce: c.nonce, player: player.id, rulesetId: RO3_RULESET }, player.privateKey);
  const body = new URLSearchParams({ player: player.id, nonce: c.nonce, sig, account, password });
  r = await fetchImpl(`${realm}/ro3emu/arcade/link`, { method: 'POST', body, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!r) throw new Error('The server stopped answering. Try again.');
  const a = await r.json().catch(() => ({}));
  if (a.code === 0) return a.account ?? account;
  throw new Error(REASONS[a.reason] ?? `The server refused the link (${a.code ?? r.status} ${a.reason ?? ''}).`);
}

/** Where the browser goes back to: the launcher's loopback port, with public facts only. */
export function returnUrl(params, profile, account = null) {
  const q = new URLSearchParams({ state: params.state, name: profile.name ?? '', tokenId: profile.tokenId, address: profile.address ?? '' });
  if (account && params.serverId) { q.set('account', account); q.set('serverId', params.serverId); }
  return `http://127.0.0.1:${params.port}/ro3/return?${q}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The page. `st` = { params, profile, busy, error, done }. */
export function ro3View(st) {
  const head = '<div class="panel-h"><h3>RO3 on LITNODE</h3></div>';
  const wrap = (inner) => `<section class="panel hi s12">${head}${inner}</section>`;
  if (!st.params) return wrap('<div class="empty">Open this page from the RO3 on LITNODE launcher: its Profile tab adds what this page needs.</div>');
  const error = st.error ? `<div class="sub" style="color:var(--bad,#ff7b8a)">${esc(st.error)}</div>` : '';
  if (st.busy) return wrap(`<div class="sub dim">${esc(st.busy)}</div>${error}`);
  if (st.done) return wrap(`<div class="sub">Done. Your browser goes back to the launcher; if it does not, <a href="${esc(st.done)}">click here</a>.</div>`);
  if (!st.profile) return wrap(`<div class="sub">Sign in to link RO3 on LITNODE to your arcade profile.</div><button class="btn primary" id="ro3-signin">Sign in</button> <span class="dim">email or Google · no wallet</span>${error}`);
  const who = `<div class="sub">Signed in as <b>${esc(st.profile.name ?? `profile #${st.profile.tokenId}`)}</b> · profile #${esc(st.profile.tokenId)}</div>`;
  if (!st.params.realm) return wrap(`${who}<button class="btn primary" id="ro3-back">Back to the launcher</button>${error}`);
  return wrap(`${who}
    <div class="sub">Link your account on <b>${esc(st.params.server || st.params.realm)}</b>: the name and password you use in the game's login box there. It is checked by that server and not kept here.</div>
    <form id="ro3-link" class="sub" autocomplete="off">
      <input id="ro3-account" placeholder="In-game account name" maxlength="64" required>
      <input id="ro3-password" type="password" placeholder="Password" required>
      <button class="btn primary" type="submit">Link and go back</button>
      <button class="btn" type="button" id="ro3-back">Skip</button>
    </form>${error}`);
}
