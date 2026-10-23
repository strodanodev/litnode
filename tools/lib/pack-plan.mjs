/** What a release zip holds, derived from ONE source: the npm scripts each kind ships.
 *
 *  Before 0.11.32 the scripts map and the copy list were written separately, and they drifted: the portable zip
 *  shipped `bond-node.mjs` without the `tools/lib/rpc.mjs` it imports, and the operator zip's package.json named
 *  `delegate`, `enroll`, `authority` and `release:registry` whose files were never copied (audit 2026-10-21 §4.4).
 *  Now every script's entry file is copied together with its relative-import closure, and `checkStage` proves a
 *  staged folder is whole: every script resolves, every relative import inside it resolves, every bare import is a
 *  Node builtin or a declared dependency. demo/pack.test.mjs runs it against a real stage. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Folders copied whole (minus what git ignores). */
export const SHIPPED = ['node', 'protocol', 'sdk', 'titles', 'rulesets', 'cabinet'];

/** The scripts each kind ships. A tool is in a zip because a script names it, and only then. Maintainer tools
 *  (deploy, release, registry admin, params) stay in the source checkout: no operator runs them. */
export function scriptsFor(kind) {
  const base = { node: 'node node/cli.mjs', host: 'node sdk/host/cli.mjs', keygen: 'node tools/keygen.mjs', cabinet: 'node cabinet/serve.mjs', update: 'node tools/update.mjs', guardian: 'node tools/guardian.mjs', bond: 'node tools/bond-node.mjs' };
  if (kind === 'portable') return base;
  return {
    ...base,
    delegate: 'node tools/delegate.mjs', enroll: 'node tools/enroll.mjs', announcer: 'node tools/set-announcer.mjs',
    authority: 'node tools/authority.mjs', fleet: 'node tools/fleet.mjs', rewards: 'node tools/rewards.mjs',
  };
}

/** Launchers, readmes and data files beside the code, per kind: [from (repo-relative), to (stage-relative)]. */
export function extrasFor(kind) {
  const common = [
    ['portable/start-node.cmd', 'start-node.cmd'], ['portable/allow-firewall.cmd', 'allow-firewall.cmd'], ['portable/update.cmd', 'update.cmd'],
    ['portable/node.env.example', 'node.env.example'], ['contracts/deployed.testnet.json', 'contracts/deployed.testnet.json'],
    ['contracts/deploy.testnet.json', 'contracts/deploy.testnet.json'],
  ];
  if (kind === 'portable') return [...common, ['portable/README-PORTABLE.md', 'README.md']];
  return [...common, ['portable/README-OPERATOR.md', 'README.md'],
    ...['install-task.cmd', 'run-node.cmd', 'restart-node.cmd', 'stop-node.cmd', 'run-af-relay.cmd'].map((f) => [`portable/${f}`, f])];
}

/** Every bare package a kind's scripts may import, with the version from the source package.json. */
export const depsFor = (kind, pkg) => ({ ethers: pkg.devDependencies.ethers });

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g;
const isJs = (f) => /\.(m?js|cjs)$/.test(f);
const entryOf = (cmd) => cmd.match(/^node\s+(\S+\.m?js)\b/)?.[1] ?? null;

/** Source without comments, so a usage example in a doc comment is not read as an import. Line comments are taken
 *  only where `//` is not part of a URL or a string's scheme (`http://`). */
const code = (file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\/])\/\/[^\n]*/g, '$1');
/** Relative imports of one file, resolved to absolute paths. */
function relativeImports(file) {
  return [...code(file).matchAll(IMPORT)].map((m) => m[1]).filter((s) => s.startsWith('.')).map((s) => resolve(dirname(file), s));
}
const bareImports = (file) => [...code(file).matchAll(IMPORT)].map((m) => m[1]).filter((s) => !s.startsWith('.') && !s.startsWith('/'));

/** The files a set of entry scripts need that the SHIPPED folders do not already carry: each entry plus the
 *  transitive closure of its relative imports. Repo-relative paths, sorted. */
export function closure(root, entries) {
  const seen = new Set(), out = new Set();
  const inShipped = (abs) => SHIPPED.some((d) => abs.startsWith(resolve(root, d) + sep));
  const walk = (abs) => {
    if (seen.has(abs)) return; seen.add(abs);
    if (!existsSync(abs)) throw new Error(`pack: ${relative(root, abs)} is imported but does not exist`);
    if (!inShipped(abs)) out.add(relative(root, abs).split(sep).join('/'));
    if (isJs(abs)) for (const dep of relativeImports(abs)) walk(dep);
  };
  for (const e of entries) walk(resolve(root, e));
  return [...out].sort();
}

/** git-ignored paths under the SHIPPED folders (cabinet/.vercel held Vercel ids and shipped up to 0.11.16). */
function ignoredUnder(root) {
  const r = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', ...SHIPPED], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).map((p) => resolve(root, p).replace(/[\\/]+$/, '').toLowerCase()) : [];
}

/** Stage one kind into `<dist>/<name>`: SHIPPED folders, the scripts' closure, the extras, a package.json.
 *  Returns { stage, scripts, files } — `files` is the closure that was copied. */
export function stage(kind, { root, dist, name, runtime = null, pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) }) {
  const dir = join(dist, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ignored = ignoredUnder(root);
  const isIgnored = (src) => { const p = resolve(src).toLowerCase(); return ignored.some((i) => p === i || p.startsWith(i + sep)); };
  for (const d of SHIPPED) cpSync(join(root, d), join(dir, d), { recursive: true, filter: (src) => !isIgnored(src) });
  const scripts = scriptsFor(kind);
  const files = closure(root, Object.values(scripts).map(entryOf).filter(Boolean));
  for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(root, f), join(dir, f)); }
  for (const [from, to] of extrasFor(kind)) {
    if (!existsSync(join(root, from))) continue;
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(join(root, from), join(dir, to));
  }
  if (runtime) {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    cpSync(runtime.exe, join(dir, 'runtime', 'node.exe'));
    cpSync(runtime.license, join(dir, 'runtime', 'LICENSE-nodejs.txt'));
    writeFileSync(join(dir, 'runtime', 'VERSION'), `${runtime.version}\n`);
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `litnode-${kind}`, private: true, type: 'module', version: pkg.version ?? '0.0.0', license: 'Apache-2.0', runtime: runtime?.version ?? 'system',
    engines: { node: '>=20' }, scripts, dependencies: depsFor(kind, pkg),
  }, null, 2) + '\n');
  return { stage: dir, scripts, files };
}

/** Prove a staged folder is whole: every script's entry exists, and the import graph reachable from the entries
 *  (plus `extraEntries`, e.g. what the daemon loads dynamically) resolves — relative imports to files in the zip,
 *  bare imports to Node builtins or the zip's declared dependencies. `optionalPackages` are developer tools a
 *  shipped file imports behind a try/catch that tells the user to `npm install` (esbuild, for bundling a title).
 *  Returns problems (empty = whole). */
export function checkStage(dir, { extraEntries = ['node/cli.mjs', 'sdk/conformance.mjs'], optionalPackages = ['esbuild'] } = {}) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const builtins = new Set(builtinModules);
  const rel = (p) => relative(dir, p).split(sep).join('/');
  const entries = [...extraEntries];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    const e = entryOf(cmd);
    if (!e) problems.push(`script ${name}: not a "node <file>" command (${cmd})`);
    else if (!existsSync(join(dir, e))) problems.push(`script ${name}: ${e} is not in the zip`);
    else entries.push(e);
  }
  const seen = new Set();
  const walk = (abs) => {
    if (seen.has(abs) || !existsSync(abs) || !isJs(abs)) return; seen.add(abs);
    for (const dep of relativeImports(abs)) {
      if (!existsSync(dep)) problems.push(`${rel(abs)}: imports ${rel(dep)}, not in the zip`);
      else walk(dep);
    }
    for (const b of bareImports(abs)) {
      if (b.startsWith('node:')) continue;
      const name = b.split('/').slice(0, b.startsWith('@') ? 2 : 1).join('/');
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) continue; // not a package specifier (text that happened to follow `import`)
      if (!builtins.has(name) && !deps.has(name) && !optionalPackages.includes(name)) problems.push(`${rel(abs)}: imports package ${name}, not a dependency of the zip`);
    }
  };
  for (const e of entries) walk(resolve(dir, e));
  return problems;
}
