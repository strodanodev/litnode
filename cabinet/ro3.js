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
 *  The password goes from this page to the RO3 server only (over its https tunnel); the arcade keeps nothing.
 *
 *  What the URL says about the server is never trusted (anyone can send a player a #/ro3 link):
 *    - the server must be one this page's own node lists at GET /ro3/hosts, with the same node id and address, and its
 *      name is taken from that listing, never from the URL;
 *    - its challenge's aud must be `ro3.<the first 32 hex of that node id>` (the server's Ro3Emu:ArcadeLink:Audience),
 *      so a server that passes on another server's challenge gets no proof that counts there;
 *    - https only (plain http only to this machine, for development). */
import { signKeyProof, NONCE_RE, AUD_RE } from './protocol/challenge.js';

export const RO3_RULESET = 'ro3.v1';
const STATE_RE = /^[0-9a-f]{32}$/;
const NODE_RE = /^[0-9a-f]{64}$/;

/** The aud a server must name in its challenge: tied to its LITNODE node id, the identity the mesh lists it under. */
export const ro3Audience = (nodeId) => `ro3.${nodeId.slice(0, 32)}`;

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

/** The launcher's request from `#/ro3?…`, or null when it is not one. */
export function ro3Params(hash) {
  const q = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const port = Number(q.get('return'));
  const state = q.get('state') ?? '';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !STATE_RE.test(state)) return null;
  const realm = (q.get('realm') ?? '').replace(/\/$/, '').toLowerCase();
  // A bare origin (a server's tunnel), https only; and its node id. Who it is comes from the mesh: listedRealm().
  const okRealm = (/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(realm) || LOCAL.test(realm)) && NODE_RE.test(q.get('serverId') ?? '') ? realm : null;
  return { port, state, realm: okRealm, serverId: okRealm ? q.get('serverId') : null, shop: !!okRealm && q.get('shop') === '1' };
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

/** The server as this page's own node lists it (GET /ro3/hosts): same node id and address, or it is refused. */
export async function listedRealm({ nodeUrl, realm, serverId, fetchImpl = fetch }) {
  const r = await fetchImpl(`${nodeUrl}/ro3/hosts`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const hosts = r?.ok ? (await r.json().catch(() => ({}))).hosts : null;
  if (!Array.isArray(hosts)) throw new Error("The arcade's node does not list RO3 servers right now, so the server cannot be checked. Try again later.");
  const h = hosts.find((x) => x?.nodeId === serverId && String(x.url ?? '').replace(/\/$/, '').toLowerCase() === realm);
  if (!h) throw new Error('That server is not on LITNODE (or moved). Open Link account again from the launcher.');
  return { name: String(h.name ?? '').slice(0, 32) || `server ${serverId.slice(0, 12)}`, url: realm, serverId };
}

/** Link `account` on the listed server to the signed-in profile. Resolves to the account; throws with a readable reason. */
export async function linkAccount({ realm, serverId, account, password, player, fetchImpl = fetch }) {
  if (!account || !password) throw new Error('Enter the name and password you use in the game on this server.');
  let r = await fetchImpl(`${realm}/ro3emu/arcade/challenge`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) throw new Error('The server does not answer. Is it still online?');
  if (r.status === 404) throw new Error('This server does not link arcade accounts (its host has not turned it on).');
  const c = await r.json();
  if (c?.rulesetId !== RO3_RULESET || !AUD_RE.test(c?.aud ?? '') || !NONCE_RE.test(c?.nonce ?? '')) throw new Error('The server sent a malformed challenge.');
  // The challenge must be this server's own: a server passing on another's would get a proof that counts there.
  if (c.aud !== ro3Audience(serverId)) throw new Error("This server's challenge is not its own (its aud does not name its LITNODE node), so nothing was signed.");
  const sig = await signKeyProof({ aud: c.aud, nonce: c.nonce, player: player.id, rulesetId: RO3_RULESET }, player.privateKey);
  const body = new URLSearchParams({ player: player.id, nonce: c.nonce, sig, account, password });
  r = await fetchImpl(`${realm}/ro3emu/arcade/link`, { method: 'POST', body, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!r) throw new Error('The server stopped answering. Try again.');
  const a = await r.json().catch(() => ({}));
  if (a.code === 0) return a.account ?? account;
  throw new Error(REASONS[a.reason] ?? `The server refused the link (${a.code ?? r.status} ${a.reason ?? ''}).`);
}

// ---------------------------------------------------------------- shop: premium currency for zkLTC (RO3Emu Http/ShopEndpoints.cs)
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const LITVM_CHAIN_ID = 4441;

/** The server's price list (GET /ro3emu/shop): its treasury, the price of 100 in wei, the item mailed. Null when it sells nothing. */
export async function shopInfo({ realm, fetchImpl = fetch }) {
  const r = await fetchImpl(`${realm}/ro3emu/shop`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r?.ok) return null;
  const i = await r.json().catch(() => null);
  if (!ADDRESS_RE.test(i?.treasury ?? '') || !/^[1-9][0-9]{0,40}$/.test(i?.priceWeiPer100 ?? '') || i?.chainId !== LITVM_CHAIN_ID) return null;
  return { treasury: i.treasury, priceWeiPer100: BigInt(i.priceWeiPer100), currencyItem: i.currencyItem };
}

/** zkLTC typed by the player ("0.4") into wei, exactly (18 decimals); null when it is not a positive amount. */
export function zkltcToWei(text) {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,18}))?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

/** What `wei` buys: floor(wei × 100 / price), as the server computes it. */
export const shopAmount = (wei, priceWeiPer100) => Number((wei * 100n) / priceWeiPer100);

/** Pay with the browser's wallet: zkLTC to the treasury, this page's player key as the data (who the currency is for). */
export async function pay({ info, wei, playerKey, wallet }) {
  const from = await wallet.connect();
  // Checked here too, right before paying (wallet.pay checks again and pins chainId): a player may switch networks in
  // between, and the same transfer on another chain moves real value.
  if (await wallet.chainId() !== LITVM_CHAIN_ID) throw new Error('Your wallet is not on litVM testnet. Switch it back and try again; nothing was sent.');
  return wallet.pay(from, info.treasury, wei, '0x' + playerKey);
}

const SHOP_REASONS = {
  NotLinked: 'Your profile has no RO3 account linked on this server yet. Link one, then press Claim again: the payment is kept for you.',
  NoCharacter: 'Your linked account has no character on this server yet. Make one in the game, then press Claim again.',
  TooSmall: 'That payment is too small to buy anything.',
  NotToTreasury: 'That payment did not go to this server.',
  Failed: 'That payment failed on litVM, so nothing was charged.',
  NoBuyer: 'That payment does not name a buyer.',
  Unbound: 'The key in that payment is not on an arcade profile.',
};

/** Ask the server to credit a mined payment; waits while litVM has not shown it yet. Resolves to { amount, already }. */
export async function claim({ realm, tx, fetchImpl = fetch, tries = 10, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchImpl(`${realm}/ro3emu/shop/claim`, { method: 'POST', body: new URLSearchParams({ tx }), signal: AbortSignal.timeout(20000) }).catch(() => null);
    const a = r ? await r.json().catch(() => ({})) : {};
    if (a.code === 0) return { amount: a.amount, already: !!a.already };
    if (a.code !== 202 && r) throw new Error(SHOP_REASONS[a.reason] ?? `The server refused the claim (${a.reason ?? r.status}).`);
    await wait(3000);
  }
  throw new Error('The server has not seen the payment on litVM yet. Press Claim again in a minute: it is kept for you.');
}

/** Where the browser goes back to: the launcher's loopback port, with public facts only. */
export function returnUrl(params, profile, account = null, credited = null) {
  const q = new URLSearchParams({ state: params.state, name: profile.name ?? '', tokenId: profile.tokenId, address: profile.address ?? '' });
  if (account && params.serverId) { q.set('account', account); q.set('serverId', params.serverId); }
  if (credited && params.serverId) { q.set('credited', String(credited)); q.set('serverId', params.serverId); }
  return `http://127.0.0.1:${params.port}/ro3/return?${q}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


const field = (id, label, attrs) => `<label class="ro3-field"><span>${label}</span><input id="${id}" class="ask-input" ${attrs}></label>`;

/** The shop part: price, an amount, Buy; then the payment's claim (repeatable with the same transaction). */
function shopView(st) {
  if (!st.shop) return `<p class="ro3-note">${st.error ? '' : 'Asking the server for its prices…'}</p><div class="ro3-actions"><button class="btn" id="ro3-back">Back to the launcher</button></div>`;
  const per = Number(st.shop.priceWeiPer100) / 1e18;
  const wei = zkltcToWei(st.amount ?? '');
  const gets = wei ? shopAmount(wei, st.shop.priceWeiPer100) : 0;
  const pending = st.tx ? `<p class="ro3-note">Payment <span class="mono">${esc(st.tx.slice(0, 10))}…</span> is kept for you. <button class="btn sm" id="ro3-claim">Claim again</button></p>` : '';
  return `<p class="ro3-lead">Buy Sacred Relic Crystals on <b>${esc(st.listed.name)}</b> with zkLTC on litVM testnet (no real value): <b>${per} zkLTC = 100</b>.
      They arrive by in-game mail to your linked account's most recently played character.</p>
    <form id="ro3-shop" class="ro3-form" autocomplete="off">
      ${field('ro3-zkltc', 'Amount (zkLTC)', `inputmode="decimal" placeholder="${per}" value="${esc(st.amount ?? '')}"`)}
      <p class="ro3-note" id="ro3-gets">${gets > 0 ? `= ${gets} Sacred Relic Crystals` : ''}</p>
      <div class="ro3-actions">
        <button class="btn primary" type="submit" ${gets > 0 ? '' : 'disabled'}>Buy with my wallet</button>
        <button class="btn" type="button" id="ro3-back">Back to the launcher</button>
      </div>
    </form>${pending}`;
}

/** The page. `st` = { params, listed (listedRealm's answer), profile, shop, amount, tx, busy, error, done }. */
export function ro3View(st) {
  const wrap = (inner) => `<div class="ro3"><section class="panel hi"><div class="panel-h"><h3>RO3 on LITNODE</h3></div><div class="panel-b">${inner}</div></section></div>`;
  if (!st.params) return wrap('<div class="empty">Open this page from the RO3 on LITNODE launcher: its Profile tab adds what this page needs.</div>');
  const error = st.error ? `<p class="ro3-error" role="alert">${esc(st.error)}</p>` : '';
  if (st.busy) return wrap(`<p class="ro3-note ro3-busy">${esc(st.busy)}</p>${error}`);
  if (st.done) return wrap(`<p class="ro3-lead">Done. Your browser goes back to the launcher; if it does not, <a class="link" href="${esc(st.done)}">click here</a>.</p>`);
  if (!st.profile) return wrap(`<p class="ro3-lead">Sign in to link RO3 on LITNODE to your arcade profile.</p><div class="ro3-actions"><button class="btn primary" id="ro3-signin">Sign in</button><span class="dim">email or Google · no wallet</span></div>${error}`);
  const who = `<div class="ro3-who"><span class="dim">Signed in as</span> <b>${esc(st.profile.name ?? `profile #${st.profile.tokenId}`)}</b><span class="tag">profile #${esc(st.profile.tokenId)}</span></div>`;
  if (!st.params.realm) return wrap(`${who}${error}<div class="ro3-actions"><button class="btn primary" id="ro3-back">Back to the launcher</button></div>`);
  if (!st.listed) return wrap(`${who}<p class="ro3-note">${st.error ? '' : 'Checking the server on LITNODE…'}</p>${error}<div class="ro3-actions"><button class="btn" id="ro3-back">Back to the launcher</button></div>`);
  if (st.params.shop) return wrap(`${who}${shopView(st)}${error}`);
  return wrap(`${who}
    <p class="ro3-lead">Link your account on <b>${esc(st.listed.name)}</b>: the name and password you use in the game's login box there. It is checked by that server and not kept here.</p>
    <form id="ro3-link" class="ro3-form" autocomplete="off">
      ${field('ro3-account', 'In-game account', 'placeholder="the name you log in with" maxlength="64" required spellcheck="false" autocapitalize="off" autocomplete="off"')}
      ${field('ro3-password', 'Password', 'type="password" placeholder="••••••••" required autocomplete="off"')}
      ${error}
      <div class="ro3-actions">
        <button class="btn primary" type="submit">Link and go back</button>
        <button class="btn" type="button" id="ro3-back">Skip</button>
      </div>
    </form>`);
}
