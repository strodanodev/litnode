/** Turn one Agent Fighter `match_ledgers` row into a litnode /ledger
 *  submission. Shared by tools/af-watch.mjs and tools/af-import-ledger.mjs.
 *
 *  The relay is a casual intake (Agent Fighter ADR 0014, settlement v4): the
 *  gauntlet, with both players signing, is the only ranked path. So a relay row
 *  settles UNPLACED and CASUAL under the relay's own match id, with no player
 *  signatures (they were made over the mesh id, and under the relay id the node
 *  would refuse the whole submission), and a row the gauntlet archived
 *  (pin.intake === 'gauntlet') is not submitted at all: it settled itself.
 *
 *  Identity: pin.playerKeys when both are keys — since af-core-9 the relay pins
 *  a key only after verifying that key's ledger signature — else
 *  `af:<display name>`, casual-only. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);

/** @param row      a match_ledgers row
 *  @param engine   the bundled @af/core (decodeLedger)
 *  @param manifest rulesets/agent-fighter.v1.json
 *  @param afRoot   the Agent Fighter checkout (character bundles)
 *  @returns the submission, or null for a row the gauntlet archived */
export function toSubmission(row, { engine, manifest, afRoot }) {
  const pin = row.pin;
  if (pin?.intake === 'gauntlet') return null;
  const [t0, t1] = engine.decodeLedger(row.ledger);
  const n = Math.min(t0.length, t1.length);
  const keys = Array.isArray(pin.playerKeys) && pin.playerKeys.length === 2 && pin.playerKeys.every(isKey) ? pin.playerKeys : null;
  const identity = keys ? 'keys' : 'names';
  return {
    matchId: row.match_id,
    rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash,
    mode: 'casual',
    // A player is the same player on either side; no side suffix.
    participants: keys ?? pin.names.map((name) => `af:${name}`),
    entries: Array.from({ length: n }, (_, k) => ({ k, inputs: [t0[k] | 0, t1[k] | 0] })),
    hydration: { pin, bundles: Object.fromEntries(pin.chars.map((id) => [id, JSON.parse(readFileSync(join(afRoot, 'characters', id, 'character.json'), 'utf8'))])) },
    expected: pin.result ? { hash: pin.result.hash, winner: pin.result.winner, rounds: pin.result.rounds, endTick: pin.result.endTick, reason: pin.result.reason } : null,
    source: { table: 'match_ledgers', relayMatchId: row.match_id, room: pin.room ?? null, identity, engine: row.engine, protocol: row.protocol, codecVersion: row.codec_version, digest: row.digest, createdAt: row.created_at },
  };
}
