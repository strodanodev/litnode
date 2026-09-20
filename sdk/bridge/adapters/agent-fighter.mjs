/** Adapter: Agent Fighter's studio database (Supabase `match_ledgers`),
 *  through the same mapping tools/af-watch.mjs uses. The worked example of
 *  a REPLAYABLE title with a pre-existing backend: the relay archives an
 *  input ledger per match; each row becomes a submission under the mesh
 *  match id and keys when the cabinet placed it, the relay's own id
 *  otherwise.
 *
 *  Needs AF_ROOT (the Agent Fighter checkout: its .env for the Supabase
 *  service key, its character bundles) and rulesets/agent-fighter.v1.js.
 *  The service key is read from that .env and never printed. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toSubmission as afSubmission } from '../../../tools/lib/af-submission.mjs';
import { ROOT } from '../index.mjs';

export const kind = 'replayable';
export const rulesetId = 'agent-fighter.v1';

let cache = null;
const setup = async (opts) => {
  if (cache) return cache;
  const afRoot = resolve(opts?.afRoot ?? process.env.AF_ROOT ?? 'E:/NPC/AGENT FIGHTER/agent-fighter');
  const env = {};
  for (const l of readFileSync(join(afRoot, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) env[m[1]] = m[2]; }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
  const { engine } = await import(pathToFileURL(join(ROOT, 'rulesets', 'agent-fighter.v1.js')).href);
  cache = { afRoot, engine, manifest, url: env.SUPABASE_URL.replace(/\/+$/, ''), headers: { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } };
  return cache;
};

export async function poll(cursor, ctx) {
  const c = await setup(ctx.options);
  const since = cursor ?? new Date(Date.now() - 6 * 3600_000).toISOString();
  const rows = await (await fetch(`${c.url}/rest/v1/match_ledgers?select=*&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc&limit=20`, { headers: c.headers })).json();
  return { rows: rows.map((row) => ({ id: row.match_id, room: row.pin?.room ?? null, row })), cursor: rows.at(-1)?.created_at ?? since };
}

export async function toSubmission({ row }, ctx) {
  const c = await setup(ctx.options);
  if (row.engine !== c.engine.ENGINE_VERSION) { ctx.log(`${row.match_id}: engine ${row.engine} ≠ ${c.engine.ENGINE_VERSION}, skipped`); return null; }
  return afSubmission(row, { engine: c.engine, manifest: c.manifest, afRoot: c.afRoot, rooms: ctx.rooms });
}
