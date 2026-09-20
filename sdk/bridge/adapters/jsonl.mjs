/** Adapter: a JSON-lines file your backend appends one finished match to.
 *  The lowest-effort source — a cron job or a database trigger that writes
 *  a line is all a backend needs, and the same file is a backfill from a
 *  database export. Each line:
 *
 *    { "id": "<unique>", "room": "LIT-…"?, "submission": { …unsigned… } }
 *
 *  or the submission itself carrying an `id` (else its matchId is the id).
 *  The cursor is the byte offset consumed, so the file may keep growing
 *  while the bridge runs. Options (from --source/--kind/--ruleset or
 *  BRIDGE_SOURCE/BRIDGE_KIND/BRIDGE_RULESET): file, kind, rulesetId. */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

export const kind = process.env.BRIDGE_KIND ?? 'replayable';
export const rulesetId = process.env.BRIDGE_RULESET ?? 'unknown.v1';

export async function poll(cursor, ctx) {
  const file = ctx.options?.source ?? process.env.BRIDGE_SOURCE;
  if (!file) throw new Error('jsonl adapter: --source <file> (or BRIDGE_SOURCE) required');
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = Number(cursor ?? 0);
    if (size <= from) return { rows: [], cursor: from };
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const complete = text.lastIndexOf('\n');
    if (complete < 0) return { rows: [], cursor: from };
    const rows = [];
    for (const line of text.slice(0, complete).split('\n')) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      const submission = j.submission ?? j;
      rows.push({ id: j.id ?? submission.matchId, room: j.room ?? submission.room ?? null, submission });
    }
    return { rows, cursor: from + Buffer.byteLength(text.slice(0, complete + 1), 'utf8') };
  } finally { closeSync(fd); }
}

export async function toSubmission(row, ctx) {
  const s = { ...row.submission };
  delete s.id; delete s.room;
  if (ctx.options?.rulesetId && !s.rulesetId) s.rulesetId = ctx.options.rulesetId;
  if ((ctx.options?.kind ?? kind) === 'attested') s.kind = 'attested';
  return s;
}
