/** Bundle a title into the one-file artifact the mesh pins by hash.
 *
 *    node tools/bundle-title.mjs titles/my-title.v1.mjs [--out rulesets/]
 *
 *  Inlines the SDK (and anything else the title imports) with esbuild, runs
 *  the conformance suite over the RESULT — the bytes a node will actually
 *  load — and writes rulesets/<id>.js plus rulesets/<id>.json:
 *  { rulesetId, buildHash, bytes, builtAt }. The buildHash is what the
 *  cabinet config and every node advertise; keep the .json with the .js.
 *
 *  esbuild is a devDependency (npm install once). No minify: the source is
 *  the audit trail of what settled. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { h } from '../protocol/canonical.js';
const rulesetHash = (source) => h('ruleset', source); // same as node/litnode.js
import { check } from '../sdk/conformance.mjs';
import { bundleTitle } from '../sdk/bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const entry = args.find((a) => !a.startsWith('--'));
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'rulesets');
if (!entry) { console.error('usage: node tools/bundle-title.mjs <titles/name.v1.mjs> [--out dir]'); process.exit(2); }

let source;
try { source = await bundleTitle(entry); } catch (e) { console.error(e.message); process.exit(1); }

const result = await check(source);
for (const c of result.checks) if (!c.ok) console.error(`${c.warn ? 'warn' : 'FAIL'}  ${c.name}  — ${c.detail}`);
if (!result.ok) { console.error('\nnot conformant — nothing written. Fix the checks above; no node will load this.'); process.exit(1); }

const title = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const id = title.manifest.rulesetId;
if (basename(entry).replace(/\.m?js$/, '') !== id) console.error(`note: file is ${basename(entry)} but rulesetId is ${id}; writing ${id}.js`);
mkdirSync(outDir, { recursive: true });
const buildHash = rulesetHash(source);
writeFileSync(join(outDir, `${id}.js`), source);
writeFileSync(join(outDir, `${id}.json`), JSON.stringify({ rulesetId: id, buildHash, bytes: source.length, kind: title.manifest.kind, display: title.manifest.display ?? null, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`${join(outDir, `${id}.js`)}  ${source.length} bytes\nbuildHash ${buildHash}\n\nhost it:  RULESETS=./rulesets/${id}.js npm run node`);
