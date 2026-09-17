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
import { applyDelta, sortDeltas } from './protocol/derive.js';
import { NODE_URL, GAMES as CONFIG_GAMES } from './config.js';
import { CHARACTERS, STYLES, ITEMS, ITEM_LINES, PETS, RARITY, INVENTORY_SAMPLE, portraitUrl } from './roster.js';
import { identicon, fileToAvatar } from './avatar.js';
import { paintBackdrop } from './bg.js';
import { sample, loadHistory, slots, uptimePct, hoursOnline, fmtDuration, ring, strip, heatmap } from './uptime.js';
import { readStake } from './chain.js';
import * as wallet from './wallet.js';
import * as seeds from './seeds.js';
import { CHAIN } from './config.js';

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
    const d = t.display;
    GAMES.push({
      id: t.rulesetId.replace(/\.v\d+$/, ''), title: d.title, accent: d.accent ?? ACCENTS[GAMES.length % ACCENTS.length],
      tagline: d.description ?? 'Hosted on the mesh.', description: d.description ?? `A title hosted by ${t.hosts.length} node${t.hosts.length === 1 ? '' : 's'} on the litVM Games mesh.`,
      controls: d.controls ?? [], modes: t.modes ?? [], players: t.kind === 'attested' ? 'attested' : `${Array.isArray(t.participants) ? t.participants.join('/') : t.participants}P`,
      url: d.url ?? null, cover: d.cover ?? null, rulesetId: t.rulesetId, buildHash: t.buildHash,
      status: t.kind === 'attested' ? 'attested' : 'mesh', tags: ['MESH', ...(t.bondedHosts ? ['BONDED HOST'] : [])], badge: d.url ? new URL(d.url).host : 'mesh', playable: !!d.url, mesh: true,
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
const setName = () => { const v = prompt('Display name', player.name); if (v && v.trim()) { player.name = v.trim().slice(0, 24); store('cabinet.name', player.name); renderChrome(); render(); } };
$('avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try { player.avatar = await fileToAvatar(f); store('cabinet.avatar', player.avatar); renderChrome(); render(); } catch { /* ignore */ }
  e.target.value = '';
});

// ═══════════════════════════════════════════════ node state ══
const S = { online: false, checked: false, health: null, boards: {}, stats: {}, deltas: {}, peers: [], snapshot: null, uptime: {}, stake: null, seeds: [], seedsAt: 0, viaSeed: null };
/** No local node → read NodeDirectory and try the seeds. Runs at most once a minute. */
async function findSeed() {
  if (S.online || localStorage.getItem('cabinet.nodeUrl') || servedByNode() || !seeds.configured() || Date.now() - S.seedsAt < 60_000) return;
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
    if (polls % 5 === 1 && mergeMeshTitles((await api('/titles').catch(() => ({}))).titles)) render();
    S.snapshot = await api('/snapshot').catch(() => S.snapshot);
  } catch {
    // One slow answer is not an outage: flip to offline on the second miss.
    if (++misses >= 2) { S.online = false; S.health = null; findSeed().catch(() => {}); }
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
    out.push({ matchId: d.matchId, when: d.settledAt, res, opp, ticks: d.ticks ?? 0, rating: tables.rating[who] ?? 1200, mode: d.mode, cosigned: (d.cosigners?.length ?? 0) > 0, verification: d.verification ?? (d.cosigners?.length ? 'verified' : 'unverified'), official: !!d.official, attestation: d.attestation });
  }
  return out;
}
const myBoardRow = (rid) => (S.boards[rid] ?? []).find((r) => r.player === player.id) ?? null;
const ticksToHours = (t) => t / 60 / 3600;

// ═══════════════════════════════════════════════ chrome ══
function renderChrome() {
  $('me-avatar').src = player.avatar;
  $('me-name').textContent = player.name;
  const t = myTotals();
  const xp = t.wins * 60 + (t.matches - t.wins) * 20;
  $('me-level').textContent = `LV ${levelOf(xp).level}`;
  $('node-pill').classList.toggle('on', S.online);
  const h = S.health;
  $('node-text').textContent = S.online ? `${S.viaSeed && nodeUrl() === seedUrl ? 'SEED' : 'NODE'} ${h.bonded ? 'BONDED' : h.bonded === false ? 'UNBONDED' : 'ONLINE'} · ${h.peers} PEER${h.peers === 1 ? '' : 'S'}` : S.checked ? 'NODE OFFLINE' : 'CONNECTING…';
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
  const workCol = `
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
      <span class="tag projected">no rewards contract yet — nothing accrues; the bond is a cost of misbehaviour, not a yield</span>
    </div>`;
  return `<section class="panel hi s12"><div class="panel-h"><h3>Node uptime · mesh work</h3><span class="tag ${S.online ? 'live' : ''}">${S.online ? 'node online' : S.checked ? 'node offline' : 'connecting'}</span>${compact ? moreLink('#/node', 'node') : ''}</div>
    <div class="panel-b hi-grid"><div>${uptimeCol}</div><div>${workCol}</div><div>${rewardCol}</div></div></section>`;
}

// ═══════════════════════════════════════════════ pieces ══
const panel = (title, body, more = '', cls = '') => `<section class="panel ${cls}"><div class="panel-h"><h3>${title}</h3>${more}</div><div class="panel-b">${body}</div></section>`;
const moreLink = (href, label = 'view all') => `<a class="more" href="${href}">${label} ›</a>`;
const gameTag = () => '<span class="tag live">Live</span>';
/** What backs a result, in one word: verified (players signed + independent witness agreed), disputed, or unverified — and whether it counts. */
const verifyTag = (d) => d.verification === 'verified' ? `<span class="tag live" title="players signed, an independent witness reached the same result${d.official ? '; counts toward the official ladder' : ''}">verified${d.official ? '' : ' · unofficial'}</span>` : d.verification === 'disputed' ? '<span class="tag court" title="a witness recomputed a different result">disputed</span>' : `<span class="tag" title="${esc(d.attestation ?? '')}: not independently verified; not on the official ladder">unverified</span>`;
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

/** The wallet row under the key: bound → who owns it; unbound → sign in. */
function walletLine() {
  if (!wallet.configured()) return '';
  if (!player.kp) return '<div class="sub dim">No key on this page (insecure context), so nothing to bind.</div>';
  const b = Wl.binding;
  if (Wl.busy) return `<div class="sub">${esc(Wl.busy)}</div>`;
  if (b?.active) return `<div class="sub">profile <b>${esc(Wl.profile?.name ?? `#${b.tokenId}`)}</b> · wallet <span class="mono" title="${esc(b.owner)}">${b.owner.slice(0, 6)}…${b.owner.slice(-4)}</span></div>`;
  if (b && !b.active) return '<div class="sub" style="color:var(--bad,#ff7b8a)">this key was revoked by its profile owner — nodes refuse it</div>';
  if (!wallet.hasWallet()) return '<div class="sub dim">Install a wallet (MetaMask) to bind this key to a litVM Games profile.</div>';
  return `<div class="sub"><button class="btn sm" id="wallet-btn">Sign in with wallet</button> <span class="dim">one transaction: a soulbound profile owns this key</span>${Wl.error ? `<div class="dim">${esc(Wl.error)}</div>` : ''}</div>`;
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
      const name = prompt('Profile name (1–32 letters, digits, space _ . -)', player.name.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 32) || 'player');
      if (!name) { Wl.busy = ''; render(); return; }
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
          <table><thead><tr><th>Result</th><th>Opponent</th><th class="num">Length</th><th class="num">Rating</th><th>When</th></tr></thead><tbody>${hist.map((h) => `<tr><td class="res ${h.res[0]}">${h.res.toUpperCase()}</td><td>${h.opp.map((o) => short(o, 10)).join(', ') || '—'}</td><td class="num">${Math.floor(h.ticks / 3600)}:${String(Math.floor((h.ticks / 60) % 60)).padStart(2, '0')}</td><td class="num">${h.rating}</td><td class="dim">${h.when ? new Date(h.when).toLocaleDateString() : '—'} ${verifyTag(h)}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">No matches yet.</td></tr>'}</tbody></table>` : `<div class="empty">${S.online ? 'No settled matches under your key yet. Play one — it shows up here once the mesh settles it.' : 'Start a node to load your record.'}</div>`)}
      </div>
    </div>`;
  if (g.rulesetId) renderMatchmaking(g);
}

// ═══════════════════════════════════════════════ matchmaking ══
// The point of the design (client.js): sign a queue entry, wait for the pair,
// recompute placement from a snapshot this page can hash, and refuse a host
// the rule did not produce. The node is a directory, never an authority.
const MM = { state: 'idle', game: null, text: '', match: null, check: null, host: null, waitedMs: 0 };
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
      <div class="hero-actions">${c.ok ? (MM.host?.wsAddr ? '<button class="btn primary" data-mm-launch>Launch on this host</button>' : `<span class="dim">host ${short(m.host ?? '', 12)} advertises no relay (wsAddr) — placed, not playable from here</span>`) : '<span class="dim">not launching against a host the rule did not produce</span>'}<button class="btn" data-mm-reset>Clear</button></div>
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
    Object.assign(MM, { state: 'placed', match: r.match, check: r.check, host: r.snapshot.peers.find((p) => p.nodeId === r.match.host) ?? null, waitedMs: r.waitedMs });
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
function renderNode() {
  const h = S.health;
  const status = h ? `<dl class="kv">
      <dt>node id</dt><dd title="${esc(h.nodeId)}">${esc(h.nodeId)}</dd><dt>operator</dt><dd>${esc(h.operator)}</dd><dt>roles</dt><dd>${esc(h.roles.join(', '))}</dd><dt>region</dt><dd>${esc(h.region)}</dd>
      <dt>address</dt><dd>${esc(h.addr)}</dd><dt>bonded</dt><dd>${h.bonded === null ? 'unknown (offline / no stake contract)' : h.bonded ? 'yes' : 'no — run tools/bond-node.mjs'}</dd>
      <dt>tunnel</dt><dd>${h.tunnel?.node ? `${esc(h.tunnel.node.mode)} · ${esc(h.tunnel.node.state)}${h.tunnel.node.url ? ` · ${esc(h.tunnel.node.url)}` : ''}${h.tunnel.node.lastError ? ` · ${esc(h.tunnel.node.lastError)}` : ''}` : 'none — LAN address only'}</dd>
      <dt>relay</dt><dd>${h.wsAddr ? `${esc(h.wsAddr)}${h.tunnel?.relay ? ` (${esc(h.tunnel.relay.state)})` : ''}` : 'none advertised'}</dd>
      <dt>version</dt><dd>${esc(h.version ?? '?')}${h.update?.available ? ` — <b>${esc(h.update.latest)} available</b>` : h.update?.checkedAt ? ' — up to date' : ''}${h.update?.lastError ? ` <span class="dim">(check failed: ${esc(h.update.lastError)})</span>` : ''}</dd>
      <dt>reachable</dt><dd>${h.inbound ? (h.inbound.reachable === null ? 'no peers known yet' : h.inbound.reachable ? `yes — ${h.inbound.peers} peer${h.inbound.peers === 1 ? '' : 's'} push gossip to this node` : `no peer has reached this node in 30 s — fine for a witness; a seed, LAN host or relay needs allow-firewall.cmd or a tunnel`) : '—'}</dd>
      <dt>epoch</dt><dd>${h.epoch}</dd><dt>chain</dt><dd>${h.chain.offline ? 'offline beacon' : `${esc(h.chain.rpc)} · block ${h.chain.head ?? '?'}`}${h.chain.lastError ? ` · ${esc(h.chain.lastError)}` : ''}</dd>
      <dt>rulesets</dt><dd>${Object.entries(h.rulesets).map(([k, v]) => `${esc(k)} @ ${v.slice(0, 10)}`).join(', ')}</dd><dt>builds held</dt><dd>${h.buildsHeld}</dd>
    </dl>` : `<div class="empty">No node at <span class="mono">${esc(nodeUrl())}</span>. Start one below, or <button class="link" id="node-edit2">point the cabinet at another node</button>.</div>`;
  const peers = S.peers.length ? `<table><thead><tr><th>Node</th><th>Operator</th><th>Region</th><th>Roles</th><th>Fresh</th><th>Bonded</th><th>Rulesets</th></tr></thead><tbody>${S.peers.map((p) => `<tr><td class="mono" title="${esc(p.nodeId)}">${short(p.nodeId, 12)}</td><td>${esc(p.operator)}</td><td>${esc(p.region)}</td><td class="dim">${esc(p.roles.join(','))}</td><td>${p.fresh ? '<span class="res w">●</span>' : '<span class="res l">●</span>'}</td><td>${p.bonded === null ? '—' : p.bonded ? 'yes' : 'no'}</td><td class="dim">${esc(p.rulesets.join(', '))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No peers known.</div>';
  view('node').innerHTML = `<div class="page-h"><h1 class="chrome">Nodes</h1><span class="dim">run a node while you play — it verifies and witnesses matches for the mesh</span></div>
    <div class="home">
      ${nodePanel({ compact: false })}
      ${panel('7-day uptime', `${heatmap(S.uptime)}<div class="legend"><i class="up"></i>up <i class="partial"></i>partial <i class="down"></i>down <i class="none"></i>dashboard closed</div><div class="source">Observed by this dashboard while it is open, 10-minute resolution, stored locally per node URL. The node's own process uptime is the "process up" figure above.</div>`, '', 's6')}
      ${panel('Mesh work', `<table><thead><tr><th>Source</th><th class="num">Yours</th><th>Counted from</th></tr></thead><tbody>
          <tr><td>Match settled as host</td><td class="num">${nodeWork().settled}</td><td class="dim">deltas with hostId = this node</td></tr>
          <tr><td>Witness co-signature</td><td class="num">${nodeWork().cosigned}</td><td class="dim">deltas listing this node in cosigners</td></tr>
          <tr><td>Hours observed up</td><td class="num">${fmtTok(hoursOnline(S.uptime, 7 * 24 * 6))} h</td><td class="dim">this dashboard, while open — not a mesh figure</td></tr>
        </tbody></table><div class="source">There is no rewards contract on litVM; nothing accrues. Bond and wallet figures are read live from ${esc(CHAIN.name)} (chain ${CHAIN.chainId}); NodeStake ${CHAIN.NodeStake.slice(0, 10)}…</div>`, '', 's6')}
      ${panel('This node', status, h?.update?.available ? (isLoopbackNode() ? '<button class="btn sm primary" id="update-btn">Update node</button>' : '<span class="dim">update from the node\'s own machine</span>') : '', 's6')}
      ${panel('Run a node', `<p>The arcade is a peer network: this page talks to the mesh through a node on <b>your</b> machine, the way a torrent client is the peer. Every node verifies and witnesses matches for everyone.</p><ol class="steps">
          <li><a class="link" href="${RELEASES}" target="_blank" rel="noopener">Download the latest release</a> — the <span class="mono">-win-x64</span> zip carries its own runtime; nothing to install. Releases are signed; the node checks the signature on every update.</li>
          <li>Unzip anywhere. Double-click <span class="mono">start-node.cmd</span>. Give it a name and the seed URL of a node that is already running.</li>
          <li>Reload this page: the header turns green and your key appears on the ladders once you play. Keep the window open — it is your peer.</li>
          <li>Only if others must reach you (a seed, a LAN host): <span class="mono">allow-firewall.cmd</span> once. A node that only reaches outward needs nothing.</li>
          <li>To host and witness ranked matches, bond the node's key from the operator wallet: <span class="mono">npm run bond -- &lt;nodeId&gt;</span>. Until then it plays and verifies as a guest peer.</li></ol>`, '', 's6')}
      ${panel('Seeds on chain', seeds.configured() ? (S.seeds.length ? `<table><thead><tr><th>Operator</th><th>Node</th><th>Address</th><th>Relay</th><th>Announced</th></tr></thead><tbody>${S.seeds.map((s) => `<tr><td class="mono">${s.operator.slice(0, 6)}…${s.operator.slice(-4)}</td><td class="mono" title="${esc(s.nodeId)}">${short(s.nodeId, 12)}</td><td class="mono">${esc(s.url)}</td><td class="mono dim">${esc(s.wsAddr ?? '—')}</td><td class="dim">${new Date(s.updatedAt * 1000).toLocaleString()}</td></tr>`).join('')}</tbody></table><div class="source">Read from NodeDirectory on ${esc(CHAIN.name)}: bonded nodes that announced an address in the last 7 days. ${S.viaSeed ? `This page is reading the mesh through ${esc(S.viaSeed.url)}.` : 'Your own node comes first; these are the fallback.'}</div>` : '<div class="empty">No seed has announced yet, or the chain is unreachable. <button class="link" id="seeds-refresh">Read again</button></div>') : '<div class="empty">NodeDirectory is not configured in this build (config.js CHAIN.NodeDirectory).</div>', '', 's12')}
      ${panel('Peers', peers, '', 's12')}
    </div>`;
  $('node-edit2')?.addEventListener('click', editNode);
  $('update-btn')?.addEventListener('click', updateNode);
  $('seeds-refresh')?.addEventListener('click', () => { S.seedsAt = 0; findSeed().then(render); });
}

// ═══════════════════════════════════════════════ router ══
let route = { name: 'home' };
function parseRoute() {
  const h = location.hash;
  const m = h.match(/^#\/game\/([\w-]+)/);
  if (m) { const g = GAMES.find((x) => x.id === m[1]); return g ? { name: 'game', game: g } : { name: 'games' }; }
  const name = (h.match(/^#\/(\w+)/)?.[1]) ?? 'home';
  return ['games', 'leaderboards', 'characters', 'inventory', 'node'].includes(name) ? { name } : { name: 'home' };
}
function render() {
  switch (route.name) {
    case 'home': renderHome(); break;
    case 'games': renderGames(); break;
    case 'game': renderGame(route.game); break;
    case 'leaderboards': renderLeaderboards(); break;
    case 'characters': renderCharacters(); break;
    case 'inventory': renderInventory(); break;
    case 'node': renderNode(); break;
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
  const t = e.target.closest('[data-play],[data-queue],[data-mm-stop],[data-mm-reset],[data-mm-launch],[data-lb],[data-style],#name-btn,#avatar-btn,#wallet-btn');
  if (!t) return;
  if (t.id === 'wallet-btn') { signInWithWallet(); return; }
  if (t.dataset.play) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.play); if (g) play(g); }
  else if (t.dataset.queue) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.queue); if (g) findMatch(g); }
  else if ('mmStop' in t.dataset || 'mmReset' in t.dataset) stopMatchmaking();
  else if ('mmLaunch' in t.dataset) { if (MM.game && MM.check?.ok) play(MM.game, { matchId: MM.match.matchId, host: MM.match.host, witness: MM.check.witness, wsAddr: MM.host?.wsAddr ?? null, beacon: MM.match.beacon, participants: MM.match.participants }); }
  else if (t.dataset.lb) { lbTab = t.dataset.lb; render(); }
  else if (t.dataset.style) { styleFilter = t.dataset.style; render(); }
  else if (t.id === 'name-btn') setName();
  else if (t.id === 'avatar-btn') $('avatar-file').click();
});

// ═══════════════════════════════════════════════ play ══
// Shell → game: { type:'cabinet:init', version:1, player:{id,guest,name}, node:{url,online}, game:{id,title},
//                 match?:{matchId, host, witness, wsAddr, beacon, participants} }   ← present when launched from a verified placement
// Game → shell: { type:'cabinet:hello' } (ask for init) · { type:'cabinet:exit' }
let current = null, currentMatch = null;
const frame = $('game');
const sendInit = () => { if (current && frame.contentWindow) frame.contentWindow.postMessage({ type: 'cabinet:init', version: 1, player: { id: player.id, guest: player.guest, name: player.name }, node: { url: nodeUrl(), online: S.online }, game: { id: current.id, title: current.title }, ...(currentMatch ? { match: currentMatch } : {}) }, '*'); };
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || !e.data?.type) return;
  if (e.data.type === 'cabinet:hello') sendInit();
  if (e.data.type === 'cabinet:exit') exit();
});
frame.addEventListener('load', sendInit);
/** Open a title. With `match` (from a verified placement) the title is told
 *  which relay to join: Agent Fighter's client takes the relay as ?ws=, and
 *  every title gets the full descriptor in cabinet:init. */
function play(g, match = null) {
  if (!g.playable || !g.url) return;
  current = g; currentMatch = match;
  $('play').style.setProperty('--ga', g.accent);
  $('play-title').textContent = g.title;
  $('play-status').textContent = match ? `${g.badge} · match ${short(match.matchId, 10)} · host ${short(match.host, 10)}` : g.badge;
  const u = new URL(g.url);
  if (match?.wsAddr && g.id === 'agent-fighter') {
    // Agent Fighter: relay override, friendly-room rendezvous keyed on the
    // mesh match (both placed players derive the same code), and the key
    // this match was placed under — the relay pins it into the ledger.
    u.searchParams.set('ws', match.wsAddr);
    u.searchParams.set('room', roomCodeFor(match.matchId));
    if (player.kp) u.searchParams.set('player', player.id);
  }
  frame.src = u.href;
  $('play').hidden = false;
}
function exit() { current = null; currentMatch = null; frame.src = 'about:blank'; $('play').hidden = true; }
$('play-exit').addEventListener('click', exit);
// Open the SAME url the frame has — with ?ws= ?room= ?player= when this is a
// placed match — never the bare title url, or the tab loses its relay.
$('play-tab').addEventListener('click', () => { if (current) window.open(frame.src && frame.src !== 'about:blank' ? frame.src : current.url, '_blank', 'noopener'); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) exit(); });

// ═══════════════════════════════════════════════ boot ══
const editNode = () => { const v = prompt('litnode URL', nodeUrl()); if (v != null) { store('cabinet.nodeUrl', v.trim().replace(/\/$/, '') || undefined); pollNode(); } };
$('node-edit').addEventListener('click', editNode);

paintBackdrop($('bg'));
player = await loadPlayer();
renderChrome();
navigate();
refreshBinding().then(render);
if (seeds.configured()) seeds.chainSeeds().then((s) => { S.seeds = s; S.seedsAt = Date.now(); render(); });
setInterval(() => refreshBinding().then(render), 60_000);
pollNode();
setInterval(pollNode, 5000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', () => { $('install-hint').hidden = false; });
