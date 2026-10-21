/** The protocol version every signed descriptor and heartbeat carries.
 *
 *  Bump it whenever two honest nodes on different builds would compute a
 *  different placement, snapshot root, result commitment or leaf from the
 *  same inputs. Peers on another version are heard, listed as incompatible,
 *  and excluded from the snapshot — they can neither be placed nor witness,
 *  so old and new rules never mix inside one competitive match.
 *
 *  History:
 *    1  through litnode 0.6.x (implicit; heartbeats carried no version)
 *    2  0.8: result commitment (resultHash), descriptor-bound settlement,
 *       official-standings policy, frozen epochs, sandboxed titles
 *    3  0.9: player-signed ledger body is {matchId, ticks, head, buildHash}
 *       (no hydration hash) so a title's client can sign at match end; a
 *       protocol-2 witness would refuse those signatures, so it is a bump
 *    4  0.12 (settlement v4): the result commitment adds `proof` and
 *       `stats` (protocol/result.js resultFields, versioned by the delta's
 *       own protocol); the anchored epoch root becomes
 *       pair(resultsRoot, statsRoot); off-chain results are gossiped to a
 *       drawn custody set again; attested envelopes may carry the log. A v3
 *       witness would compute another resultHash, so it is a bump. */
export const PROTOCOL_VERSION = 4;
export const compatible = (v) => v === PROTOCOL_VERSION;
