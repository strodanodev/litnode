/** A Cloudflare tunnel the node owns. Spawns cloudflared for a local port,
 *  learns the public hostname, restarts it if it dies, and tells the node —
 *  which puts the URL in its heartbeat. Gossip does the broadcasting: every
 *  peer learns the address on the next tick, no config edits anywhere.
 *
 *    quick   cloudflared tunnel --url http://127.0.0.1:<port>
 *            no account; a new *.trycloudflare.com hostname every run
 *    named   cloudflared tunnel run --url http://127.0.0.1:<port> <name>
 *            stable hostname you routed once with
 *            `cloudflared tunnel route dns <name> <host>`; needs
 *            `cloudflared tunnel login` on this machine, once
 *
 *  Cloudflare terminates TLS and passes WebSockets, so the same mechanism
 *  fronts the node (https) and a relay (wss). Zero dependencies. */
import { spawn } from 'node:child_process';

const QUICK_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** @param {object} o
 *  @param {number} o.port         local port to expose
 *  @param {string} [o.name]       named tunnel (else quick)
 *  @param {string} [o.hostname]   the named tunnel's routed host
 *  @param {(url:string|null)=>void} [o.onUrl]  called with the public https URL, or null when it drops
 *  @param {string[]} [o.bin]      executable (+ leading args); tests substitute a script */
export function createTunnel({ port, name = null, hostname = null, onUrl = () => {}, log = () => {}, bin = ['cloudflared'] }) {
  if (name && !hostname) throw new Error('a named tunnel needs its routed hostname (TUNNEL_HOST)');
  let child = null, url = null, state = 'starting', stopped = false, restarts = 0, timer = null, lastError = null;
  const label = name ? `tunnel ${name}` : 'quick tunnel';

  const announce = (u) => { if (u === url) return; url = u; state = u ? 'up' : 'down'; log(`${label}: ${u ? `${u} → 127.0.0.1:${port}` : 'down'}`); try { onUrl(u); } catch { /* observer */ } };

  const start = () => {
    if (stopped) return;
    const args = name ? ['tunnel', 'run', '--url', `http://127.0.0.1:${port}`, name] : ['tunnel', '--url', `http://127.0.0.1:${port}`];
    const [exe, ...pre] = bin;
    try { child = spawn(exe, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { lastError = e.message; state = 'missing'; log(`${label}: cannot start cloudflared (${e.message})`); return; }
    state = 'starting';
    const onText = (d) => {
      const text = String(d);
      if (!name) { const m = QUICK_RE.exec(text); if (m) announce(m[0]); }
      else if (/Registered tunnel connection|Connection .* registered/i.test(text)) announce(`https://${hostname}`);
      if (/error|failed/i.test(text) && !/INF/.test(text)) lastError = text.trim().slice(0, 200);
    };
    child.stdout.on('data', onText);
    child.stderr.on('data', onText);
    child.on('error', (e) => { lastError = e.code === 'ENOENT' ? 'cloudflared not found on PATH' : e.message; state = 'missing'; log(`${label}: ${lastError}`); child = null; });
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      announce(null);
      // Back off 5 s → 60 s. A quick tunnel comes back with a NEW hostname;
      // the heartbeat carries it and peers follow.
      const wait = Math.min(60_000, 5_000 * 2 ** Math.min(restarts++, 4));
      log(`${label}: cloudflared exited (${code}); restarting in ${wait / 1000}s`);
      timer = setTimeout(start, wait);
    });
  };
  start();

  return {
    get url() { return url; },
    status: () => ({ port, mode: name ? 'named' : 'quick', name, state, url, restarts, lastError }),
    stop() { stopped = true; clearTimeout(timer); if (child) { try { child.kill(); } catch { /* gone */ } } url = null; state = 'stopped'; },
  };
}
