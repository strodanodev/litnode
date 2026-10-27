/** RO3Emu (Ragnarok Online 3) servers hosted through the node's own free tunnel.
 *
 *  An operator who runs RO3Emu with `--tunnel-port 5480` (its loopback "tunnel front": login, server list, gate key
 *  and the two game gates as WebSockets, never the loopback admin tools) sets RO3_PORT=5480. The node then:
 *    - runs a quick tunnel to that port (node/tunnel.js): no account, no server cost;
 *    - advertises the URL in its heartbeat as `ro3: { url, name }` only once it answered GET /ro3emu/status
 *      through it, the way the node and relay tunnels are verified before they are advertised;
 *    - keeps checking it, withdraws it when it stops answering, and restarts cloudflared for a fresh hostname
 *      when it stays dead (the relay watch's lessons, node/litnode.js).
 *  Every node lists the RO3 servers its peers advertise at GET /ro3/hosts; a player's `RO3Emu.exe join litnode`
 *  asks its own node there, at start and again whenever the host's tunnel stops answering, so a host restart
 *  (a new trycloudflare name) is followed without anyone copying a link. Zero dependencies. */
import { createTunnel } from './tunnel.js';

/** A bare https origin (what a quick or named tunnel gives); anything else in a heartbeat is ignored. */
const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

/** A display name: printable, short. */
export const ro3Name = (s) => String(s ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32);

/** `ro3` from a peer's heartbeat, or null when it does not hold a usable one. */
export function ro3Entry(b) {
  const r = b?.ro3;
  if (!r || typeof r.url !== 'string' || !ORIGIN.test(r.url)) return null;
  return { url: r.url.toLowerCase(), name: ro3Name(r.name) || ro3Name(b.operator) || b.nodeId.slice(0, 12) };
}

/** @param {object} o
 *  @param {number} o.port         RO3Emu's tunnel front on this machine (--tunnel-port)
 *  @param {string} [o.name]       how players see this server (default: the operator label)
 *  @param {(url:string)=>Promise<boolean>} [o.probe]  true when RO3Emu answered through the URL (tests inject one)
 *  @param {(entry:{url:string,name:string}|null)=>void} [o.onChange]  the advertised entry, or null when withdrawn */
export function createRo3Host({ port, name, bin, log = () => {}, emit = () => {}, probe = null, onChange = () => {}, fast = false }) {
  const VERIFY_MS = fast ? 200 : 5000, GIVE_UP_MS = fast ? 3000 : 5 * 60_000, WATCH_MS = fast ? 300 : 60_000, FAILS = 3, ROTATE_FAILS = 6;
  const check = probe ?? (async (u) => {
    const r = await fetch(`${u}/ro3emu/status`, { signal: AbortSignal.timeout(8000) });
    return r.ok && (await r.json())?.online === true;
  });
  const s = { url: null, state: 'off', since: 0, checkedAt: null, lastError: null, fails: 0, rotations: 0 }; // off | verifying | up | down | unreachable
  let timer = null, tunnel = null;
  const advertised = () => (s.state === 'up' ? { url: s.url, name } : null);
  const set = (state, why) => {
    const before = advertised();
    s.state = state;
    log(`ro3: ${s.url} ${why}`); emit('tunnel', { which: 'ro3', url: s.url, state });
    if ((before?.url ?? null) !== (advertised()?.url ?? null)) onChange(advertised());
  };
  const tick = async () => {
    const u = s.url;
    if (!u) return;
    try {
      if (!(await check(u))) throw new Error('RO3Emu did not answer /ro3emu/status');
      s.fails = 0; s.lastError = null; s.checkedAt = Date.now();
      if (s.state !== 'up') { set('up', 'answers — advertising it to the mesh'); clearInterval(timer); timer = setInterval(() => void tick(), WATCH_MS); }
    } catch (e) {
      s.lastError = e.cause?.code ?? e.message; s.checkedAt = Date.now(); s.fails++;
      if (s.state === 'up' && s.fails >= FAILS) set('down', `stopped answering (${s.lastError}) — withdrawn from the heartbeat`);
      else if (s.state === 'down' && s.fails >= ROTATE_FAILS) { s.fails = 0; s.rotations++; set('down', 'still not answering — restarting cloudflared for a fresh hostname'); tunnel?.rotate(); }
      else if (s.state === 'verifying' && Date.now() - s.since > GIVE_UP_MS) { s.rotations++; set('unreachable', `never answered (${s.lastError}) — rotating the hostname`); tunnel?.rotate(); }
    }
  };
  const onUrl = (u) => {
    clearInterval(timer); timer = null;
    const before = advertised();
    Object.assign(s, { url: u, state: u ? 'verifying' : 'off', since: Date.now(), checkedAt: null, lastError: null, fails: 0 });
    if (before) onChange(null); // the old hostname is gone either way
    emit('tunnel', { which: 'ro3', url: u, state: s.state });
    if (!u) return;
    timer = setInterval(() => void tick(), VERIFY_MS);
    void tick();
  };
  tunnel = createTunnel({ port, log, bin, onUrl });
  return {
    get entry() { return advertised(); },
    status: () => ({ port, name, url: s.url, state: s.state, checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null, lastError: s.lastError, rotations: s.rotations, tunnel: tunnel.status() }),
    stop() { clearInterval(timer); timer = null; tunnel.stop(); },
  };
}
