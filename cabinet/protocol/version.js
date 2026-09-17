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
 *       official-standings policy, frozen epochs, sandboxed titles */
export const PROTOCOL_VERSION = 2;
export const compatible = (v) => v === PROTOCOL_VERSION;
