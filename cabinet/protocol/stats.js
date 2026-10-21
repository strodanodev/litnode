/** Title stats (settlement v4): a title declares which per-match counters it keeps and how a player's season folds
 *  them; the node takes the numbers from the title (replayed in the sandbox, or from a court's signed report),
 *  commits them in the result hash, and folds them into per-player lines and an hourly stats root. Pure; vendored to
 *  the cabinet.
 *
 *    manifest.services.stats = { track: ['matches', 'wins', 'ticks'], schema: { rescued: 'sum', bestChain: 'max' } }
 *
 *  Values are non-negative safe integers. Names match NAME_RE, at most MAX_STATS of them, and never shadow the
 *  built-in line (`matches`, `wins`, `ticks`). Ops:
 *    sum   add every match's value
 *    max   keep the largest            min   keep the smallest (a missing value is not 0: it is skipped)
 *    last  keep the value of the latest match in fold order (derive.js sortDeltas)
 *  docs/SETTLEMENT-STANDARD.md §10 is the contract. */
import { canonical, h } from './canonical.js';

export const STATS_VERSION = 1;
export const STAT_OPS = Object.freeze(['sum', 'max', 'min', 'last']);
export const NAME_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
export const MAX_STATS = 32;
export const RESERVED = Object.freeze(['matches', 'wins', 'ticks']);

/** Why a schema is unusable, or null. */
export function schemaProblem(schema) {
  if (schema == null) return null;
  if (typeof schema !== 'object' || Array.isArray(schema)) return 'stats.schema must be an object { name: op }';
  const names = Object.keys(schema);
  if (names.length > MAX_STATS) return `stats.schema has ${names.length} names; at most ${MAX_STATS}`;
  for (const n of names) {
    if (!NAME_RE.test(n)) return `stat name ${JSON.stringify(n)} must match ${NAME_RE}`;
    if (RESERVED.includes(n)) return `stat name ${n} is reserved for the built-in line`;
    if (!STAT_OPS.includes(schema[n])) return `stat ${n}: op must be one of ${STAT_OPS.join('|')} (got ${JSON.stringify(schema[n])})`;
  }
  return null;
}

/** The schema a manifest declares, or null. */
export const schemaOf = (manifest) => manifest?.services?.stats?.schema ?? null;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/** One match's stats, checked against the schema: `{ participant: { name: int } }`, keeping only schema names and
 *  listed participants. A value that is not a non-negative safe integer is an error (the title or court is wrong,
 *  and a witness must refuse the same input the host refuses). A participant with nothing left is omitted; nothing
 *  at all is null. */
export function cleanStats(raw, participants, schema) {
  if (raw == null || !schema) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('stats must be an object { participant: { name: value } }');
  const out = {};
  for (const p of participants) {
    const line = raw[p];
    if (line == null) continue;
    if (typeof line !== 'object' || Array.isArray(line)) throw new Error(`stats for ${String(p).slice(0, 16)} must be an object`);
    const kept = {};
    for (const name of Object.keys(schema).sort()) {
      if (!(name in line)) continue;
      if (!isCount(line[name])) throw new Error(`stat ${name} for ${String(p).slice(0, 16)} must be a non-negative integer (got ${JSON.stringify(line[name])})`);
      kept[name] = line[name];
    }
    if (Object.keys(kept).length) out[p] = kept;
  }
  for (const p of Object.keys(raw)) if (!participants.includes(p)) throw new Error(`stats name ${String(p).slice(0, 16)}, not a participant`);
  return Object.keys(out).length ? out : null;
}

/** Fold one match's values into a player's running line, in place. */
export function foldLine(line, values, schema) {
  for (const [name, op] of Object.entries(schema)) {
    const v = values?.[name];
    if (v == null) continue;
    if (op === 'sum') line[name] = (line[name] ?? 0) + v;
    else if (op === 'max') line[name] = line[name] == null ? v : Math.max(line[name], v);
    else if (op === 'min') line[name] = line[name] == null ? v : Math.min(line[name], v);
    else if (op === 'last') line[name] = v;
  }
  return line;
}

/** Per-player season lines for ONE title from results already in fold order: { player: { name: value } }. */
export function foldStats(sortedDeltas, schema) {
  const lines = {};
  if (!schema) return lines;
  for (const d of sortedDeltas) for (const [p, values] of Object.entries(d.stats ?? {})) foldLine(lines[p] ?? (lines[p] = {}), values, schema);
  return lines;
}

/** A stats-root leaf: one player's folded line for one title, through hour `through` (inclusive). */
export const statsLeaf = (rulesetId, player, line, through) => h('stat', { v: STATS_VERSION, rulesetId, player, stats: line, through });

/** All leaves for a set of titles: [{ rulesetId, player, stats, leaf }], in a stable order. */
export function statsLeaves(foldsByTitle, through) {
  const out = [];
  for (const rulesetId of Object.keys(foldsByTitle).sort())
    for (const player of Object.keys(foldsByTitle[rulesetId]).sort()) {
      const line = foldsByTitle[rulesetId][player];
      if (!Object.keys(line).length) continue;
      out.push({ rulesetId, player, stats: line, leaf: statsLeaf(rulesetId, player, line, through) });
    }
  return out;
}

/** A node's LOCAL season through hour `through` (settlement v4): every protocol-4 result with stats whose proof is
 *  above `host` and whose hour is ≤ through, in derive order (epoch hour, then matchId), folded by the schema each
 *  delta itself commits. Shared by the node (node/settle.js) and the custody check (tools/custody.mjs).
 *  @returns { folds: { rulesetId: { player: line } }, leaves } */
export function localSeason(deltas, through) {
  const keep = [...new Map(deltas.map((d) => [d.matchId, d])).values()]
    .filter((d) => (d.protocol ?? 0) >= 4 && d.epoch <= through && d.proof && d.proof !== 'host' && d.stats && d.statsSchema)
    .sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0) || (a.matchId < b.matchId ? -1 : 1));
  const folds = {};
  for (const d of keep) for (const [p, values] of Object.entries(d.stats)) foldLine(((folds[d.rulesetId] ??= {})[p] ??= {}), values, d.statsSchema);
  return { folds, leaves: statsLeaves(folds, through) };
}

/** The digest a reader compares to know two nodes folded the same season. */
export const statsDigest = (foldsByTitle) => h('stats', canonical({ v: STATS_VERSION, folds: foldsByTitle }));
