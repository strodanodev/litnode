/** Scaffold a title from the SDK template.
 *
 *    npm run create-title -- my-title.v1 "My Title"
 *    npm run create-title -- my-title.v1 "My Title" --out <dir>     (anywhere else; the SDK import is made absolute)
 *
 *  Writes titles/my-title.v1.mjs — a complete, conformant, replayable game
 *  (TUG) with the rulesetId and display name filled in. Edit it, then:
 *
 *    node sdk/conformance.mjs titles/my-title.v1.mjs
 *    node tools/bundle-title.mjs titles/my-title.v1.mjs     → rulesets/my-title.v1.js
 *    RULESETS=./rulesets/my-title.v1.js npm run node */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const outDir = outAt >= 0 ? resolve(argv[outAt + 1] ?? '.') : join(root, 'titles');
if (outAt >= 0) argv.splice(outAt, 2);
const [id, ...nameParts] = argv;
if (!id || !/^[a-z0-9][a-z0-9-]*\.v\d+$/.test(id)) {
  console.error('usage: npm run create-title -- <name.v1> ["Display Name"]\n  rulesetId: lowercase, digits, dashes, then .v<n>  (e.g. tug.v1)');
  process.exit(2);
}
const name = nameParts.join(' ') || id.replace(/\.v\d+$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const out = join(outDir, `${id}.mjs`);
if (existsSync(out)) { console.error(`${out} exists — pick another id or delete it`); process.exit(1); }
let src = readFileSync(join(root, 'sdk', 'template', 'title.mjs'), 'utf8').replaceAll('__RULESET_ID__', id).replaceAll('__TITLE_NAME__', name);
// Outside titles/ the template's relative SDK import would point nowhere: point it at this checkout's SDK — relative
// when the folder shares a drive with the checkout, else absolute (resolved by the bundler; bundle before running it).
if (outDir !== join(root, 'titles')) {
  const rel = relative(outDir, join(root, 'sdk', 'index.js'));
  const posix = (p) => p.replace(/\\/g, '/');
  const spec = isAbsolute(rel) ? posix(rel) : posix(rel.startsWith('.') ? rel : `./${rel}`);
  src = src.replaceAll("'../sdk/index.js'", `'${spec}'`);
}
writeFileSync(out, src);
console.log(`titles/${id}.mjs — "${name}"\n\n  check   node sdk/conformance.mjs titles/${id}.mjs\n  bundle  node tools/bundle-title.mjs titles/${id}.mjs\n  host    RULESETS=./rulesets/${id}.js npm run node\n\n  rules   docs/HOST-YOUR-TITLE.md`);
