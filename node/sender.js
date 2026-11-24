/** One transaction at a time per signing key, across every module that sends from it.
 *
 *  A node's hot key (<dataDir>/announcer.json) pays for three things: MatchBook (node/matchbook.js), the
 *  NodeDirectory announce (node/announce.js) and the gas top-up of a new AIR proxy wallet (node/proxy.js). Each used
 *  to pick its own nonce: MatchBook counted locally, the other two asked the chain for `pending`. When an announce or a
 *  top-up went out between two MatchBook sends, MatchBook's next transaction carried a nonce the chain had already
 *  used and was refused — a commit or an attestation lost, and not sent again (audit of 10 Nov 2026).
 *
 *  `keyQueue(address)` is the one line every sender for that address stands in. `run(owner, fn)` calls `fn` when the
 *  line reaches it, with `{ foreign }`: true when the previous send from this key was another module's, so a sender
 *  that counts nonces locally knows to ask the chain again. A failed send does not stop the line.
 *
 *  Process-wide and keyed by address: two nodes in one process (the tests) with two keys never wait on each other. */
const queues = new Map(); // address (lowercase) → { tail, last }

export function keyQueue(address) {
  const id = String(address).toLowerCase();
  let q = queues.get(id);
  if (!q) { q = { tail: Promise.resolve(), last: null }; queues.set(id, q); }
  return {
    run(owner, fn) {
      const p = q.tail.then(() => { const foreign = q.last !== null && q.last !== owner; q.last = owner; return fn({ foreign }); });
      q.tail = p.catch(() => {});
      return p;
    },
  };
}

/** A send the chain refused because of the nonce, not because of the call: worth one more try with a fresh count. */
export const isNonceError = (e) => /nonce|already known|replacement transaction|underpriced/i.test(String(e?.message ?? e));
