/** The result commitment and the official-standings policy. Pure.
 *
 *  A delta's `resultHash` commits to EVERYTHING a ranking or a settlement
 *  consumes: the match binding (descriptor), the build, the participants and
 *  roles, the seed, the hydration, the replay outcome (root, ticks, head,
 *  engine hash, scores), and what attests it. A witness signs `{ matchId,
 *  resultHash }` after recomputing every field itself — so a co-signature is
 *  a claim about the whole result, not about one hash inside it. */
import { h } from './canonical.js';

export const RESULT_TAG = 'result';

/** The fields the commitment covers, in one place so intake, witness and
 *  acceptCosign cannot drift. Unknown extra fields on a delta are ignored. */
export const resultFields = (d) => ({
  protocol: d.protocol ?? null,
  matchId: d.matchId, rulesetId: d.rulesetId, buildHash: d.buildHash, kind: d.kind ?? 'replayable', mode: d.mode,
  descriptorHash: d.descriptorHash ?? null,
  participants: d.participants, teams: d.teams ?? null,
  seed: d.seed ?? null, ticks: d.ticks ?? null, head: d.head ?? null,
  finalStateRoot: d.finalStateRoot, engineHash: d.engineHash ?? null,
  hydrationHash: d.hydrationHash, hydrationSource: d.hydrationSource ?? null,
  scores: d.scores, attestation: d.attestation, attestor: d.attestor ?? null, relay: d.relay?.id ?? null,
  hostId: d.hostId, epoch: d.epoch,
});
export const resultHash = (d) => h(RESULT_TAG, resultFields(d));

/** What a co-signature and a dispute are over. */
export const cosignBody = (d) => ({ matchId: d.matchId, resultHash: d.resultHash });

/** Verification status of one delta, as a label the cabinet can show:
 *    verified   attested by the players (or an authorized court) AND at least
 *               one independent witness reached the same commitment, and no
 *               witness disputes it outnumber those that agree
 *    disputed   at least one witness recomputed a different result
 *    unverified everything else (host-only, relay-only, or not yet witnessed)
 *  `registry` says whether the node reads a character registry; when it
 *  does, a fixture-hydrated ranked result is never verified. */
export function verification(d, { registry = false } = {}) {
  const cos = d.cosigners?.length ?? 0;
  const dis = d.disputes?.length ?? 0;
  const attested = d.attestation === 'players' || d.attestation === 'attested';
  if (dis > 0 && dis >= cos) return 'disputed';
  if (!attested || cos === 0) return 'unverified';
  if (registry && d.mode === 'ranked' && d.hydrationSource === 'fixture') return 'unverified';
  return 'verified';
}

/** Official standings take verified results only. */
export const isOfficial = (d, opts) => verification(d, opts) === 'verified';
