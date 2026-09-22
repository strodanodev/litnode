/** Publisher services (node/publisher-services.js): a title's long-lived backend, run BY THE NODE.
 *
 *  A gauntlet (node/gauntlet.js) is one process per placed match. A service
 *  is one process that stays up: a matchmaker, an accounts API, a pool of
 *  courts a matchmaker leases from. The node supervises it (restart on exit,
 *  backoff), and the gauntlet gateway publishes it at
 *
 *      https://<wsAddr host>/svc/<prefix>.<name>/...     (HTTP, proxied)
 *      wss://<wsAddr host>/svc/<prefix>.<name>/...       (WebSocket, proxied)
 *
 *  so a studio needs no hosting of its own beyond static files. The node
 *  lists what it runs at GET /svc on the gateway and in its heartbeat
 *  (`services`), which is how a game client finds it (NodeDirectory → the
 *  node's wsAddr → /svc).
 *
 *  Config: SERVICES=<bundle.json>[,<bundle.json>] in node.env. A bundle:
 *    { "prefix": "pickle-brawl", "cwd": "E:/…/PickleBrawl",
 *      "envFiles": ["services/api/.env"],                 // relative to cwd; values never logged
 *      "portRange": [8790, 8819],
 *      "services": {
 *        "api":        { "command": "${node}", "args": [...], "env": { "PORT": "${port}" }, "health": "/health" },
 *        "matchmaker": { ..., "env": { "PORT": "${port}", "COURT_URLS": "${public:court-1}" } },
 *        "court-1":    { ..., "cwd": "…", "env": { "MATCHMAKER_URL": "${local:matchmaker}", "COURT_PUBLIC_URL": "${public:court-1}" } } } }
 *  Variables: ${port} (this service) ${node} (the node's runtime) ${nodeUrl}
 *  (the node, loopback) ${local:<name>} (http://127.0.0.1:<its port>)
 *  ${public:<name>} (wss://…/svc/<prefix>.<name>) ${publicHttp:<name>}
 *  (https://…/svc/<prefix>.<name>). A service whose environment names a
 *  public address is restarted when the node's public address changes (a
 *  quick tunnel rotated), so it never hands out a dead hostname.
 *
 *  Env precedence: the node's own environment < envFiles < the service's
 *  `env`. Operator secrets (OPERATOR_KEY, DEPLOYER_KEY) are never passed. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer as createTcpServer } from 'node:net';
import { isAbsolute, join } from 'node:path';

const parseEnvFile = (text) => {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\n/g, '\n');
    out[m[1]] = v;
  }
  return out;
};

/** SERVICES=<path>[,<path>] → [bundle]. Throws on a bundle that cannot run. */
export function loadServiceBundles(spec, { root = process.cwd() } = {}) {
  const out = [];
  for (const file of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const path = isAbsolute(file) || /^[A-Za-z]:/.test(file) ? file : join(root, file);
    if (!existsSync(path)) throw new Error(`SERVICES: ${path} not found`);
    const b = JSON.parse(readFileSync(path, 'utf8'));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(b.prefix ?? '')) throw new Error(`SERVICES: ${path}: "prefix" must be a short lowercase name`);
    if (!b.services || !Object.keys(b.services).length) throw new Error(`SERVICES: ${path}: no "services"`);
    for (const [name, s] of Object.entries(b.services)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`SERVICES: ${b.prefix}: bad service name "${name}"`);
      if (!s.command) throw new Error(`SERVICES: ${b.prefix}.${name}: "command" required`);
    }
    out.push({ cwd: root, envFiles: [], portRange: [8790, 8839], ...b, file: path });
  }
  return out;
}

const portFree = (port) => new Promise((res) => { const s = createTcpServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
const canConnect = (port) => new Promise((res) => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });

export function createServices({ bundles = [], nodeUrl, publicBase = () => null, log = () => {}, emit = () => {}, spawnImpl = spawn, backoffMs = [5_000, 10_000, 20_000, 40_000, 60_000], watchMs = 5_000 }) {
  const all = new Map(); // fullName → svc
  const used = new Set();
  let stopped = false, watch = null, lastBase;

  const base = () => { const b = publicBase(); return b ? b.replace(/\/+$/, '') : null; };
  const publicWs = (full, gatewayPort) => `${(base() ?? `ws://127.0.0.1:${gatewayPort ?? 0}`)}/svc/${full}`;

  for (const b of bundles) {
    const files = {};
    for (const f of b.envFiles ?? []) {
      const p = isAbsolute(f) || /^[A-Za-z]:/.test(f) ? f : join(b.cwd, f);
      if (!existsSync(p)) { log(`services ${b.prefix}: env file ${p} missing`); continue; }
      Object.assign(files, parseEnvFile(readFileSync(p, 'utf8')));
    }
    for (const [name, s] of Object.entries(b.services)) {
      const full = `${b.prefix}.${name}`;
      all.set(full, { full, name, bundle: b, cfg: { args: [], env: {}, readyMs: 120_000, ...s }, files, port: null, pid: null, child: null, state: 'off', restarts: 0, upSince: null, lastError: null, lastLine: null, usesPublic: false, timer: null });
    }
  }

  const fill = (v, svc, gatewayPort) => String(v).replace(/\$\{([a-zA-Z]+)(?::([a-z0-9-]+))?\}/g, (all_, k, arg) => {
    const other = (n) => all.get(`${svc.bundle.prefix}.${n}`);
    if (k === 'port') return String(svc.port);
    if (k === 'node') return process.execPath;
    if (k === 'nodeUrl') return nodeUrl;
    if (k === 'local' && other(arg)) return `http://127.0.0.1:${other(arg).port}`;
    if (k === 'public' && other(arg)) { svc.usesPublic = true; return publicWs(other(arg).full, gatewayPort); }
    if (k === 'publicHttp' && other(arg)) { svc.usesPublic = true; return publicWs(other(arg).full, gatewayPort).replace(/^ws/, 'http'); }
    return all_;
  });

  let gwPort = null;
  const launch = async (svc) => {
    if (stopped) return;
    const c = svc.cfg;
    svc.usesPublic = false;
    const cwd = c.cwd ? (isAbsolute(c.cwd) || /^[A-Za-z]:/.test(c.cwd) ? c.cwd : join(svc.bundle.cwd, c.cwd)) : svc.bundle.cwd;
    const own = Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, fill(v, svc, gwPort)]));
    const env = { ...process.env, ...svc.files, ...own, LITNODE_SERVICE: svc.full, LITNODE_NODE_URL: nodeUrl };
    delete env.OPERATOR_KEY; delete env.DEPLOYER_KEY; delete env.PUBLISHER_KEY;
    svc.state = 'starting'; svc.lastError = null;
    const child = spawnImpl(fill(c.command, svc, gwPort), c.args.map((a) => fill(a, svc, gwPort)), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    svc.child = child; svc.pid = child.pid ?? null;
    const tail = (d) => { const line = String(d).trim().split('\n').pop(); if (line) svc.lastLine = line.slice(0, 200); };
    child.stdout?.on('data', tail); child.stderr?.on('data', tail);
    child.on('error', (e) => { svc.lastError = e.message; });
    child.on('exit', (code) => {
      svc.child = null; svc.pid = null;
      if (stopped || svc.state === 'stopping') { svc.state = 'off'; return; }
      const wasUp = svc.state === 'up' && svc.upSince && Date.now() - svc.upSince > 60_000;
      if (wasUp) svc.restarts = 0;
      const wait = backoffMs[Math.min(svc.restarts++, backoffMs.length - 1)];
      svc.state = 'restarting'; svc.lastError = svc.lastError ?? `exited (${code}) ${svc.lastLine ?? ''}`.trim();
      log(`service ${svc.full}: exited (${code}); restarting in ${wait / 1000}s`);
      emit('service', { name: svc.full, state: 'restarting', code });
      svc.timer = setTimeout(() => void launch(svc), wait); svc.timer.unref?.();
    });
    const t0 = Date.now();
    while (Date.now() - t0 < c.readyMs && svc.child === child) { if (await canConnect(svc.port)) break; await new Promise((r) => setTimeout(r, 300)); }
    if (svc.child !== child) return; // exited while starting: the exit handler has it
    if (!(await canConnect(svc.port))) { svc.lastError = `not listening on ${svc.port} after ${c.readyMs} ms (${svc.lastLine ?? 'no output'})`; log(`service ${svc.full}: ${svc.lastError}`); try { child.kill(); } catch {} return; }
    svc.state = 'up'; svc.upSince = Date.now();
    log(`service ${svc.full}: up on :${svc.port} (pid ${svc.pid})`);
    emit('service', { name: svc.full, state: 'up', port: svc.port });
  };

  const restart = (svc, why) => {
    if (!svc.child) return;
    log(`service ${svc.full}: restarting (${why})`);
    svc.state = 'stopping';
    const child = svc.child;
    child.once('exit', () => { svc.restarts = 0; void launch(svc); });
    try { child.kill(); } catch {}
  };

  /** Allocate every port first (services refer to each other's), then start them all. */
  const start = async ({ gatewayPort = null } = {}) => {
    gwPort = gatewayPort;
    for (const svc of all.values()) {
      const [lo, hi] = svc.cfg.port ? [svc.cfg.port, svc.cfg.port] : svc.bundle.portRange;
      for (let p = lo; p <= hi && !svc.port; p++) if (!used.has(p) && (await portFree(p))) { used.add(p); svc.port = p; }
      if (!svc.port) { svc.state = 'failed'; svc.lastError = `no free port in ${lo}-${hi}`; log(`service ${svc.full}: ${svc.lastError}`); }
    }
    lastBase = base();
    await Promise.all([...all.values()].filter((s) => s.port).map((s) => launch(s)));
    // The public address moves when a quick tunnel rotates or first comes up: restart what hands it out.
    watch = setInterval(() => {
      const b = base();
      if (b === lastBase) return;
      lastBase = b;
      for (const svc of all.values()) if (svc.usesPublic && svc.child) restart(svc, `public address is now ${b ?? 'local only'}`);
    }, watchMs);
    watch.unref?.();
  };

  const stop = async () => {
    stopped = true; clearInterval(watch);
    const exits = [];
    for (const svc of all.values()) {
      clearTimeout(svc.timer);
      if (svc.child) { svc.state = 'stopping'; exits.push(new Promise((r) => { svc.child.once('exit', r); setTimeout(r, 5000).unref?.(); })); try { svc.child.kill(); } catch {} }
    }
    await Promise.all(exits);
  };

  /** For the gateway: where a /svc/<full> request goes, or null. */
  const route = (full) => { const s = all.get(full); return s && s.state === 'up' ? { port: s.port } : null; };
  const names = () => [...all.keys()].sort();
  const status = () => [...all.values()].map((s) => ({ name: s.full, state: s.state, port: s.port, pid: s.pid, restarts: s.restarts, since: s.upSince ? new Date(s.upSince).toISOString() : null, lastError: s.lastError }));
  return { start, stop, route, names, status, all };
}
