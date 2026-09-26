/** Map the repository as a graph: every tracked file a node, every relation between them an edge.
 *
 *    node tools/project-graph.mjs              write dist/project-graph.json and dist/project-graph.html
 *    node tools/project-graph.mjs --json       print the graph to stdout, write nothing
 *
 *  Edges, by kind:
 *    import     a static or dynamic import / require between two tracked JS files
 *    loads      a JS or HTML file names another by path: new URL('./x'), join(ROOT, 'titles', 'x.mjs'), <script src>
 *    script     an npm script in package.json runs this file
 *    vendored   cabinet/protocol/X.js is a byte copy of protocol/X.js (tools/vendor-cabinet.mjs)
 *    contract   a JS file names a Solidity contract (MatchBook, NodeStake, …)
 *    doc        a Markdown file names a tracked path
 *    launcher   a portable/*.cmd runs a file or another .cmd
 *
 *  Each file also carries its size, line count, the first sentence of its header comment, how many
 *  commits touched it, and when. The findings block lists what an organizing pass should look at:
 *  import cycles, JS nothing reaches, test files npm test does not run, and the largest files.
 *  The HTML page is tools/project-graph.html with the graph inlined; it needs no server. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });

const JS = new Set(['.js', '.mjs', '.cjs']);
const TEXT = new Set([...JS, '.md', '.json', '.sol', '.cmd', '.html', '.css', '.txt', '.jsonl', '.webmanifest', '.example']);

const files = git('ls-files').split('\n').filter(Boolean).filter((f) => !f.startsWith('cabinet/vendor/'));
const tracked = new Set(files);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The area a file belongs to: its top folder, with the cabinet's vendored protocol split out. */
function groupOf(f) {
  if (f.startsWith('cabinet/protocol/')) return 'cabinet/protocol';
  if (f.startsWith('demo/')) return 'tests';
  if (f.startsWith('.claude/')) return 'skills';
  if (!f.includes('/')) return 'root';
  return f.split('/')[0];
}

/** The first sentence of a file's header comment (or its Markdown title). */
function headline(src, ext) {
  let m = null;
  if (JS.has(ext) || ext === '.sol') {
    const body = src.replace(/^\s*(?:#![^\n]*\n|\/\/ SPDX[^\n]*\n|pragma[^\n]*\n|import[^\n]*\n|\s*\n)*/, '');
    m = body.match(/^\/\*\*?([\s\S]*?)\*\//) || body.match(/^(?:\/\/[^\n]*\n)+/);
  } else if (ext === '.md') {
    m = src.match(/^#\s+(.+)/m) || src.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  } else if (ext === '.cmd') {
    m = src.match(/^(?:@echo off\s*\n)?((?:rem [^\n]*\n)+)/i);
  }
  if (!m) return '';
  const text = (m[1] ?? m[0]).replace(/^\s*(\*|\/\/\/?|rem\b)\s?(@title\s+)?/gim, '').replace(/\s+/g, ' ').trim();
  const s = text.match(/^(.{20,240}?[.!?])(?=\s+[A-Z(`"]|\s*$)/);
  return (s ? s[1] : text.slice(0, 240)).trim();
}

/** Commits and last-touched date per file, from one git log walk. */
const churn = new Map();
{
  let date = null;
  for (const line of git('log', '--format=@%cI', '--name-only', '--no-renames').split('\n')) {
    if (line.startsWith('@')) { date = line.slice(1); continue; }
    if (!line || !tracked.has(line)) continue;
    const c = churn.get(line) ?? { commits: 0, last: date };
    c.commits++;
    churn.set(line, c);
  }
}

const nodes = files.map((f) => {
  const ext = extname(f).toLowerCase();
  const bytes = statSync(join(root, f)).size;
  const src = TEXT.has(ext) && bytes < 4e6 ? readFileSync(join(root, f), 'utf8') : null;
  const c = churn.get(f) ?? { commits: 0, last: null };
  return { id: f, group: groupOf(f), ext: ext || '(none)', bytes, lines: src ? src.split('\n').length : 0,
    about: src ? headline(src, ext) : '', commits: c.commits, last: c.last, _src: src };
});
const byId = new Map(nodes.map((n) => [n.id, n]));

const edges = [];
const seen = new Set();
function edge(source, target, kind, via) {
  if (source === target || !byId.has(source) || !byId.has(target)) return;
  const k = `${source}\0${target}\0${kind}`;
  if (seen.has(k)) return;
  seen.add(k);
  edges.push(via ? { source, target, kind, via } : { source, target, kind });
}

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`, `${base}/index.mjs`]) if (tracked.has(c)) return c;
  return null;
}

/** Imports. Specifiers inside comments resolve to nothing, so a regex over the source is enough. */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const packages = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(lock.packages ?? {}).map((k) => k.replace(/^.*node_modules\//, ''))]);
packages.add('@af/core'); // Agent Fighter's engine, resolved from the AF checkout at bundle time
const external = new Map();
for (const n of nodes) {
  if (!JS.has(extname(n.id)) || !n._src) continue;
  for (const [, spec] of n._src.matchAll(IMPORT)) {
    const t = resolve(n.id, spec);
    if (t) edge(n.id, t, 'import');
    else if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      const name = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
      if (packages.has(name)) (external.get(name) ?? external.set(name, new Set()).get(name)).add(n.id);
    }
  }
}

/** Paths named in code: relative string literals (a template's ${…} matches any one path segment),
 *  <script src>/<link href> in HTML, and the literal segments of a join(ROOT, 'titles', 'tug.v1.mjs'). */
const importPairs = new Set(edges.map((e) => `${e.source}\0${e.target}`));
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function loads(from, p, dirs) {
  if (p.includes('${')) {
    const base = posix.normalize(posix.join(posix.dirname(from), p.replace(/\$\{[^}]*\}/g, '\u0001')));
    const re = new RegExp('^' + base.split('\u0001').map(escapeRe).join('[^/]+') + '$');
    for (const f of tracked) if (re.test(f) && !importPairs.has(`${from}\0${f}`)) edge(from, f, 'loads');
    return;
  }
  for (const d of dirs) {
    const t = posix.normalize(posix.join(d, p));
    if (tracked.has(t)) { if (!importPairs.has(`${from}\0${t}`)) edge(from, t, 'loads'); return; }
  }
}
for (const n of nodes) {
  const ext = extname(n.id);
  if (!n._src || !(JS.has(ext) || ext === '.html')) continue;
  const here = posix.dirname(n.id);
  for (const [, , p] of n._src.matchAll(/(['"`])(\.{1,2}\/[^'"`\s]+?)\1/g)) loads(n.id, p, [here]);
  if (ext === '.html') for (const [, p] of n._src.matchAll(/\b(?:src|href)="(?!https?:|\/\/|#|data:)([^"]+)"/g)) loads(n.id, p.replace(/^\//, ''), [here, '.']);
  for (const [, args] of n._src.matchAll(/\b(?:join|resolve)\(([^()]*)\)/g)) {
    const segs = [...args.matchAll(/'([\w.-]+)'/g)].map((m) => m[1]);
    if (segs.length && segs.at(-1).includes('.')) loads(n.id, segs.join('/'), ['.', here]);
  }
}

/** npm scripts → the file each runs. */
const scriptsOf = new Map();
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const [, f] of cmd.matchAll(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.m?js)/g)) {
    if (!tracked.has(f)) continue;
    edge('package.json', f, 'script', name);
    (scriptsOf.get(f) ?? scriptsOf.set(f, []).get(f)).push(name);
  }
}

/** The cabinet's protocol copies. */
for (const n of nodes) if (n.group === 'cabinet/protocol' && n.id.endsWith('.js')) edge(n.id, `protocol/${posix.basename(n.id)}`, 'vendored');

/** Contracts named from JS. */
const contracts = nodes.filter((n) => n.ext === '.sol').map((n) => [n.id, new RegExp(`\\b${posix.basename(n.id, '.sol')}\\b`)]);
for (const n of nodes) {
  if (!JS.has(extname(n.id)) || !n._src || n.group === 'cabinet/protocol') continue;
  for (const [id, re] of contracts) if (re.test(n._src)) edge(n.id, id, 'contract');
}

/** Paths named from Markdown and from the Windows launchers. */
const pathish = [...tracked].filter((f) => f.includes('/'));
for (const n of nodes) {
  if (!n._src) continue;
  if (n.ext === '.md') {
    for (const f of pathish) if (n._src.includes(f)) edge(n.id, f, 'doc');
    for (const [, l] of n._src.matchAll(/\]\((?!https?:|#)([^)\s#]+)/g)) {
      const t = posix.normalize(posix.join(posix.dirname(n.id), l));
      if (tracked.has(t)) edge(n.id, t, 'doc');
    }
  } else if (n.ext === '.cmd') {
    const dir = posix.dirname(n.id);
    for (const [, f] of n._src.matchAll(/([\w./\\%~-]+\.(?:m?js|cmd))/gi)) {
      const p = f.replace(/\\/g, '/').replace(/^%~dp0/i, '');
      for (const c of [posix.normalize(posix.join(dir, p)), p]) if (tracked.has(c)) { edge(n.id, c, 'launcher'); break; }
    }
    for (const [, s] of n._src.matchAll(/npm(?:\.cmd)? run ([\w:-]+)/g)) {
      const f = (pkg.scripts?.[s] ?? '').match(/((?:[\w.-]+\/)+[\w.-]+\.m?js)/)?.[1];
      if (f && tracked.has(f)) edge(n.id, f, 'launcher', `npm run ${s}`);
    }
  }
}

/** Findings. */
const imports = edges.filter((e) => e.kind === 'import');
const out = new Map(nodes.map((n) => [n.id, []]));
for (const e of imports) out.get(e.source).push(e.target);

/** Import cycles, as strongly connected components of more than one file (Tarjan). */
function cycles() {
  let i = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], found = [];
  const visit = (v) => {
    idx.set(v, i); low.set(v, i); i++; stack.push(v); on.add(v);
    for (const w of out.get(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); on.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) found.push(scc.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n.id)) visit(n.id);
  return found;
}

const testCmd = pkg.scripts?.test ?? '';
const unrunTests = nodes.filter((n) => /\.test\.mjs$/.test(n.id) && !testCmd.includes(n.id)).map((n) => n.id);

/** JS that nothing imports, loads, runs, launches, or names in docs: an entry point that lost its caller, or dead code. */
const reached = new Set(edges.filter((e) => e.kind !== 'contract' && e.kind !== 'vendored').map((e) => e.target));
const unreached = nodes.filter((n) => JS.has(extname(n.id)) && !reached.has(n.id) && n.group !== 'tests').map((n) => n.id);

/** protocol/ is pure and isomorphic: it imports nothing outside itself. */
const layerBreaks = imports.filter((e) => byId.get(e.source).group === 'protocol' && byId.get(e.target).group !== 'protocol')
  .map((e) => `${e.source} → ${e.target}`);

const largest = nodes.filter((n) => n.lines && n.ext !== '.json').sort((a, b) => b.lines - a.lines).slice(0, 10).map((n) => ({ id: n.id, lines: n.lines }));
const hottest = [...nodes].sort((a, b) => b.commits - a.commits).slice(0, 10).map((n) => ({ id: n.id, commits: n.commits }));

for (const n of nodes) {
  delete n._src;
  const s = scriptsOf.get(n.id);
  if (s) n.scripts = s;
}

const graph = {
  name: pkg.name, version: pkg.version,
  generatedAt: new Date().toISOString(),
  commit: git('rev-parse', '--short', 'HEAD').trim(),
  dirty: git('status', '--porcelain').split('\n').filter(Boolean).length,
  nodes, edges,
  external: Object.fromEntries([...external].sort().map(([k, v]) => [k, [...v].sort()])),
  findings: { cycles: cycles(), unrunTests, unreached, layerBreaks, largest, hottest },
};

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
} else {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'project-graph.json'), JSON.stringify(graph, null, 2) + '\n');
  const tpl = readFileSync(join(root, 'tools', 'project-graph.html'), 'utf8');
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  writeFileSync(join(dist, 'project-graph.html'), tpl.replace('/*__GRAPH__*/null', () => data));
  const f = graph.findings;
  console.log(`${nodes.length} files, ${edges.length} edges → dist/project-graph.html`);
  console.log(`  cycles ${f.cycles.length} · unreached JS ${f.unreached.length} · tests outside npm test ${f.unrunTests.length} · protocol layer breaks ${f.layerBreaks.length}`);
}
