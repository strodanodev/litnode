/** Settlement: ledger in, co-signed delta out, tables and the hour's tree
 *  derived from the delta set. BUILD-SPEC v0.2 §6, §9, §11.
 *
 *  A submission is:
 *    { matchId, rulesetId, buildHash, mode, participants: [p0, p1],
 *      entries: [{k, inputs:[a, b]}], signatures?: {playerId: sig},
 *      hydration: { agents?: {playerId: agent}, pin?, bundles?, bounds? },
 *      expected?: { hash, winner, rounds, endTick } }   // the relay's own record, cross-checked
 *
 *  attestation on the delta says what backs it, never more than it is:
 *    'players'  both players signed the chain head
 *    'relay'    unsigned by players; the relay's recorded result matched our replay
 *    'host'     unsigned and no relay record; only this node's word */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, h } from '../protocol/canonical.js';
import { sign, verify } from '../protocol/keys.js';
import { chainHead, verifyLedger } from '../protocol/log.js';
import { hydrationManifest, agent as makeAgent } from '../protocol/erc6699.js';
import { derive } from '../protocol/derive.js';
import { buildTree, leafOf, proofFor, anchorCalldata, hourOf } from '../protocol/epoch.js';

export const COSIGN_TAG = 'cosign';
export const HOST_TAG = 'delta';
/** What an attested title's host signs: { matchId, rulesetId, report }. */
export const ATTEST_TAG = 'attest';

export function createSettlement({ dataDir, nodeId, identity, loaded, builds = new Map(), log = () => {} }) {
  /** The build a submission names, or the current one when it names none. */
  const buildFor = (sub) => {
    if (sub.buildHash) {
      const b = builds.get(sub.buildHash);
      if (!b) throw new Error(`build ${sub.buildHash.slice(0, 12)} not held`);
      if (b.rulesetId !== sub.rulesetId) throw new Error('build belongs to another ruleset');
      return b;
    }
    const rs = loaded.get(sub.rulesetId);
    if (!rs) throw new Error(`ruleset ${sub.rulesetId} not loaded`);
    return rs;
  };
  const dirs = { ledgers: join(dataDir, 'ledgers'), deltas: join(dataDir, 'deltas') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const readAll = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const put = (dir, id, obj) => writeFileSync(join(dir, `${encodeURIComponent(id)}.json`), JSON.stringify(obj));
  const get = (dir, id) => { const f = join(dir, `${encodeURIComponent(id)}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };

  const deltas = new Map(readAll(dirs.deltas).map((d) => [d.matchId, d]));

  /** Hydration context for the title, and the manifest the delta carries. */
  const hydrate = (sub) => {
    const hy = sub.hydration ?? {};
    const agents = sub.participants.map((p) => hy.agents?.[p] ?? makeAgent({ tokenId: `external:${p}`, stats: {}, manifest: null }));
    const rs = buildFor(sub);
    const manifest = hydrationManifest({ agents, mode: sub.mode ?? 'casual', balanceVersion: rs.title.manifest.balanceVersion ?? null });
    const ctx = { agents: Object.fromEntries(sub.participants.map((p, i) => [p, agents[i]])), pin: hy.pin ?? null, bundles: hy.bundles ?? {}, bounds: hy.bounds ?? hy.pin?.bounds ?? undefined };
    return { manifest, ctx };
  };

  /** Deterministic replay of a submission through the pinned build. */
  const replay = (sub) => {
    const rs = buildFor(sub);
    const { manifest, ctx } = hydrate(sub);
    const { title } = rs;
    const [a, b] = sub.participants;
    let state = title.init(sub.seed ?? h('seed', sub.matchId), sub.participants, ctx);
    let t = 0;
    for (; t < sub.entries.length && !title.done(state); t++) {
      const e = sub.entries[t];
      state = title.step(state, { [a]: e.inputs[0], [b]: e.inputs[1] }) ?? state;
    }
    const engineHash = rs.mod?.engine?.stateHash ? rs.mod.engine.stateHash(state) : null;
    return { root: h('state', title.serialize(state)), scores: title.scores(state), ticks: t, engineHash, hydrationManifest: manifest, buildHash: rs.buildHash, state };
  };

  /** Attested titles: validate the signed outcome report, never replay. The
   *  delta says so. Returns { delta body fields } for intake/cosign to share. */
  const checkAttested = async (sub) => {
    const rs = buildFor(sub);
    if (rs.title.manifest.kind !== 'attested') throw new Error(`${sub.rulesetId} is not an attested title`);
    const bad = rs.title.validate(sub.report);
    if (bad) throw new Error(`report rejected: ${bad}`);
    const a = sub.attestor;
    if (!a?.id || !a?.sig) throw new Error('attestor signature required');
    if (!(await verify(ATTEST_TAG, { matchId: sub.matchId, rulesetId: sub.rulesetId, report: sub.report }, a.sig, a.id))) throw new Error('attestor signature invalid');
    if (!Array.isArray(sub.teams) || sub.teams.length !== 2) throw new Error('teams required');
    const flat = sub.teams.flat();
    if (flat.length !== sub.participants.length || flat.some((p) => !sub.participants.includes(p))) throw new Error('teams must partition participants');
    if (!rs.title.manifest.participants.includes(sub.participants.length)) throw new Error(`title takes ${rs.title.manifest.participants.join('|')} participants`);
    const { manifest } = hydrate(sub);
    return { rs, hydrationManifest: manifest, scores: rs.title.scores(sub.report, sub.participants, sub.teams), root: h('attested', { rulesetId: sub.rulesetId, report: sub.report }) };
  };

  /** Host / settler side: take a ledger, verify what can be verified, replay, sign. */
  const intake = async (sub) => {
    if (!sub?.matchId || !Array.isArray(sub.participants)) throw new Error('malformed submission');
    if (deltas.has(sub.matchId)) return deltas.get(sub.matchId);
    if (sub.kind === 'attested') {
      const c = await checkAttested(sub);
      const body = {
        matchId: sub.matchId, rulesetId: sub.rulesetId, buildHash: c.rs.buildHash, mode: sub.mode ?? 'casual', kind: 'attested',
        participants: sub.participants, teams: sub.teams, ticks: sub.report.ticks ?? null, head: null, signatures: {},
        attestation: 'attested', attestor: sub.attestor.id, verifiable: false,
        hydrationManifest: c.hydrationManifest, hydrationHash: c.hydrationManifest.manifestHash,
        finalStateRoot: c.root, engineHash: null, scores: c.scores,
        hostId: nodeId, epoch: hourOf(Date.now()), settledAt: new Date().toISOString(),
      };
      const delta = { ...body, hostSig: await sign(HOST_TAG, body, identity.privateKey), cosigners: [], cosigs: {} };
      put(dirs.ledgers, sub.matchId, sub);
      put(dirs.deltas, sub.matchId, delta);
      deltas.set(sub.matchId, delta);
      log(`settled ${sub.matchId} · attested by ${sub.attestor.id.slice(0, 12)} · ${sub.report.scoreA}-${sub.report.scoreB}`);
      return delta;
    }
    if (!Array.isArray(sub.entries) || sub.participants.length !== 2) throw new Error('malformed submission');
    const head = chainHead(sub.entries); // throws on gaps or reorders
    const r = replay(sub);
    let attestation = 'host';
    if (sub.signatures && Object.keys(sub.signatures).length) {
      const v = await verifyLedger({ entries: sub.entries, matchId: sub.matchId, participants: sub.participants, buildHash: r.buildHash, hydrationHash: r.hydrationManifest.manifestHash, signatures: sub.signatures });
      if (!v.ok) throw new Error(`ledger signatures: ${v.reason}`);
      attestation = 'players';
    } else if (sub.expected) {
      const ok = (sub.expected.hash == null || sub.expected.hash === r.engineHash) && (sub.expected.endTick == null || sub.expected.endTick === r.ticks);
      if (!ok) throw new Error(`relay record disagrees with replay: hash ${sub.expected.hash} vs ${r.engineHash}, endTick ${sub.expected.endTick} vs ${r.ticks}`);
      attestation = 'relay';
    }
    const body = {
      matchId: sub.matchId, rulesetId: sub.rulesetId, buildHash: r.buildHash, mode: sub.mode ?? 'casual',
      participants: sub.participants, ticks: r.ticks, head, signatures: sub.signatures ?? {}, attestation,
      hydrationManifest: r.hydrationManifest, hydrationHash: r.hydrationManifest.manifestHash,
      finalStateRoot: r.root, engineHash: r.engineHash, scores: r.scores,
      hostId: nodeId, epoch: hourOf(Date.now()), settledAt: new Date().toISOString(),
    };
    const delta = { ...body, hostSig: await sign(HOST_TAG, body, identity.privateKey), cosigners: [], cosigs: {} };
    put(dirs.ledgers, sub.matchId, sub);
    put(dirs.deltas, sub.matchId, delta);
    deltas.set(sub.matchId, delta);
    log(`settled ${sub.matchId} · ${r.ticks} ticks · root ${r.root.slice(0, 12)} · ${attestation}`);
    return delta;
  };

  /** Witness side: replay independently from the ledger and the delta's own
   *  claims; sign only the root we reach ourselves. */
  const cosign = async (delta, ledger) => {
    if (delta.hostId === nodeId) return { ok: false, reason: 'cannot witness own match' };
    const hostOk = await verify(HOST_TAG, stripSig(delta), delta.hostSig, delta.hostId);
    if (!hostOk) return { ok: false, reason: 'host signature' };
    if (delta.kind === 'attested') {
      // We cannot replay; we CAN check the attestor's signature and the rules.
      // The co-signature therefore means "the attestation is well-formed and
      // the root is what this report hashes to", nothing more.
      let c;
      try { c = await checkAttested(ledger); } catch (e) { return { ok: false, reason: e.message }; }
      if (c.root !== delta.finalStateRoot) return { ok: false, reason: 'root', ours: c.root, theirs: delta.finalStateRoot };
      if (c.hydrationManifest.manifestHash !== delta.hydrationHash) return { ok: false, reason: 'hydration' };
      const body = { matchId: delta.matchId, finalStateRoot: c.root, head: null, hydrationHash: delta.hydrationHash };
      return { ok: true, matchId: delta.matchId, witnessId: nodeId, sig: await sign(COSIGN_TAG, body, identity.privateKey), verified: 'attestation-only' };
    }
    let head, r;
    try {
      head = chainHead(ledger.entries);
      if (head !== delta.head) return { ok: false, reason: 'ledger head' };
      r = replay({ ...ledger, mode: delta.mode, buildHash: delta.buildHash });
    } catch (e) { return { ok: false, reason: e.message }; }
    if (r.hydrationManifest.manifestHash !== delta.hydrationHash) return { ok: false, reason: 'hydration', ours: r.hydrationManifest.manifestHash, theirs: delta.hydrationHash };
    if (r.root !== delta.finalStateRoot) return { ok: false, reason: 'root', ours: r.root, theirs: delta.finalStateRoot };
    const body = { matchId: delta.matchId, finalStateRoot: r.root, head, hydrationHash: delta.hydrationHash };
    return { ok: true, matchId: delta.matchId, witnessId: nodeId, sig: await sign(COSIGN_TAG, body, identity.privateKey) };
  };

  const acceptCosign = async ({ matchId, witnessId, sig }) => {
    const d = deltas.get(matchId);
    if (!d) return { ok: false, reason: 'unknown match' };
    if (witnessId === d.hostId) return { ok: false, reason: 'host cannot co-sign itself' };
    const body = { matchId, finalStateRoot: d.finalStateRoot, head: d.head, hydrationHash: d.hydrationHash };
    if (!(await verify(COSIGN_TAG, body, sig, witnessId))) return { ok: false, reason: 'bad signature' };
    if (!d.cosigners.includes(witnessId)) { d.cosigners.push(witnessId); d.cosigs[witnessId] = sig; put(dirs.deltas, matchId, d); log(`co-signed ${matchId} by ${witnessId.slice(0, 12)}`); }
    return { ok: true, cosigners: d.cosigners };
  };

  const stripSig = ({ hostSig, cosigners, cosigs, ...body }) => body;
  const list = (rulesetId) => [...deltas.values()].filter((d) => !rulesetId || d.rulesetId === rulesetId);

  const derived = (rulesetId, opts) => {
    const rs = loaded.get(rulesetId);
    if (!rs) throw new Error(`ruleset ${rulesetId} not loaded`);
    return { rulesetId, ...derive(list(rulesetId), rs.title.manifest, opts) };
  };

  const epoch = (hour = hourOf(Date.now())) => {
    const ds = [...deltas.values()].filter((d) => d.epoch === hour);
    const leaves = ds.map(leafOf);
    const tree = buildTree(leaves);
    return { epoch: hour, count: ds.length, root: tree.root, matches: ds.map((d, i) => ({ matchId: d.matchId, leaf: leaves[i], cosigners: d.cosigners.length })), anchorCalldata: anchorCalldata(hour, tree.root), tree };
  };
  const proof = (matchId) => {
    const d = deltas.get(matchId);
    if (!d) return null;
    const e = epoch(d.epoch);
    const leaf = leafOf(d);
    return { matchId, epoch: d.epoch, leaf, root: e.root, path: proofFor(e.tree, leaf) };
  };

  return { intake, cosign, acceptCosign, replay, derived, epoch, proof, list, delta: (id) => deltas.get(id) ?? null, ledger: (id) => get(dirs.ledgers, id) };
}
