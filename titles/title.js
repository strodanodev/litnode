import { canonical, h } from '../protocol/canonical.js';

/** The title contract. Two kinds, because the arcade has two kinds of title:
 *
 *  REPLAYABLE (defineTitle) — a deterministic step(state, inputs) the node can
 *    re-run from a signed input log. A witness reproduces the result itself.
 *    Agent Fighter.
 *
 *  ATTESTED (defineAttestedTitle) — a simulation the node cannot reproduce
 *    (floating-point physics, a proprietary engine, no input log). The title's
 *    own attested host signs an outcome report; the node validates the report
 *    against the title's rules, settles it, and says plainly that the result
 *    is attested rather than verified. Pickle Brawl.
 *
 *  Everything downstream — placement, derived ladders, epoch settlement — is
 *  the same for both. Only witnessing differs, and the delta records which. */

export function defineTitle({
  rulesetId, tickRate, maxTicks, modes = ['ranked', 'casual'],
  participants = 2, inputSchema = 'bitfield-per-tick', hiddenInfo = false,
  balance, hostPolicy = { affinity: 'open' }, replicas = 3, standingFloor = 0, exclusive = false,
  init, step, done, scores, serialize, view, services = {},
  // How the arcade lists the title: { title, url, description?, cover?, accent? }.
  // url is where the game runs; the cabinet launches it with cabinet:init.
  display = null,
}) {
  for (const [name, fn] of Object.entries({ init, step, done, scores, serialize, view }))
    if (typeof fn !== 'function') throw new Error(`defineTitle: ${name} is required`);

  return {
    manifest: {
      kind: 'replayable',
      rulesetId, tickRate, maxTicks, modes, participants, inputSchema, hiddenInfo,
      replicas, standingFloor, hostPolicy, exclusive, display,
      balanceVersion: balance?.version ?? null,
      services: {
        leaderboard: services.leaderboard ?? null,
        credits: services.credits ?? null,
        stats: services.stats ?? null,
      },
    },
    balance, init, step, done, scores,
    // The runtime hashes this, so it must contain every field the sim reads and
    // nothing that differs between two honest hosts.
    serialize,
    // harness.observe() in Article VII step 5: what may cross to a client.
    view,
  };
}

/** @param validate  (report) → null if valid, else a string reason
 *  @param scores    (report, participants, teams) → { playerId: score } */
export function defineAttestedTitle({
  rulesetId, modes = ['ranked', 'casual'], participants = [2], teams = 2,
  balance = null, hostPolicy = { affinity: 'open' }, standingFloor = 0,
  services = {}, validate, scores, equipment = 'studio', display = null,
  // Which courts may sign reports for this title (ed25519 pubkeys, hex). A
  // node ALSO accepts courts its operator configures (COURTS); a report
  // from any other key is refused however valid its signature.
  attestors = [],
}) {
  for (const [name, fn] of Object.entries({ validate, scores }))
    if (typeof fn !== 'function') throw new Error(`defineAttestedTitle: ${name} is required`);
  return {
    manifest: {
      kind: 'attested',
      rulesetId, modes, participants, teams, standingFloor, hostPolicy, equipment, display, attestors,
      balanceVersion: balance?.version ?? null,
      services: {
        leaderboard: services.leaderboard ?? null,
        credits: services.credits ?? null,
        stats: services.stats ?? null,
      },
    },
    balance, validate, scores,
  };
}

/** Defaults, so a title that wants the obvious thing writes nothing. The
 *  derivation itself lives in protocol/derive.js and is team-aware; these
 *  only carry parameters. */
export const eloLeaderboard = ({ k = 24 } = {}) => ({ kind: 'elo', k });
export const winnerTakesCredits = ({ pot = 10, currency = 'credits' } = {}) => ({ kind: 'pot', pot, currency });

export const titleHash = (t) => h('title', canonical(t.manifest));
