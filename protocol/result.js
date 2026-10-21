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
 *  acceptCosign cannot drift. Unknown extra fields on a delta are ignored.
 *
 *  VERSIONED by the delta's own `protocol`: a protocol-4 delta also commits
 *  its proof level, its per-match stats and the schema they fold by (the
 *  build's `services.stats.schema`, so a season fold needs nothing but the
 *  deltas themselves) — settlement v4; a delta settled
 *  under protocol 3 or earlier keeps the field set it was signed over, so a
 *  v4 node re-verifying custody of an old delta reaches the same hash. */
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
  ...((d.protocol ?? 0) >= 4 ? { proof: d.proof ?? null, stats: d.stats ?? null, statsSchema: d.statsSchema ?? null } : {}),
});
export const resultHash = (d) => h(RESULT_TAG, resultFields(d));

/** Proof levels (settlement v4, docs/SETTLEMENT-STANDARD.md §2), strongest first. A delta's `proof` is derived
 *  by the node from what it can check itself — never taken from a submitter — fixed at settlement, committed in
 *  the result hash, and never upgraded afterwards. */
export const PROOF_LEVELS = Object.freeze(['verified', 'checkable', 'attested', 'host']);

/** The proof level the evidence supports.
 *    verified   a replayable log both players signed (anyone re-runs it; official once witnesses agree)
 *    checkable  a log an authorized key vouched for and the mesh holds, re-runnable by anyone: a relay-signed
 *               replayable log, or an attested report whose log this node holds (sha256 = commitments.inputsHash)
 *               and whose verifier bundle is registered and active for the title
 *    attested   an authorized court's signed report, checked against the title's rules
 *    host       one node's word
 *  @param s.kind         'replayable' | 'attested'
 *  @param s.attestation  the delta's provenance label (players | relay | host | attested)
 *  @param s.logHeld      this node holds the bytes committed as commitments.inputsHash
 *  @param s.verifierActive  commitments.verifierHash is registered and active for the title */
export function proofOf({ kind = 'replayable', attestation, commitments = null, logHeld = false, verifierActive = false }) {
  if (kind === 'attested') {
    if (attestation !== 'attested') return 'host';
    return commitments?.inputsHash && commitments?.verifierHash && logHeld && verifierActive ? 'checkable' : 'attested';
  }
  if (attestation === 'players') return 'verified';
  if (attestation === 'relay') return 'checkable';
  return 'host';
}

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

/** Official standings take verified results that the PLAYERS signed: a
 *  replayable log both players attested and a witness re-ran. An attested
 *  result (a court's signed report) can be verified — an authorized court
 *  signed it and a witness checked it against the rules — but the node
 *  trusts the court for the outcome, so it ranks on the title's ladder and is
 *  never OFFICIAL (docs/BRING-YOUR-BACKEND.md). */
export const isOfficial = (d, opts) => d.attestation === 'players' && verification(d, opts) === 'verified';
