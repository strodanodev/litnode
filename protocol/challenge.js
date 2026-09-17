/** Proof of possession for a discovered endpoint. A directory entry says
 *  "node key K is at URL U"; a /health answer from U proves only that
 *  something answers there. The reader sends a nonce and the node signs it
 *  with K — a URL that cannot do that is not that node, whatever it says.
 *
 *  GET /whoami?nonce=<hex>  →  { nodeId, nonce, addr, at, sig }
 *  where sig = sign('whoami', { nodeId, nonce, addr, at }, nodeKey). */
import { sign, verify } from './keys.js';

export const WHOAMI_TAG = 'whoami';
export const NONCE_RE = /^[0-9a-f]{16,64}$/;

export async function answerChallenge({ nodeId, nonce, addr, at = Date.now() }, privateKey) {
  const body = { nodeId, nonce, addr: addr ?? null, at };
  return { ...body, sig: await sign(WHOAMI_TAG, body, privateKey) };
}

/** Verify an answer against the identity the reader EXPECTED and the nonce it sent. */
export async function checkChallenge(answer, { expectNodeId, nonce, maxSkewMs = 120_000, now = Date.now() }) {
  if (!answer || answer.nodeId !== expectNodeId) return { ok: false, reason: 'identity' };
  if (answer.nonce !== nonce) return { ok: false, reason: 'nonce' };
  if (typeof answer.at !== 'number' || Math.abs(now - answer.at) > maxSkewMs) return { ok: false, reason: 'stale' };
  const { sig, ...body } = answer;
  return (await verify(WHOAMI_TAG, body, sig, expectNodeId)) ? { ok: true } : { ok: false, reason: 'signature' };
}

/** A random nonce as hex, from whatever crypto the runtime has (browser or Node). */
export const newNonce = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
