/** The agent skills say only what the code does (audit 2026-10-21 §4.4: each skill had a step that did not run as
 *  written). Statically: every `npm run <script>` a skill names exists, every `npm run host -- <command>` is a
 *  harness command, every `npm run bridge -- <command>` is a bridge command, every repo path it names exists, the
 *  frontmatter is well-formed, and the gitignored .agents/skills copy (when present) is byte-identical.
 *    node --test demo/skills.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSkills, drift } from '../tools/sync-skills.mjs';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const hostSrc = readFileSync(join(root, 'sdk', 'host', 'cli.mjs'), 'utf8');
const bridgeSrc = readFileSync(join(root, 'sdk', 'bridge', 'cli.mjs'), 'utf8');
const skills = Object.keys(trackedSkills());

test('skills: frontmatter names and describes each one, and says when to use it', () => {
  assert.ok(skills.length >= 4, skills.join(','));
  for (const name of skills) {
    const src = readFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'), `${name}: name matches its folder`);
    const desc = fm[1].match(/^description: (.+)$/m)?.[1] ?? '';
    assert.ok(desc.length > 80 && desc.length <= 1024, `${name}: description 80–1024 chars (${desc.length})`);
    assert.match(desc, /Use when/, `${name}: says when to use it`);
  }
  // the two title skills name their discriminator in both directions
  const d = (n) => readFileSync(join(root, '.claude', 'skills', n, 'SKILL.md'), 'utf8');
  assert.match(d('build-a-title'), /client has to be WRITTEN/); assert.match(d('build-a-title'), /use host-a-title/);
  assert.match(d('host-a-title'), /ALREADY EXIST/); assert.match(d('host-a-title'), /use build-a-title/);
});

test('skills: every npm script, harness command, bridge command and repo path a skill names exists', () => {
  for (const name of skills) {
    const src = readFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    for (const [, script] of src.matchAll(/npm run ([\w:-]+)/g)) assert.ok(pkg.scripts[script], `${name}: npm run ${script} is not a script`);
    for (const [, cmd] of src.matchAll(/npm run host -- ([a-z-]+)/g)) assert.ok(new RegExp(`(['"\`]?)${cmd}\\1\\s*[(:]|async '${cmd}'|${cmd}\\(\\)`).test(hostSrc), `${name}: npm run host -- ${cmd} is not a harness command`);
    for (const [, cmd] of src.matchAll(/(?:npm run bridge -- |bridge )(assess|key|body|submit|watch|backfill|serve|check|resolve)\b/g)) assert.ok(bridgeSrc.includes(`'${cmd}'`) || bridgeSrc.includes(`${cmd}(`) || bridgeSrc.includes(`${cmd}:`), `${name}: bridge ${cmd}`);
    // repo paths in backticks: a real folder prefix, no placeholder
    for (const [, p] of src.matchAll(/`((?:docs|tools|sdk|titles|rulesets|node|protocol|cabinet|demo|gauntlets|portable|contracts)\/[\w./-]+)`/g)) {
      if (/[<>*]/.test(p)) continue;
      assert.ok(existsSync(join(root, p.replace(/\/$/, ''))), `${name}: ${p} does not exist`);
    }
  }
});

test('skills: the .agents/skills copy, when present, is byte-identical (npm run skills:sync)', () => {
  assert.deepEqual(drift(), []);
});
