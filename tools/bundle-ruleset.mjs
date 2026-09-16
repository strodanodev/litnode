/** Build a ruleset artifact: the adapter plus everything it imports, as ONE
 *  ES module with no imports. That file is what `GET /ruleset/:rulesetId`
 *  serves and what buildHash = H('ruleset', source) pins.
 *
 *    node tools/bundle-ruleset.mjs                                   # every adapter in titles/
 *    node tools/bundle-ruleset.mjs titles/pickle-brawl.adapter.js    # one
 *    AF_ROOT=/path/to/agent-fighter node tools/bundle-ruleset.mjs    # where @af/core lives
 *
 *  Writes rulesets/<rulesetId>.js and rulesets/<rulesetId>.json. For an
 *  adapter that imports @af/core the manifest also records the engine version
 *  and the agent-fighter commit, since the hash pins engine and adapter as one. */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { h } from '../protocol/canonical.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const AF_ROOT = resolve(process.env.AF_ROOT ?? 'E:/NPC/AGENT FIGHTER/agent-fighter');
const coreEntry = join(AF_ROOT, 'packages', 'core', 'src', 'index.ts');
const esbuildMain = [join(AF_ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'), join(root, 'node_modules', 'esbuild', 'lib', 'main.js')].find(existsSync);
if (!esbuildMain) throw new Error('esbuild not found — npm install in the agent-fighter checkout or here');
const { build } = await import(pathToFileURL(esbuildMain).href);

const adapters = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : readdirSync(join(root, 'titles')).filter((f) => f.endsWith('.adapter.js')).map((f) => join(root, 'titles', f));

const outDir = join(root, 'rulesets');
mkdirSync(outDir, { recursive: true });

for (const adapter of adapters) {
  const src = readFileSync(adapter, 'utf8');
  const rulesetId = /rulesetId:\s*'([^']+)'|RULESET_ID = '([^']+)'/.exec(src)?.slice(1).find(Boolean);
  if (!rulesetId) throw new Error(`${adapter}: cannot find rulesetId`);
  const usesEngine = src.includes("'@af/core'");
  if (usesEngine && !existsSync(coreEntry)) throw new Error(`@af/core not found at ${coreEntry} — set AF_ROOT`);
  const outfile = join(outDir, `${rulesetId}.js`);

  let engineVersion = null, afCommit = null;
  if (usesEngine) {
    engineVersion = /ENGINE_VERSION = '([^']+)'/.exec(readFileSync(join(AF_ROOT, 'packages/core/src/data.ts'), 'utf8'))?.[1] ?? 'unknown';
    try { afCommit = execSync('git rev-parse --short HEAD', { cwd: AF_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { afCommit = 'unknown'; }
  }

  const result = await build({
    entryPoints: [adapter], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile,
    alias: usesEngine ? { '@af/core': coreEntry } : {},
    banner: { js: `// ${rulesetId}${engineVersion ? ` · engine ${engineVersion} · af-core ${afCommit}` : ''} · built by tools/bundle-ruleset.mjs` },
    legalComments: 'none', logLevel: 'warning',
  });
  if (result.errors.length) process.exit(1);

  const source = readFileSync(outfile, 'utf8');
  if (/^\s*import\s/m.test(source)) throw new Error(`${rulesetId}: bundle still has imports`);
  const manifest = { rulesetId, buildHash: h('ruleset', source), engine: engineVersion, afCommit, bytes: Buffer.byteLength(source), builtAt: new Date().toISOString() };
  writeFileSync(join(outDir, `${rulesetId}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
}
