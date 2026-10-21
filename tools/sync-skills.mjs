#!/usr/bin/env node
/** Keep `.agents/skills/` (read by agents that are not Claude Code; gitignored) byte-identical to the tracked
 *  `.claude/skills/`. The copy drifted silently before: nothing synced it (audit 2026-10-21 §4.4).
 *
 *    npm run skills:sync            copy every git-tracked skill folder to .agents/skills
 *    npm run skills:sync -- --check exit 1 when a copy differs or is missing (demo/skills.test.mjs runs this)
 *
 *  Only skills git tracks are synced: a locally installed skill (graphify, say) stays where its installer put it. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tracked skill folders and their files: { name: [relative file, …] }. */
export function trackedSkills() {
  const files = execFileSync('git', ['ls-files', '.claude/skills'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const out = {};
  for (const f of files) { const [, , name, ...rest] = f.split('/'); (out[name] ??= []).push(rest.join('/')); }
  return out;
}

/** Differences between .claude/skills and .agents/skills, as human lines. Empty = in sync (or no copy at all). */
export function drift({ requireCopy = false } = {}) {
  const problems = [];
  if (!existsSync(join(root, '.agents', 'skills'))) return requireCopy ? ['.agents/skills does not exist'] : [];
  for (const [name, files] of Object.entries(trackedSkills()))
    for (const f of files) {
      const a = join(root, '.claude', 'skills', name, f), b = join(root, '.agents', 'skills', name, f);
      if (!existsSync(b)) problems.push(`.agents/skills/${name}/${f} missing`);
      else if (!readFileSync(a).equals(readFileSync(b))) problems.push(`.agents/skills/${name}/${f} differs`);
    }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const p = drift();
    if (p.length) { console.error(`skills out of sync:\n  ${p.join('\n  ')}\n  run: npm run skills:sync`); process.exit(1); }
    console.log('.agents/skills in sync with .claude/skills');
  } else {
    for (const name of Object.keys(trackedSkills())) {
      const to = join(root, '.agents', 'skills', name);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(root, '.claude', 'skills', name), to, { recursive: true });
    }
    console.log(`synced ${Object.keys(trackedSkills()).length} skill(s) → .agents/skills`);
  }
}
