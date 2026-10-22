/** Pack a gauntlet title's match server into the hashed artifact the mesh fetches by hash
 *  (node/server-bundle.js has the shape and the trust boundary).
 *
 *    node tools/bundle-server.mjs gauntlets/agent-fighter.server.json [--root <checkout>] [--out servers/]
 *
 *  The spec names the checkout (`root`, overridden by --root or AF_ROOT), the TypeScript or JS entry the node
 *  spawns per match, the data files the server reads beside itself (`include`, globs with `*` per segment),
 *  and the gauntlet settings a node applies (env template, portRange, readyMs, ttlMs, ticketTtlMs,
 *  settledGraceMs). esbuild bundles the entry with every dependency inlined into one plain-JS module at the
 *  entry's own path inside the archive (so `dirname(import.meta.url)`-relative lookups still find the data), a
 *  one-line run.mjs imports it (so a `process.argv[1] === import.meta.url` main guard stays false), and the
 *  whole thing is one deterministic tar: the same checkout and esbuild give the same serverHash anywhere.
 *
 *  Writes <out>/<rulesetId>.server.tgz and <out>/<rulesetId>.server.json { rulesetId, serverHash, … }. Then:
 *    npm run sign:build -- servers/<id>.server.tgz           (a TRUSTED_PUBLISHERS attestation, optional with a registry)
 *    npm run publish:title -- set-build servers/<id>.server.json   (register the hash under the title: the publisher's wallet)
 *    GAUNTLET_SERVERS=<id>=servers/<id>.server.tgz           (node.env on the publisher's node: serve it to the mesh)
 *
 *  esbuild is litnode's devDependency; the checkout's own copy is used when litnode has none installed. */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { packBundle } from '../node/server-bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

export async function bundleServer(spec, { checkout, esbuildMain = null, log = () => {}, kind = 'server' } = {}) {
  const src = resolve(checkout ?? spec.root);
  if (!existsSync(src)) throw new Error(`checkout not found: ${src} (pass --root or set AF_ROOT)`);
  if (!spec.rulesetId || !spec.entry) throw new Error('spec needs rulesetId and entry');
  const entryAbs = join(src, spec.entry);
  if (!existsSync(entryAbs)) throw new Error(`entry not found: ${entryAbs}`);
  const main = esbuildMain ?? [join(root, 'node_modules', 'esbuild', 'lib', 'main.js'), join(src, 'node_modules', 'esbuild', 'lib', 'main.js')].find(existsSync);
  if (!main) throw new Error('esbuild not found — npm install in litnode or in the checkout');
  const { build } = await import(pathToFileURL(main).href);
  // The bundled server sits at the entry's own path (extension .mjs) so its import.meta.url-relative root is the archive root.
  const bundledPath = spec.entry.replace(/\.(m?ts|m?js|cjs)$/, '') + '.mjs';
  const r = await build({
    // absWorkingDir: esbuild's per-module path comments are relative to it, so the checkout (not wherever litnode
    // was run from) is the base and the same checkout gives the same hash on any machine (Agent Fighter hand-back, 22 Oct).
    absWorkingDir: src, entryPoints: [entryAbs], bundle: true, write: false, format: 'esm', platform: 'node', target: spec.target ?? 'node20',
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...(spec.external ?? [])],
    banner: { js: `// ${spec.rulesetId} ${kind === 'verifier' ? 'verifier' : 'match server'} · built by litnode tools/bundle-server.mjs\nimport { createRequire as __litnodeRequire } from 'node:module'; const require = __litnodeRequire(import.meta.url);` },
    legalComments: 'none', logLevel: 'silent', alias: spec.alias ?? {},
  });
  if (r.errors.length) throw new Error(r.errors.map((e) => `${e.location?.file ?? ''}: ${e.text}`).join('\n'));
  for (const w of r.warnings) log(`esbuild: ${w.text}`);
  // A server gets a one-line run.mjs (its main guard stays false); a verifier IS its module: entry exports verify().
  const files = kind === 'verifier' ? { [bundledPath]: Buffer.from(r.outputFiles[0].contents) } : { [bundledPath]: Buffer.from(r.outputFiles[0].contents), 'run.mjs': `import './${bundledPath}';\n` };
  for (const g of spec.include ?? []) for (const p of glob(src, g)) files[p] = readFileSync(join(src, p));
  let commit = null;
  try { commit = execSync('git rev-parse --short HEAD', { cwd: src, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
  const manifest = kind === 'verifier' ? {
    rulesetId: spec.rulesetId, entry: bundledPath, runtime: spec.runtime ?? { node: '>=20' },
    // The contract a challenger relies on: verify(logBytes, spec) → { finalHash, result } (docs/SETTLEMENT-STANDARD.md §11).
    exports: ['verify'], logFormat: spec.logFormat ?? null,
    source: { entry: spec.entry, ...(spec.repo ? { repo: spec.repo } : {}) },
  } : {
    rulesetId: spec.rulesetId, entry: 'run.mjs', runtime: spec.runtime ?? { node: '>=20' },
    ...pick(spec, ['env', 'portRange', 'readyMs', 'ttlMs', 'ticketTtlMs', 'settledGraceMs']),
    // No builtAt here: the manifest is inside the hashed bytes, and the same checkout must give the same hash (the sidecar carries the time).
    // No commit either: the commit that records the hash would change the hash. The sidecar carries both.
    source: { entry: spec.entry, ...(spec.repo ? { repo: spec.repo } : {}) },
  };
  const out = packBundle(manifest, files, { kind });
  return { ...out, files: Object.keys(files), bundledPath, commit };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
/** A tiny glob: `*` matches within one path segment; `**` matches any number of segments. Returns posix paths relative to base. */
export function glob(base, pattern) {
  const segs = pattern.split('/');
  const out = [];
  const walk = (dir, i) => {
    if (i === segs.length) { if (statSync(join(base, dir)).isFile()) out.push(dir); return; }
    const seg = segs[i];
    const abs = join(base, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
    if (seg === '**') { walk(dir, i + 1); for (const d of readdirSync(abs, { withFileTypes: true })) if (d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.')) walk(posix.join(dir, d.name), i); return; }
    const re = new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    for (const d of readdirSync(abs)) if (re.test(d)) walk(dir ? posix.join(dir, d) : d, i + 1);
  };
  walk('', 0);
  return out.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kind = opt('--kind') ?? 'server';
  const specFile = args.find((a) => !a.startsWith('--') && a !== opt('--root') && a !== opt('--out') && a !== opt('--kind'));
  if (!specFile || !['server', 'verifier'].includes(kind)) { console.error('usage: node tools/bundle-server.mjs <spec.json> [--kind server|verifier] [--root <checkout>] [--out dir]\n       npm run bundle:verifier -- <spec.json>   (same as --kind verifier)'); process.exit(2); }
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const checkout = opt('--root') ?? process.env.AF_ROOT ?? spec.root;
  const outDir = opt('--out') ?? join(root, kind === 'verifier' ? 'verifiers' : 'servers');
  try {
    const b = await bundleServer(spec, { checkout, log: (m) => console.error(m), kind });
    mkdirSync(outDir, { recursive: true });
    const tgz = join(outDir, `${spec.rulesetId}.${kind}.tgz`), side = join(outDir, `${spec.rulesetId}.${kind}.json`);
    if (kind === 'verifier') {
      writeFileSync(tgz, b.gz);
      writeFileSync(side, JSON.stringify({ kind: 'verifier', rulesetId: spec.rulesetId, verifierHash: b.hash, bytes: b.tar.length, gzBytes: b.gz.length, files: b.files.length, entry: b.manifest.entry, logFormat: b.manifest.logFormat, builtAt: new Date().toISOString(), source: { ...b.manifest.source, ...(b.commit ? { commit: b.commit } : {}) } }, null, 2) + '\n');
      console.log(`${tgz}  ${b.gz.length} bytes gzipped (${b.tar.length} in the archive)\nverifierHash ${b.hash}\n\nput it in the court's report:          report.commitments.verifierHash = '${b.hash}'\nregister it under the title (publisher):  npm run publish:title -- set-build ${side}\nuntil then, a node may accept it with:   VERIFIERS=${spec.rulesetId}:${b.hash}`);
      process.exit(0);
    }
    writeFileSync(tgz, b.gz);
    // Keep a publisher attestation an earlier sign:build wrote only if it is for THIS hash.
    const prev = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
    const keep = prev.serverHash === b.hash && prev.publisher ? { publisher: prev.publisher, sig: prev.sig, signedAt: prev.signedAt } : {};
    writeFileSync(side, JSON.stringify({ kind: 'server', rulesetId: spec.rulesetId, serverHash: b.hash, bytes: b.tar.length, gzBytes: b.gz.length, files: b.files.length, entry: b.manifest.entry, builtAt: new Date().toISOString(), source: { ...b.manifest.source, ...(b.commit ? { commit: b.commit } : {}) }, ...keep }, null, 2) + '\n');
    const show = (p) => { const r = root.replace(/\\/g, '/'), q = resolve(p).replace(/\\/g, '/'); return q.startsWith(`${r}/`) ? q.slice(r.length + 1) : q; };
    console.log(`${tgz}  ${b.gz.length} bytes gzipped (${b.tar.length} in the archive, ${b.files.length} files)\nserverHash ${b.hash}\n\nregister it under the title (the publisher's wallet):  npm run publish:title -- set-build ${show(side)}\nserve it from this node:                                GAUNTLET_SERVERS=${spec.rulesetId}=${show(tgz)}\noperators run it with:                                   GAUNTLET_SERVERS=${spec.rulesetId}`);
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
