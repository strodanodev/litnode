/** The daemon's face. A full-screen ANSI view of one node, drawn from the
 *  same events and state everything else reads — every hash on screen is a
 *  real one (snapshot root, delta roots, envelope signatures, block hashes).
 *
 *  Zero dependencies. Runs only when stdout is a TTY (node/cli.mjs decides);
 *  a scheduled task or a pipe gets plain log lines from formatEvent() instead.
 *  LITNODE_ASCII=1 swaps the box and glyph characters for 7-bit ones. */

const ASCII = !!process.env.LITNODE_ASCII;
const G = ASCII
  ? { self: '@', on: 'o', dim: 'o', off: '.', link: '-', in: '<', out: '>', reply: '<', queue: '#', placed: '*', settled: '=', cosign: 'v', bad: 'x', block: '#', ruleset: '~', stake: '$', log: '.', h: '-', v: '|', spark: ' .:-=+*#%@' }
  : { self: '◆', on: '●', dim: '◐', off: '○', link: '─', in: '◂', out: '▸', reply: '◃', queue: '▪', placed: '◈', settled: '■', cosign: '✓', bad: '✗', block: '⛓', ruleset: '▤', stake: '$', log: '·', h: '─', v: '│', spark: ' ▁▂▃▄▅▆▇█' };

const E = '\x1b[';
const c = {
  reset: `${E}0m`, bold: `${E}1m`, dim: `${E}2m`,
  gray: `${E}90m`, red: `${E}31m`, green: `${E}32m`, yellow: `${E}33m`, blue: `${E}34m`, magenta: `${E}35m`, cyan: `${E}36m`, white: `${E}97m`,
};
const paint = (color, s) => `${color}${s}${c.reset}`;
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const fit = (s, w) => { const v = visible(s); return v.length > w ? s.slice(0, s.length - (v.length - w) - 1) + '…' : s + ' '.repeat(w - v.length); };
const short = (h, n = 12) => (typeof h === 'string' && h.length > n ? `${h.slice(0, n)}…` : h ?? '—');
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`);
const hms = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const clock = (t) => new Date(t).toISOString().slice(11, 19);

/** One event as one line. Used by the TUI feed and by plain-log mode. */
export function formatEvent(ev, color = true) {
  const P = color ? paint : (_, s) => s;
  const hash = (h, n) => P(c.gray, short(h, n));
  const tag = (glyph, word, col) => P(col, `${glyph} ${word.padEnd(7)}`);
  switch (ev.type) {
    case 'gossip.in': return `${tag(ev.via === 'push' ? G.in : G.reply, 'gossip', c.cyan)} ${P(c.white, String(ev.from).replace(/^::ffff:/, '').padEnd(22))} hb ${ev.heartbeats} q ${ev.queue} Δ ${ev.deltas} m ${ev.matches}  ${kb(ev.bytes).padStart(6)}  ${ev.sig ? `sig ${hash(ev.sig, 16)}` : ''}`;
    case 'gossip.out': return `${tag(G.out, 'gossip', c.cyan)} ${P(c.white, `${ev.peers} peer${ev.peers === 1 ? '' : 's'}`.padEnd(22))} hb ${ev.heartbeats} q ${ev.queue} Δ ${ev.deltas} m ${ev.matches}  ${kb(ev.bytes).padStart(6)}`;
    case 'queue': return `${tag(G.queue, 'queue', c.yellow)} player ${hash(ev.playerId, 12)}  ${ev.rulesetId} ${ev.mode}  bucket ${ev.bucket}${ev.region ? `  ${ev.region}` : ''}  sig ${hash(ev.sig, 16)}`;
    case 'placed': return `${tag(G.placed, 'placed', c.green)} match ${hash(ev.matchId, 12)}  host ${hash(ev.host, 10)}  witness ${ev.witness ? hash(ev.witness, 10) : P(c.yellow, 'none')}  beacon ${ev.beacon === 'chain' ? P(c.magenta, 'chain') : P(c.yellow, ev.beacon ?? '?')}  root ${hash(ev.snapshotRoot, 12)}`;
    case 'dispute': return `${tag(G.bad, 'dispute', c.red)} match ${hash(ev.matchId, 12)}  we drew ${hash(ev.ours, 10)}  ${hash(ev.by, 10)} drew ${hash(ev.theirs, 10)}`;
    case 'settled': return `${tag(G.settled, 'settled', c.green)} ${P(c.white, ev.matchId)}  ${ev.ticks ?? '—'} ticks  root ${hash(ev.root, 16)}  ${P(ev.attestation === 'players' ? c.green : c.yellow, ev.attestation)}  sig ${hash(ev.hostSig, 16)}`;
    case 'cosigned': return `${tag(G.cosign, 'cosign', c.green)} ${P(c.white, ev.matchId)}  by ${hash(ev.witnessId, 12)}  sig ${hash(ev.sig, 16)}  (${ev.cosigners})`;
    case 'witness': return ev.ok
      ? `${tag(G.cosign, 'witness', c.green)} ${P(c.white, ev.matchId)}  replayed to root ${hash(ev.root, 16)}  co-signed ${hash(ev.sig, 16)}`
      : `${tag(G.bad, 'witness', c.red)} ${P(c.white, ev.matchId)}  DISAGREE ${ev.reason}${ev.ours ? `  ours ${hash(ev.ours, 12)} theirs ${hash(ev.theirs, 12)}` : ''}`;
    case 'block': return `${tag(G.block, 'block', c.magenta)} #${ev.number}  ${hash(ev.hash, 20)}`;
    case 'stakes': return `${tag(G.stake, 'stakes', c.magenta)} ${ev.bonded}/${ev.read} bonded`;
    case 'ruleset': return `${tag(G.ruleset, 'ruleset', c.blue)} ${ev.rulesetId} @ ${hash(ev.buildHash, 16)}  ${ev.current ? 'current' : 'held'}  ${kb(ev.bytes)}`;
    case 'revoked': return `${tag(G.bad, 'revoked', c.yellow)} key ${hash(ev.playerId, 12)} revoked by its owner ${hash(ev.owner, 10)} — queue entries refused from now`;
    case 'upnp': return ev.mapped?.length ? `${tag(G.ruleset, 'upnp', c.magenta)} ${ev.gateway} forwards ${ev.mapped.map((m) => m.external).join(', ')} · public IP ${ev.publicIp}${ev.cgnat ? P(c.red, ' — CGNAT: unreachable from the internet anyway') : ''}` : `${tag(G.bad, 'upnp', c.yellow)} ${ev.lastError ?? 'no mapping'}${ev.cgnat ? P(c.red, ' — CGNAT') : ''}`;
    case 'tunnel': return `${tag(G.ruleset, 'tunnel', c.magenta)} ${ev.which} ${ev.url ? `up at ${P(c.white, ev.url)} — in the next heartbeat` : P(c.red, 'down (falling back to the LAN address until it returns)')}`;
    case 'update': return `${tag(G.ruleset, 'update', c.yellow)} ${ev.latest} is available (running ${ev.version}) — press u to update and restart`;
    case 'restart': return `${tag(G.ruleset, 'restart', c.yellow)} restarting to run the new build`;
    case 'refused': return `${tag(G.bad, 'refused', c.red)} ${ev.what}${ev.matchId ? ` ${ev.matchId}` : ''}: ${ev.reason}`;
    case 'log': return `${tag(G.log, 'log', c.gray)} ${P(c.gray, ev.msg)}`;
    default: return `${tag(G.log, ev.type, c.gray)} ${P(c.gray, JSON.stringify(ev).slice(0, 120))}`;
  }
}

export function createTui({ chainId = null } = {}) {
  const out = process.stdout;
  const feed = [];            // last events, newest last
  const FEED_MAX = 400;
  const perSec = new Map();   // second → { msgs, bytes }
  let node = null, timer = null, showLog = false, showGossip = false, paused = false, dirty = true;
  let lastIn = null, lastOut = null; // the wire: most recent gossip each way

  const event = (ev) => {
    if (ev.type === 'gossip.in' || ev.type === 'gossip.out') {
      const s = Math.floor(ev.t / 1000); const b = perSec.get(s) ?? { msgs: 0, bytes: 0 }; b.msgs++; b.bytes += ev.bytes ?? 0; perSec.set(s, b);
      for (const k of perSec.keys()) if (k < s - 120) perSec.delete(k);
      if (ev.type === 'gossip.in') lastIn = ev; else lastOut = ev;
    }
    if (!paused) { feed.push(ev); if (feed.length > FEED_MAX) feed.shift(); }
    dirty = true;
  };
  const log = (msg) => event({ t: Date.now(), type: 'log', msg });

  const spark = (n) => {
    const now = Math.floor(Date.now() / 1000);
    const vals = Array.from({ length: n }, (_, i) => perSec.get(now - n + 1 + i)?.msgs ?? 0);
    const max = Math.max(1, ...vals);
    return vals.map((v) => G.spark[Math.min(G.spark.length - 1, Math.round((v / max) * (G.spark.length - 1)))]).join('');
  };
  const rate = () => { const now = Math.floor(Date.now() / 1000); let m = 0, b = 0; for (let i = 1; i <= 10; i++) { const x = perSec.get(now - i); if (x) { m += x.msgs; b += x.bytes; } } return { msgs: m / 10, bytes: b / 10 }; };

  const rule = (title, w) => { const t = title ? ` ${title} ` : ''; return paint(c.gray, G.h.repeat(2)) + paint(c.cyan + c.bold, t) + paint(c.gray, G.h.repeat(Math.max(0, w - 2 - visible(t).length))); };

  const render = () => {
    if (!node) return;
    const W = Math.max(80, out.columns || 100), H = Math.max(20, out.rows || 30);
    const s = node.snapshot();
    const peers = [...node.peers().values()];
    const fresh = new Set(s.peers.map((p) => p.nodeId));
    const bondedSet = new Set(s.peers.filter((p) => p.staked).map((p) => p.nodeId));
    const ch = node.chain.status();
    const deltas = node.settlement.list();
    const ep = node.settlement.epoch();
    const me = s.peers.find((p) => p.nodeId === node.nodeId);
    const inb = [...node.inbound.values()].filter((t) => Date.now() - t < 30_000).length;
    const L = [];

    // ── header
    const bonded = s.staking === 'chain' ? (me?.staked ? paint(c.green, `${G.on} bonded ${me.standing} LITVM`) : paint(c.red, `${G.off} unbonded`)) : paint(c.yellow, `${G.dim} ${s.staking}`);
    const up = node.updater?.status();
    const ver = up?.available ? paint(c.yellow, `v${node.version} → ${up.latest} available (u)`) : paint(c.gray, `v${node.version ?? '?'}`);
    L.push(`${paint(c.cyan + c.bold, `${G.self} litnode`)} ${ver}  ${paint(c.white + c.bold, short(node.nodeId, 16))}  ${paint(c.bold, node.operator)}  ${paint(c.gray, node.roles.join(G.link))}  ${paint(c.gray, node.region)}  up ${hms(Date.now() - node.startedAt)}  ${bonded}`);
    const chain = ch.offline ? paint(c.yellow, 'offline beacon') : `${paint(c.magenta, `#${ch.head ?? '?'}`)}${chainId ? paint(c.gray, ` chain ${chainId}`) : ''}${ch.lastError ? paint(c.red, ` ${ch.lastError.slice(0, 30)}`) : ''}`;
    const reach = node.inbound.size === 0 && peers.length <= 1 ? paint(c.gray, 'no peers yet') : inb ? paint(c.green, `${inb} peer${inb === 1 ? '' : 's'} reach us`) : paint(c.yellow, 'nobody reaches us (fine for a witness)');
    const tn = node.tunnels?.node?.status(), tr = node.tunnels?.relay?.status();
    const tun = tn ? paint(tn.state === 'up' ? c.magenta : c.yellow, ` ${tn.mode} tunnel ${tn.state}`) : '';
    const relay = node.wsAddr ? paint(c.magenta, ` relay ${short(node.wsAddr.replace(/^wss:\/\//, ''), 28)}${tr ? ` (${tr.state})` : ''}`) : '';
    L.push(`  ${paint(c.gray, node.addr)}${tun}${relay}  ${chain}  epoch ${s.epoch}  hour root ${paint(c.gray, short(ep.root, 12))} (${ep.count})  ${deltas.length} settled  ${reach}`);
    // constellation: self and every peer heard, fresh or not
    const stars = [paint(c.cyan + c.bold, G.self)];
    for (const p of peers.filter((p) => p.nodeId !== node.nodeId).sort((a, b) => (a.operator < b.operator ? -1 : 1)))
      stars.push(fresh.has(p.nodeId) ? (bondedSet.has(p.nodeId) || s.staking !== 'chain' ? paint(c.green, G.on) : paint(c.yellow, G.dim)) : paint(c.gray, G.off));
    L.push(`  ${stars.join(paint(c.gray, G.link.repeat(2)))}  ${paint(c.gray, `${s.peers.length} fresh${s.staking === 'chain' ? ' bonded' : ''} of ${peers.length} heard`)}`);

    // ── mesh + titles
    const half = Math.floor((W - 3) / 2), wide = W >= 120;
    const meshL = [rule('mesh', wide ? half : W)];
    for (const p of peers.sort((a, b) => (a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0))) {
      const isMe = p.nodeId === node.nodeId, f = fresh.has(p.nodeId);
      const dot = isMe ? paint(c.cyan, G.self) : f ? (bondedSet.has(p.nodeId) || s.staking !== 'chain' ? paint(c.green, G.on) : paint(c.yellow, G.dim)) : paint(c.gray, G.off);
      const skew = ((p.epoch - Math.floor(Date.now() / 2000)) * 2).toFixed(0);
      const sp = s.peers.find((x) => x.nodeId === p.nodeId);
      meshL.push(` ${dot} ${fit(p.operator, 10)} ${paint(c.gray, short(p.nodeId, 12))} ${fit(p.region ?? '', 7)} ${fit((p.roles ?? []).map((r) => r[0]).join(''), 5)} ${fit(sp?.staked ? `${sp.standing} LITVM` : s.staking === 'chain' ? '—' : 'dev', 9)} ${paint(f ? c.gray : c.yellow, `${skew}s`)}${p.wsAddr ? paint(c.magenta, ' relay') : ''}`);
    }
    const titlesL = [rule('titles', wide ? W - half - 3 : W)];
    for (const [rid, m] of Object.entries(s.manifests)) {
      const hosts = s.peers.filter((p) => p.buildHashes?.[rid] === m.buildHash && p.roles?.includes('host')).length;
      const n = deltas.filter((d) => d.rulesetId === rid).length;
      titlesL.push(` ${paint(c.blue, G.ruleset)} ${fit(rid, 18)} ${paint(c.gray, short(m.buildHash, 12))} ${fit(m.kind === 'attested' ? 'attested' : 'replay', 8)} ${hosts} host${hosts === 1 ? '' : 's'}  ${n} settled`);
    }
    if (Object.keys(s.manifests).length === 0) titlesL.push(paint(c.gray, ' no titles advertised'));
    titlesL.push(` ${paint(c.gray, 'snapshot root')} ${paint(c.white, short(s.root, 16))}  ${paint(c.gray, `staking ${s.staking}`)}`);
    if (wide) { const n = Math.max(meshL.length, titlesL.length); for (let i = 0; i < n; i++) L.push(`${fit(meshL[i] ?? '', half)} ${paint(c.gray, G.v)} ${titlesL[i] ?? ''}`); }
    else L.push(...meshL, ...titlesL);

    // ── traffic
    const r = rate();
    const sparkW = Math.min(60, W - 50);
    L.push(rule(`traffic ${paint(c.cyan, spark(sparkW))} ${r.msgs.toFixed(1)} msg/s ${kb(Math.round(r.bytes))}/s${paused ? paint(c.yellow, ' PAUSED') : ''}`, W));
    // the wire: the newest envelope each way, so a real signature is always on screen
    L.push(` ${paint(c.gray, 'wire')} ${lastIn ? `${paint(c.gray, clock(lastIn.t))} ${formatEvent(lastIn)}` : paint(c.gray, 'nothing received yet')}`);
    L.push(`      ${lastOut ? `${paint(c.gray, clock(lastOut.t))} ${formatEvent(lastOut)}` : paint(c.gray, 'nothing sent yet')}`);
    const footer = 1, logH = showLog ? 8 : 0;
    const feedH = Math.max(3, H - L.length - footer - logH - (showLog ? 1 : 0));
    const shown = feed.filter((e) => e.type !== 'log' && (showGossip || (e.type !== 'gossip.in' && e.type !== 'gossip.out'))).slice(-feedH);
    for (const ev of shown) L.push(` ${paint(c.gray, clock(ev.t))} ${formatEvent(ev)}`);
    for (let i = shown.length; i < feedH; i++) L.push('');
    if (showLog) {
      L.push(rule('log', W));
      for (const ev of feed.filter((e) => e.type === 'log').slice(-logH)) L.push(` ${paint(c.gray, clock(ev.t))} ${paint(c.gray, ev.msg)}`);
    }
    if (shown.length === 0) L[L.length - feedH] = paint(c.gray, '  waiting for a queue entry, a placement, a ledger… (g shows every gossip envelope)');
    L.push(paint(c.gray, ` q quit  g ${showGossip ? 'hide' : 'show'} gossip  l ${showLog ? 'hide' : 'show'} log  p ${paused ? 'resume' : 'pause'} feed${up?.available ? '  u update' : ''}   http://localhost:${node.port}/`));

    out.write(`${E}H` + L.slice(0, H).map((l) => fit(l, W) + `${E}K`).join('\n'));
    dirty = false;
  };

  const attach = (n) => {
    node = n;
    out.write(`${E}?1049h${E}?25l${E}2J${E}H`);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      process.stdin.on('data', async (k) => {
        if (k === 'q' || k === '') { await stop(); await node.stop().catch(() => {}); process.exit(0); }
        if (k === 'l') { showLog = !showLog; dirty = true; }
        if (k === 'g') { showGossip = !showGossip; dirty = true; }
        if (k === 'u') { const s = node.updater?.status(); if (s?.available) { log(`updating to ${s.latest}…`); node.updater.apply().then(() => node.restart()).catch((e) => log(`update failed: ${e.message}`)); } else log('no update available'); }
        if (k === 'p') { paused = !paused; dirty = true; }
      });
    }
    out.on('resize', () => { out.write(`${E}2J`); dirty = true; });
    timer = setInterval(() => { if (dirty || Date.now() % 1000 < 350) render(); }, 250);
    render();
  };
  const stop = async () => { clearInterval(timer); out.write(`${E}?25h${E}?1049l`); if (process.stdin.isTTY) process.stdin.setRawMode(false); };
  return { event, log, attach, stop, formatEvent };
}
