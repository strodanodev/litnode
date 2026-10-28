/** litnode arcade — gamer dashboard in front of a litnode.
 *
 *  No build step, no dependencies. Views: home (dashboard), games, one game,
 *  leaderboards, cards, node, build; plus a fullscreen play overlay.
 *
 *  What is real vs. placeholder:
 *    real   — node status, leaderboards, per-player stats, match history and
 *             the rating curve (all derived from the node's settled deltas),
 *             the player key (the node's own ed25519 module).
 *    sample — which cards (fighters, items, pets) the player holds, tickets:
 *             account data that arrives with the Agent Fighter sync. Labelled "sample". */
import { loadPlayer as loadKeypair, createClient, IDENTITY_KEY } from './client.js';
import { roomCodeFor } from './protocol/pairing.js';
import { chainHead, ledgerBody, signLedger } from './protocol/log.js';
import { signSeat, signKeyProof, NONCE_RE, AUD_RE } from './protocol/challenge.js';
import { sign as signTagged } from './protocol/keys.js';
const RUN_TAG = 'run'; // sdk/court RUN_TAG: a player's signature over a single-player run
import { applyDelta, sortDeltas } from './protocol/derive.js';
import { levelOf as levelFromXp } from './protocol/progression.js';
import { NODE_URL, GAMES as CONFIG_GAMES } from './config.js';
import { deck, KINDS, COLLECTION_SAMPLE } from './roster.js';
import { identicon, fileToAvatar } from './avatar.js';
import { paintBackdrop } from './bg.js';
import { sample, slots, uptimePct, fmtDuration, ring, strip, heatmap } from './uptime.js';
import { readStake } from './chain.js';
import { rankedCapacity } from './quorum.js';
import * as wallet from './wallet.js';
import * as air from './air.js';
import * as nodeops from './nodeops.js';
import * as seeds from './seeds.js';
import { CHAIN } from './config.js';
import { CABINET_VERSION } from './version.js';
import { CONTRACTS } from './contracts.js';
import { readFleet, describeEvent, checklist as fleetChecklist, ago } from './fleet.js';
import { arcadeBanner, downloadPage } from './download.js';
import { renderBuild } from './build.js';
import * as ro3 from './ro3.js';
import { loadReceipt, renderReceipt } from './receipt.js';

const $ = (id) => document.getElementById(id);
const view = (name) => document.querySelector(`.view[data-view="${name}"]`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Every id the node or a peer hands us goes through esc(): a player id, a host id, an opponent is a string a
// bonded stranger chose, and the player's key lives in this origin's storage (audit of 21 Oct 2026).
const short = (id, n = 10) => (id ? `${esc(String(id).slice(0, n))}…` : '—');
const safeAccent = (c, fallback) => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d.,%\s/]+\))$/i.test(c.trim()) ? c.trim() : fallback);
const safeHttpUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
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
    // A manifest's display block is a peer's word. The accent lands in a style attribute, the url and cover in
    // href and url('…'): each is checked against the shape it must have, never trusted to be one.
    if (typeof t.rulesetId !== 'string' || !/^[\w.-]{1,64}$/.test(t.rulesetId)) continue;
    const d = t.display;
    const url = safeHttpUrl(d.url), cover = safeHttpUrl(d.cover);
    const hosts = Array.isArray(t.hosts) ? t.hosts.length : 0;
    GAMES.push({
      id: t.rulesetId.replace(/\.v\d+$/, ''), title: String(d.title), accent: safeAccent(d.accent, ACCENTS[GAMES.length % ACCENTS.length]),
      tagline: typeof d.description === 'string' ? d.description : 'Hosted on the mesh.', description: typeof d.description === 'string' ? d.description : `A title hosted by ${hosts} node${hosts === 1 ? '' : 's'} on the litVM Games mesh.`,
      controls: Array.isArray(d.controls) ? d.controls.map(String) : [], modes: Array.isArray(t.modes) ? t.modes.map(String) : [], players: t.kind === 'attested' ? 'attested' : `${Array.isArray(t.participants) ? t.participants.join('/') : t.participants}P`,
      url, cover, rulesetId: t.rulesetId, buildHash: t.buildHash,
      kind: t.kind === 'attested' ? 'attested' : 'replayable', status: t.kind === 'attested' ? 'attested' : 'mesh', tags: ['MESH', ...(t.published ? ['PUBLISHED'] : t.bondedHosts ? ['BONDED HOST'] : [])], badge: url ? new URL(url).host : 'mesh', playable: !!url, mesh: true,
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
const S = { online: false, checked: false, health: null, boards: {}, stats: {}, progress: {}, deltas: {}, peers: [], snapshot: null, uptime: {}, stake: null, seeds: [], seedsAt: 0, viaSeed: null, titles: [], fleet: null, fleetError: null, fleetAt: 0 };
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
      // An attested title (a court's reports, never official) has no official ladder by construction: show its own, labelled (docs/SETTLEMENT-STANDARD.md §4).
      const [lb, st, ds, pg] = await Promise.all([api(`/leaderboard?ruleset=${rid}${g.status === 'attested' ? '&scope=all' : ''}`).catch(() => ({})), api(`/stats?ruleset=${rid}${g.status === 'attested' ? '&scope=all' : ''}`).catch(() => ({})), wantDeltas ? api(`/deltas?ruleset=${rid}`).catch(() => null) : null,
        player?.id ? api(`/progress?ruleset=${rid}&player=${player.id}`).catch(() => null) : null]);
      S.boards[g.rulesetId] = lb.leaderboard ?? [];
      S.stats[g.rulesetId] = st && !st.error ? st : {};
      // XP, level and streak, folded by the node from results final on chain (protocol/progression.js); a node
      // older than 0.11.21 has no /progress and the profile falls back to its own estimate.
      S.progress[g.rulesetId] = pg && !pg.error && typeof pg.level === 'number' ? pg : null;
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
/** AF's real XP rules (protocol/progression.js, the node's own fold): win 60 / loss 20 / draw 30;
 *  xp_for_next(level) = 80 + level·45; cap 40. */
function levelOf(xp) { const l = levelFromXp(xp); return { level: l.level, xp: l.xp, next: l.xpForNext ?? l.xp }; }
/** The node's progression line for a title, as the profile shows it (level, XP into it, XP to the next). */
const progressLine = (rid) => { const p = rid ? S.progress[rid] : null; return p ? { level: p.level, xp: p.xp, next: p.xpForNext ?? p.xp, streak: p.streak, p } : null; };
/** A title's level bar for "Your record": the node's progression, with the win streak when there is one. */
const recordXp = (rid) => {
  const P = progressLine(rid);
  if (!P) return '';
  const streak = P.streak > 1 ? ` · ${P.streak} WIN STREAK` : '';
  return `<div class="xp" style="margin:0 0 12px" title="folded by the node from results final on chain"><div class="row"><span>LEVEL ${P.level}${streak}</span><span>${P.p.xpForNext ? `${P.xp} / ${P.next} XP` : `${P.xp} XP · MAX LEVEL`}</span></div><div class="bar"><i style="width:${P.p.xpForNext ? pct(P.xp, P.next) : 100}%"></i></div></div>`;
};

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
    out.push({ matchId: d.matchId, when: d.settledAt, res, opp, ticks: d.ticks ?? 0, rating: tables.rating[who] ?? 1200, mode: d.mode, proof: matchProof(d), cosigned: (d.cosigners?.length ?? 0) > 0, verification: d.verification ?? (d.cosigners?.length ? 'verified' : 'unverified'), official: !!d.official, attestation: d.attestation, chain: d.chain ?? null });
  }
  return out;
}
const myBoardRow = (rid) => ladderRows(rid).find((r) => r.player === player.id) ?? null;
const ticksToHours = (t) => t / 60 / 3600;

// Settlement v4: each title declares its own match stats (services.stats.schema), folded by the node into the /stats
// lines. The names below get a label; any other title's names show humanized.
const STAT_LABEL = { kos: 'KOs', roundsWon: 'Rounds won', perfectRounds: 'Perfect rounds', damageDealt: 'Damage dealt', maxCombo: 'Best combo', supersLanded: 'Supers landed', throwTechs: 'Throw techs', fastestKo: 'Fastest KO',
  pointsWon: 'Points won', aces: 'Aces', winners: 'Winners', unforcedErrors: 'Unforced errors', smashes: 'Smashes', dinks: 'Dinks', longestRally: 'Longest rally', matchesMvp: 'MVP',
  points: 'Best score', stars: 'Stars', rescued: 'Rescued', casualties: 'Casualties', bestChain: 'Best chain', keptDry: 'Kept dry', stormsSurvived: 'Storms survived' };
/** Where only a few fit (profile, ranks columns) these lead, in schema order, then the rest. */
const STAT_HEAD = new Set(['kos', 'perfectRounds', 'maxCombo', 'fastestKo', 'aces', 'winners', 'longestRally', 'matchesMvp', 'points', 'rescued', 'bestChain', 'stormsSurvived']);
const statNames = (rid, n = Infinity) => { const all = Object.keys(S.snapshot?.manifests?.[rid]?.services?.stats?.schema ?? {}); return [...all.filter((k) => STAT_HEAD.has(k)), ...all.filter((k) => !STAT_HEAD.has(k))].slice(0, n); };
const statLabel = (k) => STAT_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const hasTitleStats = (rid, line) => !!line && statNames(rid).some((k) => line[k] != null);
/** A stat as shown: fastestKo is engine ticks (60/s); keptDry is a percent summed over runs, shown per run. */
function statValue(k, line) {
  const v = line?.[k];
  if (typeof v !== 'number') return '—';
  if (k === 'fastestKo') return `${(v / 60).toFixed(1)}<small>s</small>`;
  if (k === 'keptDry') return `${line.matches ? Math.round(v / line.matches) : 0}<small>% avg</small>`;
  return v.toLocaleString();
}
const statTiles = (rid, line, n) => `<div class="tstats">${statNames(rid, n).map((k) => `<div class="stat"><div class="k">${esc(statLabel(k))}</div><div class="v">${statValue(k, line)}</div></div>`).join('')}</div>`;
/** The profile's per-title block: each title's own stats under my key; titles with none are left out. */
function titleStats() {
  const rows = GAMES.filter((g) => g.rulesetId && hasTitleStats(g.rulesetId, S.stats[g.rulesetId]?.[player.id]));
  if (!rows.length) return '';
  return `<div class="section-h"><h4>Per title</h4></div>${rows.map((g) => { const line = S.stats[g.rulesetId][player.id]; return `<a class="tline" href="#/game/${g.id}"><div class="tt">${esc(g.title)}<span>${line.matches} match${line.matches === 1 ? '' : 'es'} ›</span></div>${statTiles(g.rulesetId, line, 4)}</a>`; }).join('')}`;
}

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

/** The status band (Home and Nodes): uptime · mesh work · on chain. No reward figure: nothing pays yet, and a
 *  number nothing can pay is a claim (BUILD-SPEC honest zeroes). Work counters are real: the hot key's own sends
 *  from the signed /fleet, and the settled deltas any node can reproduce. */
function nodePanel({ compact = true } = {}) {
  const h = S.health;
  const u24 = uptimePct(S.uptime, 24 * 6), u7 = uptimePct(S.uptime, 7 * 24 * 6);
  const rw = nodeWork();
  const fresh = S.peers.filter((p) => p.fresh).length;
  const bonded = S.stake?.bonded ?? h?.bonded ?? null;
  const purse = S.fleet?.chain?.matchBook?.purse ?? null;
  const since = S.online && h.startedAt ? new Date(h.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const uptimeCol = `
    <div class="up-ring">${ring(u24.pct, { color: S.online ? '#7ef0a8' : '#ff7b8a', label: '24H UPTIME', sub: u24.observedSlots ? `${u24.observedSlots} × 10 min seen` : 'unobserved' })}</div>
    <div class="up-meta">
      <div class="kv2"><span class="k">Up</span><span class="v" title="${since ? `since ${esc(since)}` : ''}">${S.online ? fmtDuration(h.uptimeMs) : '—'}</span></div>
      <div class="kv2"><span class="k">7 days</span><span class="v">${u7.pct == null ? '—' : `${u7.pct.toFixed(1)}%`}</span></div>
      <div class="kv2"><span class="k">Peers</span><span class="v">${S.online ? `${fresh}/${S.peers.length} fresh` : '—'}</span></div>
    </div>
    ${strip(slots(S.uptime, 24 * 6))}
    <div class="legend"><i class="up"></i>up <i class="partial"></i>partial <i class="down"></i>down <i class="none"></i>unobserved</div>`;
  const sent = S.fleet?.chain?.matchBook?.sent ?? null;
  const count = (what) => sent.filter((x) => x.what === what && x.ok !== false).length;
  const workCol = `<div class="col-k">Mesh work</div>${sent ? `
    <div class="work">
      <div class="stat"><div class="k">Commits · host</div><div class="v">${count('commit')}</div></div>
      <div class="stat"><div class="k">Attests · witness</div><div class="v">${count('attest')}</div></div>
      <div class="stat"><div class="k">Settles · finals</div><div class="v">${count('settle')}<small>· ${count('finalize')}</small></div></div>
      <div class="stat"><div class="k">Backstops · anchors</div><div class="v">${count('expire') + count('escalate') + count('resolve')}<small>· ${count('propose')}</small></div></div>
    </div>
    <div class="source">Sent by the hot key since start. Settled matches: ${rw.settled} hosted, ${rw.cosigned} witnessed.</div>` : `
    <div class="work">
      <div class="stat"><div class="k">Hosted</div><div class="v">${rw.settled}</div></div>
      <div class="stat"><div class="k">Witnessed</div><div class="v">${rw.cosigned}</div></div>
      <div class="stat"><div class="k">Bond</div><div class="v">${bonded === null ? '—' : bonded ? 'Active' : 'None'}</div></div>
      <div class="stat"><div class="k">Roles</div><div class="v small">${S.online ? esc(h.roles.join(' · ')) : '—'}</div></div>
    </div>
    <div class="source">${S.online ? `Last work: ${rw.latest ? new Date(rw.latest).toLocaleString() : 'none yet'}.` : 'Start the node to count work.'}</div>`}`;
  const chainCol = `<div class="col-k">On chain · ${esc(CHAIN.name)}</div>
    <div class="big-tok"><span class="chrome">${S.stake?.amount != null ? fmtTok(S.stake.amount) : '—'}</span><span class="tok">${CHAIN.token} bonded</span></div>
    <div class="onchain">
      <div class="kv2"><span class="k">Wallet</span><span class="v">${S.stake?.balance != null ? `${fmtTok(S.stake.balance)} ${CHAIN.token}` : '—'}</span></div>
      ${purse ? `<div class="kv2"><span class="k">Hot-key gas</span><span class="v${purse.low ? ' bad' : ''}">${purse.balance != null ? `${Number(purse.balance).toFixed(4)} zkLTC${purse.matchesLeft != null ? ` · ~${purse.matchesLeft} matches` : ''}` : '—'}</span></div>` : ''}
      <div class="kv2"><span class="k">Operator</span><span class="v mono" title="${esc(S.stake?.operator ?? '')}">${S.stake?.bonded && S.stake.operator ? `${S.stake.operator.slice(0, 6)}…${S.stake.operator.slice(-4)}` : '—'}</span></div>
    </div>
    <div class="source">Nothing is paid yet: the bond is collateral, not yield.</div>`;
  return `<section class="panel hi s12"><div class="panel-h"><h3>Node status</h3><span class="tag ${S.online ? 'live' : ''}">${S.online ? 'online' : S.checked ? 'offline' : 'connecting'}</span>${compact ? moreLink('#/node', 'details') : ''}</div>
    <div class="panel-b hi-grid"><div>${uptimeCol}</div><div>${workCol}</div><div>${chainCol}</div></div></section>`;
}

// ═══════════════════════════════════════════════ pieces ══
const panel = (title, body, more = '', cls = '') => `<section class="panel ${cls}"><div class="panel-h"><h3>${title}</h3>${more}</div><div class="panel-b">${body}</div></section>`;
const moreLink = (href, label = 'view all') => `<a class="more" href="${href}">${label} ›</a>`;
/** Settlement v4 proof levels, one word each, with what a reader should take from it (docs/SETTLEMENT-STANDARD.md §2). */
const PROOF = {
  verified: ['proof live', 'L3 verified: independent nodes replayed the player-signed input log. Ranked results count on the official ladder.'],
  checkable: ['proof checkable', "L2 checkable: an authorized court replayed it, the mesh holds the log, and the title's verifier is registered on litVM — anyone can re-run it."],
  attested: ['proof court', "L1 attested: an authorized court signed the report and the node checked it against the title's rules. Not re-run by anyone."],
  host: ['proof', "L0 host: one node's word. Casual only; never counts."],
};
const proofTag = (level) => (PROOF[level] ? `<span class="tag ${PROOF[level][0]}" title="${esc(PROOF[level][1])}">${level}</span>` : '');
/** A result's level: the delta's own `proof` (protocol 4), else what its provenance supported (protocol 3). */
const matchProof = (d) => d.proof ?? ({ players: 'verified', relay: 'checkable', attested: 'attested' }[d.attestation] ?? 'host');
/** The best level a title's results reach: a replayable title's are verified; an attested one's are attested, or
 *  checkable once one of its results here was (the court commits its log and its verifier is registered). */
const titleProof = (g) => {
  if (!g.rulesetId) return null;
  if ((g.kind ?? (g.status === 'attested' ? 'attested' : 'replayable')) === 'replayable') return 'verified';
  return (S.deltas[g.rulesetId] ?? []).some((d) => d.proof === 'checkable') ? 'checkable' : 'attested';
};
/** A title is "on the mesh" only with a ruleset a node runs; anything else is hosted by its studio and says so. */
const gameTag = (g) => (g?.rulesetId ? proofTag(titleProof(g)) : '<span class="tag" title="Played at the studio\'s own site; no node settles its matches yet.">not on the mesh</span>');
const settledBy = (g) => ({ verified: 'replay of the player-signed input log (L3 verified)', checkable: "the court's replay, log held by the mesh, verifier registered (L2 checkable)", attested: "the court's signed report, checked against the rules (L1 attested)" }[titleProof(g)] ?? 'not on the mesh yet');
/** What backs a result, in one word: verified (players signed + independent witness agreed), disputed, or unverified — and whether it counts. */
const verifyTag = (d) => d.chain === 'final' ? '<span class="tag live" title="finalized on chain: committed before play, settled by the host, attested by three witnesses; counts toward the official ladder">final on chain</span>' : d.chain === 'void' ? '<span class="tag court" title="voided on chain: the witnesses disagreed, or the host never settled">voided</span>' : d.chain && d.chain !== 'none' ? `<span class="tag" title="on chain, ${esc(d.chain)}: attestations still arriving">on chain · ${esc(d.chain)}</span>` : d.verification === 'verified' ? `<span class="tag live" title="players signed, an independent witness reached the same result${d.official ? '; counts toward the official ladder' : ''}">verified${d.official ? '' : ' · unofficial'}</span>` : d.verification === 'disputed' ? '<span class="tag court" title="a witness recomputed a different result">disputed</span>' : `<span class="tag" title="${esc(d.attestation ?? '')}: not independently verified; not on the official ladder">unverified</span>`;
const statusTag = (g) => g.status === 'attested' ? '<span class="tag court">Court</span>' : g.status === 'external' ? '<span class="tag hosted">Hosted</span>' : g.status === 'mesh' ? '<span class="tag hosted">Mesh</span>' : g.status === 'community' ? '<span class="tag hosted" title="Run by their hosts on the LITNODE mesh; not settled">Community servers</span>' : '';
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
// The hosted page is a front door: this browser talks to the mesh through a
// node on THIS machine (https → http://localhost is allowed). No node → say
// how to get one; the signed release is the download.
const RELEASES = 'https://github.com/strodanodev/litnode/releases/latest';
// docs/OPERATORS.md: the one step-by-step page for a new operator (install, wallet bonding, troubleshooting).
const OPERATOR_GUIDE = 'https://github.com/strodanodev/litnode/blob/master/docs/OPERATORS.md';
const nodeHint = () => (S.online ? '' : !S.checked ? '<div class="empty">Connecting to the node…</div>' : `<div class="empty">No node on this machine. <a class="link" href="#/download">Download the Control Plane</a> (Windows), run it, reload. <a class="link" href="#/node">Details ›</a></div>`);

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
    pushAir();   // a title waiting on this sign-in can go on now; the litVM profile below can take a while
    if (!S.online) throw new Error('no node to ask — the profile is minted by your node (or the seed)');
    Ai.busy = 'your node is setting up your litVM profile (first time: three transactions)…'; render();
    Ai.me.session = await air.nodeSession(nodeUrl(), { playerKey: player.id, name: player.name.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 32) || null });
    if (Ai.me.session.name && !load('cabinet.name')) { player.name = Ai.me.session.name; renderChrome(); }
    await refreshBinding();
  } catch (e) { Ai.error = e?.message ?? String(e); }
  Ai.busy = ''; render();
}
async function signOutAir() { Ai.busy = 'signing out…'; render(); await air.logout(); Ai.me = air.current(); Ai.busy = ''; render(); pushAir(); }

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
  // The node's fold of results final on chain; an old node without /progress: the estimate from /stats.
  const L = progressLine(PRIMARY.rulesetId) ?? levelOf(t.wins * 60 + (t.matches - t.wins) * 20);
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
      <a class="big" href="#/cards"><div class="icon">▣</div><div><div class="k">Cards</div><div class="v">${DECK.filter((c) => c.held).length}<small> / ${DECK.length} sample</small></div></div></a>
    </div>
    ${titleStats()}
    <div class="source">${S.online ? `Derived from ${t.matches} settled match${t.matches === 1 ? '' : 'es'} on the mesh. Account XP and cards sync with Agent Fighter.` : 'Start a node to load your mesh record.'}</div>
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
      <div style="min-width:0"><div class="t">${esc(g.title)}${g.trademark === false ? '' : '<sup>™</sup>'}</div><div class="s">${esc(g.players)} · ${esc(g.modes.join(' / '))}</div></div>
      <div class="right">${gameTag(g)}${g.playable ? `<button class="btn sm primary" data-play="${g.id}">Play</button>` : ''}</div>
    </a>`).join('');
  return panel('Game library', `<div class="glist">${rows}</div>`, moreLink('#/games', 'all games'), 's3');
}

/** A title with no rating ladder (one seat, no Elo: FLOOD CONTROL) ranks by its lead stat instead; `byStat` names it. */
function statRanking(rid) {
  const k = statNames(rid, 1)[0];
  if (!k) return [];
  const asc = S.snapshot?.manifests?.[rid]?.services?.stats?.schema?.[k] === 'min';
  const rows = Object.entries(S.stats[rid] ?? {}).filter(([, l]) => typeof l[k] === 'number')
    .sort(([pa, a], [pb, b]) => (asc ? a[k] - b[k] : b[k] - a[k]) || (pa < pb ? -1 : 1))
    .map(([p], i) => ({ rank: i + 1, player: p, rating: null }));
  return Object.assign(rows, { byStat: k });
}
const ladderRows = (rid) => (S.boards[rid]?.length ? S.boards[rid] : statRanking(rid));

function boardTable(rid, limit, q = '', cols = 0) {
  const rows = ladderRows(rid);
  const st = S.stats[rid] ?? {};
  const list = (q ? rows.filter((r) => r.player.includes(q)) : rows).slice(0, limit);
  const me = myBoardRow(rid);
  const names = statNames(rid, cols);
  const tr = (r) => { const s = st[r.player] ?? {}; return `<tr class="${r.player === player.id ? 'me' : ''}"><td class="rank ${r.rank <= 3 ? 'top' : ''}">#${r.rank}</td><td><div class="pl"><img src="${r.player === player.id ? player.avatar : identicon(r.player, 40)}" alt=""/>${r.player === player.id ? esc(player.name) : short(r.player, 12)}</div></td><td class="num">${r.rating ?? '—'}</td><td class="num">${s.matches ?? 0}</td><td class="num">${s.wins ?? 0}</td><td class="num">${pct(s.wins ?? 0, s.matches ?? 0)}%</td>${names.map((k) => `<td class="num">${statValue(k, s)}</td>`).join('')}</tr>`; };
  if (!S.online) return nodeHint();
  if (!rows.length) return attestedTitle(rid) ? '<div class="empty">No court-reported matches on this title yet. This ladder is attested: the title’s own court signs each result and the node checks it against the rules; nothing on it is replayed by witnesses or official.</div>' : '<div class="empty">No verified ranked matches on this title yet. The official ladder counts placed, player-signed, witness-verified results only; every settled match still shows in your record, labelled.</div>';
  const extra = me && !list.some((r) => r.player === player.id) ? `<tr><td colspan="${6 + names.length}" class="dim" style="text-align:center">…</td></tr>${tr(me)}` : '';
  const byStat = rows.byStat ? `<div class="dim" style="margin:0 0 8px">no rating ladder on this title (one seat per run): ranked by ${esc(statLabel(rows.byStat).toLowerCase())}</div>` : '';
  return `${attestedNote(rid)}${byStat}<div class="tablewrap"><table><thead><tr><th>Rank</th><th>Player</th><th class="num">Rating</th><th class="num">Matches</th><th class="num">Wins</th><th class="num">Win %</th>${names.map((k) => `<th class="num">${esc(statLabel(k))}</th>`).join('')}</tr></thead><tbody>${list.map(tr).join('')}${extra}</tbody></table></div>`;
}
/** A title whose results a court attests (defineAttestedTitle): its ladder is labelled so wherever it is drawn. */
const attestedTitle = (rid) => GAMES.some((g) => g.rulesetId === rid && g.status === 'attested');
const attestedNote = (rid) => attestedTitle(rid) ? '<div class="dim" style="margin:0 0 8px"><span class="tag court">attested</span> results signed by the title’s own court and checked against its rules, not replayed by witnesses — this ladder is never official</div>' : '';
let lbTab = PRIMARY.rulesetId;
const lbTabs = () => `<div class="tabs">${GAMES.filter((g) => g.rulesetId).map((g) => `<button class="${g.rulesetId === lbTab ? 'active' : ''}" data-lb="${g.rulesetId}">${esc(g.title)}</button>`).join('')}</div>`;
const leaderboardPanel = () => panel('Leaderboards', `${lbTabs()}<div style="margin-top:8px">${boardTable(lbTab, 8)}</div>`, moreLink('#/leaderboards'), 's5');

// Cards are not live yet: greyed (.soon), inert, "coming soon" on hover. Every fighter, item and pet is one
// card in one collection (roster.js deck); the sample stands in for the player's own until the account sync.
const SOON_TAG = '<span class="tag soon-tag">coming soon</span>';
const DECK = deck();
const nftCard = (c) => `<article class="nft ${c.held ? '' : 'locked'}" style="--cc:${c.color}" title="${esc(c.name)} · ${esc(c.badge)}">
    <div class="nft-top"><span>${c.kind}</span><span class="nft-badge">${esc(c.badge)}</span></div>
    <div class="nft-art">${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy" />` : `<span class="nft-glyph">${c.glyph}</span>`}${c.held ? '' : '<span class="nft-lock">🔒</span>'}</div>
    <div class="nft-name">${esc(c.name)}</div>
    <div class="nft-stat">${esc(c.stat)}</div>
    <div class="nft-foot"><span>${c.held > 1 ? `×${c.held}` : c.held ? 'held' : 'not held'}</span>${c.flag ? `<span class="nft-flag">${c.flag}</span>` : ''}</div>
  </article>`;
function cardsPanel() {
  const held = DECK.filter((c) => c.held);
  const lead = [...held.filter((c) => c.flag), ...held.filter((c) => !c.flag)].slice(0, 6);   // the main fighter and the equipped pet first
  return panel('Cards', `<div class="deck sm">${lead.map(nftCard).join('')}</div><div class="source">${held.length} of ${DECK.length} cards held · <span class="tag sample">sample</span></div>`, moreLink('#/cards', 'collection'), 's7 soon');
}

// ═══════════════════════════════════════════════ views ══
function renderHome() {
  view('home').innerHTML = nodePanel() + profilePanel() + statsPanel() + gamesPanel() + leaderboardPanel() + cardsPanel();
}
const coverArt = (g) => g.cover
  ? `<img class="bgimg" src="${esc(g.cover)}" alt="${esc(g.title)} title screen" />${g.logo ? `<img class="logo" src="${esc(g.logo)}" alt="" />` : ''}`
  : `<div class="mark"><span class="chrome">${esc(g.title.split(' ').map((w) => w[0]).join(''))}</span></div>`;
// The Arcade tab's window: pick a title, play it in the page. Its <iframe> is
// built once — render() runs on every node poll, and rewriting the frame's
// HTML would reload the game — so only the parts around it re-render.
const playableGames = () => GAMES.filter((g) => g.playable && g.url);
let arcadePick = null;   // picked this session; otherwise the featured title (config.js `featured`, else the first) loads
const arcadeGame = () => { const list = playableGames(); return list.find((g) => g.id === arcadePick) ?? list.find((g) => g.featured) ?? list[0] ?? null; };
const inWindow = () => current && frame !== overlayFrame;
// The Arcade tab is the landing page: entering it with nothing running loads
// the featured title. A remembered AIR session is restored first (capped), so
// the title opens signed in rather than as a guest.
let airBoot = Promise.resolve();
async function autoloadArcade() {
  await Promise.race([airBoot, new Promise((r) => setTimeout(r, 4000))]);
  if (route.name === 'games' && !current) { const g = arcadeGame(); if (g) play(g, null, 'window'); }
}
function renderArcadeWindow() {
  const g = arcadeGame(), list = playableGames(), live = inWindow();
  const win = $('aw');
  win.style.setProperty('--ga', (live ? current : g)?.accent ?? 'var(--cyan)');
  win.classList.toggle('live', !!live);
  $('aw-bar').innerHTML = `<span class="aw-led"></span><span class="aw-title">${live ? esc(current.title) : g ? esc(g.title) : 'No title'}</span><span class="aw-status">${live ? `now playing · ${esc(current.badge ?? '')}` : g ? 'stopped' : 'no playable titles yet'}</span><span class="spacer"></span>
    ${live ? '<button class="btn sm" data-aw-fs>⛶ fullscreen</button><button class="btn sm" data-aw-tab>↗ open in tab</button>' : g ? `<button class="btn sm primary" data-aw-start="${g.id}">▶ play</button>` : ''}`;
  $('aw-sel').innerHTML = list.map((x) => `<button class="aw-pick ${x.id === g?.id ? 'on' : ''} ${live && x.id === current.id ? 'playing' : ''}" data-aw-pick="${x.id}" style="--ga:${x.accent}">${esc(x.title)}</button>`).join('');
}
function renderGames() {
  const v = view('games');
  if (!$('aw')) v.innerHTML = `<div class="page-h" id="games-h"></div>
    ${arcadeBanner()}
    <section class="aw" id="aw" aria-label="arcade window">
      <div class="aw-bar" id="aw-bar"></div>
      <div class="aw-screen" id="aw-screen"><iframe id="aw-frame" title="arcade window" allow="fullscreen *; gamepad *; autoplay *; pointer-lock *; xr-spatial-tracking *; clipboard-write *"></iframe></div>
      <div class="aw-sel" id="aw-sel"></div>
    </section>
    <div class="section-h aw-lib"><h4>Library</h4></div>
    <div class="cards" id="games-cards"></div>`;
  const onMesh = GAMES.filter((g) => g.rulesetId).length;
  $('games-h').innerHTML = `<h1 class="chrome">Arcade</h1><span class="dim">${GAMES.length} titles · ${onMesh} settled on the mesh</span>`;
  renderArcadeWindow();
  $('games-cards').innerHTML = GAMES.map((g, i) => `
    <article class="card" style="--ga:${g.accent}">
      <a class="cover" href="#/game/${g.id}">${coverArt(g)}${gameTag(g)}<span class="no">0${i + 1}</span></a>
      <div class="body">
        <div class="ttl"><h2>${esc(g.title)}${g.trademark === false ? '' : '<sup>™</sup>'}</h2><a class="sel" href="#/game/${g.id}">Select ›</a></div>
        <div class="tagline">${esc(g.tagline)}</div>
        ${tagRow(g)}
        <ul class="mini">${!g.rulesetId ? '<li class="dim">not on the mesh yet</li>' : S.online ? ((S.boards[g.rulesetId] ?? []).slice(0, 3).map((r) => `<li><span>${r.rank}. ${short(r.player, 12)}</span><span>${r.rating}</span></li>`).join('') || '<li class="dim">no settled matches yet</li>') : `<li class="dim">${S.checked ? 'node offline' : 'connecting…'}</li>`}</ul>
        <div class="row">${g.playable ? `<button class="btn primary" data-aw-start="${g.id}">Play now</button>` : '<button class="btn" disabled>Off-cabinet</button>'}<a class="btn" href="#/game/${g.id}">Details</a></div>
      </div>
    </article>`).join('');
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
      <div class="hero-actions">${g.rulesetId && g.queue !== false ? `<button class="btn primary" data-queue="${g.id}" ${S.online && player.kp ? '' : 'disabled'}>Find match</button>` : ''}${g.playable ? `<button class="btn ${g.rulesetId && g.queue !== false ? '' : 'primary'}" data-play="${g.id}">Play now</button>` : `<button class="btn" disabled>${esc(g.offCabinet ?? 'Played off-cabinet')}</button>`}${g.url ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">↗ open in tab</a>` : ''}</div>
    </section>
    ${g.rulesetId ? '<div id="mm"></div>' : ''}
    <div class="cols">
      <div class="col">
        ${panel('About', `<p>${esc(g.description)}</p>`)}
        <div style="height:16px"></div>
        ${panel('Controls & modes', `<ul class="list">${g.controls.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><div class="section-h"><h4>Modes</h4></div><div class="chips">${g.modes.map((m) => `<span class="chip" style="cursor:default">${esc(m)}</span>`).join('')}</div>`)}
        <div style="height:16px"></div>
        ${panel('On the mesh', `<dl class="mesh"><div><dt>ruleset</dt><dd>${esc(g.rulesetId ?? '—')}</dd></div><div><dt>build</dt><dd title="${esc(g.buildHash ?? '')}">${g.buildHash ? short(g.buildHash, 20) : '—'}</dd></div><div><dt>settled by</dt><dd>${esc(settledBy(g))}</dd></div><div><dt>settled</dt><dd>${S.online && g.rulesetId ? `${(S.deltas[g.rulesetId] ?? []).length} matches` : '—'}</dd></div></dl>`)}
      </div>
      <div class="col">
        ${panel('Leaderboard', g.rulesetId ? boardTable(g.rulesetId, 10) : '<div class="empty">This title is not on the mesh yet — its ruleset lands with the node sync.</div>', g.rulesetId ? moreLink('#/leaderboards') : '')}
        <div style="height:16px"></div>
        ${panel('Your record', me || hist.length || progressLine(g.rulesetId) ? `${recordXp(g.rulesetId)}<div class="stats4" style="margin:0 0 12px"><div class="stat"><div class="k">Rank</div><div class="v">${me ? `#${me.rank}` : '—'}</div></div><div class="stat"><div class="k">Rating</div><div class="v">${me ? me.rating ?? '—' : 1200}</div></div><div class="stat"><div class="k">Matches</div><div class="v">${S.stats[g.rulesetId]?.[player.id]?.matches ?? 0}</div></div><div class="stat"><div class="k">Wins</div><div class="v">${S.stats[g.rulesetId]?.[player.id]?.wins ?? 0}</div></div></div>
          ${hasTitleStats(g.rulesetId, S.stats[g.rulesetId]?.[player.id]) ? `<div style="margin:0 0 12px">${statTiles(g.rulesetId, S.stats[g.rulesetId][player.id])}</div>` : ''}
          <div class="tablewrap"><table><thead><tr><th>Result</th><th>Opponent</th><th class="num">Length</th><th class="num">Rating</th><th>When</th></tr></thead><tbody>${hist.map((h) => `<tr><td class="res ${h.res[0]}">${h.res.toUpperCase()}</td><td>${h.opp.map((o) => short(o, 10)).join(', ') || '—'}</td><td class="num">${Math.floor(h.ticks / 3600)}:${String(Math.floor((h.ticks / 60) % 60)).padStart(2, '0')}</td><td class="num">${h.rating}</td><td class="dim">${h.when ? new Date(h.when).toLocaleDateString() : '—'} ${proofTag(h.proof)} ${verifyTag(h)} <a class="link rcpt-link" href="#/match/${esc(h.matchId)}" title="the match's transactions on the Liteforge explorer">receipt ›</a></td></tr>`).join('') || '<tr><td colspan="5" class="dim">No matches yet.</td></tr>'}</tbody></table></div>` : `<div class="empty">${S.online ? 'No settled matches under your key yet. Play one — it shows up here once the mesh settles it.' : 'Start a node to load your record.'}</div>`)}
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
  if (MM.state === 'idle') { const notice = player.kp && rankedShortfall(g); el.innerHTML = player.kp ? (notice ? panel('Find match', `<div class="empty">${esc(notice)}</div>`) : '') : panel('Find match', '<div class="empty">This page has no WebCrypto (plain http from a network address), so it holds no player key and cannot queue. Open it as http://localhost:&lt;port&gt;/ on the node&#39;s machine, or over https.</div>'); return; }
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
/** A ranked match goes on chain only when the draw seats a host plus three witnesses under three other operators
 *  (protocol/placement.js PANEL; node/matchbook.js skips the commit otherwise). Say so before the queue, not after:
 *  on 23-25 Sep every ranked match played casual-only because two or three nodes were fresh. Counts distinct
 *  operators among fresh bonded nodes that carry the title — the draw's exact rule (build hash, eligibility age,
 *  staking addresses) can only seat fewer, so a warning here is never a false alarm. */
function rankedShortfall(g) {
  const c = rankedCapacity(S.peers, g.rulesetId, { protocol: S.health?.protocol ?? null });
  if (c.ok) return null;
  const why = !c.hosts ? 'no host with this title is online' : `${c.operators} ${c.operators === 1 ? 'is' : 'are'} online with this title, and a host finds ${c.seats} witness${c.seats === 1 ? '' : 'es'} under other wallets`;
  return `Ranked plays casual-only right now: going on chain needs a host and three witnesses under four different staking wallets${c.by === 'label' ? ' (this node names operators by label only: update it to count wallets)' : ''}; ${why}. You can still play; the result stays off the official ladder.`;
}
/** Matchmaking is a function of everyone's clock (2 s buckets). A node whose
 *  clock disagrees with its bonded peers computes buckets nobody else has
 *  and waits forever — seen live (a laptop 23 min behind). Refuse loudly. */
function clockProblem() {
  const bonded = S.peers.filter((p) => p.bonded && p.nodeId !== S.health?.nodeId);
  const off = bonded.filter((p) => Math.abs(p.clockSkewS) > 4);
  if (bonded.length && off.length === bonded.length) return `this node's clock is about ${Math.round(Math.abs(off[0].clockSkewS))} s ${off[0].clockSkewS > 0 ? 'behind' : 'ahead of'} the mesh — matchmaking cannot pair across clocks. Sync it (Windows: Settings › Time › Sync now, or an admin prompt: w32tm /resync), then try again.`;
  if (!S.peers.some((p) => p.nodeId !== S.health?.nodeId)) return 'this node has not heard from any other node — it is alone on the mesh, so there is nobody to pair with. A node finds its peers on chain: check this machine\'s internet and clock, and leave the manual seed blank (Control Plane setup, or SEEDS in node.env) unless you run a private mesh.';
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
    const say = (text) => { MM.text = text; if (route.name === 'game') renderMatchmaking(g); };
    const r = await client.waitForMatch({ timeoutMs: 5 * 60_000, sinceBucket: bucket, requeue: entry, signal: mmAbort.signal,
      onTick: (m) => { if (!m) say(`waiting… ${((Date.now() - t0) / 1000).toFixed(0)} s — the other player must press Find match too`); },
      // Paired: checking the placement and asking the host for its on-chain commit takes a few seconds. Say so, or the
      // panel reads as frozen and players press Stop and queue again (23 Sep 2026: three courts for one pair).
      onPaired: () => say('paired — checking the placement and asking the host to commit it on chain (a few seconds)…') });
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
  const top = ladderRows(lbTab).slice(0, 3);
  const streakOf = (pid) => { const h = history(lbTab, pid); const last = h.at(-1)?.res; if (!last) return '—'; let n = 0; for (let i = h.length - 1; i >= 0 && h[i].res === last; i--) n++; return `${last === 'win' ? 'W' : last === 'loss' ? 'L' : 'D'}${n}`; };
  const podium = top.length ? `<div class="podium">${top.map((r) => { const s2 = st[r.player] ?? {}; const me = r.player === player.id; const color = r.rank === 1 ? '#f2c46d' : r.rank === 3 ? '#f0946a' : '#8ce8ff'; return `
    <div class="rankcard r${r.rank}">
      <div class="head">${rankBadge(r.rank, color)}<span class="badge-tier">${tierOf(levelOf((s2.wins ?? 0) * 60 + ((s2.matches ?? 0) - (s2.wins ?? 0)) * 20).level)}</span></div>
      <div class="name"><img src="${me ? player.avatar : identicon(r.player, 56)}" alt="" />${me ? esc(player.name) : short(r.player, 10)}</div>
      <div class="sub">${esc(g?.title ?? lbTab)}</div>
      <div class="row3"><div><div class="v">${r.rating?.toLocaleString() ?? '—'}</div><div class="k">Rating</div></div><div><div class="v">${pct(s2.wins ?? 0, s2.matches ?? 0)}%</div><div class="k">Win rate</div></div><div><div class="v">${streakOf(r.player)}</div><div class="k">Streak</div></div></div>
      ${hasTitleStats(lbTab, s2) ? `<div class="row3 st">${statNames(lbTab, 3).map((k) => `<div><div class="v">${statValue(k, s2)}</div><div class="k">${esc(statLabel(k))}</div></div>`).join('')}</div>` : ''}
      <div class="rfoot">ed25519:${esc(r.player)}</div>
    </div>`; }).join('')}</div>` : '';
  view('leaderboards').innerHTML = `<div class="page-h"><h1 class="chrome">Ranks</h1><span class="dim">derived by the mesh from settled matches — reproducible by any node</span><div class="right"><input class="search" id="lb-q" placeholder="find player id…" value="${esc(lbQuery)}" /></div></div>
    ${lbQuery ? '' : podium}
    ${panel(g?.title ?? 'Leaderboard', `${lbTabs()}<div style="margin-top:8px">${boardTable(lbTab, 100, lbQuery, 4)}</div>`)}`;
  const q = $('lb-q'); q.addEventListener('input', () => { lbQuery = q.value.trim(); const pos = q.selectionStart; renderLeaderboards(); const q2 = $('lb-q'); q2.focus(); q2.setSelectionRange(pos, pos); });
}
let cardKind = 'all', cardHeld = false;
function renderCards() {
  const list = DECK.filter((c) => (cardKind === 'all' || c.kind === cardKind) && (!cardHeld || c.held));
  const tally = (k) => { const all = DECK.filter((c) => c.kind === k); return `${all.filter((c) => c.held).length}<small> / ${all.length}</small>`; };
  view('cards').innerHTML = `<div class="page-h"><h1 class="chrome">Cards</h1><span class="dim">Every fighter, item and pet becomes an NFT card you own.</span>${SOON_TAG}</div>
    <div class="soon soon-page">
      <div class="stats4 deck-sum">${Object.entries(KINDS).map(([k, label]) => `<div class="stat"><div class="k">${label}</div><div class="v">${tally(k)}</div></div>`).join('')}<div class="stat"><div class="k">Tickets</div><div class="v">${COLLECTION_SAMPLE.tickets}</div></div></div>
      <div class="chips deck-filter">${[['all', 'All'], ...Object.entries(KINDS)].map(([k, label]) => `<button class="chip ${cardKind === k ? 'active' : ''}" data-cards="${k}">${label}</button>`).join('')}<span class="spacer"></span><button class="chip ${cardHeld ? 'active' : ''}" data-cards-held>Held only</button></div>
      <div class="deck">${list.map(nftCard).join('') || '<div class="empty">No cards here.</div>'}</div>
      <div class="source">A sample collection until the Agent Fighter sync. Tickets are won in wager matches, cannot be transferred, and redeem for esports qualification, merch and vouchers.</div>
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
  if (!nodeops.available()) return '<div class="sub dim">Install a browser wallet (MetaMask) on litVM to bond, delegate or transfer this node. CLI: <span class="mono">npm run bond -- &lt;nodeId&gt;</span>.</div>';
  if (Op.busy) return `<div class="sub">${esc(Op.busy)}</div>`;
  const err = Op.error ? `<div class="sub bad">${esc(Op.error)}</div>` : '';
  const tx = Op.lastTx ? `<div class="sub dim">last tx <span class="mono">${esc(Op.lastTx.slice(0, 14))}…</span>${CHAIN.explorer ? ` · <a class="link" target="_blank" rel="noopener" href="${esc(CHAIN.explorer)}/tx/${esc(Op.lastTx)}">explorer</a>` : ''}</div>` : '';
  if (!Op.account) return `<div class="sub"><button class="btn sm" id="op-connect">Connect operator wallet</button> <span class="dim">nothing is sent until you confirm</span></div>${err}`;
  const i = Op.info; const me = Op.account;
  const mine = !!i?.bonded && i.operator === me;
  const ann = h.directory?.announcer?.address?.toLowerCase() ?? null;
  const rows = [
    `<dt>wallet</dt><dd class="mono">${esc(me)}${i?.balance != null ? ` · ${tok(i.balance)} tLITVM` : ''}${i?.gas != null ? ` · ${(Number(i.gas / 10n ** 12n) / 1e6).toFixed(4)} zkLTC` : ''}</dd>`,
    i && i.gas === 0n ? `<dt>gas</dt><dd><span class="bad">no zkLTC: nothing can be signed.</span> Get 0.005 (plenty for a bond) at the <a class="link" href="${GAS_FAUCET}" target="_blank" rel="noopener">faucet</a>, then come back.</dd>` : '',
    `<dt>bond</dt><dd>${i ? (i.bonded ? `${tok(i.amount)} tLITVM by <span class="mono">${esc(i.operator.slice(0, 10))}…</span>${mine ? ' (you)' : ''}` : `none · minimum ${tok(i.minStake)} tLITVM`) : 'reading…'}</dd>`,
    ann ? `<dt>announcer</dt><dd class="mono">${esc(ann.slice(0, 10))}… ${i?.announcer === ann ? '<span class="dim">delegated</span>' : '<span class="dim">not delegated</span>'}</dd>` : '',
    ann && i?.bonded ? `<dt>delegate</dt><dd class="mono">${i.delegate ? `${esc(i.delegate.slice(0, 10))}… <span class="dim">${i.delegate === ann ? 'the node’s hot key' : 'another key'}</span>` : '<span class="dim">not set: the node cannot commit, attest or propose</span>'}</dd>` : '',
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
    if (what === 'bond') {
      step('bonding…');
      // Generation 4 needs the node key's signature over this wallet: this node signs it (loopback, this page only); older nodes have no route and gen-3 needs none.
      const pr = await fetch(`${nodeUrl()}/bond-proof?operator=${encodeURIComponent(Op.account)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      Op.lastTx = await nodeops.bond(Op.account, h.nodeId, { onStep: step, delegate: h.directory?.announcer?.address ?? null, proof: pr?.proof ?? null });
    }
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
  if (!air.configured()) return '<div class="sub dim">Universal login is off in this build. CLI: <span class="mono">npm run publish:title -- register rulesets/&lt;id&gt;.js</span>.</div>';
  if (Pub.busy) return `<div class="sub">${esc(Pub.busy)}</div>`;
  const err = Pub.error ? `<div class="sub bad">${esc(Pub.error)}</div>` : '';
  const tx = Pub.lastTx ? `<div class="sub dim">last tx <span class="mono">${esc(Pub.lastTx.slice(0, 14))}…</span>${CHAIN.explorer ? ` · <a class="link" target="_blank" rel="noopener" href="${esc(CHAIN.explorer)}/tx/${esc(Pub.lastTx)}">explorer</a>` : ''}</div>` : '';
  const s = Ai.me.session;
  if (!s?.address) return `<div class="sub"><button class="btn sm" id="pub-signin">Sign in with AIR</button> <span class="dim">your AIR account gets a litVM wallet here to hold the titles you publish</span></div>${err}`;
  if (s.custody !== 'here') return `<div class="sub dim">Your litVM wallet <span class="mono">${esc(s.address.slice(0, 10))}…</span> is held by another node: publish from that node's arcade, or transfer the title to a wallet you control.</div>`;
  if (!h.trust?.titleRegistry) return '<div class="sub dim">No TitleRegistry on this node: titles cannot be claimed from here.</div>';
  const me = s.address.toLowerCase();
  const bondedByMe = h.bonded && S.stake?.operator?.toLowerCase() === me;
  const bondLine = h.bonded === false ? `<div class="sub"><button class="btn sm primary" data-pub="bond">Bond this node from my AIR wallet</button> <span class="dim">stakes the minimum and delegates the announcer; a title is listed only while its holder runs a bonded host</span></div>`
    : bondedByMe ? '<div class="sub dim">Bonded from your AIR wallet: titles you hold here are listed.</div>'
    : h.bonded ? `<div class="sub dim">Bonded from another wallet${S.stake?.operator ? ` (<span class="mono">${esc(S.stake.operator.slice(0, 10))}…</span>)` : ''}: your titles are hosted here but listed only from a node bonded by your wallet.</div>` : '';
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
  const table = mine.length ? `<table><thead><tr><th>Title on this node</th><th>Holder</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="sub dim">This node hosts no titles. Add one to RULESETS in node.env, restart, and claim it here.</div>';
  return `<div class="sub">AIR <b>${esc(Ai.me.email ?? s.name ?? '')}</b> · litVM wallet <span class="mono" title="${esc(s.address)}">${esc(s.address.slice(0, 10))}…</span> <span class="dim">· titles are NFTs this wallet holds</span></div>${bondLine}${table}${tx}${err}`;
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
const secs = (s) => (s == null ? '?' : s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const REGISTRY = { active: 'active on ReleaseRegistry', pending: 'registered, activation delay running', revoked: 'REVOKED, will not apply', unset: 'no registry configured', unchecked: 'registry not checked yet', unreadable: 'registry unreadable' };
// The page is one status band and one tab at a time; the tab is remembered per browser.
const NODE_TABS = { overview: 'Overview', wallet: 'Wallet & gas', network: 'Network', activity: 'Activity', guide: 'Run a node' };
let nodeTab = NODE_TABS[load('cabinet.nodeTab')] ? load('cabinet.nodeTab') : 'overview';
const uptimeWeek = () => `${heatmap(S.uptime)}<div class="legend"><i class="up"></i>up <i class="partial"></i>partial <i class="down"></i>down <i class="none"></i>unobserved</div><div class="source">Seen by this page while it is open, in 10-minute slots.</div>`;
const runANode = () => `<p class="lede">This page reads the mesh through a node on <b>your</b> machine. Like a torrent client, every node serves everyone: it verifies and witnesses matches.</p><ol class="steps">
    <li><a class="link" href="#/download"><b>Download the Control Plane</b></a> for Windows 10/11 (no admin needed) and check its SHA-256.</li>
    <li>In first-run setup, pick <b>Quick Tunnel</b> and leave the seed blank. The node starts in the tray and the header turns green.</li>
    <li>Put a little zkLTC (<a class="link" href="${GAS_FAUCET}" target="_blank" rel="noopener">free faucet</a>) in a fresh wallet on ${esc(CHAIN.name)}. Then, under <b>Wallet &amp; gas</b>: faucet tLITVM, bond, delegate, and top up the hot key.</li>
    <li>Leave it running. Tunnel, announce, enrolment and witnessing are automatic; apply updates when the Control Plane offers them.</li></ol>
  <div class="source">Ranked results go on chain once four operators (four wallets) have bonded nodes online, so every operator counts. macOS/Linux: the <a class="link" href="${RELEASES}" target="_blank" rel="noopener">release zips</a>. Troubleshooting: the <a class="link" href="${OPERATOR_GUIDE}" target="_blank" rel="noopener">operator guide</a>.</div>`;
const seedsTable = () => !seeds.configured() ? '<div class="empty">NodeDirectory is not configured in this build.</div>'
  : S.seeds.length ? `<div class="tablewrap"><table><thead><tr><th>Operator</th><th>Node</th><th>Address</th><th>Relay</th><th>Announced</th></tr></thead><tbody>${S.seeds.map((s) => `<tr><td class="mono">${s.operator.slice(0, 6)}…${s.operator.slice(-4)}</td><td class="mono" title="${esc(s.nodeId)}">${short(s.nodeId, 12)}</td><td class="mono">${esc(s.url)}</td><td class="mono dim">${esc(s.wsAddr ?? '—')}</td><td class="dim">${new Date(s.updatedAt * 1000).toLocaleString()}</td></tr>`).join('')}</tbody></table></div><div class="source">Bonded nodes that announced on NodeDirectory in the last 7 days. ${S.viaSeed ? `This page reads the mesh through ${esc(S.viaSeed.url)}.` : 'Your own node comes first; seeds are the fallback.'}</div>`
  : '<div class="empty">No seed has announced, or the chain is unreachable. <button class="link" id="seeds-refresh">Read again</button></div>';

/** The operator's cockpit, from the node's signed /fleet; the older /health rows when a node predates it. */
function renderNode() {
  const h = S.health, f = S.fleet;
  const verified = f ? `<span class="tag live" title="digest ${esc(f.digest.slice(0, 12))}… · signed by ${esc(f.nodeId.slice(0, 12))}… at ${esc(f.at)}">signed by the node · ${ago(Date.now() - S.fleetAt)} ago</span>` : S.fleetError ? `<span class="tag court" title="${esc(S.fleetError)}">unverified</span>` : '';
  const head = `<div class="page-h"><h1 class="chrome">Nodes</h1><span class="dim">Your node verifies and witnesses matches for the mesh.</span><div class="right">${verified}</div></div>`;
  if (!h) {
    view('node').innerHTML = `${head}<div class="home">${nodePanel({ compact: false })}
      ${panel('Run a node', `${S.checked ? `<div class="empty">No node at <span class="mono">${esc(nodeUrl())}</span>. <button class="link" id="node-edit2">Use another node</button></div>` : ''}${runANode()}`, '', 's12')}
      ${panel('Seeds on chain', seedsTable(), '', 's12')}</div>`;
    bindNode();
    return;
  }
  const sf = f?.self, mb = f?.chain.matchBook, purse = mb?.purse ?? null, ann = f?.chain.announcer;
  const steps = f ? fleetChecklist(f, { cabinetContracts: CONTRACTS.contracts }) : [];
  const open = steps.filter((st) => st.state === 'todo' || st.state === 'warn').length;
  const updateBtn = h.update?.available ? (isLoopbackNode() ? '<button class="btn sm primary" id="update-btn">Update node</button>' : '<span class="dim">update from the node’s machine</span>') : '';

  // ---- overview: setup + this node (identity and release in one list)
  const u = sf?.update;
  const identity = f ? `<dl class="kv">
      <dt>node id</dt><dd>${copyable(sf.nodeId, 24)} <span class="dim">the key the operator bonds</span></dd>
      <dt>operator</dt><dd>${esc(sf.operator)} · ${esc(sf.region)}</dd>
      <dt>roles</dt><dd>${esc(sf.roles.join(' · '))}</dd>
      <dt>wallet</dt><dd>${sf.wallet ? ex('address', sf.wallet) : '<span class="dim">not bonded</span>'}</dd>
      <dt>hot key</dt><dd>${ann ? ex('address', ann.address) : '—'} <span class="dim">pays gas, never holds the bond</span></dd>
      <dt>version</dt><dd>${esc(sf.version)} · protocol ${f.protocol}${sf.version !== CABINET_VERSION ? ` · <b>this arcade is ${esc(CABINET_VERSION)}</b> (the node serves ${esc(f.cabinet)})` : ''}</dd>
      <dt>release</dt><dd>${u.latest ? `${u.available ? `<b>${esc(u.latest)} available</b>` : `${esc(u.latest)} is the latest`}${u.applying ? ' · applying…' : ''}${u.registry ? ` · <span class="dim">${esc(REGISTRY[u.registry] ?? u.registry)}</span>` : ''}` : '<span class="dim">no release manifest read yet</span>'}</dd>
      <dt>update check</dt><dd>${esc(u.channel ?? 'stable')} · ${u.checkedAt ? `${ago(Date.now() - new Date(u.checkedAt).getTime())} ago` : 'never'}${u.lastError ? ` · <span class="bad">${esc(u.lastError)}</span>` : ''}${u.canRollback ? ' · rollback kept' : ''}</dd>
    </dl>` : `<dl class="kv">
      <dt>node id</dt><dd>${copyable(h.nodeId, 24)}</dd><dt>operator</dt><dd>${esc(h.operator)} · ${esc(h.region)}</dd><dt>roles</dt><dd>${esc(h.roles.join(' · '))}</dd>
      <dt>address</dt><dd>${esc(h.addr)}</dd><dt>bonded</dt><dd>${h.bonded === null ? 'unknown' : h.bonded ? 'yes' : 'no — see Wallet &amp; gas'}</dd>
      <dt>tunnel</dt><dd>${h.tunnel?.node ? `${esc(h.tunnel.node.mode)} · ${esc(h.tunnel.node.state)}${h.tunnel.node.url ? ` · ${esc(h.tunnel.node.url)}` : ''}${h.tunnel.node.lastError ? ` · ${esc(h.tunnel.node.lastError)}` : ''}` : 'none (LAN only)'}</dd>
      <dt>relay</dt><dd>${h.wsAddr ? `${esc(h.wsAddr)}${h.tunnel?.relay ? ` (${esc(h.tunnel.relay.state)})` : ''}` : 'none'}</dd>
      <dt>version</dt><dd>${esc(h.version ?? '?')}${h.update?.available ? ` · <b>${esc(h.update.latest)} available</b>` : h.update?.checkedAt ? ' · up to date' : ''}${h.version && h.version !== CABINET_VERSION ? ` · <b>this arcade is ${esc(CABINET_VERSION)}</b>` : ''}</dd>
      <dt>reachable</dt><dd>${h.inbound ? (h.inbound.reachable === null ? 'no peers known yet' : h.inbound.reachable ? `${h.inbound.peers} peer${h.inbound.peers === 1 ? '' : 's'} push gossip here` : 'nobody reached it in 30 s — fine for a witness; a seed or host needs a tunnel') : '—'}</dd>
      <dt>chain</dt><dd>${h.chain.offline ? 'offline beacon' : `block ${h.chain.head ?? '?'} · ${esc(h.chain.rpc)}`}${h.chain.lastError ? ` · <span class="bad">${esc(h.chain.lastError)}</span>` : ''}</dd>
      <dt>rulesets</dt><dd>${Object.entries(h.rulesets).map(([k, v]) => `${esc(k)} @ ${v.slice(0, 10)}`).join(', ')}</dd>
    </dl>`;
  const fleetNote = !f && S.fleetError ? `<div class="source">Signed status unavailable: ${esc(S.fleetError)}</div>` : '';
  const checklistHtml = f ? `<ol class="checklist">${steps.map((st) => `<li class="${st.state}"><span class="st">${stateTag(st.state)}</span><span><b>${esc(st.label)}</b><small>${esc(st.detail)}</small></span></li>`).join('')}</ol>
      <div class="source">Read live from the node and the chain. Wallet steps are under Wallet &amp; gas; the node does the rest itself.</div>` : '';

  // ---- wallet & gas: the hot key's purse and top-up
  let purseHtml = '';
  if (purse) {
    const price = purse.gasPriceWei ? Number(purse.gasPriceWei) : null;
    const perMatch = purse.perMatchGas ?? 445_000;
    const covers = (z) => (price ? Math.floor((Number(z) * 1e18) / (perMatch * price)) : null);
    const buttons = TOPUP_AMOUNTS.map((z) => `<button class="btn sm${purse.low && z === '0.05' ? ' primary' : ''}" data-topup="${z}" ${Tu.busy ? 'disabled' : ''}>+ ${z} zkLTC<small>${covers(z) != null ? ` ≈ ${covers(z)} matches` : ''}</small></button>`).join(' ');
    purseHtml = `<div class="purse ${purse.low ? 'low' : ''}">
        <div class="big-tok"><span class="chrome">${esc(Tu.hotGas != null ? (Number(Tu.hotGas) / 1e18).toFixed(6) : purse.balance ?? '—')}</span><span class="tok">zkLTC${Tu.hotGas != null ? ' <span class="dim">just read</span>' : ''}</span></div>
        <dl class="kv"><dt>covers</dt><dd>~${purse.matchesLeft ?? '?'} matches as ${esc(purse.perMatchRole ?? 'host')} <span class="dim">· ${Math.round(perMatch / 1000)}k gas at ${price ? (price / 1e9).toFixed(2) : '?'} gwei</span></dd>
        <dt>hot key</dt><dd>${ex('address', purse.address, 14)} <button class="link" data-copy-now="${esc(purse.address)}">copy</button></dd>
        <dt>sent</dt><dd>${mb.sends} tx since start${purse.txType ? ` · type-${purse.txType}` : ''}${mb.lastError ? ` · <span class="bad">${esc(mb.lastError)}</span>` : ''}</dd></dl>
        ${purse.low ? '<div class="sub bad">Low: a host that runs dry mid-match voids it. Top up below.</div>' : ''}
        <div class="topup">
          <div class="k">Top up</div>
          ${nodeops.available() ? `<div class="row">${buttons}</div>
            <div class="sub dim">${Op.account ? `from ${esc(Op.account.slice(0, 6))}…${esc(Op.account.slice(-4))}${Tu.walletGas != null ? ` · ${(Number(Tu.walletGas) / 1e18).toFixed(4)} zkLTC in this wallet` : ''}` : '<button class="link" id="topup-connect">Connect a wallet</button>: any wallet can pay; the hot key can never touch the bond.'}</div>`
          : '<div class="sub dim">No browser wallet here: use the faucet.</div>'}
          ${Tu.busy ? `<div class="sub">${esc(Tu.busy)}</div>` : ''}
          ${Tu.tx ? `<div class="sub">sent ${esc(Tu.amount)} zkLTC · ${ex('tx', Tu.tx, 14)} · the node sees it within 30 s</div>` : ''}
          ${Tu.error ? `<div class="sub bad">${esc(Tu.error)}</div>` : ''}
          <div class="sub dim">Free testnet gas: <button class="link" data-copy-now="${esc(purse.address)}">copy the hot-key address</button> and claim at the <a class="link" target="_blank" rel="noopener" href="${GAS_FAUCET}">Caldera faucet</a>. It lands on the node directly.</div>
        </div>
      </div>`;
  }

  // ---- network: reach + chain
  let reachHtml = '', chainHtml = '';
  if (f) {
    const entry = ann?.entry ?? null;
    const same = entry && entry.url === sf.addr && (entry.wsAddr ?? null) === (sf.wsAddr ?? null);
    reachHtml = `<dl class="kv">
      <dt>address</dt><dd>${esc(sf.addr)}${sf.lanAddr && sf.lanAddr !== sf.addr ? ` <span class="dim">· LAN ${esc(sf.lanAddr)}</span>` : ''}</dd>
      <dt>tunnel</dt><dd>${sf.tunnel ? `${esc(sf.tunnel.mode)} · <b>${esc(sf.tunnel.state)}</b>${sf.tunnel.restarts ? ` · rotated ${sf.tunnel.restarts}×` : ''}${sf.tunnel.lastError && sf.tunnel.state !== 'up' ? ` · ${esc(sf.tunnel.lastError.slice(0, 160))}` : ''}` : '<span class="dim">none (LAN only)</span>'}</dd>
      <dt>inbound</dt><dd>${sf.inbound.reachable === null ? 'no peers known yet' : sf.inbound.reachable ? `${sf.inbound.peers} peer${sf.inbound.peers === 1 ? '' : 's'} push gossip here` : 'nobody reached this node in 30 s'}</dd>
      ${sf.relay ? `<dt>relay</dt><dd><b>${esc(sf.relay.state)}</b>${sf.relay.ms != null ? ` · ${sf.relay.ms} ms` : ''}${sf.relay.url ? ` · ${esc(sf.relay.url)}` : ''} <span class="dim">· port ${sf.relay.port} · checked ${sf.relay.checkedAt ? `${ago(Date.now() - new Date(sf.relay.checkedAt).getTime())} ago` : 'never'}</span>${sf.relay.lastError ? ` · <span class="bad">${esc(sf.relay.lastError)}</span>` : ''}</dd>` : ''}
      <dt>directory</dt><dd>${entry ? `${same ? 'matches this node' : `${esc(entry.url)}${entry.wsAddr ? ' + relay' : ''}`} <span class="dim">· announced ${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '?'}</span>` : ann && !('entry' in ann) ? '<span class="dim">not reported by this node version</span>' : '<span class="dim">no entry on NodeDirectory</span>'}${ann?.lastTx ? ` · tx ${ex('tx', ann.lastTx)}` : ''}${ann?.lastError ? ` · <span class="bad">${esc(ann.lastError)}</span>` : ''}</dd>
      <dt>mesh</dt><dd>${f.mesh.active} active · ${f.mesh.known} known · ${f.mesh.bonded} bonded · ${f.mesh.eligible} eligible${f.mesh.incompatible ? ` · ${f.mesh.incompatible} incompatible` : ''} <span class="dim">· ${Object.entries(f.mesh.versions).map(([v, n]) => `${esc(v)}×${n}`).join(' ')}</span></dd>
      <dt>gossip</dt><dd>${f.mesh.gossip.outPerMin}↑ ${f.mesh.gossip.inPerMin}↓ per min · ${(f.mesh.gossip.outBytesPerMin / 1024 / 60).toFixed(1)} KB/s out · ${(f.mesh.gossip.inBytesPerMin / 1024 / 60).toFixed(1)} KB/s in</dd>
    </dl>`;
    const c = f.chain, cs = c.contracts ?? {};
    chainHtml = `<dl class="kv">
      <dt>rpc</dt><dd>${esc(c.rpc)} · <b>${c.rpcMs ?? '?'} ms</b> · ${c.rpcFailures}/${c.rpcCalls} failed${c.lastError ? ` · <span class="bad">${esc(c.lastError)}</span>` : ''}</dd>
      <dt>head</dt><dd>${c.recentBlocks?.length ? ex('block', String(c.recentBlocks.at(-1).number), 12) : esc(c.head ?? '—')} · lag ${c.lagS ?? '?'} s</dd>
      <dt>generation</dt><dd>${cs.generation ?? (c.contracts ? '?' : 'not reported')} on the node · ${CONTRACTS.generation ?? '?'} here</dd>
      ${mb ? `<dt>matchbook</dt><dd>hosting ${mb.hosting} · seated ${mb.seated} · ${mb.events} events · cursor ${mb.cursor}</dd>
      <dt>windows</dt><dd>settle ${secs(mb.windows?.settleWindow)} · attest ${secs(mb.windows?.attestWindow)} · escalation ${secs(mb.windows?.escalationWindow)}</dd>` : ''}
      ${['NodeStake', 'NodeDirectory', 'MatchBook', 'EpochAnchor', 'ReleaseRegistry', 'TitleRegistry', 'PlayerProfile'].map((k) => cs[k] ? `<dt>${k}</dt><dd>${ex('address', cs[k], 14)}${CONTRACTS.contracts[k]?.address && CONTRACTS.contracts[k].address.toLowerCase() !== cs[k].toLowerCase() ? ` <span class="bad">≠ this arcade's ${esc(CONTRACTS.contracts[k].address.slice(0, 10))}…</span>` : ''}</dd>` : '').join('')}
    </dl>`;
  }
  const peersHtml = f ? (f.peers.length ? `<div class="tablewrap"><table><thead><tr><th>Operator</th><th>Node</th><th>Version</th><th>Roles</th><th>Quality</th><th>Ping</th><th>Bonded</th><th>Address</th></tr></thead><tbody>${[...f.peers].sort((a, b) => b.quality.score - a.quality.score).map((p) => `<tr><td>${esc(p.operator)}</td><td class="mono" title="${esc(p.nodeId)}">${esc(p.nodeId.slice(0, 12))}…</td><td>${esc(p.version ?? '?')}${p.protocol !== f.protocol ? ' <span class="tag court">protocol</span>' : ''}</td><td class="dim">${esc(p.roles.join(', '))}</td><td><span class="tag ${p.quality.grade === 'A' || p.quality.grade === 'B' ? 'live' : p.quality.grade === 'C' ? 'hosted' : 'court'}">${p.quality.grade} ${p.quality.score}</span>${p.fresh ? '' : ` <span class="dim">silent ${Math.round(p.ageS)} s</span>`}</td><td>${p.link?.emaMs != null ? `${p.link.emaMs} ms${p.link.loss ? ` · ${Math.round(p.link.loss * 100)}% loss` : ''}` : p.link?.inboundMs != null ? `←${p.link.inboundMs} ms <span class="dim">(they reach us)</span>` : '<span class="dim">via mesh</span>'}</td><td>${p.bonded === null ? '?' : p.bonded ? 'yes' : 'no'}</td><td class="mono dim">${esc(p.addr ?? '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No peers heard yet.</div>')
    : S.peers.length ? `<div class="tablewrap"><table><thead><tr><th>Node</th><th>Operator</th><th>Region</th><th>Roles</th><th>Fresh</th><th>Bonded</th><th>Rulesets</th></tr></thead><tbody>${S.peers.map((p) => `<tr><td class="mono" title="${esc(p.nodeId)}">${esc(p.nodeId.slice(0, 12))}…</td><td>${esc(p.operator)}</td><td>${esc(p.region ?? '')}</td><td class="dim">${esc((p.roles ?? []).join(', '))}</td><td>${p.fresh ? 'yes' : 'no'}</td><td>${p.bonded === null ? '?' : p.bonded ? 'yes' : 'no'}</td><td class="dim">${esc((p.rulesets ?? []).join(', '))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No peers heard yet.</div>';

  // ---- activity: what the hot key sent, the node's events
  const sent = mb?.sent ?? [];
  const workHtml = f ? `${sent.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>What</th><th>Match</th><th>Transaction</th><th class="num">Gas</th><th>Result</th></tr></thead><tbody>${[...sent].reverse().slice(0, 15).map((x) => `<tr><td class="dim">${new Date(x.at).toLocaleTimeString()}</td><td>${esc(x.what)}</td><td class="mono">${x.matchId ? esc(x.matchId.slice(0, 12)) + '…' : '—'}</td><td>${ex('tx', x.tx, 14)}</td><td class="num">${x.gasUsed?.toLocaleString() ?? '—'}</td><td>${x.ok === true ? '<span class="tag live">mined</span>' : x.ok === false ? '<span class="tag court">reverted</span>' : '<span class="tag">pending</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No transactions from this key since start. Commits, settles and attests appear here as ranked matches are played.</div>'}
      ${f.recent.length ? `<div class="source">Recent finals: ${f.recent.slice(-5).reverse().map((r) => `<a class="link mono" href="#/match/${esc(r.matchId)}" title="match receipt">${esc(r.matchId.slice(0, 10))}…</a> ${esc(r.status)}${r.tx ? ' ' + ex('tx', r.tx, 8) : ''}`).join(' · ')}</div>` : ''}
      ${f.rooms.length ? `<div class="source">Rooms held: ${f.rooms.map((r) => `<span class="mono">${esc(r.room)}</span> ${esc(r.state)}${r.ours ? ' (host)' : r.seated ? ' (seat)' : ''}`).join(' · ')}</div>` : ''}` : '';
  const eventsHtml = f ? (f.events.length ? `<div class="events">${[...f.events].reverse().slice(0, 12).map((e) => `<div><time>${new Date(e.t).toLocaleTimeString()}</time><span class="mono dim">${esc(e.type)}</span><span>${esc(describeEvent(e))}</span></div>`).join('')}</div>` : '<div class="empty">Nothing yet.</div>') : '';

  const tabs = {
    overview: [f ? panel('Setup', checklistHtml, `<span class="tag ${open ? 'hosted' : 'live'}">${open ? `${open} open` : 'all done'}</span>`, 's6') : panel('7-day uptime', uptimeWeek(), '', 's6'),
      panel('This node', identity + fleetNote, updateBtn, 's6')],
    wallet: [purse ? panel('Hot key · gas', purseHtml, '', 's6') : '', panel('Operator', operatorPanel(h), '', 's6'), panel('Publisher', publisherPanel(h), '', purse ? 's12' : 's6')],
    network: [f ? panel('Reach', reachHtml, '', 's6') : '', f ? panel('Chain', chainHtml, `<a class="more" target="_blank" rel="noopener" href="${esc(CHAIN.explorer)}">explorer ›</a>`, 's6') : '',
      panel('Peers', peersHtml, f ? '<span class="dim">ping measured on gossip, every second</span>' : '', 's12'), panel('Seeds on chain', seedsTable(), '', 's12')],
    activity: [f ? panel('Settlement work', workHtml, '', 's12') : '', f ? panel('Events', eventsHtml, '', 's6') : '', panel('7-day uptime', uptimeWeek(), '', f ? 's6' : 's12')],
    guide: [panel('Run a node', runANode(), '', 's12')],
  };
  const alert = { overview: open > 0, wallet: !!purse?.low };
  const count = { network: (f ? f.peers : S.peers).length };
  const nav = `<div class="subnav" role="tablist">${Object.entries(NODE_TABS).map(([k, label]) => `<button role="tab" aria-selected="${nodeTab === k}" class="${nodeTab === k ? 'on' : ''}" data-node-tab="${k}">${label}${count[k] != null ? `<small>${count[k]}</small>` : ''}${alert[k] ? '<i class="alert" title="needs attention"></i>' : ''}</button>`).join('')}</div>`;
  view('node').innerHTML = `${head}<div class="home">${nodePanel({ compact: false })}</div>${nav}<div class="home">${tabs[nodeTab].join('')}</div>`;
  bindNode();
}
function bindNode() {
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

// The Control Plane download (download.js): built once per visit; render() runs on every node poll.
function renderDownload() {
  const v = view('download');
  if (v.dataset.built) return;
  v.innerHTML = downloadPage({ panel, esc });
  v.dataset.built = '1';
  for (const c of v.querySelectorAll('[data-copy-now]')) c.addEventListener('click', () => { navigator.clipboard?.writeText(c.dataset.copyNow).then(() => { const t = c.textContent; c.textContent = 'copied ✓'; setTimeout(() => { c.textContent = t; }, 1200); }).catch(() => {}); });
}

// ═══════════════════════════════════════════════ RO3 on LITNODE launcher ══
const R3 = { params: null, listed: null, checking: false, shop: null, amount: '', tx: null, busy: '', error: '', done: null };
let r3Html = '';   // the page last drawn (renderRo3)
const r3Profile = () => { const p = ro3.signedProfile(Ai.me.session, player?.id); return p.ok ? p : null; };
function renderRo3() {
  if (R3.params?.state !== route.ro3?.state) Object.assign(R3, { params: route.ro3, listed: null, checking: false, shop: null, amount: '', tx: null, busy: '', error: '', done: null });
  // The server to link on is checked against this page's own node, never taken from the URL (cabinet/ro3.js).
  if (R3.params?.realm && !R3.listed && !R3.checking && !R3.error) {
    R3.checking = true;
    ro3.listedRealm({ nodeUrl: nodeUrl(), realm: R3.params.realm, serverId: R3.params.serverId })
      .then(async (l) => {
        R3.listed = l;
        if (R3.params.shop && !(R3.shop = await ro3.shopInfo({ realm: l.url }))) R3.error = 'This server does not sell anything right now.';
      }, (e) => { R3.error = e.message; })
      .finally(() => { R3.checking = false; if (route.name === 'ro3') renderRo3(); });
  }
  // render() runs on every 5-s node poll: an unchanged page is left alone, so typing in its fields survives the poll;
  // a changed one (an error, sign-in done) keeps what was typed and where the cursor was.
  const html = ro3.ro3View({ ...R3, profile: r3Profile() });
  if (html === r3Html && view('ro3').firstChild) return;
  r3Html = html;
  const typed = ['ro3-account', 'ro3-password'].map((id) => [id, $(id)?.value]).filter(([, v]) => v);
  const focus = document.activeElement?.id;
  view('ro3').innerHTML = html;
  for (const [id, v] of typed) if ($(id)) $(id).value = v;
  if (focus?.startsWith('ro3-')) $(focus)?.focus();
  $('ro3-signin')?.addEventListener('click', ro3SignIn);
  $('ro3-back')?.addEventListener('click', () => ro3Return(null));
  $('ro3-link')?.addEventListener('submit', (e) => { e.preventDefault(); ro3Link(); });
  $('ro3-shop')?.addEventListener('submit', (e) => { e.preventDefault(); ro3Buy(); });
  $('ro3-claim')?.addEventListener('click', ro3Claim);
  $('ro3-zkltc')?.addEventListener('input', (e) => {   // update the quote without re-rendering the field
    R3.amount = e.target.value;
    const wei = ro3.zkltcToWei(R3.amount), gets = wei && R3.shop ? ro3.shopAmount(wei, R3.shop.priceWeiPer100) : 0;
    $('ro3-gets').textContent = gets > 0 ? `= ${gets} Sacred Relic Crystals` : '';
    e.target.form.querySelector('button[type=submit]').disabled = !(gets > 0);
  });
}
async function ro3SignIn() {
  R3.error = '';
  await signInWithAir();   // the arcade's own AIR flow: the profile, and this page's player key bound to it
  const p = ro3.signedProfile(Ai.me.session, player?.id);
  if (!p.ok) R3.error = Ai.error || p.why;
  else if (!R3.params.realm) return ro3Return(null);
  renderRo3();
}
async function ro3Link() {
  if (!R3.listed) return;
  R3.error = ''; R3.busy = `Linking your account on ${R3.listed.name}…`; renderRo3();
  try {
    const account = await ro3.linkAccount({ realm: R3.listed.url, serverId: R3.listed.serverId, account: $('ro3-account')?.value.trim(), password: $('ro3-password')?.value ?? '', player: { id: player.id, privateKey: player.kp.privateKey } });
    R3.busy = ''; return ro3Return(account);
  } catch (e) { R3.error = e?.message ?? String(e); }
  R3.busy = ''; renderRo3();
}
// The shop: pay with the browser's wallet (wallet.js), wait for litVM, then the server credits it (claim, repeatable).
async function ro3Buy() {
  const wei = ro3.zkltcToWei(R3.amount);
  if (!wei || !R3.shop) return;
  R3.error = '';
  try {
    if (!wallet.hasWallet()) throw new Error('No wallet in this browser. Install MetaMask (or another), add litVM testnet, and get test zkLTC from the faucet.');
    R3.busy = 'Confirm the payment in your wallet…'; renderRo3();
    R3.tx = await ro3.pay({ info: R3.shop, wei, playerKey: player.id, wallet });
    R3.busy = 'Waiting for litVM to confirm the payment…'; renderRo3();
    const ok = await wallet.waitForReceipt(R3.tx);
    if (ok === false) { R3.tx = null; throw new Error('The payment failed on litVM, so nothing was charged.'); }
    return await ro3Claim();
  } catch (e) { R3.error = e?.message ?? String(e); }
  R3.busy = ''; renderRo3();
}
async function ro3Claim() {
  if (!R3.tx) return;
  R3.error = ''; R3.busy = `Crediting your purchase on ${R3.listed.name}…`; renderRo3();
  try {
    const { amount } = await ro3.claim({ realm: R3.listed.url, tx: R3.tx });
    R3.busy = ''; return ro3Return(null, amount);
  } catch (e) { R3.error = e?.message ?? String(e); }
  R3.busy = ''; renderRo3();
}
function ro3Return(account, credited = null) {
  const p = r3Profile();
  if (!p) { R3.error = 'Sign in first.'; return renderRo3(); }
  R3.done = ro3.returnUrl(R3.params, p, account, credited);
  renderRo3();
  location.href = R3.done;   // to the launcher on 127.0.0.1 (a top-level navigation, as desktop apps' sign-ins do)
}

// ═══════════════════════════════════════════════ router ══
let route = { name: 'games' };
function parseRoute() {
  const h = location.hash;
  const m = h.match(/^#\/game\/([\w-]+)/);
  if (m) { const g = GAMES.find((x) => x.id === m[1]); return g ? { name: 'game', game: g } : { name: 'games' }; }
  const mr = h.match(/^#\/match\/([\w:.-]{1,128})/);
  if (mr) return { name: 'match', matchId: mr[1] };
  const name = (h.match(/^#\/(\w+)/)?.[1]) ?? 'games';
  if (name === 'characters' || name === 'inventory') return { name: 'cards', legacy: true };   // the old pages, merged into Cards
  if (name === 'ro3') return { name, ro3: ro3.ro3Params(h) };   // the RO3 on LITNODE launcher's sign-in (cabinet/ro3.js)
  return ['home', 'games', 'leaderboards', 'cards', 'node', 'build', 'download'].includes(name) ? { name } : { name: 'games' };
}
function render() {
  renderWorking();
  switch (route.name) {
    case 'home': renderHome(); break;
    case 'games': renderGames(); break;
    case 'game': renderGame(route.game); break;
    case 'leaderboards': renderLeaderboards(); break;
    case 'cards': renderCards(); break;
    case 'node': renderNode(); break;
    case 'build': renderBuild(view('build')); break;
    case 'match': renderMatch(route.matchId); break;
    case 'download': renderDownload(); break;
    case 'ro3': renderRo3(); break;
  }
}
function navigate() {
  route = parseRoute();
  if (route.legacy) window.history.replaceState(null, '', '#/cards');   // `history` here is the match-history fold
  if (route.name !== 'games' && inWindow()) exit();
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== route.name;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.view === route.name || (route.name === 'game' && a.dataset.view === 'games'));
  $('dl-btn')?.classList.toggle('active', route.name === 'download');
  if (route.name !== 'game') viewing = null;
  render();
  if (route.name === 'games' && !current) autoloadArcade();
  if (route.name === 'node' && S.online && !S.fleet) pollNode();   // /fleet is read only on this page: now, not on the next tick
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', navigate);

// One delegated click handler for everything rendered from templates.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-aw-start],[data-aw-pick],[data-aw-fs],[data-aw-tab],[data-play],[data-queue],[data-mm-stop],[data-mm-reset],[data-mm-launch],[data-lb],[data-cards],[data-cards-held],[data-node-tab],#name-btn,#avatar-btn,#wallet-btn,#air-btn,#air-link,#air-out,#me-chip,#dash-lock-btn');
  if (!t) return;
  if (t.id === 'wallet-btn') { signInWithWallet(); return; }
  if (t.dataset.awStart) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.awStart); if (g) { pickArcade(g.id); play(g, null, 'window'); $('aw')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
  else if (t.dataset.awPick) { const g = GAMES.find((x) => x.id === t.dataset.awPick); if (g && !(inWindow() && current.id === g.id)) { pickArcade(g.id); play(g, null, 'window'); } }
  else if ('awFs' in t.dataset) $('aw-screen')?.requestFullscreen?.().catch(() => {});
  else if ('awTab' in t.dataset) openInTab();
  else if (t.dataset.play) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.play); if (g) play(g); }
  else if (t.dataset.queue) { e.preventDefault(); const g = GAMES.find((x) => x.id === t.dataset.queue); if (g) findMatch(g); }
  else if ('mmStop' in t.dataset || 'mmReset' in t.dataset) stopMatchmaking();
  // Everything a title needs to run and settle the placed match (sdk/client.js):
  // the host's address to POST /ledger to, the build to sign for, the mode the
  // node will require, the participant order the log is recorded in.
  else if ('mmLaunch' in t.dataset) { if (MM.game && MM.check?.ok) play(MM.game, { matchId: MM.match.matchId, host: MM.match.host, hostAddr: MM.host?.addr ?? null, witness: MM.check.witness, wsAddr: MM.relay ?? MM.host?.wsAddr ?? null, beacon: MM.match.beacon, beaconSource: MM.match.beaconSource ?? null, participants: MM.match.participants, mode: MM.match.mode ?? null, buildHash: MM.match.buildHash ?? null, rulesetId: MM.match.rulesetId ?? MM.game.rulesetId ?? null, descriptor: MM.match.envelope ?? null }); }
  else if (t.dataset.lb) { lbTab = t.dataset.lb; render(); }
  else if (t.dataset.cards) { cardKind = t.dataset.cards; render(); }
  else if ('cardsHeld' in t.dataset) { cardHeld = !cardHeld; render(); }
  else if (t.dataset.nodeTab) { nodeTab = t.dataset.nodeTab; store('cabinet.nodeTab', nodeTab); render(); }
  else if (t.id === 'name-btn') setName();
  else if (t.id === 'air-btn' || t.id === 'air-link' || t.id === 'dash-lock-btn') signInWithAir();
  else if (t.id === 'me-chip' && air.configured() && player.kp && !Ai.me.session?.address) { e.preventDefault(); signInWithAir(); }
  else if (t.id === 'air-out') signOutAir();
  else if (t.id === 'avatar-btn') $('avatar-file').click();
});

// ═══════════════════════════════════════════════ play ══
// Shell → game: { type:'cabinet:init', version:1, player:{id,guest,name}, air:{id,email,address,tokenId,name}|null, node:{url,online}, game:{id,title},
//                 chain:{chainId, rpc, generation, contracts:{NodeDirectory:{address},NodeStake:{address},…}}   ← the CURRENT contract set: a title that discovers the mesh on its own takes these, never its own constants
//                 match?:{matchId, host, hostAddr, witness, wsAddr, beacon, beaconSource, participants, mode, buildHash, rulesetId, descriptor} }   ← present when launched from a verified placement; `descriptor` is the host's signed envelope: send it back with the ledger (sdk/client.js settle)
//                 login:'arcade'|null   ← 'arcade': this title signs in through this page (below), never with its own dialog
// Game → shell: { type:'cabinet:hello' } (ask for init) · { type:'cabinet:exit' }
// Game → shell: { type:'cabinet:sign-run', body:{ rulesetId, inputsHash } }   a single-player run's committed log
// Shell → game: { type:'cabinet:run-signed', inputsHash, player, sig } | { type:'cabinet:run-signed', inputsHash, error }
//               sig = sign('run', { rulesetId, inputsHash }) by the player key, only under the launched title's rulesetId
//
// Universal login (docs/UNIVERSAL-LOGIN.md), for titles config.js marks `login: 'arcade'`:
// Game → shell: { type:'cabinet:air', id, token?:true }   the session (and a fresh AIR token when asked)
//               { type:'cabinet:air-login', id }          open THIS page's AIR sign-in (the click in the title lends the gesture)
//               { type:'cabinet:air-logout', id }         sign the arcade out (one session, so the title is out too)
// Shell → game: { type:'cabinet:air', version:1, re?:id, signedIn, user:{id,email,address,name}|null, token?, error? }
//               re = the request it answers; without re it was pushed because the session changed.
// Answered only when the message comes from the running title's own origin, and posted only to that
// origin: the token is the arcade partner's, which the node also accepts for the player's proxy wallet.
let current = null, currentMatch = null;
let titleOrigin = null;   // the running title's origin, once it asked for the session and passed the check
// The frame the running title lives in: the fullscreen overlay, or the Arcade tab's window. One title at a time.
const overlayFrame = $('game');
let frame = overlayFrame;
const pickArcade = (id) => { arcadePick = id; };
const airOriginsOf = (g) => { const out = []; for (const u of [g?.url, ...(g?.origins ?? [])]) { try { out.push(new URL(u).origin); } catch { /* not a url */ } } return out; };
const airTitle = (origin) => current?.login === 'arcade' && air.configured() && airOriginsOf(current).includes(origin);
/** What the title is told about the session. AIR tokens rotate: a fresh one per ask, never a cached one. */
async function airState({ token = false } = {}) {
  await Promise.race([airBoot, new Promise((r) => setTimeout(r, 4000))]);
  const me = Ai.me, msg = { type: 'cabinet:air', version: 1, signedIn: !!me.loggedIn, user: me.loggedIn ? { id: me.id ?? null, email: me.email ?? null, address: me.address ?? null, name: me.session?.name ?? null } : null };
  if (me.loggedIn && token) { try { msg.token = (await air.token()) ?? null; } catch (e) { msg.token = null; msg.error = e?.message ?? String(e); } }
  return msg;
}
/** The session changed here (sign-in, sign-out, a restored session): tell the running title, if it asked before. */
async function pushAir() {
  if (!titleOrigin || !current || !frame.contentWindow) return;
  const target = frame.contentWindow, origin = titleOrigin, msg = await airState();
  if (frame.contentWindow === target && titleOrigin === origin) target.postMessage(msg, origin);
}
const sendInit = () => { if (current && frame.contentWindow) frame.contentWindow.postMessage({ type: 'cabinet:init', version: 1, login: current.login === 'arcade' && air.configured() ? 'arcade' : null, player: { id: player.id, guest: player.guest, name: player.name }, air: Ai.me.session?.address ? { id: Ai.me.id ?? null, email: Ai.me.email ?? null, address: Ai.me.session.address, tokenId: Ai.me.session.tokenId ?? null, name: Ai.me.session.name ?? null } : null, node: { url: nodeUrl(), online: S.online }, game: { id: current.id, title: current.title }, chain: { chainId: CHAIN.chainId, rpc: CHAIN.rpc, generation: CHAIN.generation, contracts: CONTRACTS.contracts }, ...(currentMatch ? { match: currentMatch } : {}) }, '*'); };
window.addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow || !e.data?.type) return;
  if (e.data.type === 'cabinet:hello') sendInit();
  if (e.data.type === 'cabinet:exit') exit();
  if (e.data.type === 'cabinet:air' || e.data.type === 'cabinet:air-login' || e.data.type === 'cabinet:air-logout') {
    if (!airTitle(e.origin)) return;   // not a first-party title at its own origin: no answer, and never a token
    titleOrigin = e.origin;
    const target = e.source, origin = e.origin, kind = e.data.type;
    let error = null;
    if (kind === 'cabinet:air-login' && !Ai.me.loggedIn) {
      // AIR's dialog lives in this page: out of fullscreen first, or it opens behind the game.
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      await signInWithAir();
      if (!Ai.me.loggedIn) error = Ai.error || 'sign-in did not complete';
    }
    if (kind === 'cabinet:air-logout' && Ai.me.loggedIn) await signOutAir();
    const reply = await airState({ token: kind === 'cabinet:air-login' || e.data.token === true });
    if (error) reply.error = error;
    if (target === frame.contentWindow) target.postMessage({ ...reply, re: e.data.id ?? null }, origin);
    return;
  }
  // The title played the placed match and handed back (agent-fighter after 21 Sep 2026): close the frame so the
  // next ranked match is placed here — a rematch inside the title would be a room no node placed.
  if (e.data.type === 'cabinet:played' && currentMatch && e.data.matchId === currentMatch.matchId) exit();
  // The title asks this shell to sign the ledger it just played (protocol 3):
  // the player key never leaves this origin. Signed only for the match this
  // shell launched, with the build it launched — a title cannot get a
  // signature over some other match or some other ruleset.
  if (e.data.type === 'cabinet:sign') {
    const b = { ...(e.data.body ?? {}) };
    // With the title's OWN input log (`entries`, what it recorded while playing), the shell computes the head
    // itself and signs that, never a head the host handed the title: a host that edited the log gets no
    // signature. A head sent beside the log must agree with it.
    if (Array.isArray(e.data.entries)) {
      let head = null;
      try { head = chainHead(e.data.entries); } catch { /* a gap or a reorder: not a log */ }
      if (!head || (b.head != null && b.head !== head)) { frame.contentWindow.postMessage({ type: 'cabinet:signed', matchId: b.matchId ?? null, error: head ? 'the host\'s head does not match the log this game recorded' : 'the log has a gap or a reorder' }, '*'); return; }
      b.head = head; b.ticks = e.data.entries.length;
    }
    const ok = currentMatch && player?.kp && b.matchId === currentMatch.matchId && (!currentMatch.buildHash || b.buildHash === currentMatch.buildHash)
      && typeof b.head === 'string' && Number.isInteger(b.ticks) && b.ticks > 0;
    if (!ok) { frame.contentWindow.postMessage({ type: 'cabinet:signed', matchId: b.matchId ?? null, error: 'not the match this shell launched' }, '*'); return; }
    const body = ledgerBody({ matchId: b.matchId, ticks: b.ticks, head: b.head, buildHash: currentMatch.buildHash ?? b.buildHash ?? null });
    const sig = await signLedger(body, player.kp);
    frame.contentWindow.postMessage({ type: 'cabinet:signed', matchId: b.matchId, player: player.id, sig }, '*');
  }
  // The title claims this player's seat on the host's gateway (protocol/challenge.js SEAT_TAG): the host
  // hands the join ticket only against the player key's signature over its one-time nonce. Signed only
  // for the match this shell launched, in its room, as this player.
  if (e.data.type === 'cabinet:sign-seat') {
    const c = e.data.challenge ?? {};
    const ok = currentMatch && player?.kp && c.matchId === currentMatch.matchId && c.room === roomCodeFor(currentMatch.matchId)
      && c.player === player.id && typeof c.nonce === 'string' && NONCE_RE.test(c.nonce);
    if (!ok) { frame.contentWindow.postMessage({ type: 'cabinet:seat-signed', matchId: c.matchId ?? null, error: 'not a seat in the match this shell launched' }, '*'); return; }
    const sig = await signSeat(c, player.kp.privateKey);
    frame.contentWindow.postMessage({ type: 'cabinet:seat-signed', matchId: c.matchId, nonce: c.nonce, player: player.id, sig }, '*');
  }
  // The title's own service asks the player to prove its arcade key outside a match (protocol/challenge.js KEY_TAG):
  // Pickle Brawl's API mints a matchmaker ticket that seats the key, not the AIR id. Signed only under the ruleset
  // of the title this shell launched, as this player, over the service's one-time nonce.
  if (e.data.type === 'cabinet:sign-key') {
    const c = e.data.claim ?? {};
    const ok = current?.rulesetId && player?.kp && typeof c.aud === 'string' && AUD_RE.test(c.aud) && typeof c.nonce === 'string' && NONCE_RE.test(c.nonce);
    if (!ok) { frame.contentWindow.postMessage({ type: 'cabinet:key-signed', nonce: c.nonce ?? null, error: current?.rulesetId ? (player?.kp ? 'aud or nonce malformed' : 'no player key yet') : 'this title names no ruleset' }, '*'); return; }
    const claim = { aud: c.aud, nonce: c.nonce, player: player.id, rulesetId: current.rulesetId };
    const sig = await signKeyProof(claim, player.kp.privateKey);
    frame.contentWindow.postMessage({ type: 'cabinet:key-signed', ...claim, sig }, '*');
  }
  // A single-player title asks this shell to sign the run log its court will commit (settlement v4, FLOOD CONTROL's
  // daily): sign('run', { rulesetId, inputsHash }) — sdk/court verifyRun is the court's check before it seats this
  // key. Only under the ruleset of the title this shell launched, so a title never gets the player's signature over
  // another title's run; no placement is involved, so nothing here is ranked.
  if (e.data.type === 'cabinet:sign-run') {
    const b = e.data.body ?? {};
    const ok = current?.rulesetId && player?.kp && b.rulesetId === current.rulesetId && /^[0-9a-f]{64}$/.test(b.inputsHash ?? '');
    if (!ok) { frame.contentWindow.postMessage({ type: 'cabinet:run-signed', inputsHash: b.inputsHash ?? null, error: current?.rulesetId ? 'not a run of the title this shell launched' : 'this title names no ruleset' }, '*'); return; }
    const sig = await signTagged(RUN_TAG, { inputsHash: b.inputsHash, rulesetId: current.rulesetId }, player.kp.privateKey);
    frame.contentWindow.postMessage({ type: 'cabinet:run-signed', inputsHash: b.inputsHash, player: player.id, sig }, '*');
  }
});
document.addEventListener('load', (e) => { if (e.target === frame) sendInit(); }, true);
/** Open a title. With `match` (from a verified placement) the title is told
 *  which relay to join: Agent Fighter's client takes the relay as ?ws=, and
 *  every title gets the full descriptor in cabinet:init. */
async function play(g, match = null, where = 'overlay') {
  if (!g.playable || !g.url) return;
  if (current) exit();
  frame = where === 'window' && $('aw-frame') ? $('aw-frame') : overlayFrame;
  current = g; currentMatch = match; titleOrigin = null;
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
  const target = frame;
  const src = await air.ssoUrl(u.href);
  if (frame !== target || current !== g) return;   // stopped or switched while the SSO token was fetched
  frame.src = src;
  if (frame === overlayFrame) $('play').hidden = false; else renderArcadeWindow();
}
function exit() {
  const wasWindow = frame !== overlayFrame;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  current = null; currentMatch = null; titleOrigin = null; frame.src = 'about:blank'; frame = overlayFrame; $('play').hidden = true;
  if (wasWindow && $('aw')) renderArcadeWindow();
}
const openInTab = () => { if (current) window.open(frame.src && frame.src !== 'about:blank' ? frame.src : current.url, '_blank', 'noopener'); };
$('play-exit').addEventListener('click', exit);
// Open the SAME url the frame has — with ?ws= ?room= ?player= when this is a
// placed match — never the bare title url, or the tab loses its relay.
$('play-tab').addEventListener('click', openInTab);
// Esc closes the fullscreen overlay only — in the window, a title may use Esc itself (and the browser's own fullscreen takes it first).
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current && frame === overlayFrame) exit(); });

// ═══════════════════════════════════════════════ boot ══
const editNode = async () => { const v = await ask({ title: 'node', label: 'litnode URL', value: nodeUrl(), placeholder: 'https://…', hint: 'the node this cabinet talks to · blank = the directory picks one' }); if (v != null) { store('cabinet.nodeUrl', v.trim().replace(/\/$/, '') || undefined); pollNode(); } };
$('node-edit').addEventListener('click', editNode);

paintBackdrop($('bg'));
player = await loadPlayer();
renderChrome();
if (air.configured() && air.remembered()) airBoot = air.rehydrate().then(() => { Ai.me = air.current(); render(); pushAir(); }).catch(() => {});
navigate();
refreshBinding().then(render);
// Read the directory now AND, when no local node answers, fall through to a
// proven seed at once. (Stamping seedsAt here used to make findSeed() wait
// a full minute: a visitor with no node saw NODE OFFLINE for 60 s.)
if (seeds.configured()) findSeed().then(render);
setInterval(() => refreshBinding().then(render), 60_000);
pollNode();
setInterval(pollNode, 5000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', () => { $('install-hint').hidden = false; });
