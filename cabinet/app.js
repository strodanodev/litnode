/** litnode arcade — gamer dashboard in front of a litnode.
 *
 *  No build step, no dependencies. Views: home (dashboard), games, one game,
 *  leaderboards, characters, inventory, node; plus a fullscreen play overlay.
 *
 *  What is real vs. placeholder:
 *    real   — node status, leaderboards, per-player stats, match history and
 *             the rating curve (all derived from the node's settled deltas),
 *             the player key (the node's own ed25519 module).
 *    sample — which fighters are unlocked, items, pets, tickets: account data
 *             that arrives with the Agent Fighter sync. Labelled "sample". */
import { loadPlayer as loadKeypair, createClient, IDENTITY_KEY } from './client.js';
import { roomCodeFor } from './protocol/pairing.js';
import { ledgerBody, signLedger } from './protocol/log.js';
import { applyDelta, sortDeltas } from './protocol/derive.js';
import { NODE_URL, GAMES as CONFIG_GAMES } from './config.js';
import { CHARACTERS, STYLES, ITEMS, ITEM_LINES, PETS, RARITY, INVENTORY_SAMPLE, portraitUrl } from './roster.js';
import { identicon, fileToAvatar } from './avatar.js';
import { paintBackdrop } from './bg.js';
import { sample, loadHistory, slots, uptimePct, hoursOnline, fmtDuration, ring, strip, heatmap } from './uptime.js';
import { readStake } from './chain.js';
import * as wallet from './wallet.js';
import * as air from './air.js';
import * as nodeops from './nodeops.js';
import * as seeds from './seeds.js';
import { CHAIN } from './config.js';
import { CABINET_VERSION } from './version.js';
import { CONTRACTS } from './contracts.js';
import { readFleet, describeEvent, checklist as fleetChecklist, ago } from './fleet.js';
import { renderBuild } from './build.js';
import { loadReceipt, renderReceipt } from './receipt.js';

const $ = (id) => document.getElementById(id);
const view = (name) => document.querySelector(`.view[data-view="${name}"]`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (id, n = 10) => (id ? `${id.slice(0, n)}…` : '—');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
// The node that serves this page IS the node to talk to (same origin, no
// preflight); a static host (Vercel) falls back to config, and the footer
// override wins over both.
const servedByNode = () => /^https?:$/.test(location.protocol) && !/vercel\.app$|litvm\.games$/.test(location.hostname) && location.port !== '5180' ? location.origin : null;
// With no node on this machine, the freshest bonded seed announced on chain
// (seeds.js) stands in — found once the local default has failed.
let seedUrl = null;
const nodeUrl = () => localStorage.getItem('cabinet.nodeUrl') || servedByNode() || seedUrl || NODE_URL;
const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const api = async (path) => (await fetch(`${nodeUrl()}${path}`, { signal: AbortSignal.timeout(5000) })).json();
/** The roster: config.js titles first (curated art and copy), then every
 *  other title the mesh is hosting right now, listed from the manifest its
 *  host gossips (`display`). A third-party title needs no entry here — a
 *  bonded node hosting a conformant ruleset with a display block is listed. */
const GAMES = [...CONFIG_GAMES];
const PRIMARY = GAMES.find((g) => g.rulesetId) ?? GAMES[0];
const ACCENTS = ['#ffb84a', '#4ad7ff', '#c77dff', '#ff6b4a', '#7cff4a'];
function mergeMeshTitles(titles) {
  let changed = false;
  for (const t of titles ?? []) {
    if (!t.display?.title || GAMES.some((g) => g.rulesetId === t.rulesetId)) continue;
    // With a TitleRegistry on the node, a title is listed only while its
    // publisher (the token holder) runs a bonded host for it; `published`
    // null = no registry, the older rule (display + a bonded host) applies.
    if (t.published === false) continue;
    const d = t.display;
    GAMES.push({
      id: t.rulesetId.replace(/\.v\d+$/, ''), title: d.title, accent: d.accent ?? ACCENTS[GAMES.length % ACCENTS.length],
      tagline: d.description ?? 'Hosted on the mesh.', description: d.description ?? `A title hosted by ${t.hosts.length} node${t.hosts.length === 1 ? '' : 's'} on the litVM Games mesh.`,
      controls: d.controls ?? [], modes: t.modes ?? [], players: t.kind === 'attested' ? 'attested' : `${Array.isArray(t.participants) ? t.participants.join('/') : t.participants}P`,
      url: d.url ?? null, cover: d.cover ?? null, rulesetId: t.rulesetId, buildHash: t.buildHash,
      status: t.kind === 'attested' ? 'attested' : 'mesh', tags: ['MESH', ...(t.published ? ['PUBLISHED'] : t.bondedHosts ? ['BONDED HOST'] : [])], badge: d.url ? new URL(d.url).host : 'mesh', playable: !!d.url, mesh: true,
    });
    changed = true;
  }
  return changed;
}

// ═══════════════════════════════════════════════ player ══
let player = null;
/** The player is an ed25519 keypair under IDENTITY_KEY (client.js), the same
 *  key the node-served page and the tests use. A key made under the cabinet's
 *  old name is migrated once. Without WebCrypto (plain http from a LAN
 *  address) there is no key: the cabinet is read-only and says so. */
async function loadPlayer() {
  let kp = null, id = null, guest = false;
  try { const old = load('cabinet.identity'); if (old && !load(IDENTITY_KEY)) { store(IDENTITY_KEY, old); store('cabinet.identity'); } } catch { /* ignore */ }
  try { kp = await loadKeypair(localStorage); id = kp.publicKey; }
  catch { id = load('cabinet.guest') || 'guest' + Array.from(crypto.getRandomValues(new Uint8Array(28)), (b) => b.toString(16).padStart(2, '0')).join(''); store('cabinet.guest', id); guest = true; }
  return { id, kp, guest, name: load('cabinet.name') || `PLAYER_${id.slice(0, 6).toUpperCase()}`, avatar: load('cabinet.avatar') || identicon(id, 160) };
}
/** In-page prompt. window.prompt() is ugly, blocked in PWA windows on some
 *  platforms and unstyled everywhere; this is the same contract — a string
 *  or null — with the cabinet's own chrome, validation and Esc/Enter. */
function ask({ title = 'cabinet', label, value = '', placeholder = '', pattern = null, maxlength = null, hint = '', ok = 'OK' }) {
  return new Promise((resolve) => {
    const d = $('ask'), inp = $('ask-input');
    $('ask-title').textContent = title; $('ask-label').textContent = label; $('ask-hint').textContent = hint; $('ask-ok').textContent = ok;
    inp.value = value; inp.placeholder = placeholder || ' ';
    if (pattern) inp.setAttribute('pattern', pattern); else inp.removeAttribute('pattern');
    if (maxlength) inp.setAttribute('maxlength', String(maxlength)); else inp.removeAttribute('maxlength');
    let answer = null;
    const done = () => { d.removeEventListener('close', done); resolve(answer); };
    d.addEventListener('close', done);
    $('ask-form').onsubmit = (e) => { e.preventDefault(); if (!inp.checkValidity()) { inp.reportValidity(); return; } answer = inp.value; d.close(); };
    $('ask-cancel').onclick = () => { answer = null; d.close(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ask-form').requestSubmit(); } };
    d.showModal(); inp.focus(); inp.select();
  });
}
/** A busy line: spinner + what is happening. */
const busy = (t) => `<div class="sub"><span class="busy"><span class="spin"></span>${esc(t)}</span></div>`;
/** The fixed pill: whichever flow is working right now, wherever the player is looking. */
function renderWorking() {
  const t = Ai.busy || Wl.busy || Op.busy || '';
  $('working').hidden = !t; $('working-text').textContent = t;
  $('me-chip').classList.toggle('busy-chip', !!Ai.busy);
}
const setName = async () => { const v = await ask({ title: 'profile', label: 'Display name', value: player.name, maxlength: 24, hint: 'shown in the arcade and on ladders' }); if (v && v.trim()) { player.name = v.trim().slice(0, 24); store('cabinet.name', player.name); renderChrome(); render(); } };
$('avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try { player.avatar = await fileToAvatar(f); store('cabinet.avatar', player.avatar); renderChrome(); render(); } catch { /* ignore */ }
  e.target.value = '';
});

// ═══════════════════════════════════════════════ node state ══
const S = { online: false, checked: false, health: null, boards: {}, stats: {}, deltas: {}, peers: [], snapshot: null, uptime: {}, stake: null, seeds: [], seedsAt: 0, viaSeed: null, titles: [], fleet: null, fleetError: null, fleetAt: 0 };
/** No local node → read NodeDirectory and try the seeds. Runs at most once a
 *  minute while a node answers; every 15 s while none does (a seed behind a
 *  quick tunnel re-announces a new hostname within seconds of a restart). */
async function findSeed() {
  if (S.online || localStorage.getItem('cabinet.nodeUrl') || servedByNode() || !seeds.configured() || Date.now() - S.seedsAt < (S.checked && !S.online ? 15_000 : 60_000)) return;
  S.seedsAt = Date.now();
  S.seeds = await seeds.chainSeeds();
  const s = await seeds.reachableSeed(S.seeds);
  if (s) { seedUrl = s.url; S.viaSeed = s; pollNode(); }
}
// Wallet / profile (docs/WALLET-IDENTITY.md): what the chain says about THIS browser's key.
const Wl = { binding: null, account: null, profile: null, busy: '', error: '' };
async function refreshBinding() {
  if (!wallet.configured() || !player?.kp) return;
  try { Wl.binding = await wallet.bindingOf(player.id); } catch { /* chain unreachable; keep what we had */ }
}
let misses = 0, polls = 0;
async function pollNode() {
  $('node-url').textContent = nodeUrl();
  try {
    S.health = await api('/health');
    S.online = true; misses = 0;
    // /deltas carries every settled match (ledgers excluded) — poll it every third tick.
    const wantDeltas = polls++ % 3 === 0;
    for (const g of GAMES) {
      if (!g.rulesetId) continue;
      const rid = encodeURIComponent(g.rulesetId);
      const [lb, st, ds] = await Promise.all([api(`/leaderboard?ruleset=${rid}`).catch(() => ({})), api(`/stats?ruleset=${rid}`).catch(() => ({})), wantDeltas ? api(`/deltas?ruleset=${rid}`).catch(() => null) : null]);
      S.boards[g.rulesetId] = lb.leaderboard ?? [];
      S.stats[g.rulesetId] = st && !st.error ? st : {};
      if (ds) S.deltas[g.rulesetId] = ds.deltas ?? [];
    }
    S.peers = (await api('/peers').catch(() => ({}))).peers ?? [];
    if (polls % 5 === 1) { const { titles } = await api('/titles').catch(() => ({})); S.titles = titles ?? S.titles; if (mergeMeshTitles(S.titles)) render(); }
    S.snapshot = await api('/snapshot').catch(() => S.snapshot);
    // The Node page reads the node's signed telemetry (cabinet/fleet.js): verified against the /health key on every read.
    if (route.name === 'node') {
      try { S.fleet = await readFleet(nodeUrl(), { expectNodeId: S.health?.nodeId ?? null }); S.fleetError = null; S.fleetAt = Date.now(); }
      catch (e) { S.fleetError = e?.message ?? String(e); if (/did not sign|digest/.test(S.fleetError)) S.fleet = null; }
    }
  } catch {
    // One slow answer is not an outage: flip to offline on the second miss.
    if (++misses >= 2) { S.online = false; S.health = null; S.fleet = null; findSeed().catch(() => {}); }
  }
  S.checked = true;
  S.uptime = sample(nodeUrl(), S.online);
  if (S.online && S.health && (polls % 6 === 1 || !S.stake)) readStake(S.health.nodeId).then((st) => { S.stake = st; render(); });
  renderChrome();
  render();
  if (current) sendInit();
}

// ═══════════════════════════════════════════════ derived profile ══
/** AF's real XP rules: win 60 / loss 20 / draw 30; xp_for_next(level) = 80 + level·45; cap 40. */
const xpForNext = (level) => 80 + level * 45;
function levelOf(xp) { let level = 1; while (level < 40 && xp >= xpForNext(level)) { xp -= xpForNext(level); level++; } return { level, xp, next: xpForNext(level) }; }

function myTotals() {
  const t = { matches: 0, wins: 0, ticks: 0 };
  for (const rid of Object.keys(S.stats)) { const s = S.stats[rid]?.[player.id]; if (s) { t.matches += s.matches; t.wins += s.wins; t.ticks += s.ticks; } }
  return t;
}
/** Match history for one ruleset, oldest → newest, with my rating after each.
 *  Walks protocol/derive.js applyDelta over sortDeltas — the node's own fold,
 *  one step at a time — so the chart cannot drift from /leaderboard. */
function history(rid, who = player.id) {
  const svc = S.snapshot?.manifests?.[rid]?.services ?? { leaderboard: { kind: 'elo', k: 24 }, stats: true };
  const tables = { rating: {}, credits: {}, stats: {} };
  const out = [];
  for (const d of sortDeltas(S.deltas[rid] ?? [])) {
    const { teams: [A, B], sa } = applyDelta(tables, d, svc);
    const mine = A.includes(who) ? 'A' : B.includes(who) ? 'B' : null;
    if (!mine) continue;
    const res = sa === 0.5 ? 'draw' : (mine === 'A') === (sa === 1) ? 'win' : 'loss';
    const opp = (mine === 'A' ? B : A).filter((p) => p !== who);
    out.push({ matchId: d.matchId, when: d.settledAt, res, opp, ticks: d.ticks ?? 0, rating: tables.rating[who] ?? 1200, mode: d.mode, cosigned: (d.cosigners?.length ?? 0) > 0, verification: d.verification ?? (d.cosigners?.length ? 'verified' : 'unverified'), official: !!d.official, attestation: d.attestation, chain: d.chain ?? null });
  }
  return out;
}
const myBoardRow = (rid) => (S.boards[rid] ?? []).find((r) => r.player === player.id) ?? null;
const ticksToHours = (t) => t / 60 / 3600;

// ═══════════════════════════════════════════════ chrome ══
function renderChrome() {
  $('me-avatar').src = player.avatar;
  const signedIn = !!Ai.me.session?.address;
  $('me-name').textContent = signedIn ? (Ai.me.session.name || player.name) : air.configured() && player.kp ? `${player.name} · SIGN IN` : player.name;
  $('me-chip').title = signedIn ? `AIR ${Ai.me.email ?? ''} · litVM ${Ai.me.session.address}` : air.configured() ? 'Sign in with AIR' : '';
  const t = myTotals();
  const xp = t.wins * 60 + (t.matches - t.wins) * 20;
  $('me-level').textContent = `LV ${levelOf(xp).level}`;
  $('node-pill').classList.toggle('on', S.online);
  const h = S.health;
  $('node-text').textContent = S.online ? `${S.viaSeed && nodeUrl() === seedUrl ? 'SEED' : 'NODE'} ${h.bonded ? 'BONDED' : h.bonded === false ? 'UNBONDED' : 'ONLINE'} · ${h.peers} PEER${h.peers === 1 ? '' : 'S'}` : S.checked ? 'NODE OFFLINE' : 'CONNECTING…';

  // dashboard is a front onto the node's own data — grey it out while the
  // node can't be reached, with sign-in as the way back in (it needs a node
  // to mint/ask the litVM profile, so a successful sign-in implies it's up).
  const locked = S.checked && !S.online;
  document.body.classList.toggle('dash-locked', locked);
  const lock = $('dash-lock');
  lock.hidden = !locked;
  if (locked) {
    const canSignIn = air.configured() && player.kp && !signedIn;
    lock.innerHTML = `<span class="dash-lock-msg">Node offline${signedIn ? ' — reconnect your node to resume the dashboard' : ' — sign in to activate the dashboard'}</span>${canSignIn ? '<button id="dash-lock-btn" class="btn primary sm">Sign in with AIR</button>' : ''}`;
  }
}


// ═══════════════════════════════════════════════ node work + rewards ══
/** What this node has actually done on the mesh, from the settled deltas. */
function nodeWork() {
  const id = S.health?.nodeId;
  let settled = 0, cosigned = 0, latest = null;
  for (const ds of Object.values(S.deltas)) for (const d of ds) {
    if (d.hostId === id) settled++;
    if (d.cosigners?.includes(id)) cosigned++;
    if (d.hostId === id || d.cosigners?.includes(id)) if (!latest || d.settledAt > latest) latest = d.settledAt;
  }
  return { settled, cosigned, latest };
}
const fmtTok = (n) => (n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** The highlighted band: uptime ring + 24 h strip · mesh work · on chain.
 *  No reward figure: there is no rewards contract, and a number nothing can
 *  pay is a claim (BUILD-SPEC honest zeroes). Work counters are real — they
 *  are counted from settled deltas any node can reproduce. */
function nodePanel({ compact = true } = {}) {
  const h = S.health;
  const u24 = uptimePct(S.uptime, 24 * 6), u7 = uptimePct(S.uptime, 7 * 24 * 6);
  const rw = nodeWork();
  const fresh = S.peers.filter((p) => p.fresh).length;
  const bonded = S.stake?.bonded ?? h?.bonded ?? null;
  const uptimeCol = `
    <div class="up-ring">${ring(u24.pct, { color: S.online ? '#7ef0a8' : '#ff7b8a', label: '24H UPTIME', sub: u24.observedSlots ? `${u24.observedSlots} × 10 min seen` : 'unobserved' })}</div>
    <div class="up-meta">
      <div class="kv2"><span class="k">Process up</span><span class="v">${S.online ? fmtDuration(h.uptimeMs) : '—'}</span></div>
      <div class="kv2"><span class="k">Since</span><span class="v">${S.online && h.startedAt ? new Date(h.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span></div>
      <div class="kv2"><span class="k">7 d observed</span><span class="v">${u7.pct == null ? '—' : `${u7.pct.toFixed(1)}%`}</span></div>
      <div class="kv2"><span class="k">Mesh</span><span class="v">${S.online ? `${fresh}/${S.peers.length} fresh` : '—'}</span></div>
    </div>
    ${strip(slots(S.uptime, 24 * 6))}
    <div class="legend"><i class="up"></i>up <i class="partial"></i>partial <i class="down"></i>down <i class="none"></i>dashboard closed</div>`;
  const sent = S.fleet?.chain?.matchBook?.sent ?? null;
  const count = (what) => (sent ? sent.filter((x) => x.what === what && x.ok !== false).length : null);
  const workCol = sent ? `
    <div class="work">
      <div class="stat"><div class="k">Commits (host)</div><div class="v">${count('commit')}</div></div>
      <div class="stat"><div class="k">Attests (witness)</div><div class="v">${count('attest')}</div></div>
      <div class="stat"><div class="k">Settles · finals</div><div class="v">${count('settle')}<small>· ${count('finalize')}</small></div></div>
      <div class="stat"><div class="k">Backstop · anchors</div><div class="v">${count('expire') + count('escalate') + count('resolve')}<small>· ${count('propose')}</small></div></div>
    </div>
    <div class="source">Transactions this node's hot key sent since it started (${sent.length} in the ledger below) · epoch ${h.epoch}</div>` : `
    <div class="work">
      <div class="stat"><div class="k">Settled as host</div><div class="v">${rw.settled}</div></div>
      <div class="stat"><div class="k">Witnessed</div><div class="v">${rw.cosigned}</div></div>
      <div class="stat"><div class="k">Bond</div><div class="v">${bonded === null ? '—' : bonded ? 'Active' : 'None'}</div></div>
      <div class="stat"><div class="k">Roles</div><div class="v small">${S.online ? esc(h.roles.join(' · ')) : '—'}</div></div>
    </div>
    <div class="source">${S.online ? `Last mesh work ${rw.latest ? new Date(rw.latest).toLocaleString() : 'none yet'} · epoch ${h.epoch}` : 'Start the node to count work.'}</div>`;
  const rewardCol = `
    <div class="reward">
      <div class="k">On chain · ${esc(CHAIN.name)}</div>
      <div class="big-tok"><span class="chrome">${S.stake?.amount != null ? fmtTok(S.stake.amount) : '—'}</span><span class="tok">${CHAIN.token} bonded</span></div>
      <div class="breakdown">
        <div><span>Hours observed up</span><span>${fmtTok(hoursOnline(S.uptime, 7 * 24 * 6))} h</span><span class="dim">7 d</span></div>
        <div><span>Settled as host</span><span>${rw.settled}</span><span class="dim">deltas</span></div>
        <div><span>Witnessed</span><span>${rw.cosigned}</span><span class="dim">co-signs</span></div>
      </div>
      <div class="onchain">
        <div class="kv2"><span class="k">Bonded</span><span class="v">${S.stake?.amount != null ? `${fmtTok(S.stake.amount)} ${CHAIN.token}` : '—'}</span></div>
        <div class="kv2"><span class="k">Wallet</span><span class="v">${S.stake?.balance != null ? `${fmtTok(S.stake.balance)} ${CHAIN.token}` : '—'}</span></div>
        <div class="kv2"><span class="k">Operator</span><span class="v mono" title="${esc(S.stake?.operator ?? '')}">${S.stake?.bonded && S.stake.operator ? `${S.stake.operator.slice(0, 6)}…${S.stake.operator.slice(-4)}` : '—'}</span></div>
      </div>
      <span class="tag projected">no rewards contract yet — nothing accrues; the bond is a cost of misbehaviour, not a yield. Gas for every commit, settle and attest comes from the hot key below.</span>
    </div>`;
  return `<section class="panel hi s12"><div class="panel-h"><h3>Node uptime · mesh work</h3><span class="tag ${S.online ? 'live' : ''}">${S.online ? 'node online' : S.checked ? 'node offline' : 'connecting'}</span>${compact ? moreLink('#/node', 'node') : ''}</div>
    <div class="panel-b hi-grid"><div>${uptimeCol}</div><div>${workCol}</div><div>${rewardCol}</div></div></section>`;
}

// ═══════════════════════════════════════════════ pieces ══
const panel = (title, body, more = '', cls = '') => `<section class="panel ${cls}"><div class="panel-h"><h3>${title}</h3>${more}</div><div class="panel-b">${body}</div></section>`;
const moreLink = (href, label = 'view all') => `<a class="more" href="${href}">${label} ›</a>`;
const gameTag = () => '<span class="tag live">Live</span>';
/** What backs a result, in one word: verified (players signed + independent witness agreed), disputed, or unverified — and whether it counts. */
const verifyTag = (d) => d.chain === 'final' ? '<span class="tag live" title="finalized on chain: committed before play, settled by the host, attested by three witnesses; counts toward the official ladder">final on chain</span>' : d.chain === 'void' ? '<span class="tag court" title="voided on chain: the witnesses disagreed, or the host never settled">voided</span>' : d.chain && d.chain !== 'none' ? `<span class="tag" title="on chain, ${esc(d.chain)}: attestations still arriving">on chain · ${esc(d.chain)}</span>` : d.verification === 'verified' ? `<span class="tag live" title="players signed, an independent witness reached the same result${d.official ? '; counts toward the official ladder' : ''}">verified${d.official ? '' : ' · unofficial'}</span>` : d.verification === 'disputed' ? '<span class="tag court" title="a witness recomputed a different result">disputed</span>' : `<span class="tag" title="${esc(d.attestation ?? '')}: not independently verified; not on the official ladder">unverified</span>`;
const statusTag = (g) => g.status === 'attested' ? '<span class="tag court">Court</span>' : g.status === 'external' ? '<span class="tag hosted">Hosted</span>' : g.status === 'mesh' ? '<span class="tag hosted">Mesh</span>' : '';
const tagRow = (g) => `<div class="chips">${(g.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${statusTag(g)}</div>`;
/** Rank badge: the number inside bracket ticks. */
const rankBadge = (n, color) => {
  const ticks = [];
  for (const side of [-1, 1]) for (let i = -2; i <= 2; i++) {
    const a = Math.PI / 2 + side * (Math.PI / 2 + i * 0.28);
    const p = (r) => `${(27 + Math.cos(a) * r).toFixed(1)},${(27 + Math.sin(a) * r).toFixed(1)}`;
    ticks.push(`<line x1="${p(20).split(',')[0]}" y1="${p(20).split(',')[1]}" x2="${p(25).split(',')[0]}" y2="${p(25).split(',')[1]}"/>`);
  }
  return `<svg class="badge" viewBox="0 0 54 54"><g stroke="${color}" stroke-width="1.6">${ticks.join('')}</g><text x="27" y="33" text-anchor="middle" fill="${color}" font-family="IBM Plex Mono, monospace" font-size="20" font-weight="600">${n}</text></svg>`;
};
const TIERS = [[40, 'Pantheon'], [30, 'Titan'], [20, 'Olympian'], [10, 'Contender'], [1, 'Initiate']];
const tierOf = (level) => TIERS.find(([min]) => level >= min)[1];
const styleTag = (s) => `<span class="style" style="--sc:${STYLES[s]?.color ?? '#999'}">${esc(STYLES[s]?.label ?? s)}</span>`;
// The hosted page is a front door: this browser talks to the mesh through a
// node on THIS machine (https → http://localhost is allowed). No node → say
// how to get one; the signed release is the download.
const RELEASES = 'https://github.com/strodanodev/litnode/releases/latest';
const nodeHint = () => (S.online ? '' : !S.checked ? '<div class="empty">Connecting to the node…</div>' : `<div class="empty">No node on this machine. The arcade reads the mesh through your own node — <a class="link" href="${RELEASES}" target="_blank" rel="noopener">get litnode</a> (Windows, nothing to install), run <span class="mono">start-node.cmd</span>, reload. <a class="link" href="#/node">Details ›</a></div>`);

// Universal login (docs/UNIVERSAL-LOGIN.md): AIR signs the player in, the
// node gives the account a litVM proxy wallet + profile and binds this key.
const Ai = { busy: '', error: '', me: air.current() };
function airLine() {
  if (!air.configured() || !player.kp) return '';
  if (Ai.busy) return busy(Ai.busy);
  const s = Ai.me.session;
  if (Ai.me.loggedIn && s?.address) {
    const who = Ai.me.email ?? s.name ?? Ai.me.id?.slice(0, 8) ?? 'AIR';
    return `<div class="sub">AIR <b>${esc(who)}</b> · profile <b>${esc(s.name ?? `#${s.tokenId}`)}</b> · litVM <span class="mono" title="${esc(s.address)}">${s.address.slice(0, 6)}…${s.address.slice(-4)}</span>${s.custody === 'elsewhere' ? ' <span class="dim">(held by another node)</span>' : ''} <button class="link" id="air-out">sign out</button>${Ai.error ? `<div class="dim">${esc(Ai.error)}</div>` : ''}</div>`;
  }
  if (Ai.me.loggedIn) return `<div class="sub">AIR <b>${esc(Ai.me.email ?? Ai.me.id?.slice(0, 8) ?? '')}</b> · <button class="btn sm" id="air-link">Get my litVM profile</button> <button class="link" id="air-out">sign out</button>${Ai.error ? `<div class="dim">${esc(Ai.error)}</div>` : ''}</div>`;
  return `<div class="sub"><button class="btn sm" id="air-btn">Sign in with AIR</button> <span class="dim">Google, email or a wallet · a litVM profile is made for you</span>${Ai.error ? `<div class="dim">${esc(Ai.error)}</div>` : ''}</div>`;
}
/** AIR dialog → node session (proxy wallet + profile + this key bound). */
async function signInWithAir() {
  Ai.error = '';
  try {
    Ai.busy = 'opening AIR…'; render();
    if (!Ai.me.loggedIn) await air.login();
    Ai.me = air.current();
    if (!S.online) throw new Error('no node to ask — the profile is minted by your node (or the seed)');
    Ai.busy = 'your node is setting up your litVM profile (first time: three transactions)…'; render();
    Ai.me.session = await air.nodeSession(nodeUrl(), { playerKey: player.id, name: player.name.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 32) || null });
    if (Ai.me.session.name && !load('cabinet.name')) { player.name = Ai.me.session.name; renderChrome(); }
    await refreshBinding();
  } catch (e) { Ai.error = e?.message ?? String(e); }
  Ai.busy = ''; render();
}
async function signOutAir() { Ai.busy = 'signing out…'; render(); await air.logout(); Ai.me = air.current(); Ai.busy = ''; render(); }

/** The wallet row under the key: bound → who owns it; unbound → sign in. */
function walletLine() {
  if (!wallet.configured()) return airLine();
  if (!player.kp) return '<div class="sub dim">No key on this page (insecure context), so nothing to bind.</div>';
  const b = Wl.binding;
  if (Wl.busy) return busy(Wl.busy);
  if (b?.active && !(Ai.me.session?.address && b.owner === Ai.me.session.address)) return airLine() + `<div class="sub">profile <b>${esc(Wl.profile?.name ?? `#${b.tokenId}`)}</b> · wallet <span class="mono" title="${esc(b.owner)}">${b.owner.slice(0, 6)}…${b.owner.slice(-4)}</span></div>`;
  if (b?.active) return airLine();
  if (b && !b.active) return '<div class="sub" style="color:var(--bad,#ff7b8a)">this key was revoked by its profile owner — nodes refuse it</div>';
  const own = !wallet.hasWallet() ? '<div class="sub dim">Install a wallet (MetaMask) on litVM to bind this key yourself.</div>'
    : `<div class="sub"><button class="btn sm" id="wallet-btn">Bind with my own wallet</button> <span class="dim">one transaction: a soulbound profile owns this key</span>${Wl.error ? `<div class="dim">${esc(Wl.error)}</div>` : ''}</div>`;
  return airLine() + `<details class="sub"><summary class="dim">advanced · your own wallet</summary>${own}</details>`;
}
/** Connect, then register (no profile yet) or bindKey (profile exists, new device). */
async function signInWithWallet() {
  Wl.error = '';
  try {
    Wl.busy = 'connecting wallet…'; render();
    Wl.account = await wallet.connect();
    Wl.profile = await wallet.profileOf(Wl.account);
    if (Wl.profile) {
      Wl.busy = `adding this device to ${Wl.profile.name} — confirm in your wallet`; render();
      await wallet.bindKey(Wl.account, player.id);
    } else {
      Wl.busy = ''; render();
      const name = await ask({ title: 'mint profile', label: 'Profile name', value: player.name.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 32) || 'player', pattern: '[A-Za-z0-9 _.\\-]{1,32}', maxlength: 32, hint: '1–32 letters, digits, space _ . -  ·  soulbound on litVM', ok: 'Mint' });
      if (!name || !name.trim()) { render(); return; }
      Wl.busy = 'minting your profile — confirm in your wallet'; render();
      await wallet.register(Wl.account, player.id, name.trim());
    }
    Wl.busy = 'waiting for the chain…'; render();
    Wl.binding = await wallet.waitForBinding(player.id);
    Wl.profile = Wl.binding ? await wallet.profileOf(Wl.binding.owner) : Wl.profile;
    if (!Wl.binding) Wl.error = 'the transaction did not land in 60 s — check the explorer, then reload';
  } catch (e) { Wl.error = e?.message ?? String(e); }
  Wl.busy = ''; render();
}
function profilePanel() {
  const t = myTotals();
  const xpRaw = t.wins * 60 + (t.matches - t.wins) * 20;
  const L = levelOf(xpRaw);
  const row = PRIMARY.rulesetId ? myBoardRow(PRIMARY.rulesetId) : null;
  const rank = row ? `#${row.rank}` : '—';
  const rating = row ? row.rating : 1200;
  return panel('Profile', `
    <div class="who">
      <div class="avatar-wrap"><img src="${player.avatar}" alt="" /><button id="avatar-btn" title="change photo">✎</button></div>
      <div style="min-width:0">
        <h2>${esc(player.name)} <button class="link" id="name-btn" title="rename">✎</button></h2>
        <div class="sub">Level ${L.level} · ${tierOf(L.level)}</div>
        <span class="token" title="${esc(player.id)}">${player.guest ? 'guest' : 'ed25519'}:${player.id.slice(0, 8)}…${player.id.slice(-4)}</span>
        ${walletLine()}
      </div>
    </div>
    <div class="xp"><div class="row"><span>LEVEL ${L.level}</span><span>${L.xp} / ${L.next} XP</span></div><div class="bar"><i style="width:${pct(L.xp, L.next)}%"></i></div></div>
    <div class="stats4">
      <div class="stat"><div class="k">Global rank</div><div class="v">${rank}</div></div>
      <div class="stat"><div class="k">Win rate</div><div class="v">${pct(t.wins, t.matches)}<small>%</small></div></div>
      <div class="stat"><div class="k">Matches</div><div class="v">${t.matches}</div></div>
      <div class="stat"><div class="k">Playtime</div><div class="v">${ticksToHours(t.ticks).toFixed(1)}<small>hrs</small></div></div>
    </div>
    <div class="two">
      <div class="big"><div class="icon">◆</div><div><div class="k">Skill rating</div><div class="v">${rating}<small> ${row ? 'SR' : 'unrated'}</small></div></div></div>
      <div class="big"><div class="icon">🎟</div><div><div class="k">Tickets</div><div class="v">${INVENTORY_SAMPLE.tickets}<small> sample</small></div></div></div>
    </div>
    <div class="source">${S.online ? `Derived from ${t.matches} settled match${t.matches === 1 ? '' : 'es'} on the mesh. Account XP, tickets and loadout sync with Agent Fighter.` : 'Start a node to load your mesh record.'}</div>
  `, '', 'profile s4');
}

function chartSvg(series) {
  const W = 600, H = 190, padL = 36, padR = 10, padT = 12, padB = 22;
  if (!series.length) {
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">${[0, 1, 2, 3].map((i) => `<line x1="${padL}" x2="${W - padR}" y1="${padT + i * (H - padT - padB) / 3}" y2="${padT + i * (H - padT - padB) / 3}"/>`).join('')}</g><text class="axis" x="4" y="${H / 2}">1200</text></svg><div class="chart-empty">No settled matches yet — your rating curve starts with your first one.</div>`;
  }
  const rs = series.map((s) => s.rating);
  const lo = Math.min(1200, ...rs) - 20, hi = Math.max(1200, ...rs) + 20;
  const x = (i) => padL + (series.length === 1 ? (W - padL - padR) / 2 : (i / (series.length - 1)) * (W - padL - padR));
  const y = (r) => padT + (1 - (r - lo) / (hi - lo)) * (H - padT - padB);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.rating).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(series.length - 1).toFixed(1)},${H - padB} L${x(0).toFixed(1)},${H - padB} Z`;
  const bars = series.map((s, i) => `<rect class="${s.res}" x="${(x(i) - 3).toFixed(1)}" y="${H - padB + 4}" width="6" height="6" rx="1"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#33c6ff" stop-opacity=".35"/><stop offset="1" stop-color="#33c6ff" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${[0, 1, 2, 3].map((i) => `<line x1="${padL}" x2="${W - padR}" y1="${padT + i * (H - padT - padB) / 3}" y2="${padT + i * (H - padT - padB) / 3}"/>`).join('')}</g>
    <text class="axis" x="4" y="${padT + 4}">${hi}</text><text class="axis" x="4" y="${H - padB}">${lo}</text>
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    ${series.map((s, i) => `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(s.rating).toFixed(1)}" r="3"><title>${s.res} · ${s.rating} SR</title></circle>`).join('')}
    ${bars}
  </svg>`;
}

function statsPanel() {
  const rid = PRIMARY.rulesetId;
  const hist = rid ? history(rid) : [];
  let streak = 0; for (let i = hist.length - 1; i >= 0 && hist[i].res === 'win'; i--) streak++;
  const best = hist.length ? Math.max(1200, ...hist.map((h) => h.rating)) : 1200;
  const avgLen = hist.length ? hist.reduce((s, h) => s + h.ticks, 0) / hist.length / 60 : 0;
  return panel('Stats overview', `
    <div class="chips" style="margin-bottom:10px"><span class="chip active">${esc(PRIMARY.title)}</span><span class="chip" style="cursor:default">rating · last ${Math.min(hist.length, 30)}</span></div>
    <div class="chart-wrap">${chartSvg(hist.slice(-30))}</div>
    <div class="kpis">
      <div class="kpi"><div class="k">Avg match</div><div class="v">${avgLen ? `${Math.floor(avgLen / 60)}:${String(Math.round(avgLen % 60)).padStart(2, '0')}` : '—'}</div></div>
      <div class="kpi"><div class="k">Best rating</div><div class="v">${best}</div></div>
      <div class="kpi"><div class="k">Win streak</div><div class="v">${streak}</div></div>
    </div>${nodeHint()}`, '', 's5');
}

function gamesPanel() {
  const rows = GAMES.map((g, i) => `
    <a class="grow" href="#/game/${g.id}" style="--ga:${g.accent}">
      <div class="ico" style="${g.cover ? `background-image:url('${esc(g.cover)}')` : ''}">${g.cover ? '' : `0${i + 1}`}</div>
      <div style="min-width:0"><div class="t">${esc(g.title)}<sup>™</sup></div><div class="s">${esc(g.players)} · ${esc(g.modes.join(' / '))}</div></div>
      <div class="right">${gameTag(g)}${g.playable ? `<button class="btn sm primary" data-play="${g.id}">Play</button>` : ''}</div>
    </a>`).join('');
  return panel('Game library', `<div class="glist">${rows}</div>`, moreLink('#/games', 'all games'), 's3');
}

function boardTable(rid, limit, q = '') {
  const rows = S.boards[rid] ?? [];
  const st = S.stats[rid] ?? {};
  const list = (q ? rows.filter((r) => r.player.includes(q)) : rows).slice(0, limit);
  const me = myBoardRow(rid);
  const tr = (r) => { const s = st[r.player] ?? {}; return `<tr class="${r.player === player.id ? 'me' : ''}"><td class="rank ${r.rank <= 3 ? 'top' : ''}">#${r.rank}</td><td><div class="pl"><img src="${r.player === player.id ? player.avatar : identicon(r.player, 40)}" alt=""/>${r.player === player.id ? esc(player.name) : short(r.player, 12)}</div></td><td class="num">${r.rating}</td><td class="num">${s.matches ?? 0}</td><td class="num">${s.wins ?? 0}</td><td class="num">${pct(s.wins ?? 0, s.matches ?? 0)}%</td></tr>`; };
  if (!S.online) return nodeHint();
  if (!rows.length) return '<div class="empty">No verified ranked matches on this title yet. The official ladder counts placed, player-signed, witness-verified results only; every settled match still shows in your record, labelled.</div>';
  const extra = me && !list.some((r) => r.player === player.id) ? `<tr><td colspan="6" class="dim" style="text-align:center">…</td></tr>${tr(me)}` : '';
  return `<table><thead><tr><th>Rank</th><th>Player</th><th class="num">Rating</th><th class="num">Matches</th><th class="num">Wins</th><th class="num">Win %</th></tr></thead><tbody>${list.map(tr).join('')}${extra}</tbody></table>`;
}
let lbTab = PRIMARY.rulesetId;
const lbTabs = () => `<div class="tabs">${GAMES.filter((g) => g.rulesetId).map((g) => `<button class="${g.rulesetId === lbTab ? 'active' : ''}" data-lb="${g.rulesetId}">${esc(g.title)}</button>`).join('')}</div>`;
const leaderboardPanel = () => panel('Leaderboards', `${lbTabs()}<div style="margin-top:8px">${boardTable(lbTab, 8)}</div>`, moreLink('#/leaderboards'), 's5');

const charCard = (c, { big = false } = {}) => {
  const owned = INVENTORY_SAMPLE.unlocked.includes(c.id);
  return `<a class="ch ${c.id === INVENTORY_SAMPLE.main ? 'main' : ''} ${owned ? '' : 'locked'}" href="#/characters" title="${esc(c.name)} · ${esc(STYLES[c.style]?.label ?? c.style)}" style="--sc:${STYLES[c.style]?.color ?? '#999'}">
    <span class="st">${esc(STYLES[c.style]?.label ?? c.style)}</span>${owned ? '' : '<span class="lock">🔒</span>'}
    <img src="${portraitUrl(c.id)}" alt="" loading="lazy" />
    <div class="n">${esc(c.name)}</div>${big ? `<div class="hp">HP ${c.hp.toLocaleString()}${c.id === INVENTORY_SAMPLE.main ? ' · main' : ''}</div>` : ''}
  </a>`;
};
function charactersPanel() {
  const mine = CHARACTERS.filter((c) => INVENTORY_SAMPLE.unlocked.includes(c.id)).slice(0, 6);
  return panel('Characters', `<div class="cgrid">${mine.map((c) => charCard(c)).join('')}</div><div class="source">${mine.length} of ${CHARACTERS.length} fighters unlocked · <span class="tag sample">sample</span></div>`, moreLink('#/characters', 'roster'), 's4');
}

const itemCard = (it, qty) => { const L = ITEM_LINES[it.line]; return `<div class="item ${qty ? 'owned' : 'none'}" style="--ic:${L.color}"><div class="ico">T${it.tier}</div><div><div class="n">${esc(it.name)}</div><div class="s">${esc(L.label)} · ${esc(L.effect)}</div></div><div class="q">${qty ? `×${qty}` : ''}</div></div>`; };
const petCard = (p) => { const def = PETS.find((x) => x.id === p.id); const R = RARITY[p.rarity]; return `<div class="pet ${p.id === INVENTORY_SAMPLE.equippedPet ? 'eq' : ''}" style="--rc:${R.color}"><div class="g">${def.glyph}</div><div><div class="n">${esc(def.name)}${p.id === INVENTORY_SAMPLE.equippedPet ? ' · equipped' : ''}</div><div class="r">${R.label}</div><div class="aura">ATK +${p.aura.atk} · DEF +${p.aura.def} · CRIT +${p.aura.crit}</div></div></div>`; };
function inventoryPanel() {
  const items = INVENTORY_SAMPLE.items.map((o) => itemCard(ITEMS.find((i) => i.id === o.id), o.qty)).join('');
  const pet = INVENTORY_SAMPLE.pets.find((p) => p.id === INVENTORY_SAMPLE.equippedPet);
  return panel('Inventory', `<div class="igrid" style="grid-template-columns:1fr">${items}</div><div class="section-h"><h4>Pet</h4></div>${pet ? petCard(pet) : '<div class="empty">No pet equipped.</div>'}<div class="source"><span class="tag sample">sample</span> loadout until account sync</div>`, moreLink('#/inventory'), 's3');
}

// ═══════════════════════════════════════════════ views ══
function renderHome() {
  view('home').innerHTML = nodePanel() + profilePanel() + statsPanel() + gamesPanel() + leaderboardPanel() + charactersPanel() + inventoryPanel();
}
const coverArt = (g) => g.cover
  ? `<img class="bgimg" src="${esc(g.cover)}" alt="${esc(g.title)} title screen" />${g.logo ? `<img class="logo" src="${esc(g.logo)}" alt="" />` : ''}`
  : `<div class="mark"><span class="chrome">${esc(g.title.split(' ').map((w) => w[0]).join(''))}</span></div>`;
function renderGames() {
  view('games').innerHTML = `<div class="page-h"><h1 class="chrome">Arcade</h1><span class="dim">${GAMES.length} titles · settled on litVM</span></div><div class="cards">${GAMES.map((g, i) => `
    <article class="card" style="--ga:${g.accent}">
      <a class="cover" href="#/game/${g.id}">${coverArt(g)}<span class="tag live live">Live</span><span class="no">0${i + 1}</span></a>
      <div class="body">
        <div class="ttl"><h2>${esc(g.title)}<sup>™</sup></h2><a class="sel" href="#/game/${g.id}">Select ›</a></div>
        <div class="tagline">${esc(g.tagline)}</div>
        ${tagRow(g)}
        <ul class="mini">${!g.rulesetId ? '<li class="dim">not on the mesh yet</li>' : S.online ? ((S.boards[g.rulesetId] ?? []).slice(0, 3).map((r) => `<li><span>${r.rank}. ${short(r.player, 12)}</span><span>${r.rating}</span></li>`).join('') || '<li class="dim">no settled matches yet</li>') : `<li class="dim">${S.checked ? 'node offline' : 'connecting…'}</li>`}</ul>
        <div class="row">${g.playable ? `<button class="btn primary" data-play="${g.id}">Play now</button>` : '<button class="btn" disabled>Off-cabinet</button>'}<a class="btn" href="#/game/${g.id}">Details</a></div>
      </div>
    </article>`).join('')}</div>`;
}
let viewing = null;
function renderGame(g) {
  viewing = g;
  const hist = g.rulesetId ? history(g.rulesetId).slice(-8).reverse() : [];
  const me = g.rulesetId ? myBoardRow(g.rulesetId) : null;
  view('game').style.setProperty('--ga', g.accent);
  view('game').innerHTML = `
    <div class="page-h"><a class="dim" href="#/games">‹ all games</a></div>
    <section class="hero ${g.cover ? 'has-cover' : ''}" style="${g.cover ? `--cover:url('${esc(g.cover)}')` : ''}">
      <div><h1 class="chrome">${esc(g.title)}</h1><div class="tagline">${esc(g.tagline)}</div><div class="chips">${gameTag(g)}<span class="tag">${esc(g.players)}</span>${(g.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${statusTag(g)}</div></div>
      <div class="hero-actions">${g.rulesetId ? `<button class="btn primary" data-queue="${g.id}" ${S.online && player.kp ? '' : 'disabled'}>Find match</button>` : ''}${g.playable ? `<button class="btn ${g.rulesetId ? '' : 'primary'}" data-play="${g.id}">Play now</button>` : '<button class="btn" disabled>Played off-cabinet</button>'}${g.url ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">↗ open in tab</a>` : ''}</div>
    </section>
    ${g.rulesetId ? '<div id="mm"></div>' : ''}
    <div class="cols">
      <div class="col">
        ${panel('About', `<p>${esc(g.description)}</p>`)}
        <div style="height:16px"></div>
        ${panel('Controls & modes', `<ul class="list">${g.controls.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><div class="section-h"><h4>Modes</h4></div><div class="chips">${g.modes.map((m) => `<span class="chip" style="cursor:default">${esc(m)}</span>`).join('')}</div>`)}
        <div style="height:16px"></div>
        ${panel('On the mesh', `<dl class="mesh"><div><dt>ruleset</dt><dd>${esc(g.rulesetId ?? '—')}</dd></div><div><dt>build</dt><dd title="${esc(g.buildHash ?? '')}">${g.buildHash ? short(g.buildHash, 20) : '—'}</dd></div><div><dt>settled by</dt><dd>${!g.rulesetId ? 'not on the mesh yet' : g.id === 'pickle-brawl' ? 'attestor signature + rules check' : 'replay of the signed input ledger'}</dd></div><div><dt>settled</dt><dd>${S.online && g.rulesetId ? `${(S.deltas[g.rulesetId] ?? []).length} matches` : '—'}</dd></div></dl>`)}
      </div>
      <div class="col">
        ${panel('Leaderboard', g.rulesetId ? boardTable(g.rulesetId, 10) : '<div class="empty">This title is not on the mesh yet — its ruleset lands with the node sync.</div>', g.rulesetId ? moreLink('#/leaderboards') : '')}
        <div style="height:16px"></div>
        ${panel('Your record', me || hist.length ? `<div class="stats4" style="margin:0 0 12px"><div class="stat"><div class="k">Rank</div><div class="v">${me ? `#${me.rank}` : '—'}</div></div><div class="stat"><div class="k">Rating</div><div class="v">${me?.rating ?? 1200}</div></div><div class="stat"><div class="k">Matches</div><div class="v">${S.stats[g.rulesetId]?.[player.id]?.matches ?? 0}</div></div><div class="stat"><div class="k">Wins</div><div class="v">${S.stats[g.rulesetId]?.[player.id]?.wins ?? 0}</div></div></div>
          <table><thead><tr><th>Result</th><th>Opponent</th><th class="num">Length</th><th class="num">Rating</th><th>When</th></tr></thead><tbody>${hist.map((h) => `<tr><td class="res ${h.res[0]}">${h.res.toUpperCase()}</td><td>${h.opp.map((o) => short(o, 10)).join(', ') || '—'}</td><td class="num">${Math.floor(h.ticks / 3600)}:${String(Math.floor((h.ticks / 60) % 60)).padStart(2, '0')}</td><td class="num">${h.rating}</td><td class="dim">${h.when ? new Date(h.when).toLocaleDateString() : '—'} ${verifyTag(h)} <a class="link rcpt-link" href="#/match/${esc(h.matchId)}" title="the match's transactions on the Liteforge explorer">receipt ›</a></td></tr>`).join('') || '<tr><td colspan="5" class="dim">No matches yet.</td></tr>'}</tbody></table>` : `<div class="empty">${S.online ? 'No settled matches under your key yet. Play one — it shows up here once the mesh settles it.' : 'Start a node to load your record.'}</div>`)}
      </div>
    </div>`;
  if (g.rulesetId) renderMatchmaking(g);
}

// ═══════════════════════════════════════════════ matchmaking ══
// The point of the design (client.js): sign a queue entry, wait for the pair,
// recompute placement from a snapshot this page can hash, and refuse a host
// the rule did not produce. The node is a directory, never an authority.
const MM = { state: 'idle', game: null, text: '', match: null, check: null, host: null, relay: null, waitedMs: 0 };
let mmAbort = null;
function renderMatchmaking(g) {
  const el = $('mm'); if (!el) return;
  if (MM.game && MM.game.id !== g.id && MM.state !== 'idle') { el.innerHTML = ''; return; }
  if (MM.state === 'idle') { el.innerHTML = player.kp ? '' : panel('Find match', '<div class="empty">This page has no WebCrypto (plain http from a network address), so it holds no player key and cannot queue. Open it as http://localhost:&lt;port&gt;/ on the node&#39;s machine, or over https.</div>'); return; }
  const m = MM.match, c = MM.check;
  const body = MM.state === 'queued' ? `<div class="empty">${esc(MM.text)}</div><div class="hero-actions"><button class="btn" data-mm-stop>Stop</button></div>`
    : `<dl class="mesh">
        <div><dt>match</dt><dd class="mono" title="${esc(m.matchId)}">${short(m.matchId, 16)}</dd></div>
        <div><dt>opponent</dt><dd class="mono">${short(m.participants.find((p) => p !== player.id) ?? '', 16)}</dd></div>
        <div><dt>beacon</dt><dd>${esc(m.beaconSource ?? '?')}${c.beacon ? c.beacon.ok === true ? ' · <span class="res w">block checked</span>' : c.beacon.ok === false ? ` · <span class="res l">${esc(c.beacon.reason)}</span>` : ` · <span class="dim">${esc(c.beacon.reason ?? 'unchecked')}</span>` : ''}</dd></div>
        <div><dt>membership</dt><dd>${c.snapshotVerified ? '<span class="res w">signatures re-verified here</span>' : '<span class="dim">as the node reported it</span>'}${m.protocol ? ` · protocol ${m.protocol}` : ''}</dd></div>
        <div><dt>host (node says)</dt><dd class="mono">${short(m.host ?? '', 16)}</dd></div>
        <div><dt>host (you computed)</dt><dd class="mono">${short(c.host ?? '', 16)}</dd></div>
        <div><dt>witness</dt><dd class="mono">${c.witness ? short(c.witness, 16) : 'none (single operator)'}</dd></div>
        <div><dt>verdict</dt><dd>${c.ok ? `<span class="res w">ACCEPT</span> — the host is the one the rule produces${m.disputes?.length ? ` (${m.disputes.length} node(s) disputed)` : ''}` : `<span class="res l">REFUSE</span> — ${esc(c.reason)}`}</dd></div>
      </dl>
      <div class="hero-actions">${c.ok ? (MM.host ? `<button class="btn primary" data-mm-launch>Launch on this host</button>${MM.host.wsAddr ? '' : MM.relay ? `<span class="dim">host ${short(m.host ?? '', 12)} advertises no relay: launching on ${esc(MM.relay)}</span>` : `<span class="dim">host ${short(m.host ?? '', 12)} advertises no relay (wsAddr) and no bonded peer does: the title brings its own transport</span>`}` : `<span class="dim">host ${short(m.host ?? '', 12)} is not in the snapshot — placed, not launchable from here</span>`) : '<span class="dim">not launching against a host the rule did not produce</span>'}<button class="btn" data-mm-reset>Clear</button></div>
      <div class="source">paired after ${(MM.waitedMs / 1000).toFixed(1)} s · snapshot root ${short(m.snapshotRoot ?? '', 12)}${c.sameSnapshot === false ? ' · eligible set moved since the draw' : ''}</div>`;
  el.innerHTML = panel('Find match', body, '', 'mm');
}
/** Matchmaking is a function of everyone's clock (2 s buckets). A node whose
 *  clock disagrees with its bonded peers computes buckets nobody else has
 *  and waits forever — seen live (a laptop 23 min behind). Refuse loudly. */
function clockProblem() {
  const bonded = S.peers.filter((p) => p.bonded && p.nodeId !== S.health?.nodeId);
  const off = bonded.filter((p) => Math.abs(p.clockSkewS) > 4);
  if (bonded.length && off.length === bonded.length) return `this node's clock is about ${Math.round(Math.abs(off[0].clockSkewS))} s ${off[0].clockSkewS > 0 ? 'behind' : 'ahead of'} the mesh — matchmaking cannot pair across clocks. Sync it (Windows: Settings › Time › Sync now, or an admin prompt: w32tm /resync), then try again.`;
  if (!S.peers.some((p) => p.nodeId !== S.health?.nodeId)) return 'this node has not heard from any other node — it is alone on the mesh, so there is nobody to pair with. Check SEEDS in node.env and that the seed is reachable.';
  return null;
}
async function findMatch(g) {
  if (!player.kp || !S.online || MM.state === 'queued') return;
  // Identity is asked for at the moment it matters — a ranked queue — never
  // at the door. One dialog, then the queue; a closed dialog queues as a guest.
  if (air.configured() && !Ai.me.session?.address && !Ai.busy) { await signInWithAir(); if (MM.state === 'queued') return; }
  const problem = clockProblem();
  if (problem) { alert(problem); return; }
  const client = createClient({ nodeUrl: nodeUrl(), player: player.kp, rpc: seeds.configured() ? seeds.rpc : null });
  Object.assign(MM, { state: 'queued', game: g, text: 'signing a queue entry…', match: null, check: null, host: null });
  render();
  mmAbort = new AbortController();
  try {
    const region = S.health?.region ?? null; // queue with the region of the node we talk to: the draw prefers hosts near us
    const entry = { rulesetId: g.rulesetId, mode: 'ranked', region };
    const { bucket } = await client.queue(entry);
    const t0 = Date.now();
    MM.text = `queued for ${g.rulesetId} (ranked). Re-entering every 2 s bucket until someone else queues…`; render();
    // Keep re-entering every bucket for up to 5 min: an entry lives in one
    // 2 s bucket, so waiting without re-queuing would only ever pair with
    // someone who clicked in the same two seconds.
    const r = await client.waitForMatch({ timeoutMs: 5 * 60_000, sinceBucket: bucket, requeue: entry, signal: mmAbort.signal,
      onTick: () => { MM.text = `waiting… ${((Date.now() - t0) / 1000).toFixed(0)} s — the other player must press Find match too`; if (route.name === 'game') renderMatchmaking(g); } });
    if (!r) { if (MM.state === 'queued') { Object.assign(MM, { state: 'idle', text: '' }); render(); } return; }
    // The relay both players join: the host's, or — when the drawn host fronts none (m16, the Ally) — the same
    // fallback on both screens: the lowest-keyed bonded peer in the verified snapshot that carries this title and
    // advertises one. Without this the title fell back to its own on-chain discovery, which still read the
    // generation-2 directory: a relay hostname dead since 20 Sep → "SERVER OFFLINE" on every launch the desktop
    // did not host (22 Sep 2026).
    const host = r.snapshot.peers.find((p) => p.nodeId === r.match.host) ?? null;
    const relay = host?.wsAddr || r.snapshot.peers.filter((p) => p.wsAddr && p.buildHashes?.[r.match.rulesetId] && p.standing !== 0).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))[0]?.wsAddr || null;
    Object.assign(MM, { state: 'placed', match: r.match, check: r.check, host, relay, waitedMs: r.waitedMs });
    render();
  } catch (e) { Object.assign(MM, { state: 'idle', text: '' }); alert(`queue: ${e.message}`); render(); }
  finally { mmAbort = null; }
}
function stopMatchmaking() { mmAbort?.abort(); Object.assign(MM, { state: 'idle', match: null, check: null, host: null }); render(); }
let lbQuery = '';
function renderLeaderboards() {
  const g = GAMES.find((x) => x.rulesetId === lbTab);
  const st = S.stats[lbTab] ?? {};
  const top = (S.boards[lbTab] ?? []).slice(0, 3);
  const streakOf = (pid) => { const h = history(lbTab, pid); const last = h.at(-1)?.res; if (!last) return '—'; let n = 0; for (let i = h.length - 1; i >= 0 && h[i].res === last; i--) n++; return `${last === 'win' ? 'W' : last === 'loss' ? 'L' : 'D'}${n}`; };
  const podium = top.length ? `<div class="podium">${top.map((r) => { const s2 = st[r.player] ?? {}; const me = r.player === player.id; const color = r.rank === 1 ? '#f2c46d' : r.rank === 3 ? '#f0946a' : '#8ce8ff'; return `
    <div class="rankcard r${r.rank}">
      <div class="head">${rankBadge(r.rank, color)}<span class="badge-tier">${tierOf(levelOf((s2.wins ?? 0) * 60 + ((s2.matches ?? 0) - (s2.wins ?? 0)) * 20).level)}</span></div>
      <div class="name"><img src="${me ? player.avatar : identicon(r.player, 56)}" alt="" />${me ? esc(player.name) : short(r.player, 10)}</div>
      <div class="sub">${esc(g?.title ?? lbTab)}</div>
      <div class="row3"><div><div class="v">${r.rating.toLocaleString()}</div><div class="k">Rating</div></div><div><div class="v">${pct(s2.wins ?? 0, s2.matches ?? 0)}%</div><div class="k">Win rate</div></div><div><div class="v">${streakOf(r.player)}</div><div class="k">Streak</div></div></div>
      <div class="rfoot">ed25519:${r.player}</div>
    </div>`; }).join('')}</div>` : '';
  view('leaderboards').innerHTML = `<div class="page-h"><h1 class="chrome">Ranks</h1><span class="dim">derived by the mesh from settled matches — reproducible by any node</span><div class="right"><input class="search" id="lb-q" placeholder="find player id…" value="${esc(lbQuery)}" /></div></div>
    ${lbQuery ? '' : podium}
    ${panel(g?.title ?? 'Leaderboard', `${lbTabs()}<div style="margin-top:8px">${boardTable(lbTab, 100, lbQuery)}</div>`)}`;
  const q = $('lb-q'); q.addEventListener('input', () => { lbQuery = q.value.trim(); const pos = q.selectionStart; renderLeaderboards(); const q2 = $('lb-q'); q2.focus(); q2.setSelectionRange(pos, pos); });
}
let styleFilter = 'all';
function renderCharacters() {
  const list = styleFilter === 'all' ? CHARACTERS : CHARACTERS.filter((c) => c.style === styleFilter);
  view('characters').innerHTML = `<div class="page-h"><h1 class="chrome">Agents</h1><span class="dim">${CHARACTERS.length} fighters · ${INVENTORY_SAMPLE.unlocked.length} unlocked <span class="tag sample">sample</span></span></div>
    <div class="chips" style="margin-bottom:14px"><button class="chip ${styleFilter === 'all' ? 'active' : ''}" data-style="all">All</button>${Object.entries(STYLES).map(([k, v]) => `<button class="chip ${styleFilter === k ? 'active' : ''}" data-style="${k}" style="${styleFilter === k ? `border-color:${v.color};color:${v.color}` : ''}">${v.label}</button>`).join('')}</div>
    <div class="cgrid big">${list.map((c) => charCard(c, { big: true })).join('')}</div>
    <div class="source">Portraits are served by the hosted Agent Fighter build. Which fighters you own, and your main, come from your account at sync time.</div>`;
}
function renderInventory() {
  const byLine = Object.keys(ITEM_LINES).map((line) => `<div class="section-h"><h4>${ITEM_LINES[line].label} · ${ITEM_LINES[line].effect}</h4></div><div class="igrid">${ITEMS.filter((i) => i.line === line).map((it) => itemCard(it, INVENTORY_SAMPLE.items.find((o) => o.id === it.id)?.qty ?? 0)).join('')}</div>`).join('');
  view('inventory').innerHTML = `<div class="page-h"><h1 class="chrome">Inventory</h1><span class="dim"><span class="tag sample">sample</span> loadout until account sync</span></div>
    <div class="home">
      ${panel('Consumables', byLine, '', 's6')}
      <div class="s6" style="display:flex;flex-direction:column;gap:16px">
        ${panel('Pets', `<div style="display:grid;gap:8px">${INVENTORY_SAMPLE.pets.map(petCard).join('')}</div><div class="source">Rarity odds: ${Object.values(RARITY).map((r) => `${r.label} ${r.pct}%`).join(' · ')}</div>`)}
        ${panel('Tickets', `<div class="big"><div class="icon">🎟</div><div><div class="k">Non-transferable</div><div class="v">${INVENTORY_SAMPLE.tickets}</div></div></div><div class="source">Minted by winning a wager match. Redeemable for esports qualification, merch and vouchers.</div>`)}
      </div>
    </div>`;
}
const isLoopbackNode = () => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(nodeUrl());
/** POST /update on the node (loopback only), then wait for it to come back on the new version. */
async function updateNode() {
  const btn = $('update-btn'); if (btn) { btn.disabled = true; btn.textContent = 'downloading…'; }
  try {
    const r = await fetch(`${nodeUrl()}/update`, { method: 'POST', signal: AbortSignal.timeout(180_000) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.status);
    if (btn) btn.textContent = `applied ${j.to} — restarting…`;
    const was = j.to;
    for (let i = 0; i < 60; i++) { await new Promise((res) => setTimeout(res, 2000)); const h = await api('/health').catch(() => null); if (h && h.version === was) { S.health = h; render(); return; } }
    alert('the node did not come back in 2 minutes — check its window or litnode.log');
  } catch (e) { alert(`update: ${e.message}`); render(); }
}
// ---- hot-key top-up: any connected wallet sends zkLTC to the node's hot key (the gas it spends settling matches).
const Tu = { busy: '', error: '', tx: null, amount: null, walletGas: null, hotGas: null };
const TOPUP_AMOUNTS = ['0.01', '0.05', '0.1'];
const toWei = (z) => BigInt(Math.round(Number(z) * 1e6)) * 10n ** 12n;
async function topUpRun(amount) {
  const f = S.fleet, hot = f?.chain?.matchBook?.purse?.address ?? f?.chain?.announcer?.address;
  if (!hot) return;
  Tu.error = ''; Tu.tx = null; Tu.amount = amount;
  try {
    if (!Op.account) { Tu.busy = 'connecting wallet…'; render(); Op.account = await nodeops.connectOperator(); }
    Tu.busy = `sending ${amount} zkLTC to the hot key — confirm in your wallet`; render();
    Tu.tx = await nodeops.topUp(Op.account, hot, toWei(amount));
    Tu.busy = 'mined — reading the balance…'; render();
    [Tu.hotGas, Tu.walletGas] = await Promise.all([nodeops.gasBalance(hot), nodeops.gasBalance(Op.account)]);
  } catch (e) { Tu.error = e?.code === 4001 ? 'cancelled in the wallet — nothing was sent' : (e?.message ?? String(e)); }
  Tu.busy = ''; render();
}
async function topUpConnect() {
  Tu.error = '';
  try { Tu.busy = 'connecting wallet…'; render(); Op.account = await nodeops.connectOperator(); Tu.walletGas = await nodeops.gasBalance(Op.account); }
  catch (e) { Tu.error = e?.message ?? String(e); }
  Tu.busy = ''; render();
}
// ---- operator actions (cabinet/nodeops.js): the operator's wallet signs bond / delegate / transfer.
const Op = { account: null, info: null, busy: '', error: '', lastTx: null };
const tok = (wei) => fmtTok(Number(wei / 10n ** 14n) / 10_000);
function operatorPanel(h) {
  if (!nodeops.available()) return '<div class="sub dim">Install a wallet (MetaMask) on litVM to bond this node, delegate its announcer or transfer it — or use the CLI: <span class="mono">npm run bond -- &lt;nodeId&gt;</span>.</div>';
  if (Op.busy) return `<div class="sub">${esc(Op.busy)}</div>`;
  const err = Op.error ? `<div class="sub" style="color:var(--bad,#ff7b8a)">${esc(Op.error)}</div>` : '';
  const tx = Op.lastTx ? `<div class="sub dim">last tx <span class="mono">${esc(Op.lastTx.slice(0, 14))}…</span>${CHAIN.explorer ? ` · <a class="link" target="_blank" rel="noopener" href="${esc(CHAIN.explorer)}/tx/${esc(Op.lastTx)}">explorer</a>` : ''}</div>` : '';
  if (!Op.account) return `<div class="sub"><button class="btn sm" id="op-connect">Connect operator wallet</button> <span class="dim">the wallet that bonds this node; nothing is sent until you confirm</span></div>${err}`;
  const i = Op.info; const me = Op.account;
  const mine = !!i?.bonded && i.operator === me;
  const ann = h.directory?.announcer?.address?.toLowerCase() ?? null;
  const rows = [
    `<dt>wallet</dt><dd class="mono">${esc(me)}${i?.balance != null ? ` · ${tok(i.balance)} tLITVM` : ''}${i?.gas != null ? ` · ${(Number(i.gas / 10n ** 12n) / 1e6).toFixed(4)} zkLTC` : ''}</dd>`,
    i && i.gas === 0n ? `<dt>gas</dt><dd><span style="color:var(--red)">no zkLTC — nothing can be signed.</span> Get some at <a href="https://liteforge.hub.caldera.xyz" target="_blank" rel="noopener">liteforge.hub.caldera.xyz</a> (a bond is four small transactions; 0.005 is plenty), then come back.</dd>` : '',
    `<dt>bond</dt><dd>${i ? (i.bonded ? `${tok(i.amount)} tLITVM by <span class="mono">${esc(i.operator.slice(0, 10))}…</span>${mine ? ' (you)' : ''}` : `none · minimum ${tok(i.minStake)} tLITVM`) : 'reading…'}</dd>`,
    ann ? `<dt>announcer</dt><dd class="mono">${esc(ann.slice(0, 10))}… ${i?.announcer === ann ? '<span class="dim">delegated</span>' : '<span class="dim">not delegated</span>'}</dd>` : '',
    ann && i?.bonded ? `<dt>delegate</dt><dd class="mono">${i.delegate ? `${esc(i.delegate.slice(0, 10))}… <span class="dim">${i.delegate === ann ? 'the node’s hot key' : 'another key'}</span>` : '<span class="dim">not set — the node cannot commit, attest or propose</span>'}</dd>` : '',
  ].join('');
  const acts = [
    i && !i.bonded ? '<button class="btn sm primary" id="op-bond">Bond this node</button>' : '',
    i && !i.bonded && CHAIN.TestLITVM && i.balance != null && i.balance < i.minStake ? '<button class="btn sm" id="op-faucet">Faucet tLITVM</button>' : '',
    mine && ann && i.announcer !== ann ? '<button class="btn sm" id="op-delegate">Delegate + fund announcer</button>' : '',
    mine && ann && i.delegate !== ann ? '<button class="btn sm" id="op-hotkey">Set hot key (delegate)</button>' : '',
    mine ? '<button class="btn sm" id="op-transfer">Transfer operator…</button>' : '',
  ].filter(Boolean).join(' ');
  return `<dl class="kv">${rows}</dl><div class="sub">${acts || '<span class="dim">nothing to do from this wallet</span>'}</div>${tx}${err}`;
}
async function opRun(what) {
  const h = S.health; if (!h) return;
  Op.error = '';
  try {
    if (what === 'connect' || !Op.account) { Op.busy = 'connecting wallet…'; render(); Op.account = await nodeops.connectOperator(); }
    const step = (m) => { Op.busy = m; render(); };
    if (what === 'faucet') { step('faucet — confirm in your wallet'); Op.lastTx = await nodeops.faucet(Op.account); }
    if (what === 'bond') { step('bonding…'); Op.lastTx = await nodeops.bond(Op.account, h.nodeId, { onStep: step, delegate: h.directory?.announcer?.address ?? null }); }
    if (what === 'hotkey') { step('setting the hot key…'); Op.lastTx = await nodeops.setDelegate(Op.account, h.nodeId, h.directory.announcer.address); }
    if (what === 'delegate') { step('delegating…'); Op.lastTx = await nodeops.delegateAnnouncer(Op.account, h.nodeId, h.directory.announcer.address, { onStep: step }); }
    if (what === 'transfer') { Op.busy = ''; render(); const to = await ask({ title: 'transfer node', label: 'New operator address', placeholder: '0x…', pattern: '0x[0-9a-fA-F]{40}', hint: 'the bond and the listing move with it', ok: 'Transfer' }); if (!to) { render(); return; } step('transfer — confirm in your wallet'); Op.lastTx = await nodeops.transferOperator(Op.account, h.nodeId, to.trim()); }
    step('reading the chain…');
    Op.info = await nodeops.inspect(h.nodeId, Op.account);
    if (what !== 'connect') readStake(h.nodeId).then((st) => { S.stake = st; render(); });
  } catch (e) { Op.error = e?.message ?? String(e); }
  Op.busy = ''; render();
}
// ---- publisher actions (cabinet/air.js): the AIR account's proxy wallet on THIS node claims titles, adds or revokes builds, hands them over, and bonds the node.
const Pub = { busy: '', error: '', lastTx: null };
function publisherPanel(h) {
  if (!air.configured()) return '<div class="sub dim">Universal login is not configured in this build; publish from the CLI: <span class="mono">npm run publish:title -- register rulesets/&lt;id&gt;.js</span>.</div>';
  if (Pub.busy) return `<div class="sub">${esc(Pub.busy)}</div>`;
  const err = Pub.error ? `<div class="sub" style="color:var(--bad,#ff7b8a)">${esc(Pub.error)}</div>` : '';
  const tx = Pub.lastTx ? `<div class="sub dim">last tx <span class="mono">${esc(Pub.lastTx.slice(0, 14))}…</span>${CHAIN.explorer ? ` · <a class="link" target="_blank" rel="noopener" href="${esc(CHAIN.explorer)}/tx/${esc(Pub.lastTx)}">explorer</a>` : ''}</div>` : '';
  const s = Ai.me.session;
  if (!s?.address) return `<div class="sub"><button class="btn sm" id="pub-signin">Sign in with AIR</button> <span class="dim">your AIR account gets a litVM wallet on this node; it holds the titles you publish</span></div>${err}`;
  if (s.custody !== 'here') return `<div class="sub dim">Your litVM wallet <span class="mono">${esc(s.address.slice(0, 10))}…</span> is held by another node. Open that node's cabinet to publish, or transfer the title to a wallet you control.</div>`;
  if (!h.trust?.titleRegistry) return '<div class="sub dim">This node has no TitleRegistry configured (contracts/deployed.testnet.json); titles cannot be claimed on chain from here.</div>';
  const me = s.address.toLowerCase();
  const bondedByMe = h.bonded && S.stake?.operator?.toLowerCase() === me;
  const bondLine = h.bonded === false ? `<div class="sub"><button class="btn sm primary" data-pub="bond">Bond this node from my AIR wallet</button> <span class="dim">approve + stake the minimum from <span class="mono">${esc(s.address.slice(0, 10))}…</span>, delegate the announcer; a title is listed only while its holder runs a bonded host</span></div>`
    : bondedByMe ? '<div class="sub dim">This node is bonded from your AIR wallet: titles you hold here are listed in the arcade.</div>'
    : h.bonded ? `<div class="sub dim">This node is bonded from another wallet${S.stake?.operator ? ` (<span class="mono">${esc(S.stake.operator.slice(0, 10))}…</span>)` : ''}: a title your AIR wallet holds is hosted here but not listed until a node bonded from your wallet hosts it.</div>` : '';
  const mine = S.titles.filter((t) => t.hosts?.includes(h.nodeId));
  const rows = mine.length ? mine.map((t) => {
    const owner = t.owner ? (t.owner === me ? '<b>you</b>' : `<span class="mono" title="${esc(t.owner)}">${esc(t.owner.slice(0, 10))}…</span>`) : '<span class="dim">unclaimed</span>';
    const build = !t.owner ? '' : t.build ? (t.build.ok ? '<span class="dim">build active</span>' : `<span class="dim">${esc(t.build.reason)}</span>`) : '<span class="dim">reading…</span>';
    const acts = !t.owner ? `<button class="btn sm primary" data-pub="register" data-rid="${esc(t.rulesetId)}">Claim</button>`
      : t.owner === me ? [
        t.build && !t.build.registered ? `<button class="btn sm primary" data-pub="set-build" data-rid="${esc(t.rulesetId)}">Add this build</button>` : '',
        t.build?.registered && !t.build.revoked ? `<button class="btn sm" data-pub="revoke" data-rid="${esc(t.rulesetId)}">Revoke build</button>` : '',
        `<button class="btn sm" data-pub="transfer" data-rid="${esc(t.rulesetId)}">Transfer…</button>`,
      ].filter(Boolean).join(' ') : '';
    return `<tr><td>${esc(t.display?.title ?? t.rulesetId)} <span class="dim mono">${esc(t.rulesetId)}</span></td><td>${owner}</td><td>${t.published ? 'listed' : t.owner ? '<span class="dim">not listed</span>' : ''} ${build}</td><td>${acts}</td></tr>`;
  }).join('') : '';
  const table = mine.length ? `<table><thead><tr><th>Title on this node</th><th>Holder</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="sub dim">This node hosts no titles. Add one to RULESETS in node.env (docs/HOST-YOUR-TITLE.md), restart, and claim it here.</div>';
  return `<div class="sub">AIR <b>${esc(Ai.me.email ?? s.name ?? '')}</b> · litVM wallet <span class="mono" title="${esc(s.address)}">${esc(s.address.slice(0, 10))}…</span> · a title is an NFT this wallet holds; transferring it hands the title over</div>${bondLine}${table}${tx}${err}`;
}
async function pubRun(what, rid) {
  const h = S.health; if (!h) return;
  Pub.error = '';
  try {
    const step = (m) => { Pub.busy = m; render(); };
    if (what === 'bond') { step('bonding this node from your AIR wallet — the node signs, no prompt…'); const r = await air.bond(nodeUrl()); Pub.lastTx = r.steps?.at(-1)?.tx ?? Pub.lastTx; }
    else {
      let to = null;
      if (what === 'transfer') { const v = await ask({ title: `transfer ${rid}`, label: 'New holder address', placeholder: '0x…', pattern: '0x[0-9a-fA-F]{40}', hint: 'the title NFT moves to this wallet; this node can no longer act for it', ok: 'Transfer' }); if (!v) { render(); return; } to = v.trim(); }
      step({ register: `claiming ${rid} on chain…`, 'set-build': `registering this build of ${rid}…`, revoke: `revoking this build of ${rid}…`, transfer: `transferring ${rid}…` }[what]);
      const r = await air.publish(nodeUrl(), { action: what, rulesetId: rid, to });
      Pub.lastTx = r.tx ?? Pub.lastTx;
    }
    step('reading the chain…');
    const [{ titles }, st] = await Promise.all([api('/titles').catch(() => ({ titles: S.titles })), readStake(h.nodeId).catch(() => S.stake)]);
    S.titles = titles ?? S.titles; S.stake = st; S.health = await api('/health').catch(() => h);
  } catch (e) { Pub.error = e?.message ?? String(e); }
  Pub.busy = ''; render();
}
// ═══════════════════════════════════════════════ node page ══
const ex = (kind, v, n = 10) => (v ? `<a class="link mono" target="_blank" rel="noopener" title="${esc(v)}" href="${esc(CHAIN.explorer)}/${kind}/${esc(v)}">${esc(v.slice(0, n))}…</a>` : '—');
const copyable = (v, n = 12) => (v ? `<span class="mono copy" data-copy="${esc(v)}" title="${esc(v)} — click to copy">${esc(v.slice(0, n))}…</span>` : '—');
const stateTag = (st) => ({ ok: '<span class="tag live">done</span>', warn: '<span class="tag hosted">pending</span>', todo: '<span class="tag court">to do</span>', na: '<span class="tag">n/a</span>' })[st] ?? '';
const GAS_FAUCET = 'https://liteforge.hub.caldera.xyz';
/** The operator's cockpit, from the node's signed /fleet; the older /health rows when a node predates it. */
function renderNode() {
  const h = S.health, f = S.fleet;
  const verified = f ? `<span class="tag live" title="digest ${esc(f.digest.slice(0, 12))}… · signed by ${esc(f.nodeId.slice(0, 12))}… at ${esc(f.at)}">signed by the node · ${ago(Date.now() - S.fleetAt)} ago</span>` : S.fleetError ? `<span class="tag court" title="${esc(S.fleetError)}">unverified: ${esc(S.fleetError)}</span>` : '';
  const legacy = h ? `<dl class="kv">
      <dt>node id</dt><dd title="${esc(h.nodeId)}">${esc(h.nodeId)}</dd><dt>operator</dt><dd>${esc(h.operator)}</dd><dt>roles</dt><dd>${esc(h.roles.join(', '))}</dd><dt>region</dt><dd>${esc(h.region)}</dd>
      <dt>address</dt><dd>${esc(h.addr)}</dd><dt>bonded</dt><dd>${h.bonded === null ? 'unknown (offline / no stake contract)' : h.bonded ? 'yes' : 'no — Operator panel below'}</dd>
      <dt>tunnel</dt><dd>${h.tunnel?.node ? `${esc(h.tunnel.node.mode)} · ${esc(h.tunnel.node.state)}${h.tunnel.node.url ? ` · ${esc(h.tunnel.node.url)}` : ''}${h.tunnel.node.lastError ? ` · ${esc(h.tunnel.node.lastError)}` : ''}` : 'none — LAN address only'}</dd>
      <dt>relay</dt><dd>${h.wsAddr ? `${esc(h.wsAddr)}${h.tunnel?.relay ? ` (${esc(h.tunnel.relay.state)})` : ''}` : 'none advertised'}</dd>
      <dt>version</dt><dd>${esc(h.version ?? '?')}${h.update?.available ? ` — <b>${esc(h.update.latest)} available</b>` : h.update?.checkedAt ? ' — up to date' : ''}${h.update?.lastError ? ` <span class="dim">(check failed: ${esc(h.update.lastError)})</span>` : ''}</dd>
      <dt>cabinet</dt><dd>${esc(CABINET_VERSION)}${h.version && h.version !== CABINET_VERSION ? ` — <b>this copy of the arcade is not the node's (node serves ${esc(h.cabinet?.version ?? h.version)})</b>` : ' — matches the node'}</dd>
      <dt>reachable</dt><dd>${h.inbound ? (h.inbound.reachable === null ? 'no peers known yet' : h.inbound.reachable ? `yes — ${h.inbound.peers} peer${h.inbound.peers === 1 ? '' : 's'} push gossip to this node` : 'no peer has reached this node in 30 s — fine for a witness; a seed, LAN host or relay needs allow-firewall.cmd or a tunnel') : '—'}</dd>
      <dt>chain</dt><dd>${h.chain.offline ? 'offline beacon' : `${esc(h.chain.rpc)} · block ${h.chain.head ?? '?'}`}${h.chain.lastError ? ` · ${esc(h.chain.lastError)}` : ''}</dd>
      <dt>rulesets</dt><dd>${Object.entries(h.rulesets).map(([k, v]) => `${esc(k)} @ ${v.slice(0, 10)}`).join(', ')}</dd><dt>builds held</dt><dd>${h.buildsHeld}</dd>
    </dl>` : `<div class="empty">No node at <span class="mono">${esc(nodeUrl())}</span>. Start one below, or <button class="link" id="node-edit2">point the cabinet at another node</button>.</div>`;

  // ---- from /fleet
  let identity = legacy, checklistHtml = '', purseHtml = '', reachHtml = '', releaseHtml = '', chainHtml = '', workHtml = '', eventsHtml = '', peersHtml = '';
  if (f) {
    const sf = f.self, mb = f.chain.matchBook, purse = mb?.purse ?? null, ann = f.chain.announcer;
    identity = `<dl class="kv">
      <dt>node id</dt><dd>${copyable(sf.nodeId, 24)} <span class="dim">ed25519 · the key the operator bonds</span></dd>
      <dt>operator</dt><dd>${esc(sf.operator)} · ${esc(sf.roles.join(', '))} · ${esc(sf.region)}</dd>
      <dt>operator wallet</dt><dd>${sf.wallet ? ex('address', sf.wallet) : '<span class="dim">not bonded</span>'}${sf.bond?.amount ? ` <span class="dim">· ${fmtTok(Number(BigInt(sf.bond.amount) / 10n ** 14n) / 10_000)} ${CHAIN.token} bonded</span>` : ''}</dd>
      <dt>hot key</dt><dd>${ann ? ex('address', ann.address) : '—'} <span class="dim">signs commits, attests, announces · never holds the bond</span></dd>
      <dt>version</dt><dd>node ${esc(sf.version)} · cabinet ${esc(CABINET_VERSION)}${sf.version !== CABINET_VERSION ? ` — <b>this copy of the arcade is not the node's (it serves ${esc(f.cabinet)})</b>` : ''} · protocol ${f.protocol}</dd>
      <dt>up</dt><dd>${fmtDuration(sf.uptimeMs)} since ${new Date(sf.startedAt).toLocaleString()}</dd>
    </dl>`;
    const steps = fleetChecklist(f, { cabinetContracts: CONTRACTS.contracts });
    checklistHtml = `<ol class="checklist">${steps.map((st) => `<li class="${st.state}"><span class="st">${stateTag(st.state)}</span><span><b>${esc(st.label)}</b><small>${esc(st.detail)}</small></span></li>`).join('')}</ol>
      <div class="source">Every step is read from the node and the chain, not remembered. Wallet steps are in the Operator panel; the rest the node does by itself once the step before it is done.</div>`;
    if (purse) {
      const price = purse.gasPriceWei ? Number(purse.gasPriceWei) : null;
      const perMatch = purse.perMatchGas ?? 445_000;
      const covers = (z) => (price ? Math.floor((Number(z) * 1e18) / (perMatch * price)) : null);
      const walletOk = nodeops.available();
      const buttons = TOPUP_AMOUNTS.map((z) => `<button class="btn sm${purse.low && z === '0.05' ? ' primary' : ''}" data-topup="${z}" ${Tu.busy ? 'disabled' : ''}>+ ${z} zkLTC<small>${covers(z) != null ? ` ≈ ${covers(z)} matches` : ''}</small></button>`).join(' ');
      purseHtml = `<div class="purse ${purse.low ? 'low' : ''}">
        <div class="big-tok"><span class="chrome">${esc(Tu.hotGas != null ? (Number(Tu.hotGas) / 1e18).toFixed(6) : purse.balance ?? '—')}</span><span class="tok">zkLTC on the hot key${Tu.hotGas != null ? ' <span class="dim">(just read)</span>' : ''}</span></div>
        <dl class="kv"><dt>covers</dt><dd>~${purse.matchesLeft ?? '?'} matches as ${esc(purse.perMatchRole ?? 'host')} <span class="dim">(${Math.round(perMatch / 1000)}k gas each at ${price ? (price / 1e9).toFixed(2) : '?'} gwei)</span></dd>
        <dt>hot key</dt><dd>${ex('address', purse.address, 42)} <button class="link" data-copy-now="${esc(purse.address)}">copy</button></dd>
        <dt>transactions</dt><dd>${mb.sends} sent since start · type-${purse.txType ?? '?'}${mb.lastError ? ` · <span style="color:var(--red)">${esc(mb.lastError)}</span>` : ''}</dd></dl>
        ${purse.low ? '<div class="sub" style="color:var(--red)">LOW — a host that runs dry mid-match voids it. Top up below.</div>' : ''}
        <div class="topup">
          <div class="k">Top up</div>
          ${walletOk ? `<div class="row">${buttons}</div>
            <div class="sub dim">${Op.account ? `from ${esc(Op.account.slice(0, 6))}…${esc(Op.account.slice(-4))}${Tu.walletGas != null ? ` · ${(Number(Tu.walletGas) / 1e18).toFixed(4)} zkLTC in this wallet` : ''}` : `<button class="link" id="topup-connect">connect a wallet</button> — any wallet on ${esc(CHAIN.name)} can pay; the hot key spends it on this node's transactions and can never touch the bond`}</div>`
          : '<div class="sub dim">No browser wallet here. Use the faucet route below — it needs none.</div>'}
          ${Tu.busy ? `<div class="sub">${esc(Tu.busy)}</div>` : ''}
          ${Tu.tx ? `<div class="sub">sent ${esc(Tu.amount)} zkLTC · ${ex('tx', Tu.tx, 14)} — the node sees it within 30 s</div>` : ''}
          ${Tu.error ? `<div class="sub" style="color:var(--red)">${esc(Tu.error)}</div>` : ''}
          <div class="sub dim">No zkLTC yet? Testnet gas is free: <button class="link" data-copy-now="${esc(purse.address)}">copy the hot-key address</button>, open <a class="link" target="_blank" rel="noopener" href="${GAS_FAUCET}">the Caldera faucet</a>, paste it there and claim — it lands on the node directly. (The tLITVM bond token is a different faucet, in the Operator panel.)</div>
        </div>
      </div>`;
    }
    reachHtml = `<dl class="kv">
      <dt>advertised</dt><dd>${esc(sf.addr)}${sf.lanAddr && sf.lanAddr !== sf.addr ? ` <span class="dim">· LAN ${esc(sf.lanAddr)}</span>` : ''}</dd>
      <dt>tunnel</dt><dd>${sf.tunnel ? `${esc(sf.tunnel.mode)} · <b>${esc(sf.tunnel.state)}</b>${sf.tunnel.restarts ? ` · rotated ${sf.tunnel.restarts}×` : ''}${sf.tunnel.lastError && sf.tunnel.state !== 'up' ? ` · ${esc(sf.tunnel.lastError.slice(0, 160))}` : ''}` : '<span class="dim">none (LAN only)</span>'}</dd>
      <dt>inbound</dt><dd>${sf.inbound.reachable === null ? 'no peers known yet' : sf.inbound.reachable ? `${sf.inbound.peers} peer${sf.inbound.peers === 1 ? '' : 's'} push gossip here` : 'nobody has reached this node in 30 s'}</dd>
      ${sf.relay ? `<dt>relay</dt><dd><b>${esc(sf.relay.state)}</b>${sf.relay.ms != null ? ` · ${sf.relay.ms} ms` : ''}${sf.relay.url ? ` · ${esc(sf.relay.url)}` : ''} <span class="dim">· port ${sf.relay.port} · checked ${sf.relay.checkedAt ? ago(Date.now() - new Date(sf.relay.checkedAt).getTime()) + ' ago' : 'never'}</span>${sf.relay.lastError ? ` · <span style="color:var(--red)">${esc(sf.relay.lastError)}</span>` : ''}</dd>` : ''}
      <dt>directory</dt><dd>${ann?.entry ? `${esc(ann.entry.url)}${ann.entry.wsAddr ? ` · relay ${esc(ann.entry.wsAddr)}` : ''} <span class="dim">· announced ${ann.entry.updatedAt ? new Date(ann.entry.updatedAt).toLocaleString() : '?'}</span>` : ann && !('entry' in ann) ? '<span class="dim">entry not reported by this node version</span>' : '<span class="dim">no entry on NodeDirectory</span>'}${ann?.lastTx ? ` · tx ${ex('tx', ann.lastTx)}` : ''}${ann?.lastError ? ` · <span style="color:var(--red)">${esc(ann.lastError)}</span>` : ''}</dd>
      <dt>mesh</dt><dd>${f.mesh.active} active · ${f.mesh.known} known · ${f.mesh.bonded} bonded · ${f.mesh.eligible} eligible${f.mesh.incompatible ? ` · ${f.mesh.incompatible} incompatible` : ''} · versions ${Object.entries(f.mesh.versions).map(([v, n]) => `${esc(v)}×${n}`).join(' ')}</dd>
      <dt>gossip</dt><dd>${f.mesh.gossip.outPerMin}↑ ${f.mesh.gossip.inPerMin}↓ per min · ${(f.mesh.gossip.outBytesPerMin / 1024 / 60).toFixed(1)} KB/s out · ${(f.mesh.gossip.inBytesPerMin / 1024 / 60).toFixed(1)} KB/s in</dd>
    </dl>`;
    const u = sf.update;
    releaseHtml = `<dl class="kv">
      <dt>running</dt><dd>${esc(sf.version)}${u.applying ? ' · applying…' : ''}</dd>
      <dt>latest</dt><dd>${u.latest ? `${esc(u.latest)}${u.available ? ' — <b>available</b>' : ' — this is it'}${u.date ? ` <span class="dim">· ${new Date(u.date).toLocaleString()}</span>` : ''}` : '<span class="dim">no release manifest read yet</span>'}</dd>
      <dt>registry gate</dt><dd>${esc(u.registry ?? 'not reported by this node version')} <span class="dim">· ${{ active: 'the zip hash is registered and active on ReleaseRegistry — a node may apply it', pending: 'registered, activation delay not over', revoked: 'REVOKED — will not be applied', unset: 'no registry configured', unchecked: 'not looked at yet', unreadable: 'the chain did not answer' }[u.registry] ?? ''}</span></dd>
      <dt>channel</dt><dd>${esc(u.channel ?? 'stable')} · checked ${u.checkedAt ? ago(Date.now() - new Date(u.checkedAt).getTime()) + ' ago' : 'never'}${u.lastError ? ` · <span style="color:var(--red)">${esc(u.lastError)}</span>` : ''}${u.canRollback ? ' · previous build kept (rollback possible)' : ''}</dd>
    </dl>`;
    const c = f.chain, cs = c.contracts ?? {};
    chainHtml = `<dl class="kv">
      <dt>rpc</dt><dd>${esc(c.rpc)} · <b>${c.rpcMs ?? '?'} ms</b> avg (last ${c.rpcLastMs ?? '?'}) · ${c.rpcFailures}/${c.rpcCalls} failed${c.lastError ? ` · <span style="color:var(--red)">${esc(c.lastError)}</span>` : ''}</dd>
      <dt>head</dt><dd>${c.head ?? '—'} · lag ${c.lagS ?? '?'} s${c.recentBlocks?.length ? ` · ${ex('block', String(c.recentBlocks.at(-1).number), 12)}` : ''}</dd>
      <dt>generation</dt><dd>${cs.generation ?? (c.contracts ? '?' : 'not reported by this node version')} on the node · ${CONTRACTS.generation ?? '?'} in this cabinet</dd>
      ${['NodeStake', 'NodeDirectory', 'MatchBook', 'EpochAnchor', 'ReleaseRegistry', 'TitleRegistry', 'PlayerProfile'].map((k) => cs[k] ? `<dt>${k}</dt><dd>${ex('address', cs[k], 42)}${CONTRACTS.contracts[k]?.address && CONTRACTS.contracts[k].address.toLowerCase() !== cs[k].toLowerCase() ? ` <span style="color:var(--red)">≠ this cabinet's ${esc(CONTRACTS.contracts[k].address.slice(0, 10))}…</span>` : ''}</dd>` : '').join('')}
      ${mb ? `<dt>settlement</dt><dd>cursor ${mb.cursor} · ${mb.events} events held · hosting ${mb.hosting} · seated ${mb.seated} · windows settle ${mb.windows?.settleWindow ?? '?'} s / attest ${mb.windows?.attestWindow ?? '?'} s / escalation ${mb.windows?.escalationWindow ?? '?'} s</dd>` : ''}
    </dl>`;
    const sent = mb?.sent ?? [];
    workHtml = `${sent.length ? `<table><thead><tr><th>When</th><th>What</th><th>Match</th><th>Transaction</th><th class="num">Gas</th><th>Result</th></tr></thead><tbody>${[...sent].reverse().slice(0, 15).map((x) => `<tr><td class="dim">${new Date(x.at).toLocaleTimeString()}</td><td>${esc(x.what)}</td><td class="mono">${x.matchId ? esc(x.matchId.slice(0, 12)) + '…' : '—'}</td><td>${ex('tx', x.tx, 14)}</td><td class="num">${x.gasUsed?.toLocaleString() ?? '—'}</td><td>${x.ok === true ? '<span class="tag live">mined</span>' : x.ok === false ? '<span class="tag court">reverted</span>' : '<span class="tag">pending</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No transactions from this key since the node started. Commits, settles and attests appear here as ranked matches are played.</div>'}
      ${f.recent.length ? `<div class="source">Recent finals on chain: ${f.recent.slice(-5).reverse().map((r) => `<a class="link mono" href="#/match/${esc(r.matchId)}" title="match receipt">${esc(r.matchId.slice(0, 10))}…</a> ${esc(r.status)}${r.tx ? ' ' + ex('tx', r.tx, 8) : ''}`).join(' · ')}</div>` : ''}
      ${f.rooms.length ? `<div class="source">Rooms held now: ${f.rooms.map((r) => `<span class="mono">${esc(r.room)}</span> ${esc(r.state)}${r.ours ? ' (host)' : r.seated ? ' (seat)' : ''}`).join(' · ')}</div>` : ''}`;
    eventsHtml = f.events.length ? `<div class="events">${[...f.events].reverse().slice(0, 12).map((e) => `<div><time>${new Date(e.t).toLocaleTimeString()}</time><span class="mono dim">${esc(e.type)}</span><span>${esc(describeEvent(e))}</span></div>`).join('')}</div>` : '<div class="empty">Nothing yet.</div>';
    peersHtml = f.peers.length ? `<table><thead><tr><th>Operator</th><th>Node</th><th>Version</th><th>Roles</th><th>Quality</th><th>Ping</th><th>Bonded</th><th>Address</th></tr></thead><tbody>${[...f.peers].sort((a, b) => b.quality.score - a.quality.score).map((p) => `<tr><td>${esc(p.operator)}</td><td class="mono" title="${esc(p.nodeId)}">${esc(p.nodeId.slice(0, 12))}…</td><td>${esc(p.version ?? '?')}${p.protocol !== f.protocol ? ' <span class="tag court">protocol</span>' : ''}</td><td class="dim">${esc(p.roles.join(', '))}</td><td><span class="tag ${p.quality.grade === 'A' || p.quality.grade === 'B' ? 'live' : p.quality.grade === 'C' ? 'hosted' : 'court'}">${p.quality.grade} ${p.quality.score}</span>${p.fresh ? '' : ` <span class="dim">silent ${Math.round(p.ageS)} s</span>`}</td><td>${p.link?.emaMs != null ? `${p.link.emaMs} ms${p.link.loss ? ` · ${Math.round(p.link.loss * 100)}% loss` : ''}` : p.link?.inboundMs != null ? `←${p.link.inboundMs} ms <span class="dim">(they reach us)</span>` : '<span class="dim">via mesh</span>'}</td><td>${p.bonded === null ? '?' : p.bonded ? 'yes' : 'no'}</td><td class="mono dim">${esc(p.addr ?? '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No peers heard yet.</div>';
  }
  const peersLegacy = S.peers.length ? `<table><thead><tr><th>Node</th><th>Operator</th><th>Region</th><th>Roles</th><th>Fresh</th><th>Bonded</th><th>Rulesets</th></tr></thead><tbody>${S.peers.map((p) => `<tr><td class="mono" title="${esc(p.nodeId)}">${esc(p.nodeId.slice(0, 12))}…</td><td>${esc(p.operator)}</td><td>${esc(p.region ?? '')}</td><td class="dim">${esc((p.roles ?? []).join(', '))}</td><td>${p.fresh ? 'yes' : 'no'}</td><td>${p.bonded === null ? '?' : p.bonded ? 'yes' : 'no'}</td><td class="dim">${esc((p.rulesets ?? []).join(', '))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No peers heard yet.</div>';
  const updateMore = h?.update?.available ? (isLoopbackNode() ? '<button class="btn sm primary" id="update-btn">Update node</button>' : '<span class="dim">update from the node\'s own machine</span>') : '';
  view('node').innerHTML = `<div class="page-h"><h1 class="chrome">Nodes</h1><span class="dim">run a node while you play — it verifies and witnesses matches for the mesh</span></div>
    <div class="home">
      ${nodePanel({ compact: false })}
      ${panel('This node', identity, verified, 's6')}
      ${f ? panel('Setup', checklistHtml, '', 's6') : panel('7-day uptime', `${heatmap(S.uptime)}<div class="legend"><i class="up"></i>up <i class="partial"></i>partial <i class="down"></i>down <i class="none"></i>dashboard closed</div><div class="source">Observed by this dashboard while it is open, 10-minute slots.</div>`, '', 's6')}
      ${f && purseHtml ? panel('Hot key · gas', purseHtml, '', 's6') : ''}
      ${f ? panel('Reach · directory', reachHtml, '', 's6') : ''}
      ${h ? panel('Operator', operatorPanel(h), '', 's6') : ''}
      ${h ? panel('Publisher', publisherPanel(h), '', 's6') : ''}
      ${f ? panel('Release', releaseHtml, updateMore, 's6') : ''}
      ${f ? panel('Chain · contracts', chainHtml, `<span class="dim">${esc(CHAIN.name)} · <a class="link" target="_blank" rel="noopener" href="${esc(CHAIN.explorer)}">explorer</a></span>`, 's6') : ''}
      ${f ? panel('Settlement work · this key', workHtml, '', 's12') : ''}
      ${f ? panel('Events', eventsHtml, '', 's6') : ''}
      ${f ? panel('7-day uptime', `${heatmap(S.uptime)}<div class="legend"><i class="up"></i>up <i class="partial"></i>partial <i class="down"></i>down <i class="none"></i>dashboard closed</div><div class="source">Observed by this dashboard while it is open, 10-minute slots.</div>`, '', 's6') : ''}
      ${panel('Run a node', `<p>The arcade is a peer network: this page talks to the mesh through a node on <b>your</b> machine, the way a torrent client is the peer. Every node verifies and witnesses matches for everyone.</p><ol class="steps">
          <li><a class="link" href="${RELEASES}" target="_blank" rel="noopener">Download the latest release</a> (the <span class="mono">-win-x64</span> zip carries its own runtime) or the LITNODE Control Plane app — releases are signed and registered on chain; the node refuses anything else.</li>
          <li>Unzip anywhere, double-click <span class="mono">start-node.cmd</span>, give it a name. Reload this page: the header turns green and the <b>Setup</b> panel above shows what is left.</li>
          <li>Bond from the operator wallet and set the hot key (Operator panel), send the hot key a little zkLTC (Hot key panel). Enrolment, the tunnel, the announce and updates are the node's own job.</li>
          <li>Only if others must reach you (a seed, a LAN host): <span class="mono">allow-firewall.cmd</span> once, or <span class="mono">TUNNEL=quick</span> in <span class="mono">node.env</span>.</li></ol>`, '', 's6')}
      ${panel('Seeds on chain', seeds.configured() ? (S.seeds.length ? `<table><thead><tr><th>Operator</th><th>Node</th><th>Address</th><th>Relay</th><th>Announced</th></tr></thead><tbody>${S.seeds.map((s) => `<tr><td class="mono">${s.operator.slice(0, 6)}…${s.operator.slice(-4)}</td><td class="mono" title="${esc(s.nodeId)}">${short(s.nodeId, 12)}</td><td class="mono">${esc(s.url)}</td><td class="mono dim">${esc(s.wsAddr ?? '—')}</td><td class="dim">${new Date(s.updatedAt * 1000).toLocaleString()}</td></tr>`).join('')}</tbody></table><div class="source">Read from NodeDirectory on ${esc(CHAIN.name)}: bonded nodes that announced an address in the last 7 days. ${S.viaSeed ? `This page is reading the mesh through ${esc(S.viaSeed.url)}.` : 'Your own node comes first; these are the fallback.'}</div>` : '<div class="empty">No seed has announced yet, or the chain is unreachable. <button class="link" id="seeds-refresh">Read again</button></div>') : '<div class="empty">NodeDirectory is not configured in this build (config.js CHAIN.NodeDirectory).</div>', '', 's12')}
      ${panel('Peers', f ? peersHtml : peersLegacy, f ? `<span class="dim">measured on this node's gossip push, every second</span>` : '', 's12')}
    </div>`;
  $('node-edit2')?.addEventListener('click', editNode);
  $('update-btn')?.addEventListener('click', updateNode);
  for (const w of ['connect', 'faucet', 'bond', 'delegate', 'hotkey', 'transfer']) $(`op-${w}`)?.addEventListener('click', () => opRun(w));
  $('pub-signin')?.addEventListener('click', () => signInWithAir().then(render));
  for (const b of view('node').querySelectorAll('[data-pub]')) b.addEventListener('click', () => pubRun(b.dataset.pub, b.dataset.rid ?? null));
  $('seeds-refresh')?.addEventListener('click', () => { S.seedsAt = 0; findSeed().then(render); });
  for (const c of view('node').querySelectorAll('[data-copy]')) c.addEventListener('click', () => { navigator.clipboard?.writeText(c.dataset.copy).then(() => { c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 900); }).catch(() => {}); });
  for (const c of view('node').querySelectorAll('[data-copy-now]')) c.addEventListener('click', () => { navigator.clipboard?.writeText(c.dataset.copyNow).then(() => { const t = c.textContent; c.textContent = 'copied ✓'; setTimeout(() => { c.textContent = t; }, 1200); }).catch(() => {}); });
  for (const b of view('node').querySelectorAll('[data-topup]')) b.addEventListener('click', () => topUpRun(b.dataset.topup));
  $('topup-connect')?.addEventListener('click', topUpConnect);
}

// ═══════════════════════════════════════════════ match receipt ══
/** #/match/<id>: what the chain recorded about one match — every step a
 *  transaction that opens on the Liteforge explorer, each receipt re-checked
 *  from this browser (cabinet/receipt.js). Loaded once per visit and on
 *  "Refresh"; the poll's re-renders reuse it. */
const Rcpt = { id: null, data: null, loading: false, error: null, at: 0 };
function renderMatch(matchId, { refresh = false } = {}) {
  const el = view('match');
  const draw = () => {
    const names = { [player.id]: player.name };
    el.innerHTML = Rcpt.data
      ? renderReceipt(Rcpt.data, { explorer: CHAIN.explorer, me: player.id, names, contracts: CHAIN })
        + `<div class="source" style="margin-top:10px">Read from ${esc(nodeUrl())} ${ago(Date.now() - Rcpt.at)} ago · <button class="link" id="rcpt-refresh">refresh</button></div>`
      : `<div class="page-h"><a class="dim" href="#/games">‹ arcade</a><h1 class="chrome" style="margin-left:12px">Match receipt</h1></div>${panel('Match', `<div class="empty">${Rcpt.error ? `Could not read this match: ${esc(Rcpt.error)}` : `Reading <span class="mono">${esc(short(matchId, 16))}</span> from the node and the chain…`}</div>`)}`;
    $('rcpt-refresh')?.addEventListener('click', () => renderMatch(matchId, { refresh: true }));
    for (const c of el.querySelectorAll('[data-copy]')) c.addEventListener('click', () => { navigator.clipboard?.writeText(c.dataset.copy).then(() => { c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 900); }).catch(() => {}); });
    for (const c of el.querySelectorAll('[data-copy-now]')) c.addEventListener('click', () => { navigator.clipboard?.writeText(c.dataset.copyNow).then(() => { const t = c.textContent; c.textContent = 'copied ✓'; setTimeout(() => { c.textContent = t; }, 1200); }).catch(() => {}); });
  };
  if (Rcpt.id !== matchId) Object.assign(Rcpt, { id: matchId, data: null, error: null, at: 0 });
  draw();
  if (Rcpt.loading || (Rcpt.data && !refresh) || (Rcpt.error && Date.now() - Rcpt.at < 10_000 && !refresh)) return;
  Rcpt.loading = true;
  loadReceipt(matchId, { api, rpc: seeds.rpc, contracts: CHAIN })
    .then((d) => { if (Rcpt.id === matchId) Object.assign(Rcpt, { data: d, error: null, at: Date.now() }); })
    .catch((e) => { if (Rcpt.id === matchId) Object.assign(Rcpt, { error: e.message, at: Date.now() }); })
    .finally(() => { Rcpt.loading = false; if (route.name === 'match' && route.matchId === matchId) draw(); });
}

// ═══════════════════════════════════════════════ router ══
let route = { name: 'home' };
function parseRoute() {
  const h = location.hash;
  const m = h.match(/^#\/game\/([\w-]+)/);
  if (m) { const g = GAMES.find((x) => x.id === m[1]); return g ? { name: 'game', game: g } : { name: 'games' }; }
  const mr = h.match(/^#\/match\/([\w:.-]{1,128})/);
  if (mr) return { name: 'match', matchId: mr[1] };
  const name = (h.match(/^#\/(\w+)/)?.[1]) ?? 'home';
  return ['games', 'leaderboards', 'characters', 'inventory', 'node', 'build'].includes(name) ? { name } : { name: 'home' };
}
function render() {
  renderWorking();
  switch (route.name) {
    case 'home': renderHome(); break;
    case 'games': renderGames(); break;
    case 'game': renderGame(route.game); break;
    case 'leaderboards': renderLeaderboards(); break;
    case 'characters': renderCharacters(); break;
    case 'inventory': renderInventory(); break;
    case 'node': renderNode(); break;
    case 'build': renderBuild(view('build')); break;
    case 'match': renderMatch(route.matchId); break;
  }
}
function navigate() {
  route = parseRoute();
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== route.name;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.view === route.name || (route.name === 'game' && a.dataset.view === 'games'));
  if (route.name !== 'game') viewing = null;
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', navigate);

// One delegated click handler for everything rendered from templates.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-play],[data-queue],[data-mm-stop],[data-mm-reset],[data-mm-launch],[data-lb],[data-style],#name-btn,#avatar-btn,#wallet-btn,#air-btn,#air-link,#air-out,#me-chip,#dash-lock-btn');
  if (!t) return;
  if (t.id === 'wallet-btn') { signInWithWallet(); return; }
  if (t.dataset.play) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.play); if (g) play(g); }
  else if (t.dataset.queue) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.queue); if (g) findMatch(g); }
  else if ('mmStop' in t.dataset || 'mmReset' in t.dataset) stopMatchmaking();
  // Everything a title needs to run and settle the placed match (sdk/client.js):
  // the host's address to POST /ledger to, the build to sign for, the mode the
  // node will require, the participant order the log is recorded in.
  else if ('mmLaunch' in t.dataset) { if (MM.game && MM.check?.ok) play(MM.game, { matchId: MM.match.matchId, host: MM.match.host, hostAddr: MM.host?.addr ?? null, witness: MM.check.witness, wsAddr: MM.relay ?? MM.host?.wsAddr ?? null, beacon: MM.match.beacon, beaconSource: MM.match.beaconSource ?? null, participants: MM.match.participants, mode: MM.match.mode ?? null, buildHash: MM.match.buildHash ?? null, rulesetId: MM.match.rulesetId ?? MM.game.rulesetId ?? null }); }
  else if (t.dataset.lb) { lbTab = t.dataset.lb; render(); }
  else if (t.dataset.style) { styleFilter = t.dataset.style; render(); }
  else if (t.id === 'name-btn') setName();
  else if (t.id === 'air-btn' || t.id === 'air-link' || t.id === 'dash-lock-btn') signInWithAir();
  else if (t.id === 'me-chip' && air.configured() && player.kp && !Ai.me.session?.address) { e.preventDefault(); signInWithAir(); }
  else if (t.id === 'air-out') signOutAir();
  else if (t.id === 'avatar-btn') $('avatar-file').click();
});

// ═══════════════════════════════════════════════ play ══
// Shell → game: { type:'cabinet:init', version:1, player:{id,guest,name}, air:{id,email,address,tokenId,name}|null, node:{url,online}, game:{id,title},
//                 chain:{chainId, rpc, generation, contracts:{NodeDirectory:{address},NodeStake:{address},…}}   ← the CURRENT contract set: a title that discovers the mesh on its own takes these, never its own constants
//                 match?:{matchId, host, hostAddr, witness, wsAddr, beacon, beaconSource, participants, mode, buildHash, rulesetId} }   ← present when launched from a verified placement
// Game → shell: { type:'cabinet:hello' } (ask for init) · { type:'cabinet:exit' }
let current = null, currentMatch = null;
const frame = $('game');
const sendInit = () => { if (current && frame.contentWindow) frame.contentWindow.postMessage({ type: 'cabinet:init', version: 1, player: { id: player.id, guest: player.guest, name: player.name }, air: Ai.me.session?.address ? { id: Ai.me.id ?? null, email: Ai.me.email ?? null, address: Ai.me.session.address, tokenId: Ai.me.session.tokenId ?? null, name: Ai.me.session.name ?? null } : null, node: { url: nodeUrl(), online: S.online }, game: { id: current.id, title: current.title }, chain: { chainId: CHAIN.chainId, rpc: CHAIN.rpc, generation: CHAIN.generation, contracts: CONTRACTS.contracts }, ...(currentMatch ? { match: currentMatch } : {}) }, '*'); };
window.addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow || !e.data?.type) return;
  if (e.data.type === 'cabinet:hello') sendInit();
  if (e.data.type === 'cabinet:exit') exit();
  // The title played the placed match and handed back (agent-fighter after 21 Sep 2026): close the frame so the
  // next ranked match is placed here — a rematch inside the title would be a room no node placed.
  if (e.data.type === 'cabinet:played' && currentMatch && e.data.matchId === currentMatch.matchId) exit();
  // The title asks this shell to sign the ledger it just played (protocol 3):
  // the player key never leaves this origin. Signed only for the match this
  // shell launched, with the build it launched — a title cannot get a
  // signature over some other match or some other ruleset.
  if (e.data.type === 'cabinet:sign') {
    const b = e.data.body ?? {};
    const ok = currentMatch && player?.kp && b.matchId === currentMatch.matchId && (!currentMatch.buildHash || b.buildHash === currentMatch.buildHash)
      && typeof b.head === 'string' && Number.isInteger(b.ticks) && b.ticks > 0;
    if (!ok) { frame.contentWindow.postMessage({ type: 'cabinet:signed', matchId: b.matchId ?? null, error: 'not the match this shell launched' }, '*'); return; }
    const body = ledgerBody({ matchId: b.matchId, ticks: b.ticks, head: b.head, buildHash: currentMatch.buildHash ?? b.buildHash ?? null });
    const sig = await signLedger(body, player.kp);
    frame.contentWindow.postMessage({ type: 'cabinet:signed', matchId: b.matchId, player: player.id, sig }, '*');
  }
});
frame.addEventListener('load', sendInit);
/** Open a title. With `match` (from a verified placement) the title is told
 *  which relay to join: Agent Fighter's client takes the relay as ?ws=, and
 *  every title gets the full descriptor in cabinet:init. */
async function play(g, match = null) {
  if (!g.playable || !g.url) return;
  current = g; currentMatch = match;
  $('play').style.setProperty('--ga', g.accent);
  $('play-title').textContent = g.title;
  $('play-status').textContent = match ? `${g.badge} · match ${short(match.matchId, 10)} · host ${short(match.host, 10)}` : g.badge;
  const u = new URL(g.url);
  if (match) {
    // Every placed title gets the same launch (sdk/client.js parseLaunch):
    // the relay to join when the host fronts one, a friendly-room code keyed
    // on the mesh match (both placed players derive the same code), and the
    // key this match was placed under — a relay pins it into the ledger.
    if (match.wsAddr) u.searchParams.set('ws', match.wsAddr);
    u.searchParams.set('room', roomCodeFor(match.matchId));
    if (player.kp) u.searchParams.set('player', player.id);
    // What the title needs to ask this shell for a ledger signature at match
    // end (cabinet:sign → cabinet:signed): the mesh match and the build.
    u.searchParams.set('match', match.matchId);
    if (match.buildHash) u.searchParams.set('build', match.buildHash);
  }
  // Signed in with AIR → the title gets a one-time token in its URL and
  // opens already signed in (cabinet/air.js ssoUrl); otherwise the plain URL.
  frame.src = await air.ssoUrl(u.href);
  $('play').hidden = false;
}
function exit() { current = null; currentMatch = null; frame.src = 'about:blank'; $('play').hidden = true; }
$('play-exit').addEventListener('click', exit);
// Open the SAME url the frame has — with ?ws= ?room= ?player= when this is a
// placed match — never the bare title url, or the tab loses its relay.
$('play-tab').addEventListener('click', () => { if (current) window.open(frame.src && frame.src !== 'about:blank' ? frame.src : current.url, '_blank', 'noopener'); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) exit(); });

// ═══════════════════════════════════════════════ boot ══
const editNode = async () => { const v = await ask({ title: 'node', label: 'litnode URL', value: nodeUrl(), placeholder: 'https://…', hint: 'the node this cabinet talks to · blank = the directory picks one' }); if (v != null) { store('cabinet.nodeUrl', v.trim().replace(/\/$/, '') || undefined); pollNode(); } };
$('node-edit').addEventListener('click', editNode);

paintBackdrop($('bg'));
player = await loadPlayer();
renderChrome();
navigate();
refreshBinding().then(render);
// Read the directory now AND, when no local node answers, fall through to a
// proven seed at once. (Stamping seedsAt here used to make findSeed() wait
// a full minute: a visitor with no node saw NODE OFFLINE for 60 s.)
if (seeds.configured()) findSeed().then(render);
if (air.configured() && air.remembered()) air.rehydrate().then(() => { Ai.me = air.current(); render(); }).catch(() => {});
setInterval(() => refreshBinding().then(render), 60_000);
pollNode();
setInterval(pollNode, 5000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', () => { $('install-hint').hidden = false; });
