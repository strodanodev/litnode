/** Quick-tunnel names resolve through Cloudflare's own resolver, never through
 *  the machine's.
 *
 *  A `*.trycloudflare.com` hostname exists the moment cloudflared prints it
 *  and reaches DNS a little later. A resolver asked in between answers
 *  NXDOMAIN and caches that for the zone's SOA minimum — 1800 s, THIRTY
 *  MINUTES — so every later lookup of that name fails for half an hour
 *  whatever the record says by then. That is what the desktop saw on 21 Sep
 *  2026 (seven hostnames in a row "never became reachable (ENOTFOUND)",
 *  rotated every three minutes, no public URL for 38 minutes), and it is
 *  what a peer sees when it reads a freshly announced URL from NodeDirectory
 *  one second before its own resolver has the record (the laptop and the
 *  Ally, blind for the same half hour).
 *
 *  Cloudflare is authoritative for the zone, so its DNS-over-HTTPS answers
 *  the instant the record exists and never carries our resolver's negative
 *  cache. `install()` patches `dns.lookup` — the function Node's fetch and
 *  net.connect resolve with — so that matching hostnames are asked of DoH
 *  first (a positive answer is cached for its TTL; a negative one is not
 *  cached at all) and of the operating system only when DoH itself is
 *  unreachable. Every other hostname goes to the operating system untouched. */
import dns from 'node:dns';

const DOH = ['https://1.1.1.1/dns-query', 'https://cloudflare-dns.com/dns-query'];
const MATCH = /\.trycloudflare\.com$/i;
const cache = new Map(); // host → { addresses: [{ address, family }], until }
let installed = false;
let dohFetch = null;

/** One DoH query. Returns { addresses, ttl } for a positive answer, [] with ttl 0 for NXDOMAIN, or throws when DoH is unreachable. */
export async function resolveDoh(host, { fetchImpl = globalThis.fetch, type = 'A' } = {}) {
  let lastErr = null;
  for (const base of DOH) {
    try {
      const r = await fetchImpl(`${base}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`doh ${r.status}`);
      const j = await r.json();
      const answers = (j.Answer ?? []).filter((a) => a.type === (type === 'AAAA' ? 28 : 1));
      return { addresses: answers.map((a) => ({ address: a.data, family: type === 'AAAA' ? 6 : 4 })), ttl: Math.max(1, Math.min(300, answers[0]?.TTL ?? 0)), status: j.Status };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('doh unreachable');
}

/** Patch dns.lookup once. `fetchImpl` is for tests (a fake DoH); `matches` widens or narrows which names go to DoH. */
export function install({ fetchImpl = globalThis.fetch, matches = MATCH, log = () => {} } = {}) {
  if (installed) return;
  installed = true; dohFetch = fetchImpl;
  const os = dns.lookup;
  const patched = function lookup(host, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    options = options ?? {};
    if (typeof host !== 'string' || !matches.test(host)) return os.call(dns, host, options, callback);
    const answer = (addresses) => {
      const list = addresses.filter((a) => !options.family || options.family === 0 || a.family === options.family);
      if (!list.length) { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; e.hostname = host; e.syscall = 'getaddrinfo'; return callback(e); }
      return options.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
    };
    const hit = cache.get(host);
    if (hit && hit.until > Date.now()) return process.nextTick(() => answer(hit.addresses));
    resolveDoh(host, { fetchImpl: dohFetch })
      .then(({ addresses, ttl }) => { if (addresses.length) cache.set(host, { addresses, until: Date.now() + ttl * 1000 }); answer(addresses); })
      .catch((e) => { log(`dns: DoH unreachable for ${host} (${e.message}) — asking the system resolver`); os.call(dns, host, options, callback); });
  };
  // net.connect and fetch read dns.lookup at call time; keep the promise flavour intact for callers that use it
  patched.__promisify__ = os.__promisify__;
  dns.lookup = patched;
  log('dns: *.trycloudflare.com resolves through Cloudflare DoH (no negative caching of new tunnel names)');
}

/** Tests: forget every cached answer. */
export const flush = () => cache.clear();
