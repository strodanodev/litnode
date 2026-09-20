/** Turn one Agent Fighter `match_ledgers` row into a litnode /ledger
 *  submission. Shared by tools/af-watch.mjs and tools/af-import-ledger.mjs.
 *
 *  Identity, in order of preference:
 *    1. pin.playerKeys — the litnode keys the cabinet placed the match under
 *       (the relay pins them when the client was launched with ?player=);
 *       the delta then lands on the cabinet's ladder under the key that queued.
 *    2. `af:<display name>` — a relay match played outside the cabinet.
 *  Match id: the MESH match when pin.room is a LIT- code that resolves to a
 *  live placement descriptor on the node (so the placed match and the settled
 *  delta are one id), else the relay's own id. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roomCodeFor } from '../../protocol/pairing.js';

const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);

/** Ask a node for its frozen placements and index them by relay room code. */
export async function meshRooms(nodeUrl) {
  try {
    const { matches } = await (await fetch(`${nodeUrl}/match`)).json();
    return new Map(matches.map((m) => [roomCodeFor(m.matchId), m]));
  } catch { return new Map(); }
}

/** @param row      a match_ledgers row
 *  @param engine   the bundled @af/core (decodeLedger)
 *  @param manifest rulesets/agent-fighter.v1.json
 *  @param afRoot   the Agent Fighter checkout (character bundles)
 *  @param rooms    Map from meshRooms(), may be empty */
export function toSubmission(row, { engine, manifest, afRoot, rooms = new Map() }) {
  const [t0, t1] = engine.decodeLedger(row.ledger);
  const n = Math.min(t0.length, t1.length);
  const pin = row.pin;
  const keys = Array.isArray(pin.playerKeys) && pin.playerKeys.length === 2 && pin.playerKeys.every(isKey) ? pin.playerKeys : null;
  const placed = pin.room && rooms.get(String(pin.room)) || null;
  const identity = keys ? 'keys' : 'names';
  return {
    matchId: placed ? placed.matchId : row.match_id,
    rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash,
    // A placed match settles in the mode the mesh placed it in (the node
    // refuses a mode that differs from its descriptor); an unplaced relay
    // match is casual unless the relay itself called it ranked.
    mode: placed ? (placed.mode ?? 'casual') : (row.pin?.mode === 'ranked' ? 'ranked' : 'casual'),
    // A player is the same player on either side; no side suffix.
    participants: keys ?? pin.names.map((name) => `af:${name}`),
    entries: Array.from({ length: n }, (_, k) => ({ k, inputs: [t0[k] | 0, t1[k] | 0] })),
    hydration: { pin, bundles: Object.fromEntries(pin.chars.map((id) => [id, JSON.parse(readFileSync(join(afRoot, 'characters', id, 'character.json'), 'utf8'))])) },
    // Player signatures over the ledger body (protocol 3), when the relay
    // collected them: {playerKey: sig}. With both, the node settles as
    // 'players' provenance; without, as 'relay'.
    ...(keys && pin.signatures && keys.every((k) => typeof pin.signatures[k] === 'string') ? { signatures: Object.fromEntries(keys.map((k) => [k, pin.signatures[k]])) } : {}),
    expected: pin.result ? { hash: pin.result.hash, winner: pin.result.winner, rounds: pin.result.rounds, endTick: pin.result.endTick, reason: pin.result.reason } : null,
    source: { table: 'match_ledgers', relayMatchId: row.match_id, room: pin.room ?? null, identity, engine: row.engine, protocol: row.protocol, codecVersion: row.codec_version, digest: row.digest, createdAt: row.created_at },
  };
}
