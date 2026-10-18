/** Server bundles: a gauntlet title's match server as a hashed artifact,
 *  fetched from peers like a ruleset and run by node/gauntlet.js.
 *
 *  WHY. A title's RULESET already travels by hash: TitleRegistry pins it,
 *  nodes fetch it from any peer and run it in the sandbox. A title whose
 *  match server is a PROCESS (Agent Fighter, Pickle Brawl's court) did not:
 *  gauntlets/<id>.json pointed at a checkout the operator cloned by hand, so
 *  the title was publisher-less only on nodes whose operator did that
 *  (docs/SETTLEMENT-STANDARD.md §7, audit of 19 Oct 2026). This module makes
 *  the server the second artifact of the same title.
 *
 *  THE ARTIFACT. One ustar tar, written deterministically (entries sorted
 *  by path, mtime 0, mode 0644, no owner), gzipped for transport:
 *
 *    manifest.json                       { kind: 'server', rulesetId, entry, runtime, env,
 *                                          portRange, readyMs, ttlMs, ticketTtlMs, settledGraceMs,
 *                                          builtAt, source }
 *    run.mjs                             the entry: plain JS the node's own runtime runs
 *    packages/server/src/<name>.mjs      the server, bundled by esbuild with its dependencies inlined
 *    characters/<id>/character.json …    the data files the server reads beside itself
 *
 *  No node_modules, no lockfile, no install step: everything that will
 *  execute is inside the bytes the hash covers, and a node never runs npm
 *  (nor any install script) on an operator's machine. A dependency with a
 *  native optional (ws → bufferutil) is left external; its JS fallback runs.
 *
 *  THE HASH. serverHash = sha256('server' NUL tarBytes), hex: the same
 *  tag-prefixed scheme as a ruleset's H('ruleset', source), over the
 *  UNCOMPRESSED tar, so the hash is reproducible from the same checkout
 *  and esbuild version on any machine (gzip output is not). A node
 *  gunzips, hashes, and only then looks inside.
 *
 *  THE CHAIN. The hash is registered under the title's TitleRegistry token
 *  with the existing setBuild(titleId, hash, activatesAt), and admitted by
 *  the existing buildStatus. No contract change, and no kind tag on chain,
 *  because the KIND IS IN THE HASH DOMAIN: H('server', …) and H('ruleset', …)
 *  can never collide, a ruleset served as a server bundle fails the server
 *  hash check and vice versa, and the artifact's own manifest names its
 *  rulesetId, which must match the title it was registered under. The
 *  registry only ever said "this publisher vouches for these bytes under
 *  this title"; that is still all it says. A later server bundle waits the
 *  registry's activationDelay like a ruleset retune; a revoked one stops
 *  being fetched at once.
 *
 *  THE TRUST BOUNDARY. A ruleset is admitted by the sandbox: it runs in a
 *  permission-restricted child with no network. A server bundle is a
 *  TRUSTED PROCESS: it needs a port, the network, and the node's loopback
 *  URL to settle. So it is never run on a node that did not opt in
 *  (node.env GAUNTLET_SERVERS=<rulesetId>,…), and a bundle from a PEER is
 *  admitted only when the chain says the title's publisher registered that
 *  hash (or, without a registry, when a TRUSTED_PUBLISHERS key signed
 *  { rulesetId, buildHash: serverHash }). TITLE_TRUST=open does NOT extend
 *  to server bundles: 'open' leans on the sandbox, and a gauntlet has none.
 *  The operator's own file (GAUNTLET_SERVERS=<id>=<path>) is the operator's
 *  choice and loads regardless, as RULESETS do. Inside the archive, paths
 *  are relative, contain no '..', and only regular files are unpacked: a
 *  bundle with a symlink or a device is refused before anything is written.
 *
 *  ON DISK. <dataDir>/servers/<hash>.tgz (the bytes served to peers),
 *  <hash>.json (rulesetId, publisher, sig, origin) and <hash>/ (unpacked).
 *  Never evicted, like rulesets: a match settled by a bundle stays
 *  reproducible for as long as one node kept the bytes.
 *
 *  Pure helpers here; the node's fetch, trust gate and run are in
 *  node/litnode.js (installServer, hydrateServers) and the config a bundle
 *  becomes is a plain gauntlet config (configFromBundle). The publisher
 *  packs with tools/bundle-server.mjs. */
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

export const SERVER_TAG = 'server';
export const MANIFEST_NAME = 'manifest.json';
/** A bundle larger than this is not fetched: a server is a few MB of JS and JSON. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const BLOCK = 512;

/** serverHash: sha256 over 'server' NUL tar bytes, lowercase hex. */
export const serverHash = (tarBytes) => createHash('sha256').update(`${SERVER_TAG}\0`).update(tarBytes).digest('hex');

// ------------------------------------------------------------------ paths
/** What is wrong with an archive path, or null: relative, forward slashes, no '..' or '.' segments, no NUL, ≤ 255 chars. */
export const pathProblem = (p) => {
  if (typeof p !== 'string' || !p.length) return 'empty path';
  if (p.length > 255) return 'path longer than 255 characters';
  if (p.includes('\0')) return 'NUL in path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return `bad path segment in ${JSON.stringify(p)}`;
  return null;
};

// ------------------------------------------------------------------ tar (ustar), deterministic
const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
const splitName = (p) => {
  if (p.length <= 100) return [p, ''];
  // ustar prefix: split at a '/' so that name ≤ 100 and prefix ≤ 155.
  for (let i = p.length - 101; i >= 0; i--) if (p[i] === '/' && i <= 155) return [p.slice(i + 1), p.slice(0, i)];
  throw new Error(`path cannot be stored in a ustar header: ${p}`);
};
const header = (p, size) => {
  const [name, prefix] = splitName(p);
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(0o644, 8), 100);      // mode
  b.write(octal(0, 8), 108);          // uid
  b.write(octal(0, 8), 116);          // gid
  b.write(octal(size, 12), 124);
  b.write(octal(0, 12), 136);         // mtime: 0, so the same files give the same bytes
  b.write('        ', 148);           // checksum placeholder
  b.write('0', 156);                  // regular file
  b.write('ustar\0', 257); b.write('00', 263);
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
};
/** Pack { path → Buffer|string } into a tar. Entries are sorted by path; the output is a pure function of the inputs. */
export function packTar(files) {
  const parts = [];
  for (const p of Object.keys(files).sort()) {
    const problem = pathProblem(p);
    if (problem) throw new Error(`bundle: ${problem}`);
    const data = Buffer.isBuffer(files[p]) ? files[p] : Buffer.from(String(files[p]), 'utf8');
    parts.push(header(p, data.length), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
const field = (b, off, len) => { const s = b.subarray(off, off + len); const nul = s.indexOf(0); return (nul >= 0 ? s.subarray(0, nul) : s).toString('utf8'); };
/** Unpack a tar into { path → Buffer }. Only regular files; a directory entry is skipped; anything else (a
 *  symlink, a hard link, a device, a GNU long name) refuses the whole archive. Paths are checked as above. */
export function unpackTar(buf) {
  const out = {};
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break; // end-of-archive
    const type = String.fromCharCode(h[156] || 48);
    const name = field(h, 0, 100), prefix = h.subarray(257, 262).toString() === 'ustar' ? field(h, 345, 155) : '';
    const p = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bundle: bad size for ${p}`);
    let sum = 0; for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (parseInt(field(h, 148, 8).trim(), 8) !== sum) throw new Error(`bundle: bad header checksum at ${p || off}`);
    off += BLOCK;
    const next = off + Math.ceil(size / BLOCK) * BLOCK;
    if (type === '5') { off = next; continue; }
    if (type !== '0' && type !== '\0') throw new Error(`bundle: entry ${JSON.stringify(p)} is not a regular file (type ${JSON.stringify(type)}): refused`);
    const problem = pathProblem(p.replace(/\/+$/, ''));
    if (problem) throw new Error(`bundle: ${problem}`);
    if (off + size > buf.length) throw new Error(`bundle: truncated at ${p}`);
    if (p in out) throw new Error(`bundle: ${p} appears twice`);
    out[p] = Buffer.from(buf.subarray(off, off + size));
    off = next;
  }
  return out;
}
export const gzip = (buf) => gzipSync(buf, { level: 9 });
export const gunzip = (buf) => gunzipSync(buf, { maxOutputLength: MAX_BUNDLE_BYTES });

// ------------------------------------------------------------------ manifest
const RID_RE = /^[a-z0-9][a-z0-9-]*\.v[0-9]+$/;
const num = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** What is wrong with a server manifest, or null. `files` (the archive's paths) checks the entry exists. */
export function manifestProblem(m, files = null) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest.json is not an object';
  if (m.kind !== 'server') return `kind must be "server" (got ${JSON.stringify(m.kind)})`;
  if (typeof m.rulesetId !== 'string' || !RID_RE.test(m.rulesetId) || m.rulesetId.length > 64) return 'rulesetId must be <name>.v<n>, 1–64 characters';
  const ep = pathProblem(m.entry);
  if (ep) return `entry: ${ep}`;
  if (!/\.(m?js|cjs)$/.test(m.entry)) return 'entry must be a .mjs/.js/.cjs file: the node runs it with its own runtime';
  if (files && !(m.entry in files)) return `entry ${m.entry} is not in the archive`;
  if (m.runtime != null) {
    if (typeof m.runtime !== 'object' || (m.runtime.node != null && !/^>=\s*\d+(\.\d+)*$/.test(String(m.runtime.node)))) return 'runtime.node must look like ">=22"';
  }
  if (m.env != null) {
    if (typeof m.env !== 'object' || Array.isArray(m.env)) return 'env must be an object';
    for (const [k, v] of Object.entries(m.env)) if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > 4096) return `env.${k}: names are UPPER_SNAKE, values strings`;
    for (const k of ['OPERATOR_KEY', 'DEPLOYER_KEY', 'PUBLISHER_KEY', 'ADMIN_KEY']) if (k in m.env) return `env.${k}: a bundle never names an operator secret`;
  }
  if (m.portRange != null && !(Array.isArray(m.portRange) && m.portRange.length === 2 && num(m.portRange[0], 1024, 65535) && num(m.portRange[1], m.portRange[0], 65535))) return 'portRange must be [lo, hi] within 1024–65535';
  for (const k of ['readyMs', 'ttlMs', 'ticketTtlMs', 'settledGraceMs']) if (m[k] != null && !num(m[k], 0, 24 * 3600_000)) return `${k} must be an integer number of ms (≤ 24 h)`;
  return null;
}
/** Does this node's runtime satisfy manifest.runtime.node (">=22")? Only the major is compared. */
export const runtimeOk = (m, version = process.versions.node) => { const want = /^>=\s*(\d+)/.exec(String(m?.runtime?.node ?? ''))?.[1]; return !want || Number(version.split('.')[0]) >= Number(want); };

/** Open a gzipped bundle: gunzip, hash, unpack, read and check the manifest. Throws on any refusal, BEFORE anything is
 *  written anywhere. Returns { tar, hash, files, manifest }. */
export function openBundle(gzBytes, expectedHash = null) {
  if (gzBytes.length > MAX_BUNDLE_BYTES) throw new Error(`bundle: ${gzBytes.length} bytes compressed, over the ${MAX_BUNDLE_BYTES} limit`);
  let tar;
  try { tar = gunzip(gzBytes); } catch (e) { throw new Error(`bundle: not a gzip archive (${e.message})`); }
  const hash = serverHash(tar);
  if (expectedHash && hash !== expectedHash) throw new Error(`server bundle hash mismatch: expected ${expectedHash.slice(0, 12)} got ${hash.slice(0, 12)}`);
  // From here on the bytes ARE the pinned bundle: a refusal is the bundle's own fault, and permanent — no peer
  // can serve better bytes for this hash (node/litnode.js remembers it and never asks again).
  try {
    const files = unpackTar(tar);
    if (!(MANIFEST_NAME in files)) throw new Error('bundle: no manifest.json');
    let manifest;
    try { manifest = JSON.parse(files[MANIFEST_NAME].toString('utf8')); } catch (e) { throw new Error(`bundle: manifest.json is not JSON (${e.message})`); }
    const problem = manifestProblem(manifest, files);
    if (problem) throw new Error(`bundle: ${problem}`);
    return { tar, hash, files, manifest };
  } catch (e) { throw permanent(e); }
}
/** Mark a refusal as the bundle's own (its bytes verified; its content is wrong): never retried. */
export const permanent = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { permanent: true });

/** Write unpacked files under `dir` (created). Paths were checked by unpackTar; this only joins them. */
export function writeFiles(dir, files) {
  for (const [p, data] of Object.entries(files)) {
    const target = join(dir, ...p.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/** Pack a server bundle: `files` is { archivePath → Buffer|string } WITHOUT the manifest; the manifest is added as
 *  manifest.json. Returns { tar, gz, hash, manifest }. */
export function packBundle(manifest, files) {
  const m = { kind: 'server', ...manifest };
  const problem = manifestProblem(m, { ...files, [MANIFEST_NAME]: true });
  if (problem) throw new Error(`bundle: ${problem}`);
  const tar = packTar({ ...files, [MANIFEST_NAME]: JSON.stringify(m, null, 2) + '\n' });
  return { tar, gz: gzip(tar), hash: serverHash(tar), manifest: m };
}

/** The gauntlet config (node/gauntlet.js) a held bundle becomes on this node: the node's own runtime runs the entry
 *  from the unpacked directory; the manifest's env, ports and timings apply; `stateDir` is a per-title directory
 *  the process may keep a key or a cache in (${stateDir} / GAUNTLET_STATE_DIR). */
export function configFromBundle({ dir, manifest, hash }, { stateDir = null } = {}) {
  return {
    command: '${node}', args: [join(dir, ...manifest.entry.split('/'))], cwd: dir,
    env: { ...(manifest.env ?? {}) },
    portRange: manifest.portRange ?? [7820, 7859], readyMs: manifest.readyMs ?? 60_000, ttlMs: manifest.ttlMs ?? 15 * 60_000, ticketTtlMs: manifest.ticketTtlMs ?? 10 * 60_000, settledGraceMs: manifest.settledGraceMs ?? 3000,
    stateDir, bundle: hash,
  };
}

/** Parse node.env GAUNTLET_SERVERS=<rulesetId>[=<path to .tgz>],… into { rulesetId: path|null }. A bare id opts in
 *  to fetching the title's bundle from peers; a path is the operator's own file (the publisher's node). */
export function parseServerOptIns(spec, { root = process.cwd() } = {}) {
  const out = {};
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const rid = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!RID_RE.test(rid)) throw new Error(`GAUNTLET_SERVERS: ${JSON.stringify(rid)} is not a rulesetId (<name>.v<n>)`);
    const file = eq < 0 ? null : part.slice(eq + 1).trim();
    out[rid] = file ? (file.startsWith('/') || /^[A-Za-z]:/.test(file) ? file : posix.join(root.replace(/\\/g, '/'), file)) : null;
  }
  return out;
}
