/** The verifier runner (docs/SETTLEMENT-ARCHITECTURE.md §4, Amendment 1 B1; the contract is
 *  docs/SETTLEMENT-STANDARD.md §11). Until now a node only checked that an attested result's verifier bundle was
 *  registered, which earned the result `checkable`; nobody ran it. Here a witness or custodian that holds the
 *  committed log RUNS the title's verifier on it and compares what it reproduces with what the court signed:
 *
 *    agree     co-sign, marked `verified: 'verifier'` (the court's report was re-run, not just bounds-checked)
 *    disagree  a signed dispute, reason `verifier: …` — the court signed something its own verifier does not see
 *    skip      no verifier, no log, over budget, untrusted bundle: the old attestation-only co-sign, nothing worse
 *
 *  Nothing here changes a result's hash or its proof level, so it ships under protocol 4: a node without the runner
 *  co-signs as before, a node with it can only add disputes. Upgrading a re-run result's proof level is protocol 5.
 *
 *  THE BUNDLE. Packed like a server bundle (node/server-bundle.js, kind 'verifier', its hash in its own domain),
 *  held by hash under <dataDir>/verifiers/, never evicted, served at GET /verifier/<rulesetId>?build=<hash> and
 *  advertised in the heartbeat (`verifiers`). A node fetches one only when the title's publisher registered it
 *  (TitleRegistry active) or the operator accepts it (VERIFIERS); the publisher's own file (VERIFIER_BUNDLES) loads
 *  regardless. Trust is checked again at every run, so a revoked verifier stops being run at once.
 *
 *  THE RUN. Every verify() call gets its own process (node/verifier-child.mjs): the permission model with read
 *  access to the bundle's directory only, an empty environment, network builtins refused, `--max-old-space-size`
 *  and a kill at the deadline from the manifest's runtime (defaults 512 MB / 120 s, ceilings 2048 MB / 900 s; a
 *  bundle asking for more is refused). One run at a time, and at most VERIFY_BUDGET_MIN minutes of runs per UTC
 *  day (default 60; 0 turns the runner off): over budget a node skips rather than guesses. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { h } from '../protocol/canonical.js';
import { MANIFEST_NAME, MAX_BUNDLE_BYTES, VERIFIER_TAG, openBundle, permanent, runtimeOk, writeFiles } from './server-bundle.js';
import { permissionFlag } from './sandbox.js';

export const CEILINGS = Object.freeze({ memoryMb: 2048, timeoutS: 900 });
export const DEFAULT_RUNTIME = Object.freeze({ memoryMb: 512, timeoutS: 120 });
export const DEFAULT_BUDGET_MIN = 60;
const MAX_OUTPUT_BYTES = 1 << 20;
const RETRY_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const CHILD_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'verifier-child.mjs'), 'utf8');

/** What is wrong with a verifier manifest beyond node/server-bundle.js's checks, or null: it must export verify()
 *  and ask for no more than the runner's ceilings. */
export function runtimeProblem(m) {
  if (!Array.isArray(m?.exports) || !m.exports.includes('verify')) return 'exports must include "verify"';
  const r = m.runtime ?? {};
  if (r.memoryMb != null && !(Number.isInteger(r.memoryMb) && r.memoryMb >= 64 && r.memoryMb <= CEILINGS.memoryMb)) return `runtime.memoryMb must be an integer 64–${CEILINGS.memoryMb}`;
  if (r.timeoutS != null && !(Number.isInteger(r.timeoutS) && r.timeoutS >= 1 && r.timeoutS <= CEILINGS.timeoutS)) return `runtime.timeoutS must be an integer 1–${CEILINGS.timeoutS}`;
  return null;
}
export const limitsOf = (m) => ({ memoryMb: m?.runtime?.memoryMb ?? DEFAULT_RUNTIME.memoryMb, timeoutS: m?.runtime?.timeoutS ?? DEFAULT_RUNTIME.timeoutS });

/** Does a verifier's verdict reproduce the court's signed report? Pure. The contract (docs/SETTLEMENT-STANDARD.md
 *  §11) is the commitment: a verify() that threw (`refused: …`) or a finalHash other than
 *  report.commitments.finalHash is a disagreement. The verifier receives the report as its spec, so it refuses a log
 *  that isn't the run the report names.
 *  The report's other numbers are NOT compared with `result` by name: the two needn't share units (FLOOD CONTROL's
 *  report carries keptDry as a whole percent, its verifier the raw share), so a name-for-name check would dispute
 *  honest runs. Binding them needs a per-title rule (docs/SETTLEMENT-ARCHITECTURE.md §19). */
export function judge(report, verdict) {
  const c = report?.commitments ?? {};
  if (!verdict || verdict.ok === false) return { ok: false, reason: `the verifier refused the log (${String(verdict?.error ?? 'no result').slice(0, 200)})`, fields: ['finalHash'] };
  if (typeof verdict.finalHash !== 'string' || verdict.finalHash !== c.finalHash) return { ok: false, reason: 'finalHash differs from report.commitments.finalHash', fields: ['finalHash'] };
  return { ok: true, reason: null, fields: [] };
}
/** The commitment a verifier dispute reports as "ours": never the disputed resultHash, so the MatchBook path
 *  (node/matchbook.js) attests it as dissent. */
export const disputeHash = (resultHash, finalHash) => h('verifier-dispute', { resultHash, finalHash: finalHash ?? null });

/** @param o.verifierActive  async (rulesetId, hash) → the hash is registered and active for the title (or VERIFIERS)
 *  @param o.local           { rulesetId: path to the publisher's own .tgz } (VERIFIER_BUNDLES)
 *  @param o.peersFor        (rulesetId, hash) → [addr]: who may serve it (advertisers first, then the host)
 *  @param o.budgetMin       minutes of verify() per UTC day; 0 turns the runner off */
export function createVerifiers({ dataDir, verifierActive = async () => false, local = {}, peersFor = () => [], budgetMin = DEFAULT_BUDGET_MIN, node = process.execPath, log = () => {}, emit = () => {}, now = () => Date.now() } = {}) {
  const dir = join(dataDir, 'verifiers');
  mkdirSync(dir, { recursive: true });
  const held = new Map();    // verifierHash → { rulesetId, hash, manifest, dir, file, bytes, origin }
  const refused = new Map(); // verifierHash → { reason, until }
  const stats = { runs: 0, agreed: 0, disagreed: 0, skipped: 0, failed: 0, lastMs: null };
  const flag = permissionFlag(node);

  // ---------------------------------------------------------------- the daily budget (persisted: a restart is not a reset)
  const budgetFile = join(dir, 'budget.json');
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  let budget = { day: dayOf(now()), ms: 0 };
  try { const b = JSON.parse(readFileSync(budgetFile, 'utf8')); if (b?.day === budget.day && Number.isFinite(b.ms)) budget = b; } catch { /* first run */ }
  const used = () => { if (budget.day !== dayOf(now())) budget = { day: dayOf(now()), ms: 0 }; return budget.ms; };
  const spend = (ms) => { used(); budget.ms += ms; try { writeFileSync(budgetFile, JSON.stringify(budget)); } catch { /* disk */ } };
  const overBudget = () => budgetMin <= 0 || used() >= budgetMin * 60_000;

  // ---------------------------------------------------------------- holding bundles
  /** Hold a verifier ONLY if its bytes hash to the pinned value, its manifest is sound, names the title it is held
   *  under, fits this runtime and the runner's ceilings. Refused before anything is written. Trust is not decided
   *  here: it is checked at every run (and before any fetch). */
  const install = (gzBytes, expectedHash, { rulesetId = null, origin = 'peer' } = {}) => {
    const { tar, hash, files, manifest } = openBundle(gzBytes, expectedHash, { kind: VERIFIER_TAG });
    if (rulesetId && manifest.rulesetId !== rulesetId) throw permanent(new Error(`verifier ${hash.slice(0, 12)} is ${manifest.rulesetId}'s, not ${rulesetId}'s`));
    if (held.has(hash)) return held.get(hash);
    const problem = runtimeProblem(manifest);
    if (problem) throw permanent(new Error(`verifier ${manifest.rulesetId} @ ${hash.slice(0, 12)}: ${problem}`));
    if (!runtimeOk(manifest)) throw permanent(new Error(`verifier ${manifest.rulesetId} @ ${hash.slice(0, 12)} needs Node ${manifest.runtime.node}; this node runs ${process.versions.node}`));
    const d = join(dir, hash), file = join(dir, `${hash}.tgz`);
    if (!existsSync(join(d, MANIFEST_NAME))) { const tmp = `${d}.tmp`; rmSync(tmp, { recursive: true, force: true }); writeFiles(tmp, files); rmSync(d, { recursive: true, force: true }); renameSync(tmp, d); }
    if (!existsSync(file)) { writeFileSync(file, gzBytes); writeFileSync(join(dir, `${hash}.json`), JSON.stringify({ rulesetId: manifest.rulesetId, verifierHash: hash, origin })); }
    const entry = { rulesetId: manifest.rulesetId, hash, manifest, dir: d, file, bytes: tar.length, origin };
    held.set(hash, entry);
    log(`verifier ${manifest.rulesetId} @ ${hash.slice(0, 12)} held · ${origin} · ${tar.length} bytes · ${limitsOf(manifest).memoryMb} MB / ${limitsOf(manifest).timeoutS} s`);
    emit('verifier', { rulesetId: manifest.rulesetId, verifierHash: hash, origin, bytes: tar.length });
    return entry;
  };
  // Re-hold what earlier runs cached (bytes re-checked), then the publisher's own files.
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.tgz'))) {
    try {
      const hash = f.slice(0, -4);
      const side = join(dir, `${hash}.json`);
      const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
      install(readFileSync(join(dir, f)), hash, { origin: meta.origin === 'local' ? 'local' : 'cache' });
    } catch (e) { log(`cached verifier ${f}: ${e.message}`); }
  }
  for (const [rid, file] of Object.entries(local)) {
    if (!existsSync(file)) throw new Error(`VERIFIER_BUNDLES: ${rid}: ${file} not found`);
    const side = file.replace(/\.tgz$/, '.json');
    const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
    install(readFileSync(file), meta.verifierHash ?? null, { rulesetId: rid, origin: 'local' });
  }
  const trusted = async (e) => e.origin === 'local' || !!(await verifierActive(e.rulesetId, e.hash));

  /** The verifier for (rulesetId, hash): held, or fetched from a peer that serves it once the title's publisher has
   *  registered it. null when it can't be had. A peer that served wrong bytes is skipped; bytes that are the
   *  bundle's own fault are never asked for again; a trust refusal is retried after a minute. */
  const ensure = async (rulesetId, hash) => {
    if (!HEX64.test(hash ?? '')) return null;
    const have = held.get(hash);
    if (have) return have.rulesetId === rulesetId ? have : null;
    const r = refused.get(hash);
    if (r && now() < r.until) return null;
    if (!(await verifierActive(rulesetId, hash))) { refused.set(hash, { reason: 'not registered for the title', until: now() + RETRY_MS }); return null; }
    for (const addr of [...new Set(peersFor(rulesetId, hash))].slice(0, 4)) {
      try {
        const res = await fetch(`${addr}/verifier/${encodeURIComponent(rulesetId)}?build=${hash}`, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) continue;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > MAX_BUNDLE_BYTES) continue;
        const e = install(bytes, hash, { rulesetId, origin: 'peer' });
        refused.delete(hash);
        return e;
      } catch (e) {
        log(`verifier ${rulesetId} @ ${hash.slice(0, 12)} from ${addr}: ${e.message}`);
        if (/hash mismatch|not a gzip/.test(e.message)) continue;
        refused.set(hash, { reason: e.message, until: e.permanent ? Infinity : now() + RETRY_MS });
        return null;
      }
    }
    return null;
  };

  // ---------------------------------------------------------------- running one verify()
  let chain = Promise.resolve(); // one run at a time
  /** Run the bundle's verify(logBytes, spec) in its own process. Resolves { ok, finalHash, result, ms } or
   *  { ok: false, error, ms }; a run killed at the deadline or out of memory is { ok: false } too, with
   *  `runner: true`, because it says nothing about the court. */
  const run = (entry, logBytes, spec) => {
    const go = () => new Promise((resolve) => {
      if (!flag) return resolve({ ok: false, runner: true, error: 'this Node runtime has no permission model: verifiers cannot be run', ms: 0 });
      const { memoryMb, timeoutS } = limitsOf(entry.manifest);
      const t0 = now();
      const args = [flag, `--allow-fs-read=${entry.dir}`, `--max-old-space-size=${memoryMb}`, '--no-addons', '--input-type=module', '-e', CHILD_SOURCE];
      const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {};
      let child;
      try { child = spawn(node, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return resolve({ ok: false, runner: true, error: e.message, ms: 0 }); }
      let out = '', err = '', killed = null, done = false;
      const timer = setTimeout(() => { killed = `deadline of ${timeoutS} s`; child.kill('SIGKILL'); }, timeoutS * 1000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUTPUT_BYTES) { killed = 'output over 1 MB'; child.kill('SIGKILL'); } });
      child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); const ms = now() - t0; spend(ms); stats.lastMs = ms; resolve({ ...r, ms }); };
      child.on('error', (e) => finish({ ok: false, runner: true, error: e.message }));
      child.on('close', (code) => {
        if (killed) return finish({ ok: false, runner: true, error: `killed: ${killed}` });
        const line = out.split('\n').filter(Boolean).pop();
        let r = null; try { r = JSON.parse(line); } catch { /* no line */ }
        if (!r) return finish({ ok: false, runner: true, error: `exited ${code}${/heap|memory/i.test(err) ? ' (out of memory)' : ''}: ${err.trim().split('\n').pop() ?? ''}`.slice(0, 300) });
        finish(r.ok ? { ok: true, finalHash: r.finalHash, result: r.result } : { ok: false, error: r.error });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ entry: pathToFileURL(join(entry.dir, ...entry.manifest.entry.split('/'))).href, log: Buffer.from(logBytes).toString('base64'), spec: spec ?? null }));
    });
    const p = chain.then(go, go);
    chain = p.catch(() => {});
    return p;
  };

  /** The witness hook (node/settle.js cosign, attested branch): re-run an attested result's committed log with the
   *  verifier it names. null = not checked (nothing to run, or this node won't run it); otherwise
   *  { ok, reason, fields, finalHash, verifierHash, ms }. `logs` is the settlement's log store; `logFrom` lists who
   *  may serve the log when this node doesn't hold it yet. */
  const check = async (delta, ledger, { logs, logFrom = [] } = {}) => {
    const c = delta?.commitments;
    const report = ledger?.report;
    if (delta?.kind !== 'attested' || !c?.verifierHash || !c?.inputsHash || !c?.finalHash || !report) return null;
    if (overBudget()) { stats.skipped++; return null; }
    if (!logs.hasLog(c.inputsHash)) {
      for (const addr of [...new Set(logFrom)].slice(0, 4)) {
        try { const r = await fetch(`${addr}/log/${c.inputsHash}`, { signal: AbortSignal.timeout(20_000) }); if (r.ok) { logs.holdLog(Buffer.from(await r.arrayBuffer()), c.inputsHash); break; } } catch { /* next holder */ }
      }
      if (!logs.hasLog(c.inputsHash)) { stats.skipped++; return null; }
    }
    const entry = await ensure(delta.rulesetId, c.verifierHash);
    if (!entry || !(await trusted(entry))) { stats.skipped++; return null; }
    stats.runs++;
    const verdict = await run(entry, logs.readLog(c.inputsHash), report);
    if (verdict.runner) { stats.failed++; log(`verifier ${delta.rulesetId} on ${delta.matchId}: ${verdict.error} (not counted against the court)`); return null; }
    const j = judge(report, verdict);
    stats[j.ok ? 'agreed' : 'disagreed']++;
    log(`verifier ${delta.rulesetId} @ ${c.verifierHash.slice(0, 12)} on ${delta.matchId}: ${j.ok ? 'agrees' : `DISAGREES (${j.reason})`} · ${verdict.ms} ms`);
    emit('verified', { matchId: delta.matchId, rulesetId: delta.rulesetId, verifierHash: c.verifierHash, agrees: j.ok, reason: j.reason, ms: verdict.ms });
    return { ...j, finalHash: verdict.finalHash ?? null, verifierHash: c.verifierHash, ms: verdict.ms };
  };

  /** The heartbeat's `verifiers`: { rulesetId: [verifierHash] } this node serves (a few per title, sorted). */
  const advertised = () => {
    const out = {};
    for (const e of held.values()) (out[e.rulesetId] ??= []).push(e.hash);
    for (const k of Object.keys(out)) out[k] = out[k].sort().slice(0, 4);
    return Object.keys(out).length ? Object.fromEntries(Object.entries(out).sort().slice(0, 16)) : null;
  };
  /** GET /verifier/<rulesetId>?build=<hash>: the .tgz bytes, or null. */
  const serve = (rulesetId, hash) => { const e = held.get(hash); return e && e.rulesetId === rulesetId ? readFileSync(e.file) : null; };
  const status = () => ({
    budgetMin, usedMsToday: used(), runner: !!flag && budgetMin > 0, ...stats,
    held: [...held.values()].map((e) => ({ rulesetId: e.rulesetId, verifierHash: e.hash, origin: e.origin, ...limitsOf(e.manifest) })),
    refused: Object.fromEntries([...refused].map(([k, r]) => [k, r.reason])),
  });
  return { install, ensure, run, check, advertised, serve, status, held: () => [...held.values()] };
}
