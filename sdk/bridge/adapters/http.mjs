/** Adapter: poll a results endpoint on your backend.
 *
 *    GET <source>?since=<cursor>  →  { "rows": [ { "id", "room"?, "submission" }, … ], "cursor": <next> }
 *
 *  with `authorization: Bearer <BRIDGE_SOURCE_TOKEN>` when set. Return rows
 *  in order and a cursor the next call continues from (a timestamp, a row
 *  id); the bridge persists it. Row and submission shapes are the jsonl
 *  adapter's. Options: source (URL), sourceToken, kind, rulesetId. */
export const kind = process.env.BRIDGE_KIND ?? 'replayable';
export const rulesetId = process.env.BRIDGE_RULESET ?? 'unknown.v1';

export async function poll(cursor, ctx) {
  const source = ctx.options?.source ?? process.env.BRIDGE_SOURCE;
  if (!source) throw new Error('http adapter: --source <url> (or BRIDGE_SOURCE) required');
  const token = ctx.options?.sourceToken ?? process.env.BRIDGE_SOURCE_TOKEN;
  const u = new URL(source);
  if (cursor != null) u.searchParams.set('since', String(cursor));
  const r = await fetch(u, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${u.host}: HTTP ${r.status}`);
  const j = await r.json();
  return { rows: (j.rows ?? []).map((x) => ({ id: x.id ?? x.submission?.matchId ?? x.matchId, room: x.room ?? null, submission: x.submission ?? x })), cursor: j.cursor ?? cursor };
}

export async function toSubmission(row, ctx) {
  const s = { ...row.submission };
  delete s.id; delete s.room;
  if (ctx.options?.rulesetId && !s.rulesetId) s.rulesetId = ctx.options.rulesetId;
  if ((ctx.options?.kind ?? kind) === 'attested') s.kind = 'attested';
  return s;
}
