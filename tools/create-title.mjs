/** Scaffold a title from the SDK template.
 *
 *    npm run create-title -- my-title.v1 "My Title"
 *
 *  Writes titles/my-title.v1.mjs — a complete, conformant, replayable game
 *  (TUG) with the rulesetId and display name filled in. Edit it, then:
 *
 *    node sdk/conformance.mjs titles/my-title.v1.mjs
 *    node tools/bundle-title.mjs titles/my-title.v1.mjs     → rulesets/my-title.v1.js
 *    RULESETS=./rulesets/my-title.v1.js npm run node */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...nameParts] = process.argv.slice(2);
if (!id || !/^[a-z0-9][a-z0-9-]*\.v\d+$/.test(id)) {
  console.error('usage: npm run create-title -- <name.v1> ["Display Name"]\n  rulesetId: lowercase, digits, dashes, then .v<n>  (e.g. tug.v1)');
  process.exit(2);
}
const name = nameParts.join(' ') || id.replace(/\.v\d+$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const out = join(root, 'titles', `${id}.mjs`);
if (existsSync(out)) { console.error(`${out} exists — pick another id or delete it`); process.exit(1); }
const src = readFileSync(join(root, 'sdk', 'template', 'title.mjs'), 'utf8').replaceAll('__RULESET_ID__', id).replaceAll('__TITLE_NAME__', name);
writeFileSync(out, src);
console.log(`titles/${id}.mjs — "${name}"\n\n  check   node sdk/conformance.mjs titles/${id}.mjs\n  bundle  node tools/bundle-title.mjs titles/${id}.mjs\n  host    RULESETS=./rulesets/${id}.js npm run node\n\n  rules   docs/HOST-YOUR-TITLE.md`);
