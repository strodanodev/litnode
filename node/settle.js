/** Settlement: ledger in, co-signed delta out, tables and the hour's tree
 *  derived from the delta set. BUILD-SPEC v0.2 §6, §9, §11 — repaired after
 *  the build audit (findings 2, 3, 4, 5).
 *
 *  A submission is:
 *    { matchId, rulesetId, buildHash?, mode, participants: [p0, p1],
 *      entries: [{k, inputs:[a, b]}], signatures?: {playerId: sig},
 *      relay?: { id, sig },                       // an authenticated relay's word (RELAY_TAG)
 *      hydration: { agents?: {playerId: agent}, pin?, bundles?, bounds? },
 *      expected?: { hash, winner, rounds, endTick } }   // the relay's own record, cross-checked
 *  or, for an attested title:
 *    { kind: 'attested', matchId, rulesetId, mode, participants, teams, report, attestor: { id, sig } }
 *
 *  What settles, and how it is labelled:
 *
 *   PLACED     the mesh computed a signed placement descriptor for matchId
 *              (node/litnode.js matchBook). Ranked REQUIRES it, and the
 *              submission is bound to it: participants, ruleset, build, mode,
 *              seed = H(beacon, matchId), host = this node, protocol version.
 *              Unplaced casual submissions settle labelled `placed: false`
 *              and never reach official standings.
 *   COMPLETE   a replayable match must end (done() true, or the title's
 *              maxTicks reached); an empty log is not a match. Ranked with an
 *              unfinished log is refused.
 *   attestation — what backs the result, never more than it is:
 *     'players'   both players signed the chain head (verified at intake AND
 *                 again by every witness)
 *     'relay'     a relay key this host trusts (RELAY_KEYS, advertised in its
 *                 heartbeat) signed the log head and its recorded result
 *                 matched our replay. `expected` alone proves nothing.
 *     'host'      only this node's word — casual only
 *     'attested'  an authorized court (title manifest `attestors` or the
 *                 node's COURTS) signed the outcome report
 *   HYDRATION  characters come from the registry at the placement's block
 *              when a registry is configured (`hydrationSource: 'registry'`),
 *              and the player key's profile owner must own or control the
 *              token. Submission-supplied stats are `fixture` — allowed in
 *              casual, refused in ranked when a registry exists, always
 *              labelled.
 *
 *  Every settled result carries a `resultHash` over the complete outcome
 *  (protocol/result.js). A witness recomputes EVERY field itself, from the
 *  ledger, the descriptor, its own registry reads and its own sandboxed
 *  replay, and signs only `{ matchId, resultHash }` when its commitment is
 *  byte-identical; otherwise it files a signed dispute. Official standings
 *  take ranked, placed, verified results (protocol/result.js verification).
 *
 *  Title code never runs in this process: replays and report validation go
 *  through node/sandbox.js. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, h } from '../protocol/canonical.js';
import { sign, verify } from '../protocol/keys.js';
import { chainHead, verifyLedger } from '../protocol/log.js';
import { hydrationManifest, agent as makeAgent } from '../protocol/erc6699.js';
import { mayPlay } from '../protocol/registry.js';
import { derive } from '../protocol/derive.js';
import { applyProfiles } from '../protocol/profile.js';
import { buildTree, leafOf, proofFor, proposeCalldata, hourOf, freezeAt } from '../protocol/epoch.js';
import { resultHash as commit, cosignBody, verification, isOfficial } from '../protocol/result.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

export const COSIGN_TAG = 'cosign';
export const DISPUTE_TAG = 'dispute';
export const HOST_TAG = 'delta';
/** What an attested title's court signs: { matchId, rulesetId, report }. */
export const ATTEST_TAG = 'attest';
/** What a relay signs: { matchId, head, ticks, expected }. */
export const RELAY_TAG = 'relay';
/** A placement descriptor's commitment: the fields settlement binds to. */
export const descriptorHash = (d) => h('descriptor', {
  matchId: d.matchId, rulesetId: d.rulesetId, mode: d.mode, participants: d.participants, buildHash: d.buildHash ?? null,
  host: d.host, witness: d.witness ?? null, beacon: d.beacon, beaconBlock: d.beaconBlock ?? null, bucket: d.bucket, protocol: d.protocol ?? null, snapshotRoot: d.snapshotRoot,
});
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function createSettlement({
  dataDir, nodeId, identity, loaded, builds = new Map(), sandbox, log = () => {},
  descriptorFor = () => null,          // matchId → { descriptor, envelope } | null (this node's frozen placement)
  verifyDescriptor = async () => null, // envelope → descriptor | null (signature valid, signer bonded) — the witness path
  registry = null,                     // { configured, readAgent(tokenId, block), profile(playerKey) } | null
  courts = {},                         // rulesetId → [court pubkeys] the operator authorizes (in addition to the manifest's)
  relayKeys = [],                      // relay pubkeys THIS host accepts
  hostRelayKeys = () => [],            // hostId → relay pubkeys that host advertised (witness path)
}) {
  if (!sandbox) throw new Error('settlement needs the title sandbox');
  /** The build a submission names, or the current one when it names none. */
  const buildFor = (sub) => {
    if (sub.buildHash) {
      const b = builds.get(sub.buildHash);
      if (!b) throw new Error(`build ${String(sub.buildHash).slice(0, 12)} not held`);
      if (b.rulesetId !== sub.rulesetId) throw new Error('build belongs to another ruleset');
      return b;
    }
    const rs = loaded.get(sub.rulesetId);
    if (!rs) throw new Error(`ruleset ${sub.rulesetId} not loaded`);
    return rs;
  };
  const dirs = { ledgers: join(dataDir, 'ledgers'), deltas: join(dataDir, 'deltas'), epochs: join(dataDir, 'epochs') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const readAll = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const put = (dir, id, obj) => writeFileSync(join(dir, `${encodeURIComponent(id)}.json`), JSON.stringify(obj));
  const get = (dir, id) => { const f = join(dir, `${encodeURIComponent(id)}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };

  const deltas = new Map(readAll(dirs.deltas).map((d) => [d.matchId, { disputes: [], ...d }]));
  const frozen = new Map(readAll(dirs.epochs).map((e) => [e.epoch, e]));
  const registryOn = !!registry?.configured;

  // ---------------------------------------------------------------- binding
  /** Resolve the placement a submission claims. Ranked must be placed. */
  const bind = async (sub, { envelope = null } = {}) => {
    const local = descriptorFor(sub.matchId);
    let desc = local?.descriptor ?? null, env = local?.envelope ?? null;
    if (!desc && envelope) { desc = await verifyDescriptor(envelope); env = desc ? envelope : null; }
    if (!desc) {
      if (sub.mode === 'ranked') throw new Error('ranked: no placement descriptor for this match (the mesh did not place it)');
      return { placed: false, descriptor: null, envelope: null, seed: h('seed', sub.matchId), descriptorHash: null };
    }
    if (desc.rulesetId !== sub.rulesetId) throw new Error(`descriptor binds ${desc.rulesetId}, submission says ${sub.rulesetId}`);
    if ((desc.mode ?? 'casual') !== (sub.mode ?? 'casual')) throw new Error(`descriptor mode ${desc.mode}, submission ${sub.mode}`);
    if (!sameSet(desc.participants, sub.participants)) throw new Error('participants differ from the placement');
    if (desc.buildHash && sub.buildHash && desc.buildHash !== sub.buildHash) throw new Error('build differs from the placement');
    if (desc.protocol != null && desc.protocol !== PROTOCOL_VERSION) throw new Error(`descriptor protocol ${desc.protocol} ≠ ${PROTOCOL_VERSION}`);
    return { placed: true, descriptor: desc, envelope: env, seed: h('seed', desc.beacon, sub.matchId), descriptorHash: descriptorHash(desc), buildHash: desc.buildHash ?? sub.buildHash ?? null };
  };

  // ---------------------------------------------------------------- hydration
  /** Agents for the title: from the registry at the placement's block when
   *  one is configured, else what the submission claims — labelled. */
  const hydrate = async (sub, build, binding) => {
    const hy = sub.hydration ?? {};
    const mode = sub.mode ?? 'casual';
    const block = binding.descriptor?.beaconBlock != null ? '0x' + Number(binding.descriptor.beaconBlock).toString(16) : 'latest';
    const agents = [];
    for (const p of sub.participants) {
      const claim = hy.agents?.[p];
      const tokenId = claim?.tokenId == null ? null : String(claim.tokenId);
      if (!claim || tokenId == null || tokenId.startsWith('external:')) { agents.push(makeAgent({ tokenId: `external:${p}`, stats: {}, manifest: null, source: 'external' })); continue; }
      if (registryOn) {
        const rec = await registry.readAgent(tokenId, block);
        if (!rec) throw new Error(`hydration: token ${tokenId} unknown to the registry`);
        const may = mayPlay(rec, await registry.profile(p));
        if (!may.ok) throw new Error(`hydration: ${may.reason}`);
        agents.push(rec);
      } else {
        if (mode === 'ranked' && registry) throw new Error('ranked: characters must come from the registry, not the submission');
        agents.push(makeAgent({ ...claim, source: 'fixture' }));
      }
    }
    const pinHash = hy.pin || hy.bundles || hy.bounds ? h('pin', { pin: hy.pin ?? null, bundles: hy.bundles ?? null, bounds: hy.bounds ?? null }) : null;
    const manifest = hydrationManifest({ agents, mode, balanceVersion: build.manifest.balanceVersion ?? null, pinHash });
    const sources = new Set(agents.map((a) => a.source));
    const hydrationSource = sources.has('fixture') ? 'fixture' : sources.has('registry') ? 'registry' : 'external';
    const ctx = { agents: Object.fromEntries(sub.participants.map((p, i) => [p, agents[i]])), pin: hy.pin ?? null, bundles: hy.bundles ?? {}, bounds: hy.bounds ?? hy.pin?.bounds ?? undefined };
    return { manifest, ctx, hydrationSource, block };
  };

  // ---------------------------------------------------------------- replay
  /** Deterministic replay of a submission through the pinned build, in the sandbox. */
  const replay = async (sub, binding) => {
    const rs = buildFor(sub);
    const hy = await hydrate(sub, rs, binding);
    const r = await sandbox.one(rs.source, { kind: 'replay', seed: binding.seed, participants: sub.participants, ctx: hy.ctx, entries: sub.entries, maxTicks: rs.manifest.maxTicks ?? undefined });
    const complete = r.done || (rs.manifest.maxTicks && r.ticks >= rs.manifest.maxTicks);
    return { root: h('state', JSON.parse(r.serialized)), scores: r.scores, ticks: r.ticks, done: r.done, complete: !!complete, engineHash: r.engineHash ?? null, hydrationManifest: hy.manifest, hydrationSource: hy.hydrationSource, buildHash: rs.buildHash, manifest: rs.manifest };
  };

  /** Provenance of a replayable submission. Returns { attestation, relay }. */
  const provenance = async (sub, r, { relayAllowed }) => {
    if (sub.signatures && Object.keys(sub.signatures).length) {
      const v = await verifyLedger({ entries: sub.entries, matchId: sub.matchId, participants: sub.participants, buildHash: r.buildHash, hydrationHash: r.hydrationManifest.manifestHash, signatures: sub.signatures });
      if (!v.ok) throw new Error(`ledger signatures: ${v.reason}`);
      return { attestation: 'players', relay: null };
    }
    if (sub.relay?.id) {
      if (!relayAllowed.includes(sub.relay.id)) throw new Error(`relay ${String(sub.relay.id).slice(0, 12)} is not a relay this host trusts`);
      const head = chainHead(sub.entries);
      const body = { matchId: sub.matchId, head, ticks: sub.entries.length, expected: sub.expected ?? null };
      if (!(await verify(RELAY_TAG, body, sub.relay.sig, sub.relay.id))) throw new Error('relay signature invalid');
      const e = sub.expected;
      if (e && ((e.hash != null && e.hash !== r.engineHash) || (e.endTick != null && e.endTick !== r.ticks))) throw new Error(`relay record disagrees with replay: hash ${e.hash} vs ${r.engineHash}, endTick ${e.endTick} vs ${r.ticks}`);
      return { attestation: 'relay', relay: { id: sub.relay.id } };
    }
    if (sub.mode === 'ranked') throw new Error('ranked: player signatures or an authenticated relay are required');
    return { attestation: 'host', relay: null };
  };

  /** Attested titles: validate the signed outcome report in the sandbox;
   *  the signer must be an authorized court. Never replays. */
  const checkAttested = async (sub, binding) => {
    const rs = buildFor(sub);
    if (rs.manifest.kind !== 'attested') throw new Error(`${sub.rulesetId} is not an attested title`);
    const a = sub.attestor;
    if (!a?.id || !a?.sig) throw new Error('attestor signature required');
    const authorized = [...(rs.manifest.attestors ?? []), ...(courts[sub.rulesetId] ?? [])];
    if (!authorized.length) throw new Error(`${sub.rulesetId}: no authorized court (manifest.attestors or COURTS)`);
    if (!authorized.includes(a.id)) throw new Error(`attestor ${String(a.id).slice(0, 12)} is not an authorized court for ${sub.rulesetId}`);
    if (!(await verify(ATTEST_TAG, { matchId: sub.matchId, rulesetId: sub.rulesetId, report: sub.report }, a.sig, a.id))) throw new Error('attestor signature invalid');
    if (!Array.isArray(sub.teams) || sub.teams.length !== 2) throw new Error('teams required');
    const flat = sub.teams.flat();
    if (flat.length !== sub.participants.length || flat.some((p) => !sub.participants.includes(p))) throw new Error('teams must partition participants');
    if (!rs.manifest.participants.includes(sub.participants.length)) throw new Error(`title takes ${rs.manifest.participants.join('|')} participants`);
    const v = await sandbox.one(rs.source, { kind: 'attested', report: sub.report, participants: sub.participants, teams: sub.teams });
    if (v.validate) throw new Error(`report rejected: ${v.validate}`);
    const hy = await hydrate(sub, rs, binding);
    return { rs, hydrationManifest: hy.manifest, hydrationSource: hy.hydrationSource, scores: v.scores, root: h('attested', { rulesetId: sub.rulesetId, report: sub.report }) };
  };

  const finish = async (body, sub, binding) => {
    body.resultHash = commit(body);
    const delta = { ...body, hostSig: await sign(HOST_TAG, body, identity.privateKey), cosigners: [], cosigs: {}, disputes: [] };
    put(dirs.ledgers, sub.matchId, { ...sub, descriptor: binding.envelope ?? null });
    put(dirs.deltas, sub.matchId, delta);
    deltas.set(sub.matchId, delta);
    return delta;
  };

  /** Host / settler side: bind, verify what can be verified, replay, sign. */
  const intake = async (sub) => {
    if (!sub?.matchId || typeof sub.matchId !== 'string' || !Array.isArray(sub.participants) || !sub.rulesetId) throw new Error('malformed submission');
    if (deltas.has(sub.matchId)) return decorate(deltas.get(sub.matchId));
    if (!['ranked', 'casual', undefined].includes(sub.mode)) throw new Error(`unknown mode ${sub.mode}`);
    const mode = sub.mode ?? 'casual';
    if (new Set(sub.participants).size !== sub.participants.length) throw new Error('duplicate participant');
    if (mode === 'ranked' && !sub.participants.every(isKey)) throw new Error('ranked: participants must be player keys');
    const binding = await bind({ ...sub, mode });
    if (binding.placed && binding.descriptor.host !== nodeId) throw new Error(`placement names host ${binding.descriptor.host.slice(0, 12)}, not this node`);

    if (sub.kind === 'attested') {
      const c = await checkAttested({ ...sub, mode }, binding);
      const body = {
        protocol: PROTOCOL_VERSION, matchId: sub.matchId, rulesetId: sub.rulesetId, buildHash: c.rs.buildHash, kind: 'attested', mode, placed: binding.placed, descriptorHash: binding.descriptorHash,
        participants: sub.participants, teams: sub.teams, seed: null, ticks: sub.report.ticks ?? null, head: null, signatures: {},
        attestation: 'attested', attestor: sub.attestor.id, relay: null, verifiable: false,
        hydrationManifest: c.hydrationManifest, hydrationHash: c.hydrationManifest.manifestHash, hydrationSource: c.hydrationSource,
        finalStateRoot: c.root, engineHash: null, scores: c.scores,
        hostId: nodeId, epoch: hourOf(Date.now()), settledAt: new Date().toISOString(),
      };
      const delta = await finish(body, sub, binding);
      log(`settled ${sub.matchId} · attested by ${sub.attestor.id.slice(0, 12)} · ${sub.report.scoreA}-${sub.report.scoreB}${binding.placed ? '' : ' · unplaced'}`);
      return decorate(delta);
    }
    if (!Array.isArray(sub.entries) || sub.participants.length !== 2) throw new Error('malformed submission');
    if (sub.entries.length === 0) throw new Error('empty log: not a match');
    const head = chainHead(sub.entries); // throws on gaps or reorders
    const r = await replay({ ...sub, mode, buildHash: binding.buildHash ?? sub.buildHash }, binding);
    if (!r.complete) { if (mode === 'ranked') throw new Error(`ranked: match not finished after ${r.ticks} ticks`); }
    const prov = await provenance({ ...sub, mode }, r, { relayAllowed: relayKeys });
    const body = {
      protocol: PROTOCOL_VERSION, matchId: sub.matchId, rulesetId: sub.rulesetId, buildHash: r.buildHash, kind: 'replayable', mode, placed: binding.placed, descriptorHash: binding.descriptorHash,
      participants: sub.participants, teams: null, seed: binding.seed, ticks: r.ticks, complete: r.complete, head, signatures: sub.signatures ?? {}, attestation: prov.attestation, attestor: null, relay: prov.relay,
      hydrationManifest: r.hydrationManifest, hydrationHash: r.hydrationManifest.manifestHash, hydrationSource: r.hydrationSource,
      finalStateRoot: r.root, engineHash: r.engineHash, scores: r.scores,
      hostId: nodeId, epoch: hourOf(Date.now()), settledAt: new Date().toISOString(),
    };
    const delta = await finish(body, sub, binding);
    log(`settled ${sub.matchId} · ${r.ticks} ticks · root ${r.root.slice(0, 12)} · ${prov.attestation}${binding.placed ? '' : ' · unplaced'}${r.hydrationSource === 'fixture' ? ' · fixture hydration' : ''}`);
    return decorate(delta);
  };

  /** Witness side: recompute the COMPLETE result from the ledger, the
   *  descriptor and our own reads; sign only a byte-identical commitment. */
  const cosign = async (delta, ledger) => {
    if (delta.hostId === nodeId) return { ok: false, reason: 'cannot witness own match' };
    if (delta.protocol !== PROTOCOL_VERSION) return { ok: false, reason: `protocol ${delta.protocol} ≠ ${PROTOCOL_VERSION}` };
    const hostOk = await verify(HOST_TAG, stripSig(delta), delta.hostSig, delta.hostId);
    if (!hostOk) return { ok: false, reason: 'host signature' };
    if (commit(delta) !== delta.resultHash) return { ok: false, reason: 'result commitment does not match its fields' };
    if (!ledger || ledger.matchId !== delta.matchId) return { ok: false, reason: 'ledger is for another match' };
    const mode = delta.mode ?? 'casual';
    let binding;
    try { binding = await bind({ ...ledger, mode, rulesetId: delta.rulesetId, participants: delta.participants, buildHash: delta.buildHash }, { envelope: ledger.descriptor }); }
    catch (e) { return { ok: false, reason: `binding: ${e.message}` }; }
    if (binding.placed !== !!delta.placed) return { ok: false, reason: 'placement claim', ours: binding.placed, theirs: delta.placed };
    if (binding.placed && binding.descriptor.host !== delta.hostId) return { ok: false, reason: 'descriptor names another host' };
    if (binding.descriptorHash !== (delta.descriptorHash ?? null)) return { ok: false, reason: 'descriptor', ours: binding.descriptorHash, theirs: delta.descriptorHash };

    let ours;
    if (delta.kind === 'attested') {
      let c;
      try { c = await checkAttested({ ...ledger, mode }, binding); } catch (e) { return { ok: false, reason: e.message }; }
      ours = { ...delta, seed: null, finalStateRoot: c.root, hydrationHash: c.hydrationManifest.manifestHash, hydrationSource: c.hydrationSource, scores: c.scores, attestation: 'attested', attestor: ledger.attestor?.id ?? null, engineHash: null, ticks: ledger.report?.ticks ?? null };
    } else {
      let head, r, prov;
      try {
        if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) throw new Error('empty log');
        head = chainHead(ledger.entries);
        if (head !== delta.head) return { ok: false, reason: 'ledger head', ours: head, theirs: delta.head };
        r = await replay({ ...ledger, mode, participants: delta.participants, rulesetId: delta.rulesetId, buildHash: delta.buildHash }, binding);
        if (mode === 'ranked' && !r.complete) throw new Error(`ranked: match not finished after ${r.ticks} ticks`);
        prov = await provenance({ ...ledger, mode, participants: delta.participants }, r, { relayAllowed: hostRelayKeys(delta.hostId) });
      } catch (e) { return { ok: false, reason: e.message }; }
      ours = { ...delta, seed: binding.seed, ticks: r.ticks, head, finalStateRoot: r.root, engineHash: r.engineHash, hydrationHash: r.hydrationManifest.manifestHash, hydrationSource: r.hydrationSource, scores: r.scores, attestation: prov.attestation, relay: prov.relay, attestor: null };
    }
    const mine = commit(ours);
    if (mine !== delta.resultHash) {
      const diff = Object.keys(ours).filter((k) => ['seed', 'ticks', 'head', 'finalStateRoot', 'engineHash', 'hydrationHash', 'hydrationSource', 'scores', 'attestation', 'attestor', 'relay'].includes(k) && canonical(ours[k] ?? null) !== canonical(delta[k] ?? null));
      const body = { matchId: delta.matchId, resultHash: delta.resultHash, witnessId: nodeId, reason: diff.join(',') || 'commitment', ours: mine };
      return { ok: false, reason: `result differs: ${diff.join(', ') || 'commitment'}`, ours: mine, theirs: delta.resultHash, fields: diff, dispute: { ...body, sig: await sign(DISPUTE_TAG, body, identity.privateKey) } };
    }
    return { ok: true, matchId: delta.matchId, witnessId: nodeId, sig: await sign(COSIGN_TAG, cosignBody(delta), identity.privateKey), verified: delta.kind === 'attested' ? 'attestation-only' : 'replay' };
  };

  const acceptCosign = async ({ matchId, witnessId, sig }) => {
    const d = deltas.get(matchId);
    if (!d) return { ok: false, reason: 'unknown match' };
    if (witnessId === d.hostId) return { ok: false, reason: 'host cannot co-sign itself' };
    if (commit(d) !== d.resultHash) return { ok: false, reason: 'stored delta does not match its commitment' };
    if (!(await verify(COSIGN_TAG, cosignBody(d), sig, witnessId))) return { ok: false, reason: 'bad signature' };
    if (!d.cosigners.includes(witnessId)) { d.cosigners.push(witnessId); d.cosigs[witnessId] = sig; put(dirs.deltas, matchId, d); log(`co-signed ${matchId} by ${witnessId.slice(0, 12)}`); }
    return { ok: true, cosigners: d.cosigners, verification: verification(d, { registry: registryOn }) };
  };

  /** A witness that recomputed a different result files this; the delta is
   *  `disputed` until independent agreement outnumbers disputes. */
  const acceptDispute = async (dsp) => {
    const d = deltas.get(dsp?.matchId);
    if (!d) return { ok: false, reason: 'unknown match' };
    if (dsp.witnessId === d.hostId) return { ok: false, reason: 'host cannot dispute itself' };
    const { sig, ...body } = dsp;
    if (body.resultHash !== d.resultHash) return { ok: false, reason: 'dispute is over another commitment' };
    if (!(await verify(DISPUTE_TAG, body, sig, dsp.witnessId))) return { ok: false, reason: 'bad signature' };
    if (!d.disputes.some((x) => x.witnessId === dsp.witnessId)) { d.disputes.push({ witnessId: dsp.witnessId, reason: dsp.reason, ours: dsp.ours, sig, at: new Date().toISOString() }); put(dirs.deltas, d.matchId, d); log(`DISPUTED ${d.matchId} by ${dsp.witnessId.slice(0, 12)}: ${dsp.reason}`); }
    return { ok: true, disputes: d.disputes.length, verification: verification(d, { registry: registryOn }) };
  };

  const stripSig = ({ hostSig, cosigners, cosigs, disputes, verification: _v, official: _o, ...body }) => body;
  const decorate = (d) => ({ ...d, verification: verification(d, { registry: registryOn }), official: officialOf(d) });
  const officialOf = (d) => d.mode === 'ranked' && !!d.placed && isOfficial(d, { registry: registryOn });
  const list = (rulesetId, { scope = 'all' } = {}) => [...deltas.values()].filter((d) => !rulesetId || d.rulesetId === rulesetId).filter((d) => scope === 'all' || officialOf(d)).map(decorate);

  /** Tables for one ruleset. `scope`: 'official' (default — ranked, placed,
   *  verified) or 'all'. `profiles` (key → {owner, active}) folds by wallet
   *  owner instead of by key; the response says which (`by`). */
  const derived = (rulesetId, { profiles = null, scope = 'official', ...opts } = {}) => {
    const rs = loaded.get(rulesetId);
    if (!rs) throw new Error(`ruleset ${rulesetId} not loaded`);
    const base = list(rulesetId, { scope });
    const ds = profiles ? applyProfiles(base, profiles) : base;
    return { rulesetId, scope, by: profiles ? 'owner' : 'key', ...derive(ds, rs.manifest, opts) };
  };

  // ---------------------------------------------------------------- epochs
  const leafInputs = (d) => ({ cosigners: d.cosigners, verified: verification(d, { registry: registryOn }) === 'verified' });
  const liveEpoch = (hour) => {
    const ds = [...deltas.values()].filter((d) => d.epoch === hour);
    const rows = ds.map((d) => { const li = leafInputs(d); return { matchId: d.matchId, leaf: leafOf(d, li), cosigners: [...li.cosigners], verified: li.verified, resultHash: d.resultHash }; });
    const tree = buildTree(rows.map((r) => r.leaf));
    return { epoch: hour, status: 'open', count: ds.length, root: tree.root, matches: rows, freezeAt: new Date(freezeAt(hour)).toISOString(), tree };
  };
  /** Freeze the hour: the leaf set as of now is final. Idempotent. */
  const freeze = (hour) => {
    if (frozen.has(hour)) return frozen.get(hour);
    const e = liveEpoch(hour);
    const rec = { epoch: hour, status: 'finalized', count: e.count, root: e.root, matches: e.matches, frozenAt: new Date().toISOString(), protocol: PROTOCOL_VERSION };
    put(dirs.epochs, String(hour), rec);
    frozen.set(hour, rec);
    log(`epoch ${hour} frozen: ${rec.count} leaves, root ${rec.root.slice(0, 12)}`);
    return rec;
  };
  const maybeFreeze = (now = Date.now()) => {
    const hours = new Set([...deltas.values()].map((d) => d.epoch));
    for (const hour of hours) if (!frozen.has(hour) && now >= freezeAt(hour)) freeze(hour);
  };
  const epoch = (hour = hourOf(Date.now()), { nodeKey = nodeId } = {}) => {
    const f = frozen.get(hour);
    const e = f ? { ...f, tree: buildTree(f.matches.map((m) => m.leaf)) } : liveEpoch(hour);
    return { ...e, proposeCalldata: proposeCalldata(hour, e.root, nodeKey) };
  };
  const proof = (matchId) => {
    const d = deltas.get(matchId);
    if (!d) return null;
    const e = epoch(d.epoch);
    const row = e.matches.find((m) => m.matchId === matchId);
    if (!row) return null;
    return { matchId, epoch: d.epoch, status: e.status, leaf: row.leaf, verified: row.verified, cosignersAtFreeze: row.cosigners, cosignersNow: d.cosigners, resultHash: d.resultHash, root: e.root, path: proofFor(e.tree, row.leaf) };
  };

  return {
    intake, cosign, acceptCosign, acceptDispute, replay, derived, epoch, freeze, maybeFreeze, proof, list,
    delta: (id) => { const d = deltas.get(id); return d ? decorate(d) : null; }, ledger: (id) => get(dirs.ledgers, id),
    verification: (d) => verification(d, { registry: registryOn }), official: officialOf,
  };
}
