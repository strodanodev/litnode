/** Gauntlet loops: a title's headless match server, run BY THE NODE for
 *  each match the node hosts — the litepaper's "spins up on a node when a
 *  match is requested … then it dies", for titles whose simulation is a
 *  process rather than a replayable file (Pickle Brawl's court).
 *
 *  For every placement that names this node as host and whose rulesetId
 *  has a gauntlet config, the node:
 *    1. spawns the configured command on a free local port, with the match
 *       in its environment (a per-match seat secret, the seats it will admit,
 *       its public URL, the node's loopback URL for its outcome report);
 *    2. mints one join ticket per placed player (HMAC over the seat claims,
 *       the format Pickle Brawl's court verifies at its gate);
 *    3. serves the tickets and proxies WebSocket connections for the match's
 *       room on ONE gateway port — the port the node's relay tunnel fronts
 *       and advertises as wsAddr — so every match is reachable at
 *       wss://<wsAddr>/<room> without a tunnel per process;
 *    4. ends the process when the match settles on this node, or after its
 *       time to live.
 *
 *  Paths the gateway does not know go to `upstream` (a title's own relay
 *  on this machine, e.g. Agent Fighter's), so one wsAddr serves both.
 *
 *  Config, one object per rulesetId (node.env GAUNTLETS=<id>=<json path>,…):
 *    { "command": "node", "args": ["…/tsx/dist/cli.mjs", "services/court/src/court.ts"],
 *      "cwd": "E:/…/PickleBrawl",
 *      "env": { "PORT": "${port}", "COURT_TICKET_SECRET": "${secret}", "COURT_PUBLIC_URL": "${publicUrl}",
 *               "LITNODE_SEATS": "${seats}", "LITNODE_URL": "${nodeUrl}", "COURT_IDENTITY": "…" },
 *      "portRange": [7777, 7787], "readyMs": 90000, "ttlMs": 900000, "ticketTtlMs": 600000, "settledGraceMs": 3000 }
 *
 *  Nothing here runs title code in the node process; the child is the
 *  publisher's own server, isolated exactly as far as a process is. */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { roomCodeFor } from '../protocol/pairing.js';

const ROOM_RE = /^\/(LIT-[0-9A-F]{32})(\/ticket)?\/?$/;

/** PB-compatible join ticket: base64url(claims JSON) '.' base64url(HMAC-SHA256(payload, secret)). */
export const mintTicket = (claims, secret) => { const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`; };
export const verifyTicket = (ticket, secret) => {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  if (createHmac('sha256', secret).update(payload).digest('base64url') !== ticket.slice(dot + 1)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
};

/** Seats for 2 (singles: one per team) or 4 (doubles: two per team) placed players, in placement order. */
export const seatsFor = (participants) => {
  const n = participants.length;
  const mode = n <= 2 ? 'singles' : 'doubles';
  const per = n <= 2 ? 1 : 2;
  return { mode, seats: participants.map((sub, i) => ({ sub, team: Math.floor(i / per) % 2, slot: i % per })) };
};

/** Load GAUNTLETS=<rulesetId>=<path>[,…] into { rulesetId: config }. */
export function loadGauntletConfigs(spec, { root = process.cwd() } = {}) {
  const out = {};
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`GAUNTLETS: expected <rulesetId>=<path>, got "${part}"`);
    const rid = part.slice(0, eq).trim(), file = part.slice(eq + 1).trim();
    const path = file.startsWith('/') || /^[A-Za-z]:/.test(file) ? file : `${root}/${file}`;
    if (!existsSync(path)) throw new Error(`GAUNTLETS: ${rid}: ${path} not found`);
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (!cfg.command) throw new Error(`GAUNTLETS: ${rid}: "command" required`);
    out[rid] = { cwd: root, env: {}, portRange: [7777, 7787], readyMs: 90_000, ttlMs: 15 * 60_000, ticketTtlMs: 10 * 60_000, settledGraceMs: 3000, args: [], ...cfg };
  }
  return out;
}

const portFree = (port) => new Promise((res) => { const s = createTcpServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
const canConnect = (port) => new Promise((res) => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });

export function createGauntlets({ configs = {}, port = null, host = '0.0.0.0', upstream = null, nodeUrl, wsAddr = () => null, nodeId = null, log = () => {}, emit = () => {}, spawnImpl = spawn }) {
  const active = new Map();   // matchId → run
  const rooms = new Map();    // room → run
  const used = new Set();
  let server = null, actualPort = null;
  const sockets = new Set();  // proxied (upgraded) sockets: server.close() does not track these

  const publicWs = (room) => { const w = wsAddr(); return `${w ?? `ws://127.0.0.1:${actualPort}`}/${room}`; };
  const fill = (v, vars) => String(v).replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `\${${k}}`));

  const allocPort = async ([lo, hi]) => { for (let p = lo; p <= hi; p++) if (!used.has(p) && (await portFree(p))) { used.add(p); return p; } throw new Error(`no free port in ${lo}-${hi}`); };

  /** Start a gauntlet for a placement this node hosts. Idempotent per matchId. */
  const start = async ({ matchId, rulesetId, participants, mode: placedMode = null }) => {
    const cfg = configs[rulesetId];
    if (!cfg || active.has(matchId)) return active.get(matchId) ?? null;
    const room = roomCodeFor(matchId);
    const { mode, seats } = seatsFor(participants);
    const secret = randomBytes(32).toString('hex');
    const run = { matchId, rulesetId, room, mode, placedMode, seats, secret, port: null, pid: null, state: 'starting', startedAt: Date.now(), exitCode: null, lastError: null, tickets: {}, timer: null, child: null };
    active.set(matchId, run); rooms.set(room, run);
    try {
      run.port = await allocPort(cfg.portRange);
      const vars = { port: run.port, secret, publicUrl: publicWs(room), seats: JSON.stringify(seats), matchId, room, nodeUrl, mode, placedMode: placedMode ?? 'casual', rulesetId };
      const env = { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, fill(v, vars)])), GAUNTLET_MATCH_ID: matchId, GAUNTLET_ROOM: room, GAUNTLET_PORT: String(run.port), GAUNTLET_SECRET: secret, GAUNTLET_SEATS: vars.seats, GAUNTLET_PUBLIC_URL: vars.publicUrl, GAUNTLET_NODE_URL: nodeUrl, GAUNTLET_MODE: mode, GAUNTLET_PLACED_MODE: vars.placedMode };
      const child = spawnImpl(cfg.command, cfg.args.map((a) => fill(a, vars)), { cwd: cfg.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      run.child = child; run.pid = child.pid ?? null;
      const tail = (d) => { const line = String(d).trim().split('\n').pop(); if (line) run.lastLine = line.slice(0, 200); };
      child.stdout?.on('data', tail); child.stderr?.on('data', tail);
      child.on('error', (e) => { run.lastError = e.message; run.state = 'failed'; log(`gauntlet ${rulesetId} ${matchId.slice(0, 12)}: ${e.message}`); });
      child.on('exit', (code) => { run.exitCode = code; if (run.state !== 'stopped') { run.state = code === 0 ? 'exited' : 'failed'; emit('gauntlet', { matchId, rulesetId, state: run.state, code }); } used.delete(run.port); rooms.delete(room); clearTimeout(run.timer); });
      const exp = Date.now() + cfg.ticketTtlMs;
      for (const s of seats) run.tickets[s.sub] = { ticket: mintTicket({ sub: s.sub, matchId, team: s.team, slot: s.slot, mode, exp }, secret), team: s.team, slot: s.slot, exp };
      const t0 = Date.now();
      while (Date.now() - t0 < cfg.readyMs && run.state === 'starting') { if (await canConnect(run.port)) break; await new Promise((r) => setTimeout(r, 250)); }
      if (run.state !== 'starting') throw new Error(run.lastError ?? `process ended before listening (${run.lastLine ?? 'no output'})`);
      if (!(await canConnect(run.port))) { child.kill(); throw new Error(`not listening on ${run.port} after ${cfg.readyMs} ms (${run.lastLine ?? 'no output'})`); }
      run.state = 'up';
      run.timer = setTimeout(() => stop(matchId, 'ttl'), cfg.ttlMs);
      run.timer.unref?.();
      log(`gauntlet ${rulesetId} ${matchId.slice(0, 12)}: up on :${run.port} as ${vars.publicUrl} (${mode}, ${seats.length} seats, pid ${run.pid})`);
      emit('gauntlet', { matchId, rulesetId, state: 'up', port: run.port, room, publicUrl: vars.publicUrl, seats: seats.length });
      return run;
    } catch (e) {
      run.state = 'failed'; run.lastError = e.message;
      log(`gauntlet ${rulesetId} ${matchId.slice(0, 12)}: failed — ${e.message}`);
      emit('gauntlet', { matchId, rulesetId, state: 'failed', error: e.message });
      if (run.port) used.delete(run.port);
      rooms.delete(room);
      return run;
    }
  };

  const stop = (matchId, why = 'stopped') => {
    const run = active.get(matchId);
    if (!run) return false;
    clearTimeout(run.timer);
    if (run.state === 'up' || run.state === 'starting') { run.state = 'stopped'; try { run.child?.kill(); } catch { /* already gone */ } log(`gauntlet ${run.rulesetId} ${matchId.slice(0, 12)}: ${why}`); emit('gauntlet', { matchId, rulesetId: run.rulesetId, state: 'stopped', why }); }
    if (run.port) used.delete(run.port);
    rooms.delete(run.room);
    active.delete(matchId);
    return true;
  };

  // --------------------------------------------------------------- gateway
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  const handle = (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health' || url.pathname === '/') return json(res, 200, status());
    const m = ROOM_RE.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'unknown room' });
    const run = rooms.get(m[1]);
    if (!run) return json(res, 404, { error: 'no gauntlet for this room (not placed here, ended, or timed out)' });
    if (m[2]) {
      const player = url.searchParams.get('player') ?? '';
      const t = run.tickets[player];
      if (!t) return json(res, 403, { error: 'not a placed player of this match', seats: run.seats.map((s) => s.sub) });
      return json(res, 200, { ticket: t.ticket, ws: publicWs(run.room), matchId: run.matchId, rulesetId: run.rulesetId, mode: run.mode, team: t.team, slot: t.slot, exp: t.exp, state: run.state });
    }
    json(res, 200, { room: run.room, matchId: run.matchId, state: run.state, mode: run.mode, seats: run.seats.length, ws: publicWs(run.room) });
  };
  /** Raw WebSocket proxy: replay the client's upgrade request to the target with the path
   *  rewritten to '/', then pipe bytes both ways. Protocol-agnostic. */
  const proxyUpgrade = (req, socket, head, target) => {
    const up = connect(target.port, target.host ?? '127.0.0.1');
    sockets.add(socket); sockets.add(up);
    up.once('connect', () => {
      const lines = [`GET ${target.path ?? '/'} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) if (k !== 'host') lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      lines.push(`host: ${target.host ?? '127.0.0.1'}:${target.port}`, '', '');
      up.write(lines.join('\r\n'));
      if (head?.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    const drop = () => { sockets.delete(socket); sockets.delete(up); try { socket.destroy(); } catch {} try { up.destroy(); } catch {} };
    up.on('error', drop); socket.on('error', drop); up.on('close', drop); socket.on('close', drop);
  };
  const onUpgrade = (req, socket, head) => {
    const m = ROOM_RE.exec(new URL(req.url, 'http://x').pathname);
    const run = m ? rooms.get(m[1]) : null;
    if (run && run.state === 'up') return proxyUpgrade(req, socket, head, { port: run.port });
    if (upstream) { const u = new URL(upstream); return proxyUpgrade(req, socket, head, { host: u.hostname, port: Number(u.port || 80), path: req.url }); }
    socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n'); socket.destroy();
  };

  const listen = () => new Promise((res, rej) => {
    if (!port && port !== 0) return res(null);
    server = createServer(handle);
    server.on('upgrade', onUpgrade);
    server.once('error', rej);
    server.listen(port, host, () => { actualPort = server.address().port; log(`gauntlet gateway on :${actualPort}${upstream ? ` (unknown rooms → ${upstream})` : ''}: ${Object.keys(configs).join(', ') || 'no titles configured'}`); res(actualPort); });
  });

  const status = () => ({ port: actualPort, upstream, titles: Object.keys(configs), active: [...active.values()].map((r) => ({ matchId: r.matchId, rulesetId: r.rulesetId, room: r.room, state: r.state, mode: r.mode, seats: r.seats.length, port: r.port, pid: r.pid, since: new Date(r.startedAt).toISOString(), lastError: r.lastError, exitCode: r.exitCode })) });

  /** Hooks the node calls. A placement is ours when it names this node as host. */
  const onPlaced = (d) => { if (configs[d.rulesetId] && (!nodeId || d.host === nodeId)) start({ matchId: d.matchId, rulesetId: d.rulesetId, participants: d.participants, mode: d.mode ?? null }).catch(() => {}); };
  // The settlement answer is still on its way back to the court when this
  // fires; give the process a moment to receive it and tell its players
  // before it is ended (settledGraceMs, default 3 s).
  const onSettled = (matchId) => { const run = active.get(matchId); if (!run || run.ending) return; run.ending = true; const grace = configs[run.rulesetId]?.settledGraceMs ?? 3000; setTimeout(() => stop(matchId, 'settled'), grace).unref?.(); };
  const stopAll = async () => { for (const id of [...active.keys()]) stop(id, 'node stopping'); for (const s of sockets) { try { s.destroy(); } catch {} } sockets.clear(); if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); server = null; } };

  return { listen, start, stop, onPlaced, onSettled, status, stopAll, get port() { return actualPort; }, active, rooms };
}
