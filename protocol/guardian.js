/** Lite guardian: the checks a phone or a desktop tray can afford, and the
 *  signed report it sends. Pure — WebCrypto and fetch only, runs in a browser
 *  and in Node (≥ 20).
 *
 *  A guardian does NOT replay, co-sign, dispute or hold stake. It checks what
 *  needs no chain and no sandbox — the host's signature, the result
 *  commitment, and that the served log reaches the head the result claims —
 *  and reports it. Reports are advisory: an `inconsistent` report tells
 *  bonded witnesses where to look; it never changes a result's standing. */
import { verify, seal, opened } from './keys.js';
import { chainHead } from './log.js';
import { resultHash } from './result.js';

export const GUARDIAN_TAG = 'guardian';
export const GUARDIAN_VERSION = 1;
export const VERDICTS = ['consistent', 'inconsistent', 'unavailable'];

// Must match node/settle.js (HOST_TAG, stripSig); demo/guardian.test.mjs checks a real settled delta.
const HOST_TAG = 'delta';
const stripSig = ({ hostSig, cosigners, cosigs, disputes, verification: _v, official: _o, ...body }) => body;

/** Check one settled delta against the ledger its node serves (null = not served). */
export async function checkDelta(delta, ledger) {
  const failed = [];
  if (!(await verify(HOST_TAG, stripSig(delta), delta.hostSig, delta.hostId))) failed.push('hostSig');
  if (resultHash(delta) !== delta.resultHash) failed.push('commitment');
  if (!ledger) return { verdict: 'unavailable', failed: [...failed, 'ledger'] };
  if (ledger.matchId !== delta.matchId) failed.push('ledger');
  else if (delta.kind !== 'attested') {
    try { if (chainHead(ledger.entries ?? []) !== delta.head) failed.push('head'); } catch { failed.push('head'); }
  }
  return { verdict: failed.length ? 'inconsistent' : 'consistent', failed };
}

export const reportBody = (delta, { verdict, failed }, at = Date.now()) => ({
  v: GUARDIAN_VERSION, matchId: delta.matchId, resultHash: delta.resultHash, hostId: delta.hostId, verdict, failed, at,
});

/** { body, signer, sig } — the signer IS the guardian's id. */
export const signReport = (body, kp) => seal(GUARDIAN_TAG, body, kp);

export async function verifyReport(env, { now = Date.now(), maxSkewMs = 10 * 60_000 } = {}) {
  if (!(await opened(GUARDIAN_TAG, env))) return 'bad signature';
  const b = env.body;
  if (b.v !== GUARDIAN_VERSION) return `version ${b.v}`;
  if (typeof b.matchId !== 'string' || typeof b.resultHash !== 'string') return 'malformed';
  if (!VERDICTS.includes(b.verdict) || !Array.isArray(b.failed)) return 'malformed';
  if (!Number.isFinite(b.at) || Math.abs(now - b.at) > maxSkewMs) return 'stale';
  return null;
}
